import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeConfig } from "../config/types.js";
import type {
  HostAdapter,
  HostExecutionOutcome,
  HostSessionIdentity,
  HostSessionResumeResult,
  TaskEnvelope
} from "../adapters/contract.js";
import type {
  Assignment,
  AssignmentClaim,
  DecisionPacket,
  ResultPacket,
  RuntimeAttachment
} from "../core/types.js";
import { createBootstrapRuntime } from "../core/runtime.js";
import { buildRecoveryBrief } from "../recovery/brief.js";
import { RuntimeStore } from "../persistence/store.js";
import { applyRuntimeEvent, fromSnapshot, toSnapshot } from "../projections/runtime-projection.js";
import { recordNormalizedTelemetry } from "../telemetry/recorder.js";
import { nowIso } from "../utils/time.js";
import type { CommandDiagnostic } from "./types.js";
import { diagnosticsFromWarning, loadOperatorProjection, loadOperatorProjectionWithDiagnostics } from "./runtime-state.js";
import {
  buildOutcomeEvents,
  getRunnableAssignment,
  listAuthoritativeAttachmentClaims,
  loadReconciledProjectionWithDiagnostics,
  listResumableAttachmentClaims,
  markAssignmentInProgress,
  projectionForRunnableAssignment,
  reconcileActiveRuns
} from "./run-operations.js";

export type { CommandDiagnostic } from "./types.js";
export { loadOperatorProjection, loadOperatorProjectionWithDiagnostics } from "./runtime-state.js";
export { loadReconciledProjectionWithDiagnostics } from "./run-operations.js";

export interface InitRuntimeResult {
  sessionId: string;
  adapterId: string;
  rootDir: string;
  diagnostics: CommandDiagnostic[];
}

export interface PrepareResumeRuntimeResult {
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  brief: ReturnType<typeof buildRecoveryBrief>;
  envelope: Awaited<ReturnType<HostAdapter["buildResumeEnvelope"]>>;
  envelopePath: string;
  diagnostics: CommandDiagnostic[];
}

export type ResumeRuntimeResult =
  | (PrepareResumeRuntimeResult & { mode: "prepared" })
  | (PrepareResumeRuntimeResult & {
      mode: "reclaimed";
      attachment: RuntimeAttachment;
      claim: AssignmentClaim;
    });

export interface RunRuntimeResult {
  projectionBefore: Awaited<ReturnType<typeof loadOperatorProjection>>;
  projectionAfter: Awaited<ReturnType<typeof loadOperatorProjection>>;
  assignment: ReturnType<typeof getRunnableAssignment>;
  envelope: Awaited<ReturnType<HostAdapter["buildResumeEnvelope"]>>;
  execution: Awaited<ReturnType<HostAdapter["executeAssignment"]>>;
  recoveredOutcome: boolean;
  diagnostics: CommandDiagnostic[];
}

interface ProjectionWriteOptions {
  snapshotFallback?: boolean;
}

type SessionExecution = Pick<HostExecutionOutcome, "outcome" | "run">;

function listUnmatchedActiveLeases(
  activeLeases: string[],
  bindings: Array<{ claim: AssignmentClaim }>
): string[] {
  const claimedAssignmentIds = new Set(bindings.map(({ claim }) => claim.assignmentId));
  return activeLeases.filter((assignmentId) => !claimedAssignmentIds.has(assignmentId));
}

export async function initRuntime(
  projectRoot: string,
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<InitRuntimeResult | undefined> {
  const existing = await store.loadConfig();
  if (existing) {
    return undefined;
  }

  const createdAt = nowIso();
  const sessionId = randomUUID();

  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: adapter.id,
    host: adapter.host,
    rootPath: projectRoot,
    createdAt
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: adapter.id,
    host: adapter.host,
    workflow: "milestone-2"
  });

  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  let syncResult = await store.syncSnapshotFromEventsWithRecovery();
  const diagnostics = diagnosticsFromWarning(syncResult.warning, "event-log-repaired");
  let projection = syncResult.projection;
  await adapter.initialize(store, projection);
  await store.appendEvent({
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "host.setup.completed",
    payload: {
      adapter: adapter.id,
      host: adapter.host,
      completedAt: nowIso()
    }
  });
  syncResult = await store.syncSnapshotFromEventsWithRecovery();
  diagnostics.push(...diagnosticsFromWarning(syncResult.warning, "event-log-repaired"));
  projection = syncResult.projection;
  const prepared = await prepareResumeRuntimeInternal(store, adapter, {
    telemetryEventType: undefined
  });
  diagnostics.push(...prepared.diagnostics);
  const telemetry = await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry({
      eventType: "runtime.initialized",
      taskId: sessionId,
      assignmentId: bootstrap.initialAssignmentId,
      metadata: {
        projectRoot,
        repoName: basename(projectRoot)
      }
    })
  );
  diagnostics.push(...diagnosticsFromWarning(telemetry.warning, "telemetry-write-failed"));

  return {
    sessionId,
    adapterId: adapter.id,
    rootDir: store.rootDir,
    diagnostics
  };
}

async function persistProjectionEvents(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  events: import("../core/events.js").RuntimeEvent[],
  options?: ProjectionWriteOptions
): Promise<{
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  warning?: string;
}> {
  if (!options?.snapshotFallback) {
    for (const event of events) {
      await store.appendEvent(event);
    }
    return store.syncSnapshotFromEventsWithRecovery();
  }

  const nextProjection = fromSnapshot(toSnapshot(projection));
  for (const event of events) {
    applyRuntimeEvent(nextProjection, event);
  }
  await store.writeSnapshot(toSnapshot(nextProjection));
  return { projection: nextProjection };
}

async function persistRuntimeOutcome(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  execution: SessionExecution,
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

async function prepareResumeRuntimeInternal(
  store: RuntimeStore,
  adapter: HostAdapter,
  options: {
    telemetryEventType: string | undefined;
  }
): Promise<PrepareResumeRuntimeResult> {
  const config = await store.loadConfig();
  if (!config) {
    throw new Error("Coortex is not initialized. Run `ctx init` first.");
  }

  const loaded = await loadOperatorProjectionWithDiagnostics(store);
  return prepareResumeFromProjection(
    store,
    adapter,
    loaded.projection,
    loaded.diagnostics,
    options.telemetryEventType
  );
}

async function prepareResumeFromProjection(
  store: RuntimeStore,
  adapter: HostAdapter,
  effectiveProjection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  seedDiagnostics: CommandDiagnostic[],
  telemetryEventType: string | undefined
): Promise<PrepareResumeRuntimeResult> {
  const diagnostics = [...seedDiagnostics];
  const brief = buildRecoveryBrief(effectiveProjection, {
    allowAttachmentResumeAction:
      adapter.getCapabilities().supportsNativeSessionResume === true && !!adapter.resumeSession
  });
  if (brief.activeAssignments.length === 0) {
    throw new Error("No active assignment is available to resume.");
  }
  const envelope = await adapter.buildResumeEnvelope(store, effectiveProjection, brief);
  const envelopePath = join(store.runtimeDir, "last-resume-envelope.json");
  await store.writeJsonArtifact("runtime/last-resume-envelope.json", envelope);
  if (telemetryEventType) {
    const telemetry = await recordNormalizedTelemetry(
      store,
      adapter.normalizeTelemetry({
        eventType: telemetryEventType,
        taskId: effectiveProjection.sessionId,
        metadata: {
          envelopeChars: envelope.estimatedChars,
          trimApplied: envelope.trimApplied,
          trimmedFields: envelope.trimmedFields.length
        }
      })
    );
    diagnostics.push(...diagnosticsFromWarning(telemetry.warning, "telemetry-write-failed"));
  }

  return {
    projection: effectiveProjection,
    brief,
    envelope,
    envelopePath: resolve(envelopePath),
    diagnostics
  };
}

export async function prepareResumeRuntime(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<PrepareResumeRuntimeResult> {
  return prepareResumeRuntimeInternal(store, adapter, {
    telemetryEventType: "resume.requested"
  });
}

export async function resumeRuntime(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<ResumeRuntimeResult> {
  const config = await store.loadConfig();
  if (!config) {
    throw new Error("Coortex is not initialized. Run `ctx init` first.");
  }

  const reconciled = await loadReconciledProjectionWithDiagnostics(store, adapter);
  const diagnostics = [...reconciled.diagnostics];
  const resumableClaims = listResumableAttachmentClaims(reconciled.projection);
  const unmatchedActiveLeases = listUnmatchedActiveLeases(
    reconciled.activeLeases,
    resumableClaims
  );
  const resumeWriteOptions = {
    snapshotFallback: reconciled.snapshotFallback
  } satisfies ProjectionWriteOptions;
  const buildPreparedResult = async (
    projection: Awaited<ReturnType<typeof loadOperatorProjection>>
  ): Promise<ResumeRuntimeResult> => {
    const prepared = await prepareResumeFromProjection(store, adapter, projection, [], undefined);
    return {
      mode: "prepared",
      ...prepared,
      diagnostics: [...diagnostics, ...prepared.diagnostics]
    };
  };
  if (unmatchedActiveLeases.length > 0) {
    throw new Error(`Assignment ${unmatchedActiveLeases[0]!} already has an active host run lease.`);
  }
  if (resumableClaims.length === 0) {
    const prepared = await prepareResumeFromProjection(
      store,
      adapter,
      reconciled.projection,
      diagnostics,
      "resume.requested"
    );
    return {
      mode: "prepared",
      ...prepared
    };
  }
  if (resumableClaims.length > 1) {
    throw new Error(
      `Invalid runtime state: multiple resumable attachments are present (${resumableClaims
        .map(({ attachment }) => attachment.id)
        .join(", ")}).`
    );
  }
  const target = resumableClaims[0]!;
  const assignment = reconciled.projection.assignments.get(target.claim.assignmentId);
  if (!assignment) {
    throw new Error(
      `Invalid runtime state: active claim ${target.claim.id} references missing assignment ${target.claim.assignmentId}.`
    );
  }
  if (!adapter.getCapabilities().supportsNativeSessionResume || !adapter.resumeSession) {
    const prepared = await prepareResumeFromProjection(
      store,
      adapter,
      reconciled.projection,
      diagnostics,
      "resume.requested"
    );
    return {
      mode: "prepared",
      ...prepared
    };
  }

  const resumeProjection = projectionForRunnableAssignment(reconciled.projection, assignment.id);
  const resumeBrief = buildRecoveryBrief(resumeProjection);
  const resumeEnvelope = await adapter.buildResumeEnvelope(store, resumeProjection, resumeBrief);
  const envelopePath = resolve(join(store.runtimeDir, "last-resume-envelope.json"));
  await store.writeJsonArtifact("runtime/last-resume-envelope.json", resumeEnvelope);
  const telemetry = await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry({
      eventType: "resume.requested",
      taskId: reconciled.projection.sessionId,
      metadata: {
        envelopeChars: resumeEnvelope.estimatedChars,
        trimApplied: resumeEnvelope.trimApplied,
        trimmedFields: resumeEnvelope.trimmedFields.length
      }
    })
  );
  diagnostics.push(...diagnosticsFromWarning(telemetry.warning, "telemetry-write-failed"));
  const startedTelemetry = await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry({
      eventType: "host.resume.started",
      taskId: reconciled.projection.sessionId,
      assignmentId: assignment.id,
      metadata: {
        attachmentId: target.attachment.id,
        nativeSessionId: target.attachment.nativeSessionId ?? "",
        envelopeChars: resumeEnvelope.estimatedChars,
        trimApplied: resumeEnvelope.trimApplied,
        trimmedFields: resumeEnvelope.trimmedFields.length
      }
    })
  );
  diagnostics.push(...diagnosticsFromWarning(startedTelemetry.warning, "telemetry-write-failed"));

  let effectiveProjection = reconciled.projection;
  let resumeResult: HostSessionResumeResult;
  try {
    if (!target.attachment.nativeSessionId) {
      throw new Error(`Attachment ${target.attachment.id} is missing a stored native session id.`);
    }
    resumeResult = await adapter.resumeSession(store, resumeProjection, resumeEnvelope, target.attachment, {
      onSessionIdentity: async (identity) => {
        effectiveProjection = await markAssignmentInProgress(
          store,
          effectiveProjection,
          assignment.id,
          resumeWriteOptions
        );
        effectiveProjection = await activateAttachmentSession(
          store,
          effectiveProjection,
          target.attachment.id,
          assignment.id,
          "resume",
          identity,
          resumeWriteOptions
        );
      }
    });
  } catch (error) {
    const failedResume = await orphanAttachmentClaimAndRequeue(
      store,
      adapter,
      effectiveProjection,
      target.attachment,
      target.claim,
      `Wrapped same-session resume failed. ${error instanceof Error ? error.message : String(error)}`,
      resumeWriteOptions
    );
    diagnostics.push(...failedResume.diagnostics);
    return buildPreparedResult(failedResume.projection);
  }

  diagnostics.push(...diagnosticsFromWarning(resumeResult.warning, "host-run-persist-failed"));
  if (resumeResult.telemetry) {
    const completedTelemetry = await recordNormalizedTelemetry(
      store,
      adapter.normalizeTelemetry(resumeResult.telemetry)
    );
    diagnostics.push(...diagnosticsFromWarning(completedTelemetry.warning, "telemetry-write-failed"));
  }

  if (!resumeResult.reclaimed) {
    const failedResume = await orphanAttachmentClaimAndRequeue(
      store,
      adapter,
      effectiveProjection,
      target.attachment,
      target.claim,
      resumeResult.warning ?? "Wrapped same-session resume failed.",
      resumeWriteOptions
    );
    diagnostics.push(...failedResume.diagnostics);
    return buildPreparedResult(failedResume.projection);
  }

  diagnostics.push(
    ...diagnosticsFromWarning(
      await cleanupResumeLeaseArtifacts(
        store,
        adapter,
        assignment.id,
        resumeResult.stoppedAt,
        `Wrapped same-session resume reclaimed attachment ${target.attachment.id} and released stale lease blockers.`
      ),
      "host-run-persist-failed"
    )
  );
  const persistedOutcome = await persistRuntimeOutcome(
    store,
    effectiveProjection,
    {
      outcome: resumeResult.outcome,
      run: resumeResult.run
    },
    adapter,
    resumeWriteOptions
  );
  effectiveProjection = persistedOutcome.projection;
  diagnostics.push(...persistedOutcome.diagnostics);
  effectiveProjection = await finalizeAttachmentAuthority(
    store,
    effectiveProjection,
    target.attachment.id,
    target.claim.id,
    {
      outcome: resumeResult.outcome,
      run: resumeResult.run
    },
    true,
    resumeWriteOptions,
    resumeResult.stoppedAt
  );
  const resumedAttachment = effectiveProjection.attachments.get(target.attachment.id);
  const resumedClaim = effectiveProjection.claims.get(target.claim.id);
  if (!resumedAttachment || !resumedClaim) {
    throw new Error(
      `Attachment ${target.attachment.id} or claim ${target.claim.id} disappeared during resume finalization.`
    );
  }

  return {
    mode: "reclaimed",
    projection: effectiveProjection,
    brief: resumeBrief,
    envelope: resumeEnvelope,
    envelopePath,
    diagnostics,
    attachment: resumedAttachment,
    claim: resumedClaim
  };
}

export async function runRuntime(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<RunRuntimeResult> {
  const config = await store.loadConfig();
  if (!config) {
    throw new Error("Coortex is not initialized. Run `ctx init` first.");
  }

  const projectionBeforeResult = await loadOperatorProjectionWithDiagnostics(store);
  const reconciled = await reconcileActiveRuns(
    store,
    adapter,
    projectionBeforeResult.projection,
    { snapshotFallback: projectionBeforeResult.snapshotFallback }
  );
  projectionBeforeResult.diagnostics.push(...reconciled.diagnostics);
  let projectionBefore = reconciled.projection;
  let diagnostics: CommandDiagnostic[] = [...projectionBeforeResult.diagnostics];
  const launchWriteOptions = {
    snapshotFallback: projectionBeforeResult.snapshotFallback
  } satisfies ProjectionWriteOptions;
  const unmatchedActiveLeases = listUnmatchedActiveLeases(
    reconciled.activeLeases,
    listAuthoritativeAttachmentClaims(projectionBefore)
  );
  if (unmatchedActiveLeases.length > 0) {
    throw new Error(`Assignment ${unmatchedActiveLeases[0]!} already has an active host run lease.`);
  }
  let assignment: ReturnType<typeof getRunnableAssignment>;
  try {
    assignment = getRunnableAssignment(projectionBefore);
  } catch (error) {
    const recoveredOutcome = synthesizeRecoveredExecutionFromReconciliation(
      adapter,
      projectionBeforeResult.projection,
      projectionBefore
    );
    if (!recoveredOutcome) {
      throw error;
    }
    return {
      projectionBefore,
      projectionAfter: projectionBefore,
      assignment: recoveredOutcome.assignment,
      envelope: recoveredOutcome.envelope,
      execution: recoveredOutcome.execution,
      recoveredOutcome: true,
      diagnostics
    };
  }
  const authoritativeClaims = listAuthoritativeAttachmentClaims(projectionBefore);
  if (authoritativeClaims.length > 1) {
    throw new Error(
      `Invalid runtime state: multiple authoritative attachments are present (${authoritativeClaims
        .map(({ attachment }) => attachment.id)
        .join(", ")}).`
    );
  }
  if (authoritativeClaims.length === 1) {
    const blocking = authoritativeClaims[0]!;
    throw new Error(
      `Assignment ${blocking.claim.assignmentId} already has an active host run lease. Claimed by attachment ${blocking.attachment.id}.`
    );
  }
  let claimedRun: Awaited<ReturnType<HostAdapter["claimRunLease"]>>;
  try {
    claimedRun = await adapter.claimRunLease(store, projectionBefore, assignment.id);
  } catch (error) {
    throw error;
  }
  const launchAuthority = createLaunchAuthority(adapter, projectionBefore, assignment.id);
  let authorityPersisted = false;
  try {
    projectionBefore = await appendAttachmentAuthority(
      store,
      projectionBefore,
      launchAuthority.attachment,
      launchAuthority.claim,
      launchWriteOptions
    );
    authorityPersisted = true;
  } catch (error) {
    try {
      await adapter.releaseRunLease(store, assignment.id);
    } catch (releaseError) {
      throw new Error(
        `Wrapped launch failed after claiming the host run lease and lease cleanup also failed. ${
          error instanceof Error ? error.message : String(error)
        } ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`
      );
    }
    throw error;
  }
  let executionStarted = false;
  let launchedProjection: Awaited<ReturnType<typeof loadOperatorProjection>> | undefined;
  let envelope: Awaited<ReturnType<HostAdapter["buildResumeEnvelope"]>> | undefined;
  let execution: Awaited<ReturnType<HostAdapter["executeAssignment"]>> | undefined;
  let sessionIdentitySeen = false;
  try {
    const envelopeProjection = projectionForRunnableAssignment(projectionBefore, assignment.id);
    const brief = buildRecoveryBrief(envelopeProjection);
    envelope = await adapter.buildResumeEnvelope(store, envelopeProjection, brief);
    launchedProjection = await markAssignmentInProgress(
      store,
      projectionBefore,
      assignment.id,
      launchWriteOptions
    );

    const startedTelemetry = await recordNormalizedTelemetry(
      store,
      adapter.normalizeTelemetry({
        eventType: "host.run.started",
        taskId: launchedProjection.sessionId,
        assignmentId: assignment.id,
        metadata: {
          envelopeChars: envelope.estimatedChars,
          trimApplied: envelope.trimApplied,
          trimmedFields: envelope.trimmedFields.length
        }
      })
    );
    diagnostics.push(...diagnosticsFromWarning(startedTelemetry.warning, "telemetry-write-failed"));

    executionStarted = true;
    execution = await adapter.executeAssignment(store, launchedProjection, envelope, claimedRun, {
      onSessionIdentity: async (identity) => {
        sessionIdentitySeen = true;
        launchedProjection = await activateAttachmentSession(
          store,
          launchedProjection ?? projectionBefore,
          launchAuthority.attachment.id,
          assignment.id,
          "launch",
          identity,
          launchWriteOptions
        );
      }
    });
    diagnostics.push(...diagnosticsFromWarning(execution.warning, "host-run-persist-failed"));
    const persistedOutcome = await persistRuntimeOutcome(
      store,
      launchedProjection,
      execution,
      adapter,
      launchWriteOptions
    );
    let projectionAfter = persistedOutcome.projection;
    diagnostics.push(...persistedOutcome.diagnostics);
    projectionAfter = await finalizeAttachmentAuthority(
      store,
      projectionAfter,
      launchAuthority.attachment.id,
      launchAuthority.claim.id,
      execution,
      sessionIdentitySeen,
      launchWriteOptions
    );

    if (execution.telemetry) {
      const completedTelemetry = await recordNormalizedTelemetry(
        store,
        adapter.normalizeTelemetry(execution.telemetry)
      );
      diagnostics.push(
        ...diagnosticsFromWarning(completedTelemetry.warning, "telemetry-write-failed")
      );
    }

    return {
      projectionBefore: launchedProjection,
      projectionAfter,
      assignment,
      envelope,
      execution,
      recoveredOutcome: false,
      diagnostics
    };
  } catch (error) {
    if (!executionStarted) {
      await adapter.releaseRunLease(store, assignment.id);
      if (authorityPersisted) {
        projectionBefore = await releaseAttachmentClaim(
          store,
          projectionBefore,
          launchAuthority.attachment.id,
          launchAuthority.claim.id,
          {
            attachment: `Wrapped launch failed before native session identity was observed. ${
              error instanceof Error ? error.message : String(error)
            }`,
            claim: "Wrapped launch did not begin."
          },
          launchWriteOptions
        );
      }
    } else if (launchedProjection && envelope) {
      const recoveredExecution = synthesizeRecoveredExecution(
        await adapter.inspectRun(store, assignment.id)
      );
      if (recoveredExecution) {
        const recovered = await loadReconciledProjectionWithDiagnostics(store, adapter);
          const projectionAfter = await finalizeAttachmentAuthority(
          store,
          recovered.projection,
          launchAuthority.attachment.id,
          launchAuthority.claim.id,
          recoveredExecution,
          sessionIdentitySeen,
          {
            snapshotFallback: recovered.snapshotFallback
          }
        );
        diagnostics.push(
          ...diagnosticsFromWarning(
            `Runtime event persistence was interrupted after the host run completed durably. Recovered from durable host run metadata. ${
              error instanceof Error ? error.message : String(error)
            }`,
            "host-run-persist-failed"
          ),
          ...recovered.diagnostics
        );
        return {
          projectionBefore: launchedProjection,
          projectionAfter,
          assignment,
          envelope,
          execution: recoveredExecution,
          recoveredOutcome: false,
          diagnostics
        };
      }
      if (sessionIdentitySeen) {
        launchedProjection = await updateAttachmentToDetachedResumable(
          store,
          launchedProjection,
          launchAuthority.attachment.id,
          launchWriteOptions
        );
      } else {
        launchedProjection = await releaseAttachmentClaim(
          store,
          launchedProjection,
          launchAuthority.attachment.id,
          launchAuthority.claim.id,
          {
            attachment: `Wrapped launch ended without a stored native session identity. ${
              error instanceof Error ? error.message : String(error)
            }`,
            claim: "Wrapped launch ended before identity finalization."
          },
          launchWriteOptions
        );
      }
    }
    throw error;
  }
}

function createLaunchAuthority(
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
      provenance: {
        kind: "launch",
        source: "ctx.run"
      }
    },
    claim: {
      id: randomUUID(),
      assignmentId,
      attachmentId,
      state: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      provenance: {
        kind: "launch",
        source: "ctx.run"
      }
    }
  };
}

async function appendAttachmentAuthority(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  attachment: RuntimeAttachment,
  claim: AssignmentClaim,
  options?: ProjectionWriteOptions
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
  const timestamp = nowIso();
  return (await persistProjectionEvents(store, projection, [
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "attachment.created" as const,
      payload: { attachment }
    },
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "claim.created" as const,
      payload: { claim }
    }
  ], options)).projection;
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
  const events: import("../core/events.js").RuntimeEvent[] = [
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

async function transitionAttachmentClaim(
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
  return (await persistProjectionEvents(store, projection, [
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
  ], options)).projection;
}

async function updateAttachmentToDetachedResumable(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  attachmentId: string,
  options?: ProjectionWriteOptions,
  detachedAt = nowIso()
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
  return updateAttachmentState(store, projection, attachmentId, {
    state: "detached_resumable",
    updatedAt: detachedAt,
    detachedAt
  }, options);
}

async function activateAttachmentSession(
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

async function releaseAttachmentClaim(
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

async function orphanAttachmentClaim(
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

async function finalizeAttachmentAuthority(
  store: RuntimeStore,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  attachmentId: string,
  claimId: string,
  execution: SessionExecution,
  sessionIdentitySeen: boolean,
  options?: ProjectionWriteOptions,
  detachedAt?: string
): Promise<Awaited<ReturnType<typeof loadOperatorProjection>>> {
  const terminal = isTerminalExecution(execution);
  if (terminal) {
    return releaseAttachmentClaim(
      store,
      projection,
      attachmentId,
      claimId,
      {
        attachment:
          execution.outcome.kind === "result"
            ? `Assignment finished with ${execution.outcome.capture.status}.`
            : "Assignment completed with a decision.",
        claim: "Assignment finished."
      },
      options
    );
  }

  if (sessionIdentitySeen) {
    return updateAttachmentToDetachedResumable(store, projection, attachmentId, options, detachedAt);
  }

  return orphanAttachmentClaim(
    store,
    projection,
    attachmentId,
    claimId,
    {
      attachment: "Wrapped launch completed without native session identity finalization.",
      claim: "Wrapped launch completed without native session identity finalization."
    },
    options
  );
}

async function orphanAttachmentClaimAndRequeue(
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
  try {
    const inspected = await adapter.inspectRun(store, claim.assignmentId);
    if (inspected?.state === "running") {
      await adapter.reconcileStaleRun(store, {
        ...inspected,
        state: "completed",
        staleAt: timestamp,
        staleReason: reason
      });
    } else if (await adapter.hasRunLease(store, claim.assignmentId)) {
      await adapter.releaseRunLease(store, claim.assignmentId);
    }
  } catch {
    // runtime authority is already cleared; lease cleanup remains best-effort here
  }
  const assignment = effectiveProjection.assignments.get(claim.assignmentId);
  if (assignment) {
    const retryStatus = {
      ...effectiveProjection.status,
      currentObjective: `Retry assignment ${claim.assignmentId}: ${assignment.objective}`,
      lastDurableOutputAt: timestamp,
      resumeReady: true
    };
    effectiveProjection = (await persistProjectionEvents(store, effectiveProjection, [
      {
        eventId: randomUUID(),
        sessionId: effectiveProjection.sessionId,
        timestamp,
        type: "assignment.updated",
        payload: {
          assignmentId: claim.assignmentId,
          patch: {
            state: "queued",
            updatedAt: timestamp
          }
        }
      },
      {
        eventId: randomUUID(),
        sessionId: effectiveProjection.sessionId,
        timestamp,
        type: "status.updated",
        payload: { status: retryStatus }
      }
    ], options)).projection;
  }
  return {
    projection: effectiveProjection,
    diagnostics
  };
}

async function cleanupResumeLeaseArtifacts(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId: string,
  stoppedAt: string,
  reason: string
): Promise<string | undefined> {
  try {
    const inspected = await adapter.inspectRun(store, assignmentId);
    if (inspected?.state === "running") {
      await adapter.reconcileStaleRun(store, {
        ...inspected,
        state: "completed",
        staleAt: stoppedAt,
        staleReason: reason
      });
      return undefined;
    }
    if (await adapter.hasRunLease(store, assignmentId)) {
      await adapter.releaseRunLease(store, assignmentId);
    }
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to clear host run lease metadata after wrapped resume for assignment ${assignmentId}. ${message}`;
  }
}

function isTerminalExecution(execution: SessionExecution): boolean {
  return execution.outcome.kind === "result" &&
    (execution.outcome.capture.status === "completed" || execution.outcome.capture.status === "failed");
}

export async function inspectRuntimeRun(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId?: string
) {
  const config = await store.loadConfig();
  if (!config) {
    throw new Error("Coortex is not initialized. Run `ctx init` first.");
  }
  return adapter.inspectRun(store, assignmentId);
}

function synthesizeRecoveredExecution(
  record: Awaited<ReturnType<HostAdapter["inspectRun"]>>
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

function synthesizeRecoveredExecutionFromReconciliation(
  adapter: HostAdapter,
  projectionBeforeReconciliation: Awaited<ReturnType<typeof loadOperatorProjection>>,
  projectionAfterReconciliation: Awaited<ReturnType<typeof loadOperatorProjection>>
): {
  assignment: Assignment;
  envelope: TaskEnvelope;
  execution: HostExecutionOutcome;
} | undefined {
  const recoveredDecision = findRecoveredDecisionCandidate(
    projectionBeforeReconciliation,
    projectionAfterReconciliation
  );
  if (recoveredDecision) {
    return {
      assignment: recoveredDecision.assignment,
      envelope: buildRecoveredExecutionEnvelope(
        adapter,
        projectionAfterReconciliation,
        recoveredDecision.assignment
      ),
      execution: {
        outcome: {
          kind: "decision",
          capture: {
            assignmentId: recoveredDecision.assignment.id,
            requesterId: recoveredDecision.decision.requesterId,
            blockerSummary: recoveredDecision.decision.blockerSummary,
            options: recoveredDecision.decision.options.map((option) => ({ ...option })),
            recommendedOption: recoveredDecision.decision.recommendedOption,
            state: recoveredDecision.decision.state,
            createdAt: recoveredDecision.decision.createdAt,
            decisionId: recoveredDecision.decision.decisionId
          }
        },
        run: {
          assignmentId: recoveredDecision.assignment.id,
          state: "completed",
          startedAt: recoveredDecision.decision.createdAt,
          completedAt: recoveredDecision.decision.createdAt,
          outcomeKind: "decision",
          summary: recoveredDecision.decision.blockerSummary,
          terminalOutcome: {
            kind: "decision",
            decision: {
              decisionId: recoveredDecision.decision.decisionId,
              requesterId: recoveredDecision.decision.requesterId,
              blockerSummary: recoveredDecision.decision.blockerSummary,
              options: recoveredDecision.decision.options.map((option) => ({ ...option })),
              recommendedOption: recoveredDecision.decision.recommendedOption,
              state: recoveredDecision.decision.state,
              createdAt: recoveredDecision.decision.createdAt
            }
          }
        }
      }
    };
  }

  if (projectionAfterReconciliation.status.activeAssignmentIds.length > 0) {
    return undefined;
  }

  const recoveredResult = findRecoveredResultCandidate(
    projectionBeforeReconciliation,
    projectionAfterReconciliation
  );
  if (!recoveredResult) {
    return undefined;
  }

  return {
    assignment: recoveredResult.assignment,
    envelope: buildRecoveredExecutionEnvelope(
      adapter,
      projectionAfterReconciliation,
      recoveredResult.assignment
    ),
    execution: {
      outcome: {
        kind: "result",
        capture: {
          assignmentId: recoveredResult.assignment.id,
          producerId: recoveredResult.result.producerId,
          status: recoveredResult.result.status,
          summary: recoveredResult.result.summary,
          changedFiles: [...recoveredResult.result.changedFiles],
          createdAt: recoveredResult.result.createdAt,
          resultId: recoveredResult.result.resultId
        }
      },
      run: {
        assignmentId: recoveredResult.assignment.id,
        state: "completed",
        startedAt: recoveredResult.result.createdAt,
        completedAt: recoveredResult.result.createdAt,
        outcomeKind: "result",
        resultStatus: recoveredResult.result.status,
        summary: recoveredResult.result.summary,
        terminalOutcome: {
          kind: "result",
          result: {
            resultId: recoveredResult.result.resultId,
            producerId: recoveredResult.result.producerId,
            status: recoveredResult.result.status,
            summary: recoveredResult.result.summary,
            changedFiles: [...recoveredResult.result.changedFiles],
            createdAt: recoveredResult.result.createdAt
          }
        }
      }
    }
  };
}

function findRecoveredDecisionCandidate(
  projectionBeforeReconciliation: Awaited<ReturnType<typeof loadOperatorProjection>>,
  projectionAfterReconciliation: Awaited<ReturnType<typeof loadOperatorProjection>>
): {
  assignment: Assignment;
  decision: DecisionPacket;
} | undefined {
  for (const assignmentId of projectionAfterReconciliation.status.activeAssignmentIds) {
    const assignment = projectionAfterReconciliation.assignments.get(assignmentId);
    if (!assignment || assignment.state !== "blocked") {
      continue;
    }
    const decision = findLatestOpenDecision(projectionAfterReconciliation, assignment.id);
    if (!decision) {
      continue;
    }
    const beforeAssignment = projectionBeforeReconciliation.assignments.get(assignment.id);
    if (
      beforeAssignment?.state !== assignment.state ||
      projectionBeforeReconciliation.status.activeAssignmentIds.includes(assignment.id) !==
        projectionAfterReconciliation.status.activeAssignmentIds.includes(assignment.id) ||
      !hasMatchingDecision(projectionBeforeReconciliation, decision)
    ) {
      return { assignment, decision };
    }
  }

  return undefined;
}

function findRecoveredResultCandidate(
  projectionBeforeReconciliation: Awaited<ReturnType<typeof loadOperatorProjection>>,
  projectionAfterReconciliation: Awaited<ReturnType<typeof loadOperatorProjection>>
): {
  assignment: Assignment;
  result: ResultPacket;
} | undefined {
  let candidate:
    | {
        assignment: Assignment;
        result: ResultPacket;
      }
    | undefined;

  for (const assignment of projectionAfterReconciliation.assignments.values()) {
    if (assignment.state !== "completed" && assignment.state !== "failed") {
      continue;
    }
    const result = findLatestTerminalResult(projectionAfterReconciliation, assignment.id);
    if (!result) {
      continue;
    }
    const beforeAssignment = projectionBeforeReconciliation.assignments.get(assignment.id);
    if (
      beforeAssignment?.state === assignment.state &&
      projectionBeforeReconciliation.status.activeAssignmentIds.includes(assignment.id) ===
        projectionAfterReconciliation.status.activeAssignmentIds.includes(assignment.id) &&
      hasMatchingResult(projectionBeforeReconciliation, result)
    ) {
      continue;
    }
    if (!candidate || candidate.result.createdAt < result.createdAt) {
      candidate = { assignment, result };
    }
  }

  return candidate;
}

function buildRecoveredExecutionEnvelope(
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignment: Assignment
): TaskEnvelope {
  const brief = buildRecoveryBrief(projection);
  return {
    host: adapter.host,
    adapter: adapter.id,
    objective: assignment.objective,
    writeScope: [...assignment.writeScope],
    requiredOutputs: [...assignment.requiredOutputs],
    recoveryBrief: brief,
    recentResults: brief.lastDurableResults.map((result) => ({
      resultId: result.resultId,
      summary: result.summary,
      trimmed: !!result.trimmed,
      ...(result.reference ? { reference: result.reference } : {})
    })),
    metadata: {
      activeMode: projection.status.activeMode,
      activeAssignmentId: assignment.id,
      unresolvedDecisionCount: brief.unresolvedDecisions.length,
      recoveredOutcome: true
    },
    estimatedChars: 0,
    trimApplied: false,
    trimmedFields: []
  };
}

function findLatestOpenDecision(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string
): DecisionPacket | undefined {
  return [...projection.decisions.values()]
    .filter((decision) => decision.assignmentId === assignmentId && decision.state === "open")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
}

function findLatestTerminalResult(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string
): ResultPacket | undefined {
  return [...projection.results.values()]
    .filter(
      (result) =>
        result.assignmentId === assignmentId &&
        (result.status === "completed" || result.status === "failed")
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
}

function hasMatchingDecision(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  decision: DecisionPacket
): boolean {
  return [...projection.decisions.values()].some((candidate) =>
    candidate.assignmentId === decision.assignmentId &&
    (
      candidate.decisionId === decision.decisionId ||
      (
        candidate.blockerSummary === decision.blockerSummary &&
        candidate.recommendedOption === decision.recommendedOption &&
        candidate.createdAt === decision.createdAt
      )
    )
  );
}

function hasMatchingResult(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  result: ResultPacket
): boolean {
  return [...projection.results.values()].some((candidate) =>
    candidate.assignmentId === result.assignmentId &&
    (
      candidate.resultId === result.resultId ||
      (
        candidate.status === result.status &&
        candidate.summary === result.summary &&
        candidate.createdAt === result.createdAt
      )
    )
  );
}
