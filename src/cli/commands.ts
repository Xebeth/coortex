import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeConfig } from "../config/types.js";
import type { HostAdapter } from "../adapters/contract.js";
import { createBootstrapRuntime } from "../core/runtime.js";
import { buildRecoveryBrief } from "../recovery/brief.js";
import { RuntimeStore } from "../persistence/store.js";
import { toSnapshot } from "../projections/runtime-projection.js";
import { recordNormalizedTelemetry } from "../telemetry/recorder.js";
import { nowIso } from "../utils/time.js";
import type { CommandDiagnostic } from "./types.js";
import { diagnosticsFromWarning, loadOperatorProjection, loadOperatorProjectionWithDiagnostics } from "./runtime-state.js";
import {
  buildOutcomeEvents,
  getRunnableAssignment,
  loadReconciledProjectionWithDiagnostics,
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

export interface ResumeRuntimeResult {
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  brief: ReturnType<typeof buildRecoveryBrief>;
  envelope: Awaited<ReturnType<HostAdapter["buildResumeEnvelope"]>>;
  envelopePath: string;
  diagnostics: CommandDiagnostic[];
}

export interface RunRuntimeResult {
  projectionBefore: Awaited<ReturnType<typeof loadOperatorProjection>>;
  projectionAfter: Awaited<ReturnType<typeof loadOperatorProjection>>;
  assignment: ReturnType<typeof getRunnableAssignment>;
  envelope: Awaited<ReturnType<HostAdapter["buildResumeEnvelope"]>>;
  execution: Awaited<ReturnType<HostAdapter["executeAssignment"]>>;
  diagnostics: CommandDiagnostic[];
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

  const syncResult = await store.syncSnapshotFromEventsWithRecovery();
  const diagnostics = diagnosticsFromWarning(syncResult.warning, "event-log-repaired");
  const projection = syncResult.projection;
  await adapter.initialize(store, projection);
  const bootstrapBrief = buildRecoveryBrief(projection);
  const bootstrapEnvelope = await adapter.buildResumeEnvelope(store, projection, bootstrapBrief);
  await store.writeJsonArtifact("runtime/last-resume-envelope.json", bootstrapEnvelope);
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

export async function resumeRuntime(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<ResumeRuntimeResult> {
  const config = await store.loadConfig();
  if (!config) {
    throw new Error("Coortex is not initialized. Run `ctx init` first.");
  }

  const { projection, diagnostics } = await loadOperatorProjectionWithDiagnostics(store);
  const reconciled = await reconcileActiveRuns(store, adapter, projection);
  diagnostics.push(...reconciled.diagnostics);
  const effectiveProjection = reconciled.projection;
  const brief = buildRecoveryBrief(effectiveProjection);
  if (brief.activeAssignments.length === 0) {
    throw new Error("No active assignment is available to resume.");
  }
  const envelope = await adapter.buildResumeEnvelope(store, effectiveProjection, brief);
  const envelopePath = join(store.runtimeDir, "last-resume-envelope.json");
  await store.writeSnapshot(toSnapshot(effectiveProjection));
  await store.writeJsonArtifact("runtime/last-resume-envelope.json", envelope);
  const telemetry = await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry({
      eventType: "resume.requested",
      taskId: projection.sessionId,
      metadata: {
        envelopeChars: envelope.estimatedChars,
        trimApplied: envelope.trimApplied,
        trimmedFields: envelope.trimmedFields.length
      }
    })
  );
  diagnostics.push(...diagnosticsFromWarning(telemetry.warning, "telemetry-write-failed"));

  return {
    projection: effectiveProjection,
    brief,
    envelope,
    envelopePath: resolve(envelopePath),
    diagnostics
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
    projectionBeforeResult.projection
  );
  projectionBeforeResult.diagnostics.push(...reconciled.diagnostics);
  const projectionBefore = reconciled.projection;
  if (reconciled.activeLeases.length > 0) {
    const assignmentId = reconciled.activeLeases[0]!;
    throw new Error(`Assignment ${assignmentId} already has an active host run lease.`);
  }
  const assignment = getRunnableAssignment(projectionBefore);
  const claimedRun = adapter.claimRunLease
    ? await adapter.claimRunLease(store, projectionBefore, assignment.id)
    : undefined;
  let executionStarted = false;
  try {
    const envelopeProjection = projectionForRunnableAssignment(projectionBefore, assignment.id);
    const brief = buildRecoveryBrief(envelopeProjection);
    const envelope = await adapter.buildResumeEnvelope(store, envelopeProjection, brief);
    const launchedProjection = await markAssignmentInProgress(store, projectionBefore, assignment.id);

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
    const diagnostics = [
      ...projectionBeforeResult.diagnostics,
      ...diagnosticsFromWarning(startedTelemetry.warning, "telemetry-write-failed")
    ];

    executionStarted = true;
    const execution = await adapter.executeAssignment(store, launchedProjection, envelope, claimedRun);
    diagnostics.push(...diagnosticsFromWarning(execution.warning, "host-run-persist-failed"));
    const events = buildOutcomeEvents(launchedProjection, execution, adapter);
    for (const event of events) {
      await store.appendEvent(event);
    }
    const projectionAfterResult = await store.syncSnapshotFromEventsWithRecovery();
    const projectionAfter = projectionAfterResult.projection;
    diagnostics.push(...diagnosticsFromWarning(projectionAfterResult.warning, "event-log-repaired"));

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
      diagnostics
    };
  } catch (error) {
    if (!executionStarted) {
      await adapter.releaseRunLease?.(store, assignment.id);
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
  return adapter.inspectRun(store, assignmentId);
}
