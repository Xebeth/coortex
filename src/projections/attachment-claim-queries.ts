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

export function assertUniqueActiveClaims(projection: RuntimeProjection): void {
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

export function selectSingleAuthoritativeAttachmentClaim(
  projection: RuntimeProjection
): AttachmentClaimBinding | undefined {
  return selectSingleAttachmentClaimBinding(
    listAuthoritativeAttachmentClaims(projection),
    "authoritative"
  );
}

export function selectSingleResumableAttachmentClaim(
  projection: RuntimeProjection
): AttachmentClaimBinding | undefined {
  return selectSingleAttachmentClaimBinding(listResumableAttachmentClaims(projection), "resumable");
}

function selectSingleAttachmentClaimBinding(
  bindings: AttachmentClaimBinding[],
  label: "authoritative" | "resumable"
): AttachmentClaimBinding | undefined {
  if (bindings.length <= 1) {
    return bindings[0];
  }
  throw new Error(
    `Invalid runtime state: multiple ${label} attachments are present (${bindings
      .map(({ attachment }) => attachment.id)
      .join(", ")}).`
  );
}
