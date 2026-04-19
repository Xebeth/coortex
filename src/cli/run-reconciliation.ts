import type { HostAdapter } from "../adapters/contract.js";
import { getNativeRunId, getRunInstanceId, isRunLeaseExpired } from "../core/run-state.js";
import type { RuntimeEvent } from "../core/events.js";
import type { HostRunRecord, RuntimeProjection } from "../core/types.js";
import { fromSnapshot, toSnapshot } from "../projections/runtime-projection.js";
import {
  ProjectionRecoveryService,
  selectReplayableSuffixEvents
} from "../persistence/projection-recovery.js";
import { RuntimeStore } from "../persistence/store.js";
import { buildStaleRunReconciliation, createActiveRunDiagnostic } from "../recovery/host-runs.js";
import {
  buildCompletedRunReconciliation,
  buildCompletedRunRecordFromRuntimeOutcome,
  hydrateCompletedDecisionFromReplayableEvents
} from "../recovery/completed-runs.js";
import { recordNormalizedTelemetry } from "../telemetry/recorder.js";
import { nowIso } from "../utils/time.js";
import { AttachmentLifecycleService } from "./attachment-lifecycle.js";
import {
  getActiveClaimForAssignment,
  listProvisionalAttachmentClaims
} from "../projections/attachment-claim-queries.js";
import {
  reconcileStaleRunWithLeaseVerification
} from "./host-run-cleanup.js";
import type { CommandDiagnostic } from "./types.js";
import { loadOperatorProjectionWithDiagnostics } from "./runtime-state.js";

type ProjectionWriteOptions = {
  snapshotFallback?: boolean;
};

export interface RunReconciliationDiagnostic {
  level: "warning";
  code:
    | "event-log-repaired"
    | "telemetry-write-failed"
    | "host-run-persist-failed"
    | "active-run-present"
    | "stale-run-reconciled"
    | "completed-run-reconciled"
    | "provisional-attachment-promoted"
    | "provisional-attachment-cleared";
  message: string;
}

export interface RunReconciliationResult {
  projection: RuntimeProjection;
  diagnostics: RunReconciliationDiagnostic[];
  activeLeases: string[];
}

export interface RunReconciliationOptions {
  snapshotFallback?: boolean;
}

interface RunReconciliationContext {
  store: RuntimeStore;
  adapter: HostAdapter;
  projectionRecovery: ProjectionRecoveryService;
}

interface CompletedRunReconciliationResult {
  projection: RuntimeProjection;
  changed: boolean;
  handled: boolean;
  replayableHydrated: boolean;
}

interface RecoveryProjectionOptions {
  snapshotFallback: boolean;
  replayableEvents: RuntimeEvent[] | undefined;
  snapshotBoundaryEventId: string | undefined;
}

export class RunReconciliationService {
  private readonly projectionRecovery: ProjectionRecoveryService;

  constructor(
    private readonly store: RuntimeStore,
    private readonly adapter: HostAdapter
  ) {
    this.projectionRecovery = new ProjectionRecoveryService(store);
  }

  async reconcileActiveRuns(
    projection: RuntimeProjection,
    options?: RunReconciliationOptions
  ): Promise<RunReconciliationResult> {
    return reconcileActiveRunsInContext(
      {
        store: this.store,
        adapter: this.adapter,
        projectionRecovery: this.projectionRecovery
      },
      projection,
      options
    );
  }
}

function listHiddenActiveLeaseAssignments(
  projection: RuntimeProjection,
  activeLeases: string[]
): string[] {
  return activeLeases.filter((assignmentId) => !projection.assignments.has(assignmentId));
}

export async function reconcileActiveRuns(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: RuntimeProjection,
  options?: RunReconciliationOptions
): Promise<RunReconciliationResult> {
  return new RunReconciliationService(store, adapter).reconcileActiveRuns(projection, options);
}

export async function loadReconciledProjectionWithDiagnostics(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<{
  projection: RuntimeProjection;
  diagnostics: CommandDiagnostic[];
  activeLeases: string[];
  hiddenActiveLeases: string[];
  snapshotFallback: boolean;
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
    hiddenActiveLeases,
    snapshotFallback: loaded.snapshotFallback
  };
}

async function reconcileActiveRunsInContext(
  context: RunReconciliationContext,
  projection: RuntimeProjection,
  options?: RunReconciliationOptions
): Promise<RunReconciliationResult> {
  const diagnostics: RunReconciliationDiagnostic[] = [];
  const snapshotFallback = options?.snapshotFallback ?? false;
  const snapshotBoundaryEventId = snapshotFallback ? (await context.store.loadSnapshot())?.lastEventId : undefined;
  const replayableEvents = snapshotFallback
    ? (await context.projectionRecovery.loadReplayableEvents()).events
    : undefined;
  let effectiveProjection = fromSnapshot(toSnapshot(projection));
  let changed = false;
  let snapshotFallbackReplayHydrated = false;
  let handledCompletedRun = false;
  const runtimeKnownAssignmentIds = [...projection.assignments.keys()];
  const enumeratedRecords = await context.adapter.inspectRuns(context.store);
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
    const replayableHydration = context.projectionRecovery.hydrateProjectionFromReplayableEvents(
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
      ?? await context.adapter.inspectRun(context.store, assignmentId);
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
      const replayableHydration = context.projectionRecovery.hydrateMissingAssignmentFromReplayableEvents(
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
      ? buildCompletedRunRecordFromRuntimeOutcome(effectiveProjection, record)
      : undefined;
    if (durableRuntimeCompletedRecord) {
      handledCompletedRun = true;
      const completedRecovery = await reconcileCompletedRunRecord(
        context,
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
        context,
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
            context,
            effectiveProjection,
            assignmentId,
            record,
            diagnostics
          );
          continue;
        }

        changed = true;
        effectiveProjection = await reconcileInProjectionStaleRun(
          context,
          effectiveProjection,
          assignmentId,
          record,
          diagnostics,
          {
            snapshotFallback,
            replayableEvents,
            snapshotBoundaryEventId
          },
          {
            alreadyReconciledCleanupRecord: record
          }
        );
        continue;
      }

      continue;
    }

    if (!effectiveProjection.assignments.has(assignmentId)) {
      if (!isLiveLeaseRecord(record) && snapshotFallback && isStaleRunReconciliationCandidate(record)) {
        await reconcileOutOfProjectionStaleRun(
          context,
          effectiveProjection,
          assignmentId,
          record,
          diagnostics
        );
      }
      continue;
    }

    if (!isRunLeaseExpired(record)) {
      continue;
    }

    changed = true;
    effectiveProjection = await reconcileInProjectionStaleRun(
      context,
      effectiveProjection,
      assignmentId,
      record,
      diagnostics,
      {
        snapshotFallback,
        replayableEvents,
        snapshotBoundaryEventId
      }
    );
  }

  const record = await context.adapter.inspectRun(context.store);
  if (
    !handledCompletedRun &&
    record?.state === "completed" &&
    record.terminalOutcome &&
    !assignmentIdsToInspect.includes(record.assignmentId)
  ) {
    const completedRecovery = await reconcileCompletedRunRecord(
      context,
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

  const reconciledRecordsBeforeProvisional = await context.adapter.inspectRuns(context.store);
  const provisionalReconciliation = await reconcileProvisionalAttachmentClaims(
    context,
    effectiveProjection,
    diagnostics,
    new Map(reconciledRecordsBeforeProvisional.map((record) => [record.assignmentId, record] as const)),
    { snapshotFallback }
  );
  effectiveProjection = provisionalReconciliation.projection;
  changed ||= provisionalReconciliation.changed;
  const finalLeaseRecords = await context.adapter.inspectRuns(context.store);
  const finalLiveLeaseRecords = finalLeaseRecords.filter(isLiveLeaseRecord);
  const finalActiveLeases = finalLiveLeaseRecords.map((record) => record.assignmentId);

  return {
    projection: changed ? effectiveProjection : projection,
    diagnostics: [
      ...diagnostics,
      ...finalLiveLeaseRecords.map((record) => createActiveRunDiagnostic(record.assignmentId, record))
    ],
    activeLeases: finalActiveLeases
  };
}

async function reconcileProvisionalAttachmentClaims(
  context: RunReconciliationContext,
  projection: RuntimeProjection,
  diagnostics: RunReconciliationDiagnostic[],
  recordByAssignmentId: Map<string, HostRunRecord>,
  options?: ProjectionWriteOptions
): Promise<{
  projection: RuntimeProjection;
  changed: boolean;
}> {
  let effectiveProjection = projection;
  let changed = false;

  for (const { attachment, claim } of listProvisionalAttachmentClaims(effectiveProjection)) {
    const assignment = effectiveProjection.assignments.get(claim.assignmentId);
    const record =
      recordByAssignmentId.get(claim.assignmentId)
      ?? await context.adapter.inspectRun(context.store, claim.assignmentId);
    const liveNativeSessionId = getNativeRunId(record);
    const hasLiveLease = isLiveLeaseRecord(record);

    if (hasLiveLease && liveNativeSessionId) {
      effectiveProjection = await AttachmentLifecycleService.promoteProvisionalAttachment(
        context.store,
        effectiveProjection,
        attachment.id,
        claim.id,
        liveNativeSessionId,
        record?.adapterData,
        options
      );
      diagnostics.push({
        level: "warning",
        code: "provisional-attachment-promoted",
        message: `Promoted provisional attachment ${attachment.id} for assignment ${claim.assignmentId} into resumable attachment truth.`
      });
      changed = true;
      continue;
    }

    const startedHostRun = !!record;
    const shouldRequeue = assignment?.state === "in_progress";
    const cleanupReason = hasLiveLease
      ? "Wrapped launch left only unverifiable provisional session state."
      : "Wrapped launch ended before native session identity could be finalized.";
    if (startedHostRun || shouldRequeue) {
      const clearedProvisional = await AttachmentLifecycleService.cleanupHostRunArtifactsAndOrphanClaim(
        context.store,
        context.adapter,
        effectiveProjection,
        attachment,
        claim,
        cleanupReason,
        {
          cleanupOrder: "after_orphan",
          ...(record ? { inspectedRecord: record } : {}),
          ...(shouldRequeue && assignment ? { requeueObjective: assignment.objective } : {})
        },
        options
      );
      effectiveProjection = clearedProvisional.projection;
      diagnostics.push(...warningDiagnostics(clearedProvisional.cleanupWarning, "host-run-persist-failed"));
    } else {
      const releasedProvisional = await AttachmentLifecycleService.cleanupHostRunArtifactsAndReleaseClaim(
        context.store,
        context.adapter,
        effectiveProjection,
        attachment,
        claim,
        {
          attachment: "Wrapped launch did not establish a durable host session.",
          claim: "Wrapped launch did not establish a durable host session."
        },
        cleanupReason,
        {
          ...(record ? { inspectedRecord: record } : {})
        },
        options
      );
      effectiveProjection = releasedProvisional.projection;
      diagnostics.push(...warningDiagnostics(releasedProvisional.cleanupWarning, "host-run-persist-failed"));
    }
    diagnostics.push({
      level: "warning",
      code: "provisional-attachment-cleared",
      message: `Cleared provisional attachment ${attachment.id} for assignment ${claim.assignmentId} because launch did not finalize into resumable attachment truth.`
    });
    changed = true;
  }

  return {
    projection: effectiveProjection,
    changed
  };
}

async function reconcileCompletedRunRecord(
  context: RunReconciliationContext,
  projection: RuntimeProjection,
  record: HostRunRecord,
  diagnostics: RunReconciliationDiagnostic[],
  options: {
    cleanupRecord: HostRunRecord | undefined;
    replayableEvents: RuntimeEvent[] | undefined;
    snapshotBoundaryEventId: string | undefined;
    snapshotFallback: boolean;
  }
): Promise<CompletedRunReconciliationResult> {
  let effectiveProjection = projection;
  let changed = false;
  const replayableHydration = context.projectionRecovery.hydrateProjectionFromReplayableEvents(
    effectiveProjection,
    options.replayableEvents,
    options.snapshotBoundaryEventId
  );
  if (replayableHydration.hydrated) {
    effectiveProjection = replayableHydration.projection;
    changed = true;
  }
  if (options.snapshotFallback && !effectiveProjection.assignments.has(record.assignmentId)) {
    const missingAssignmentHydration = context.projectionRecovery.hydrateMissingAssignmentFromReplayableEvents(
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
  if (options.snapshotFallback && !effectiveProjection.assignments.has(record.assignmentId)) {
    return {
      projection: effectiveProjection,
      changed,
      handled: false,
      replayableHydrated: replayableHydration.hydrated
    };
  }

  const completedReplayableEvents =
    options.replayableEvents ??
    (options.snapshotFallback ? undefined : (await context.projectionRecovery.loadReplayableEvents()).events);
  const completedRecoveryProofEvents = options.snapshotFallback
    ? selectReplayableSuffixEvents(
        completedReplayableEvents,
        options.snapshotBoundaryEventId ?? ""
      )
    : completedReplayableEvents;
  const completedDecisionHydration = hydrateCompletedDecisionFromReplayableEvents(
    effectiveProjection,
    record,
    completedRecoveryProofEvents
  );
  if (completedDecisionHydration.hydrated) {
    effectiveProjection = completedDecisionHydration.projection;
    changed = true;
  }
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

  const completedAuthorityEvents = AttachmentLifecycleService.buildCompletedAuthorityRepairEvents(
    effectiveProjection,
    record,
    completedRecovery.allEvents[0]?.timestamp ?? nowIso()
  );
  const completedEvents = [...completedRecovery.events, ...completedAuthorityEvents];

  if (completedEvents.length > 0) {
    changed = true;
    effectiveProjection = await applyRecoveryProjectionEvents(
      context,
      effectiveProjection,
      completedEvents,
      diagnostics,
      {
        snapshotFallback: options.snapshotFallback,
        replayableEvents: options.replayableEvents,
        snapshotBoundaryEventId: options.snapshotBoundaryEventId
      }
    );
    diagnostics.push(completedRecovery.diagnostic);
  } else if (options.snapshotFallback) {
    changed = true;
    effectiveProjection = await applyRecoveryProjectionEvents(
      context,
      effectiveProjection,
      [],
      diagnostics,
      {
        snapshotFallback: true,
        replayableEvents: options.replayableEvents,
        snapshotBoundaryEventId: options.snapshotBoundaryEventId
      }
    );
    diagnostics.push(completedRecovery.diagnostic);
  } else {
    changed = true;
    effectiveProjection = await applyRecoveryProjectionEvents(
      context,
      effectiveProjection,
      [],
      diagnostics,
      {
        snapshotFallback: false,
        replayableEvents: options.replayableEvents,
        snapshotBoundaryEventId: options.snapshotBoundaryEventId
      }
    );
  }

  const cleanupError = await reconcileStaleRunWithLeaseVerification(
    context.store,
    context.adapter,
    selectCompletedRunCleanupRecord(record, options.cleanupRecord)
  );
  if (cleanupError) {
    diagnostics.push(
      ...warningDiagnostics(
        `Host run reconciliation artifacts could not be updated for assignment ${record.assignmentId}. ${cleanupError.message}`,
        "host-run-persist-failed"
      )
    );
  }

  return {
    projection: effectiveProjection,
    changed,
    handled: true,
    replayableHydrated: replayableHydration.hydrated
  };
}

async function reconcileInProjectionStaleRun(
  context: RunReconciliationContext,
  projection: RuntimeProjection,
  assignmentId: string,
  record: HostRunRecord,
  diagnostics: RunReconciliationDiagnostic[],
  recoveryOptions: RecoveryProjectionOptions,
  options?: {
    alreadyReconciledCleanupRecord?: HostRunRecord;
  }
): Promise<RuntimeProjection> {
  const staleRecoveryState = getStaleRunRecoveryState(
    projection,
    assignmentId,
    record
  );
  const reconciliation = buildStaleRunReconciliation(projection, assignmentId, record);
  if (
    isStaleRunAlreadyReconciled(
      projection,
      assignmentId,
      staleRecoveryState
    )
  ) {
    const syncedProjection = await context.projectionRecovery.syncProjectionSnapshot({
      snapshotFallback: recoveryOptions.snapshotFallback
    });
    diagnostics.push(...warningDiagnostics(syncedProjection.warning, "event-log-repaired"));
    await addHostRunPersistFailureWarnings(
      context,
      diagnostics,
      options?.alreadyReconciledCleanupRecord ?? reconciliation.staleRecord
    );
    return syncedProjection.projection;
  }

  const pendingEvents = selectPendingStaleRecoveryEvents(reconciliation.events, staleRecoveryState);
  const authorityRepairEvents = AttachmentLifecycleService.buildStaleAuthorityRepairEvents(
    projection,
    assignmentId,
    reconciliation.events[0]?.timestamp ?? nowIso()
  );
  const recoveryEvents = [...pendingEvents, ...authorityRepairEvents];

  await addHostRunPersistFailureWarnings(
    context,
    diagnostics,
    reconciliation.staleRecord
  );

  const nextProjection = await applyRecoveryProjectionEvents(
    context,
    projection,
    recoveryEvents.length === 0 && recoveryOptions.snapshotFallback
      ? reconciliation.events
      : recoveryEvents,
    diagnostics,
    recoveryOptions
  );

  if (recoveryEvents.length === 0) {
    return nextProjection;
  }

  diagnostics.push(reconciliation.diagnostic);
  const telemetry = await recordNormalizedTelemetry(
    context.store,
    context.adapter.normalizeTelemetry({
      eventType: "host.run.stale_reconciled",
      taskId: projection.sessionId,
      assignmentId,
      metadata: reconciliation.telemetryMetadata
    })
  );
  diagnostics.push(...warningDiagnostics(telemetry.warning, "telemetry-write-failed"));
  return nextProjection;
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

interface StaleRunRecoveryState {
  assignmentRecovered: boolean;
  statusRecovered: boolean;
}

function getStaleRunRecoveryState(
  projection: RuntimeProjection,
  assignmentId: string,
  record: HostRunRecord
): StaleRunRecoveryState {
  const assignment = projection.assignments.get(assignmentId);
  const runInstanceId = getRunInstanceId(record);

  return {
    assignmentRecovered:
      typeof runInstanceId === "string" &&
      assignment?.state === "queued" &&
      assignment.lastStaleRunInstanceId === runInstanceId,
    statusRecovered:
      typeof runInstanceId === "string" &&
      projection.status.lastStaleRunInstanceId === runInstanceId
  };
}

async function reconcileOutOfProjectionStaleRun(
  context: RunReconciliationContext,
  projection: RuntimeProjection,
  assignmentId: string,
  record: HostRunRecord,
  diagnostics: RunReconciliationDiagnostic[]
): Promise<void> {
  const reconciliation = buildStaleRunReconciliation(projection, assignmentId, record);
  diagnostics.push({
    level: "warning",
    code: "stale-run-reconciled",
    message: `Cleared stale host run artifacts for assignment ${assignmentId} after snapshot fallback could not safely hydrate the assignment into runtime state.`
  });

  const telemetry = await recordNormalizedTelemetry(
    context.store,
    context.adapter.normalizeTelemetry({
      eventType: "host.run.stale_reconciled",
      taskId: projection.sessionId,
      assignmentId,
      metadata: reconciliation.telemetryMetadata
    })
  );
  diagnostics.push(...warningDiagnostics(telemetry.warning, "telemetry-write-failed"));

  const cleanupError = await reconcileStaleRunWithLeaseVerification(
    context.store,
    context.adapter,
    reconciliation.staleRecord
  );
  if (cleanupError) {
    diagnostics.push(
      ...warningDiagnostics(
        `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
        "host-run-persist-failed"
      )
    );
  }
}

function selectPendingStaleRecoveryEvents(
  events: RuntimeEvent[],
  recoveryState: StaleRunRecoveryState
): RuntimeEvent[] {
  const pendingEvents: RuntimeEvent[] = [];
  const [assignmentEvent, statusEvent] = events;

  if (!recoveryState.assignmentRecovered) {
    pendingEvents.push(assignmentEvent!);
  }
  if (!recoveryState.statusRecovered) {
    pendingEvents.push(statusEvent!);
  }

  return pendingEvents;
}

function isStaleRunAlreadyReconciled(
  projection: RuntimeProjection,
  assignmentId: string,
  recoveryState: StaleRunRecoveryState
): boolean {
  return (
    recoveryState.assignmentRecovered &&
    recoveryState.statusRecovered &&
    !getActiveClaimForAssignment(projection, assignmentId) &&
    projection.assignments.get(assignmentId)?.state === "queued"
  );
}

function isDegradedRunRecord(record: HostRunRecord): boolean {
  return (record.state === "completed" && Boolean(record.staleReasonCode) && !record.terminalOutcome) ||
    isRunLeaseExpired(record);
}

function isStaleRunReconciliationCandidate(record: HostRunRecord): boolean {
  return isDegradedRunRecord(record);
}

function listLiveLeaseAssignments(records: HostRunRecord[]): string[] {
  return records
    .filter(isLiveLeaseRecord)
    .map((record) => record.assignmentId);
}

function isLiveLeaseRecord(
  record: HostRunRecord | undefined
): record is HostRunRecord & { state: "running" } {
  return record?.state === "running" && !isRunLeaseExpired(record);
}

async function applyRecoveryProjectionEvents(
  context: RunReconciliationContext,
  projection: RuntimeProjection,
  events: RuntimeEvent[],
  diagnostics: RunReconciliationDiagnostic[],
  options: RecoveryProjectionOptions
): Promise<RuntimeProjection> {
  const persisted = await context.projectionRecovery.applyRecoveryProjectionEvents(
    projection,
    events,
    { snapshotFallback: options.snapshotFallback }
  );
  diagnostics.push(...warningDiagnostics(persisted.warning, "event-log-repaired"));
  return persisted.projection;
}

async function addHostRunPersistFailureWarnings(
  context: RunReconciliationContext,
  diagnostics: RunReconciliationDiagnostic[],
  record: HostRunRecord
): Promise<void> {
  const cleanupError = await reconcileStaleRunWithLeaseVerification(
    context.store,
    context.adapter,
    record
  );
  if (cleanupError) {
    diagnostics.push(
      ...warningDiagnostics(
        `Host run reconciliation artifacts could not be updated for assignment ${record.assignmentId}. ${cleanupError.message}`,
        "host-run-persist-failed"
      )
    );
  }
}

function warningDiagnostics(
  warning: string | undefined,
  code: RunReconciliationDiagnostic["code"]
): RunReconciliationDiagnostic[] {
  return warning
    ? [{
        level: "warning",
        code,
        message: warning
      }]
    : [];
}
