import type { HostExecutionOutcome } from "./contract.js";
import type {
  HostRunRecord,
  RuntimeProjection,
  WorkflowRunAttemptIdentity
} from "../core/types.js";

interface HostRunRecordStampOptions {
  nativeRunId?: string | undefined;
  workflowAttempt?: WorkflowRunAttemptIdentity | undefined;
}

export function deriveWorkflowRunAttemptIdentity(
  projection: RuntimeProjection,
  assignmentId: string
): WorkflowRunAttemptIdentity | undefined {
  const progress = projection.workflowProgress;
  if (!progress || progress.currentAssignmentId !== assignmentId) {
    return undefined;
  }
  return {
    workflowId: progress.workflowId,
    workflowCycle: progress.workflowCycle,
    moduleId: progress.currentModuleId,
    moduleAttempt: progress.currentModuleAttempt
  };
}

export function buildCompletedRunRecord(
  outcome: Pick<HostExecutionOutcome, "outcome">,
  assignmentId: string,
  startedAt: string,
  completedAt: string,
  options: HostRunRecordStampOptions = {}
): HostRunRecord {
  const completedRecordBase = {
    assignmentId,
    state: "completed" as const,
    startedAt,
    completedAt,
    ...buildHostRunRecordStamp(options)
  };
  if (outcome.outcome.kind === "decision") {
    return {
      ...completedRecordBase,
      outcomeKind: "decision",
      summary: outcome.outcome.capture.blockerSummary,
      terminalOutcome: {
        kind: "decision",
        decision: {
          requesterId: outcome.outcome.capture.requesterId,
          blockerSummary: outcome.outcome.capture.blockerSummary,
          options: outcome.outcome.capture.options.map((option) => ({ ...option })),
          recommendedOption: outcome.outcome.capture.recommendedOption,
          state: outcome.outcome.capture.state ?? "open",
          createdAt: outcome.outcome.capture.createdAt ?? completedAt,
          ...(outcome.outcome.capture.decisionId
            ? { decisionId: outcome.outcome.capture.decisionId }
            : {})
        }
      }
    };
  }

  return {
    ...completedRecordBase,
    outcomeKind: "result",
    resultStatus: outcome.outcome.capture.status,
    summary: outcome.outcome.capture.summary,
    terminalOutcome: {
      kind: "result",
      result: {
        producerId: outcome.outcome.capture.producerId,
        status: outcome.outcome.capture.status,
        summary: outcome.outcome.capture.summary,
        changedFiles: [...outcome.outcome.capture.changedFiles],
        createdAt: outcome.outcome.capture.createdAt ?? completedAt,
        ...(outcome.outcome.capture.resultId ? { resultId: outcome.outcome.capture.resultId } : {})
      }
    }
  };
}

export function createRunningRunRecord(
  assignmentId: string,
  startedAt: string,
  leaseMs: number,
  options: HostRunRecordStampOptions = {}
): HostRunRecord {
  return {
    assignmentId,
    state: "running",
    ...buildHostRunRecordStamp(options),
    startedAt,
    heartbeatAt: startedAt,
    leaseExpiresAt: new Date(Date.parse(startedAt) + leaseMs).toISOString()
  };
}

export function withRunNativeId(record: HostRunRecord, nativeRunId: string): HostRunRecord {
  return {
    ...record,
    adapterData: {
      ...(record.adapterData ?? {}),
      nativeRunId
    }
  };
}

function buildHostRunRecordStamp(options: HostRunRecordStampOptions) {
  return {
    ...(options.workflowAttempt ? { workflowAttempt: options.workflowAttempt } : {}),
    ...(options.nativeRunId ? { adapterData: { nativeRunId: options.nativeRunId } } : {})
  };
}
