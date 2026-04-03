import type { RecoveryBrief, RuntimeProjection } from "../core/types.js";
import { nowIso } from "../utils/time.js";

export function buildRecoveryBrief(projection: RuntimeProjection): RecoveryBrief {
  const activeAssignments = [...projection.assignments.values()].filter((assignment) =>
    projection.status.activeAssignmentIds.includes(assignment.id)
  );
  const recentResults = [...projection.results.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 3)
    .map((result) => ({
      resultId: result.resultId,
      assignmentId: result.assignmentId,
      status: result.status,
      summary: result.summary,
      changedFiles: result.changedFiles,
      createdAt: result.createdAt
    }));
  const unresolvedDecisions = [...projection.decisions.values()]
    .filter((decision) => decision.state === "open")
    .map((decision) => ({
      decisionId: decision.decisionId,
      assignmentId: decision.assignmentId,
      blockerSummary: decision.blockerSummary,
      recommendedOption: decision.recommendedOption
    }));

  return {
    activeObjective: projection.status.currentObjective,
    activeAssignments: activeAssignments.map((assignment) => ({
      id: assignment.id,
      objective: assignment.objective,
      state: assignment.state,
      writeScope: assignment.writeScope,
      requiredOutputs: assignment.requiredOutputs
    })),
    lastDurableResults: recentResults,
    unresolvedDecisions,
    nextRequiredAction: determineNextAction(activeAssignments, unresolvedDecisions),
    generatedAt: nowIso()
  };
}

function determineNextAction(
  activeAssignments: RecoveryBrief["activeAssignments"],
  unresolvedDecisions: RecoveryBrief["unresolvedDecisions"]
): string {
  if (unresolvedDecisions.length > 0) {
    const nextDecision = unresolvedDecisions[0]!;
    return `Resolve decision ${nextDecision.decisionId}: ${nextDecision.blockerSummary}`;
  }
  const blockedAssignment = activeAssignments.find((assignment) => assignment.state === "blocked");
  if (blockedAssignment) {
    return `Unblock assignment ${blockedAssignment.id}: ${blockedAssignment.objective}`;
  }
  const inProgressAssignment = activeAssignments.find(
    (assignment) => assignment.state === "in_progress"
  );
  if (inProgressAssignment) {
    return `Continue assignment ${inProgressAssignment.id}: ${inProgressAssignment.objective}`;
  }
  const queuedAssignment = activeAssignments.find((assignment) => assignment.state === "queued");
  if (queuedAssignment) {
    return `Start assignment ${queuedAssignment.id}: ${queuedAssignment.objective}`;
  }
  return "Inspect status and decide the next assignment.";
}
