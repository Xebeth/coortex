import type { RecoveryBrief, RuntimeProjection } from "../core/types.js";
import { deriveWorkflowOperatorGuidance } from "../core/workflow-guidance.js";

export function buildRecoveryBrief(projection: RuntimeProjection): RecoveryBrief {
  const workflowGuidance = projection.workflowProgress
    ? deriveWorkflowOperatorGuidance(projection)
    : null;
  const activeAssignments = workflowGuidance
    ? workflowGuidance.currentAssignment ? [workflowGuidance.currentAssignment] : []
    : [...projection.assignments.values()].filter((assignment) =>
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
  const unresolvedDecisions = selectRelevantOpenDecisions(
    projection,
    workflowGuidance,
    activeAssignments
  )
    .map((decision) => ({
      decisionId: decision.decisionId,
      assignmentId: decision.assignmentId,
      blockerSummary: decision.blockerSummary,
      recommendedOption: decision.recommendedOption
    }));

  return {
    activeObjective: workflowGuidance?.currentObjective ?? projection.status.currentObjective,
    activeAssignments: activeAssignments.map((assignment) => ({
      id: assignment.id,
      objective: assignment.objective,
      state: assignment.state,
      writeScope: assignment.writeScope,
      requiredOutputs: assignment.requiredOutputs
    })),
    lastDurableResults: recentResults,
    unresolvedDecisions,
    nextRequiredAction: workflowGuidance?.nextRequiredAction
      ?? determineNextAction(activeAssignments, unresolvedDecisions),
    generatedAt: deriveGeneratedAt(projection)
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

function selectRelevantOpenDecisions(
  projection: RuntimeProjection,
  workflowGuidance: ReturnType<typeof deriveWorkflowOperatorGuidance>,
  activeAssignments: RecoveryBrief["activeAssignments"]
) {
  const openDecisions = [...projection.decisions.values()].filter(
    (decision) => decision.state === "open"
  );
  if (projection.workflowProgress) {
    const currentAssignmentId = workflowGuidance?.currentAssignment?.id;
    if (!currentAssignmentId) {
      return [];
    }
    const attemptLowerBound = workflowDecisionLowerBound(projection);
    return openDecisions.filter(
      (decision) =>
        decision.assignmentId === currentAssignmentId &&
        decision.createdAt >= attemptLowerBound
    );
  }

  const activeAssignmentIds = new Set(activeAssignments.map((assignment) => assignment.id));
  return openDecisions.filter((decision) => activeAssignmentIds.has(decision.assignmentId));
}

function workflowDecisionLowerBound(projection: RuntimeProjection): string {
  const workflow = projection.workflowProgress;
  if (!workflow || workflow.currentModuleAttempt <= 1) {
    return "";
  }
  return workflow.modules[workflow.currentModuleId]?.enteredAt ?? workflow.lastTransition?.appliedAt ?? "";
}

function deriveGeneratedAt(projection: RuntimeProjection): string {
  const timestamps = [
    projection.status.lastDurableOutputAt,
    ...[...projection.assignments.values()].flatMap((assignment) => [
      assignment.createdAt,
      assignment.updatedAt
    ]),
    ...[...projection.results.values()].map((result) => result.createdAt),
    ...[...projection.decisions.values()].flatMap((decision) =>
      decision.resolvedAt ? [decision.createdAt, decision.resolvedAt] : [decision.createdAt]
    )
  ].filter((value) => value.length > 0);

  return timestamps.sort().at(-1) ?? "";
}
