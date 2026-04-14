import type {
  Assignment,
  DecisionPacket,
  RuntimeProjection,
  WorkflowSummary
} from "./types.js";
import { deriveActiveWorkflowModuleState } from "./workflow-module-state.js";

export interface WorkflowOperatorGuidance {
  currentAssignment: Assignment | undefined;
  currentModuleState: WorkflowSummary["currentModuleState"];
  blockerReason: string | null;
  currentObjective: string;
  nextRequiredAction: string;
  resumeReady: boolean;
}

export function deriveWorkflowOperatorGuidance(
  projection: RuntimeProjection
): WorkflowOperatorGuidance | null {
  const progress = projection.workflowProgress;
  if (!progress) {
    return null;
  }

  const durableCurrentModule = progress.modules[progress.currentModuleId];
  const rawCurrentAssignment = progress.currentAssignmentId
    ? projection.assignments.get(progress.currentAssignmentId)
    : undefined;
  const currentAssignment = durableCurrentModule ? rawCurrentAssignment : undefined;
  const openDecision = currentAssignment
    ? getOpenDecisionSummary(projection, currentAssignment.id, workflowAttemptLowerBound(progress))
    : undefined;
  const currentModuleState = currentAssignment && durableCurrentModule
    ? deriveActiveWorkflowModuleState(
        currentAssignment.state,
        Boolean(openDecision),
        progress.lastTransition,
        durableCurrentModule
      )
    : progress.lastTransition?.transition === "complete"
      ? "completed"
      : "blocked";
  const blockerReason = openDecision
    ? `Resolve decision ${openDecision.decisionId}: ${openDecision.blockerSummary}`
    : currentAssignment
      ? currentAssignment.state === "blocked"
        ? `Unblock ${progress.currentModuleId} assignment ${currentAssignment.id}: ${currentAssignment.objective}`
      : null
      : currentModuleState === "completed"
        ? null
        : `Inspect workflow ${progress.workflowId} and repair runtime state.`;
  const currentObjective = blockerReason
    ?? (!currentAssignment
      ? currentModuleState === "completed"
        ? `Workflow ${progress.workflowId} complete.`
        : `Inspect workflow ${progress.workflowId} and repair runtime state.`
      : `${
          currentAssignment.state === "in_progress" ? "Continue" : "Start"
        } ${progress.currentModuleId} assignment ${currentAssignment.id}: ${currentAssignment.objective}`);

  return {
    currentAssignment,
    currentModuleState,
    blockerReason,
    currentObjective,
    nextRequiredAction: currentObjective,
    resumeReady: Boolean(currentAssignment)
  };
}

function getOpenDecisionSummary(
  projection: RuntimeProjection,
  assignmentId: string,
  attemptLowerBound: string
) {
  return [...projection.decisions.values()]
    .filter(
      (decision) =>
        decision.assignmentId === assignmentId &&
        decision.state === "open" &&
        decision.createdAt >= attemptLowerBound
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
}

function workflowAttemptLowerBound(workflow: NonNullable<RuntimeProjection["workflowProgress"]>): string {
  return workflow.currentModuleAttempt > 1
    ? (workflow.modules[workflow.currentModuleId]?.enteredAt ?? workflow.lastTransition?.appliedAt ?? "")
    : "";
}
