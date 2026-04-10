import { randomUUID } from "node:crypto";

import type { HostAdapter } from "../adapters/contract.js";
import { isRunLeaseExpired } from "../core/run-state.js";
import type { RuntimeEvent } from "../core/events.js";
import { buildStaleRunReconciliation, createActiveRunDiagnostic, selectRunnableProjection } from "../recovery/host-runs.js";
import { recordNormalizedTelemetry } from "../telemetry/recorder.js";
import { nowIso } from "../utils/time.js";
import { RuntimeStore } from "../persistence/store.js";

import type { CommandDiagnostic } from "./types.js";
import { diagnosticsFromWarning, loadOperatorProjection, loadOperatorProjectionWithDiagnostics } from "./runtime-state.js";

export async function loadReconciledProjectionWithDiagnostics(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<{
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  diagnostics: CommandDiagnostic[];
}> {
  const loaded = await loadOperatorProjectionWithDiagnostics(store);
  const reconciled = await reconcileActiveRuns(store, adapter, loaded.projection);
  return {
    projection: reconciled.projection,
    diagnostics: [...loaded.diagnostics, ...reconciled.diagnostics]
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
      diagnostics.push(createActiveRunDiagnostic(assignmentId, record));
      continue;
    }

    changed = true;
    const reconciliation = buildStaleRunReconciliation(effectiveProjection, assignmentId, record);
    await store.writeJsonArtifact(
      `adapters/${adapter.id}/runs/${assignmentId}.json`,
      reconciliation.staleRecord
    );
    await store.writeJsonArtifact(`adapters/${adapter.id}/last-run.json`, reconciliation.staleRecord);
    await store.deleteArtifact(`adapters/${adapter.id}/runs/${assignmentId}.lease.json`);

    for (const event of reconciliation.events) {
      await store.appendEvent(event);
    }
    const syncResult = await store.syncSnapshotFromEventsWithRecovery();
    effectiveProjection = syncResult.projection;
    diagnostics.push(
      ...diagnosticsFromWarning(syncResult.warning, "event-log-repaired"),
      reconciliation.diagnostic
    );

    const telemetry = await recordNormalizedTelemetry(
      store,
      adapter.normalizeTelemetry({
        eventType: "host.run.stale_reconciled",
        taskId: projection.sessionId,
        assignmentId,
        metadata: reconciliation.telemetryMetadata
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
