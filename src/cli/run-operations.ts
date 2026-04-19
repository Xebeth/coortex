import { randomUUID } from "node:crypto";

import type {
  HostAdapter,
  HostExecutionOutcome,
  TaskEnvelope
} from "../adapters/contract.js";
import {
  buildCompletedHostExecutionOutcomeFromDecisionCapture,
  buildCompletedHostExecutionOutcomeFromResultCapture,
  matchesDecisionIdentity,
  matchesResultIdentity,
  synthesizeHostExecutionOutcomeFromCompletedRecord
} from "../adapters/host-run-records.js";
import type { RuntimeEvent } from "../core/events.js";
import {
  listAuthoritativeAttachmentClaims,
  listResumableAttachmentClaims
} from "../projections/attachment-claim-queries.js";
import {
  findLatestOpenAssignmentDecision,
  findLatestTerminalAssignmentResult
} from "../projections/assignment-outcome-queries.js";
import { selectRunnableProjection } from "../recovery/host-runs.js";
import { loadReconciledProjectionWithDiagnostics } from "./run-reconciliation.js";
import { nowIso } from "../utils/time.js";
import { RuntimeStore } from "../persistence/store.js";
import { buildRecoveryBrief } from "../recovery/brief.js";

import { AttachmentLifecycleService } from "./attachment-lifecycle.js";
import {
  cleanupHostRunArtifactsWithLeaseVerification
} from "./host-run-cleanup.js";
import {
  applyRuntimeEventsToProjection,
  persistProjectionEvents,
  type ProjectionWriteOptions
} from "./projection-write.js";
import type { CommandDiagnostic } from "./types.js";
import { buildNextRuntimeStatus } from "../recovery/runtime-status.js";
import { diagnosticsFromWarning, loadOperatorProjection } from "./runtime-state.js";
import type {
  Assignment,
  DecisionPacket,
  ResultPacket
} from "../core/types.js";

export interface WrappedExecutionRecoveryResult {
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  execution?: HostExecutionOutcome;
  diagnostics: CommandDiagnostic[];
}

export interface RecoveredExecutionFromReconciliation {
  assignment: Assignment;
  envelope: TaskEnvelope;
  execution: HostExecutionOutcome;
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
  const events: RuntimeEvent[] = [
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "assignment.updated",
      payload: {
        assignmentId,
        patch: {
          state: "in_progress",
          lastStaleRunInstanceId: undefined,
          updatedAt: timestamp
        }
      }
    }
  ];
  if (projection.status.lastStaleRunInstanceId) {
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "status.updated",
      payload: {
        status: {
          ...projection.status,
          lastStaleRunInstanceId: undefined,
          lastDurableOutputAt: timestamp
        }
      }
    });
  }
  if (!options?.snapshotFallback) {
    await store.appendEvents(events);
    return (await store.syncSnapshotFromEventsWithRecovery()).projection;
  }
  return store.mutateSnapshotProjection((latestProjection) =>
    applyRuntimeEventsToProjection(latestProjection, events)
  );
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
  const recoveredExecution = synthesizeHostExecutionOutcomeFromCompletedRecord(
    await adapter.inspectRun(store, assignmentId)
  );
  if (recoveredExecution) {
    const recovered = await loadReconciledProjectionWithDiagnostics(store, adapter);
    const projectionAfter = await AttachmentLifecycleService.finalizeAttachmentAuthority(
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
    const detachedProjection = await AttachmentLifecycleService.updateAttachmentToDetachedResumable(
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

export function synthesizeRecoveredExecutionFromReconciliation(
  adapter: HostAdapter,
  projectionBeforeReconciliation: Awaited<ReturnType<typeof loadOperatorProjection>>,
  projectionAfterReconciliation: Awaited<ReturnType<typeof loadOperatorProjection>>
): RecoveredExecutionFromReconciliation | undefined {
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
      execution: buildCompletedHostExecutionOutcomeFromDecisionCapture(
        recoveredDecision.decision
      )
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
    execution: buildCompletedHostExecutionOutcomeFromResultCapture(
      recoveredResult.result
    )
  };
}

export function buildOutcomeEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  execution: Pick<HostExecutionOutcome, "outcome" | "run">,
  adapter: HostAdapter
): RuntimeEvent[] {
  const timestamp = nowIso();
  const assignmentId = execution.run.assignmentId;
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
  const postTransitionProjection = applyRuntimeEventsToProjection(projection, events);
  const status = buildNextRuntimeStatus(
    postTransitionProjection,
    assignmentId,
    execution.outcome.kind === "decision"
      ? {
          kind: "decision",
          blockerSummary: execution.outcome.capture.blockerSummary,
          state: execution.outcome.capture.state ?? "open"
        }
      : {
          kind: "result",
          status: execution.outcome.capture.status
        },
    timestamp
  );
  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "status.updated",
    payload: { status }
  });

  return events;
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
    const decision = findLatestOpenAssignmentDecision(
      projectionAfterReconciliation,
      assignment.id
    );
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
    const result = findLatestTerminalAssignmentResult(
      projectionAfterReconciliation,
      assignment.id
    );
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

function hasMatchingDecision(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  decision: DecisionPacket
): boolean {
  return [...projection.decisions.values()].some((candidate) =>
    matchesDecisionIdentity(decision, candidate)
  );
}

function hasMatchingResult(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  result: ResultPacket
): boolean {
  return [...projection.results.values()].some((candidate) =>
    matchesResultIdentity(result, candidate)
  );
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
    const unresolvedDecision = findLatestOpenAssignmentDecision(
      projection,
      activeAssignment.id
    );
    if (activeAssignment.state === "blocked" || unresolvedDecision) {
      continue;
    }
    return activeAssignment;
  }

  const blockedAssignment = activeAssignments[0]!;
  const unresolvedDecision = findLatestOpenAssignmentDecision(
    projection,
    blockedAssignment.id
  );
  const suffix = unresolvedDecision
    ? ` Resolve decision ${unresolvedDecision.decisionId} first.`
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
    return execution.outcome.capture.state === "resolved"
      ? ("in_progress" as const)
      : ("blocked" as const);
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
