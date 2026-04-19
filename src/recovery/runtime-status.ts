import type { RuntimeProjection } from "../core/types.js";
import { findLatestAssignmentDecision } from "../projections/assignment-outcome-queries.js";

interface DecisionOutcomeShape {
  kind: "decision";
  blockerSummary: string;
  state: "open" | "resolved";
}

interface ResultOutcomeShape {
  kind: "result";
  status: string;
}

export type RuntimeStatusOutcome = DecisionOutcomeShape | ResultOutcomeShape;

const RETRY_OBJECTIVE_PREFIX = /^Retry assignment [^:]+:\s*/;

export function buildNextRuntimeStatus(
  projection: RuntimeProjection,
  assignmentId: string,
  outcome: RuntimeStatusOutcome,
  timestamp: string
): RuntimeProjection["status"] {
  const terminal =
    outcome.kind === "result" && (outcome.status === "completed" || outcome.status === "failed");
  const activeAssignmentIds = terminal
    ? projection.status.activeAssignmentIds.filter((id) => id !== assignmentId)
    : projection.status.activeAssignmentIds;

  return {
    ...projection.status,
    activeMode: activeAssignmentIds.length === 0 ? "idle" : projection.status.activeMode,
    currentObjective: nextCurrentObjective(projection, assignmentId, outcome, activeAssignmentIds),
    activeAssignmentIds,
    lastDurableOutputAt: timestamp,
    resumeReady: true,
    lastStaleRunInstanceId: undefined
  };
}

export function buildRetryRuntimeStatus(
  projection: RuntimeProjection,
  assignmentId: string,
  objective: string,
  timestamp: string,
  options?: {
    lastStaleRunInstanceId?: string;
  }
): RuntimeProjection["status"] {
  const prioritizedAssignmentId = projection.status.activeAssignmentIds[0] ?? assignmentId;
  const prioritizedObjective =
    projection.assignments.get(prioritizedAssignmentId)?.objective
    ?? (prioritizedAssignmentId === assignmentId ? objective : projection.status.currentObjective);
  return {
    ...projection.status,
    currentObjective: buildRetryObjective(prioritizedAssignmentId, prioritizedObjective),
    lastDurableOutputAt: timestamp,
    resumeReady: true,
    ...(options?.lastStaleRunInstanceId !== undefined
      ? { lastStaleRunInstanceId: options.lastStaleRunInstanceId }
      : {})
  };
}

function nextCurrentObjective(
  projection: RuntimeProjection,
  assignmentId: string,
  outcome: RuntimeStatusOutcome,
  activeAssignmentIds: string[]
): string {
  if (activeAssignmentIds.length === 0) {
    return outcome.kind === "result" && outcome.status === "failed"
      ? `Review failed assignment ${assignmentId}.`
      : "Await the next assignment.";
  }

  if (outcome.kind === "decision") {
    return nextDecisionCurrentObjective(
      projection,
      assignmentId,
      blockerSummaryOrFallback(outcome.blockerSummary, projection.status.currentObjective),
      outcome.state,
      activeAssignmentIds
    );
  }

  if (statusObjectiveTracksAssignment(projection, assignmentId) && !activeAssignmentIds.includes(assignmentId)) {
    return projection.assignments.get(activeAssignmentIds[0] ?? "")?.objective ?? projection.status.currentObjective;
  }

  return projection.status.currentObjective;
}

function nextDecisionCurrentObjective(
  projection: RuntimeProjection,
  assignmentId: string,
  blockerSummary: string,
  decisionState: "open" | "resolved",
  activeAssignmentIds: string[]
): string {
  if (decisionState === "resolved") {
    if (
      projection.status.currentObjective === blockerSummary ||
      statusObjectiveTracksAssignment(projection, assignmentId)
    ) {
      return projection.assignments.get(assignmentId)?.objective ?? projection.status.currentObjective;
    }
    return projection.status.currentObjective;
  }
  const latestDecision = findLatestAssignmentDecision(projection, assignmentId);
  if (!latestDecision) {
    return blockerSummary;
  }
  if (latestDecision.state === "resolved") {
    return projection.status.currentObjective;
  }
  if (
    statusObjectiveTracksAssignment(projection, assignmentId) ||
    (activeAssignmentIds.length === 1 && activeAssignmentIds[0] === assignmentId)
  ) {
    return blockerSummary;
  }
  return projection.status.currentObjective;
}

function blockerSummaryOrFallback(blockerSummary: string, fallback: string): string {
  return blockerSummary.trim().length > 0 ? blockerSummary : fallback;
}

function buildRetryObjective(
  assignmentId: string,
  objective: string
): string {
  let normalizedObjective = objective.trim();
  while (RETRY_OBJECTIVE_PREFIX.test(normalizedObjective)) {
    normalizedObjective = normalizedObjective.replace(RETRY_OBJECTIVE_PREFIX, "").trimStart();
  }
  return `Retry assignment ${assignmentId}: ${normalizedObjective}`;
}

function statusObjectiveTracksAssignment(
  projection: RuntimeProjection,
  assignmentId: string
): boolean {
  const assignmentObjective = projection.assignments.get(assignmentId)?.objective;
  if (assignmentObjective && projection.status.currentObjective === assignmentObjective) {
    return true;
  }
  return projection.status.currentObjective.startsWith(`Retry assignment ${assignmentId}:`);
}
