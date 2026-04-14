import type {
  Assignment,
  RuntimeProjection,
  RuntimeStatus,
  WorkflowProgressRecord,
  WorkflowSummary
} from "../core/types.js";
import { deriveWorkflowOperatorGuidance as deriveSharedWorkflowOperatorGuidance } from "../core/workflow-guidance.js";
import { getWorkflowModule } from "./registry.js";
import { toProjectRelativeArtifactPath, workflowArtifactPath } from "./progression.js";

export function deriveWorkflowSummary(projection: RuntimeProjection): WorkflowSummary | null {
  const progress = projection.workflowProgress;
  const guidance = deriveSharedWorkflowOperatorGuidance(projection);
  if (!progress || !guidance) {
    return null;
  }

  const currentAssignment = guidance.currentAssignment;
  const currentModule = getWorkflowModule(progress.currentModuleId);
  const readArtifacts = currentAssignment
    ? currentModule.getReadArtifacts(progress).map(toProjectRelativeArtifactPath)
    : [];
  const outputArtifact = currentAssignment
    ? toProjectRelativeArtifactPath(
        workflowArtifactPath(
          progress.workflowId,
          progress.workflowCycle,
          progress.currentModuleId,
          progress.currentAssignmentId!,
          progress.currentModuleAttempt
        )
      )
    : null;
  const rerunEligible = Boolean(
    currentAssignment &&
      (currentAssignment.state === "queued" || currentAssignment.state === "in_progress") &&
      !guidance.blockerReason
  );

  return {
    id: progress.workflowId,
    currentModuleId: progress.currentModuleId,
    currentModuleState: guidance.currentModuleState,
    workflowCycle: progress.workflowCycle,
    currentAssignmentId: currentAssignment?.id ?? null,
    outputArtifact,
    readArtifacts,
    rerunEligible,
    blockerReason: guidance.blockerReason,
    lastGateOutcome: progress.lastGate?.gateOutcome ?? null,
    lastDurableAdvancement: deriveLastDurableAdvancement(progress)
  };
}

export function deriveWorkflowOperatorGuidance(
  projection: RuntimeProjection
): {
  currentObjective: string;
  nextRequiredAction: string;
  resumeReady: boolean;
} | null {
  const guidance = deriveSharedWorkflowOperatorGuidance(projection);
  if (!guidance) {
    return null;
  }

  return {
    currentObjective: guidance.currentObjective,
    nextRequiredAction: guidance.nextRequiredAction,
    resumeReady: guidance.resumeReady
  };
}

export function deriveWorkflowStatus(
  projection: RuntimeProjection,
  timestamp: string
): RuntimeStatus {
  const sharedGuidance = deriveSharedWorkflowOperatorGuidance(projection);
  const guidance = sharedGuidance
    ? {
        currentObjective: sharedGuidance.currentObjective,
        nextRequiredAction: sharedGuidance.nextRequiredAction,
        resumeReady: sharedGuidance.resumeReady
      }
    : null;
  if (!guidance) {
    return projection.status;
  }

  const currentAssignment = sharedGuidance?.currentAssignment;

  return {
    ...projection.status,
    activeMode: currentAssignment ? projection.status.activeMode : "idle",
    currentObjective: guidance.currentObjective,
    activeAssignmentIds: currentAssignment ? [currentAssignment.id] : [],
    lastDurableOutputAt: timestamp,
    resumeReady: guidance.resumeReady
  };
}

export function deriveWorkflowNextRequiredAction(projection: RuntimeProjection): string | null {
  return deriveWorkflowOperatorGuidance(projection)?.nextRequiredAction ?? null;
}

export function getCurrentWorkflowAssignment(
  projection: RuntimeProjection
): Assignment | undefined {
  const assignmentId = projection.workflowProgress?.currentAssignmentId;
  return assignmentId ? projection.assignments.get(assignmentId) : undefined;
}

export function currentModuleAttemptStartedAt(progress: WorkflowProgressRecord): string {
  return progress.modules[progress.currentModuleId]?.enteredAt
    ?? progress.lastTransition?.appliedAt
    ?? "";
}

function deriveLastDurableAdvancement(progress: WorkflowProgressRecord): string | null {
  if (progress.lastGate?.evidenceSummary) {
    return progress.lastGate.evidenceSummary;
  }
  if (!progress.lastTransition) {
    return null;
  }
  switch (progress.lastTransition.transition) {
    case "advance":
      return `Advanced to ${progress.lastTransition.toModuleId}.`;
    case "rewind":
      return `Rewound to ${progress.lastTransition.toModuleId}.`;
    case "rerun_same_module":
      return `Rerun ${progress.lastTransition.toModuleId} attempt ${progress.lastTransition.moduleAttempt}.`;
    case "complete":
      return `Workflow ${progress.workflowId} complete.`;
  }
}
