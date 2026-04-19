import type { RuntimeProjection } from "../core/types.js";

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
  const latestDecision = [...projection.decisions.values()]
    .filter((decision) => decision.assignmentId === assignmentId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
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
