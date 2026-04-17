import { randomUUID } from "node:crypto";

import type {
  HostAdapter,
  HostExecutionOutcome,
  HostSessionIdentity
} from "../adapters/contract.js";
import { COORTEX_RECLAIM_LEASE_KEY } from "../core/run-state.js";
import type { RuntimeEvent } from "../core/events.js";
import type {
  AssignmentClaim,
  HostRunRecord,
  RuntimeAttachment,
  RuntimeAuthorityProvenance,
  RuntimeProjection
} from "../core/types.js";
import { RuntimeStore } from "../persistence/store.js";
import { nowIso } from "../utils/time.js";

import { getActiveClaimForAssignment } from "../projections/attachment-claim-queries.js";
import { cleanupHostRunArtifactsWithLeaseVerification } from "./host-run-cleanup.js";
import { persistProjectionEvents, type ProjectionWriteOptions } from "./projection-write.js";
import type { CommandDiagnostic } from "./types.js";
import { diagnosticsFromWarning } from "./runtime-state.js";

function buildAuthorityProvenance(
  kind: RuntimeAuthorityProvenance["kind"]
): RuntimeAuthorityProvenance {
  switch (kind) {
    case "launch":
      return { kind, source: "ctx.run" };
    case "resume":
      return { kind, source: "ctx.resume" };
    case "recovery":
      return { kind, source: "recovery.reconcile" };
  }
}

function sanitizeAttachmentAdapterMetadata(
  adapterData?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!adapterData) {
    return undefined;
  }
  const entries = Object.entries(adapterData).filter(
    ([key]) => key !== COORTEX_RECLAIM_LEASE_KEY
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

async function updateAttachmentState(
  store: RuntimeStore,
  projection: RuntimeProjection,
  attachmentId: string,
  patch: Partial<RuntimeAttachment>,
  options: ProjectionWriteOptions | undefined,
  activation?: {
    kind: "launch" | "resume";
    attachmentId: string;
    assignmentId: string;
  }
): Promise<RuntimeProjection> {
  const timestamp = nowIso();
  const events: RuntimeEvent[] = [
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "attachment.updated",
      payload: {
        attachmentId,
        patch
      }
    }
  ];
  if (activation) {
    const activeBinding = getActiveClaimForAssignment(projection, activation.assignmentId);
    if (activeBinding?.attachment.id === attachmentId) {
      events.push({
        eventId: randomUUID(),
        sessionId: projection.sessionId,
        timestamp,
        type: "claim.updated",
        payload: {
          claimId: activeBinding.claim.id,
          patch: {
            provenance: buildAuthorityProvenance(activation.kind)
          }
        }
      });
    }
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "runtime.activated",
      payload: activation
    });
  }
  return (await persistProjectionEvents(store, projection, events, options)).projection;
}

function buildRecoveredAuthorityRepairEvents(
  projection: RuntimeProjection,
  assignmentId: string,
  repair:
    | {
        kind: "release";
        attachmentReason: string;
        claimReason: string;
      }
    | {
        kind: "orphan";
        attachmentReason: string;
        claimReason: string;
      },
  timestamp: string
): RuntimeEvent[] {
  const activeBinding = getActiveClaimForAssignment(projection, assignmentId);
  if (!activeBinding) {
    return [];
  }

  return [
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "attachment.updated",
      payload: {
        attachmentId: activeBinding.attachment.id,
        patch:
          repair.kind === "release"
            ? {
                state: "released",
                updatedAt: timestamp,
                releasedAt: timestamp,
                releasedReason: repair.attachmentReason
              }
            : {
                state: "orphaned",
                updatedAt: timestamp,
                orphanedAt: timestamp,
                orphanedReason: repair.attachmentReason
              }
      }
    },
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "claim.updated",
      payload: {
        claimId: activeBinding.claim.id,
        patch:
          repair.kind === "release"
            ? {
                state: "released",
                updatedAt: timestamp,
                releasedAt: timestamp,
                releasedReason: repair.claimReason
              }
            : {
                state: "orphaned",
                updatedAt: timestamp,
                orphanedAt: timestamp,
                orphanedReason: repair.claimReason
              }
      }
    }
  ];
}

function buildRecoveredDetachedAuthorityRepairEvents(
  projection: RuntimeProjection,
  record: HostRunRecord,
  assignmentId: string,
  timestamp: string
): RuntimeEvent[] {
  const activeBinding = getActiveClaimForAssignment(projection, assignmentId);
  if (!activeBinding) {
    return [];
  }

  const recoveredNativeSessionId =
    typeof record.adapterData?.nativeRunId === "string" && record.adapterData.nativeRunId.length > 0
      ? record.adapterData.nativeRunId
      : activeBinding.attachment.nativeSessionId;
  const adapterMetadata = sanitizeAttachmentAdapterMetadata(record.adapterData);
  const detachRepair: {
    kind: "detach";
    provenanceKind: "recovery";
    nativeSessionId?: string;
    adapterMetadata?: Record<string, unknown>;
    missingIdentityReason: {
      attachment: string;
      claim: string;
    };
  } = {
    kind: "detach",
    provenanceKind: "recovery",
    missingIdentityReason: {
      attachment:
        "Recovered completed assignment could not prove a durable native session identity for resumable authority.",
      claim:
        "Recovered completed assignment could not prove a durable native session identity for resumable authority."
    }
  };
  if (recoveredNativeSessionId) {
    detachRepair.nativeSessionId = recoveredNativeSessionId;
  }
  if (adapterMetadata) {
    detachRepair.adapterMetadata = adapterMetadata;
  }
  return AttachmentLifecycleService.buildAuthorityFinalizationEvents(
    projection,
    assignmentId,
    detachRepair,
    timestamp
  );
}

export const AttachmentLifecycleService = {
  createLaunchAuthority(
    adapter: HostAdapter,
    assignmentId: string
  ): {
    attachment: RuntimeAttachment;
    claim: AssignmentClaim;
  } {
    const timestamp = nowIso();
    const attachmentId = randomUUID();
    return {
      attachment: {
        id: attachmentId,
        adapter: adapter.id,
        host: adapter.host,
        state: "provisional",
        createdAt: timestamp,
        updatedAt: timestamp,
        provenance: buildAuthorityProvenance("launch")
      },
      claim: {
        id: randomUUID(),
        assignmentId,
        attachmentId,
        state: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        provenance: buildAuthorityProvenance("launch")
      }
    };
  },

  async persistAttachmentAuthority(
    store: RuntimeStore,
    projection: RuntimeProjection,
    attachment: RuntimeAttachment,
    claim: AssignmentClaim,
    options?: ProjectionWriteOptions
  ): Promise<RuntimeProjection> {
    const timestamp = nowIso();
    return (
      await persistProjectionEvents(
        store,
        projection,
        [
          {
            eventId: randomUUID(),
            sessionId: projection.sessionId,
            timestamp,
            type: "attachment.created",
            payload: { attachment }
          },
          {
            eventId: randomUUID(),
            sessionId: projection.sessionId,
            timestamp,
            type: "claim.created",
            payload: { claim }
          }
        ],
        options
      )
    ).projection;
  },

  async transitionAttachmentClaim(
    store: RuntimeStore,
    projection: RuntimeProjection,
    attachmentId: string,
    claimId: string,
    patch: {
      attachment: Partial<RuntimeAttachment>;
      claim: Partial<AssignmentClaim>;
    },
    options?: ProjectionWriteOptions
  ): Promise<RuntimeProjection> {
    const timestamp = nowIso();
    return (
      await persistProjectionEvents(
        store,
        projection,
        [
          {
            eventId: randomUUID(),
            sessionId: projection.sessionId,
            timestamp,
            type: "attachment.updated",
            payload: {
              attachmentId,
              patch: patch.attachment
            }
          },
          {
            eventId: randomUUID(),
            sessionId: projection.sessionId,
            timestamp,
            type: "claim.updated",
            payload: {
              claimId,
              patch: patch.claim
            }
          }
        ],
        options
      )
    ).projection;
  },

  async updateAttachmentToDetachedResumable(
    store: RuntimeStore,
    projection: RuntimeProjection,
    attachmentId: string,
    options?: ProjectionWriteOptions,
    detachedAt = nowIso(),
    repair?: {
      claimId?: string;
      provenanceKind?: RuntimeAuthorityProvenance["kind"];
      nativeSessionId?: string;
    }
  ): Promise<RuntimeProjection> {
    const events: RuntimeEvent[] = [
      {
        eventId: randomUUID(),
        sessionId: projection.sessionId,
        timestamp: detachedAt,
        type: "attachment.updated",
        payload: {
          attachmentId,
          patch: {
            state: "detached_resumable",
            updatedAt: detachedAt,
            detachedAt,
            ...(repair?.nativeSessionId ? { nativeSessionId: repair.nativeSessionId } : {}),
            ...(repair?.provenanceKind
              ? { provenance: buildAuthorityProvenance(repair.provenanceKind) }
              : {})
          }
        }
      }
    ];
    if (repair?.claimId && repair.provenanceKind) {
      events.push({
        eventId: randomUUID(),
        sessionId: projection.sessionId,
        timestamp: detachedAt,
        type: "claim.updated",
        payload: {
          claimId: repair.claimId,
          patch: {
            provenance: buildAuthorityProvenance(repair.provenanceKind)
          }
        }
      });
    }
    return (await persistProjectionEvents(store, projection, events, options)).projection;
  },

  async releaseAttachmentClaim(
    store: RuntimeStore,
    projection: RuntimeProjection,
    attachmentId: string,
    claimId: string,
    reason: {
      attachment: string;
      claim: string;
    },
    options?: ProjectionWriteOptions
  ): Promise<RuntimeProjection> {
    const timestamp = nowIso();
    return AttachmentLifecycleService.transitionAttachmentClaim(
      store,
      projection,
      attachmentId,
      claimId,
      {
        attachment: {
          state: "released",
          updatedAt: timestamp,
          releasedAt: timestamp,
          releasedReason: reason.attachment
        },
        claim: {
          state: "released",
          updatedAt: timestamp,
          releasedAt: timestamp,
          releasedReason: reason.claim
        }
      },
      options
    );
  },

  async orphanAttachmentClaim(
    store: RuntimeStore,
    projection: RuntimeProjection,
    attachmentId: string,
    claimId: string,
    reason: {
      attachment: string;
      claim: string;
    },
    options?: ProjectionWriteOptions
  ): Promise<RuntimeProjection> {
    const timestamp = nowIso();
    return AttachmentLifecycleService.transitionAttachmentClaim(
      store,
      projection,
      attachmentId,
      claimId,
      {
        attachment: {
          state: "orphaned",
          updatedAt: timestamp,
          orphanedAt: timestamp,
          orphanedReason: reason.attachment
        },
        claim: {
          state: "orphaned",
          updatedAt: timestamp,
          orphanedAt: timestamp,
          orphanedReason: reason.claim
        }
      },
      options
    );
  },

  async activateAttachmentSession(
    store: RuntimeStore,
    projection: RuntimeProjection,
    attachmentId: string,
    assignmentId: string,
    kind: "launch" | "resume",
    identity: HostSessionIdentity,
    options?: ProjectionWriteOptions
  ): Promise<RuntimeProjection> {
    const timestamp = nowIso();
    const existingAttachment = projection.attachments.get(attachmentId);
    const adapterMetadata =
      identity.metadata || existingAttachment?.adapterMetadata
        ? {
            ...(existingAttachment?.adapterMetadata ?? {}),
            ...(identity.metadata ?? {})
          }
        : undefined;

    return updateAttachmentState(
      store,
      projection,
      attachmentId,
      {
        state: "attached",
        updatedAt: timestamp,
        attachedAt: timestamp,
        nativeSessionId: identity.nativeSessionId,
        provenance: buildAuthorityProvenance(kind),
        ...(adapterMetadata ? { adapterMetadata } : {})
      },
      options,
      {
        kind,
        attachmentId,
        assignmentId
      }
    );
  },

  authorityFinalizationDispositionForOutcome(
    outcome: HostExecutionOutcome["outcome"] | NonNullable<HostRunRecord["terminalOutcome"]>
  ): "release" | "detach" {
    if (outcome.kind !== "result") {
      return "detach";
    }

    const status = "capture" in outcome ? outcome.capture.status : outcome.result.status;
    return status === "completed" || status === "failed" ? "release" : "detach";
  },

  buildRequeueAssignmentEvents(
    projection: RuntimeProjection,
    assignmentId: string,
    objective: string,
    timestamp: string
  ): RuntimeEvent[] {
    return [
      {
        eventId: randomUUID(),
        sessionId: projection.sessionId,
        timestamp,
        type: "assignment.updated",
        payload: {
          assignmentId,
          patch: {
            state: "queued",
            updatedAt: timestamp
          }
        }
      },
      {
        eventId: randomUUID(),
        sessionId: projection.sessionId,
        timestamp,
        type: "status.updated",
        payload: {
          status: {
            ...projection.status,
            currentObjective: `Retry assignment ${assignmentId}: ${objective}`,
            lastDurableOutputAt: timestamp,
            resumeReady: true
          }
        }
      }
    ];
  },

  async requeueAssignmentForRetry(
    store: RuntimeStore,
    projection: RuntimeProjection,
    assignmentId: string,
    objective: string,
    options?: ProjectionWriteOptions
  ): Promise<RuntimeProjection> {
    const timestamp = nowIso();
    return (
      await persistProjectionEvents(
        store,
        projection,
        AttachmentLifecycleService.buildRequeueAssignmentEvents(
          projection,
          assignmentId,
          objective,
          timestamp
        ),
        options
      )
    ).projection;
  },

  async orphanAttachmentClaimAndRequeue(
    store: RuntimeStore,
    adapter: HostAdapter,
    projection: RuntimeProjection,
    attachment: RuntimeAttachment,
    claim: AssignmentClaim,
    reason: string,
    options?: ProjectionWriteOptions
  ): Promise<{
    projection: RuntimeProjection;
    diagnostics: CommandDiagnostic[];
  }> {
    const timestamp = nowIso();
    let effectiveProjection = await AttachmentLifecycleService.orphanAttachmentClaim(
      store,
      projection,
      attachment.id,
      claim.id,
      {
        attachment: reason,
        claim: reason
      },
      options
    );
    const diagnostics: CommandDiagnostic[] = [];
    const cleanupError = await cleanupHostRunArtifactsWithLeaseVerification(
      store,
      adapter,
      claim.assignmentId,
      {
        staleAt: timestamp,
        staleReason: reason
      }
    );
    if (cleanupError) {
      diagnostics.push(
        ...diagnosticsFromWarning(
          `Host run cleanup artifacts could not be updated for assignment ${claim.assignmentId}. ${cleanupError.message}`,
          "host-run-persist-failed"
        )
      );
    }
    const assignment = effectiveProjection.assignments.get(claim.assignmentId);
    if (assignment) {
      effectiveProjection = await AttachmentLifecycleService.requeueAssignmentForRetry(
        store,
        effectiveProjection,
        claim.assignmentId,
        assignment.objective,
        options
      );
    }
    return {
      projection: effectiveProjection,
      diagnostics
    };
  },

  buildAuthorityFinalizationEvents(
    projection: RuntimeProjection,
    assignmentId: string,
    repair:
      | {
          kind: "release";
          attachmentReason: string;
          claimReason: string;
        }
      | {
          kind: "orphan";
          attachmentReason: string;
          claimReason: string;
        }
      | {
          kind: "detach";
          provenanceKind: RuntimeAuthorityProvenance["kind"];
          nativeSessionId?: string;
          adapterMetadata?: Record<string, unknown>;
          missingIdentityReason?: {
            attachment: string;
            claim: string;
          };
        },
    timestamp: string
  ): RuntimeEvent[] {
    if (repair.kind === "release" || repair.kind === "orphan") {
      return buildRecoveredAuthorityRepairEvents(projection, assignmentId, repair, timestamp);
    }

    const activeBinding = getActiveClaimForAssignment(projection, assignmentId);
    if (!activeBinding) {
      return [];
    }

    if (activeBinding.attachment.state === "detached_resumable") {
      const patch: Partial<RuntimeAttachment> = {
        updatedAt: timestamp,
        provenance: buildAuthorityProvenance(repair.provenanceKind)
      };
      if (!activeBinding.attachment.nativeSessionId && repair.nativeSessionId) {
        patch.nativeSessionId = repair.nativeSessionId;
      }
      if (repair.adapterMetadata) {
        patch.adapterMetadata = repair.adapterMetadata;
      }
      const events: RuntimeEvent[] =
        Object.keys(patch).length > 1
          ? [
              {
                eventId: randomUUID(),
                sessionId: projection.sessionId,
                timestamp,
                type: "attachment.updated",
                payload: {
                  attachmentId: activeBinding.attachment.id,
                  patch
                }
              }
            ]
          : [];
      events.push({
        eventId: randomUUID(),
        sessionId: projection.sessionId,
        timestamp,
        type: "claim.updated",
        payload: {
          claimId: activeBinding.claim.id,
          patch: {
            provenance: buildAuthorityProvenance(repair.provenanceKind)
          }
        }
      });
      return events;
    }

    if (activeBinding.attachment.state === "provisional" && !repair.nativeSessionId) {
      return repair.missingIdentityReason
        ? buildRecoveredAuthorityRepairEvents(
            projection,
            assignmentId,
            {
              kind: "orphan",
              attachmentReason: repair.missingIdentityReason.attachment,
              claimReason: repair.missingIdentityReason.claim
            },
            timestamp
          )
        : [];
    }

    return [
      {
        eventId: randomUUID(),
        sessionId: projection.sessionId,
        timestamp,
        type: "attachment.updated",
        payload: {
          attachmentId: activeBinding.attachment.id,
          patch: {
            state: "detached_resumable",
            updatedAt: timestamp,
            detachedAt: timestamp,
            provenance: buildAuthorityProvenance(repair.provenanceKind),
            ...(repair.nativeSessionId ? { nativeSessionId: repair.nativeSessionId } : {}),
            ...(repair.adapterMetadata ? { adapterMetadata: repair.adapterMetadata } : {})
          }
        }
      },
      {
        eventId: randomUUID(),
        sessionId: projection.sessionId,
        timestamp,
        type: "claim.updated",
        payload: {
          claimId: activeBinding.claim.id,
          patch: {
            provenance: buildAuthorityProvenance(repair.provenanceKind)
          }
        }
      }
    ];
  },

  async finalizeAttachmentAuthority(
    store: RuntimeStore,
    projection: RuntimeProjection,
    attachmentId: string,
    claimId: string,
    execution: Pick<HostExecutionOutcome, "outcome" | "run">,
    provenanceKind: "launch" | "resume" | "recovery",
    verifiedNativeSessionId: string | undefined,
    options?: ProjectionWriteOptions,
    detachedAt?: string
  ): Promise<RuntimeProjection> {
    const claim = projection.claims.get(claimId);
    const attachment = projection.attachments.get(attachmentId);
    if (!claim || claim.attachmentId !== attachmentId) {
      throw new Error(`Cannot finalize missing active claim ${claimId} for attachment ${attachmentId}.`);
    }
    const detachedNativeSessionId =
      verifiedNativeSessionId ??
      (typeof execution.run.adapterData?.nativeRunId === "string"
        ? execution.run.adapterData.nativeRunId
        : attachment?.nativeSessionId);
    const finalizationEvents = AttachmentLifecycleService.buildAuthorityFinalizationEvents(
      projection,
      claim.assignmentId,
      AttachmentLifecycleService.authorityFinalizationDispositionForOutcome(execution.outcome) ===
        "release"
        ? {
            kind: "release",
            attachmentReason:
              execution.outcome.kind === "result"
                ? `Assignment finished with ${execution.outcome.capture.status}.`
                : "Assignment completed with a decision.",
            claimReason: "Assignment finished."
          }
        : {
            kind: "detach",
            provenanceKind,
            ...(detachedNativeSessionId ? { nativeSessionId: detachedNativeSessionId } : {}),
            missingIdentityReason: {
              attachment: "Wrapped launch completed without native session identity finalization.",
              claim: "Wrapped launch completed without native session identity finalization."
            }
          },
      detachedAt ?? nowIso()
    );
    if (finalizationEvents.length === 0) {
      return projection;
    }
    return (await persistProjectionEvents(store, projection, finalizationEvents, options)).projection;
  },

  buildCompletedAuthorityRepairEvents(
    projection: RuntimeProjection,
    record: HostRunRecord,
    timestamp: string
  ): RuntimeEvent[] {
    if (!record.terminalOutcome) {
      return [];
    }

    if (
      AttachmentLifecycleService.authorityFinalizationDispositionForOutcome(record.terminalOutcome) ===
      "detach"
    ) {
      return buildRecoveredDetachedAuthorityRepairEvents(
        projection,
        record,
        record.assignmentId,
        timestamp
      );
    }

    return buildRecoveredAuthorityRepairEvents(
      projection,
      record.assignmentId,
      {
        kind: "release",
        attachmentReason:
          record.terminalOutcome.kind === "result"
            ? `Recovered completed assignment finished with ${record.terminalOutcome.result.status}.`
            : "Recovered completed assignment finished with a decision.",
        claimReason: "Recovered completed assignment finished."
      },
      timestamp
    );
  },

  buildStaleAuthorityRepairEvents(
    projection: RuntimeProjection,
    assignmentId: string,
    timestamp: string
  ): RuntimeEvent[] {
    return buildRecoveredAuthorityRepairEvents(
      projection,
      assignmentId,
      {
        kind: "orphan",
        attachmentReason: "Stale host run was requeued for retry.",
        claimReason: "Stale host run was requeued for retry."
      },
      timestamp
    );
  },

  async promoteProvisionalAttachment(
    store: RuntimeStore,
    projection: RuntimeProjection,
    attachmentId: string,
    claimId: string,
    nativeSessionId: string,
    adapterData: Record<string, unknown> | undefined,
    options?: ProjectionWriteOptions
  ): Promise<RuntimeProjection> {
    const adapterMetadata = sanitizeAttachmentAdapterMetadata(adapterData);
    return AttachmentLifecycleService.transitionAttachmentClaim(
      store,
      projection,
      attachmentId,
      claimId,
      {
        attachment: {
          state: "detached_resumable",
          updatedAt: nowIso(),
          detachedAt: nowIso(),
          provenance: buildAuthorityProvenance("recovery"),
          nativeSessionId,
          ...(adapterMetadata ? { adapterMetadata } : {})
        },
        claim: {
          updatedAt: nowIso(),
          provenance: buildAuthorityProvenance("recovery")
        }
      },
      options
    );
  }
};
