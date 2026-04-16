import { randomUUID } from "node:crypto";

import type {
  HostAdapter,
  HostExecutionOutcome,
  HostSessionResumeResult,
  HostSessionIdentity
} from "../adapters/contract.js";
import { COORTEX_RECLAIM_LEASE_KEY, isRunLeaseExpired } from "../core/run-state.js";
import type { RuntimeEvent } from "../core/events.js";
import { isWrappedResumeCapableAttachment } from "../core/types.js";
import type {
  AssignmentClaim,
  DecisionPacket,
  HostRunRecord,
  RuntimeAttachment,
  RuntimeAuthorityProvenance
} from "../core/types.js";
import { applyRuntimeEvent, fromSnapshot, toSnapshot } from "../projections/runtime-projection.js";
import { buildStaleRunReconciliation, createActiveRunDiagnostic, selectRunnableProjection } from "../recovery/host-runs.js";
import { recordNormalizedTelemetry } from "../telemetry/recorder.js";
import { nowIso } from "../utils/time.js";
import { RuntimeStore } from "../persistence/store.js";

import type { CommandDiagnostic } from "./types.js";
import { diagnosticsFromWarning, loadOperatorProjection, loadOperatorProjectionWithDiagnostics } from "./runtime-state.js";

interface AttachmentClaimBinding {
  attachment: RuntimeAttachment;
  claim: AssignmentClaim;
}

export interface ProjectionWriteOptions {
  snapshotFallback?: boolean;
}

export interface WrappedExecutionRecoveryResult {
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  execution?: HostExecutionOutcome;
  diagnostics: CommandDiagnostic[];
}

const AUTHORITATIVE_ATTACHMENT_STATES = new Set<RuntimeAttachment["state"]>([
  "attached",
  "detached_resumable"
]);

const RESUMABLE_ATTACHMENT_STATES = new Set<RuntimeAttachment["state"]>([
  "attached",
  "detached_resumable"
]);

function applyRuntimeEventsToProjection(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  events: RuntimeEvent[]
): Awaited<ReturnType<typeof loadOperatorProjection>> {
  const nextProjection = fromSnapshot(toSnapshot(projection));
  for (const event of events) {
    applyRuntimeEvent(nextProjection, event);
  }
  return nextProjection;
}

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

function assertUniqueActiveClaims(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>
): void {
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

export async function loadReconciledProjectionWithDiagnostics(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<{
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  diagnostics: CommandDiagnostic[];
  activeLeases: string[];
  hiddenActiveLeases: string[];
  snapshotFallback: boolean;
}> {
  const loaded = await loadOperatorProjectionWithDiagnostics(store);
  const reconciled = await reconcileActiveRuns(store, adapter, loaded.projection, {
    snapshotFallback: loaded.snapshotFallback
  });
  const hiddenActiveLeases = listHiddenActiveLeaseAssignments(
    reconciled.projection,
    reconciled.activeLeases
  );
  return {
    projection: reconciled.projection,
    diagnostics: [...loaded.diagnostics, ...reconciled.diagnostics],
    activeLeases: reconciled.activeLeases,
    hiddenActiveLeases,
    snapshotFallback: loaded.snapshotFallback
  };
}

export async function markAssignmentInProgress(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string,
  options?: {
    snapshotFallback?: boolean;
  }
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
  const assignment = projection.assignments.get(assignmentId);
  if (!assignment || assignment.state === "in_progress") {
    return projection;
  }

  const timestamp = nowIso();
  const event: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.updated",
    payload: {
      assignmentId,
      patch: {
        state: "in_progress",
        updatedAt: timestamp
      }
    }
  };
  if (!options?.snapshotFallback) {
    await store.appendEvent(event);
    return (await store.syncSnapshotFromEventsWithRecovery()).projection;
  }
  return store.mutateSnapshotProjection((latestProjection) =>
    applyRuntimeEventsToProjection(latestProjection, [event])
  );
}

export function listActiveClaimBindings(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>
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
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>
): AttachmentClaimBinding[] {
  return listActiveClaimBindings(projection).filter(({ attachment }) =>
    AUTHORITATIVE_ATTACHMENT_STATES.has(attachment.state)
  );
}

export function listResumableAttachmentClaims(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>
): AttachmentClaimBinding[] {
  return listActiveClaimBindings(projection).filter(({ attachment }) =>
    RESUMABLE_ATTACHMENT_STATES.has(attachment.state) &&
    isWrappedResumeCapableAttachment(attachment)
  );
}

function listProvisionalAttachmentClaims(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>
): AttachmentClaimBinding[] {
  return listActiveClaimBindings(projection).filter(({ attachment }) => attachment.state === "provisional");
}

export function getActiveClaimForAssignment(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string
): AttachmentClaimBinding | undefined {
  return listActiveClaimBindings(projection).find(({ claim }) => claim.assignmentId === assignmentId);
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

async function mutateSnapshotFallbackProjection(
  store: RuntimeStore,
  replayableEvents: RuntimeEvent[] | undefined,
  snapshotBoundaryEventId: string | undefined,
  mutate: (
    projection: Awaited<ReturnType<typeof loadOperatorProjection>>
  ) => Awaited<ReturnType<typeof loadOperatorProjection>> | Promise<Awaited<ReturnType<typeof loadOperatorProjection>>>
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
  return store.mutateSnapshotProjection(async (latestProjection) => {
    const hydrated = hydrateProjectionFromReplayableEvents(
      latestProjection,
      replayableEvents,
      snapshotBoundaryEventId
    );
    return mutate(hydrated.projection);
  });
}

async function syncProjectionSnapshot(
  store: RuntimeStore,
  options: {
    snapshotFallback: boolean;
    replayableEvents: RuntimeEvent[] | undefined;
    snapshotBoundaryEventId: string | undefined;
  }
): Promise<{
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  warning?: string;
}> {
  if (options.snapshotFallback) {
    return {
      projection: await mutateSnapshotFallbackProjection(
        store,
        options.replayableEvents,
        options.snapshotBoundaryEventId,
        (latestProjection) => latestProjection
      )
    };
  }
  return store.syncSnapshotFromEventsWithRecovery();
}

async function applyRecoveryProjectionEvents(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  events: RuntimeEvent[],
  diagnostics: CommandDiagnostic[],
  options: {
    snapshotFallback: boolean;
    replayableEvents: RuntimeEvent[] | undefined;
    snapshotBoundaryEventId: string | undefined;
  }
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
  if (events.length === 0) {
    const syncResult = await syncProjectionSnapshot(store, options);
    diagnostics.push(...diagnosticsFromWarning(syncResult.warning, "event-log-repaired"));
    return syncResult.projection;
  }
  if (options.snapshotFallback) {
    return mutateSnapshotFallbackProjection(
      store,
      options.replayableEvents,
      options.snapshotBoundaryEventId,
      (latestProjection) => applyRuntimeEventsToProjection(latestProjection, events)
    );
  }
  const persisted = await persistProjectionEvents(store, projection, events, {
    snapshotFallback: false
  });
  diagnostics.push(...diagnosticsFromWarning(persisted.warning, "event-log-repaired"));
  return persisted.projection;
}

export async function persistProjectionEvents(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  events: RuntimeEvent[],
  options?: ProjectionWriteOptions
): Promise<{
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  warning?: string;
}> {
  if (!options?.snapshotFallback) {
    await store.appendEvents(events);
    return store.syncSnapshotFromEventsWithRecovery();
  }

  return {
    projection: await store.mutateSnapshotProjection((latestProjection) =>
      applyRuntimeEventsToProjection(latestProjection, events)
    )
  };
}

export async function persistWrappedExecutionOutcome(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  execution: Pick<HostExecutionOutcome, "outcome" | "run">,
  adapter: HostAdapter,
  options?: ProjectionWriteOptions
): Promise<{
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  diagnostics: CommandDiagnostic[];
}> {
  const projectionAfterResult = await persistProjectionEvents(
    store,
    projection,
    buildOutcomeEvents(projection, execution, adapter),
    options
  );
  return {
    projection: projectionAfterResult.projection,
    diagnostics: diagnosticsFromWarning(projectionAfterResult.warning, "event-log-repaired")
  };
}

export async function transitionAttachmentClaim(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  attachmentId: string,
  claimId: string,
  patch: {
    attachment: Partial<RuntimeAttachment>;
    claim: Partial<AssignmentClaim>;
  },
  options?: ProjectionWriteOptions
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
  const timestamp = nowIso();
  return (await persistProjectionEvents(
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
  )).projection;
}

export async function persistAttachmentAuthority(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  attachment: RuntimeAttachment,
  claim: AssignmentClaim,
  options?: ProjectionWriteOptions
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
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
}

export async function updateAttachmentToDetachedResumable(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  attachmentId: string,
  options?: ProjectionWriteOptions,
  detachedAt = nowIso(),
  repair?: {
    claimId?: string;
    provenanceKind?: RuntimeAuthorityProvenance["kind"];
    nativeSessionId?: string;
  }
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
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
}

export async function releaseAttachmentClaim(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  attachmentId: string,
  claimId: string,
  reason: {
    attachment: string;
    claim: string;
  },
  options?: ProjectionWriteOptions
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
  const timestamp = nowIso();
  return transitionAttachmentClaim(
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
}

export async function orphanAttachmentClaim(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  attachmentId: string,
  claimId: string,
  reason: {
    attachment: string;
    claim: string;
  },
  options?: ProjectionWriteOptions
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
  const timestamp = nowIso();
  return transitionAttachmentClaim(
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
}

export function createLaunchAuthority(
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
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
}

export async function activateAttachmentSession(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  attachmentId: string,
  assignmentId: string,
  kind: "launch" | "resume",
  identity: HostSessionIdentity,
  options?: ProjectionWriteOptions
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
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
}

async function updateAttachmentState(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  attachmentId: string,
  patch: Partial<RuntimeAttachment>,
  options?: ProjectionWriteOptions,
  activation?: {
    kind: "launch" | "resume";
    attachmentId: string;
    assignmentId: string;
  }
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
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
  }
  if (activation) {
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

export function authorityFinalizationDispositionForOutcome(
  outcome: HostExecutionOutcome["outcome"] | NonNullable<HostRunRecord["terminalOutcome"]>
): "release" | "detach" {
  if (outcome.kind !== "result") {
    return "detach";
  }

  const status = "capture" in outcome ? outcome.capture.status : outcome.result.status;
  return status === "completed" || status === "failed" ? "release" : "detach";
}

async function requeueAssignmentForRetry(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string,
  objective: string,
  options?: ProjectionWriteOptions
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
  const timestamp = nowIso();
  return (await persistProjectionEvents(
    store,
    projection,
    buildRequeueAssignmentEvents(projection, assignmentId, objective, timestamp),
    options
  )).projection;
}

export function buildRequeueAssignmentEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
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
}

export async function orphanAttachmentClaimAndRequeue(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  attachment: RuntimeAttachment,
  claim: AssignmentClaim,
  reason: string,
  options?: ProjectionWriteOptions
): Promise<{
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  diagnostics: CommandDiagnostic[];
}> {
  const timestamp = nowIso();
  let effectiveProjection = await orphanAttachmentClaim(
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
    effectiveProjection = (
      await persistProjectionEvents(
        store,
        effectiveProjection,
        buildRequeueAssignmentEvents(
          effectiveProjection,
          claim.assignmentId,
          assignment.objective,
          timestamp
        ),
        options
      )
    ).projection;
  }
  return {
    projection: effectiveProjection,
    diagnostics
  };
}

function buildRecoveredAuthorityRepairEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
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

export function buildAuthorityFinalizationEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
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
}

export async function finalizeAttachmentAuthority(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  attachmentId: string,
  claimId: string,
  execution: Pick<HostExecutionOutcome, "outcome" | "run">,
  provenanceKind: "launch" | "resume" | "recovery",
  verifiedNativeSessionId: string | undefined,
  options?: ProjectionWriteOptions,
  detachedAt?: string
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
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
  const finalizationEvents = buildAuthorityFinalizationEvents(
    projection,
    claim.assignmentId,
    authorityFinalizationDispositionForOutcome(execution.outcome) === "release"
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
}

function synthesizeRecoveredExecution(
  record: HostRunRecord | undefined
): HostExecutionOutcome | undefined {
  if (!record || !isRecoverableCompletedRunRecord(record) || !record.terminalOutcome) {
    return undefined;
  }
  if (record.terminalOutcome.kind === "decision") {
    return {
      outcome: {
        kind: "decision",
        capture: {
          assignmentId: record.assignmentId,
          requesterId: record.terminalOutcome.decision.requesterId,
          blockerSummary: record.terminalOutcome.decision.blockerSummary,
          options: record.terminalOutcome.decision.options.map((option) => ({ ...option })),
          recommendedOption: record.terminalOutcome.decision.recommendedOption,
          state: record.terminalOutcome.decision.state,
          createdAt: record.terminalOutcome.decision.createdAt,
          ...(record.terminalOutcome.decision.decisionId
            ? { decisionId: record.terminalOutcome.decision.decisionId }
            : {})
        }
      },
      run: record
    };
  }
  return {
    outcome: {
      kind: "result",
      capture: {
        assignmentId: record.assignmentId,
        producerId: record.terminalOutcome.result.producerId,
        status: record.terminalOutcome.result.status,
        summary: record.terminalOutcome.result.summary,
        changedFiles: [...record.terminalOutcome.result.changedFiles],
        createdAt: record.terminalOutcome.result.createdAt,
        ...(record.terminalOutcome.result.resultId
          ? { resultId: record.terminalOutcome.result.resultId }
          : {})
      }
    },
    run: record
  };
}

function isRecoverableCompletedRunRecord(record: { state: string; terminalOutcome?: unknown }): boolean {
  return record.state === "completed" && Boolean(record.terminalOutcome);
}

export async function cleanupWrappedResumeLeaseArtifacts(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId: string,
  stoppedAt: string,
  reason: string
): Promise<string | undefined> {
  const cleanupError = await cleanupHostRunArtifactsWithLeaseVerification(
    store,
    adapter,
    assignmentId,
    {
      staleAt: stoppedAt,
      staleReason: reason
    }
  );
  if (!cleanupError) {
    return undefined;
  }
  return `Failed to clear host run lease metadata after wrapped resume for assignment ${assignmentId}. ${cleanupError.message}`;
}

export async function recoverCompletedWrappedExecution(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string,
  attachmentId: string,
  claimId: string,
  verifiedNativeSessionId: string | undefined,
  options: ProjectionWriteOptions,
  warningPrefix: string,
  stoppedAt?: string
): Promise<WrappedExecutionRecoveryResult> {
  const recoveredExecution = synthesizeRecoveredExecution(await adapter.inspectRun(store, assignmentId));
  if (recoveredExecution) {
    const recovered = await loadReconciledProjectionWithDiagnostics(store, adapter);
    const projectionAfter = await finalizeAttachmentAuthority(
      store,
      recovered.projection,
      attachmentId,
      claimId,
      recoveredExecution,
      "recovery",
      verifiedNativeSessionId,
      {
        snapshotFallback: recovered.snapshotFallback
      },
      stoppedAt
    );
    return {
      projection: projectionAfter,
      execution: recoveredExecution,
      diagnostics: [
        ...diagnosticsFromWarning(warningPrefix, "host-run-persist-failed"),
        ...recovered.diagnostics
      ]
    };
  }

  if (verifiedNativeSessionId) {
    const cleanupDiagnostics = diagnosticsFromWarning(
      await cleanupWrappedResumeLeaseArtifacts(
        store,
        adapter,
        assignmentId,
        stoppedAt ?? nowIso(),
        "Wrapped session lifecycle ended after identity verification without durable host completion recovery."
      ),
      "host-run-persist-failed"
    );
    const detachedProjection = await updateAttachmentToDetachedResumable(
      store,
      projection,
      attachmentId,
      options,
      stoppedAt,
      {
        claimId,
        provenanceKind: "recovery",
        nativeSessionId: verifiedNativeSessionId
      }
    );
    return {
      projection: detachedProjection,
      diagnostics: [
        ...diagnosticsFromWarning(warningPrefix, "host-run-persist-failed"),
        ...cleanupDiagnostics
      ]
    };
  }

  return {
    projection,
    diagnostics: diagnosticsFromWarning(warningPrefix, "host-run-persist-failed")
  };
}

function buildRecoveredDetachedAuthorityRepairEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
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
  return buildAuthorityFinalizationEvents(
    projection,
    assignmentId,
    detachRepair,
    timestamp
  );
}

function buildCompletedAuthorityRepairEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord,
  timestamp: string
): RuntimeEvent[] {
  if (!record.terminalOutcome) {
    return [];
  }

  if (authorityFinalizationDispositionForOutcome(record.terminalOutcome) === "detach") {
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
        record.terminalOutcome?.kind === "result"
          ? `Recovered completed assignment finished with ${record.terminalOutcome.result.status}.`
          : "Recovered completed assignment finished with a decision.",
      claimReason: "Recovered completed assignment finished."
    },
    timestamp
  );
}

function buildStaleAuthorityRepairEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
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
}

async function reconcileProvisionalAttachmentClaims(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  diagnostics: CommandDiagnostic[],
  recordByAssignmentId: Map<string, HostRunRecord>,
  options?: ProjectionWriteOptions
): Promise<{
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  changed: boolean;
}> {
  let effectiveProjection = projection;
  let changed = false;

  for (const { attachment, claim } of listProvisionalAttachmentClaims(effectiveProjection)) {
    const assignment = effectiveProjection.assignments.get(claim.assignmentId);
    const record =
      recordByAssignmentId.get(claim.assignmentId) ?? await adapter.inspectRun(store, claim.assignmentId);
    const liveNativeSessionId =
      typeof record?.adapterData?.nativeRunId === "string" && record.adapterData.nativeRunId.length > 0
        ? record.adapterData.nativeRunId
        : undefined;
    const hasLiveLease = !!record && record.state === "running" && !isRunLeaseExpired(record);

    if (hasLiveLease && liveNativeSessionId) {
      const adapterMetadata = sanitizeAttachmentAdapterMetadata(record?.adapterData);
      effectiveProjection = await transitionAttachmentClaim(
        store,
        effectiveProjection,
        attachment.id,
        claim.id,
        {
          attachment: {
            state: "detached_resumable",
            updatedAt: nowIso(),
            detachedAt: nowIso(),
            nativeSessionId: liveNativeSessionId,
            ...(adapterMetadata ? { adapterMetadata } : {})
          },
          claim: {
            updatedAt: nowIso()
          }
        },
        options
      );
      diagnostics.push({
        level: "warning",
        code: "provisional-attachment-promoted",
        message: `Promoted provisional attachment ${attachment.id} for assignment ${claim.assignmentId} into resumable attachment truth.`
      });
      changed = true;
      continue;
    }

    const startedHostRun = !!record;
    const shouldRequeue = assignment?.state === "in_progress";
    const cleanupReason = hasLiveLease
      ? "Wrapped launch left only unverifiable provisional session state."
      : "Wrapped launch ended before native session identity could be finalized.";
    effectiveProjection = await transitionAttachmentClaim(
      store,
      effectiveProjection,
      attachment.id,
      claim.id,
      startedHostRun || shouldRequeue
        ? {
            attachment: {
              state: "orphaned",
              updatedAt: nowIso(),
              orphanedAt: nowIso(),
              orphanedReason: cleanupReason
            },
            claim: {
              state: "orphaned",
              updatedAt: nowIso(),
              orphanedAt: nowIso(),
              orphanedReason: cleanupReason
            }
          }
        : {
            attachment: {
              state: "released",
              updatedAt: nowIso(),
              releasedAt: nowIso(),
              releasedReason: "Wrapped launch did not establish a durable host session."
            },
            claim: {
              state: "released",
              updatedAt: nowIso(),
              releasedAt: nowIso(),
              releasedReason: "Wrapped launch did not establish a durable host session."
            }
        },
        options
    );
    const cleanupError = await cleanupHostRunArtifactsWithLeaseVerification(
      store,
      adapter,
      claim.assignmentId,
      {
        staleAt: nowIso(),
        staleReason: cleanupReason,
        ...(record ? { inspectedRecord: record } : {})
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
    if (shouldRequeue && assignment) {
      effectiveProjection = await requeueAssignmentForRetry(
        store,
        effectiveProjection,
        claim.assignmentId,
        assignment.objective,
        options
      );
    }
    diagnostics.push({
      level: "warning",
      code: "provisional-attachment-cleared",
      message: `Cleared provisional attachment ${attachment.id} for assignment ${claim.assignmentId} because launch did not finalize into resumable attachment truth.`
    });
    changed = true;
  }

  return {
    projection: effectiveProjection,
    changed
  };
}

export async function reconcileActiveRuns(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  options?: {
    snapshotFallback?: boolean;
  }
): Promise<{
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  diagnostics: CommandDiagnostic[];
  activeLeases: string[];
}> {
  const diagnostics: CommandDiagnostic[] = [];
  const snapshotFallback = options?.snapshotFallback ?? false;
  const snapshotBoundaryEventId = snapshotFallback ? (await store.loadSnapshot())?.lastEventId : undefined;
  const replayableEvents = snapshotFallback ? (await store.loadReplayableEvents()).events : undefined;
  let effectiveProjection = fromSnapshot(toSnapshot(projection));
  let changed = false;
  let snapshotFallbackReplayHydrated = false;
  let queuedTransitions: Map<string, string[]> | undefined;
  let staleStatusTransitions: Map<string, string[]> | undefined;
  let handledCompletedRun = false;
  const runtimeKnownAssignmentIds = [...projection.assignments.keys()];
  const enumeratedRecords = await adapter.inspectRuns(store);
  const enumeratedRecordByAssignmentId = new Map(
    enumeratedRecords.map((record) => [record.assignmentId, record] as const)
  );
  const assignmentIdsToInspect = [
    ...new Set([...runtimeKnownAssignmentIds, ...enumeratedRecordByAssignmentId.keys()])
  ];

  const hydrateSnapshotFallbackReplayableSuffix = () => {
    if (!snapshotFallback || snapshotFallbackReplayHydrated) {
      return;
    }
    snapshotFallbackReplayHydrated = true;
    const replayableHydration = hydrateProjectionFromReplayableEvents(
      effectiveProjection,
      replayableEvents,
      snapshotBoundaryEventId
    );
    if (replayableHydration.hydrated) {
      effectiveProjection = replayableHydration.projection;
      changed = true;
    }
  };

  for (const assignmentId of assignmentIdsToInspect) {
    const record = enumeratedRecordByAssignmentId.get(assignmentId)
      ?? await adapter.inspectRun(store, assignmentId);
    if (!record) {
      continue;
    }

    if (snapshotFallback && isStaleRunReconciliationCandidate(record)) {
      hydrateSnapshotFallbackReplayableSuffix();
    }

    if (
      snapshotFallback &&
      !effectiveProjection.assignments.has(assignmentId) &&
      isStaleRunReconciliationCandidate(record)
    ) {
      const replayableHydration = hydrateMissingAssignmentFromReplayableEvents(
        effectiveProjection,
        assignmentId,
        replayableEvents,
        snapshotBoundaryEventId
      );
      if (replayableHydration.hydrated) {
        effectiveProjection = replayableHydration.projection;
        changed = true;
      }
    }

    const durableRuntimeCompletedRecord = isDegradedRunRecord(record)
      ? buildCompletedRunRecordFromRuntimeOutcome(effectiveProjection, assignmentId)
      : undefined;
    if (durableRuntimeCompletedRecord) {
      handledCompletedRun = true;
      const completedRecovery = await reconcileCompletedRunRecord(
        store,
        adapter,
        effectiveProjection,
        durableRuntimeCompletedRecord,
        diagnostics,
        {
          cleanupRecord: record,
          replayableEvents,
          snapshotBoundaryEventId,
          snapshotFallback
        }
      );
      effectiveProjection = completedRecovery.projection;
      changed ||= completedRecovery.changed;
      snapshotFallbackReplayHydrated ||= completedRecovery.replayableHydrated;
      continue;
    }

    if (record.state === "completed") {
      const completedRecovery = await reconcileCompletedRunRecord(
        store,
        adapter,
        effectiveProjection,
        record,
        diagnostics,
        {
          cleanupRecord: undefined,
          replayableEvents,
          snapshotBoundaryEventId,
          snapshotFallback
        }
      );
      if (completedRecovery.handled) {
        handledCompletedRun = true;
        effectiveProjection = completedRecovery.projection;
        changed ||= completedRecovery.changed;
        snapshotFallbackReplayHydrated ||= completedRecovery.replayableHydrated;
        continue;
      }

      if (record.staleReasonCode && !record.terminalOutcome) {
        if (!effectiveProjection.assignments.has(assignmentId)) {
          await reconcileOutOfProjectionStaleRun(
            store,
            adapter,
            effectiveProjection,
            assignmentId,
            record,
            diagnostics
          );
          continue;
        }

        queuedTransitions ??= await loadQueuedTransitions(store, replayableEvents);
        staleStatusTransitions ??= await loadStaleRecoveryStatusTransitions(store, replayableEvents);
        const staleRecoveryState = getStaleRunRecoveryState(
          assignmentId,
          record,
          queuedTransitions,
          staleStatusTransitions
        );
        const reconciliation = buildStaleRunReconciliation(effectiveProjection, assignmentId, record);
        const expectedStatus =
          reconciliation.events[1]?.type === "status.updated"
            ? reconciliation.events[1].payload.status
            : effectiveProjection.status;
        if (
          isStaleRunAlreadyReconciled(
            effectiveProjection,
            assignmentId,
            staleRecoveryState,
            expectedStatus,
            snapshotFallback
          )
        ) {
          changed = true;
          const syncedProjection = await syncProjectionSnapshot(store, {
            snapshotFallback,
            replayableEvents,
            snapshotBoundaryEventId
          });
          effectiveProjection = syncedProjection.projection;
          diagnostics.push(...diagnosticsFromWarning(syncedProjection.warning, "event-log-repaired"));
          const cleanupError = await reconcileStaleRunWithLeaseVerification(store, adapter, record);
          if (cleanupError) {
            diagnostics.push(
              ...diagnosticsFromWarning(
                `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
                "host-run-persist-failed"
              )
            );
          }
          continue;
        }

        const pendingEvents = selectPendingStaleRecoveryEvents(
          reconciliation.events,
          staleRecoveryState
        );
        const authorityRepairEvents = buildStaleAuthorityRepairEvents(
          effectiveProjection,
          assignmentId,
          reconciliation.events[0]?.timestamp ?? nowIso()
        );
        const recoveryEvents = [...pendingEvents, ...authorityRepairEvents];
        if (recoveryEvents.length === 0) {
          changed = true;
          if (snapshotFallback) {
            effectiveProjection = await mutateSnapshotFallbackProjection(
              store,
              replayableEvents,
              snapshotBoundaryEventId,
              (latestProjection) => applyRuntimeEventsToProjection(latestProjection, reconciliation.events)
            );
          } else {
            const syncResult = await store.syncSnapshotFromEventsWithRecovery();
            effectiveProjection = syncResult.projection;
            diagnostics.push(...diagnosticsFromWarning(syncResult.warning, "event-log-repaired"));
          }
          diagnostics.push(reconciliation.diagnostic);
          const cleanupError = await reconcileStaleRunWithLeaseVerification(
            store,
            adapter,
            reconciliation.staleRecord
          );
          if (cleanupError) {
            diagnostics.push(
              ...diagnosticsFromWarning(
                `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
                "host-run-persist-failed"
              )
            );
          }
          continue;
        }

        changed = true;
        if (!staleRecoveryState.queuedTransitionTimestamp) {
          queuedTransitions.set(assignmentId, [
            ...(queuedTransitions.get(assignmentId) ?? []),
            reconciliation.events[0]!.timestamp
          ]);
        }
        if (!staleRecoveryState.statusTransitionTimestamp) {
          staleStatusTransitions.set(assignmentId, [
            ...(staleStatusTransitions.get(assignmentId) ?? []),
            reconciliation.events[1]!.timestamp
          ]);
        }
        effectiveProjection = await applyRecoveryProjectionEvents(
          store,
          effectiveProjection,
          recoveryEvents,
          diagnostics,
          {
            snapshotFallback,
            replayableEvents,
            snapshotBoundaryEventId
          }
        );
        diagnostics.push(reconciliation.diagnostic);

        const telemetry = await recordNormalizedTelemetry(
          store,
          adapter.normalizeTelemetry({
            eventType: "host.run.stale_reconciled",
            taskId: projection.sessionId,
            assignmentId,
            metadata: reconciliation.telemetryMetadata
          })
        );
        diagnostics.push(...diagnosticsFromWarning(telemetry.warning, "telemetry-write-failed"));
        const cleanupError = await reconcileStaleRunWithLeaseVerification(
          store,
          adapter,
          reconciliation.staleRecord
        );
        if (cleanupError) {
          diagnostics.push(
            ...diagnosticsFromWarning(
              `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
              "host-run-persist-failed"
            )
          );
        }
        continue;
      }

      continue;
    }

    if (!effectiveProjection.assignments.has(assignmentId)) {
      if (!isRunLeaseExpired(record)) {
      } else if (snapshotFallback && isStaleRunReconciliationCandidate(record)) {
        await reconcileOutOfProjectionStaleRun(
          store,
          adapter,
          effectiveProjection,
          assignmentId,
          record,
          diagnostics
        );
      }
      continue;
    }

    if (!isRunLeaseExpired(record)) {
      continue;
    }

    queuedTransitions ??= await loadQueuedTransitions(store, replayableEvents);
    staleStatusTransitions ??= await loadStaleRecoveryStatusTransitions(store, replayableEvents);
    const staleRecoveryState = getStaleRunRecoveryState(
      assignmentId,
      record,
      queuedTransitions,
      staleStatusTransitions
    );
    const reconciliation = buildStaleRunReconciliation(effectiveProjection, assignmentId, record);
    const expectedStatus =
      reconciliation.events[1]?.type === "status.updated"
        ? reconciliation.events[1].payload.status
        : effectiveProjection.status;
    if (
      isStaleRunAlreadyReconciled(
        effectiveProjection,
        assignmentId,
        staleRecoveryState,
        expectedStatus,
        snapshotFallback
      )
    ) {
      changed = true;
      const syncedProjection = await syncProjectionSnapshot(store, {
        snapshotFallback,
        replayableEvents,
        snapshotBoundaryEventId
      });
      effectiveProjection = syncedProjection.projection;
      diagnostics.push(...diagnosticsFromWarning(syncedProjection.warning, "event-log-repaired"));
      const cleanupError = await reconcileStaleRunWithLeaseVerification(
        store,
        adapter,
        reconciliation.staleRecord
      );
      if (cleanupError) {
        diagnostics.push(
          ...diagnosticsFromWarning(
            `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
            "host-run-persist-failed"
          )
        );
      }
      continue;
    }

    const pendingEvents = selectPendingStaleRecoveryEvents(reconciliation.events, staleRecoveryState);
    const authorityRepairEvents = buildStaleAuthorityRepairEvents(
      effectiveProjection,
      assignmentId,
      reconciliation.events[0]?.timestamp ?? nowIso()
    );
    const recoveryEvents = [...pendingEvents, ...authorityRepairEvents];
    if (recoveryEvents.length === 0) {
      changed = true;
      effectiveProjection = await applyRecoveryProjectionEvents(
        store,
        effectiveProjection,
        snapshotFallback ? reconciliation.events : [],
        diagnostics,
        {
          snapshotFallback,
          replayableEvents,
          snapshotBoundaryEventId
        }
      );
      diagnostics.push(reconciliation.diagnostic);

      const telemetry = await recordNormalizedTelemetry(
        store,
        adapter.normalizeTelemetry({
          eventType: "host.run.stale_reconciled",
          taskId: projection.sessionId,
          assignmentId,
          metadata: reconciliation.telemetryMetadata
        })
      );
      diagnostics.push(...diagnosticsFromWarning(telemetry.warning, "telemetry-write-failed"));
      const cleanupError = await reconcileStaleRunWithLeaseVerification(
        store,
        adapter,
        reconciliation.staleRecord
      );
      if (cleanupError) {
        diagnostics.push(
          ...diagnosticsFromWarning(
            `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
            "host-run-persist-failed"
          )
        );
      }
      continue;
    }

    changed = true;
    if (!staleRecoveryState.queuedTransitionTimestamp) {
      queuedTransitions.set(assignmentId, [
        ...(queuedTransitions.get(assignmentId) ?? []),
        reconciliation.events[0]!.timestamp
      ]);
    }
    if (!staleRecoveryState.statusTransitionTimestamp) {
      staleStatusTransitions.set(assignmentId, [
        ...(staleStatusTransitions.get(assignmentId) ?? []),
        reconciliation.events[1]!.timestamp
      ]);
    }
    effectiveProjection = await applyRecoveryProjectionEvents(
      store,
      effectiveProjection,
      recoveryEvents,
      diagnostics,
      {
        snapshotFallback,
        replayableEvents,
        snapshotBoundaryEventId
      }
    );
    diagnostics.push(reconciliation.diagnostic);

    const telemetry = await recordNormalizedTelemetry(
      store,
      adapter.normalizeTelemetry({
        eventType: "host.run.stale_reconciled",
        taskId: projection.sessionId,
        assignmentId,
        metadata: reconciliation.telemetryMetadata
      })
    );
    diagnostics.push(...diagnosticsFromWarning(telemetry.warning, "telemetry-write-failed"));
    const cleanupError = await reconcileStaleRunWithLeaseVerification(
      store,
      adapter,
      reconciliation.staleRecord
    );
    if (cleanupError) {
      diagnostics.push(
        ...diagnosticsFromWarning(
          `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
          "host-run-persist-failed"
        )
      );
    }
  }

  const record = await adapter.inspectRun(store);
  if (
    !handledCompletedRun &&
    record?.state === "completed" &&
    record.terminalOutcome &&
    !assignmentIdsToInspect.includes(record.assignmentId)
  ) {
    const completedRecovery = await reconcileCompletedRunRecord(
      store,
      adapter,
      effectiveProjection,
      record,
      diagnostics,
      {
        cleanupRecord: undefined,
        replayableEvents,
        snapshotBoundaryEventId,
        snapshotFallback
      }
    );
    effectiveProjection = completedRecovery.projection;
    changed ||= completedRecovery.changed;
    snapshotFallbackReplayHydrated ||= completedRecovery.replayableHydrated;
  }

  const reconciledRecordsBeforeProvisional = await adapter.inspectRuns(store);
  const provisionalReconciliation = await reconcileProvisionalAttachmentClaims(
    store,
    adapter,
    effectiveProjection,
    diagnostics,
    new Map(reconciledRecordsBeforeProvisional.map((record) => [record.assignmentId, record] as const)),
    { snapshotFallback }
  );
  effectiveProjection = provisionalReconciliation.projection;
  changed ||= provisionalReconciliation.changed;
  const finalLeaseRecords = await adapter.inspectRuns(store);
  const finalActiveLeases = listLiveLeaseAssignments(finalLeaseRecords);

  return {
    projection: changed ? effectiveProjection : projection,
    diagnostics: [
      ...diagnostics,
      ...finalLeaseRecords
        .filter((record) => record.state === "running" && !isRunLeaseExpired(record))
        .map((record) => createActiveRunDiagnostic(record.assignmentId, record))
    ],
    activeLeases: finalActiveLeases
  };
}

async function reconcileCompletedRunRecord(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord,
  diagnostics: CommandDiagnostic[],
  options: {
    cleanupRecord: HostRunRecord | undefined;
    replayableEvents: RuntimeEvent[] | undefined;
    snapshotBoundaryEventId: string | undefined;
    snapshotFallback: boolean;
  }
): Promise<{
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  changed: boolean;
  handled: boolean;
  replayableHydrated: boolean;
}> {
  let effectiveProjection = projection;
  let changed = false;
  const replayableHydration = hydrateProjectionFromReplayableEvents(
    effectiveProjection,
    options.replayableEvents,
    options.snapshotBoundaryEventId
  );
  if (replayableHydration.hydrated) {
    effectiveProjection = replayableHydration.projection;
    changed = true;
  }
  if (options.snapshotFallback && !effectiveProjection.assignments.has(record.assignmentId)) {
    const missingAssignmentHydration = hydrateMissingAssignmentFromReplayableEvents(
      effectiveProjection,
      record.assignmentId,
      options.replayableEvents,
      options.snapshotBoundaryEventId
    );
    if (missingAssignmentHydration.hydrated) {
      effectiveProjection = missingAssignmentHydration.projection;
      changed = true;
    }
  }
  if (options.snapshotFallback && !effectiveProjection.assignments.has(record.assignmentId)) {
    return {
      projection: effectiveProjection,
      changed,
      handled: false,
      replayableHydrated: replayableHydration.hydrated
    };
  }

  const completedReplayableEvents =
    options.replayableEvents ??
    (options.snapshotFallback ? undefined : (await store.loadReplayableEvents()).events);
  const completedRecoveryProofEvents = options.snapshotFallback
    ? selectReplayableSuffixEvents(
        completedReplayableEvents,
        options.snapshotBoundaryEventId ?? ""
      )
    : completedReplayableEvents;
  const completedRecovery = buildCompletedRunReconciliation(
    effectiveProjection,
    record,
    completedRecoveryProofEvents
  );
  if (!completedRecovery) {
    return {
      projection: effectiveProjection,
      changed,
      handled: false,
      replayableHydrated: replayableHydration.hydrated
    };
  }

  const completedAuthorityEvents = buildCompletedAuthorityRepairEvents(
    effectiveProjection,
    record,
    completedRecovery.allEvents[0]?.timestamp ?? nowIso()
  );
  const completedEvents = [...completedRecovery.events, ...completedAuthorityEvents];

  if (completedEvents.length > 0) {
    changed = true;
    effectiveProjection = await applyRecoveryProjectionEvents(
      store,
      effectiveProjection,
      completedEvents,
      diagnostics,
      {
        snapshotFallback: options.snapshotFallback,
        replayableEvents: options.replayableEvents,
        snapshotBoundaryEventId: options.snapshotBoundaryEventId
      }
    );
    diagnostics.push(completedRecovery.diagnostic);
  } else if (options.snapshotFallback) {
    changed = true;
    effectiveProjection = await applyRecoveryProjectionEvents(
      store,
      effectiveProjection,
      [],
      diagnostics,
      {
        snapshotFallback: true,
        replayableEvents: options.replayableEvents,
        snapshotBoundaryEventId: options.snapshotBoundaryEventId
      }
    );
    diagnostics.push(completedRecovery.diagnostic);
  } else {
    changed = true;
    effectiveProjection = await applyRecoveryProjectionEvents(
      store,
      effectiveProjection,
      [],
      diagnostics,
      {
        snapshotFallback: false,
        replayableEvents: options.replayableEvents,
        snapshotBoundaryEventId: options.snapshotBoundaryEventId
      }
    );
  }

  const cleanupError = await reconcileStaleRunWithLeaseVerification(
    store,
    adapter,
    selectCompletedRunCleanupRecord(record, options.cleanupRecord)
  );
  if (cleanupError) {
    diagnostics.push(
      ...diagnosticsFromWarning(
        `Host run reconciliation artifacts could not be updated for assignment ${record.assignmentId}. ${cleanupError.message}`,
        "host-run-persist-failed"
      )
    );
  }

  return {
    projection: effectiveProjection,
    changed,
    handled: true,
    replayableHydrated: replayableHydration.hydrated
  };
}

export async function cleanupHostRunArtifactsWithLeaseVerification(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId: string,
  options?: {
    reconcileRecord?: HostRunRecord;
    inspectedRecord?: HostRunRecord;
    staleAt?: string;
    staleReasonCode?: HostRunRecord["staleReasonCode"];
    staleReason?: string;
    failureLabel?: string;
  }
): Promise<Error | undefined> {
  let cleanupError: Error | undefined;
  try {
    if (options?.reconcileRecord) {
      await adapter.reconcileStaleRun(store, options.reconcileRecord);
    } else {
      const inspected = options?.inspectedRecord ?? await adapter.inspectRun(store, assignmentId);
      if (inspected?.state === "running") {
        await adapter.reconcileStaleRun(store, {
          ...inspected,
          state: "completed",
          staleAt: options?.staleAt ?? nowIso(),
          ...(options?.staleReasonCode ? { staleReasonCode: options.staleReasonCode } : {}),
          ...(options?.staleReason ? { staleReason: options.staleReason } : {})
        });
      } else if (await adapter.hasRunLease(store, assignmentId)) {
        await adapter.releaseRunLease(store, assignmentId);
      }
    }
  } catch (error) {
    cleanupError = error instanceof Error ? error : new Error(String(error));
  }

  if (await adapter.hasRunLease(store, assignmentId)) {
    throw new Error(
      `Host run ${options?.failureLabel ?? "cleanup"} failed to clear the active lease for assignment ${assignmentId}. ${
        cleanupError?.message ?? "The lease artifact remained on disk."
      }`
    );
  }

  return cleanupError;
}

async function reconcileStaleRunWithLeaseVerification(
  store: RuntimeStore,
  adapter: HostAdapter,
  record: HostRunRecord
): Promise<Error | undefined> {
  return cleanupHostRunArtifactsWithLeaseVerification(
    store,
    adapter,
    record.assignmentId,
    {
      reconcileRecord: record,
      failureLabel: "reconciliation"
    }
  );
}

function selectCompletedRunCleanupRecord(
  record: HostRunRecord,
  cleanupRecord: HostRunRecord | undefined
): HostRunRecord {
  if (!cleanupRecord || cleanupRecord.state !== "running") {
    return cleanupRecord ?? record;
  }

  return {
    ...record,
    ...(
      cleanupRecord.adapterData ?? record.adapterData
        ? { adapterData: cleanupRecord.adapterData ?? record.adapterData }
        : {}
    ),
    ...(cleanupRecord.staleAt ?? record.staleAt ? { staleAt: cleanupRecord.staleAt ?? record.staleAt } : {}),
    ...(
      cleanupRecord.staleReasonCode ?? record.staleReasonCode
        ? { staleReasonCode: cleanupRecord.staleReasonCode ?? record.staleReasonCode }
        : {}
    ),
    ...(
      cleanupRecord.staleReason ?? record.staleReason
        ? { staleReason: cleanupRecord.staleReason ?? record.staleReason }
        : {}
    )
  };
}

function isStaleRunAlreadyReconciled(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string,
  recoveryState: StaleRunRecoveryState,
  expectedStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"],
  snapshotFallback: boolean
): boolean {
  const assignment = projection.assignments.get(assignmentId);
  return (
    assignment?.state === "queued" &&
    !getActiveClaimForAssignment(projection, assignmentId) &&
    (
      (snapshotFallback && hasEquivalentRuntimeStatus(projection.status, expectedStatus)) ||
      (
        Boolean(recoveryState.queuedTransitionTimestamp) &&
        Boolean(recoveryState.statusTransitionTimestamp)
      )
    )
  );
}

function isDegradedRunRecord(record: HostRunRecord): boolean {
  return (record.state === "completed" && Boolean(record.staleReasonCode) && !record.terminalOutcome) ||
    isRunLeaseExpired(record);
}

function isStaleRunReconciliationCandidate(record: HostRunRecord): boolean {
  return (record.state === "completed" && Boolean(record.staleReasonCode) && !record.terminalOutcome) ||
    isRunLeaseExpired(record);
}

function buildCompletedRunRecordFromRuntimeOutcome(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string
): HostRunRecord | undefined {
  const decision = [...projection.decisions.values()]
    .filter((candidate) => candidate.assignmentId === assignmentId)
    .at(-1);
  const result = [...projection.results.values()]
    .filter(
      (candidate) =>
        candidate.assignmentId === assignmentId &&
        (candidate.status === "completed" || candidate.status === "failed")
    )
    .at(-1);

  if (!decision && !result) {
    return undefined;
  }

  if (result && (!decision || result.createdAt >= decision.createdAt)) {
    return {
      assignmentId,
      state: "completed",
      startedAt: result.createdAt,
      completedAt: result.createdAt,
      outcomeKind: "result",
      resultStatus: result.status,
      summary: result.summary,
      terminalOutcome: {
        kind: "result",
        result: {
          resultId: result.resultId,
          producerId: result.producerId,
          status: result.status,
          summary: result.summary,
          changedFiles: [...result.changedFiles],
          createdAt: result.createdAt
        }
      }
    };
  }

  return {
    assignmentId,
    state: "completed",
    startedAt: decision!.createdAt,
    completedAt: decision!.createdAt,
    outcomeKind: "decision",
    summary: decision!.blockerSummary,
    terminalOutcome: {
      kind: "decision",
      decision: {
        decisionId: decision!.decisionId,
        requesterId: decision!.requesterId,
        blockerSummary: decision!.blockerSummary,
        options: decision!.options.map((option) => ({ ...option })),
        recommendedOption: decision!.recommendedOption,
        state: decision!.state,
        createdAt: decision!.createdAt
      }
    }
  };
}

async function loadQueuedTransitions(
  store: RuntimeStore,
  replayableEvents?: RuntimeEvent[]
): Promise<Map<string, string[]>> {
  const queuedTransitions = new Map<string, string[]>();
  const { events } = replayableEvents ? { events: replayableEvents } : await store.loadReplayableEvents();
  for (const event of events) {
    if (event.type === "assignment.updated" && event.payload.patch.state === "queued") {
      queuedTransitions.set(event.payload.assignmentId, [
        ...(queuedTransitions.get(event.payload.assignmentId) ?? []),
        event.timestamp
      ]);
    }
  }
  return queuedTransitions;
}

async function loadStaleRecoveryStatusTransitions(
  store: RuntimeStore,
  replayableEvents?: RuntimeEvent[]
): Promise<Map<string, string[]>> {
  const statusTransitions = new Map<string, string[]>();
  const { events } = replayableEvents ? { events: replayableEvents } : await store.loadReplayableEvents();
  for (const event of events) {
    if (event.type !== "status.updated") {
      continue;
    }
    const match = /^Retry assignment ([^:]+): /.exec(event.payload.status.currentObjective);
    if (!match) {
      continue;
    }
    const assignmentId = match[1]!;
    if (!event.payload.status.activeAssignmentIds.includes(assignmentId)) {
      continue;
    }
    statusTransitions.set(assignmentId, [...(statusTransitions.get(assignmentId) ?? []), event.timestamp]);
  }
  return statusTransitions;
}

interface StaleRunRecoveryState {
  queuedTransitionTimestamp: string | undefined;
  statusTransitionTimestamp: string | undefined;
}

function getStaleRunRecoveryState(
  assignmentId: string,
  record: HostRunRecord,
  queuedTransitions: Map<string, string[]>,
  staleStatusTransitions: Map<string, string[]>
): StaleRunRecoveryState {
  const startedAt = Date.parse(record.startedAt);
  if (!Number.isFinite(startedAt)) {
    return {
      queuedTransitionTimestamp: undefined,
      statusTransitionTimestamp: undefined
    };
  }

  const queuedTransitionTimestamp = (queuedTransitions.get(assignmentId) ?? []).find(
    (timestamp) => Date.parse(timestamp) >= startedAt
  );
  const statusTransitionTimestamp = (staleStatusTransitions.get(assignmentId) ?? []).find(
    (timestamp) => Date.parse(timestamp) >= startedAt
  );

  return {
    queuedTransitionTimestamp,
    statusTransitionTimestamp
  };
}

async function reconcileOutOfProjectionStaleRun(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string,
  record: HostRunRecord,
  diagnostics: CommandDiagnostic[]
): Promise<void> {
  const reconciliation = buildStaleRunReconciliation(projection, assignmentId, record);
  diagnostics.push({
    level: "warning",
    code: "stale-run-reconciled",
    message: `Cleared stale host run artifacts for assignment ${assignmentId} after snapshot fallback could not safely hydrate the assignment into runtime state.`
  });

  const telemetry = await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry({
      eventType: "host.run.stale_reconciled",
      taskId: projection.sessionId,
      assignmentId,
      metadata: reconciliation.telemetryMetadata
    })
  );
  diagnostics.push(...diagnosticsFromWarning(telemetry.warning, "telemetry-write-failed"));

  const cleanupError = await reconcileStaleRunWithLeaseVerification(
    store,
    adapter,
    reconciliation.staleRecord
  );
  if (cleanupError) {
    diagnostics.push(
      ...diagnosticsFromWarning(
        `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
        "host-run-persist-failed"
      )
    );
  }
}

function selectPendingStaleRecoveryEvents(
  events: RuntimeEvent[],
  recoveryState: StaleRunRecoveryState
): RuntimeEvent[] {
  const pendingEvents: RuntimeEvent[] = [];
  const [assignmentEvent, statusEvent] = events;

  if (!recoveryState.queuedTransitionTimestamp) {
    pendingEvents.push(assignmentEvent!);
  }
  if (!recoveryState.statusTransitionTimestamp) {
    pendingEvents.push(statusEvent!);
  }

  return pendingEvents;
}

function buildCompletedRunReconciliation(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord,
  replayableEvents?: RuntimeEvent[]
): { events: RuntimeEvent[]; allEvents: RuntimeEvent[]; diagnostic: CommandDiagnostic } | undefined {
  if (record.state !== "completed" || !record.terminalOutcome) {
    return undefined;
  }
  const timestamp = nowIso();
  const expectedStatus = nextRuntimeStatusFromRecord(projection, record, timestamp);
  const events = buildRecoveredOutcomeEvents(projection, record, timestamp);
  const pendingEvents = selectPendingCompletedRecoveryEvents(
    projection,
    record,
    events,
    expectedStatus,
    replayableEvents
  );
  const assignmentId = record.assignmentId;
  return {
    events: pendingEvents,
    allEvents: events,
    diagnostic: {
      level: "warning",
      code: "completed-run-reconciled",
      message: `Recovered completed host outcome for assignment ${assignmentId} after runtime event persistence was interrupted.`
    }
  };
}

function selectPendingCompletedRecoveryEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord,
  events: RuntimeEvent[],
  expectedStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"],
  replayableEvents?: RuntimeEvent[]
): RuntimeEvent[] {
  const [outcomeEvent, assignmentEvent, statusEvent] = events;
  const pendingEvents: RuntimeEvent[] = [];
  const recoveredOutcomeEventIndex = replayableEvents
    ? findRecoveredCompletedOutcomeEventIndexFromEvents(replayableEvents, record)
    : undefined;
  const outcomeRecoveredInProjection = hasRecoveredCompletedOutcomeEvent(projection, record);
  const outcomeAlreadyAbsorbed =
    outcomeRecoveredInProjection || recoveredOutcomeEventIndex !== undefined;
  const canUseReplayableConvergenceProof =
    replayableEvents !== undefined && recoveredOutcomeEventIndex !== undefined;
  const recoveredDecision = canUseReplayableConvergenceProof
    ? findRecoveredCompletedDecisionEvent(replayableEvents, record)
    : findRecoveredCompletedDecision(projection, record);
  const recoveredDecisionState = recoveredDecision?.state;

  if (!outcomeAlreadyAbsorbed) {
    return [...events];
  }

  if (record.terminalOutcome?.kind === "decision") {
    if (
      canUseReplayableConvergenceProof
        ? !hasRecoveredCompletedAssignmentStateFromEvents(
            replayableEvents,
            record,
            recoveredDecisionState,
            recoveredOutcomeEventIndex
          )
        : !hasRecoveredCompletedAssignmentState(projection, record, recoveredDecisionState)
    ) {
      pendingEvents.push(assignmentEvent!);
    }
    if (
      canUseReplayableConvergenceProof
        ? !hasRecoveredCompletedStatusFromEvents(
            replayableEvents,
            record,
            expectedStatus,
            recoveredOutcomeEventIndex
          )
        : !hasRecoveredCompletedStatus(projection, record, expectedStatus)
    ) {
      pendingEvents.push(statusEvent!);
    }
    return pendingEvents;
  }

  if (
    canUseReplayableConvergenceProof
      ? !hasRecoveredCompletedAssignmentStateFromEvents(
          replayableEvents,
          record,
          undefined,
          recoveredOutcomeEventIndex
        )
      : !hasRecoveredCompletedAssignmentState(projection, record)
  ) {
    pendingEvents.push(assignmentEvent!);
  }
  if (
    canUseReplayableConvergenceProof
      ? !hasRecoveredCompletedStatusFromEvents(
          replayableEvents,
          record,
          expectedStatus,
          recoveredOutcomeEventIndex
        )
      : !hasRecoveredCompletedStatus(projection, record, expectedStatus)
  ) {
    pendingEvents.push(statusEvent!);
  }

  return pendingEvents;
}

function hasRecoveredCompletedOutcomeEvent(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord
): boolean {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome) {
    return false;
  }
  if (terminalOutcome.kind === "decision") {
    return findRecoveredCompletedDecision(projection, record) !== undefined;
  }
  return [...projection.results.values()].some((result) => {
    if (record.terminalOutcome?.kind !== "result") {
      return false;
    }
    return (
      result.assignmentId === record.assignmentId &&
      (record.terminalOutcome.result.resultId
        ? result.resultId === record.terminalOutcome.result.resultId
        : result.status === record.terminalOutcome.result.status &&
          result.summary === record.terminalOutcome.result.summary &&
          result.createdAt === record.terminalOutcome.result.createdAt)
    );
  });
}

function findRecoveredCompletedDecisionEvent(
  events: RuntimeEvent[],
  record: HostRunRecord
): DecisionPacket | undefined {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome || terminalOutcome.kind !== "decision") {
    return undefined;
  }
  return events
    .filter((event): event is Extract<RuntimeEvent, { type: "decision.created" }> => event.type === "decision.created")
    .find((event) => {
      if (event.payload.decision.assignmentId !== record.assignmentId) {
        return false;
      }
      return terminalOutcome.decision.decisionId
        ? event.payload.decision.decisionId === terminalOutcome.decision.decisionId
        : event.payload.decision.blockerSummary === terminalOutcome.decision.blockerSummary &&
            event.payload.decision.recommendedOption === terminalOutcome.decision.recommendedOption &&
            event.payload.decision.createdAt === terminalOutcome.decision.createdAt;
    })?.payload.decision;
}

function hasRecoveredCompletedOutcomeEventFromEvents(events: RuntimeEvent[], record: HostRunRecord): boolean {
  return findRecoveredCompletedOutcomeEventIndexFromEvents(events, record) !== undefined;
}

function findRecoveredCompletedOutcomeEventIndexFromEvents(
  events: RuntimeEvent[],
  record: HostRunRecord
): number | undefined {
  if (!record.terminalOutcome) {
    return undefined;
  }
  if (record.terminalOutcome.kind === "decision") {
    const decisionIndex = events.findIndex((event): event is Extract<RuntimeEvent, { type: "decision.created" }> => {
      if (event.type !== "decision.created") {
        return false;
      }
      if (event.payload.decision.assignmentId !== record.assignmentId) {
        return false;
      }
      return record.terminalOutcome?.kind === "decision" &&
        (record.terminalOutcome.decision.decisionId
          ? event.payload.decision.decisionId === record.terminalOutcome.decision.decisionId
          : event.payload.decision.blockerSummary === record.terminalOutcome.decision.blockerSummary &&
              event.payload.decision.recommendedOption === record.terminalOutcome.decision.recommendedOption &&
              event.payload.decision.createdAt === record.terminalOutcome.decision.createdAt);
    });
    return decisionIndex === -1 ? undefined : decisionIndex;
  }
  const resultIndex = events.findIndex((event): event is Extract<RuntimeEvent, { type: "result.submitted" }> => {
    if (event.type !== "result.submitted") {
      return false;
    }
    if (event.payload.result.assignmentId !== record.assignmentId) {
      return false;
    }
    return record.terminalOutcome?.kind === "result" &&
      (record.terminalOutcome.result.resultId
        ? event.payload.result.resultId === record.terminalOutcome.result.resultId
        : event.payload.result.status === record.terminalOutcome.result.status &&
            event.payload.result.summary === record.terminalOutcome.result.summary &&
            event.payload.result.createdAt === record.terminalOutcome.result.createdAt);
  });
  return resultIndex === -1 ? undefined : resultIndex;
}

function hasRecoveredCompletedAssignmentStateFromEvents(
  events: RuntimeEvent[],
  record: HostRunRecord,
  recoveredDecisionState: "open" | "resolved" | undefined,
  recoveredOutcomeEventIndex?: number
): boolean {
  if (recoveredOutcomeEventIndex === undefined) {
    return false;
  }
  const expectedAssignmentState = nextAssignmentStateFromRecord(record, recoveredDecisionState);
  return events.some((event, index): event is Extract<RuntimeEvent, { type: "assignment.updated" }> => {
    if (index <= recoveredOutcomeEventIndex) {
      return false;
    }
    if (event.type !== "assignment.updated") {
      return false;
    }
    return (
      event.payload.assignmentId === record.assignmentId &&
      event.payload.patch.state === expectedAssignmentState
    );
  });
}

function hasRecoveredCompletedStatusFromEvents(
  events: RuntimeEvent[],
  record: HostRunRecord,
  expectedStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"],
  recoveredOutcomeEventIndex?: number
): boolean {
  if (recoveredOutcomeEventIndex === undefined) {
    return false;
  }
  return events.some((event, index): event is Extract<RuntimeEvent, { type: "status.updated" }> => {
    if (index <= recoveredOutcomeEventIndex) {
      return false;
    }
    if (event.type !== "status.updated") {
      return false;
    }
    const status = event.payload.status;
    if (!hasEquivalentCompletedRecoveryStatus(status, expectedStatus)) {
      return false;
    }
    return !(
      record.terminalOutcome?.kind === "result" &&
      status.activeAssignmentIds.includes(record.assignmentId)
    );
  });
}

function findRecoveredCompletedDecision(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord
) {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome || terminalOutcome.kind !== "decision") {
    return undefined;
  }
  return [...projection.decisions.values()].find((decision) => {
    if (decision.assignmentId !== record.assignmentId) {
      return false;
    }
    return terminalOutcome.decision.decisionId
      ? decision.decisionId === terminalOutcome.decision.decisionId
      : decision.blockerSummary === terminalOutcome.decision.blockerSummary &&
          decision.recommendedOption === terminalOutcome.decision.recommendedOption &&
          decision.createdAt === terminalOutcome.decision.createdAt;
  });
}

function hasRecoveredCompletedAssignmentState(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord,
  recoveredDecisionState?: "open" | "resolved"
): boolean {
  const assignment = projection.assignments.get(record.assignmentId);
  const expectedAssignmentState = nextAssignmentStateFromRecord(record, recoveredDecisionState);
  return assignment?.state === expectedAssignmentState;
}

function hasRecoveredCompletedStatus(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord,
  expectedStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"]
): boolean {
  if (!hasEquivalentCompletedRecoveryStatus(projection.status, expectedStatus)) {
    return false;
  }
  return !(
    record.terminalOutcome?.kind === "result" &&
    projection.status.activeAssignmentIds.includes(record.assignmentId)
  );
}

function hasEquivalentCompletedRecoveryStatus(
  actualStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"],
  expectedStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"]
): boolean {
  return actualStatus.activeMode === expectedStatus.activeMode &&
    actualStatus.resumeReady === expectedStatus.resumeReady &&
    actualStatus.activeAssignmentIds.length === expectedStatus.activeAssignmentIds.length &&
    actualStatus.activeAssignmentIds.every((id, index) => id === expectedStatus.activeAssignmentIds[index]);
}

function hydrateProjectionFromReplayableEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  replayableEvents?: RuntimeEvent[],
  snapshotBoundaryEventId?: string
): {
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  hydrated: boolean;
} {
  const hydrationEvents = snapshotBoundaryEventId
    ? selectReplayableSuffixEvents(replayableEvents, snapshotBoundaryEventId)
    : replayableEvents;
  if (!hydrationEvents || hydrationEvents.length === 0) {
    return {
      projection,
      hydrated: false
    };
  }

  const hydratedProjection = fromSnapshot(toSnapshot(projection));
  let hydrated = false;
  for (const event of hydrationEvents) {
    try {
      applyRuntimeEvent(hydratedProjection, event);
      hydrated = true;
    } catch {
      continue;
    }
  }
  return {
    projection: hydrated ? hydratedProjection : projection,
    hydrated
  };
}

function listHiddenActiveLeaseAssignments(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  activeLeases: string[]
): string[] {
  return activeLeases.filter((assignmentId) => !projection.assignments.has(assignmentId));
}

function listLiveLeaseAssignments(records: HostRunRecord[]): string[] {
  return records
    .filter((record) => record.state === "running" && !isRunLeaseExpired(record))
    .map((record) => record.assignmentId);
}

function hasEquivalentRuntimeStatus(
  actualStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"],
  expectedStatus: Awaited<ReturnType<typeof loadOperatorProjection>>["status"]
): boolean {
  return actualStatus.currentObjective === expectedStatus.currentObjective &&
    actualStatus.activeMode === expectedStatus.activeMode &&
    actualStatus.resumeReady === expectedStatus.resumeReady &&
    actualStatus.activeAssignmentIds.length === expectedStatus.activeAssignmentIds.length &&
    actualStatus.activeAssignmentIds.every((id, index) => id === expectedStatus.activeAssignmentIds[index]);
}

function selectReplayableSuffixEvents(
  replayableEvents: RuntimeEvent[] | undefined,
  snapshotBoundaryEventId: string
): RuntimeEvent[] | undefined {
  if (!replayableEvents || replayableEvents.length === 0) {
    return undefined;
  }
  const boundaryIndex = replayableEvents.findIndex((event) => event.eventId === snapshotBoundaryEventId);
  if (boundaryIndex === -1) {
    return undefined;
  }
  return replayableEvents.slice(boundaryIndex + 1);
}

function hydrateMissingAssignmentFromReplayableEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string,
  replayableEvents?: RuntimeEvent[],
  snapshotBoundaryEventId?: string
): {
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  hydrated: boolean;
} {
  if (!replayableEvents || replayableEvents.length === 0) {
    return {
      projection,
      hydrated: false
    };
  }

  const assignmentEventFromSuffix = snapshotBoundaryEventId
    ? selectReplayableSuffixEvents(replayableEvents, snapshotBoundaryEventId)?.find(
        (event): event is Extract<RuntimeEvent, { type: "assignment.created" }> =>
          event.type === "assignment.created" && event.payload.assignment.id === assignmentId
      )
    : undefined;
  const assignmentEvent = assignmentEventFromSuffix;
  if (!assignmentEvent) {
    return {
      projection,
      hydrated: false
    };
  }

  const hydratedProjection = fromSnapshot(toSnapshot(projection));
  applyRuntimeEvent(hydratedProjection, assignmentEvent);
  return {
    projection: hydratedProjection,
    hydrated: true
  };
}

function buildRecoveredOutcomeEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord,
  timestamp: string
): RuntimeEvent[] {
  if (!record.terminalOutcome) {
    throw new Error(`Completed host run for assignment ${record.assignmentId} is missing terminal outcome data.`);
  }
  const status = nextRuntimeStatusFromRecord(projection, record, timestamp);
  const events: RuntimeEvent[] = [];

  if (record.terminalOutcome.kind === "decision") {
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "decision.created",
      payload: {
        decision: {
          decisionId: record.terminalOutcome.decision.decisionId ?? randomUUID(),
          assignmentId: record.assignmentId,
          requesterId: record.terminalOutcome.decision.requesterId,
          blockerSummary: record.terminalOutcome.decision.blockerSummary,
          options: record.terminalOutcome.decision.options.map((option) => ({ ...option })),
          recommendedOption: record.terminalOutcome.decision.recommendedOption,
          state: record.terminalOutcome.decision.state,
          createdAt: record.terminalOutcome.decision.createdAt
        }
      }
    });
  } else {
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "result.submitted",
      payload: {
        result: {
          resultId: record.terminalOutcome.result.resultId ?? randomUUID(),
          assignmentId: record.assignmentId,
          producerId: record.terminalOutcome.result.producerId,
          status: record.terminalOutcome.result.status,
          summary: record.terminalOutcome.result.summary,
          changedFiles: [...record.terminalOutcome.result.changedFiles],
          createdAt: record.terminalOutcome.result.createdAt
        }
      }
    });
  }

  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.updated",
    payload: {
      assignmentId: record.assignmentId,
      patch: {
        state: nextAssignmentStateFromRecord(record),
        updatedAt: timestamp
      }
    }
  });
  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "status.updated",
    payload: { status }
  });

  return events;
}

export function buildOutcomeEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  execution: Pick<HostExecutionOutcome, "outcome" | "run">,
  adapter: HostAdapter
): RuntimeEvent[] {
  const timestamp = nowIso();
  const assignmentId = execution.run.assignmentId;
  const status = nextRuntimeStatus(projection, execution);
  const events: RuntimeEvent[] = [];

  if (execution.outcome.kind === "decision") {
    const decision = adapter.normalizeDecision(execution.outcome.capture);
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "decision.created",
      payload: { decision }
    });
  } else {
    const result = adapter.normalizeResult(execution.outcome.capture);
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "result.submitted",
      payload: { result }
    });
  }

  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.updated",
    payload: {
      assignmentId,
      patch: {
        state: nextAssignmentState(execution),
        updatedAt: timestamp
      }
    }
  });
  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "status.updated",
    payload: { status }
  });

  return events;
}

export function getRunnableAssignment(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>
) {
  const activeAssignments = projection.status.activeAssignmentIds
    .map((assignmentId) => projection.assignments.get(assignmentId))
    .filter((assignment): assignment is NonNullable<typeof assignment> => Boolean(assignment));
  if (activeAssignments.length === 0) {
    throw new Error("No active assignment is available to run.");
  }

  for (const activeAssignment of activeAssignments) {
    const unresolvedDecisions = [...projection.decisions.values()].filter(
      (decision) => decision.assignmentId === activeAssignment.id && decision.state === "open"
    );
    if (activeAssignment.state === "blocked" || unresolvedDecisions.length > 0) {
      continue;
    }
    return activeAssignment;
  }

  const blockedAssignment = activeAssignments[0]!;
  const unresolvedDecisions = [...projection.decisions.values()].filter(
    (decision) => decision.assignmentId === blockedAssignment.id && decision.state === "open"
  );
  const suffix =
    unresolvedDecisions.length > 0
      ? ` Resolve decision ${unresolvedDecisions[0]!.decisionId} first.`
      : "";
  throw new Error(`Assignment ${blockedAssignment.id} is blocked and cannot be run.${suffix}`);
}

export function projectionForRunnableAssignment(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string
) {
  return selectRunnableProjection(projection, assignmentId);
}

function nextAssignmentState(execution: Pick<HostExecutionOutcome, "outcome" | "run">) {
  if (execution.outcome.kind === "decision") {
    return "blocked" as const;
  }
  switch (execution.outcome.capture.status) {
    case "completed":
      return "completed" as const;
    case "failed":
      return "failed" as const;
    default:
      return "in_progress" as const;
  }
}

function nextRuntimeStatus(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  execution: Pick<HostExecutionOutcome, "outcome" | "run">
) {
  const assignmentId = execution.run.assignmentId;
  const terminal =
    execution.outcome.kind === "result" &&
    (execution.outcome.capture.status === "completed" || execution.outcome.capture.status === "failed");
  const activeAssignmentIds = terminal
    ? projection.status.activeAssignmentIds.filter((id) => id !== assignmentId)
    : projection.status.activeAssignmentIds;

  return {
    ...projection.status,
    activeMode: activeAssignmentIds.length === 0 ? "idle" : projection.status.activeMode,
    currentObjective:
      activeAssignmentIds.length === 0
        ? execution.outcome.kind === "result" && execution.outcome.capture.status === "failed"
          ? `Review failed assignment ${assignmentId}.`
          : "Await the next assignment."
        : execution.outcome.kind === "decision"
          ? nextDecisionCurrentObjective(
              projection,
              assignmentId,
              execution.outcome.capture.blockerSummary
            )
          : projection.status.currentObjective,
    activeAssignmentIds,
    lastDurableOutputAt: nowIso(),
    resumeReady: true
  };
}

function nextAssignmentStateFromRecord(record: HostRunRecord, recoveredDecisionState?: "open" | "resolved") {
  if (!record.terminalOutcome) {
    return "failed" as const;
  }
  if (record.terminalOutcome.kind === "decision") {
    return recoveredDecisionState === "resolved" ? "in_progress" : ("blocked" as const);
  }
  switch (record.terminalOutcome.result.status) {
    case "completed":
      return "completed" as const;
    case "failed":
      return "failed" as const;
    default:
      return "in_progress" as const;
  }
}

function nextRuntimeStatusFromRecord(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  record: HostRunRecord,
  timestamp: string
) {
  const terminal =
    record.terminalOutcome?.kind === "result" &&
    (record.terminalOutcome.result.status === "completed" ||
      record.terminalOutcome.result.status === "failed");
  const activeAssignmentIds = terminal
    ? projection.status.activeAssignmentIds.filter((id) => id !== record.assignmentId)
    : projection.status.activeAssignmentIds;

  return {
    ...projection.status,
    activeMode: activeAssignmentIds.length === 0 ? "idle" : projection.status.activeMode,
    currentObjective:
      activeAssignmentIds.length === 0
        ? record.terminalOutcome?.kind === "result" &&
          record.terminalOutcome.result.status === "failed"
          ? `Review failed assignment ${record.assignmentId}.`
          : "Await the next assignment."
        : record.terminalOutcome?.kind === "decision"
          ? nextDecisionCurrentObjective(
              projection,
              record.assignmentId,
              record.terminalOutcome.decision.blockerSummary
            )
          : projection.status.currentObjective,
    activeAssignmentIds,
    lastDurableOutputAt: timestamp,
    resumeReady: true
  };
}

function nextDecisionCurrentObjective(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string,
  blockerSummary: string
): string {
  const hasOpenDecision = [...projection.decisions.values()].some(
    (decision) => decision.assignmentId === assignmentId && decision.state === "open"
  );
  if (hasOpenDecision) {
    return projection.status.currentObjective;
  }
  return blockerSummary.trim().length > 0 ? blockerSummary : projection.status.currentObjective;
}
