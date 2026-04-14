import type { WorkflowArtifactReference, WorkflowProgressRecord } from "../../core/types.js";
import type { WorkflowModuleDefinition } from "../types.js";
import { getExplicitRuntimeArtifactReferences } from "../artifact-references.js";

export const reviewWorkflowModule: WorkflowModuleDefinition = {
  id: "review",
  createAssignment(context) {
    return {
      workflow: context.workflowId,
      ownerType: "host",
      ownerId: context.adapterId,
      objective: "Assess the latest accepted plan artifact carried into the current cycle and produce a review verdict.",
      writeScope: [...context.inheritedWriteScope],
      requiredOutputs: ["verdict", "rationaleSummary"],
      state: "queued"
    };
  },
  getReadArtifacts(progress) {
    return getAcceptedPlanArtifacts(progress).map((reference) => reference.path);
  },
  evaluateGate(context) {
    const payload = context.artifact?.document.payload;
    const verdict =
      typeof payload?.verdict === "string" ? payload.verdict.trim() : "";
    const rationaleSummary =
      typeof payload?.rationaleSummary === "string"
        ? payload.rationaleSummary.trim()
        : "";
    const validVerdict =
      verdict === "approved" || verdict === "rejected" || verdict === "needs_iteration";
    const checklistStatus =
      validVerdict && rationaleSummary.length > 0 ? "complete" : "incomplete";
    const acceptedPlanArtifacts = getAcceptedPlanArtifacts(context.progress);
    const artifactReferences = [
      ...(context.artifact ? [context.artifact.reference] : []),
      ...getExplicitRuntimeArtifactReferences(context.artifact),
      ...acceptedPlanArtifacts
    ];
    const ready =
      context.result.status === "completed" &&
      validVerdict &&
      checklistStatus === "complete" &&
      acceptedPlanArtifacts.length > 0 &&
      Boolean(context.artifact);

    return {
      gateOutcome: ready ? (verdict as "approved" | "rejected" | "needs_iteration") : "blocked",
      checklistStatus,
      sourceResultIds: [context.result.resultId],
      sourceDecisionIds: [],
      artifactReferences,
      ...(rationaleSummary ? { evidenceSummary: rationaleSummary } : {}),
      transition: {
        type: !ready
          ? "rerun_same_module"
          : verdict === "approved"
            ? "advance"
            : "rewind",
        toModuleId: !ready ? "review" : verdict === "approved" ? "verify" : "plan",
        workflowCycle:
          ready && verdict !== "approved" ? context.progress.workflowCycle + 1 : context.progress.workflowCycle
      }
    };
  }
};

function getAcceptedPlanArtifacts(progress: WorkflowProgressRecord): WorkflowArtifactReference[] {
  const planState = progress.modules.plan;
  if (
    !planState ||
    planState.workflowCycle > progress.workflowCycle ||
    planState.moduleState !== "completed" ||
    planState.gateOutcome !== "ready_for_review"
  ) {
    return [];
  }
  return planState.artifactReferences.map((reference: WorkflowArtifactReference) => ({ ...reference }));
}
