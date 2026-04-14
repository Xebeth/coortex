import type { WorkflowArtifactReference, WorkflowProgressRecord } from "../../core/types.js";
import type { WorkflowModuleDefinition } from "../types.js";
import { getExplicitRuntimeArtifactReferences } from "../artifact-references.js";

export const verifyWorkflowModule: WorkflowModuleDefinition = {
  id: "verify",
  createAssignment(context) {
    return {
      workflow: context.workflowId,
      ownerType: "host",
      ownerId: context.adapterId,
      objective: "Verify the latest approved review state against current-cycle durable evidence.",
      writeScope: [...context.inheritedWriteScope],
      requiredOutputs: ["verdict", "verificationSummary", "evidenceResultIds"],
      state: "queued"
    };
  },
  getReadArtifacts(progress) {
    return getApprovedReviewArtifacts(progress).map((reference) => reference.path);
  },
  evaluateGate(context) {
    const payload = context.artifact?.document.payload;
    const verdict =
      typeof payload?.verdict === "string" ? payload.verdict.trim() : "";
    const verificationSummary =
      typeof payload?.verificationSummary === "string"
        ? payload.verificationSummary.trim()
        : "";
    const evidenceResultIds = Array.isArray(payload?.evidenceResultIds)
      ? payload.evidenceResultIds.filter(
          (resultId): resultId is string => typeof resultId === "string" && resultId.trim().length > 0
        )
      : [];
    const resolvedEvidence = evidenceResultIds
      .map((resultId) => context.projection.results.get(resultId))
      .filter((result): result is NonNullable<typeof result> => Boolean(result));
    const validVerdict = verdict === "verified" || verdict === "failed";
    const evidenceFresh = resolvedEvidence.length === evidenceResultIds.length &&
      resolvedEvidence.every((result) => result.createdAt >= context.currentCycleStartAt);
    const checklistStatus =
      validVerdict &&
      verificationSummary.length > 0 &&
      evidenceResultIds.length > 0 &&
      resolvedEvidence.length === evidenceResultIds.length
        ? "complete"
        : "incomplete";
    const approvedReviewArtifacts = getApprovedReviewArtifacts(context.progress);
    const artifactReferences = [
      ...(context.artifact ? [context.artifact.reference] : []),
      ...getExplicitRuntimeArtifactReferences(context.artifact)
    ];
    const ready =
      context.result.status === "completed" &&
      validVerdict &&
      checklistStatus === "complete" &&
      evidenceFresh &&
      approvedReviewArtifacts.length > 0 &&
      Boolean(context.artifact);

    return {
      gateOutcome: ready ? (verdict as "verified" | "failed") : "blocked",
      checklistStatus,
      sourceResultIds: [context.result.resultId, ...evidenceResultIds],
      sourceDecisionIds: [],
      artifactReferences,
      ...(verificationSummary ? { evidenceSummary: verificationSummary } : {}),
      transition: {
        type: !ready
          ? "rerun_same_module"
          : verdict === "verified"
            ? "complete"
            : "rewind",
        toModuleId: !ready ? "verify" : verdict === "verified" ? "verify" : "review",
        workflowCycle:
          ready && verdict === "failed" ? context.progress.workflowCycle + 1 : context.progress.workflowCycle
      }
    };
  }
};

function getApprovedReviewArtifacts(progress: WorkflowProgressRecord): WorkflowArtifactReference[] {
  const reviewState = progress.modules.review;
  if (
    !reviewState ||
    reviewState.workflowCycle !== progress.workflowCycle ||
    reviewState.moduleState !== "completed" ||
    reviewState.gateOutcome !== "approved"
  ) {
    return [];
  }
  return reviewState.artifactReferences.map((reference: WorkflowArtifactReference) => ({ ...reference }));
}
