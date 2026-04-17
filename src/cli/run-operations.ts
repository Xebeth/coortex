import { randomUUID } from "node:crypto";

import type {
  HostAdapter,
  HostExecutionOutcome
} from "../adapters/contract.js";
import type { RuntimeEvent } from "../core/events.js";
import type { HostRunRecord } from "../core/types.js";
import { selectRunnableProjection } from "../recovery/host-runs.js";
import {
  listAuthoritativeAttachmentClaims,
  listResumableAttachmentClaims
} from "./attachment-claim-queries.js";
import { loadReconciledProjectionWithDiagnostics } from "./run-reconciliation.js";
import { nowIso } from "../utils/time.js";
import { RuntimeStore } from "../persistence/store.js";

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
import { diagnosticsFromWarning, loadOperatorProjection } from "./runtime-state.js";

export interface WrappedExecutionRecoveryResult {
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  execution?: HostExecutionOutcome;
  diagnostics: CommandDiagnostic[];
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
