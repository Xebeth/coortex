import { randomUUID } from "node:crypto";

import type { HostAdapter } from "../adapters/contract.js";
import { isRunLeaseExpired } from "../core/run-state.js";
import type { RuntimeEvent } from "../core/events.js";
import type { HostRunRecord } from "../core/types.js";
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
  let queuedTransitions: Map<string, string[]> | undefined;
  let staleStatusTransitions: Map<string, string[]> | undefined;
  let handledCompletedRun = false;

  for (const assignmentId of projection.status.activeAssignmentIds) {
    const record = await adapter.inspectRun(store, assignmentId);
    if (!record) {
      continue;
    }

    if (record.state === "completed") {
      if (record.staleReasonCode && !record.terminalOutcome) {
        changed = true;
        queuedTransitions ??= await loadQueuedTransitions(store);
        staleStatusTransitions ??= await loadStaleRecoveryStatusTransitions(store);
        const staleRecoveryState = getStaleRunRecoveryState(
          assignmentId,
          record,
          queuedTransitions,
          staleStatusTransitions
        );
        if (isStaleRunAlreadyReconciled(effectiveProjection, assignmentId, staleRecoveryState)) {
          try {
            await adapter.reconcileStaleRun(store, record);
          } catch (error) {
            diagnostics.push(
              ...diagnosticsFromWarning(
                `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${
                  error instanceof Error ? error.message : String(error)
                }`,
                "host-run-persist-failed"
              )
            );
          }
          continue;
        }

        const reconciliation = buildStaleRunReconciliation(effectiveProjection, assignmentId, record);
        const pendingEvents = selectPendingStaleRecoveryEvents(
          reconciliation.events,
          staleRecoveryState
        );
        if (pendingEvents.length === 0) {
          try {
            await adapter.reconcileStaleRun(store, reconciliation.staleRecord);
          } catch (error) {
            diagnostics.push(
              ...diagnosticsFromWarning(
                `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${
                  error instanceof Error ? error.message : String(error)
                }`,
                "host-run-persist-failed"
              )
            );
          }
          continue;
        }

        changed = true;
        for (const event of pendingEvents) {
          await store.appendEvent(event);
        }
        if (pendingEvents.length !== reconciliation.events.length) {
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
        } else {
          queuedTransitions.set(assignmentId, [
            ...(queuedTransitions.get(assignmentId) ?? []),
            reconciliation.events[0]!.timestamp
          ]);
          staleStatusTransitions.set(assignmentId, [
            ...(staleStatusTransitions.get(assignmentId) ?? []),
            reconciliation.events[1]!.timestamp
          ]);
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
        try {
          await adapter.reconcileStaleRun(store, reconciliation.staleRecord);
        } catch (error) {
          diagnostics.push(
            ...diagnosticsFromWarning(
              `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${
                error instanceof Error ? error.message : String(error)
              }`,
              "host-run-persist-failed"
            )
          );
        }
        continue;
      }
      const completedRecovery = buildCompletedRunReconciliation(effectiveProjection, record);
      if (!completedRecovery) {
        continue;
      }
      changed = true;
      for (const event of completedRecovery.events) {
        await store.appendEvent(event);
      }
      const syncResult = await store.syncSnapshotFromEventsWithRecovery();
      effectiveProjection = syncResult.projection;
      diagnostics.push(
        ...diagnosticsFromWarning(syncResult.warning, "event-log-repaired"),
        completedRecovery.diagnostic
      );
      try {
        await adapter.reconcileStaleRun(store, record);
      } catch (error) {
        diagnostics.push(
          ...diagnosticsFromWarning(
            `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${
              error instanceof Error ? error.message : String(error)
            }`,
            "host-run-persist-failed"
          )
        );
      }
      continue;
    }

    if (!isRunLeaseExpired(record)) {
      activeLeases.push(assignmentId);
      diagnostics.push(createActiveRunDiagnostic(assignmentId, record));
      continue;
    }

    queuedTransitions ??= await loadQueuedTransitions(store);
    staleStatusTransitions ??= await loadStaleRecoveryStatusTransitions(store);
    const staleRecoveryState = getStaleRunRecoveryState(
      assignmentId,
      record,
      queuedTransitions,
      staleStatusTransitions
    );
    if (isStaleRunAlreadyReconciled(effectiveProjection, assignmentId, staleRecoveryState)) {
      const { staleRecord } = buildStaleRunReconciliation(effectiveProjection, assignmentId, record);
      try {
        await adapter.reconcileStaleRun(store, staleRecord);
      } catch (error) {
        diagnostics.push(
          ...diagnosticsFromWarning(
            `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${
              error instanceof Error ? error.message : String(error)
            }`,
            "host-run-persist-failed"
          )
        );
      }
      continue;
    }

    const reconciliation = buildStaleRunReconciliation(effectiveProjection, assignmentId, record);
    const pendingEvents = selectPendingStaleRecoveryEvents(reconciliation.events, staleRecoveryState);
    if (pendingEvents.length === 0) {
      continue;
    }

    changed = true;
    for (const event of pendingEvents) {
      await store.appendEvent(event);
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
    try {
      await adapter.reconcileStaleRun(store, reconciliation.staleRecord);
    } catch (error) {
      diagnostics.push(
        ...diagnosticsFromWarning(
          `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${
            error instanceof Error ? error.message : String(error)
          }`,
          "host-run-persist-failed"
        )
      );
    }
  }

  return {
    projection: changed ? effectiveProjection : projection,
    diagnostics,
    activeLeases
  };
}

function isStaleRunAlreadyReconciled(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string,
  recoveryState: StaleRunRecoveryState
): boolean {
  const assignment = projection.assignments.get(assignmentId);
  return (
    assignment?.state === "queued" &&
    Boolean(recoveryState.queuedTransitionTimestamp) &&
    Boolean(recoveryState.statusTransitionTimestamp)
  );
}

async function loadQueuedTransitions(store: RuntimeStore): Promise<Map<string, string[]>> {
  const queuedTransitions = new Map<string, string[]>();
  const { events } = await store.loadReplayableEvents();
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

async function loadStaleRecoveryStatusTransitions(store: RuntimeStore): Promise<Map<string, string[]>> {
  const statusTransitions = new Map<string, string[]>();
  const { events } = await store.loadReplayableEvents();
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
  record: HostRunRecord
): { events: RuntimeEvent[]; diagnostic: CommandDiagnostic } | undefined {
  if (record.state !== "completed" || !record.terminalOutcome) {
    return undefined;
  }
  if (!projection.status.activeAssignmentIds.includes(record.assignmentId)) {
    return undefined;
  }
  if (hasRecoveredCompletedOutcome(projection, record)) {
    return undefined;
  }
  const timestamp = nowIso();
  const assignmentId = record.assignmentId;
  const events = buildRecoveredOutcomeEvents(projection, record, timestamp);
  return {
    events,
    diagnostic: {
      level: "warning",
      code: "completed-run-reconciled",
      message: `Recovered completed host outcome for assignment ${assignmentId} after runtime event persistence was interrupted.`
    }
  };
}

function hasRecoveredCompletedOutcome(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord
): boolean {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome) {
    return false;
  }
  if (terminalOutcome.kind === "decision") {
    return [...projection.decisions.values()].some((decision) => {
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
  const assignment = projection.assignments.get(record.assignmentId);
  const expectedAssignmentState = nextAssignmentStateFromRecord(record);
  if (assignment?.state !== expectedAssignmentState) {
    return false;
  }
  const expectedStatus = nextRuntimeStatusFromRecord(
    projection,
    record,
    projection.status.lastDurableOutputAt
  );
  if (
    projection.status.currentObjective !== expectedStatus.currentObjective ||
    projection.status.activeMode !== expectedStatus.activeMode ||
    projection.status.resumeReady !== expectedStatus.resumeReady ||
    projection.status.activeAssignmentIds.length !== expectedStatus.activeAssignmentIds.length ||
    projection.status.activeAssignmentIds.some((id, index) => id !== expectedStatus.activeAssignmentIds[index])
  ) {
    return false;
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

  if (record.terminalOutcome.kind === "decision") {
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "decision.created",
      payload: {
        decision: {
          decisionId: record.terminalOutcome.decision.decisionId ?? randomUUID(),
          assignmentId: record.assignmentId,
          requesterId: record.terminalOutcome.decision.requesterId,
          blockerSummary: record.terminalOutcome.decision.blockerSummary,
          options: record.terminalOutcome.decision.options.map((option) => ({ ...option })),
          recommendedOption: record.terminalOutcome.decision.recommendedOption,
          state: record.terminalOutcome.decision.state,
          createdAt: record.terminalOutcome.decision.createdAt
        }
      }
    });
  } else {
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "result.submitted",
      payload: {
        result: {
          resultId: record.terminalOutcome.result.resultId ?? randomUUID(),
          assignmentId: record.assignmentId,
          producerId: record.terminalOutcome.result.producerId,
          status: record.terminalOutcome.result.status,
          summary: record.terminalOutcome.result.summary,
          changedFiles: [...record.terminalOutcome.result.changedFiles],
          createdAt: record.terminalOutcome.result.createdAt
        }
      }
    });
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

function nextAssignmentStateFromRecord(record: HostRunRecord) {
  if (!record.terminalOutcome) {
    return "failed" as const;
  }
  if (record.terminalOutcome.kind === "decision") {
    return "blocked" as const;
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
