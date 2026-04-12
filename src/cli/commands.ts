import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeConfig } from "../config/types.js";
import type { HostAdapter, HostExecutionOutcome, TaskEnvelope } from "../adapters/contract.js";
import type { Assignment, DecisionPacket, ResultPacket } from "../core/types.js";
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

  const reconciled = await loadReconciledProjectionWithDiagnostics(store, adapter);
  const authoritativeLeaseAssignmentId = reconciled.activeLeases[0];
  if (authoritativeLeaseAssignmentId) {
    throw new Error(
      `Assignment ${authoritativeLeaseAssignmentId} already has an active host run lease.`
    );
  }
  const diagnostics = [...reconciled.diagnostics];
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
  const projectionBefore = reconciled.projection;
  if (reconciled.activeLeases.length > 0) {
    const assignmentId = reconciled.activeLeases[0]!;
    throw new Error(`Assignment ${assignmentId} already has an active host run lease.`);
  }
  let diagnostics: CommandDiagnostic[] = [...projectionBeforeResult.diagnostics];
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
  const claimedRun = await adapter.claimRunLease(store, projectionBefore, assignment.id);
  let executionStarted = false;
  let launchedProjection: Awaited<ReturnType<typeof loadOperatorProjection>> | undefined;
  let envelope: Awaited<ReturnType<HostAdapter["buildResumeEnvelope"]>> | undefined;
  let execution: Awaited<ReturnType<HostAdapter["executeAssignment"]>> | undefined;
  try {
    const envelopeProjection = projectionForRunnableAssignment(projectionBefore, assignment.id);
    const brief = buildRecoveryBrief(envelopeProjection);
    envelope = await adapter.buildResumeEnvelope(store, envelopeProjection, brief);
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
        const recovered = await loadReconciledProjectionWithDiagnostics(store, adapter);
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
