import { randomUUID } from "node:crypto";

import type { HostAdapter } from "../adapters/contract.js";
import type {
  DecisionPacket,
  HostRunRecord,
  ResultPacket
} from "../core/types.js";
import { applyRuntimeEvent, toSnapshot } from "../projections/runtime-projection.js";
import {
  buildWorkflowHiddenRunCleanup,
  buildWorkflowStaleRunRecovery,
  createActiveRunDiagnostic,
  deriveWorkflowCleanupRecord,
  deriveWorkflowRunHandling,
  deriveWorkflowRunTruth,
  shouldCleanupWorkflowRunArtifacts,
  shouldEmitCurrentWorkflowStaleReconciliation
} from "../recovery/host-runs.js";
import { recordNormalizedTelemetry } from "../telemetry/recorder.js";
import { nowIso } from "../utils/time.js";
import {
  deriveWorkflowStatus,
  evaluateWorkflowProgression
} from "../workflows/index.js";
import { RuntimeStore } from "../persistence/store.js";

import type { CommandDiagnostic } from "./types.js";

export async function loadOperatorProjection(store: RuntimeStore) {
  return (await loadOperatorProjectionWithDiagnostics(store)).projection;
}

export async function loadOperatorProjectionWithDiagnostics(store: RuntimeStore): Promise<{
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>;
  diagnostics: CommandDiagnostic[];
  snapshotFallback: boolean;
}> {
  const { projection, warning, snapshotFallback } = await store.loadProjectionWithRecovery();
  return {
    projection,
    diagnostics: diagnosticsFromWarning(warning, "event-log-salvaged"),
    snapshotFallback
  };
}

export async function loadWorkflowAwareProjectionWithDiagnostics(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<{
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>;
  diagnostics: CommandDiagnostic[];
  snapshotFallback: boolean;
  activeLeases: string[];
  hiddenActiveLeases: string[];
  recoveredRunRecord?: HostRunRecord;
}> {
  const loaded = await loadOperatorProjectionWithDiagnostics(store);
  if (!loaded.projection.workflowProgress) {
    const legacy = await import("./run-operations.js");
    const reconciled = await legacy.loadReconciledProjectionWithDiagnostics(store, adapter);
    return {
      projection: reconciled.projection,
      diagnostics: reconciled.diagnostics,
      snapshotFallback: loaded.snapshotFallback,
      activeLeases: reconciled.activeLeases,
      hiddenActiveLeases: reconciled.hiddenActiveLeases
    };
  }

  let projection = loaded.projection;
  const initialWorkflowProgress = projection.workflowProgress!;
  const diagnostics = [...loaded.diagnostics];
  const activeLeases: string[] = [];
  const hiddenActiveLeases: string[] = [];
  const pendingHiddenCleanups: Array<ReturnType<typeof buildWorkflowHiddenRunCleanup>> = [];
  let recoveredRunRecord: HostRunRecord | undefined;
  const currentAssignmentId = initialWorkflowProgress.currentAssignmentId;
  const inspectedRuns = await adapter.inspectRuns(store);
  const recordHasLease = new Map<string, boolean>();
  await Promise.all(
    inspectedRuns.map(async (record) => {
      recordHasLease.set(record.assignmentId, await adapter.hasRunLease(store, record.assignmentId));
    })
  );
  const currentRecord = currentAssignmentId
    ? inspectedRuns.find((record) => record.assignmentId === currentAssignmentId)
        ?? await adapter.inspectRun(store, currentAssignmentId)
    : undefined;
  if (currentRecord && !recordHasLease.has(currentRecord.assignmentId)) {
    recordHasLease.set(
      currentRecord.assignmentId,
      await adapter.hasRunLease(store, currentRecord.assignmentId)
    );
  }
  const inspectedWorkflowRuns = dedupeRunRecords(
    [...inspectedRuns, ...(currentRecord ? [currentRecord] : [])]
  );
  const inspectedWorkflowRunsByAssignmentId = new Map(
    inspectedWorkflowRuns.map((record) => [record.assignmentId, record] as const)
  );

  for (const record of inspectedRuns) {
    if (record.assignmentId === currentAssignmentId) {
      continue;
    }
    const truth = deriveWorkflowRunTruth(projection, record, {
      hasLeaseArtifact: recordHasLease.get(record.assignmentId) ?? false
    });
    const handling = deriveWorkflowRunHandling(record, truth);
    switch (handling.kind) {
      case "active_lease":
        diagnostics.push(createActiveRunDiagnostic(record.assignmentId, record));
        break;
      case "emit_hidden_cleanup": {
        const hiddenCleanup = buildWorkflowHiddenRunCleanup(record);
        pendingHiddenCleanups.push(hiddenCleanup);
        diagnostics.push(
          ...await cleanupRunArtifactsWithDiagnostics(
            store,
            adapter,
            handling.cleanupRecord ?? hiddenCleanup.staleRecord
          )
        );
        recordHasLease.set(record.assignmentId, false);
        break;
      }
      case "cleanup_only":
        diagnostics.push(
          ...await cleanupRunArtifactsWithDiagnostics(
            store,
            adapter,
            handling.cleanupRecord ?? deriveWorkflowCleanupRecord(record)
          )
        );
        recordHasLease.set(record.assignmentId, false);
        break;
      case "recover_completed":
      case "ignore":
        break;
    }
  }

  const currentTruthAtLoad = currentRecord
    ? deriveWorkflowRunTruth(projection, currentRecord, {
        hasLeaseArtifact: recordHasLease.get(currentRecord.assignmentId) ?? false
      })
    : undefined;

  const currentHandling = currentRecord && currentTruthAtLoad
    ? deriveWorkflowRunHandling(currentRecord, currentTruthAtLoad)
    : undefined;

  if (currentRecord && currentHandling?.kind === "active_lease") {
    diagnostics.push(createActiveRunDiagnostic(currentRecord.assignmentId, currentRecord));
  } else if (currentRecord && currentHandling?.kind === "recover_completed") {
    const recoveredEvents = buildWorkflowRecoveredOutcomeEvents(projection.sessionId, currentRecord);
    if (recoveredEvents.length > 0) {
      const persisted = await persistWorkflowEvents(
        store,
        projection,
        recoveredEvents,
        loaded.snapshotFallback
      );
      projection = persisted.projection;
      diagnostics.push(...persisted.diagnostics);
      diagnostics.push({
        level: "warning",
        code: "completed-run-reconciled",
        message: `Recovered completed host outcome for assignment ${currentRecord.assignmentId} after runtime event persistence was interrupted.`
      });
      recoveredRunRecord = currentRecord;
    }
    diagnostics.push(
      ...await cleanupRunArtifactsWithDiagnostics(
        store,
        adapter,
        currentHandling?.cleanupRecord ?? deriveWorkflowCleanupRecord(currentRecord)
      )
    );
    recordHasLease.set(currentRecord.assignmentId, false);
  } else if (currentRecord && currentHandling?.kind === "cleanup_only") {
    diagnostics.push(
      ...await cleanupRunArtifactsWithDiagnostics(
        store,
        adapter,
        currentHandling.cleanupRecord ?? deriveWorkflowCleanupRecord(currentRecord)
      )
    );
    recordHasLease.set(currentRecord.assignmentId, false);
  }

  const staleRecovery = currentRecord &&
    currentTruthAtLoad?.staleCandidate &&
    !currentTruthAtLoad.hasDurableCurrentOutcome &&
    !currentTruthAtLoad.hasDurableStaleRecovery
    ? buildWorkflowStaleRunRecovery(currentRecord)
    : undefined;

  const initialConvergence = await convergeWorkflowProjection(
    store,
    projection,
    loaded.snapshotFallback,
    staleRecovery
  );
  projection = initialConvergence.projection;
  diagnostics.push(...initialConvergence.diagnostics);

  const currentTruthAfterConvergence = currentRecord
    ? deriveWorkflowRunTruth(projection, currentRecord, {
        hasLeaseArtifact: recordHasLease.get(currentRecord.assignmentId)
          ?? await adapter.hasRunLease(store, currentRecord.assignmentId)
      })
    : undefined;
  if (staleRecovery && currentTruthAtLoad && currentTruthAfterConvergence) {
    if (shouldEmitCurrentWorkflowStaleReconciliation(currentTruthAtLoad, currentTruthAfterConvergence)) {
      diagnostics.push(
        ...await emitWorkflowStaleReconciliation(
          store,
          adapter,
          projection.sessionId,
          staleRecovery
        )
      );
      diagnostics.push(
        ...await cleanupRunArtifactsWithDiagnostics(store, adapter, staleRecovery.staleRecord)
      );
    } else if (shouldCleanupWorkflowRunArtifacts(currentTruthAfterConvergence)) {
      diagnostics.push(...await cleanupRunArtifactsWithDiagnostics(store, adapter, staleRecovery.staleRecord));
    }
  }

  const currentRunReconciliation = await reconcileCurrentWorkflowRunAfterConvergence(
    store,
    adapter,
    projection,
    loaded.snapshotFallback,
    inspectedWorkflowRunsByAssignmentId,
    recordHasLease
  );
  projection = currentRunReconciliation.projection;
  diagnostics.push(...currentRunReconciliation.diagnostics);
  recoveredRunRecord = currentRunReconciliation.recoveredRunRecord ?? recoveredRunRecord;

  for (const cleanup of pendingHiddenCleanups) {
    if (projection.workflowProgress?.currentAssignmentId === cleanup.staleRecord.assignmentId) {
      continue;
    }
    diagnostics.push(
      ...await emitWorkflowHiddenRunCleanup(store, adapter, projection.sessionId, cleanup)
    );
  }

  const finalLeaseClassification = await classifyWorkflowLeaseVisibility(
    store,
    adapter,
    projection,
    [...inspectedWorkflowRunsByAssignmentId.values()]
  );
  activeLeases.push(...finalLeaseClassification.activeLeases);
  hiddenActiveLeases.push(...finalLeaseClassification.hiddenActiveLeases);

  return {
    projection,
    diagnostics,
    snapshotFallback: loaded.snapshotFallback,
    activeLeases,
    hiddenActiveLeases,
    ...(recoveredRunRecord ? { recoveredRunRecord } : {})
  };
}

export function diagnosticsFromWarning(
  warning: string | undefined,
  code: CommandDiagnostic["code"]
): CommandDiagnostic[] {
  return warning ? [{ level: "warning", code, message: warning }] : [];
}

async function emitWorkflowStaleReconciliation(
  store: RuntimeStore,
  adapter: HostAdapter,
  sessionId: string,
  recovery: ReturnType<typeof buildWorkflowStaleRunRecovery>
): Promise<CommandDiagnostic[]> {
  const diagnostics: CommandDiagnostic[] = [recovery.diagnostic];
  const telemetry = await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry({
      eventType: "host.run.stale_reconciled",
      taskId: sessionId,
      assignmentId: recovery.staleRecord.assignmentId,
      metadata: recovery.telemetryMetadata
    })
  );
  diagnostics.push(...diagnosticsFromWarning(telemetry.warning, "telemetry-write-failed"));
  return diagnostics;
}

async function emitWorkflowHiddenRunCleanup(
  store: RuntimeStore,
  adapter: HostAdapter,
  sessionId: string,
  cleanup: ReturnType<typeof buildWorkflowHiddenRunCleanup>
): Promise<CommandDiagnostic[]> {
  const diagnostics: CommandDiagnostic[] = [cleanup.diagnostic];
  const telemetry = await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry({
      eventType: "host.run.hidden_stale_cleaned",
      taskId: sessionId,
      assignmentId: cleanup.staleRecord.assignmentId,
      metadata: cleanup.telemetryMetadata
    })
  );
  diagnostics.push(...diagnosticsFromWarning(telemetry.warning, "telemetry-write-failed"));
  return diagnostics;
}

async function cleanupRunArtifactsWithDiagnostics(
  store: RuntimeStore,
  adapter: HostAdapter,
  record: HostRunRecord
): Promise<CommandDiagnostic[]> {
  const cleanupError = await cleanupRunArtifacts(store, adapter, record);
  return cleanupError
    ? diagnosticsFromWarning(
        `Host run reconciliation artifacts could not be updated for assignment ${record.assignmentId}. ${cleanupError.message}`,
        "host-run-persist-failed"
      )
    : [];
}

async function classifyWorkflowLeaseVisibility(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>,
  records: HostRunRecord[]
): Promise<{
  activeLeases: string[];
  hiddenActiveLeases: string[];
}> {
  const activeLeases: string[] = [];
  const hiddenActiveLeases: string[] = [];
  for (const record of records) {
    const truth = deriveWorkflowRunTruth(projection, record, {
      hasLeaseArtifact: await adapter.hasRunLease(store, record.assignmentId)
    });
    if (!truth.activeLease) {
      continue;
    }
    activeLeases.push(record.assignmentId);
    if (!truth.isCurrentAssignment) {
      hiddenActiveLeases.push(record.assignmentId);
    }
  }
  return {
    activeLeases,
    hiddenActiveLeases
  };
}

async function reconcileCurrentWorkflowRunAfterConvergence(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>,
  snapshotFallback: boolean,
  inspectedRunsByAssignmentId: Map<string, HostRunRecord>,
  recordHasLease: Map<string, boolean>
): Promise<{
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>;
  diagnostics: CommandDiagnostic[];
  recoveredRunRecord?: HostRunRecord;
}> {
  const diagnostics: CommandDiagnostic[] = [];
  let effectiveProjection = projection;
  let recoveredRunRecord: HostRunRecord | undefined;
  const reconciledAssignmentIds = new Set<string>();

  for (let iteration = 0; iteration < 10; iteration += 1) {
    const currentAssignmentId = effectiveProjection.workflowProgress?.currentAssignmentId;
    if (!currentAssignmentId || reconciledAssignmentIds.has(currentAssignmentId)) {
      break;
    }
    reconciledAssignmentIds.add(currentAssignmentId);
    const currentRecord = await resolveWorkflowRunRecord(
      store,
      adapter,
      currentAssignmentId,
      inspectedRunsByAssignmentId,
      recordHasLease
    );
    if (!currentRecord) {
      break;
    }

    const currentTruthBefore = deriveWorkflowRunTruth(effectiveProjection, currentRecord, {
      hasLeaseArtifact: recordHasLease.get(currentAssignmentId) ?? false
    });
    const currentHandling = deriveWorkflowRunHandling(currentRecord, currentTruthBefore);
    let projectionChanged = false;

    if (currentHandling.kind === "recover_completed") {
      const recoveredEvents = buildWorkflowRecoveredOutcomeEvents(
        effectiveProjection.sessionId,
        currentRecord
      );
      if (recoveredEvents.length > 0) {
        const persisted = await persistWorkflowEvents(
          store,
          effectiveProjection,
          recoveredEvents,
          snapshotFallback
        );
        effectiveProjection = persisted.projection;
        diagnostics.push(...persisted.diagnostics);
        diagnostics.push({
          level: "warning",
          code: "completed-run-reconciled",
          message: `Recovered completed host outcome for assignment ${currentRecord.assignmentId} after runtime event persistence was interrupted.`
        });
        recoveredRunRecord = currentRecord;
        projectionChanged = true;
      }
      diagnostics.push(
        ...await cleanupRunArtifactsWithDiagnostics(
          store,
          adapter,
          currentHandling.cleanupRecord ?? deriveWorkflowCleanupRecord(currentRecord)
        )
      );
      recordHasLease.set(currentRecord.assignmentId, false);
    } else if (currentHandling.kind === "cleanup_only") {
      diagnostics.push(
        ...await cleanupRunArtifactsWithDiagnostics(
          store,
          adapter,
          currentHandling.cleanupRecord ?? deriveWorkflowCleanupRecord(currentRecord)
        )
      );
      recordHasLease.set(currentRecord.assignmentId, false);
    }

    const staleRecovery = currentTruthBefore.staleCandidate &&
      !currentTruthBefore.hasDurableCurrentOutcome &&
      !currentTruthBefore.hasDurableStaleRecovery
      ? buildWorkflowStaleRunRecovery(currentRecord)
      : undefined;

    if (projectionChanged || staleRecovery) {
      const converged = await convergeWorkflowProjection(
        store,
        effectiveProjection,
        snapshotFallback,
        staleRecovery
      );
      effectiveProjection = converged.projection;
      diagnostics.push(...converged.diagnostics);
    }

    if (staleRecovery) {
      const currentTruthAfter = deriveWorkflowRunTruth(effectiveProjection, currentRecord, {
        hasLeaseArtifact:
          recordHasLease.get(currentRecord.assignmentId)
            ?? await adapter.hasRunLease(store, currentRecord.assignmentId)
      });
      if (shouldEmitCurrentWorkflowStaleReconciliation(currentTruthBefore, currentTruthAfter)) {
        diagnostics.push(
          ...await emitWorkflowStaleReconciliation(
            store,
            adapter,
            effectiveProjection.sessionId,
            staleRecovery
          )
        );
        diagnostics.push(
          ...await cleanupRunArtifactsWithDiagnostics(store, adapter, staleRecovery.staleRecord)
        );
        recordHasLease.set(currentRecord.assignmentId, false);
      } else if (shouldCleanupWorkflowRunArtifacts(currentTruthAfter)) {
        diagnostics.push(
          ...await cleanupRunArtifactsWithDiagnostics(store, adapter, staleRecovery.staleRecord)
        );
        recordHasLease.set(currentRecord.assignmentId, false);
      }
    }

    if (!projectionChanged && !staleRecovery) {
      break;
    }
  }

  return {
    projection: effectiveProjection,
    diagnostics,
    ...(recoveredRunRecord ? { recoveredRunRecord } : {})
  };
}

async function resolveWorkflowRunRecord(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId: string,
  inspectedRunsByAssignmentId: Map<string, HostRunRecord>,
  recordHasLease: Map<string, boolean>
): Promise<HostRunRecord | undefined> {
  let record = inspectedRunsByAssignmentId.get(assignmentId);
  if (!record) {
    record = await adapter.inspectRun(store, assignmentId);
    if (record) {
      inspectedRunsByAssignmentId.set(assignmentId, record);
    }
  }
  if (record && !recordHasLease.has(assignmentId)) {
    recordHasLease.set(assignmentId, await adapter.hasRunLease(store, assignmentId));
  }
  return record;
}

async function convergeWorkflowProjection(
  store: RuntimeStore,
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>,
  snapshotFallback: boolean,
  staleRecovery?: ReturnType<typeof buildWorkflowStaleRunRecovery>
): Promise<{
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>;
  diagnostics: CommandDiagnostic[];
}> {
  let effectiveProjection = projection;
  const diagnostics: CommandDiagnostic[] = [];
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const progression = await evaluateWorkflowProgression(effectiveProjection, store, {
      timestamp: nowIso(),
      staleRunFacts:
        staleRecovery &&
        effectiveProjection.workflowProgress?.currentAssignmentId === staleRecovery.staleRecord.assignmentId
          ? [{
              assignmentId: staleRecovery.staleRecord.assignmentId,
              staleAt: staleRecovery.staleRecord.staleAt ?? nowIso()
            }]
          : []
    });
    if (progression.events.length > 0) {
      const persisted = await persistWorkflowEvents(
        store,
        effectiveProjection,
        progression.events,
        snapshotFallback
      );
      effectiveProjection = persisted.projection;
      diagnostics.push(...persisted.diagnostics);
      continue;
    }
    const syncedStatus = await syncWorkflowStatus(store, effectiveProjection, snapshotFallback);
    if (syncedStatus.changed) {
      effectiveProjection = syncedStatus.projection;
      diagnostics.push(...syncedStatus.diagnostics);
      continue;
    }
    break;
  }
  return {
    projection: effectiveProjection,
    diagnostics
  };
}

async function persistWorkflowEvents(
  store: RuntimeStore,
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>,
  events: import("../core/events.js").RuntimeEvent[],
  snapshotFallback: boolean
): Promise<{
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>;
  diagnostics: CommandDiagnostic[];
}> {
  const effectiveProjection = cloneProjectionForPersistence(projection);
  for (const event of events) {
    await store.appendEvent(event);
    applyRuntimeEvent(effectiveProjection, event);
  }
  if (snapshotFallback) {
    await store.writeSnapshot(toSnapshot(effectiveProjection));
    return { projection: effectiveProjection, diagnostics: [] };
  }
  const synced = await store.syncSnapshotFromEventsWithRecovery();
  return {
    projection: synced.projection,
    diagnostics: diagnosticsFromWarning(synced.warning, "event-log-repaired")
  };
}

async function syncWorkflowStatus(
  store: RuntimeStore,
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>,
  snapshotFallback: boolean
): Promise<{
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>;
  diagnostics: CommandDiagnostic[];
  changed: boolean;
}> {
  if (!projection.workflowProgress) {
    return { projection, diagnostics: [], changed: false };
  }
  const status = deriveWorkflowStatus(projection, deriveWorkflowStatusTimestamp(projection));
  if (hasEquivalentStatus(projection.status, status)) {
    return { projection, diagnostics: [], changed: false };
  }
  const persisted = await persistWorkflowEvents(
    store,
    projection,
    [
      {
        eventId: randomUUID(),
        sessionId: projection.sessionId,
        timestamp: nowIso(),
        type: "status.updated",
        payload: { status }
      }
    ],
    snapshotFallback
  );
  return {
    projection: persisted.projection,
    diagnostics: persisted.diagnostics,
    changed: true
  };
}

function cloneProjectionForPersistence(
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>
): Awaited<ReturnType<RuntimeStore["loadProjection"]>> {
  return {
    ...projection,
    status: { ...projection.status },
    assignments: new Map(
      [...projection.assignments.entries()].map(([assignmentId, assignment]) => [
        assignmentId,
        { ...assignment }
      ])
    ),
    results: new Map(
      [...projection.results.entries()].map(([resultId, result]) => [resultId, { ...result }])
    ),
    decisions: new Map(
      [...projection.decisions.entries()].map(([decisionId, decision]) => [
        decisionId,
        { ...decision }
      ])
    ),
    ...(projection.workflowProgress
      ? {
          workflowProgress: JSON.parse(JSON.stringify(projection.workflowProgress))
        }
      : {})
  };
}

function hasEquivalentStatus(
  left: Awaited<ReturnType<RuntimeStore["loadProjection"]>>["status"],
  right: Awaited<ReturnType<RuntimeStore["loadProjection"]>>["status"]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dedupeRunRecords(records: HostRunRecord[]): HostRunRecord[] {
  const byAssignmentId = new Map<string, HostRunRecord>();
  for (const record of records) {
    if (!byAssignmentId.has(record.assignmentId)) {
      byAssignmentId.set(record.assignmentId, record);
    }
  }
  return [...byAssignmentId.values()];
}

function deriveWorkflowStatusTimestamp(
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>
): string {
  const timestamps = [
    projection.status.lastDurableOutputAt,
    ...[...projection.assignments.values()].flatMap((assignment) => [
      assignment.createdAt,
      assignment.updatedAt
    ]),
    ...[...projection.results.values()].map((result) => result.createdAt),
    ...[...projection.decisions.values()].flatMap((decision) =>
      decision.resolvedAt ? [decision.createdAt, decision.resolvedAt] : [decision.createdAt]
    ),
    projection.workflowProgress?.lastGate?.evaluatedAt ?? "",
    projection.workflowProgress?.lastTransition?.appliedAt ?? ""
  ].filter((value) => value.length > 0);
  return timestamps.sort().at(-1) ?? "";
}

function buildWorkflowRecoveredOutcomeEvents(
  sessionId: string,
  record: HostRunRecord
): import("../core/events.js").RuntimeEvent[] {
  if (!record.terminalOutcome) {
    return [];
  }
  const timestamp = nowIso();
  if (record.terminalOutcome.kind === "result") {
    const result: ResultPacket = {
      resultId: record.terminalOutcome.result.resultId ?? randomUUID(),
      assignmentId: record.assignmentId,
      producerId: record.terminalOutcome.result.producerId,
      status: record.terminalOutcome.result.status,
      summary: record.terminalOutcome.result.summary,
      changedFiles: [...record.terminalOutcome.result.changedFiles],
      createdAt: record.terminalOutcome.result.createdAt
    };
    return [
      {
        eventId: randomUUID(),
        sessionId,
        timestamp,
        type: "result.submitted",
        payload: { result }
      }
    ];
  }
  const decision: DecisionPacket = {
    decisionId: record.terminalOutcome.decision.decisionId ?? randomUUID(),
    assignmentId: record.assignmentId,
    requesterId: record.terminalOutcome.decision.requesterId,
    blockerSummary: record.terminalOutcome.decision.blockerSummary,
    options: record.terminalOutcome.decision.options.map((option) => ({ ...option })),
    recommendedOption: record.terminalOutcome.decision.recommendedOption,
    state: record.terminalOutcome.decision.state,
    createdAt: record.terminalOutcome.decision.createdAt
  };
  return [
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "decision.created",
      payload: { decision }
    }
  ];
}

async function cleanupRunArtifacts(
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
    return new Error(
      `Host run reconciliation failed to clear the active lease for assignment ${record.assignmentId}. ${
        cleanupError?.message ?? "The lease artifact remained on disk."
      }`
    );
  }
  return cleanupError;
}
