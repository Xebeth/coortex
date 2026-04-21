import { randomUUID } from "node:crypto";

import type {
  HostDecisionCapture,
  HostExecutionOutcome,
  HostResultCapture
} from "./contract.js";
import {
  matchesCompletedRunDecision,
  matchesCompletedRunResult,
  matchesDecisionIdentity,
  matchesResultIdentity
} from "../core/outcome-identity.js";
import type { DecisionPacket, HostRunRecord, ResultPacket } from "../core/types.js";
import { nowIso } from "../utils/time.js";

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
          ...(outcome.outcome.capture.resolvedAt
            ? { resolvedAt: outcome.outcome.capture.resolvedAt }
            : {}),
          ...(outcome.outcome.capture.resolutionSummary
            ? { resolutionSummary: outcome.outcome.capture.resolutionSummary }
            : {}),
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
        ...(capture.resolvedAt ? { resolvedAt: capture.resolvedAt } : {}),
        ...(capture.resolutionSummary ? { resolutionSummary: capture.resolutionSummary } : {}),
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

export {
  matchesCompletedRunDecision,
  matchesCompletedRunResult,
  matchesDecisionIdentity,
  matchesResultIdentity
};

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
    ...(decision.resolvedAt
      ? { resolvedAt: decision.resolvedAt }
      : {}),
    ...(decision.resolutionSummary
      ? { resolutionSummary: decision.resolutionSummary }
      : {}),
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
    createdAt: capture.createdAt ?? fallbackCreatedAt,
    ...(capture.resolvedAt ? { resolvedAt: capture.resolvedAt } : {}),
    ...(capture.resolutionSummary ? { resolutionSummary: capture.resolutionSummary } : {})
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
