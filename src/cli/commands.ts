import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeConfig } from "../config/types.js";
import type { HostAdapter } from "../adapters/contract.js";
import { buildRecoveryBrief } from "../recovery/brief.js";
import { RuntimeStore } from "../persistence/store.js";
import { toSnapshot } from "../projections/runtime-projection.js";
import { recordNormalizedTelemetry } from "../telemetry/recorder.js";
import { nowIso } from "../utils/time.js";
import {
  buildWorkflowBootstrap
} from "../workflows/index.js";
import type { CommandDiagnostic } from "./types.js";
import {
  diagnosticsFromWarning,
  loadOperatorProjection,
  loadOperatorProjectionWithDiagnostics,
  loadWorkflowAwareProjectionWithDiagnostics
} from "./runtime-state.js";
import {
  buildOutcomeEvents,
  getRunnableAssignment,
  markAssignmentInProgress,
  projectionForRunnableAssignment
} from "./run-operations.js";
import { loadInspectRuntimeContext } from "./inspect-context.js";
import {
  synthesizeRecoveredExecution,
  synthesizeRecoveredExecutionFromReconciliation
} from "./recovered-outcomes.js";
import {
  buildRecoveredExecutionEnvelope,
  buildWorkflowAwareEnvelope
} from "./workflow-envelope.js";

export type { CommandDiagnostic } from "./types.js";
export { loadOperatorProjection, loadOperatorProjectionWithDiagnostics } from "./runtime-state.js";
export { loadReconciledProjectionWithDiagnostics } from "./run-operations.js";

const RUNTIME_NOT_INITIALIZED_MESSAGE = "Coortex is not initialized. Run `ctx init` first.";

async function ensureRuntimeInitialized(store: RuntimeStore): Promise<void> {
  if (!await store.loadConfig()) {
    throw new Error(RUNTIME_NOT_INITIALIZED_MESSAGE);
  }
}

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
  recoveredOutcome: boolean;
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
  const bootstrap = buildWorkflowBootstrap({
    sessionId,
    adapterId: adapter.id,
    host: adapter.host
  });

  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const syncResult = await store.syncSnapshotFromEventsWithRecovery();
  const diagnostics = diagnosticsFromWarning(syncResult.warning, "event-log-repaired");
  let projection = syncResult.projection;
  const workflowAware = await loadWorkflowAwareProjectionWithDiagnostics(store, adapter);
  projection = workflowAware.projection;
  diagnostics.push(...workflowAware.diagnostics);
  await adapter.initialize(store, projection);
  const bootstrapBrief = buildRecoveryBrief(projection);
  const bootstrapEnvelope = await buildWorkflowAwareEnvelope(
    store,
    adapter,
    projection,
    bootstrapBrief
  );
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
  await ensureRuntimeInitialized(store);

  const workflowAware = await loadWorkflowAwareProjectionWithDiagnostics(store, adapter);
  assertNoActiveWorkflowLease(workflowAware.activeLeases);
  const diagnostics = [...workflowAware.diagnostics];
  const effectiveProjection = workflowAware.projection;
  const brief = buildRecoveryBrief(effectiveProjection);
  if (brief.activeAssignments.length === 0) {
    throw new Error("No active assignment is available to resume.");
  }
  const envelope = await buildWorkflowAwareEnvelope(store, adapter, effectiveProjection, brief);
  const envelopePath = join(store.runtimeDir, "last-resume-envelope.json");
  await store.writeSnapshot(toSnapshot(effectiveProjection));
  await store.writeJsonArtifact("runtime/last-resume-envelope.json", envelope);
  const telemetry = await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry({
      eventType: "resume.requested",
      taskId: effectiveProjection.sessionId,
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
  await ensureRuntimeInitialized(store);

  const projectionBeforeResult = await loadOperatorProjectionWithDiagnostics(store);
  const workflowAware = await loadWorkflowAwareProjectionWithDiagnostics(store, adapter);
  const projectionBefore = workflowAware.projection;
  assertNoActiveWorkflowLease(workflowAware.activeLeases);
  let diagnostics: CommandDiagnostic[] = [...workflowAware.diagnostics];
  if (workflowAware.recoveredRunRecord) {
    const recoveredExecution = synthesizeRecoveredExecution(workflowAware.recoveredRunRecord);
    const recoveredAssignment = projectionBefore.assignments.get(
      workflowAware.recoveredRunRecord.assignmentId
    );
    if (recoveredExecution && recoveredAssignment) {
      const recoveredEnvelope = await buildRecoveredExecutionEnvelope(
        store,
        adapter,
        projectionBefore,
        recoveredAssignment.id
      );
      return {
        projectionBefore,
        projectionAfter: projectionBefore,
        assignment: recoveredAssignment,
        envelope: recoveredEnvelope,
        execution: recoveredExecution,
        recoveredOutcome: true,
        diagnostics
      };
    }
  }
  let assignment: ReturnType<typeof getRunnableAssignment>;
  try {
    assignment = getRunnableAssignment(projectionBefore);
  } catch (error) {
    const recoveredOutcome = await synthesizeRecoveredExecutionFromReconciliation(
      store,
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
  const claimedRun = await adapter.claimRunLease(store, projectionBefore, assignment.id);
  let executionStarted = false;
  let launchedProjection: Awaited<ReturnType<typeof loadOperatorProjection>> | undefined;
  let envelope: Awaited<ReturnType<HostAdapter["buildResumeEnvelope"]>> | undefined;
  let execution: Awaited<ReturnType<HostAdapter["executeAssignment"]>> | undefined;
  try {
    const envelopeProjection = projectionForRunnableAssignment(projectionBefore, assignment.id);
    const brief = buildRecoveryBrief(envelopeProjection);
    envelope = await buildWorkflowAwareEnvelope(store, adapter, envelopeProjection, brief);
    launchedProjection = await markAssignmentInProgress(store, projectionBefore, assignment.id);

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
    execution = await adapter.executeAssignment(store, launchedProjection, envelope, claimedRun);
    diagnostics.push(...diagnosticsFromWarning(execution.warning, "host-run-persist-failed"));
    const events = buildOutcomeEvents(launchedProjection, execution, adapter);
    for (const event of events) {
      await store.appendEvent(event);
    }
    const projectionAfterResult = await loadWorkflowAwareProjectionWithDiagnostics(store, adapter);
    const projectionAfter = projectionAfterResult.projection;
    diagnostics.push(...projectionAfterResult.diagnostics);

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
    } else if (launchedProjection && envelope) {
      const recoveredExecution = synthesizeRecoveredExecution(
        await adapter.inspectRun(store, assignment.id)
      );
      if (recoveredExecution) {
        const recovered = await loadWorkflowAwareProjectionWithDiagnostics(store, adapter);
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
          projectionAfter: recovered.projection,
          assignment,
          envelope,
          execution: recoveredExecution,
          recoveredOutcome: false,
          diagnostics
        };
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
  await ensureRuntimeInitialized(store);
  return adapter.inspectRun(store, assignmentId);
}

export async function inspectRuntimeContext(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId?: string
) {
  await ensureRuntimeInitialized(store);
  return loadInspectRuntimeContext(store, adapter, assignmentId);
}

function assertNoActiveWorkflowLease(activeLeases: string[]): void {
  const assignmentId = activeLeases[0];
  if (assignmentId) {
    throw new Error(`Assignment ${assignmentId} already has an active host run lease.`);
  }
}
