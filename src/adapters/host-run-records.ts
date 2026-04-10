import type { HostExecutionOutcome } from "./contract.js";
import type { HostRunRecord } from "../core/types.js";

export function buildCompletedRunRecord(
  outcome: Pick<HostExecutionOutcome, "outcome">,
  assignmentId: string,
  startedAt: string,
  completedAt: string,
  nativeRunId?: string
): HostRunRecord {
  if (outcome.outcome.kind === "decision") {
    return {
      assignmentId,
      state: "completed",
      startedAt,
      completedAt,
      outcomeKind: "decision",
      summary: outcome.outcome.capture.blockerSummary,
      ...(nativeRunId ? { adapterData: { nativeRunId } } : {})
    };
  }

  return {
    assignmentId,
    state: "completed",
    startedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus: outcome.outcome.capture.status,
    summary: outcome.outcome.capture.summary,
    ...(nativeRunId ? { adapterData: { nativeRunId } } : {})
  };
}

export function createRunningRunRecord(
  assignmentId: string,
  startedAt: string,
  leaseMs: number,
  nativeRunId?: string
): HostRunRecord {
  return {
    assignmentId,
    state: "running",
    startedAt,
    heartbeatAt: startedAt,
    leaseExpiresAt: new Date(Date.parse(startedAt) + leaseMs).toISOString(),
    ...(nativeRunId ? { adapterData: { nativeRunId } } : {})
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
