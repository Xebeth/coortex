import { randomUUID } from "node:crypto";

import type { HostAdapter, HostTelemetryCapture } from "../adapters/contract.js";
import {
  buildRecoveredOutcomeEvent,
  deriveWorkflowRunAttemptIdentity
} from "../adapters/host-run-records.js";
import { isRunLeaseExpired } from "../core/run-state.js";
import type { RuntimeEvent } from "../core/events.js";
import type { DecisionPacket, HostRunRecord } from "../core/types.js";
import { applyRuntimeEvent, fromSnapshot, toSnapshot } from "../projections/runtime-projection.js";
import { buildStaleRunReconciliation, createActiveRunDiagnostic, selectRunnableProjection } from "../recovery/host-runs.js";
import { nowIso } from "../utils/time.js";
import { RuntimeStore } from "../persistence/store.js";
import { deriveWorkflowNextRequiredAction, deriveWorkflowSummary } from "../workflows/index.js";

import type { CommandDiagnostic } from "./types.js";
import {
  diagnosticsFromWarning,
  hostRunPersistDiagnostics,
  recordTelemetryWarningDiagnostics,
  syncProjectionWithDiagnostics
} from "./diagnostics.js";
import { loadOperatorProjection, loadOperatorProjectionWithDiagnostics } from "./runtime-state.js";

function buildStaleRunTelemetryCapture(
  sessionId: string,
  assignmentId: string,
  metadata: ReturnType<typeof buildStaleRunReconciliation>["telemetryMetadata"]
): HostTelemetryCapture {
  return {
    eventType: "host.run.stale_reconciled",
    taskId: sessionId,
    assignmentId,
    metadata
  };
}

export async function loadReconciledProjectionWithDiagnostics(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<{
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  diagnostics: CommandDiagnostic[];
  activeLeases: string[];
  hiddenActiveLeases: string[];
}> {
  const loaded = await loadOperatorProjectionWithDiagnostics(store);
  const reconciled = await reconcileActiveRuns(store, adapter, loaded.projection, {
    snapshotFallback: loaded.snapshotFallback
  });
  const hiddenActiveLeases = listHiddenActiveLeaseAssignments(
    reconciled.projection,
    reconciled.activeLeases
  );
  return {
    projection: reconciled.projection,
    diagnostics: [...loaded.diagnostics, ...reconciled.diagnostics],
    activeLeases: reconciled.activeLeases,
    hiddenActiveLeases
  };
}

export async function markAssignmentInProgress(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
  const assignment = projection.assignments.get(assignmentId);
  if (!assignment || assignment.state === "in_progress") {
    return projection;
  }

  await store.appendEvent({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp: nowIso(),
    type: "assignment.updated",
    payload: {
      assignmentId,
      patch: {
        state: "in_progress",
        updatedAt: nowIso()
      }
    }
  });
  return (await store.syncSnapshotFromEventsWithRecovery()).projection;
}

export async function reconcileActiveRuns(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  options?: {
    snapshotFallback?: boolean;
  }
): Promise<{
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  diagnostics: CommandDiagnostic[];
  activeLeases: string[];
}> {
  const diagnostics: CommandDiagnostic[] = [];
  const activeLeases: string[] = [];
  const snapshotFallback = options?.snapshotFallback ?? false;
  const snapshotBoundaryEventId = snapshotFallback ? (await store.loadSnapshot())?.lastEventId : undefined;
  const replayableEvents = snapshotFallback ? (await store.loadReplayableEvents()).events : undefined;
  let effectiveProjection = fromSnapshot(toSnapshot(projection));
  let changed = false;
  let snapshotFallbackReplayHydrated = false;
  let queuedTransitions: Map<string, string[]> | undefined;
  let staleStatusTransitions: Map<string, string[]> | undefined;
  let handledCompletedRun = false;
  const runtimeKnownAssignmentIds = [...projection.assignments.keys()];
  const enumeratedRecords = await adapter.inspectRuns(store);
  const enumeratedRecordByAssignmentId = new Map(
    enumeratedRecords.map((record) => [record.assignmentId, record] as const)
  );
  const assignmentIdsToInspect = [
    ...new Set([...runtimeKnownAssignmentIds, ...enumeratedRecordByAssignmentId.keys()])
  ];

  const hydrateSnapshotFallbackReplayableSuffix = () => {
    if (!snapshotFallback || snapshotFallbackReplayHydrated) {
      return;
    }
    snapshotFallbackReplayHydrated = true;
    const replayableHydration = hydrateProjectionFromReplayableEvents(
      effectiveProjection,
      replayableEvents,
      snapshotBoundaryEventId
    );
    if (replayableHydration.hydrated) {
      effectiveProjection = replayableHydration.projection;
      changed = true;
    }
  };

  for (const assignmentId of assignmentIdsToInspect) {
    const record = enumeratedRecordByAssignmentId.get(assignmentId)
      ?? await adapter.inspectRun(store, assignmentId);
    if (!record) {
      continue;
    }

    if (snapshotFallback && isStaleRunReconciliationCandidate(record)) {
      hydrateSnapshotFallbackReplayableSuffix();
    }

    if (
      snapshotFallback &&
      !effectiveProjection.assignments.has(assignmentId) &&
      isStaleRunReconciliationCandidate(record)
    ) {
      const replayableHydration = hydrateMissingAssignmentFromReplayableEvents(
        effectiveProjection,
        assignmentId,
        replayableEvents,
        snapshotBoundaryEventId
      );
      if (replayableHydration.hydrated) {
        effectiveProjection = replayableHydration.projection;
        changed = true;
      }
    }

    const durableRuntimeCompletedRecord = isDegradedRunRecord(record)
      ? buildCompletedRunRecordFromRuntimeOutcome(effectiveProjection, assignmentId)
      : undefined;
    if (durableRuntimeCompletedRecord) {
      handledCompletedRun = true;
      const completedRecovery = await reconcileCompletedRunRecord(
        store,
        adapter,
        effectiveProjection,
        durableRuntimeCompletedRecord,
        diagnostics,
        {
          cleanupRecord: record,
          replayableEvents,
          snapshotBoundaryEventId,
          snapshotFallback
        }
      );
      effectiveProjection = completedRecovery.projection;
      changed ||= completedRecovery.changed;
      snapshotFallbackReplayHydrated ||= completedRecovery.replayableHydrated;
      continue;
    }

    if (record.state === "completed") {
      const completedRecovery = await reconcileCompletedRunRecord(
        store,
        adapter,
        effectiveProjection,
        record,
        diagnostics,
        {
          cleanupRecord: undefined,
          replayableEvents,
          snapshotBoundaryEventId,
          snapshotFallback
        }
      );
      if (completedRecovery.handled) {
        handledCompletedRun = true;
        effectiveProjection = completedRecovery.projection;
        changed ||= completedRecovery.changed;
        snapshotFallbackReplayHydrated ||= completedRecovery.replayableHydrated;
        continue;
      }

      if (record.staleReasonCode && !record.terminalOutcome) {
        if (!effectiveProjection.assignments.has(assignmentId)) {
          await reconcileOutOfProjectionStaleRun(
            store,
            adapter,
            effectiveProjection,
            assignmentId,
            record,
            diagnostics
          );
          continue;
        }

        queuedTransitions ??= await loadQueuedTransitions(store, replayableEvents);
        staleStatusTransitions ??= await loadStaleRecoveryStatusTransitions(store, replayableEvents);
        const staleRecoveryState = getStaleRunRecoveryState(
          assignmentId,
          record,
          queuedTransitions,
          staleStatusTransitions
        );
        const reconciliation = buildStaleRunReconciliation(effectiveProjection, assignmentId, record);
        const expectedStatus =
          reconciliation.events[1]?.type === "status.updated"
            ? reconciliation.events[1].payload.status
            : effectiveProjection.status;
        if (
          isStaleRunAlreadyReconciled(
            effectiveProjection,
            assignmentId,
            staleRecoveryState,
            expectedStatus,
            snapshotFallback
          )
        ) {
          changed = true;
          await store.writeSnapshot(toSnapshot(effectiveProjection));
          await cleanupReconciledRunArtifacts(store, adapter, assignmentId, record, diagnostics);
          continue;
        }

        const pendingEvents = selectPendingStaleRecoveryEvents(
          reconciliation.events,
          staleRecoveryState
        );
        if (pendingEvents.length === 0) {
          changed = true;
          for (const event of reconciliation.events) {
            applyRuntimeEvent(effectiveProjection, event);
          }
          await store.writeSnapshot(toSnapshot(effectiveProjection));
          diagnostics.push(reconciliation.diagnostic);
          await cleanupReconciledRunArtifacts(
            store,
            adapter,
            assignmentId,
            reconciliation.staleRecord,
            diagnostics
          );
          continue;
        }

        changed = true;
        if (snapshotFallback) {
          for (const event of pendingEvents) {
            applyRuntimeEvent(effectiveProjection, event);
          }
        } else {
          for (const event of pendingEvents) {
            await store.appendEvent(event);
            applyRuntimeEvent(effectiveProjection, event);
          }
        }
        if (!staleRecoveryState.queuedTransitionTimestamp) {
          queuedTransitions.set(assignmentId, [
            ...(queuedTransitions.get(assignmentId) ?? []),
            reconciliation.events[0]!.timestamp
          ]);
        }
        if (!staleRecoveryState.statusTransitionTimestamp) {
          staleStatusTransitions.set(assignmentId, [
            ...(staleStatusTransitions.get(assignmentId) ?? []),
            reconciliation.events[1]!.timestamp
          ]);
        }
        const persisted = await persistReconciledProjection(
          store,
          effectiveProjection,
          snapshotFallback
        );
        effectiveProjection = persisted.projection;
        diagnostics.push(...persisted.diagnostics);
        diagnostics.push(reconciliation.diagnostic);

        diagnostics.push(...await recordTelemetryWarningDiagnostics(
          store,
          adapter,
          buildStaleRunTelemetryCapture(
            projection.sessionId,
            assignmentId,
            reconciliation.telemetryMetadata
          )
        ));
        await cleanupReconciledRunArtifacts(
          store,
          adapter,
          assignmentId,
          reconciliation.staleRecord,
          diagnostics
        );
        continue;
      }

      continue;
    }

    if (!effectiveProjection.assignments.has(assignmentId)) {
      if (!isRunLeaseExpired(record)) {
        activeLeases.push(assignmentId);
        diagnostics.push(createActiveRunDiagnostic(assignmentId, record));
      } else if (snapshotFallback && isStaleRunReconciliationCandidate(record)) {
        await reconcileOutOfProjectionStaleRun(
          store,
          adapter,
          effectiveProjection,
          assignmentId,
          record,
          diagnostics
        );
      }
      continue;
    }

    if (!isRunLeaseExpired(record)) {
      activeLeases.push(assignmentId);
      diagnostics.push(createActiveRunDiagnostic(assignmentId, record));
      continue;
    }

    queuedTransitions ??= await loadQueuedTransitions(store, replayableEvents);
    staleStatusTransitions ??= await loadStaleRecoveryStatusTransitions(store, replayableEvents);
    const staleRecoveryState = getStaleRunRecoveryState(
      assignmentId,
      record,
      queuedTransitions,
      staleStatusTransitions
    );
    const reconciliation = buildStaleRunReconciliation(effectiveProjection, assignmentId, record);
    const expectedStatus =
      reconciliation.events[1]?.type === "status.updated"
        ? reconciliation.events[1].payload.status
        : effectiveProjection.status;
    if (
      isStaleRunAlreadyReconciled(
        effectiveProjection,
        assignmentId,
        staleRecoveryState,
        expectedStatus,
        snapshotFallback
      )
    ) {
      changed = true;
      await store.writeSnapshot(toSnapshot(effectiveProjection));
      await cleanupReconciledRunArtifacts(
        store,
        adapter,
        assignmentId,
        reconciliation.staleRecord,
        diagnostics
      );
      continue;
    }

    const pendingEvents = selectPendingStaleRecoveryEvents(reconciliation.events, staleRecoveryState);
    if (pendingEvents.length === 0) {
      if (snapshotFallback) {
        changed = true;
        for (const event of reconciliation.events) {
          applyRuntimeEvent(effectiveProjection, event);
        }
        await store.writeSnapshot(toSnapshot(effectiveProjection));
        diagnostics.push(reconciliation.diagnostic);

        diagnostics.push(...await recordTelemetryWarningDiagnostics(
          store,
          adapter,
          buildStaleRunTelemetryCapture(
            projection.sessionId,
            assignmentId,
            reconciliation.telemetryMetadata
          )
        ));
      }
      await cleanupReconciledRunArtifacts(
        store,
        adapter,
        assignmentId,
        reconciliation.staleRecord,
        diagnostics
      );
      continue;
    }

    changed = true;
    if (snapshotFallback) {
      for (const event of pendingEvents) {
        applyRuntimeEvent(effectiveProjection, event);
      }
    } else {
      for (const event of pendingEvents) {
        await store.appendEvent(event);
        applyRuntimeEvent(effectiveProjection, event);
      }
    }
    if (!staleRecoveryState.queuedTransitionTimestamp) {
      queuedTransitions.set(assignmentId, [
        ...(queuedTransitions.get(assignmentId) ?? []),
        reconciliation.events[0]!.timestamp
      ]);
    }
    if (!staleRecoveryState.statusTransitionTimestamp) {
      staleStatusTransitions.set(assignmentId, [
        ...(staleStatusTransitions.get(assignmentId) ?? []),
        reconciliation.events[1]!.timestamp
      ]);
    }
    const persisted = await persistReconciledProjection(
      store,
      effectiveProjection,
      snapshotFallback
    );
    effectiveProjection = persisted.projection;
    diagnostics.push(...persisted.diagnostics);
    diagnostics.push(reconciliation.diagnostic);

    diagnostics.push(...await recordTelemetryWarningDiagnostics(
      store,
      adapter,
      buildStaleRunTelemetryCapture(
        projection.sessionId,
        assignmentId,
        reconciliation.telemetryMetadata
      )
    ));
    await cleanupReconciledRunArtifacts(
      store,
      adapter,
      assignmentId,
      reconciliation.staleRecord,
      diagnostics
    );
  }

  const record = await adapter.inspectRun(store);
  if (
    !handledCompletedRun &&
    record?.state === "completed" &&
    record.terminalOutcome &&
    !assignmentIdsToInspect.includes(record.assignmentId)
  ) {
    const completedRecovery = await reconcileCompletedRunRecord(
      store,
      adapter,
      effectiveProjection,
      record,
      diagnostics,
      {
        cleanupRecord: undefined,
        replayableEvents,
        snapshotBoundaryEventId,
        snapshotFallback
      }
    );
    effectiveProjection = completedRecovery.projection;
    changed ||= completedRecovery.changed;
    snapshotFallbackReplayHydrated ||= completedRecovery.replayableHydrated;
  }

  return {
    projection: changed ? effectiveProjection : projection,
    diagnostics,
    activeLeases
  };
}

async function reconcileCompletedRunRecord(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord,
  diagnostics: CommandDiagnostic[],
  options: {
    cleanupRecord: HostRunRecord | undefined;
    replayableEvents: RuntimeEvent[] | undefined;
    snapshotBoundaryEventId: string | undefined;
    snapshotFallback: boolean;
  }
): Promise<{
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  changed: boolean;
  handled: boolean;
  replayableHydrated: boolean;
}> {
  let effectiveProjection = projection;
  let changed = false;
  const replayableHydration = hydrateProjectionFromReplayableEvents(
    effectiveProjection,
    options.replayableEvents,
    options.snapshotBoundaryEventId
  );
  if (replayableHydration.hydrated) {
    effectiveProjection = replayableHydration.projection;
    changed = true;
  }
  if (options.snapshotFallback && !effectiveProjection.assignments.has(record.assignmentId)) {
    const missingAssignmentHydration = hydrateMissingAssignmentFromReplayableEvents(
      effectiveProjection,
      record.assignmentId,
      options.replayableEvents,
      options.snapshotBoundaryEventId
    );
    if (missingAssignmentHydration.hydrated) {
      effectiveProjection = missingAssignmentHydration.projection;
      changed = true;
    }
  }
  if (!effectiveProjection.assignments.has(record.assignmentId)) {
    return {
      projection: effectiveProjection,
      changed,
      handled: false,
      replayableHydrated: replayableHydration.hydrated
    };
  }

  const completedReplayableEvents =
    options.replayableEvents ??
    (options.snapshotFallback ? undefined : (await store.loadReplayableEvents()).events);
  const completedRecoveryProofEvents = options.snapshotFallback
    ? selectReplayableSuffixEvents(
        completedReplayableEvents,
        options.snapshotBoundaryEventId ?? ""
      )
    : completedReplayableEvents;
  const completedRecovery = buildCompletedRunReconciliation(
    effectiveProjection,
    record,
    completedRecoveryProofEvents
  );
  if (!completedRecovery) {
    return {
      projection: effectiveProjection,
      changed,
      handled: false,
      replayableHydrated: replayableHydration.hydrated
    };
  }

  if (completedRecovery.events.length > 0) {
    changed = true;
    if (options.snapshotFallback) {
      for (const event of completedRecovery.events) {
        applyRuntimeEvent(effectiveProjection, event);
      }
    } else {
      for (const event of completedRecovery.events) {
        await store.appendEvent(event);
        applyRuntimeEvent(effectiveProjection, event);
      }
    }
    const persisted = await persistReconciledProjection(
      store,
      effectiveProjection,
      options.snapshotFallback
    );
    effectiveProjection = persisted.projection;
    diagnostics.push(...persisted.diagnostics);
    diagnostics.push(completedRecovery.diagnostic);
  } else if (options.snapshotFallback) {
    changed = true;
    await store.writeSnapshot(toSnapshot(effectiveProjection));
    diagnostics.push(completedRecovery.diagnostic);
  } else {
    changed = true;
    await store.writeSnapshot(toSnapshot(effectiveProjection));
  }

  await cleanupReconciledRunArtifacts(
    store,
    adapter,
    record.assignmentId,
    selectCompletedRunCleanupRecord(record, options.cleanupRecord),
    diagnostics
  );

  return {
    projection: effectiveProjection,
    changed,
    handled: true,
    replayableHydrated: replayableHydration.hydrated
  };
}

async function persistReconciledProjection(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  snapshotFallback: boolean
): Promise<{
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  diagnostics: CommandDiagnostic[];
}> {
  if (snapshotFallback) {
    await store.writeSnapshot(toSnapshot(projection));
    return { projection, diagnostics: [] };
  }

  return syncProjectionWithDiagnostics(store);
}

async function cleanupReconciledRunArtifacts(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId: string,
  record: HostRunRecord,
  diagnostics: CommandDiagnostic[]
): Promise<void> {
  const cleanupError = await reconcileStaleRunWithLeaseVerification(store, adapter, record);
  if (cleanupError) {
    diagnostics.push(...hostRunPersistDiagnostics(assignmentId, cleanupError));
  }
}

async function reconcileStaleRunWithLeaseVerification(
  store: RuntimeStore,
  adapter: HostAdapter,
  record: HostRunRecord
): Promise<Error | undefined> {
  let cleanupError: Error | undefined;
  try {
    await adapter.reconcileStaleRun(store, record);
  } catch (error) {
    cleanupError = error instanceof Error ? error : new Error(String(error));
  }

  if (await adapter.hasRunLease(store, record.assignmentId)) {
    throw new Error(
      `Host run reconciliation failed to clear the active lease for assignment ${record.assignmentId}. ${
        cleanupError?.message ?? "The lease artifact remained on disk."
      }`
    );
  }

  return cleanupError;
}

function selectCompletedRunCleanupRecord(
  record: HostRunRecord,
  cleanupRecord: HostRunRecord | undefined
): HostRunRecord {
  if (!cleanupRecord || cleanupRecord.state !== "running") {
    return cleanupRecord ?? record;
  }

  return {
    ...record,
    ...(
      cleanupRecord.adapterData ?? record.adapterData
        ? { adapterData: cleanupRecord.adapterData ?? record.adapterData }
        : {}
    ),
    ...(cleanupRecord.staleAt ?? record.staleAt ? { staleAt: cleanupRecord.staleAt ?? record.staleAt } : {}),
    ...(
      cleanupRecord.staleReasonCode ?? record.staleReasonCode
        ? { staleReasonCode: cleanupRecord.staleReasonCode ?? record.staleReasonCode }
        : {}
    ),
    ...(
      cleanupRecord.staleReason ?? record.staleReason
        ? { staleReason: cleanupRecord.staleReason ?? record.staleReason }
        : {}
    )
  };
}

function isStaleRunAlreadyReconciled(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string,
  recoveryState: StaleRunRecoveryState,
  expectedStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"],
  snapshotFallback: boolean
): boolean {
  const assignment = projection.assignments.get(assignmentId);
  return (
    assignment?.state === "queued" &&
    (
      (snapshotFallback && hasEquivalentRuntimeStatus(projection.status, expectedStatus)) ||
      (
        Boolean(recoveryState.queuedTransitionTimestamp) &&
        Boolean(recoveryState.statusTransitionTimestamp)
      )
    )
  );
}

function isDegradedRunRecord(record: HostRunRecord): boolean {
  return (record.state === "completed" && Boolean(record.staleReasonCode) && !record.terminalOutcome) ||
    isRunLeaseExpired(record);
}

function isStaleRunReconciliationCandidate(record: HostRunRecord): boolean {
  return (record.state === "completed" && Boolean(record.staleReasonCode) && !record.terminalOutcome) ||
    isRunLeaseExpired(record);
}

function buildCompletedRunRecordFromRuntimeOutcome(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string
): HostRunRecord | undefined {
  const workflowAttempt = deriveWorkflowRunAttemptIdentity(projection, assignmentId);
  const decision = [...projection.decisions.values()]
    .filter((candidate) => candidate.assignmentId === assignmentId)
    .at(-1);
  const result = [...projection.results.values()]
    .filter(
      (candidate) =>
        candidate.assignmentId === assignmentId &&
        (candidate.status === "completed" || candidate.status === "failed")
    )
    .at(-1);

  if (!decision && !result) {
    return undefined;
  }

  if (result && (!decision || result.createdAt >= decision.createdAt)) {
    return {
      assignmentId,
      state: "completed",
      ...(workflowAttempt ? { workflowAttempt } : {}),
      startedAt: result.createdAt,
      completedAt: result.createdAt,
      outcomeKind: "result",
      resultStatus: result.status,
      summary: result.summary,
      terminalOutcome: {
        kind: "result",
        result: {
          resultId: result.resultId,
          producerId: result.producerId,
          status: result.status,
          summary: result.summary,
          changedFiles: [...result.changedFiles],
          createdAt: result.createdAt
        }
      }
    };
  }

  return {
    assignmentId,
    state: "completed",
    ...(workflowAttempt ? { workflowAttempt } : {}),
    startedAt: decision!.createdAt,
    completedAt: decision!.createdAt,
    outcomeKind: "decision",
    summary: decision!.blockerSummary,
    terminalOutcome: {
      kind: "decision",
      decision: {
        decisionId: decision!.decisionId,
        requesterId: decision!.requesterId,
        blockerSummary: decision!.blockerSummary,
        options: decision!.options.map((option) => ({ ...option })),
        recommendedOption: decision!.recommendedOption,
        state: decision!.state,
        createdAt: decision!.createdAt
      }
    }
  };
}

async function loadQueuedTransitions(
  store: RuntimeStore,
  replayableEvents?: RuntimeEvent[]
): Promise<Map<string, string[]>> {
  const queuedTransitions = new Map<string, string[]>();
  const { events } = replayableEvents ? { events: replayableEvents } : await store.loadReplayableEvents();
  for (const event of events) {
    if (event.type === "assignment.updated" && event.payload.patch.state === "queued") {
      queuedTransitions.set(event.payload.assignmentId, [
        ...(queuedTransitions.get(event.payload.assignmentId) ?? []),
        event.timestamp
      ]);
    }
  }
  return queuedTransitions;
}

async function loadStaleRecoveryStatusTransitions(
  store: RuntimeStore,
  replayableEvents?: RuntimeEvent[]
): Promise<Map<string, string[]>> {
  const statusTransitions = new Map<string, string[]>();
  const { events } = replayableEvents ? { events: replayableEvents } : await store.loadReplayableEvents();
  for (const event of events) {
    if (event.type !== "status.updated") {
      continue;
    }
    const match = /^Retry assignment ([^:]+): /.exec(event.payload.status.currentObjective);
    if (!match) {
      continue;
    }
    const assignmentId = match[1]!;
    if (!event.payload.status.activeAssignmentIds.includes(assignmentId)) {
      continue;
    }
    statusTransitions.set(assignmentId, [...(statusTransitions.get(assignmentId) ?? []), event.timestamp]);
  }
  return statusTransitions;
}

interface StaleRunRecoveryState {
  queuedTransitionTimestamp: string | undefined;
  statusTransitionTimestamp: string | undefined;
}

function getStaleRunRecoveryState(
  assignmentId: string,
  record: HostRunRecord,
  queuedTransitions: Map<string, string[]>,
  staleStatusTransitions: Map<string, string[]>
): StaleRunRecoveryState {
  const startedAt = Date.parse(record.startedAt);
  if (!Number.isFinite(startedAt)) {
    return {
      queuedTransitionTimestamp: undefined,
      statusTransitionTimestamp: undefined
    };
  }

  const queuedTransitionTimestamp = (queuedTransitions.get(assignmentId) ?? []).find(
    (timestamp) => Date.parse(timestamp) >= startedAt
  );
  const statusTransitionTimestamp = (staleStatusTransitions.get(assignmentId) ?? []).find(
    (timestamp) => Date.parse(timestamp) >= startedAt
  );

  return {
    queuedTransitionTimestamp,
    statusTransitionTimestamp
  };
}

async function reconcileOutOfProjectionStaleRun(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string,
  record: HostRunRecord,
  diagnostics: CommandDiagnostic[]
): Promise<void> {
  const reconciliation = buildStaleRunReconciliation(projection, assignmentId, record);
  diagnostics.push({
    level: "warning",
    code: "stale-run-reconciled",
    message: `Cleared stale host run artifacts for assignment ${assignmentId} after snapshot fallback could not safely hydrate the assignment into runtime state.`
  });

  diagnostics.push(...await recordTelemetryWarningDiagnostics(
    store,
    adapter,
    buildStaleRunTelemetryCapture(
      projection.sessionId,
      assignmentId,
      reconciliation.telemetryMetadata
    )
  ));

  await cleanupReconciledRunArtifacts(
    store,
    adapter,
    assignmentId,
    reconciliation.staleRecord,
    diagnostics
  );
}

function selectPendingStaleRecoveryEvents(
  events: RuntimeEvent[],
  recoveryState: StaleRunRecoveryState
): RuntimeEvent[] {
  const pendingEvents: RuntimeEvent[] = [];
  const [assignmentEvent, statusEvent] = events;

  if (!recoveryState.queuedTransitionTimestamp) {
    pendingEvents.push(assignmentEvent!);
  }
  if (!recoveryState.statusTransitionTimestamp) {
    pendingEvents.push(statusEvent!);
  }

  return pendingEvents;
}

function buildCompletedRunReconciliation(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord,
  replayableEvents?: RuntimeEvent[]
): { events: RuntimeEvent[]; allEvents: RuntimeEvent[]; diagnostic: CommandDiagnostic } | undefined {
  if (record.state !== "completed" || !record.terminalOutcome) {
    return undefined;
  }
  const timestamp = nowIso();
  const expectedStatus = nextRuntimeStatusFromRecord(projection, record, timestamp);
  const events = buildRecoveredOutcomeEvents(projection, record, timestamp);
  const pendingEvents = selectPendingCompletedRecoveryEvents(
    projection,
    record,
    events,
    expectedStatus,
    replayableEvents
  );
  const assignmentId = record.assignmentId;
  return {
    events: pendingEvents,
    allEvents: events,
    diagnostic: {
      level: "warning",
      code: "completed-run-reconciled",
      message: `Recovered completed host outcome for assignment ${assignmentId} after runtime event persistence was interrupted.`
    }
  };
}

function selectPendingCompletedRecoveryEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord,
  events: RuntimeEvent[],
  expectedStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"],
  replayableEvents?: RuntimeEvent[]
): RuntimeEvent[] {
  const [outcomeEvent, assignmentEvent, statusEvent] = events;
  const pendingEvents: RuntimeEvent[] = [];
  const recoveredOutcomeEventIndex = replayableEvents
    ? findRecoveredCompletedOutcomeEventIndexFromEvents(replayableEvents, record)
    : undefined;
  const outcomeRecoveredInProjection = hasRecoveredCompletedOutcomeEvent(projection, record);
  const outcomeAlreadyAbsorbed =
    outcomeRecoveredInProjection || recoveredOutcomeEventIndex !== undefined;
  const canUseReplayableConvergenceProof =
    replayableEvents !== undefined && recoveredOutcomeEventIndex !== undefined;
  const recoveredDecision = canUseReplayableConvergenceProof
    ? findRecoveredCompletedDecisionEvent(replayableEvents, record)
    : findRecoveredCompletedDecision(projection, record);
  const recoveredDecisionState = recoveredDecision?.state;

  if (!outcomeAlreadyAbsorbed) {
    return [...events];
  }

  if (record.terminalOutcome?.kind === "decision") {
    if (
      canUseReplayableConvergenceProof
        ? !hasRecoveredCompletedAssignmentStateFromEvents(
            replayableEvents,
            record,
            recoveredDecisionState,
            recoveredOutcomeEventIndex
          )
        : !hasRecoveredCompletedAssignmentState(projection, record, recoveredDecisionState)
    ) {
      pendingEvents.push(assignmentEvent!);
    }
    if (
      canUseReplayableConvergenceProof
        ? !hasRecoveredCompletedStatusFromEvents(
            replayableEvents,
            record,
            expectedStatus,
            recoveredOutcomeEventIndex
          )
        : !hasRecoveredCompletedStatus(projection, record, expectedStatus)
    ) {
      pendingEvents.push(statusEvent!);
    }
    return pendingEvents;
  }

  if (
    canUseReplayableConvergenceProof
      ? !hasRecoveredCompletedAssignmentStateFromEvents(
          replayableEvents,
          record,
          undefined,
          recoveredOutcomeEventIndex
        )
      : !hasRecoveredCompletedAssignmentState(projection, record)
  ) {
    pendingEvents.push(assignmentEvent!);
  }
  if (
    canUseReplayableConvergenceProof
      ? !hasRecoveredCompletedStatusFromEvents(
          replayableEvents,
          record,
          expectedStatus,
          recoveredOutcomeEventIndex
        )
      : !hasRecoveredCompletedStatus(projection, record, expectedStatus)
  ) {
    pendingEvents.push(statusEvent!);
  }

  return pendingEvents;
}

function hasRecoveredCompletedOutcomeEvent(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord
): boolean {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome) {
    return false;
  }
  if (terminalOutcome.kind === "decision") {
    return findRecoveredCompletedDecision(projection, record) !== undefined;
  }
  return [...projection.results.values()].some((result) => {
    if (record.terminalOutcome?.kind !== "result") {
      return false;
    }
    return (
      result.assignmentId === record.assignmentId &&
      (record.terminalOutcome.result.resultId
        ? result.resultId === record.terminalOutcome.result.resultId
        : result.status === record.terminalOutcome.result.status &&
          result.summary === record.terminalOutcome.result.summary &&
          result.createdAt === record.terminalOutcome.result.createdAt)
    );
  });
}

function findRecoveredCompletedDecisionEvent(
  events: RuntimeEvent[],
  record: HostRunRecord
): DecisionPacket | undefined {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome || terminalOutcome.kind !== "decision") {
    return undefined;
  }
  return events
    .filter((event): event is Extract<RuntimeEvent, { type: "decision.created" }> => event.type === "decision.created")
    .find((event) => {
      if (event.payload.decision.assignmentId !== record.assignmentId) {
        return false;
      }
      return terminalOutcome.decision.decisionId
        ? event.payload.decision.decisionId === terminalOutcome.decision.decisionId
        : event.payload.decision.blockerSummary === terminalOutcome.decision.blockerSummary &&
            event.payload.decision.recommendedOption === terminalOutcome.decision.recommendedOption &&
            event.payload.decision.createdAt === terminalOutcome.decision.createdAt;
    })?.payload.decision;
}

function hasRecoveredCompletedOutcomeEventFromEvents(events: RuntimeEvent[], record: HostRunRecord): boolean {
  return findRecoveredCompletedOutcomeEventIndexFromEvents(events, record) !== undefined;
}

function findRecoveredCompletedOutcomeEventIndexFromEvents(
  events: RuntimeEvent[],
  record: HostRunRecord
): number | undefined {
  if (!record.terminalOutcome) {
    return undefined;
  }
  if (record.terminalOutcome.kind === "decision") {
    const decisionIndex = events.findIndex((event): event is Extract<RuntimeEvent, { type: "decision.created" }> => {
      if (event.type !== "decision.created") {
        return false;
      }
      if (event.payload.decision.assignmentId !== record.assignmentId) {
        return false;
      }
      return record.terminalOutcome?.kind === "decision" &&
        (record.terminalOutcome.decision.decisionId
          ? event.payload.decision.decisionId === record.terminalOutcome.decision.decisionId
          : event.payload.decision.blockerSummary === record.terminalOutcome.decision.blockerSummary &&
              event.payload.decision.recommendedOption === record.terminalOutcome.decision.recommendedOption &&
              event.payload.decision.createdAt === record.terminalOutcome.decision.createdAt);
    });
    return decisionIndex === -1 ? undefined : decisionIndex;
  }
  const resultIndex = events.findIndex((event): event is Extract<RuntimeEvent, { type: "result.submitted" }> => {
    if (event.type !== "result.submitted") {
      return false;
    }
    if (event.payload.result.assignmentId !== record.assignmentId) {
      return false;
    }
    return record.terminalOutcome?.kind === "result" &&
      (record.terminalOutcome.result.resultId
        ? event.payload.result.resultId === record.terminalOutcome.result.resultId
        : event.payload.result.status === record.terminalOutcome.result.status &&
            event.payload.result.summary === record.terminalOutcome.result.summary &&
            event.payload.result.createdAt === record.terminalOutcome.result.createdAt);
  });
  return resultIndex === -1 ? undefined : resultIndex;
}

function hasRecoveredCompletedAssignmentStateFromEvents(
  events: RuntimeEvent[],
  record: HostRunRecord,
  recoveredDecisionState: "open" | "resolved" | undefined,
  recoveredOutcomeEventIndex?: number
): boolean {
  if (recoveredOutcomeEventIndex === undefined) {
    return false;
  }
  const expectedAssignmentState = nextAssignmentStateFromRecord(record, recoveredDecisionState);
  return events.some((event, index): event is Extract<RuntimeEvent, { type: "assignment.updated" }> => {
    if (index <= recoveredOutcomeEventIndex) {
      return false;
    }
    if (event.type !== "assignment.updated") {
      return false;
    }
    return (
      event.payload.assignmentId === record.assignmentId &&
      event.payload.patch.state === expectedAssignmentState
    );
  });
}

function hasRecoveredCompletedStatusFromEvents(
  events: RuntimeEvent[],
  record: HostRunRecord,
  expectedStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"],
  recoveredOutcomeEventIndex?: number
): boolean {
  if (recoveredOutcomeEventIndex === undefined) {
    return false;
  }
  return events.some((event, index): event is Extract<RuntimeEvent, { type: "status.updated" }> => {
    if (index <= recoveredOutcomeEventIndex) {
      return false;
    }
    if (event.type !== "status.updated") {
      return false;
    }
    const status = event.payload.status;
    if (!hasEquivalentCompletedRecoveryStatus(status, expectedStatus)) {
      return false;
    }
    return !(
      record.terminalOutcome?.kind === "result" &&
      status.activeAssignmentIds.includes(record.assignmentId)
    );
  });
}

function findRecoveredCompletedDecision(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord
) {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome || terminalOutcome.kind !== "decision") {
    return undefined;
  }
  return [...projection.decisions.values()].find((decision) => {
    if (decision.assignmentId !== record.assignmentId) {
      return false;
    }
    return terminalOutcome.decision.decisionId
      ? decision.decisionId === terminalOutcome.decision.decisionId
      : decision.blockerSummary === terminalOutcome.decision.blockerSummary &&
          decision.recommendedOption === terminalOutcome.decision.recommendedOption &&
          decision.createdAt === terminalOutcome.decision.createdAt;
  });
}

function hasRecoveredCompletedAssignmentState(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord,
  recoveredDecisionState?: "open" | "resolved"
): boolean {
  const assignment = projection.assignments.get(record.assignmentId);
  const expectedAssignmentState = nextAssignmentStateFromRecord(record, recoveredDecisionState);
  return assignment?.state === expectedAssignmentState;
}

function hasRecoveredCompletedStatus(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord,
  expectedStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"]
): boolean {
  if (!hasEquivalentCompletedRecoveryStatus(projection.status, expectedStatus)) {
    return false;
  }
  return !(
    record.terminalOutcome?.kind === "result" &&
    projection.status.activeAssignmentIds.includes(record.assignmentId)
  );
}

function hasEquivalentCompletedRecoveryStatus(
  actualStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"],
  expectedStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"]
): boolean {
  return actualStatus.activeMode === expectedStatus.activeMode &&
    actualStatus.resumeReady === expectedStatus.resumeReady &&
    actualStatus.activeAssignmentIds.length === expectedStatus.activeAssignmentIds.length &&
    actualStatus.activeAssignmentIds.every((id, index) => id === expectedStatus.activeAssignmentIds[index]);
}

function hydrateProjectionFromReplayableEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  replayableEvents?: RuntimeEvent[],
  snapshotBoundaryEventId?: string
): {
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  hydrated: boolean;
} {
  const hydrationEvents = snapshotBoundaryEventId
    ? selectReplayableSuffixEvents(replayableEvents, snapshotBoundaryEventId)
    : replayableEvents;
  if (!hydrationEvents || hydrationEvents.length === 0) {
    return {
      projection,
      hydrated: false
    };
  }

  const hydratedProjection = fromSnapshot(toSnapshot(projection));
  let hydrated = false;
  for (const event of hydrationEvents) {
    try {
      applyRuntimeEvent(hydratedProjection, event);
      hydrated = true;
    } catch {
      continue;
    }
  }
  return {
    projection: hydrated ? hydratedProjection : projection,
    hydrated
  };
}

function listHiddenActiveLeaseAssignments(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  activeLeases: string[]
): string[] {
  return activeLeases.filter((assignmentId) => !projection.assignments.has(assignmentId));
}

function hasEquivalentRuntimeStatus(
  actualStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"],
  expectedStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"]
): boolean {
  return actualStatus.currentObjective === expectedStatus.currentObjective &&
    actualStatus.activeMode === expectedStatus.activeMode &&
    actualStatus.resumeReady === expectedStatus.resumeReady &&
    actualStatus.activeAssignmentIds.length === expectedStatus.activeAssignmentIds.length &&
    actualStatus.activeAssignmentIds.every((id, index) => id === expectedStatus.activeAssignmentIds[index]);
}

function selectReplayableSuffixEvents(
  replayableEvents: RuntimeEvent[] | undefined,
  snapshotBoundaryEventId: string
): RuntimeEvent[] | undefined {
  if (!replayableEvents || replayableEvents.length === 0) {
    return undefined;
  }
  const boundaryIndex = replayableEvents.findIndex((event) => event.eventId === snapshotBoundaryEventId);
  if (boundaryIndex === -1) {
    return undefined;
  }
  return replayableEvents.slice(boundaryIndex + 1);
}

function hydrateMissingAssignmentFromReplayableEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string,
  replayableEvents?: RuntimeEvent[],
  snapshotBoundaryEventId?: string
): {
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  hydrated: boolean;
} {
  if (!replayableEvents || replayableEvents.length === 0) {
    return {
      projection,
      hydrated: false
    };
  }

  const assignmentEventFromSuffix = snapshotBoundaryEventId
    ? selectReplayableSuffixEvents(replayableEvents, snapshotBoundaryEventId)?.find(
        (event): event is Extract<RuntimeEvent, { type: "assignment.created" }> =>
          event.type === "assignment.created" && event.payload.assignment.id === assignmentId
      )
    : undefined;
  const assignmentEvent = assignmentEventFromSuffix;
  if (!assignmentEvent) {
    return {
      projection,
      hydrated: false
    };
  }

  const hydratedProjection = fromSnapshot(toSnapshot(projection));
  applyRuntimeEvent(hydratedProjection, assignmentEvent);
  return {
    projection: hydratedProjection,
    hydrated: true
  };
}

function buildRecoveredOutcomeEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord,
  timestamp: string
): RuntimeEvent[] {
  if (!record.terminalOutcome) {
    throw new Error(`Completed host run for assignment ${record.assignmentId} is missing terminal outcome data.`);
  }
  const status = nextRuntimeStatusFromRecord(projection, record, timestamp);
  const events: RuntimeEvent[] = [];

  const recoveredOutcomeEvent = buildRecoveredOutcomeEvent(
    projection.sessionId,
    timestamp,
    record
  );
  if (recoveredOutcomeEvent) {
    events.push(recoveredOutcomeEvent);
  }

  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.updated",
    payload: {
      assignmentId: record.assignmentId,
      patch: {
        state: nextAssignmentStateFromRecord(record),
        updatedAt: timestamp
      }
    }
  });
  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "status.updated",
    payload: { status }
  });

  return events;
}

export function buildOutcomeEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  execution: Awaited<ReturnType<HostAdapter["executeAssignment"]>>,
  adapter: HostAdapter
): RuntimeEvent[] {
  const timestamp = nowIso();
  const events: RuntimeEvent[] = [];

  if (execution.outcome.kind === "decision") {
    const decision = adapter.normalizeDecision(execution.outcome.capture);
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "decision.created",
      payload: { decision }
    });
  } else {
    const result = adapter.normalizeResult(execution.outcome.capture);
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "result.submitted",
      payload: { result }
    });
  }

  if (projection.workflowProgress) {
    return events;
  }

  const assignmentId = execution.run.assignmentId;
  const status = nextRuntimeStatus(projection, execution);
  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.updated",
    payload: {
      assignmentId,
      patch: {
        state: nextAssignmentState(execution),
        updatedAt: timestamp
      }
    }
  });
  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "status.updated",
    payload: { status }
  });

  return events;
}

export function getRunnableAssignment(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>
) {
  if (projection.workflowProgress) {
    const summary = deriveWorkflowSummary(projection);
    const assignmentId = projection.workflowProgress.currentAssignmentId;
    const assignment = assignmentId ? projection.assignments.get(assignmentId) : undefined;
    if (!summary) {
      throw new Error("No active workflow assignment is available to run.");
    }
    if (!assignment) {
      throw new Error(
        deriveWorkflowNextRequiredAction(projection)
        ?? "No active workflow assignment is available to run."
      );
    }
    if (!summary.rerunEligible) {
      const suffix = summary.blockerReason ? ` ${summary.blockerReason}` : "";
      throw new Error(
        `Workflow assignment ${assignment.id} is not runnable for module ${summary.currentModuleId}.${suffix}`
      );
    }
    return assignment;
  }

  const activeAssignments = projection.status.activeAssignmentIds
    .map((assignmentId) => projection.assignments.get(assignmentId))
    .filter((assignment): assignment is NonNullable<typeof assignment> => Boolean(assignment));
  if (activeAssignments.length === 0) {
    throw new Error("No active assignment is available to run.");
  }

  for (const activeAssignment of activeAssignments) {
    const unresolvedDecisions = [...projection.decisions.values()].filter(
      (decision) => decision.assignmentId === activeAssignment.id && decision.state === "open"
    );
    if (activeAssignment.state === "blocked" || unresolvedDecisions.length > 0) {
      continue;
    }
    return activeAssignment;
  }

  const blockedAssignment = activeAssignments[0]!;
  const unresolvedDecisions = [...projection.decisions.values()].filter(
    (decision) => decision.assignmentId === blockedAssignment.id && decision.state === "open"
  );
  const suffix =
    unresolvedDecisions.length > 0
      ? ` Resolve decision ${unresolvedDecisions[0]!.decisionId} first.`
      : "";
  throw new Error(`Assignment ${blockedAssignment.id} is blocked and cannot be run.${suffix}`);
}

export function projectionForRunnableAssignment(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string
) {
  return selectRunnableProjection(projection, assignmentId);
}

function nextAssignmentState(execution: Awaited<ReturnType<HostAdapter["executeAssignment"]>>) {
  if (execution.outcome.kind === "decision") {
    return "blocked" as const;
  }
  switch (execution.outcome.capture.status) {
    case "completed":
      return "completed" as const;
    case "failed":
      return "failed" as const;
    default:
      return "in_progress" as const;
  }
}

function nextRuntimeStatus(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  execution: Awaited<ReturnType<HostAdapter["executeAssignment"]>>
) {
  const assignmentId = execution.run.assignmentId;
  const terminal =
    execution.outcome.kind === "result" &&
    (execution.outcome.capture.status === "completed" || execution.outcome.capture.status === "failed");
  const activeAssignmentIds = terminal
    ? projection.status.activeAssignmentIds.filter((id) => id !== assignmentId)
    : projection.status.activeAssignmentIds;

  return {
    ...projection.status,
    activeMode: activeAssignmentIds.length === 0 ? "idle" : projection.status.activeMode,
    currentObjective:
      activeAssignmentIds.length === 0
        ? execution.outcome.kind === "result" && execution.outcome.capture.status === "failed"
          ? `Review failed assignment ${assignmentId}.`
          : "Await the next assignment."
        : projection.status.currentObjective,
    activeAssignmentIds,
    lastDurableOutputAt: nowIso(),
    resumeReady: true
  };
}

function nextAssignmentStateFromRecord(record: HostRunRecord, recoveredDecisionState?: "open" | "resolved") {
  if (!record.terminalOutcome) {
    return "failed" as const;
  }
  if (record.terminalOutcome.kind === "decision") {
    return recoveredDecisionState === "resolved" ? "in_progress" : ("blocked" as const);
  }
  switch (record.terminalOutcome.result.status) {
    case "completed":
      return "completed" as const;
    case "failed":
      return "failed" as const;
    default:
      return "in_progress" as const;
  }
}

function nextRuntimeStatusFromRecord(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord,
  timestamp: string
) {
  const terminal =
    record.terminalOutcome?.kind === "result" &&
    (record.terminalOutcome.result.status === "completed" ||
      record.terminalOutcome.result.status === "failed");
  const activeAssignmentIds = terminal
    ? projection.status.activeAssignmentIds.filter((id) => id !== record.assignmentId)
    : projection.status.activeAssignmentIds;

  return {
    ...projection.status,
    activeMode: activeAssignmentIds.length === 0 ? "idle" : projection.status.activeMode,
    currentObjective:
      activeAssignmentIds.length === 0
        ? record.terminalOutcome?.kind === "result" &&
          record.terminalOutcome.result.status === "failed"
          ? `Review failed assignment ${record.assignmentId}.`
          : "Await the next assignment."
        : projection.status.currentObjective,
    activeAssignmentIds,
    lastDurableOutputAt: timestamp,
    resumeReady: true
  };
}
