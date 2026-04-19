import { randomUUID } from "node:crypto";

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

export function buildCompletedRunRecordFromRuntimeOutcome(
  projection: RuntimeProjection,
  record: HostRunRecord
): HostRunRecord | undefined {
  const assignmentId = record.assignmentId;
  const startedAt = record.startedAt;
  const decision = [...projection.decisions.values()]
    .filter((candidate) => candidate.assignmentId === assignmentId)
    .filter((candidate) => candidate.createdAt >= startedAt)
    .at(-1);
  const result = [...projection.results.values()]
    .filter(
      (candidate) =>
        candidate.assignmentId === assignmentId &&
        candidate.createdAt >= startedAt &&
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
      startedAt,
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
    startedAt,
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
    .find((event) => matchesRecoveredCompletedDecision(record, event.payload.decision))?.payload.decision;
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

function findRecoveredCompletedDecision(
  projection: RuntimeProjection,
  record: HostRunRecord
) {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome || terminalOutcome.kind !== "decision") {
    return undefined;
  }
  return [...projection.decisions.values()].find((decision) => {
    return matchesRecoveredCompletedDecision(record, decision);
  });
}

function matchesRecoveredCompletedDecision(
  record: HostRunRecord,
  decision: Pick<DecisionPacket, "assignmentId" | "decisionId" | "blockerSummary" | "recommendedOption" | "createdAt">
): boolean {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome || terminalOutcome.kind !== "decision") {
    return false;
  }
  if (decision.assignmentId !== record.assignmentId) {
    return false;
  }
  return terminalOutcome.decision.decisionId
    ? decision.decisionId === terminalOutcome.decision.decisionId
    : decision.blockerSummary === terminalOutcome.decision.blockerSummary &&
        decision.recommendedOption === terminalOutcome.decision.recommendedOption &&
        decision.createdAt === terminalOutcome.decision.createdAt;
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
      matchesRecoveredCompletedDecision(record, event.payload.decision)
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
        matchesRecoveredCompletedDecision(record, event.payload.decision)) ||
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
    record.terminalOutcome?.kind === "result" &&
    projection.status.activeAssignmentIds.includes(record.assignmentId)
  );
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
