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
  AssignmentClaim,
  RuntimeAttachment
} from "../core/types.js";
import { createBootstrapRuntime } from "../core/runtime.js";
import {
  getActiveClaimForAssignment,
  listAuthoritativeAttachmentClaims,
  listResumableAttachmentClaims,
  selectSingleAuthoritativeAttachmentClaim,
  selectSingleResumableAttachmentClaim
} from "../projections/attachment-claim-queries.js";
import { buildRecoveryBrief } from "../recovery/brief.js";
import { RuntimeStore } from "../persistence/store.js";
import { recordNormalizedTelemetry } from "../telemetry/recorder.js";
import { nowIso } from "../utils/time.js";
import type { CommandDiagnostic } from "./types.js";
import { diagnosticsFromWarning, loadOperatorProjection, loadOperatorProjectionWithDiagnostics } from "./runtime-state.js";
import { AttachmentLifecycleService } from "./attachment-lifecycle.js";
import {
  cleanupWrappedResumeLeaseArtifacts,
  getRunnableAssignment,
  markAssignmentInProgress,
  persistWrappedExecutionOutcome,
  projectionForRunnableAssignment,
  recoverCompletedWrappedExecution,
  synthesizeRecoveredExecutionFromReconciliation,
} from "./run-operations.js";
import type { ProjectionWriteOptions } from "./projection-write.js";
import {
  loadReconciledProjectionWithDiagnostics,
  reconcileActiveRuns
} from "./run-reconciliation.js";

export type { CommandDiagnostic } from "./types.js";
export { loadOperatorProjection, loadOperatorProjectionWithDiagnostics } from "./runtime-state.js";
export { loadReconciledProjectionWithDiagnostics } from "./run-reconciliation.js";

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
      execution: SessionExecution;
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

type DiagnosticsBearingError = Error & {
  diagnostics?: CommandDiagnostic[];
};

function listUnmatchedActiveLeases(
  activeLeases: string[],
  bindings: Array<{ claim: AssignmentClaim }>
): string[] {
  const claimedAssignmentIds = new Set(bindings.map(({ claim }) => claim.assignmentId));
  return activeLeases.filter((assignmentId) => !claimedAssignmentIds.has(assignmentId));
}

function attachCommandDiagnostics(
  error: unknown,
  diagnostics: CommandDiagnostic[]
): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (diagnostics.length === 0) {
    return normalized;
  }
  const existingDiagnostics = (normalized as DiagnosticsBearingError).diagnostics ?? [];
  (normalized as DiagnosticsBearingError).diagnostics = [
    ...diagnostics,
    ...existingDiagnostics.filter(
      (existingDiagnostic) =>
        !diagnostics.some(
          (diagnostic) =>
            diagnostic.level === existingDiagnostic.level &&
            diagnostic.code === existingDiagnostic.code &&
            diagnostic.message === existingDiagnostic.message
        )
    )
  ];
  return normalized;
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

async function buildResumeArtifactsFromProjection(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  includeInactiveEnvelope = false
): Promise<{
  brief: ReturnType<typeof buildRecoveryBrief>;
  envelope?: Awaited<ReturnType<HostAdapter["buildResumeEnvelope"]>>;
}> {
  const brief = buildRecoveryBrief(projection, {
    allowAttachmentResumeAction:
      adapter.getCapabilities().supportsNativeSessionResume === true && !!adapter.resumeSession
  });
  if (brief.activeAssignments.length === 0 && !includeInactiveEnvelope) {
    return { brief };
  }
  const envelope = await adapter.buildResumeEnvelope(store, projection, brief);
  return {
    brief,
    envelope
  };
}

async function prepareResumeFromProjection(
  store: RuntimeStore,
  adapter: HostAdapter,
  effectiveProjection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  seedDiagnostics: CommandDiagnostic[]
): Promise<PrepareResumeRuntimeResult> {
  const diagnostics = [...seedDiagnostics];
  const { brief, envelope } = await buildResumeArtifactsFromProjection(
    store,
    adapter,
    effectiveProjection
  );
  if (brief.activeAssignments.length === 0 || !envelope) {
    throw new Error("No active assignment is available to resume.");
  }

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

async function buildReclaimedResumeResult(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  resumeEnvelope: TaskEnvelope,
  envelopePath: string,
  diagnostics: CommandDiagnostic[],
  execution: SessionExecution,
  attachment: RuntimeAttachment,
  claim: AssignmentClaim
): Promise<ResumeRuntimeResult> {
  const finalArtifacts = await buildResumeArtifactsFromProjection(
    store,
    adapter,
    projection,
    true
  );
  diagnostics.push(
    ...(await persistResumeEnvelopeAndTelemetry(
      store,
      adapter,
      projection,
      finalArtifacts.envelope ?? resumeEnvelope,
      undefined
    ))
  );
  return {
    mode: "reclaimed",
    projection,
    brief: finalArtifacts.brief,
    envelope: finalArtifacts.envelope ?? resumeEnvelope,
    envelopePath,
    diagnostics,
    execution,
    attachment,
    claim
  };
}

function requireReclaimedResumeBinding(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  attachmentId: string,
  claimId: string,
  context: string
): {
  attachment: RuntimeAttachment;
  claim: AssignmentClaim;
} {
  const attachment = projection.attachments.get(attachmentId);
  const claim = projection.claims.get(claimId);
  if (!attachment || !claim) {
    throw new Error(
      `Attachment ${attachmentId} or claim ${claimId} disappeared during ${context}.`
    );
  }
  return { attachment, claim };
}

async function buildReclaimedResumeResultForTarget(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  resumeEnvelope: TaskEnvelope,
  envelopePath: string,
  diagnostics: CommandDiagnostic[],
  execution: SessionExecution,
  attachmentId: string,
  claimId: string,
  context: string
): Promise<ResumeRuntimeResult> {
  const { attachment, claim } = requireReclaimedResumeBinding(
    projection,
    attachmentId,
    claimId,
    context
  );
  return buildReclaimedResumeResult(
    store,
    adapter,
    projection,
    resumeEnvelope,
    envelopePath,
    diagnostics,
    execution,
    attachment,
    claim
  );
}

async function recoverReclaimedResumeResult(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  assignmentId: string,
  attachmentId: string,
  claimId: string,
  verifiedSessionId: string | undefined,
  options: ProjectionWriteOptions,
  warningPrefix: string,
  stoppedAt: string | undefined,
  buildPreparedResult: (
    projection: Awaited<ReturnType<typeof loadOperatorProjection>>
  ) => Promise<ResumeRuntimeResult>,
  resumeEnvelope: TaskEnvelope,
  envelopePath: string,
  diagnostics: CommandDiagnostic[],
  context: string
): Promise<ResumeRuntimeResult> {
  const recoveredResume = await recoverCompletedWrappedExecution(
    store,
    adapter,
    projection,
    assignmentId,
    attachmentId,
    claimId,
    verifiedSessionId,
    options,
    warningPrefix,
    stoppedAt
  );
  diagnostics.push(...recoveredResume.diagnostics);
  if (!recoveredResume.execution) {
    return buildPreparedResult(recoveredResume.projection);
  }
  return buildReclaimedResumeResultForTarget(
    store,
    adapter,
    recoveredResume.projection,
    resumeEnvelope,
    envelopePath,
    diagnostics,
    recoveredResume.execution,
    attachmentId,
    claimId,
    context
  );
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
  try {
    if (unmatchedActiveLeases.length > 0) {
      throw new Error(`Assignment ${unmatchedActiveLeases[0]!} already has an active host run lease.`);
    }
    const resumableTarget = selectSingleResumableAttachmentClaim(reconciled.projection);
    if (!resumableTarget) {
      return await buildPreparedResult(reconciled.projection);
    }
    const target = resumableTarget;
    const assignment = reconciled.projection.assignments.get(target.claim.assignmentId);
    if (!assignment) {
      throw new Error(
        `Invalid runtime state: active claim ${target.claim.id} references missing assignment ${target.claim.assignmentId}.`
      );
    }
    if (!adapter.getCapabilities().supportsNativeSessionResume || !adapter.resumeSession) {
      return await buildPreparedResult(reconciled.projection);
    }

    const resumeProjection = projectionForRunnableAssignment(reconciled.projection, assignment.id);
    const resumeBrief = buildRecoveryBrief(resumeProjection, {
      allowAttachmentResumeAction: false
    });
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
            effectiveProjection = await AttachmentLifecycleService.activateAttachmentSession(
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
      const failedResume = await AttachmentLifecycleService.orphanAttachmentClaimAndRequeue(
        store,
        adapter,
        effectiveProjection,
        target.attachment,
        target.claim,
        `Wrapped same-session resume failed. ${error instanceof Error ? error.message : String(error)}`,
        resumeWriteOptions
      );
      diagnostics.push(...failedResume.diagnostics);
      return await buildPreparedResult(failedResume.projection);
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
        return await recoverReclaimedResumeResult(
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
          resumeResult.stoppedAt,
          buildPreparedResult,
          resumeEnvelope,
          envelopePath,
          diagnostics,
          "recovered resume finalization"
        );
      }
      case "unverified_failed": {
        const failedResume = await AttachmentLifecycleService.orphanAttachmentClaimAndRequeue(
          store,
          adapter,
          effectiveProjection,
          target.attachment,
          target.claim,
          resumeResult.warning ?? "Wrapped same-session resume failed.",
          resumeWriteOptions
        );
        diagnostics.push(...failedResume.diagnostics);
        return await buildPreparedResult(failedResume.projection);
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
      effectiveProjection = await AttachmentLifecycleService.finalizeAttachmentAuthority(
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
      return await recoverReclaimedResumeResult(
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
        reclaimedResume.stoppedAt,
        buildPreparedResult,
        resumeEnvelope,
        envelopePath,
        diagnostics,
        "resume finalization"
      );
    }
    return await buildReclaimedResumeResultForTarget(
      store,
      adapter,
      effectiveProjection,
      resumeEnvelope,
      envelopePath,
      diagnostics,
      {
        outcome: reclaimedResume.outcome,
        run: reclaimedResume.run
      },
      target.attachment.id,
      target.claim.id,
      "resume finalization"
    );
  } catch (error) {
    throw attachCommandDiagnostics(error, diagnostics);
  }
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
  const diagnostics: CommandDiagnostic[] = [...projectionBeforeResult.diagnostics];
  const launchWriteOptions = {
    snapshotFallback: projectionBeforeResult.snapshotFallback
  } satisfies ProjectionWriteOptions;
  const unmatchedActiveLeases = listUnmatchedActiveLeases(
    reconciled.activeLeases,
    listAuthoritativeAttachmentClaims(projectionBefore)
  );
  try {
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
    const blocking = selectSingleAuthoritativeAttachmentClaim(projectionBefore);
    if (blocking) {
      throw new Error(
        `Assignment ${blocking.claim.assignmentId} is already claimed by authoritative attachment ${blocking.attachment.id}.`
      );
    }
    const claimedRun = await adapter.claimRunLease(store, projectionBefore, assignment.id);
    const launchAuthority = AttachmentLifecycleService.createLaunchAuthority(adapter, assignment.id);
    let authorityPersisted = false;
    try {
      projectionBefore = await AttachmentLifecycleService.persistAttachmentAuthority(
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
          launchedProjection = await AttachmentLifecycleService.activateAttachmentSession(
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
      projectionAfter = await AttachmentLifecycleService.finalizeAttachmentAuthority(
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
          projectionBefore = await AttachmentLifecycleService.releaseAttachmentClaim(
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
          launchedProjection = await AttachmentLifecycleService.releaseAttachmentClaim(
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
  } catch (error) {
    throw attachCommandDiagnostics(error, diagnostics);
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
  return adapter.inspectRun(store, assignmentId);
}

export async function inspectRuntimeRunWithContext(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId?: string,
  projection?: Awaited<ReturnType<typeof loadOperatorProjection>>
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
  const effectiveProjection = projection ?? await loadOperatorProjection(store);
  const hostRun = await adapter.inspectRun(store, assignmentId);
  if (!hostRun) {
    return undefined;
  }
  const binding = getActiveClaimForAssignment(effectiveProjection, hostRun.assignmentId);
  return {
    hostRun,
    ...(binding
      ? {
          runtimeAttachment: {
            id: binding.attachment.id,
            state: binding.attachment.state,
            nativeSessionId: binding.attachment.nativeSessionId ?? "",
            claimId: binding.claim.id,
            claimState: binding.claim.state
          }
        }
      : {})
  };
}
