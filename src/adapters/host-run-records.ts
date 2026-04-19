import { randomUUID } from "node:crypto";

import type {
  HostDecisionCapture,
  HostExecutionOutcome,
  HostResultCapture
} from "./contract.js";
import type { DecisionPacket, HostRunRecord, ResultPacket } from "../core/types.js";
import { nowIso } from "../utils/time.js";

type DecisionIdentity = {
  assignmentId: DecisionPacket["assignmentId"];
  decisionId?: DecisionPacket["decisionId"];
  blockerSummary: DecisionPacket["blockerSummary"];
  recommendedOption: DecisionPacket["recommendedOption"];
  createdAt?: DecisionPacket["createdAt"];
};

type ResultIdentity = {
  assignmentId: ResultPacket["assignmentId"];
  resultId?: ResultPacket["resultId"];
  status: ResultPacket["status"];
  summary: ResultPacket["summary"];
  createdAt?: ResultPacket["createdAt"];
};

export function buildCompletedRunRecord(
  outcome: Pick<HostExecutionOutcome, "outcome">,
  assignmentId: string,
  startedAt: string,
  completedAt: string,
  nativeRunId?: string,
  runInstanceId?: string
): HostRunRecord {
  if (outcome.outcome.kind === "decision") {
    return {
      assignmentId,
      state: "completed",
      startedAt,
      ...(runInstanceId ? { runInstanceId } : {}),
      completedAt,
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
      },
      ...(nativeRunId ? { adapterData: { nativeRunId } } : {})
    };
  }

  return {
    assignmentId,
    state: "completed",
    startedAt,
    ...(runInstanceId ? { runInstanceId } : {}),
    completedAt,
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
    },
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
    runInstanceId: randomUUID(),
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

export function buildCompletedHostExecutionOutcomeFromDecisionCapture(
  capture: HostDecisionCapture
): HostExecutionOutcome {
  const completedAt = capture.createdAt ?? nowIso();
  const outcome = {
    outcome: {
      kind: "decision" as const,
      capture: {
        assignmentId: capture.assignmentId,
        requesterId: capture.requesterId,
        blockerSummary: capture.blockerSummary,
        options: capture.options.map((option) => ({ ...option })),
        recommendedOption: capture.recommendedOption,
        ...(capture.state ? { state: capture.state } : {}),
        ...(capture.createdAt ? { createdAt: capture.createdAt } : {}),
        ...(capture.decisionId ? { decisionId: capture.decisionId } : {})
      }
    }
  } satisfies Pick<HostExecutionOutcome, "outcome">;

  return {
    ...outcome,
    run: buildCompletedRunRecord(outcome, capture.assignmentId, completedAt, completedAt)
  };
}

export function buildCompletedHostExecutionOutcomeFromResultCapture(
  capture: HostResultCapture
): HostExecutionOutcome {
  const completedAt = capture.createdAt ?? nowIso();
  const outcome = {
    outcome: {
      kind: "result" as const,
      capture: {
        assignmentId: capture.assignmentId,
        producerId: capture.producerId,
        status: capture.status,
        summary: capture.summary,
        changedFiles: [...capture.changedFiles],
        ...(capture.createdAt ? { createdAt: capture.createdAt } : {}),
        ...(capture.resultId ? { resultId: capture.resultId } : {})
      }
    }
  } satisfies Pick<HostExecutionOutcome, "outcome">;

  return {
    ...outcome,
    run: buildCompletedRunRecord(outcome, capture.assignmentId, completedAt, completedAt)
  };
}

export function synthesizeHostExecutionOutcomeFromCompletedRecord(
  record: HostRunRecord | undefined
): HostExecutionOutcome | undefined {
  if (!record || record.state !== "completed" || !record.terminalOutcome) {
    return undefined;
  }
  if (record.terminalOutcome.kind === "decision") {
    const execution = buildCompletedHostExecutionOutcomeFromDecisionCapture(
      decisionCaptureFromTerminalOutcome(record.assignmentId, record.terminalOutcome.decision)
    );
    return {
      ...execution,
      run: record
    };
  }
  const execution = buildCompletedHostExecutionOutcomeFromResultCapture(
    resultCaptureFromTerminalOutcome(record.assignmentId, record.terminalOutcome.result)
  );
  return {
    ...execution,
    run: record
  };
}

export function matchesDecisionIdentity(
  expected: DecisionIdentity,
  candidate: DecisionIdentity
): boolean {
  if (candidate.assignmentId !== expected.assignmentId) {
    return false;
  }
  return expected.decisionId
    ? candidate.decisionId === expected.decisionId
    : candidate.blockerSummary === expected.blockerSummary &&
        candidate.recommendedOption === expected.recommendedOption &&
        candidate.createdAt === expected.createdAt;
}

export function matchesResultIdentity(
  expected: ResultIdentity,
  candidate: ResultIdentity
): boolean {
  if (candidate.assignmentId !== expected.assignmentId) {
    return false;
  }
  return expected.resultId
    ? candidate.resultId === expected.resultId
    : candidate.status === expected.status &&
        candidate.summary === expected.summary &&
        candidate.createdAt === expected.createdAt;
}

export function matchesCompletedRunDecision(
  record: HostRunRecord,
  decision: DecisionIdentity
): boolean {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome || terminalOutcome.kind !== "decision") {
    return false;
  }
  return matchesDecisionIdentity(
    decisionCaptureFromTerminalOutcome(record.assignmentId, terminalOutcome.decision),
    decision
  );
}

export function matchesCompletedRunResult(
  record: HostRunRecord,
  result: ResultIdentity
): boolean {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome || terminalOutcome.kind !== "result") {
    return false;
  }
  return matchesResultIdentity(
    resultCaptureFromTerminalOutcome(record.assignmentId, terminalOutcome.result),
    result
  );
}

function decisionCaptureFromTerminalOutcome(
  assignmentId: string,
  decision: NonNullable<Extract<HostRunRecord["terminalOutcome"], { kind: "decision" }>>["decision"]
): HostDecisionCapture {
  return {
    assignmentId,
    requesterId: decision.requesterId,
    blockerSummary: decision.blockerSummary,
    options: decision.options.map((option) => ({ ...option })),
    recommendedOption: decision.recommendedOption,
    state: decision.state,
    createdAt: decision.createdAt,
    ...(decision.decisionId
      ? { decisionId: decision.decisionId }
      : {})
  };
}

function resultCaptureFromTerminalOutcome(
  assignmentId: string,
  result: NonNullable<Extract<HostRunRecord["terminalOutcome"], { kind: "result" }>>["result"]
): HostResultCapture {
  return {
    assignmentId,
    producerId: result.producerId,
    status: result.status,
    summary: result.summary,
    changedFiles: [...result.changedFiles],
    createdAt: result.createdAt,
    ...(result.resultId
      ? { resultId: result.resultId }
      : {})
  };
}

export function normalizeHostResultCapture(
  capture: HostResultCapture,
  fallbackCreatedAt = nowIso()
): ResultPacket {
  return {
    resultId: capture.resultId ?? randomUUID(),
    assignmentId: capture.assignmentId,
    producerId: capture.producerId,
    status: capture.status,
    summary: capture.summary,
    changedFiles: [...capture.changedFiles],
    createdAt: capture.createdAt ?? fallbackCreatedAt
  };
}

export function normalizeHostDecisionCapture(
  capture: HostDecisionCapture,
  fallbackCreatedAt = nowIso()
): DecisionPacket {
  return {
    decisionId: capture.decisionId ?? randomUUID(),
    assignmentId: capture.assignmentId,
    requesterId: capture.requesterId,
    blockerSummary: capture.blockerSummary,
    options: capture.options.map((option) => ({ ...option })),
    recommendedOption: capture.recommendedOption,
    state: capture.state ?? "open",
    createdAt: capture.createdAt ?? fallbackCreatedAt
  };
}

export function ensureStableHostExecutionOutcomeIds(
  outcome: Pick<HostExecutionOutcome, "outcome">,
  fallbackCreatedAt = nowIso()
): Pick<HostExecutionOutcome, "outcome"> {
  if (outcome.outcome.kind === "decision") {
    return {
      outcome: {
        kind: "decision",
        capture: normalizeHostDecisionCapture(
          outcome.outcome.capture,
          fallbackCreatedAt
        )
      }
    };
  }

  return {
    outcome: {
      kind: "result",
      capture: normalizeHostResultCapture(outcome.outcome.capture, fallbackCreatedAt)
    }
  };
}
