import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeConfig } from "../config/types.js";
import type {
  HostAdapter,
  HostExecutionOutcome,
  HostSessionResumeResult,
  TaskEnvelope
} from "../adapters/contract.js";
import { isActiveHostRunLeaseError } from "../adapters/host-run-store.js";
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
import { recordNormalizedTelemetry } from "../telemetry/recorder.js";
import { nowIso } from "../utils/time.js";
import type { CommandDiagnostic } from "./types.js";
import { diagnosticsFromWarning, loadOperatorProjection, loadOperatorProjectionWithDiagnostics } from "./runtime-state.js";
import {
  activateAttachmentSession,
  createLaunchAuthority,
  cleanupWrappedResumeLeaseArtifacts,
  finalizeAttachmentAuthority,
  getRunnableAssignment,
  listAuthoritativeAttachmentClaims,
  loadReconciledProjectionWithDiagnostics,
  listResumableAttachmentClaims,
  markAssignmentInProgress,
  orphanAttachmentClaimAndRequeue,
  orphanAttachmentClaim,
  persistAttachmentAuthority,
  persistWrappedExecutionOutcome,
  projectionForRunnableAssignment,
  reconcileActiveRuns,
  recoverCompletedWrappedExecution,
  releaseAttachmentClaim,
} from "./run-operations.js";
import type { ProjectionWriteOptions } from "./run-operations.js";

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

  await store.appendEvents(bootstrap.events);

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
    seedDiagnostics: []
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

async function prepareResumeRuntimeInternal(
  store: RuntimeStore,
  adapter: HostAdapter,
  options: {
    seedDiagnostics: CommandDiagnostic[];
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
    [...loaded.diagnostics, ...options.seedDiagnostics]
  );
}

async function prepareResumeFromProjection(
  store: RuntimeStore,
  adapter: HostAdapter,
  effectiveProjection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  seedDiagnostics: CommandDiagnostic[]
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

  return {
    projection: effectiveProjection,
    brief,
    envelope,
    envelopePath: resolve(join(store.runtimeDir, "last-resume-envelope.json")),
    diagnostics
  };
}

async function persistResumeEnvelopeAndTelemetry(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  envelope: Awaited<ReturnType<HostAdapter["buildResumeEnvelope"]>>,
  telemetryEventType: string | undefined
): Promise<CommandDiagnostic[]> {
  await store.writeJsonArtifact("runtime/last-resume-envelope.json", envelope);
  if (!telemetryEventType) {
    return [];
  }
  const telemetry = await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry({
      eventType: telemetryEventType,
      taskId: projection.sessionId,
      metadata: {
        envelopeChars: envelope.estimatedChars,
        trimApplied: envelope.trimApplied,
        trimmedFields: envelope.trimmedFields.length
      }
    })
  );
  return diagnosticsFromWarning(telemetry.warning, "telemetry-write-failed");
}

export async function prepareResumeRuntime(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<PrepareResumeRuntimeResult> {
  return prepareResumeRuntimeInternal(store, adapter, {
    seedDiagnostics: []
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
    const prepared = await prepareResumeFromProjection(store, adapter, projection, []);
    diagnostics.push(
      ...(await persistResumeEnvelopeAndTelemetry(
        store,
        adapter,
        projection,
        prepared.envelope,
        "resume.requested"
      ))
    );
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
    const prepared = await prepareResumeFromProjection(store, adapter, reconciled.projection, []);
    const persistDiagnostics = await persistResumeEnvelopeAndTelemetry(
      store,
      adapter,
      reconciled.projection,
      prepared.envelope,
      "resume.requested"
    );
    return {
      mode: "prepared",
      ...prepared,
      diagnostics: [...diagnostics, ...persistDiagnostics]
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
    const prepared = await prepareResumeFromProjection(store, adapter, reconciled.projection, []);
    const persistDiagnostics = await persistResumeEnvelopeAndTelemetry(
      store,
      adapter,
      reconciled.projection,
      prepared.envelope,
      "resume.requested"
    );
    return {
      mode: "prepared",
      ...prepared,
      diagnostics: [...diagnostics, ...persistDiagnostics]
    };
  }

  const resumeProjection = projectionForRunnableAssignment(reconciled.projection, assignment.id);
  const resumeBrief = buildRecoveryBrief(resumeProjection);
  const resumeEnvelope = await adapter.buildResumeEnvelope(store, resumeProjection, resumeBrief);
  const envelopePath = resolve(join(store.runtimeDir, "last-resume-envelope.json"));
  diagnostics.push(
    ...(await persistResumeEnvelopeAndTelemetry(
      store,
      adapter,
      reconciled.projection,
      resumeEnvelope,
      "resume.requested"
    ))
  );
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
    resumeResult = await adapter.resumeSession(
      store,
      resumeProjection,
      resumeEnvelope,
      target.attachment,
      {
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
      }
    );
  } catch (error) {
    if (isActiveHostRunLeaseError(error)) {
      throw error;
    }
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

  switch (resumeResult.reclaimState) {
    case "verified_then_failed": {
      const recoveredResume = await recoverCompletedWrappedExecution(
        store,
        adapter,
        effectiveProjection,
        assignment.id,
        target.attachment.id,
        target.claim.id,
        resumeResult.verifiedSessionId,
        resumeWriteOptions,
        `Wrapped same-session resume verified the requested session but runtime persistence did not complete cleanly. ${
          resumeResult.warning ?? "No durable host completion could be recovered."
        }`,
        resumeResult.stoppedAt
      );
      diagnostics.push(...recoveredResume.diagnostics);
      if (!recoveredResume.execution) {
        return buildPreparedResult(recoveredResume.projection);
      }
      effectiveProjection = recoveredResume.projection;
      const recoveredAttachment = effectiveProjection.attachments.get(target.attachment.id);
      const recoveredClaim = effectiveProjection.claims.get(target.claim.id);
      if (!recoveredAttachment || !recoveredClaim) {
        throw new Error(
          `Attachment ${target.attachment.id} or claim ${target.claim.id} disappeared during recovered resume finalization.`
        );
      }
      return {
        mode: "reclaimed",
        projection: effectiveProjection,
        brief: resumeBrief,
        envelope: resumeEnvelope,
        envelopePath,
        diagnostics,
        attachment: recoveredAttachment,
        claim: recoveredClaim
      };
    }
    case "unverified_failed": {
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
    case "reclaimed":
      break;
  }
  if (!resumeResult.reclaimed) {
    throw new Error(`Unexpected wrapped resume reclaim state ${resumeResult.reclaimState}.`);
  }
  const reclaimedResume = resumeResult;

  diagnostics.push(
    ...diagnosticsFromWarning(
      await cleanupWrappedResumeLeaseArtifacts(
        store,
        adapter,
        assignment.id,
        reclaimedResume.stoppedAt,
        `Wrapped same-session resume reclaimed attachment ${target.attachment.id} and released stale lease blockers.`
      ),
      "host-run-persist-failed"
    )
  );
  try {
    const persistedOutcome = await persistWrappedExecutionOutcome(
      store,
      effectiveProjection,
      {
        outcome: reclaimedResume.outcome,
        run: reclaimedResume.run
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
          outcome: reclaimedResume.outcome,
          run: reclaimedResume.run
        },
        "resume",
        reclaimedResume.verifiedSessionId,
        resumeWriteOptions,
        reclaimedResume.stoppedAt
      );
  } catch (error) {
      const recoveredResume = await recoverCompletedWrappedExecution(
        store,
        adapter,
        effectiveProjection,
        assignment.id,
        target.attachment.id,
        target.claim.id,
        reclaimedResume.verifiedSessionId,
        resumeWriteOptions,
        `Runtime event persistence was interrupted after wrapped same-session resume completed durably. ${
          error instanceof Error ? error.message : String(error)
      }`,
      reclaimedResume.stoppedAt
    );
    diagnostics.push(...recoveredResume.diagnostics);
    if (!recoveredResume.execution) {
      return buildPreparedResult(recoveredResume.projection);
    }
    effectiveProjection = recoveredResume.projection;
  }
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
      `Assignment ${blocking.claim.assignmentId} is already claimed by authoritative attachment ${blocking.attachment.id}.`
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
    projectionBefore = await persistAttachmentAuthority(
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
  let verifiedNativeSessionId: string | undefined;
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
        verifiedNativeSessionId = identity.nativeSessionId;
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
    const persistedOutcome = await persistWrappedExecutionOutcome(
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
        "launch",
        verifiedNativeSessionId,
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
      const recoveredExecution = await recoverCompletedWrappedExecution(
        store,
        adapter,
        launchedProjection,
        assignment.id,
        launchAuthority.attachment.id,
        launchAuthority.claim.id,
        verifiedNativeSessionId,
        launchWriteOptions,
        `Runtime event persistence was interrupted after the host run completed durably. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (recoveredExecution.execution) {
        diagnostics.push(
          ...recoveredExecution.diagnostics
        );
        return {
          projectionBefore: launchedProjection,
          projectionAfter: recoveredExecution.projection,
          assignment,
          envelope,
          execution: recoveredExecution.execution,
          recoveredOutcome: true,
          diagnostics
        };
      }
      if (verifiedNativeSessionId) {
        diagnostics.push(...recoveredExecution.diagnostics);
        launchedProjection = recoveredExecution.projection;
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

export async function inspectRuntimeRun(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId?: string
) {
  const config = await store.loadConfig();
  if (!config) {
    throw new Error("Coortex is not initialized. Run `ctx init` first.");
  }
  await loadReconciledProjectionWithDiagnostics(store, adapter);
  return adapter.inspectRun(store, assignmentId);
}

export async function inspectRuntimeRunWithContext(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId?: string
): Promise<
  | {
      hostRun: NonNullable<Awaited<ReturnType<typeof inspectRuntimeRun>>>;
      runtimeAttachment?: {
        id: string;
        state: string;
        nativeSessionId: string;
        claimId: string;
        claimState: string;
      };
    }
  | undefined
> {
  const config = await store.loadConfig();
  if (!config) {
    throw new Error("Coortex is not initialized. Run `ctx init` first.");
  }
  const reconciled = await loadReconciledProjectionWithDiagnostics(store, adapter);
  const hostRun = await adapter.inspectRun(store, assignmentId);
  if (!hostRun) {
    return undefined;
  }
  const claim = [...reconciled.projection.claims.values()]
    .filter((candidate) => candidate.assignmentId === hostRun.assignmentId)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .at(-1);
  const attachment = claim
    ? reconciled.projection.attachments.get(claim.attachmentId)
    : undefined;
  return {
    hostRun,
    ...(attachment
      ? {
          runtimeAttachment: {
            id: attachment.id,
            state: attachment.state,
            nativeSessionId: attachment.nativeSessionId ?? "",
            claimId: claim?.id ?? "",
            claimState: claim?.state ?? ""
          }
        }
      : {})
  };
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
