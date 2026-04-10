import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeConfig } from "../config/types.js";
import type { HostAdapter, HostRunRecord } from "../adapters/contract.js";
import type { RuntimeEvent } from "../core/events.js";
import { createBootstrapRuntime } from "../core/runtime.js";
import { buildRecoveryBrief } from "../recovery/brief.js";
import { RuntimeStore } from "../persistence/store.js";
import { toSnapshot } from "../projections/runtime-projection.js";
import { recordNormalizedTelemetry } from "../telemetry/recorder.js";
import { nowIso } from "../utils/time.js";

export interface CommandDiagnostic {
  level: "warning";
  code:
    | "event-log-salvaged"
    | "event-log-repaired"
    | "telemetry-write-failed"
    | "host-run-persist-failed"
    | "active-run-present"
    | "stale-run-reconciled";
  message: string;
}

export interface InitRuntimeResult {
  sessionId: string;
  adapterId: string;
  rootDir: string;
  diagnostics: CommandDiagnostic[];
}

export interface ResumeRuntimeResult {
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  brief: ReturnType<typeof buildRecoveryBrief>;
  envelope: Awaited<ReturnType<HostAdapter["buildResumeEnvelope"]>>;
  envelopePath: string;
  diagnostics: CommandDiagnostic[];
}

export interface RunRuntimeResult {
  projectionBefore: Awaited<ReturnType<typeof loadOperatorProjection>>;
  projectionAfter: Awaited<ReturnType<typeof loadOperatorProjection>>;
  assignment: ReturnType<typeof getRunnableAssignment>;
  envelope: Awaited<ReturnType<HostAdapter["buildResumeEnvelope"]>>;
  execution: Awaited<ReturnType<HostAdapter["executeAssignment"]>>;
  diagnostics: CommandDiagnostic[];
}

export async function initRuntime(
  projectRoot: string,
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<InitRuntimeResult | undefined> {
  const existing = await store.loadConfig();
  if (existing) {
    return undefined;
  }

  const createdAt = nowIso();
  const sessionId = randomUUID();

  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: adapter.id,
    host: adapter.host,
    rootPath: projectRoot,
    createdAt
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: adapter.id,
    host: adapter.host,
    workflow: "milestone-2"
  });

  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const syncResult = await store.syncSnapshotFromEventsWithRecovery();
  const diagnostics = diagnosticsFromWarning(syncResult.warning, "event-log-repaired");
  const projection = syncResult.projection;
  await adapter.initialize(store, projection);
  const telemetry = await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry({
      eventType: "runtime.initialized",
      taskId: sessionId,
      assignmentId: bootstrap.initialAssignmentId,
      metadata: {
        projectRoot,
        repoName: basename(projectRoot)
      }
    })
  );
  diagnostics.push(...diagnosticsFromWarning(telemetry.warning, "telemetry-write-failed"));

  return {
    sessionId,
    adapterId: adapter.id,
    rootDir: store.rootDir,
    diagnostics
  };
}

export async function resumeRuntime(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<ResumeRuntimeResult> {
  const config = await store.loadConfig();
  if (!config) {
    throw new Error("Coortex is not initialized. Run `ctx init` first.");
  }

  const { projection, diagnostics } = await loadOperatorProjectionWithDiagnostics(store);
  const reconciled = await reconcileActiveRuns(store, adapter, projection);
  diagnostics.push(...reconciled.diagnostics);
  const effectiveProjection = reconciled.projection;
  const brief = buildRecoveryBrief(effectiveProjection);
  if (brief.activeAssignments.length === 0) {
    throw new Error("No active assignment is available to resume.");
  }
  const envelope = await adapter.buildResumeEnvelope(store, effectiveProjection, brief);
  const envelopePath = join(store.runtimeDir, "last-resume-envelope.json");
  await store.writeSnapshot(toSnapshot(effectiveProjection));
  await store.writeJsonArtifact("runtime/last-resume-envelope.json", envelope);
  const telemetry = await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry({
      eventType: "resume.requested",
      taskId: projection.sessionId,
      metadata: {
        envelopeChars: envelope.estimatedChars,
        trimApplied: envelope.trimApplied,
        trimmedFields: envelope.trimmedFields.length
      }
    })
  );
  diagnostics.push(...diagnosticsFromWarning(telemetry.warning, "telemetry-write-failed"));

  return {
    projection: effectiveProjection,
    brief,
    envelope,
    envelopePath: resolve(envelopePath),
    diagnostics
  };
}

export async function runRuntime(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<RunRuntimeResult> {
  const config = await store.loadConfig();
  if (!config) {
    throw new Error("Coortex is not initialized. Run `ctx init` first.");
  }

  const projectionBeforeResult = await loadOperatorProjectionWithDiagnostics(store);
  const reconciled = await reconcileActiveRuns(store, adapter, projectionBeforeResult.projection);
  const projectionBefore = reconciled.projection;
  if (reconciled.activeLeases.length > 0) {
    const assignmentId = reconciled.activeLeases[0]!;
    throw new Error(`Assignment ${assignmentId} already has an active host run lease.`);
  }
  const assignment = getRunnableAssignment(projectionBefore);
  const claimedRun = adapter.claimRunLease
    ? await adapter.claimRunLease(store, projectionBefore, assignment.id)
    : undefined;
  let executionStarted = false;
  try {
    const envelopeProjection = projectionForRunnableAssignment(projectionBefore, assignment.id);
    const brief = buildRecoveryBrief(envelopeProjection);
    const envelope = await adapter.buildResumeEnvelope(store, envelopeProjection, brief);
    const launchedProjection = await markAssignmentInProgress(store, projectionBefore, assignment.id);

    const startedTelemetry = await recordNormalizedTelemetry(
      store,
      adapter.normalizeTelemetry({
        eventType: "host.run.started",
        taskId: launchedProjection.sessionId,
        assignmentId: assignment.id,
        metadata: {
          envelopeChars: envelope.estimatedChars,
          trimApplied: envelope.trimApplied,
          trimmedFields: envelope.trimmedFields.length
        }
      })
    );
    const diagnostics = [
      ...projectionBeforeResult.diagnostics,
      ...reconciled.diagnostics,
      ...diagnosticsFromWarning(startedTelemetry.warning, "telemetry-write-failed")
    ];

    executionStarted = true;
    const execution = await adapter.executeAssignment(store, launchedProjection, envelope, claimedRun);
    diagnostics.push(...diagnosticsFromWarning(execution.warning, "host-run-persist-failed"));
    const events = buildOutcomeEvents(launchedProjection, execution, adapter);
    for (const event of events) {
      await store.appendEvent(event);
    }
    const projectionAfterResult = await store.syncSnapshotFromEventsWithRecovery();
    const projectionAfter = projectionAfterResult.projection;
    diagnostics.push(...diagnosticsFromWarning(projectionAfterResult.warning, "event-log-repaired"));

    if (execution.telemetry) {
      const completedTelemetry = await recordNormalizedTelemetry(
        store,
        adapter.normalizeTelemetry(execution.telemetry)
      );
      diagnostics.push(
        ...diagnosticsFromWarning(completedTelemetry.warning, "telemetry-write-failed")
      );
    }

    return {
      projectionBefore: launchedProjection,
      projectionAfter,
      assignment,
      envelope,
      execution,
      diagnostics
    };
  } catch (error) {
    if (!executionStarted) {
      await adapter.releaseRunLease?.(store, assignment.id);
    }
    throw error;
  }
}

async function markAssignmentInProgress(
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

export async function inspectRuntimeRun(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId?: string
) {
  const config = await store.loadConfig();
  if (!config) {
    throw new Error("Coortex is not initialized. Run `ctx init` first.");
  }
  return adapter.inspectRun(store, assignmentId);
}

export async function loadOperatorProjection(store: RuntimeStore) {
  return (await loadOperatorProjectionWithDiagnostics(store)).projection;
}

export async function loadOperatorProjectionWithDiagnostics(store: RuntimeStore): Promise<{
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>;
  diagnostics: CommandDiagnostic[];
}> {
  if (await store.hasEvents()) {
    const { projection, warning } = await store.loadProjectionWithRecovery();
    return {
      projection,
      diagnostics: diagnosticsFromWarning(warning, "event-log-salvaged")
    };
  }
  const { projection, warning } = await store.loadProjectionWithRecovery();
  return {
    projection,
    diagnostics: diagnosticsFromWarning(warning, "event-log-salvaged")
  };
}

export function buildOutcomeEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  execution: Awaited<ReturnType<HostAdapter["executeAssignment"]>>,
  adapter: HostAdapter
): RuntimeEvent[] {
  const timestamp = nowIso();
  const assignmentId = execution.run.assignmentId;
  const status = nextRuntimeStatus(projection, execution);
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

function projectionForRunnableAssignment(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string
) {
  return {
    ...projection,
    status: {
      ...projection.status,
      currentObjective:
        projection.assignments.get(assignmentId)?.objective ?? projection.status.currentObjective,
      activeAssignmentIds: [assignmentId]
    },
    decisions: new Map(
      [...projection.decisions.entries()].filter(([, decision]) => decision.assignmentId === assignmentId)
    )
  };
}

async function reconcileActiveRuns(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>
): Promise<{
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  diagnostics: CommandDiagnostic[];
  activeLeases: string[];
}> {
  const diagnostics: CommandDiagnostic[] = [];
  let effectiveProjection = projection;
  let changed = false;
  const activeLeases: string[] = [];

  for (const assignmentId of projection.status.activeAssignmentIds) {
    const record = await adapter.inspectRun(store, assignmentId);
    if (!record || record.state !== "running") {
      continue;
    }

    if (!isRunLeaseExpired(record)) {
      activeLeases.push(assignmentId);
      diagnostics.push({
        level: "warning",
        code: "active-run-present",
        message: `Assignment ${assignmentId} still has an active host run lease${
          record.hostRunId ? ` (${record.hostRunId})` : ""
        }.`
      });
      continue;
    }

    changed = true;
    const timestamp = nowIso();
    await store.writeJsonArtifact(`adapters/${adapter.id}/runs/${assignmentId}.json`, {
      ...record,
      state: "completed",
      staleAt: timestamp,
      staleReason: staleReason(record)
    });
    await store.writeJsonArtifact(`adapters/${adapter.id}/last-run.json`, {
      ...record,
      state: "completed",
      staleAt: timestamp,
      staleReason: staleReason(record)
    });
    await store.deleteArtifact(`adapters/${adapter.id}/runs/${assignmentId}.lease.json`);

    const assignment = effectiveProjection.assignments.get(assignmentId);
    const objective = assignment?.objective ?? effectiveProjection.status.currentObjective;
    const events: RuntimeEvent[] = [
      {
        eventId: randomUUID(),
        sessionId: effectiveProjection.sessionId,
        timestamp,
        type: "assignment.updated",
        payload: {
          assignmentId,
          patch: {
            state: "queued",
            updatedAt: timestamp
          }
        }
      },
      {
        eventId: randomUUID(),
        sessionId: effectiveProjection.sessionId,
        timestamp,
        type: "status.updated",
        payload: {
          status: {
            ...effectiveProjection.status,
            currentObjective: `Retry assignment ${assignmentId}: ${objective}`,
            lastDurableOutputAt: timestamp,
            resumeReady: true
          }
        }
      }
    ];
    for (const event of events) {
      await store.appendEvent(event);
    }
    const syncResult = await store.syncSnapshotFromEventsWithRecovery();
    effectiveProjection = syncResult.projection;
    diagnostics.push(
      ...diagnosticsFromWarning(syncResult.warning, "event-log-repaired"),
      {
        level: "warning",
        code: "stale-run-reconciled",
        message: `Requeued stale host run for assignment ${assignmentId}${
          record.hostRunId ? ` (${record.hostRunId})` : ""
        }.`
      }
    );

    const telemetry = await recordNormalizedTelemetry(
      store,
      adapter.normalizeTelemetry({
        eventType: "host.run.stale_reconciled",
        taskId: projection.sessionId,
        assignmentId,
        metadata: {
          hostRunId: record.hostRunId ?? "",
          leaseExpiresAt: record.leaseExpiresAt ?? "",
          heartbeatAt: record.heartbeatAt ?? "",
          staleAt: timestamp
        }
      })
    );
    diagnostics.push(...diagnosticsFromWarning(telemetry.warning, "telemetry-write-failed"));
  }

  return {
    projection: changed ? effectiveProjection : projection,
    diagnostics,
    activeLeases
  };
}

function isRunLeaseExpired(record: HostRunRecord): boolean {
  if (record.state !== "running") {
    return false;
  }
  if (!record.leaseExpiresAt) {
    return true;
  }
  const leaseExpiry = Date.parse(record.leaseExpiresAt);
  if (Number.isNaN(leaseExpiry)) {
    return true;
  }
  return leaseExpiry <= Date.now();
}

function staleReason(record: HostRunRecord): string {
  if (!record.leaseExpiresAt) {
    return "Run record remained in running state without a lease expiry.";
  }
  if (!Number.isNaN(Date.parse(record.leaseExpiresAt))) {
    return `Run lease expired at ${record.leaseExpiresAt}.`;
  }
  return `Run record has an invalid lease expiry: ${record.leaseExpiresAt}.`;
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

function diagnosticsFromWarning(
  warning: string | undefined,
  code: CommandDiagnostic["code"]
): CommandDiagnostic[] {
  return warning ? [{ level: "warning", code, message: warning }] : [];
}
