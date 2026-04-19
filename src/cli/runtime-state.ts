import { randomUUID } from "node:crypto";

import type { HostAdapter } from "../adapters/contract.js";
import { buildRecoveredOutcomeEvent } from "../adapters/host-run-records.js";
import { isRunLeaseExpired } from "../core/run-state.js";
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
  deriveWorkflowRunTruth
} from "../recovery/host-runs.js";
import { nowIso } from "../utils/time.js";
import {
  deriveWorkflowStatus,
  evaluateWorkflowProgression
} from "../workflows/index.js";
import { RuntimeStore } from "../persistence/store.js";

import type { CommandDiagnostic } from "./types.js";
import {
  diagnosticsFromWarning,
  hostRunPersistDiagnostics,
  recordTelemetryWarningDiagnostics,
  syncProjectionWithDiagnostics
} from "./diagnostics.js";

type WorkflowHiddenCleanup = ReturnType<typeof buildWorkflowHiddenRunCleanup>;
type WorkflowStaleRecovery = ReturnType<typeof buildWorkflowStaleRunRecovery>;

interface WorkflowCleanupResult {
  diagnostics: CommandDiagnostic[];
  clearedLease: boolean;
}

interface WorkflowArtifactCleanupState {
  cleanupError?: Error;
  clearedLease: boolean;
}

type WorkflowRunReconciliationAction =
  | {
      kind: "report_active_lease";
      record: HostRunRecord;
    }
  | {
      kind: "recover_completed";
      record: HostRunRecord;
    }
  | {
      kind: "cleanup_run_artifacts";
      record: HostRunRecord;
      cleanupRecord: HostRunRecord;
    }
  | {
      kind: "defer_hidden_cleanup";
      cleanup: WorkflowHiddenCleanup;
    };

interface WorkflowRunReconciliationPlan {
  record: HostRunRecord;
  truth: ReturnType<typeof deriveWorkflowRunTruth>;
  actions: WorkflowRunReconciliationAction[];
  staleRecovery?: WorkflowStaleRecovery;
}

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
  const diagnostics = [...loaded.diagnostics];
  const activeLeases: string[] = [];
  const hiddenActiveLeases: string[] = [];
  const pendingHiddenCleanups: WorkflowHiddenCleanup[] = [];
  let recoveredRunRecord: HostRunRecord | undefined;
  const inspectedRuns = await adapter.inspectRuns(store);
  const recordHasLease = new Map<string, boolean>();
  await Promise.all(
    inspectedRuns.map(async (record) => {
      await cacheRunLeasePresence(store, adapter, recordHasLease, record.assignmentId);
    })
  );
  const inspectedWorkflowRuns = dedupeRunRecords(
    inspectedRuns
  );
  const inspectedWorkflowRunsByAssignmentId = new Map(
    inspectedWorkflowRuns.map((record) => [record.assignmentId, record] as const)
  );

  const initialConvergence = await convergeWorkflowProjection(
    store,
    projection,
    loaded.snapshotFallback
  );
  projection = initialConvergence.projection;
  diagnostics.push(...initialConvergence.diagnostics);

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

  for (const record of inspectedWorkflowRunsByAssignmentId.values()) {
    if (record.assignmentId === projection.workflowProgress?.currentAssignmentId) {
      continue;
    }
    const plan = buildWorkflowRunReconciliationPlan(
      projection,
      record,
      recordHasLease.get(record.assignmentId) ?? false
    );
    const executed = await reconcileWorkflowRunPlan(
      store,
      adapter,
      projection,
      loaded.snapshotFallback,
      plan,
      recordHasLease
    );
    projection = executed.projection;
    diagnostics.push(...executed.diagnostics);
    pendingHiddenCleanups.push(...executed.confirmedHiddenCleanups);
  }

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

  if (!projection.workflowProgress && loaded.projection.workflowProgress) {
    projection = {
      ...projection,
      workflowProgress: JSON.parse(JSON.stringify(loaded.projection.workflowProgress))
    };
  }

  return {
    projection,
    diagnostics,
    snapshotFallback: loaded.snapshotFallback,
    activeLeases,
    hiddenActiveLeases,
    ...(recoveredRunRecord ? { recoveredRunRecord } : {})
  };
}

export async function loadWorkflowAwareProjection(
  store: RuntimeStore,
  adapter: HostAdapter
) {
  return (await loadWorkflowAwareProjectionWithDiagnostics(store, adapter)).projection;
}

function buildWorkflowRunReconciliationPlan(
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>,
  record: HostRunRecord,
  hasLeaseArtifact: boolean
): WorkflowRunReconciliationPlan {
  const truth = deriveWorkflowRunTruth(projection, record, { hasLeaseArtifact });
  const handling = deriveWorkflowRunHandling(record, truth);
  const actions: WorkflowRunReconciliationAction[] = [];
  const hiddenCleanup = handling.kind === "emit_hidden_cleanup"
    ? buildWorkflowHiddenRunCleanup(record)
    : undefined;
  const staleRecovery = truth.staleCandidate &&
    !truth.hasDurableCurrentOutcome &&
    !truth.hasDurableStaleRecovery
    ? buildWorkflowStaleRunRecovery(record)
    : undefined;

  if (handling.kind === "active_lease") {
    actions.push({ kind: "report_active_lease", record });
  }
  if (handling.kind === "recover_completed") {
    actions.push({ kind: "recover_completed", record });
  }
  if (hiddenCleanup) {
    actions.push({
      kind: "defer_hidden_cleanup",
      cleanup: hiddenCleanup
    });
  }
  if (handling.kind === "recover_completed" ||
      handling.kind === "emit_hidden_cleanup" ||
      handling.kind === "cleanup_only") {
    actions.push({
      kind: "cleanup_run_artifacts",
      record,
      cleanupRecord:
        hiddenCleanup?.staleRecord ??
        handling.cleanupRecord ??
        deriveWorkflowCleanupRecord(record)
    });
  }

  return {
    record,
    truth,
    actions,
    ...(staleRecovery ? { staleRecovery } : {})
  };
}

function isWorkflowStaleCleanupRecord(record: HostRunRecord): boolean {
  return (
    (record.state === "running" &&
      record.staleReasonCode !== "malformed_lease_artifact" &&
      isRunLeaseExpired(record)) ||
    (record.state === "completed" && Boolean(record.staleReasonCode) && !record.terminalOutcome)
  );
}

function shouldEmitCurrentWorkflowStaleSuccess(
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>,
  before: ReturnType<typeof deriveWorkflowRunTruth>,
  record: HostRunRecord,
  assignmentId: string,
  cleanupResult: WorkflowCleanupResult | undefined,
  recoveredStaleRunInThisPlan: boolean
): boolean {
  const currentAssignmentQueued =
    projection.workflowProgress?.currentAssignmentId === assignmentId &&
    projection.assignments.get(assignmentId)?.state === "queued";
  if (!currentAssignmentQueued) {
    return false;
  }
  if (recoveredStaleRunInThisPlan) {
    return before.hasLeaseArtifact ? Boolean(cleanupResult?.clearedLease) : true;
  }
  return before.hasLeaseArtifact &&
    Boolean(cleanupResult?.clearedLease) &&
    isWorkflowStaleCleanupRecord(record);
}

async function emitWorkflowStaleReconciliation(
  store: RuntimeStore,
  adapter: HostAdapter,
  sessionId: string,
  recovery: ReturnType<typeof buildWorkflowStaleRunRecovery>
): Promise<CommandDiagnostic[]> {
  return emitWorkflowRunTelemetryDiagnostic(
    store,
    adapter,
    sessionId,
    "host.run.stale_reconciled",
    recovery.staleRecord.assignmentId,
    recovery.diagnostic,
    recovery.telemetryMetadata
  );
}

async function emitWorkflowHiddenRunCleanup(
  store: RuntimeStore,
  adapter: HostAdapter,
  sessionId: string,
  cleanup: ReturnType<typeof buildWorkflowHiddenRunCleanup>
): Promise<CommandDiagnostic[]> {
  return emitWorkflowRunTelemetryDiagnostic(
    store,
    adapter,
    sessionId,
    "host.run.hidden_stale_cleaned",
    cleanup.staleRecord.assignmentId,
    cleanup.diagnostic,
    cleanup.telemetryMetadata
  );
}

async function emitWorkflowRunTelemetryDiagnostic(
  store: RuntimeStore,
  adapter: HostAdapter,
  sessionId: string,
  eventType: "host.run.stale_reconciled" | "host.run.hidden_stale_cleaned",
  assignmentId: string,
  diagnostic: CommandDiagnostic,
  metadata: {
    nativeRunId: string;
    leaseExpiresAt: string;
    heartbeatAt: string;
    staleAt: string;
  }
): Promise<CommandDiagnostic[]> {
  const diagnostics: CommandDiagnostic[] = [diagnostic];
  diagnostics.push(...await recordTelemetryWarningDiagnostics(store, adapter, {
    eventType,
    taskId: sessionId,
    assignmentId,
    metadata
  }));
  return diagnostics;
}

async function cleanupRunArtifactsWithDiagnostics(
  store: RuntimeStore,
  adapter: HostAdapter,
  record: HostRunRecord
): Promise<WorkflowCleanupResult> {
  const cleanupResult = await cleanupRunArtifacts(store, adapter, record);
  return {
    diagnostics: cleanupResult.cleanupError
      ? hostRunPersistDiagnostics(record.assignmentId, cleanupResult.cleanupError)
      : [],
    clearedLease: cleanupResult.clearedLease
  };
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
  const recordHasLease = new Map<string, boolean>();
  for (const record of records) {
    const truth = deriveWorkflowRunTruth(projection, record, {
      hasLeaseArtifact: await cacheRunLeasePresence(
        store,
        adapter,
        recordHasLease,
        record.assignmentId
      )
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

async function reconcileWorkflowRunPlan(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>,
  snapshotFallback: boolean,
  plan: WorkflowRunReconciliationPlan,
  recordHasLease: Map<string, boolean>
): Promise<{
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>;
  diagnostics: CommandDiagnostic[];
  confirmedHiddenCleanups: WorkflowHiddenCleanup[];
  cleanupResults: Map<string, WorkflowCleanupResult>;
  recoveredRunRecord?: HostRunRecord;
  changed: boolean;
}> {
  const executed = await executeWorkflowRunPlanActions(
    store,
    adapter,
    projection,
    snapshotFallback,
    plan,
    recordHasLease
  );
  let effectiveProjection = executed.projection;
  const diagnostics = [...executed.diagnostics];
  let changed = executed.changed;

  if (executed.changed || plan.staleRecovery) {
    const converged = await convergeWorkflowProjection(
      store,
      effectiveProjection,
      snapshotFallback,
      plan.staleRecovery
    );
    effectiveProjection = converged.projection;
    diagnostics.push(...converged.diagnostics);
    changed = changed || converged.changed;
  }

  let cleanupResult = executed.cleanupResults.get(plan.record.assignmentId);
  if (!cleanupResult && plan.staleRecovery) {
    cleanupResult = await cleanupRunArtifactsWithDiagnostics(
      store,
      adapter,
      plan.staleRecovery.staleRecord
    );
    diagnostics.push(...cleanupResult.diagnostics);
    recordHasLease.set(plan.record.assignmentId, !cleanupResult.clearedLease);
  }

  if (shouldEmitCurrentWorkflowStaleSuccess(
    effectiveProjection,
    plan.truth,
    plan.record,
    plan.record.assignmentId,
    cleanupResult,
    Boolean(plan.staleRecovery)
  )) {
    diagnostics.push(
      ...await emitWorkflowStaleReconciliation(
        store,
        adapter,
        effectiveProjection.sessionId,
        plan.staleRecovery ?? buildWorkflowStaleRunRecovery(plan.record)
      )
    );
  }

  return {
    projection: effectiveProjection,
    diagnostics,
    confirmedHiddenCleanups: executed.confirmedHiddenCleanups,
    cleanupResults: executed.cleanupResults,
    ...(executed.recoveredRunRecord ? { recoveredRunRecord: executed.recoveredRunRecord } : {}),
    changed
  };
}

async function executeWorkflowRunPlanActions(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>,
  snapshotFallback: boolean,
  plan: WorkflowRunReconciliationPlan,
  recordHasLease: Map<string, boolean>
): Promise<{
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>;
  diagnostics: CommandDiagnostic[];
  confirmedHiddenCleanups: WorkflowHiddenCleanup[];
  cleanupResults: Map<string, WorkflowCleanupResult>;
  recoveredRunRecord?: HostRunRecord;
  changed: boolean;
}> {
  const diagnostics: CommandDiagnostic[] = [];
  const confirmedHiddenCleanups: WorkflowHiddenCleanup[] = [];
  const cleanupResults = new Map<string, WorkflowCleanupResult>();
  let effectiveProjection = projection;
  let recoveredRunRecord: HostRunRecord | undefined;
  let changed = false;
  let pendingHiddenCleanup: WorkflowHiddenCleanup | undefined;

  for (const action of plan.actions) {
    switch (action.kind) {
      case "report_active_lease":
        diagnostics.push(createActiveRunDiagnostic(action.record.assignmentId, action.record));
        break;
      case "recover_completed": {
        const recoveredEvents = buildWorkflowRecoveredOutcomeEvents(
          effectiveProjection.sessionId,
          action.record
        );
        if (recoveredEvents.length === 0) {
          break;
        }
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
          message: `Recovered completed host outcome for assignment ${action.record.assignmentId} after runtime event persistence was interrupted.`
        });
        recoveredRunRecord = action.record;
        changed = true;
        break;
      }
      case "cleanup_run_artifacts": {
        const cleanupResult = await cleanupRunArtifactsWithDiagnostics(
          store,
          adapter,
          action.cleanupRecord
        );
        diagnostics.push(...cleanupResult.diagnostics);
        cleanupResults.set(action.record.assignmentId, cleanupResult);
        recordHasLease.set(action.record.assignmentId, !cleanupResult.clearedLease);
        if (cleanupResult.clearedLease && pendingHiddenCleanup) {
          confirmedHiddenCleanups.push(pendingHiddenCleanup);
          pendingHiddenCleanup = undefined;
        }
        break;
      }
      case "defer_hidden_cleanup":
        pendingHiddenCleanup = action.cleanup;
        break;
    }
  }

  return {
    projection: effectiveProjection,
    diagnostics,
    confirmedHiddenCleanups,
    cleanupResults,
    ...(recoveredRunRecord ? { recoveredRunRecord } : {}),
    changed
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

  for (let iteration = 0; iteration < 10; iteration += 1) {
    const currentAssignmentId = effectiveProjection.workflowProgress?.currentAssignmentId;
    if (!currentAssignmentId) {
      break;
    }
    const currentRecord = await resolveWorkflowRunRecord(
      store,
      adapter,
      currentAssignmentId,
      inspectedRunsByAssignmentId,
      recordHasLease
    );
    if (!currentRecord) {
      const converged = await convergeWorkflowProjection(
        store,
        effectiveProjection,
        snapshotFallback
      );
      effectiveProjection = converged.projection;
      diagnostics.push(...converged.diagnostics);
      if (!converged.changed) {
        break;
      }
      continue;
    }

    const plan = buildWorkflowRunReconciliationPlan(
      effectiveProjection,
      currentRecord,
      recordHasLease.get(currentAssignmentId) ?? false
    );
    const executed = await reconcileWorkflowRunPlan(
      store,
      adapter,
      effectiveProjection,
      snapshotFallback,
      plan,
      recordHasLease
    );
    effectiveProjection = executed.projection;
    diagnostics.push(...executed.diagnostics);
    recoveredRunRecord = executed.recoveredRunRecord ?? recoveredRunRecord;

    if (!executed.changed) {
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
  if (record) {
    await cacheRunLeasePresence(store, adapter, recordHasLease, assignmentId);
  }
  return record;
}

async function cacheRunLeasePresence(
  store: RuntimeStore,
  adapter: HostAdapter,
  recordHasLease: Map<string, boolean>,
  assignmentId: string
): Promise<boolean> {
  const cached = recordHasLease.get(assignmentId);
  if (cached !== undefined) {
    return cached;
  }
  const hasLease = await adapter.hasRunLease(store, assignmentId);
  recordHasLease.set(assignmentId, hasLease);
  return hasLease;
}

async function convergeWorkflowProjection(
  store: RuntimeStore,
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>,
  snapshotFallback: boolean,
  staleRecovery?: ReturnType<typeof buildWorkflowStaleRunRecovery>
): Promise<{
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>;
  diagnostics: CommandDiagnostic[];
  changed: boolean;
}> {
  let effectiveProjection = projection;
  const diagnostics: CommandDiagnostic[] = [];
  let changed = false;
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
      changed = true;
      continue;
    }
    const syncedStatus = await syncWorkflowStatus(store, effectiveProjection, snapshotFallback);
    if (syncedStatus.changed) {
      effectiveProjection = syncedStatus.projection;
      diagnostics.push(...syncedStatus.diagnostics);
      changed = true;
      continue;
    }
    break;
  }
  return {
    projection: effectiveProjection,
    diagnostics,
    changed
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
  return syncProjectionWithDiagnostics(store);
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
  const event = buildRecoveredOutcomeEvent(sessionId, nowIso(), record);
  return event ? [event] : [];
}

async function cleanupRunArtifacts(
  store: RuntimeStore,
  adapter: HostAdapter,
  record: HostRunRecord
): Promise<WorkflowArtifactCleanupState> {
  let cleanupError: Error | undefined;
  try {
    await adapter.reconcileStaleRun(store, record);
  } catch (error) {
    cleanupError = error instanceof Error ? error : new Error(String(error));
  }

  const clearedLease = !(await adapter.hasRunLease(store, record.assignmentId));
  if (!clearedLease) {
    return {
      clearedLease,
      cleanupError: new Error(
      `Host run reconciliation failed to clear the active lease for assignment ${record.assignmentId}. ${
        cleanupError?.message ?? "The lease artifact remained on disk."
      }`
      )
    };
  }

  return {
    clearedLease,
    ...(cleanupError ? { cleanupError } : {})
  };
}
