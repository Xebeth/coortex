import type {
  AssignmentState,
  WorkflowModuleProgressRecord,
  WorkflowTransitionRecord
} from "./types.js";

export function deriveActiveWorkflowModuleState(
  assignmentState: AssignmentState,
  hasOpenDecision: boolean,
  lastTransition: WorkflowTransitionRecord | undefined,
  module: WorkflowModuleProgressRecord
): WorkflowModuleProgressRecord["moduleState"] {
  if (
    lastTransition &&
    lastTransition.transition === "complete" &&
    lastTransition.toModuleId === module.moduleId &&
    lastTransition.workflowCycle === module.workflowCycle &&
    lastTransition.moduleAttempt === module.moduleAttempt
  ) {
    return "completed";
  }
  if (hasOpenDecision || assignmentState === "blocked") {
    return "blocked";
  }
  if (assignmentState === "in_progress") {
    return "in_progress";
  }
  if (assignmentState === "completed" || assignmentState === "failed") {
    return module.moduleState === "blocked" ? "blocked" : "in_progress";
  }
  return "queued";
}

export function derivePreTransitionWorkflowModuleState(
  assignmentState: AssignmentState,
  currentModuleState: WorkflowModuleProgressRecord["moduleState"]
): WorkflowModuleProgressRecord["moduleState"] {
  if (assignmentState === "blocked" || currentModuleState === "blocked") {
    return "blocked";
  }
  if (assignmentState === "queued" && currentModuleState === "queued") {
    return "queued";
  }
  return "in_progress";
}
