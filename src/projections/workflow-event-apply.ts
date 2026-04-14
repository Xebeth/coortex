import type { RuntimeEvent } from "../core/events.js";
import type {
  RuntimeProjection,
  WorkflowArtifactReference,
  WorkflowLastGateRecord,
  WorkflowModuleProgressRecord
} from "../core/types.js";
import { deriveActiveWorkflowModuleState } from "../core/workflow-module-state.js";
import {
  dedupeArtifactReferences,
  ensureWorkflowModule,
  requireWorkflowProgress
} from "./workflow-projection-helpers.js";

export type WorkflowRuntimeEvent = Extract<
  RuntimeEvent,
  {
    type:
      | "workflow.initialized"
      | "workflow.artifact.claimed"
      | "workflow.gate.recorded"
      | "workflow.transition.applied";
  }
>;

export function applyWorkflowEvent(
  projection: RuntimeProjection,
  event: WorkflowRuntimeEvent
): void {
  switch (event.type) {
    case "workflow.initialized":
      projection.workflowProgress = {
        workflowId: event.payload.workflowId,
        orderedModuleIds: [...event.payload.orderedModuleIds],
        currentModuleId: event.payload.currentModuleId,
        workflowCycle: event.payload.workflowCycle,
        currentAssignmentId: event.payload.currentAssignmentId,
        currentModuleAttempt: event.payload.currentModuleAttempt,
        modules: {
          [event.payload.currentModuleId]: {
            moduleId: event.payload.currentModuleId,
            workflowCycle: event.payload.workflowCycle,
            moduleAttempt: event.payload.currentModuleAttempt,
            assignmentId: event.payload.currentAssignmentId,
            moduleState: "queued",
            sourceResultIds: [],
            sourceDecisionIds: [],
            artifactReferences: [],
            enteredAt: event.payload.initializedAt
          }
        }
      };
      break;
    case "workflow.artifact.claimed": {
      const progress = requireWorkflowProgress(projection.workflowProgress);
      const module = ensureWorkflowModule(
        progress,
        event.payload.moduleId,
        event.payload.workflowCycle,
        event.payload.moduleAttempt,
        event.payload.assignmentId,
        event.payload.claimedAt
      );
      const reference: WorkflowArtifactReference = {
        path: event.payload.artifactPath,
        format: event.payload.artifactFormat,
        digest: event.payload.artifactDigest,
        sourceResultId: event.payload.sourceResultId
      };
      module.artifactReferences = dedupeArtifactReferences([
        ...module.artifactReferences,
        reference
      ]);
      break;
    }
    case "workflow.gate.recorded": {
      const progress = requireWorkflowProgress(projection.workflowProgress);
      const module = ensureWorkflowModule(
        progress,
        event.payload.moduleId,
        event.payload.workflowCycle,
        event.payload.moduleAttempt,
        event.payload.assignmentId,
        event.payload.evaluatedAt
      );
      module.moduleState = event.payload.moduleState;
      module.gateOutcome = event.payload.gateOutcome;
      module.sourceResultIds = [...event.payload.sourceResultIds];
      module.sourceDecisionIds = [...event.payload.sourceDecisionIds];
      if (event.payload.evidenceSummary) {
        module.evidenceSummary = event.payload.evidenceSummary;
      } else {
        delete module.evidenceSummary;
      }
      if (event.payload.checklistStatus) {
        module.checklistStatus = event.payload.checklistStatus;
      } else {
        delete module.checklistStatus;
      }
      module.artifactReferences = event.payload.artifactReferences.map((reference) => ({
        ...reference
      }));
      module.evaluatedAt = event.payload.evaluatedAt;
      progress.lastGate = {
        moduleId: event.payload.moduleId,
        workflowCycle: event.payload.workflowCycle,
        moduleAttempt: event.payload.moduleAttempt,
        assignmentId: event.payload.assignmentId,
        gateOutcome: event.payload.gateOutcome,
        sourceResultIds: [...event.payload.sourceResultIds],
        sourceDecisionIds: [...event.payload.sourceDecisionIds],
        artifactReferences: event.payload.artifactReferences.map((reference) => ({ ...reference })),
        evaluatedAt: event.payload.evaluatedAt,
        ...(event.payload.evidenceSummary ? { evidenceSummary: event.payload.evidenceSummary } : {}),
        ...(event.payload.checklistStatus
          ? { checklistStatus: event.payload.checklistStatus }
          : {})
      };
      break;
    }
    case "workflow.transition.applied": {
      const progress = requireWorkflowProgress(projection.workflowProgress);
      const previousModule = progress.modules[event.payload.fromModuleId];
      if (previousModule) {
        previousModule.moduleState = "completed";
      }
      progress.currentModuleId = event.payload.toModuleId;
      progress.workflowCycle = event.payload.workflowCycle;
      progress.currentAssignmentId = event.payload.nextAssignmentId;
      progress.currentModuleAttempt = event.payload.moduleAttempt;
      progress.lastTransition = {
        fromModuleId: event.payload.fromModuleId,
        toModuleId: event.payload.toModuleId,
        workflowCycle: event.payload.workflowCycle,
        moduleAttempt: event.payload.moduleAttempt,
        transition: event.payload.transition,
        previousAssignmentId: event.payload.previousAssignmentId,
        nextAssignmentId: event.payload.nextAssignmentId,
        appliedAt: event.payload.appliedAt
      };
      if (event.payload.transition === "complete") {
        const completedModule = ensureWorkflowModule(
          progress,
          event.payload.toModuleId,
          event.payload.workflowCycle,
          event.payload.moduleAttempt,
          event.payload.previousAssignmentId,
          event.payload.appliedAt
        );
        completedModule.assignmentId = event.payload.previousAssignmentId;
        completedModule.moduleState = "completed";
        completedModule.workflowCycle = event.payload.workflowCycle;
        completedModule.moduleAttempt = event.payload.moduleAttempt;
        break;
      }
      const nextModule = ensureWorkflowModule(
        progress,
        event.payload.toModuleId,
        event.payload.workflowCycle,
        event.payload.moduleAttempt,
        event.payload.nextAssignmentId,
        event.payload.appliedAt
      );
      resetNextWorkflowModule(
        nextModule,
        progress.lastGate,
        event.payload.transition,
        event.payload.nextAssignmentId,
        event.payload.workflowCycle,
        event.payload.moduleAttempt,
        event.payload.appliedAt
      );
      break;
    }
  }
}

export function syncWorkflowModuleState(
  projection: RuntimeProjection,
  assignmentId: string
): void {
  const progress = projection.workflowProgress;
  if (!progress || progress.currentAssignmentId !== assignmentId) {
    return;
  }
  const module = progress.modules[progress.currentModuleId];
  if (!module) {
    return;
  }
  const assignment = projection.assignments.get(assignmentId);
  if (!assignment) {
    return;
  }
  const openDecision = [...projection.decisions.values()].some(
    (decision) => decision.assignmentId === assignmentId && decision.state === "open"
  );
  module.assignmentId = assignmentId;
  module.workflowCycle = progress.workflowCycle;
  module.moduleAttempt = progress.currentModuleAttempt;
  module.moduleState = deriveActiveWorkflowModuleState(
    assignment.state,
    openDecision,
    progress.lastTransition,
    module
  );
}

function resetNextWorkflowModule(
  module: WorkflowModuleProgressRecord,
  previousGate: WorkflowLastGateRecord | undefined,
  transition: "advance" | "rerun_same_module" | "rewind",
  assignmentId: string | null,
  workflowCycle: number,
  moduleAttempt: number,
  enteredAt: string
): void {
  module.assignmentId = assignmentId;
  module.workflowCycle = workflowCycle;
  module.moduleAttempt = moduleAttempt;
  module.moduleState = "queued";
  module.sourceResultIds = [];
  module.sourceDecisionIds = [];
  module.artifactReferences = [];
  module.enteredAt = enteredAt;
  delete module.evaluatedAt;
  delete module.checklistStatus;
  delete module.evidenceSummary;
  if (transition === "rerun_same_module" && previousGate?.gateOutcome) {
    module.gateOutcome = previousGate.gateOutcome;
  } else {
    delete module.gateOutcome;
  }
}
