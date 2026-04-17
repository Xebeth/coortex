import { isWrappedResumeCapableAttachment } from "../core/types.js";
import type {
  AssignmentClaim,
  RuntimeAttachment,
  RuntimeProjection
} from "../core/types.js";

export interface AttachmentClaimBinding {
  attachment: RuntimeAttachment;
  claim: AssignmentClaim;
}

const AUTHORITATIVE_ATTACHMENT_STATES = new Set<RuntimeAttachment["state"]>([
  "attached",
  "detached_resumable"
]);

const RESUMABLE_ATTACHMENT_STATES = new Set<RuntimeAttachment["state"]>([
  "attached",
  "detached_resumable"
]);

export function getActiveClaimForAssignment(
  projection: RuntimeProjection,
  assignmentId: string
): AttachmentClaimBinding | undefined {
  return listActiveClaimBindings(projection).find(({ claim }) => claim.assignmentId === assignmentId);
}

export function listActiveClaimBindings(
  projection: RuntimeProjection
): AttachmentClaimBinding[] {
  assertUniqueActiveClaims(projection);
  return [...projection.claims.values()]
    .filter((claim) => claim.state === "active")
    .flatMap((claim) => {
      const attachment = projection.attachments.get(claim.attachmentId);
      return attachment ? [{ attachment, claim }] : [];
    });
}

export function listAuthoritativeAttachmentClaims(
  projection: RuntimeProjection
): AttachmentClaimBinding[] {
  return listActiveClaimBindings(projection).filter(({ attachment }) =>
    AUTHORITATIVE_ATTACHMENT_STATES.has(attachment.state)
  );
}

export function listResumableAttachmentClaims(
  projection: RuntimeProjection
): AttachmentClaimBinding[] {
  return listActiveClaimBindings(projection).filter(({ attachment }) =>
    RESUMABLE_ATTACHMENT_STATES.has(attachment.state) &&
    isWrappedResumeCapableAttachment(attachment)
  );
}

export function listProvisionalAttachmentClaims(
  projection: RuntimeProjection
): AttachmentClaimBinding[] {
  return listActiveClaimBindings(projection).filter(({ attachment }) => attachment.state === "provisional");
}

function assertUniqueActiveClaims(projection: RuntimeProjection): void {
  const activeClaimsByAssignment = new Map<string, string[]>();
  for (const claim of projection.claims.values()) {
    if (claim.state !== "active") {
      continue;
    }
    activeClaimsByAssignment.set(claim.assignmentId, [
      ...(activeClaimsByAssignment.get(claim.assignmentId) ?? []),
      claim.id
    ]);
  }
  const duplicates = [...activeClaimsByAssignment.entries()].filter(([, ids]) => ids.length > 1);
  if (duplicates.length === 0) {
    return;
  }
  throw new Error(
    `Invalid runtime state: multiple active claims are present (${duplicates
      .map(([assignmentId, ids]) => `${assignmentId}: ${ids.join(", ")}`)
      .join("; ")}).`
  );
}
