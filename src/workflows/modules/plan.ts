import type { WorkflowModuleDefinition } from "../types.js";
import { getExplicitRuntimeArtifactReferences } from "../artifact-references.js";

export const planWorkflowModule: WorkflowModuleDefinition = {
  id: "plan",
  createAssignment(context) {
    return {
      workflow: context.workflowId,
      ownerType: "host",
      ownerId: context.adapterId,
      objective: "Produce the cycle plan artifact and review-ready evidence for the current workflow objective.",
      writeScope: [...context.inheritedWriteScope],
      requiredOutputs: ["planSummary", "implementationSteps", "reviewEvidenceSummary"],
      state: "queued"
    };
  },
  getReadArtifacts() {
    return [];
  },
  evaluateGate(context) {
    const payload = context.artifact?.document.payload;
    const planSummary = typeof payload?.planSummary === "string" ? payload.planSummary.trim() : "";
    const implementationSteps = Array.isArray(payload?.implementationSteps)
      ? payload.implementationSteps.filter((step): step is string => typeof step === "string" && step.trim().length > 0)
      : typeof payload?.implementationSteps === "string" && payload.implementationSteps.trim().length > 0
        ? [payload.implementationSteps.trim()]
        : [];
    const reviewEvidenceSummary =
      typeof payload?.reviewEvidenceSummary === "string"
        ? payload.reviewEvidenceSummary.trim()
        : "";
    const checklistStatus =
      planSummary.length > 0 && implementationSteps.length > 0 && reviewEvidenceSummary.length > 0
        ? "complete"
        : "incomplete";
    const ready =
      context.result.status === "completed" &&
      checklistStatus === "complete" &&
      Boolean(context.artifact);

    return {
      gateOutcome: ready ? "ready_for_review" : "blocked",
      checklistStatus,
      sourceResultIds: [context.result.resultId],
      sourceDecisionIds: [],
      artifactReferences: [
        ...(context.artifact ? [context.artifact.reference] : []),
        ...getExplicitRuntimeArtifactReferences(context.artifact)
      ],
      ...(reviewEvidenceSummary ? { evidenceSummary: reviewEvidenceSummary } : {}),
      transition: {
        type: ready ? "advance" : "rerun_same_module",
        toModuleId: ready ? "review" : "plan",
        workflowCycle: context.progress.workflowCycle
      }
    };
  }
};
