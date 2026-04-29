import { randomUUID } from "node:crypto";

import { matchesCompletedRunDecision, matchesCompletedRunResult } from "../core/outcome-identity.js";
import type { RuntimeEvent } from "../core/events.js";
import type { DecisionPacket, HostRunRecord, RuntimeProjection } from "../core/types.js";
import { applyRuntimeEventsToProjection } from "../projections/runtime-projection.js";
import { isRuntimeAuthorityIntegrityError } from "../projections/attachment-claim-queries.js";
import { nowIso } from "../utils/time.js";
import { buildNextRuntimeStatus } from "./runtime-status.js";

export interface CompletedRunRecoveryDiagnostic {
  level: "warning";
  code: "completed-run-reconciled";
  message: string;
}

export function buildCompletedRunReconciliation(
  projection: RuntimeProjection,
  record: HostRunRecord,
  replayableEvents?: RuntimeEvent[]
): { events: RuntimeEvent[]; allEvents: RuntimeEvent[]; diagnostic: CompletedRunRecoveryDiagnostic } | undefined {
  if (record.state !== "completed" || !record.terminalOutcome) {
    return undefined;
  }
  const timestamp = nowIso();
  const recoveredDecision =
    findRecoveredCompletedDecision(projection, record) ??
    findRecoveredCompletedDecisionEvent(replayableEvents ?? [], record);
  const recoveredDecisionState = recoveredDecision?.state;
  const events = buildRecoveredOutcomeEvents(
    projection,
    record,
    timestamp,
    recoveredDecisionState
  );
  const expectedStatus = (events[2] as Extract<RuntimeEvent, { type: "status.updated" }>).payload.status;
  const pendingEvents = selectPendingCompletedRecoveryEvents(
    projection,
    record,
    events,
    expectedStatus,
    replayableEvents,
    recoveredDecisionState
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

export function hydrateCompletedDecisionFromReplayableEvents(
  projection: RuntimeProjection,
  record: HostRunRecord,
  replayableEvents?: RuntimeEvent[]
): {
  projection: RuntimeProjection;
  hydrated: boolean;
} {
  if (!replayableEvents || replayableEvents.length === 0 || record.terminalOutcome?.kind !== "decision") {
    return {
      projection,
      hydrated: false
    };
  }

  const replayableDecisionEvents = selectRecoveredCompletedDecisionReplayEvents(
    projection,
    record,
    replayableEvents
  );
  if (replayableDecisionEvents.length === 0) {
    return {
      projection,
      hydrated: false
    };
  }

  let hydratedProjection = projection;
  let hydrated = false;
  for (const event of replayableDecisionEvents) {
    try {
      hydratedProjection = applyRuntimeEventsToProjection(hydratedProjection, [event]);
      hydrated = true;
    } catch (error) {
      if (isRuntimeAuthorityIntegrityError(error)) {
        throw error;
      }
      continue;
    }
  }

  return {
    projection: hydrated ? hydratedProjection : projection,
    hydrated
  };
}

function selectPendingCompletedRecoveryEvents(
  projection: RuntimeProjection,
  record: HostRunRecord,
  events: RuntimeEvent[],
  expectedStatus: RuntimeProjection["status"],
  replayableEvents?: RuntimeEvent[],
  recoveredDecisionState?: "open" | "resolved"
): RuntimeEvent[] {
  const [, assignmentEvent, statusEvent] = events;
  const pendingEvents: RuntimeEvent[] = [];
  const recoveredOutcomeEventIndex = replayableEvents
    ? findRecoveredCompletedOutcomeEventIndexFromEvents(replayableEvents, record)
    : undefined;
  const outcomeRecoveredInProjection = hasRecoveredCompletedOutcomeEvent(projection, record);
  const outcomeAlreadyAbsorbed =
    outcomeRecoveredInProjection || recoveredOutcomeEventIndex !== undefined;

  const recoveredDecision =
    findRecoveredCompletedDecision(projection, record) ??
    (replayableEvents !== undefined && recoveredOutcomeEventIndex !== undefined
      ? findRecoveredCompletedDecisionEvent(replayableEvents, record)
      : undefined);
  const effectiveDecisionState = recoveredDecisionState ?? recoveredDecision?.state;

  if (!outcomeAlreadyAbsorbed) {
    return [...events];
  }

  if (record.terminalOutcome?.kind === "decision") {
    if (!hasRecoveredCompletedAssignmentState(projection, record, effectiveDecisionState)) {
      pendingEvents.push(assignmentEvent!);
    }
    if (!hasRecoveredCompletedStatus(projection, record, expectedStatus)) {
      pendingEvents.push(statusEvent!);
    }
    return pendingEvents;
  }

  if (!hasRecoveredCompletedAssignmentState(projection, record)) {
    pendingEvents.push(assignmentEvent!);
  }
  if (!hasRecoveredCompletedStatus(projection, record, expectedStatus)) {
    pendingEvents.push(statusEvent!);
  }

  return pendingEvents;
}

function hasRecoveredCompletedOutcomeEvent(
  projection: RuntimeProjection,
  record: HostRunRecord
): boolean {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome) {
    return false;
  }
  if (terminalOutcome.kind === "decision") {
    return findRecoveredCompletedDecision(projection, record) !== undefined;
  }
  return [...projection.results.values()].some((result) =>
    matchesCompletedRunResult(record, result)
  );
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
    .find((event) => matchesCompletedRunDecision(record, event.payload.decision))?.payload.decision;
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
      return matchesCompletedRunDecision(record, event.payload.decision);
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
    return matchesCompletedRunResult(record, event.payload.result);
  });
  return resultIndex === -1 ? undefined : resultIndex;
}

function findRecoveredCompletedDecision(
  projection: RuntimeProjection,
  record: HostRunRecord
) {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome || terminalOutcome.kind !== "decision") {
    return undefined;
  }
  return [...projection.decisions.values()].find((decision) => {
    return matchesCompletedRunDecision(record, decision);
  });
}

function selectRecoveredCompletedDecisionReplayEvents(
  projection: RuntimeProjection,
  record: HostRunRecord,
  replayableEvents: RuntimeEvent[]
): Array<
  | Extract<RuntimeEvent, { type: "decision.created" }>
  | Extract<RuntimeEvent, { type: "decision.resolved" }>
> {
  if (record.terminalOutcome?.kind !== "decision") {
    return [];
  }

  const replayableDecisionCreates = replayableEvents.filter(
    (event): event is Extract<RuntimeEvent, { type: "decision.created" }> =>
      event.type === "decision.created" &&
      matchesCompletedRunDecision(record, event.payload.decision)
  );
  const knownDecisionIds = new Set(
    [
      record.terminalOutcome.decision.decisionId,
      findRecoveredCompletedDecision(projection, record)?.decisionId,
      ...replayableDecisionCreates.map((event) => event.payload.decision.decisionId)
    ].filter((value): value is string => typeof value === "string" && value.length > 0)
  );

  return replayableEvents.filter(
    (
      event
    ): event is
      | Extract<RuntimeEvent, { type: "decision.created" }>
      | Extract<RuntimeEvent, { type: "decision.resolved" }> =>
      (event.type === "decision.created" &&
        matchesCompletedRunDecision(record, event.payload.decision)) ||
      (event.type === "decision.resolved" && knownDecisionIds.has(event.payload.decisionId))
  );
}

function hasRecoveredCompletedAssignmentState(
  projection: RuntimeProjection,
  record: HostRunRecord,
  recoveredDecisionState?: "open" | "resolved"
): boolean {
  const assignment = projection.assignments.get(record.assignmentId);
  const expectedAssignmentState = nextAssignmentStateFromRecord(record, recoveredDecisionState);
  return assignment?.state === expectedAssignmentState;
}

function hasRecoveredCompletedStatus(
  projection: RuntimeProjection,
  record: HostRunRecord,
  expectedStatus: RuntimeProjection["status"]
): boolean {
  if (
    !hasEquivalentCompletedRecoveryStatus(
      projection.status,
      expectedStatus,
      record.terminalOutcome?.kind === "decision"
    )
  ) {
    return false;
  }
  return !(
    isTerminalCompletedResult(record) &&
    projection.status.activeAssignmentIds.includes(record.assignmentId)
  );
}

function isTerminalCompletedResult(record: HostRunRecord): boolean {
  return record.terminalOutcome?.kind === "result" &&
    (record.terminalOutcome.result.status === "completed" || record.terminalOutcome.result.status === "failed");
}

function hasEquivalentCompletedRecoveryStatus(
  actualStatus: RuntimeProjection["status"],
  expectedStatus: RuntimeProjection["status"],
  compareCurrentObjective: boolean
): boolean {
  return (!compareCurrentObjective || actualStatus.currentObjective === expectedStatus.currentObjective) &&
    actualStatus.activeMode === expectedStatus.activeMode &&
    actualStatus.resumeReady === expectedStatus.resumeReady &&
    actualStatus.activeAssignmentIds.length === expectedStatus.activeAssignmentIds.length &&
    actualStatus.activeAssignmentIds.every((id, index) => id === expectedStatus.activeAssignmentIds[index]);
}

function buildRecoveredOutcomeEvents(
  projection: RuntimeProjection,
  record: HostRunRecord,
  timestamp: string,
  recoveredDecisionState?: "open" | "resolved"
): RuntimeEvent[] {
  if (!record.terminalOutcome) {
    throw new Error(`Completed host run for assignment ${record.assignmentId} is missing terminal outcome data.`);
  }
  const events: RuntimeEvent[] = [];

  if (record.terminalOutcome.kind === "decision") {
    const decisionState = recoveredDecisionState ?? record.terminalOutcome.decision.state;
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
          state: decisionState,
          createdAt: record.terminalOutcome.decision.createdAt,
          ...(record.terminalOutcome.decision.resolvedAt
            ? { resolvedAt: record.terminalOutcome.decision.resolvedAt }
            : {}),
          ...(record.terminalOutcome.decision.resolutionSummary
            ? { resolutionSummary: record.terminalOutcome.decision.resolutionSummary }
            : {})
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
        state: nextAssignmentStateFromRecord(record, recoveredDecisionState),
        updatedAt: timestamp
      }
    }
  });
  const postTransitionProjection = applyRuntimeEventsToProjection(projection, events);
  const status = buildNextRuntimeStatus(
    postTransitionProjection,
    record.assignmentId,
    record.terminalOutcome.kind === "decision"
      ? {
          kind: "decision",
          blockerSummary: record.terminalOutcome.decision.blockerSummary,
          state: recoveredDecisionState ?? record.terminalOutcome.decision.state
        }
      : {
          kind: "result",
          status: record.terminalOutcome.result.status
        },
    timestamp
  );
  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "status.updated",
    payload: { status }
  });

  return events;
}

function nextAssignmentStateFromRecord(record: HostRunRecord, recoveredDecisionState?: "open" | "resolved") {
  if (!record.terminalOutcome) {
    return "failed" as const;
  }
  if (record.terminalOutcome.kind === "decision") {
    const decisionState = recoveredDecisionState ?? record.terminalOutcome.decision.state;
    return decisionState === "resolved" ? ("in_progress" as const) : ("blocked" as const);
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
