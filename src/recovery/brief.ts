import {
  isWrappedResumeCapableAttachment,
  type RecoveryBrief,
  type RuntimeProjection
} from "../core/types.js";

export interface RecoveryBriefOptions {
  allowAttachmentResumeAction?: boolean;
}

export function buildRecoveryBrief(
  projection: RuntimeProjection,
  options: RecoveryBriefOptions = {}
): RecoveryBrief {
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
    nextRequiredAction: determineNextAction(projection, activeAssignments, unresolvedDecisions, options),
    generatedAt: deriveGeneratedAt(projection)
  };
}

function determineNextAction(
  projection: RuntimeProjection,
  activeAssignments: RecoveryBrief["activeAssignments"],
  unresolvedDecisions: RecoveryBrief["unresolvedDecisions"],
  options: RecoveryBriefOptions
): string {
  const allowAttachmentResumeAction = options.allowAttachmentResumeAction ?? true;
  const resumableClaim = [...projection.claims.values()].find((claim) => {
    if (claim.state !== "active") {
      return false;
    }
    const attachment = projection.attachments.get(claim.attachmentId);
    return !!attachment && isWrappedResumeCapableAttachment(attachment);
  });
  if (allowAttachmentResumeAction && resumableClaim) {
    const attachment = projection.attachments.get(resumableClaim.attachmentId);
    return `Resume attachment ${resumableClaim.attachmentId} for assignment ${resumableClaim.assignmentId}${
      attachment?.nativeSessionId ? ` (${attachment.nativeSessionId})` : ""
    }.`;
  }
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
    ),
    ...[...projection.attachments.values()].flatMap((attachment) => [
      attachment.createdAt,
      attachment.updatedAt,
      attachment.attachedAt ?? "",
      attachment.detachedAt ?? "",
      attachment.releasedAt ?? "",
      attachment.orphanedAt ?? ""
    ]),
    ...[...projection.claims.values()].flatMap((claim) => [
      claim.createdAt,
      claim.updatedAt,
      claim.releasedAt ?? "",
      claim.orphanedAt ?? ""
    ]),
    projection.provenance.initializedAt ?? "",
    projection.provenance.hostSetupAt ?? "",
    projection.provenance.lastActivation?.at ?? ""
  ].filter((value) => value.length > 0);

  return timestamps.sort().at(-1) ?? "";
}
