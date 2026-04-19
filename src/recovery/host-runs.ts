import { randomUUID } from "node:crypto";

import type { RuntimeEvent } from "../core/events.js";
import type {
  HostRunRecord,
  RuntimeProjection,
  WorkflowRunAttemptIdentity
} from "../core/types.js";
import { getNativeRunId, isRunLeaseExpired } from "../core/run-state.js";
import { nowIso } from "../utils/time.js";

export interface RecoveryDiagnostic {
  level: "warning";
  code: "active-run-present" | "stale-run-reconciled" | "hidden-run-cleaned";
  message: string;
}

export interface StaleRunReconciliation {
  staleRecord: HostRunRecord;
  events: RuntimeEvent[];
  diagnostic: RecoveryDiagnostic;
  telemetryMetadata: {
    nativeRunId: string;
    leaseExpiresAt: string;
    heartbeatAt: string;
    staleAt: string;
  };
}

export interface WorkflowStaleRunRecovery {
  staleRecord: HostRunRecord;
  diagnostic: RecoveryDiagnostic;
  telemetryMetadata: {
    nativeRunId: string;
    leaseExpiresAt: string;
    heartbeatAt: string;
    staleAt: string;
  };
}

export interface WorkflowHiddenRunCleanup {
  staleRecord: HostRunRecord;
  diagnostic: RecoveryDiagnostic;
  telemetryMetadata: {
    nativeRunId: string;
    leaseExpiresAt: string;
    heartbeatAt: string;
    staleAt: string;
  };
}

export interface WorkflowRunTruth {
  isCurrentAssignment: boolean;
  beforeCurrentAttempt: boolean;
  missingAttemptIdentity: boolean;
  hasLeaseArtifact: boolean;
  activeLease: boolean;
  staleCandidate: boolean;
  hiddenStaleCandidate: boolean;
  recoverableCompletedOutcome: boolean;
  hasDurableRecordOutcome: boolean;
  hasDurableCurrentOutcome: boolean;
  hasDurableStaleRecovery: boolean;
}

export interface WorkflowRunHandling {
  kind: "active_lease" | "recover_completed" | "emit_hidden_cleanup" | "cleanup_only" | "ignore";
  cleanupRecord?: HostRunRecord;
}

export function buildWorkflowStaleRunRecovery(
  record: HostRunRecord,
  timestamp = nowIso()
): WorkflowStaleRunRecovery {
  const stale = buildWorkflowStaleRecord(record, timestamp);
  return {
    staleRecord: stale.staleRecord,
    diagnostic: {
      level: "warning",
      code: "stale-run-reconciled",
      message: `Requeued stale host run for assignment ${record.assignmentId}${
        stale.nativeRunId ? ` (${stale.nativeRunId})` : ""
      }.`
    },
    telemetryMetadata: stale.telemetryMetadata
  };
}

export function buildWorkflowHiddenRunCleanup(
  record: HostRunRecord,
  timestamp = nowIso()
): WorkflowHiddenRunCleanup {
  const stale = buildWorkflowStaleRecord(record, timestamp);
  return {
    staleRecord: stale.staleRecord,
    diagnostic: {
      level: "warning",
      code: "hidden-run-cleaned",
      message: `Cleared stale host run artifacts for non-current workflow assignment ${record.assignmentId}${
        stale.nativeRunId ? ` (${stale.nativeRunId})` : ""
      }.`
    },
    telemetryMetadata: stale.telemetryMetadata
  };
}

function buildWorkflowStaleRecord(
  record: HostRunRecord,
  timestamp: string
): {
  staleRecord: HostRunRecord;
  nativeRunId: string | undefined;
  telemetryMetadata: {
    nativeRunId: string;
    leaseExpiresAt: string;
    heartbeatAt: string;
    staleAt: string;
  };
} {
  const staleReasonCode = record.staleReasonCode ?? describeStaleRunReasonCode(record);
  const staleReason = record.staleReason ?? describeStaleRunReason(record);
  const staleRecord: HostRunRecord = {
    ...record,
    state: "completed",
    staleAt: timestamp,
    staleReasonCode,
    staleReason
  };
  const nativeRunId = getNativeRunId(record);

  return {
    staleRecord,
    nativeRunId,
    telemetryMetadata: {
      nativeRunId: nativeRunId ?? "",
      leaseExpiresAt: record.leaseExpiresAt ?? "",
      heartbeatAt: record.heartbeatAt ?? "",
      staleAt: timestamp
    }
  };
}

export function deriveWorkflowRunTruth(
  projection: RuntimeProjection,
  record: HostRunRecord,
  options: {
    hasLeaseArtifact: boolean;
  }
): WorkflowRunTruth {
  const isCurrentAssignment = projection.workflowProgress?.currentAssignmentId === record.assignmentId;
  const missingAttemptIdentity = isCurrentAssignment && isCurrentWorkflowAttemptIdentityMissing(projection, record);
  const beforeCurrentAttempt = isCurrentAssignment &&
    !missingAttemptIdentity &&
    isWorkflowRecordBeforeCurrentAttempt(projection, record);
  return {
    isCurrentAssignment,
    beforeCurrentAttempt,
    missingAttemptIdentity,
    hasLeaseArtifact: options.hasLeaseArtifact,
    activeLease:
      !beforeCurrentAttempt &&
      !missingAttemptIdentity &&
      record.state === "running" &&
      !isRunLeaseExpired(record),
    staleCandidate:
      isCurrentAssignment &&
      !beforeCurrentAttempt &&
      !missingAttemptIdentity &&
      isCurrentWorkflowStaleCandidate(projection, record),
    hiddenStaleCandidate:
      !isCurrentAssignment &&
      options.hasLeaseArtifact &&
      isWorkflowStaleMetadata(record),
    recoverableCompletedOutcome:
      isCurrentAssignment &&
      !beforeCurrentAttempt &&
      !missingAttemptIdentity &&
      isRecoverableWorkflowCompletedRun(projection, record),
    hasDurableRecordOutcome: hasDurableWorkflowOutcomeForRunRecord(projection, record),
    hasDurableCurrentOutcome:
      isCurrentAssignment && hasDurableWorkflowOutcomeForCurrentAssignment(projection),
    hasDurableStaleRecovery:
      isCurrentAssignment &&
      hasDurableWorkflowStaleRecoveryForCurrentAssignment(projection, record)
  };
}

function shouldRecoverWorkflowCompletedRun(truth: WorkflowRunTruth): boolean {
  return truth.recoverableCompletedOutcome;
}

function shouldCleanupWorkflowRunArtifacts(truth: WorkflowRunTruth): boolean {
  return truth.hasLeaseArtifact && (
    truth.beforeCurrentAttempt ||
    truth.missingAttemptIdentity ||
    truth.hasDurableRecordOutcome ||
    truth.hasDurableCurrentOutcome ||
    truth.hasDurableStaleRecovery ||
    truth.hiddenStaleCandidate
  );
}

export function selectWorkflowVisibleRunRecord(
  projection: RuntimeProjection,
  record: HostRunRecord | undefined
): HostRunRecord | undefined {
  if (!record) {
    return undefined;
  }
  const currentAssignmentId = projection.workflowProgress?.currentAssignmentId;
  if (!currentAssignmentId || currentAssignmentId !== record.assignmentId) {
    return record;
  }
  return (
    isCurrentWorkflowAttemptIdentityMissing(projection, record) ||
    isWorkflowRecordBeforeCurrentAttempt(projection, record)
  )
    ? undefined
    : record;
}

function shouldEmitHiddenWorkflowCleanup(truth: WorkflowRunTruth): boolean {
  return truth.hiddenStaleCandidate;
}

export function deriveWorkflowCleanupRecord(record: HostRunRecord): HostRunRecord {
  return record.state === "completed" && record.terminalOutcome
    ? record
    : buildWorkflowStaleRunRecovery(record).staleRecord;
}

export function deriveWorkflowRunHandling(
  record: HostRunRecord,
  truth: WorkflowRunTruth
): WorkflowRunHandling {
  if (truth.activeLease) {
    return { kind: "active_lease" };
  }
  if (shouldRecoverWorkflowCompletedRun(truth)) {
    return {
      kind: "recover_completed",
      cleanupRecord: deriveWorkflowCleanupRecord(record)
    };
  }
  if (shouldEmitHiddenWorkflowCleanup(truth)) {
    return {
      kind: "emit_hidden_cleanup",
      cleanupRecord: deriveWorkflowCleanupRecord(record)
    };
  }
  if (shouldCleanupWorkflowRunArtifacts(truth)) {
    return {
      kind: "cleanup_only",
      cleanupRecord: deriveWorkflowCleanupRecord(record)
    };
  }
  return { kind: "ignore" };
}

export function selectRunnableProjection(
  projection: RuntimeProjection,
  assignmentId: string
): RuntimeProjection {
  return {
    ...projection,
    status: {
      ...projection.status,
      currentObjective:
        projection.assignments.get(assignmentId)?.objective ?? projection.status.currentObjective,
      activeAssignmentIds: [assignmentId]
    },
    decisions: new Map(
      [...projection.decisions.entries()].filter(([, decision]) => decision.assignmentId === assignmentId)
    )
  };
}

export function createActiveRunDiagnostic(
  assignmentId: string,
  record: HostRunRecord
): RecoveryDiagnostic {
  const nativeRunId = getNativeRunId(record);
  return {
    level: "warning",
    code: "active-run-present",
    message: `Assignment ${assignmentId} still has an active host run lease${
      nativeRunId ? ` (${nativeRunId})` : ""
    }.`
  };
}

export function buildStaleRunReconciliation(
  projection: RuntimeProjection,
  assignmentId: string,
  record: HostRunRecord,
  timestamp = nowIso()
): StaleRunReconciliation {
  const stale = buildWorkflowStaleRecord(record, timestamp);
  const assignment = projection.assignments.get(assignmentId);
  const objective = assignment?.objective ?? projection.status.currentObjective;
  const events: RuntimeEvent[] = [
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

  return {
    staleRecord: stale.staleRecord,
    events,
    diagnostic: {
      level: "warning",
      code: "stale-run-reconciled",
      message: `Requeued stale host run for assignment ${assignmentId}${
        stale.nativeRunId ? ` (${stale.nativeRunId})` : ""
      }.`
    },
    telemetryMetadata: stale.telemetryMetadata
  };
}

function describeStaleRunReasonCode(
  record: HostRunRecord
): NonNullable<HostRunRecord["staleReasonCode"]> {
  if (!record.leaseExpiresAt) {
    return "missing_lease_expiry";
  }
  if (!Number.isNaN(Date.parse(record.leaseExpiresAt))) {
    return "expired_lease";
  }
  return "invalid_lease_expiry";
}

function describeStaleRunReason(record: HostRunRecord): string {
  if (!record.leaseExpiresAt) {
    return "Run record remained in running state without a lease expiry.";
  }
  if (!Number.isNaN(Date.parse(record.leaseExpiresAt))) {
    return `Run lease expired at ${record.leaseExpiresAt}.`;
  }
  return `Run record has an invalid lease expiry: ${record.leaseExpiresAt}.`;
}

function isRecoverableWorkflowCompletedRun(
  projection: RuntimeProjection,
  record: HostRunRecord
): boolean {
  if (record.state !== "completed" || !record.terminalOutcome) {
    return false;
  }
  const currentAssignmentId = projection.workflowProgress?.currentAssignmentId;
  if (!currentAssignmentId || currentAssignmentId !== record.assignmentId) {
    return false;
  }
  if (isCurrentWorkflowAttemptIdentityMissing(projection, record) ||
      isWorkflowRecordBeforeCurrentAttempt(projection, record)) {
    return false;
  }
  if (record.terminalOutcome.kind === "result") {
    return !hasRecoveredResult(projection, record.terminalOutcome.result);
  }
  return !hasRecoveredDecision(projection, record.terminalOutcome.decision);
}

function isCurrentWorkflowStaleCandidate(
  projection: RuntimeProjection,
  record: HostRunRecord
): boolean {
  const currentAssignmentId = projection.workflowProgress?.currentAssignmentId;
  if (!currentAssignmentId || currentAssignmentId !== record.assignmentId) {
    return false;
  }
  return isWorkflowStaleMetadata(record);
}

function isWorkflowStaleMetadata(record: HostRunRecord): boolean {
  return (
    (record.state === "completed" && Boolean(record.staleReasonCode) && !record.terminalOutcome) ||
    isRunLeaseExpired(record)
  );
}

function hasRecoveredResult(
  projection: RuntimeProjection,
  result: Extract<NonNullable<HostRunRecord["terminalOutcome"]>, { kind: "result" }>["result"]
): boolean {
  return [...projection.results.values()].some(
    (candidate) =>
      candidate.assignmentId === projection.workflowProgress?.currentAssignmentId &&
      ((result.resultId && candidate.resultId === result.resultId) ||
        (candidate.status === result.status &&
          candidate.summary === result.summary &&
          candidate.createdAt === result.createdAt))
  );
}

function hasRecoveredDecision(
  projection: RuntimeProjection,
  decision: Extract<NonNullable<HostRunRecord["terminalOutcome"]>, { kind: "decision" }>["decision"]
): boolean {
  return [...projection.decisions.values()].some(
    (candidate) =>
      candidate.assignmentId === projection.workflowProgress?.currentAssignmentId &&
      ((decision.decisionId && candidate.decisionId === decision.decisionId) ||
        (candidate.blockerSummary === decision.blockerSummary &&
          candidate.recommendedOption === decision.recommendedOption &&
          candidate.createdAt === decision.createdAt))
  );
}

function workflowRecoveryLowerBound(
  projection: RuntimeProjection,
  attemptStartedAt: string
): string {
  return projection.workflowProgress?.currentModuleAttempt &&
    projection.workflowProgress.currentModuleAttempt > 1
    ? attemptStartedAt
    : "";
}

function hasDurableWorkflowOutcomeForRunRecord(
  projection: RuntimeProjection,
  record: HostRunRecord
): boolean {
  const outcome = record.terminalOutcome;
  if (!outcome) {
    return false;
  }
  if (outcome.kind === "result") {
    return [...projection.results.values()].some(
      (candidate) =>
        candidate.assignmentId === record.assignmentId &&
        ((outcome.result.resultId &&
          candidate.resultId === outcome.result.resultId) ||
          (candidate.status === outcome.result.status &&
            candidate.summary === outcome.result.summary &&
            candidate.createdAt === outcome.result.createdAt))
    );
  }
  return [...projection.decisions.values()].some(
    (candidate) =>
      candidate.assignmentId === record.assignmentId &&
      ((outcome.decision.decisionId &&
        candidate.decisionId === outcome.decision.decisionId) ||
        (candidate.blockerSummary === outcome.decision.blockerSummary &&
          candidate.recommendedOption === outcome.decision.recommendedOption &&
          candidate.createdAt === outcome.decision.createdAt))
  );
}

function hasDurableWorkflowOutcomeForCurrentAssignment(
  projection: RuntimeProjection
): boolean {
  const assignmentId = projection.workflowProgress?.currentAssignmentId;
  if (!assignmentId) {
    return false;
  }
  const attemptStartedAt =
    projection.workflowProgress?.modules[projection.workflowProgress.currentModuleId]?.enteredAt ?? "";
  const recoveryLowerBound = workflowRecoveryLowerBound(projection, attemptStartedAt);
  const hasDecision = [...projection.decisions.values()].some(
    (candidate) =>
      candidate.assignmentId === assignmentId &&
      candidate.createdAt >= recoveryLowerBound
  );
  if (hasDecision) {
    return true;
  }
  return [...projection.results.values()].some(
    (candidate) =>
      candidate.assignmentId === assignmentId &&
      candidate.createdAt >= recoveryLowerBound &&
      (candidate.status === "completed" || candidate.status === "failed")
  );
}

function isWorkflowRecordBeforeCurrentAttempt(
  projection: RuntimeProjection,
  record: HostRunRecord
): boolean {
  const currentAttempt = currentWorkflowAttemptIdentity(projection);
  return Boolean(
    currentAttempt &&
      record.workflowAttempt &&
      !workflowAttemptsMatch(record.workflowAttempt, currentAttempt)
  );
}

function currentWorkflowAttemptStartedAt(projection: RuntimeProjection): string {
  const currentModuleId = projection.workflowProgress?.currentModuleId;
  return currentModuleId
    ? projection.workflowProgress?.modules[currentModuleId]?.enteredAt ?? ""
    : "";
}

function currentWorkflowAttemptIdentity(
  projection: RuntimeProjection
): WorkflowRunAttemptIdentity | undefined {
  const progress = projection.workflowProgress;
  if (!progress?.currentAssignmentId) {
    return undefined;
  }
  return {
    workflowId: progress.workflowId,
    workflowCycle: progress.workflowCycle,
    moduleId: progress.currentModuleId,
    moduleAttempt: progress.currentModuleAttempt
  };
}

function isCurrentWorkflowAttemptIdentityMissing(
  projection: RuntimeProjection,
  record: HostRunRecord
): boolean {
  return Boolean(
    projection.workflowProgress?.currentAssignmentId === record.assignmentId &&
      currentWorkflowAttemptIdentity(projection) &&
      !record.workflowAttempt
  );
}

function workflowAttemptsMatch(
  left: WorkflowRunAttemptIdentity,
  right: WorkflowRunAttemptIdentity
): boolean {
  return left.workflowId === right.workflowId &&
    left.workflowCycle === right.workflowCycle &&
    left.moduleId === right.moduleId &&
    left.moduleAttempt === right.moduleAttempt;
}

function hasDurableWorkflowStaleRecoveryForCurrentAssignment(
  projection: RuntimeProjection,
  record: HostRunRecord
): boolean {
  const assignmentId = projection.workflowProgress?.currentAssignmentId;
  if (!assignmentId || assignmentId !== record.assignmentId) {
    return false;
  }
  const assignment = projection.assignments.get(assignmentId);
  if (!assignment || assignment.state !== "queued") {
    return false;
  }
  return (projection.workflowProgress?.currentModuleAttempt ?? 0) > 1;
}
