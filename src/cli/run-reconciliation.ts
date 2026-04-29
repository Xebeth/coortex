import type { HostAdapter } from "../adapters/contract.js";
import {
  buildCompletedRunRecord,
  buildCompletedHostExecutionOutcomeFromDecisionCapture,
  buildCompletedHostExecutionOutcomeFromResultCapture
} from "../adapters/host-run-records.js";
import {
  getNativeRunId,
  getRunInstanceId,
  hasMalformedLeaseBlocker,
  isRunLeaseExpired
} from "../core/run-state.js";
import type { RuntimeEvent } from "../core/events.js";
import type { HostRunRecord, RuntimeProjection } from "../core/types.js";
import {
  findLatestAssignmentDecision,
  findLatestTerminalAssignmentResult
} from "../projections/assignment-outcome-queries.js";
import { fromSnapshot, toSnapshot } from "../projections/runtime-projection.js";
import {
  ProjectionRecoveryService,
  type ProjectionPersistenceHandle
} from "../persistence/projection-recovery.js";
import type { RuntimeStore } from "../persistence/store.js";
import { buildStaleRunReconciliation, createActiveRunDiagnostic } from "../recovery/host-runs.js";
import {
  buildCompletedRunReconciliation,
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
  persistence: ProjectionPersistenceHandle;
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

export class RunReconciliationService {
  private readonly projectionRecovery: ProjectionRecoveryService;

  constructor(
    private readonly store: RuntimeStore,
    private readonly adapter: HostAdapter
  ) {
    this.projectionRecovery = new ProjectionRecoveryService(store);
  }

  async reconcileActiveRuns(
    projection: RuntimeProjection
  ): Promise<RunReconciliationResult> {
    return reconcileActiveRunsInContext(
      {
        store: this.store,
        adapter: this.adapter,
        projectionRecovery: this.projectionRecovery
      },
      projection
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
  projection: RuntimeProjection
): Promise<RunReconciliationResult> {
  return new RunReconciliationService(store, adapter).reconcileActiveRuns(projection);
}

export async function loadReconciledProjectionWithDiagnostics(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<{
  projection: RuntimeProjection;
  diagnostics: CommandDiagnostic[];
  activeLeases: string[];
  hiddenActiveLeases: string[];
  persistence: ProjectionPersistenceHandle;
}> {
  const loaded = await loadOperatorProjectionWithDiagnostics(store);
  const reconciled = await reconcileActiveRuns(store, adapter, loaded.projection);
  const hiddenActiveLeases = listHiddenActiveLeaseAssignments(
    reconciled.projection,
    reconciled.activeLeases
  );
  return {
    projection: reconciled.projection,
    diagnostics: [...loaded.diagnostics, ...reconciled.diagnostics],
    activeLeases: reconciled.activeLeases,
    hiddenActiveLeases,
    persistence: reconciled.persistence
  };
}

async function reconcileActiveRunsInContext(
  context: RunReconciliationContext,
  projection: RuntimeProjection
): Promise<RunReconciliationResult> {
  const diagnostics: RunReconciliationDiagnostic[] = [];
  const persistence = await context.projectionRecovery.createProjectionPersistenceHandle();
  let effectiveProjection = fromSnapshot(toSnapshot(projection));
  let changed = false;
  let replayableHydrated = false;
  let handledCompletedRun = false;
  const runtimeKnownAssignmentIds = [...projection.assignments.keys()];
  const enumeratedRecords = await context.adapter.inspectRuns(context.store);
  const enumeratedRecordByAssignmentId = new Map(
    enumeratedRecords.map((record) => [record.assignmentId, record] as const)
  );
  const assignmentIdsToInspect = [
    ...new Set([...runtimeKnownAssignmentIds, ...enumeratedRecordByAssignmentId.keys()])
  ];

  const hydrateReplayableSuffix = () => {
    if (replayableHydrated) {
      return;
    }
    replayableHydrated = true;
    const replayableHydration = persistence.hydrateProjection(effectiveProjection);
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

    if (isStaleRunReconciliationCandidate(record)) {
      hydrateReplayableSuffix();
    }

    if (!effectiveProjection.assignments.has(assignmentId) && isStaleRunReconciliationCandidate(record)) {
      const replayableHydration = persistence.hydrateMissingAssignment(
        effectiveProjection,
        assignmentId
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
          persistence
        }
      );
      effectiveProjection = completedRecovery.projection;
      changed ||= completedRecovery.changed;
      replayableHydrated ||= completedRecovery.replayableHydrated;
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
        persistence
      );
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
          persistence
        }
      );
      if (completedRecovery.handled) {
        handledCompletedRun = true;
        effectiveProjection = completedRecovery.projection;
        changed ||= completedRecovery.changed;
        replayableHydrated ||= completedRecovery.replayableHydrated;
        continue;
      }

      continue;
    }

    if (!effectiveProjection.assignments.has(assignmentId)) {
      if (!isLiveLeaseRecord(record) && isStaleRunReconciliationCandidate(record)) {
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
      persistence
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
        persistence
      }
    );
    effectiveProjection = completedRecovery.projection;
    changed ||= completedRecovery.changed;
    replayableHydrated ||= completedRecovery.replayableHydrated;
  }

  const reconciledRecordsBeforeProvisional = await context.adapter.inspectRuns(context.store);
  const provisionalReconciliation = await reconcileProvisionalAttachmentClaims(
    context,
    effectiveProjection,
    diagnostics,
    new Map(reconciledRecordsBeforeProvisional.map((record) => [record.assignmentId, record] as const)),
    persistence
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
    activeLeases: finalActiveLeases,
    persistence
  };
}

async function reconcileProvisionalAttachmentClaims(
  context: RunReconciliationContext,
  projection: RuntimeProjection,
  diagnostics: RunReconciliationDiagnostic[],
  recordByAssignmentId: Map<string, HostRunRecord>,
  persistence: ProjectionPersistenceHandle
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
        effectiveProjection,
        attachment.id,
        claim.id,
        liveNativeSessionId,
        record?.adapterData,
        persistence
      );
      diagnostics.push({
        level: "warning",
        code: "provisional-attachment-promoted",
        message: `Promoted provisional attachment ${attachment.id} for assignment ${claim.assignmentId} into resumable attachment truth.`
      });
      changed = true;
      continue;
    }
    if (hasLiveLease) {
      // The launch window between lease claim and durable native identity is still live
      // execution authority. Leave the provisional claim and lease intact so duplicate
      // commands fail closed instead of clearing and reissuing the assignment.
      continue;
    }

    const startedHostRun = !!record;
    const shouldRequeue = assignment?.state === "in_progress";
    const cleanupReason = "Wrapped launch ended before native session identity could be finalized.";
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
          provenanceKind: "recovery",
          ...(record ? { inspectedRecord: record } : {}),
          ...(shouldRequeue && assignment ? { requeueObjective: assignment.objective } : {})
        },
        persistence
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
          provenanceKind: "recovery",
          ...(record ? { inspectedRecord: record } : {})
        },
        persistence
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
    persistence: ProjectionPersistenceHandle;
  }
): Promise<CompletedRunReconciliationResult> {
  let effectiveProjection = projection;
  let changed = false;
  const replayableHydration = options.persistence.hydrateProjection(effectiveProjection);
  if (replayableHydration.hydrated) {
    effectiveProjection = replayableHydration.projection;
    changed = true;
  }
  if (!effectiveProjection.assignments.has(record.assignmentId)) {
    const missingAssignmentHydration = options.persistence.hydrateMissingAssignment(
      effectiveProjection,
      record.assignmentId
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

  const completedRecoveryProofEvents = await options.persistence.loadCompletedRecoveryProofEvents();
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
    const persisted = await options.persistence.persistEvents(completedEvents);
    effectiveProjection = persisted.projection;
    diagnostics.push(...warningDiagnostics(persisted.warning, "event-log-repaired"));
    diagnostics.push(completedRecovery.diagnostic);
  } else {
    changed = true;
    const persisted = await options.persistence.persistEvents([]);
    effectiveProjection = persisted.projection;
    diagnostics.push(...warningDiagnostics(persisted.warning, "event-log-repaired"));
    if (options.persistence.reportsCompletedRecoveryWithoutEvents()) {
      diagnostics.push(completedRecovery.diagnostic);
    }
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
  persistence: ProjectionPersistenceHandle,
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
    const cleanupSource = options?.alreadyReconciledCleanupRecord ?? record;
    const cleanupNeeded =
      cleanupSource.state === "running" ||
      await context.adapter.hasRunLease(context.store, assignmentId);
    const syncedProjection = await persistence.syncProjection();
    diagnostics.push(...warningDiagnostics(syncedProjection.warning, "event-log-repaired"));
    await addHostRunPersistFailureWarnings(
      context,
      diagnostics,
      options?.alreadyReconciledCleanupRecord ?? reconciliation.staleRecord
    );
    if (cleanupNeeded && persistence.shouldEmitAlreadyReconciledStaleRunSuccess(cleanupSource)) {
      await emitStaleRunReconciled(
        context,
        projection.sessionId,
        assignmentId,
        reconciliation.diagnostic,
        reconciliation.telemetryMetadata,
        diagnostics
      );
    }
    return syncedProjection.projection;
  }

  const pendingEvents = selectPendingStaleRecoveryEvents(reconciliation.events, staleRecoveryState);
  const authorityRepairEvents = AttachmentLifecycleService.buildStaleAuthorityRepairEvents(
    projection,
    assignmentId,
    reconciliation.events[0]?.timestamp ?? nowIso()
  );
  const recoveryEvents = [...pendingEvents, ...authorityRepairEvents];

  const persisted = await persistence.persistEvents(recoveryEvents);
  diagnostics.push(...warningDiagnostics(persisted.warning, "event-log-repaired"));
  const nextProjection = persisted.projection;

  await addHostRunPersistFailureWarnings(
    context,
    diagnostics,
    reconciliation.staleRecord
  );

  if (recoveryEvents.length === 0) {
    return nextProjection;
  }

  await emitStaleRunReconciled(
    context,
    projection.sessionId,
    assignmentId,
    reconciliation.diagnostic,
    reconciliation.telemetryMetadata,
    diagnostics
  );
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
  degradedRecoveryPersisted: boolean;
}

function getStaleRunRecoveryState(
  projection: RuntimeProjection,
  assignmentId: string,
  record: HostRunRecord
): StaleRunRecoveryState {
  const assignment = projection.assignments.get(assignmentId);
  const runInstanceId = getRunInstanceId(record);
  const persistedStaleRunInstanceId =
    assignment?.state === "queued" &&
    typeof assignment.lastStaleRunInstanceId === "string" &&
    assignment.lastStaleRunInstanceId.length > 0 &&
    assignment.lastStaleRunInstanceId === projection.status.lastStaleRunInstanceId
      ? assignment.lastStaleRunInstanceId
      : undefined;

  return {
    assignmentRecovered:
      typeof runInstanceId === "string" &&
      assignment?.state === "queued" &&
      assignment.lastStaleRunInstanceId === runInstanceId,
    statusRecovered:
      typeof runInstanceId === "string" &&
      projection.status.lastStaleRunInstanceId === runInstanceId,
    degradedRecoveryPersisted:
      typeof runInstanceId !== "string" && typeof persistedStaleRunInstanceId === "string"
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
  const cleanupError = await reconcileStaleRunWithLeaseVerification(
    context.store,
    context.adapter,
    reconciliation.staleRecord
  );
  await emitStaleRunReconciled(
    context,
    projection.sessionId,
    assignmentId,
    {
      level: "warning",
      code: "stale-run-reconciled",
      message: `Cleared stale host run artifacts for assignment ${assignmentId} after snapshot fallback could not safely hydrate the assignment into runtime state.`
    },
    reconciliation.telemetryMetadata,
    diagnostics
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

async function emitStaleRunReconciled(
  context: RunReconciliationContext,
  sessionId: string,
  assignmentId: string,
  diagnostic: RunReconciliationDiagnostic,
  metadata: ReturnType<typeof buildStaleRunReconciliation>["telemetryMetadata"],
  diagnostics: RunReconciliationDiagnostic[]
): Promise<void> {
  diagnostics.push(diagnostic);
  const telemetry = await recordNormalizedTelemetry(
    context.store,
    context.adapter.normalizeTelemetry({
      eventType: "host.run.stale_reconciled",
      taskId: sessionId,
      assignmentId,
      metadata
    })
  );
  diagnostics.push(...warningDiagnostics(telemetry.warning, "telemetry-write-failed"));
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

function buildCompletedRunRecordFromRuntimeOutcome(
  projection: RuntimeProjection,
  record: HostRunRecord
): HostRunRecord | undefined {
  const assignmentId = record.assignmentId;
  const startedAt = record.startedAt;
  const decision = findLatestAssignmentDecision(projection, assignmentId, {
    createdAtOnOrAfter: startedAt
  });
  const result = findLatestTerminalAssignmentResult(projection, assignmentId, {
    createdAtOnOrAfter: startedAt
  });

  if (!decision && !result) {
    return undefined;
  }

  if (result && (!decision || result.createdAt >= decision.createdAt)) {
    const execution = buildCompletedHostExecutionOutcomeFromResultCapture(result);
    return buildCompletedRunRecord(execution, assignmentId, startedAt, result.createdAt);
  }

  const execution = buildCompletedHostExecutionOutcomeFromDecisionCapture(decision!);
  return buildCompletedRunRecord(execution, assignmentId, startedAt, decision!.createdAt);
}

function isStaleRunAlreadyReconciled(
  projection: RuntimeProjection,
  assignmentId: string,
  recoveryState: StaleRunRecoveryState
): boolean {
  return (
    (recoveryState.degradedRecoveryPersisted || (
      recoveryState.assignmentRecovered && recoveryState.statusRecovered
    )) &&
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

function isLiveLeaseRecord(
  record: HostRunRecord | undefined
): record is HostRunRecord & { state: "running" } {
  return record?.state === "running" && !hasMalformedLeaseBlocker(record) && !isRunLeaseExpired(record);
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
