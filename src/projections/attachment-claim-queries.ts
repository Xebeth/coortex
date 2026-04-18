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

export class RuntimeAuthorityIntegrityError extends Error {}

export function isRuntimeAuthorityIntegrityError(
  error: unknown
): error is RuntimeAuthorityIntegrityError {
  return error instanceof RuntimeAuthorityIntegrityError;
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

export function assertAttachmentClaimGraphIntegrity(projection: RuntimeProjection): void {
  assertUniqueActiveClaims(projection);

  const missingAttachments = [...projection.claims.values()].filter(
    (claim) => !projection.attachments.has(claim.attachmentId)
  );
  if (missingAttachments.length > 0) {
    throw new RuntimeAuthorityIntegrityError(
      `Invalid runtime state: claim graph references missing attachments (${missingAttachments
        .map((claim) => `${claim.id} -> ${claim.attachmentId}`)
        .join("; ")}).`
    );
  }

  const missingAssignments = [...projection.claims.values()].filter(
    (claim) => !projection.assignments.has(claim.assignmentId)
  );
  if (missingAssignments.length > 0) {
    throw new RuntimeAuthorityIntegrityError(
      `Invalid runtime state: claim graph references missing assignments (${missingAssignments
        .map((claim) => `${claim.id} -> ${claim.assignmentId}`)
        .join("; ")}).`
    );
  }
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
  throw new RuntimeAuthorityIntegrityError(
    `Invalid runtime state: multiple active claims are present (${duplicates
      .map(([assignmentId, ids]) => `${assignmentId}: ${ids.join(", ")}`)
      .join("; ")}).`
  );
}

export function listActiveClaimBindings(
  projection: RuntimeProjection
): AttachmentClaimBinding[] {
  assertAttachmentClaimGraphIntegrity(projection);
  return [...projection.claims.values()]
    .filter((claim) => claim.state === "active")
    .map((claim) => ({
      attachment: projection.attachments.get(claim.attachmentId)!,
      claim
    }));
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
