import type { DecisionPacket, HostRunRecord, ResultPacket } from "./types.js";

export type DecisionIdentity = {
  assignmentId: DecisionPacket["assignmentId"];
  decisionId?: DecisionPacket["decisionId"];
  requesterId: DecisionPacket["requesterId"];
  blockerSummary: DecisionPacket["blockerSummary"];
  options: DecisionPacket["options"];
  recommendedOption: DecisionPacket["recommendedOption"];
  state?: DecisionPacket["state"];
  createdAt?: DecisionPacket["createdAt"];
  resolvedAt?: DecisionPacket["resolvedAt"];
  resolutionSummary?: DecisionPacket["resolutionSummary"];
};

export type ResultIdentity = {
  assignmentId: ResultPacket["assignmentId"];
  resultId?: ResultPacket["resultId"];
  producerId: ResultPacket["producerId"];
  status: ResultPacket["status"];
  summary: ResultPacket["summary"];
  changedFiles: ResultPacket["changedFiles"];
  createdAt?: ResultPacket["createdAt"];
};

export function matchesDecisionIdentity(
  expected: DecisionIdentity,
  candidate: DecisionIdentity
): boolean {
  if (candidate.assignmentId !== expected.assignmentId) {
    return false;
  }
  return expected.decisionId
    ? candidate.decisionId === expected.decisionId
    : candidate.requesterId === expected.requesterId &&
        optionsEqual(candidate.options, expected.options) &&
        candidate.blockerSummary === expected.blockerSummary &&
        candidate.recommendedOption === expected.recommendedOption &&
        candidate.state === expected.state &&
        candidate.createdAt === expected.createdAt &&
        candidate.resolvedAt === expected.resolvedAt &&
        candidate.resolutionSummary === expected.resolutionSummary;
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
    : candidate.producerId === expected.producerId &&
        changedFilesEqual(candidate.changedFiles, expected.changedFiles) &&
        candidate.status === expected.status &&
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
    decisionIdentityFromTerminalOutcome(record.assignmentId, terminalOutcome.decision),
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
    resultIdentityFromTerminalOutcome(record.assignmentId, terminalOutcome.result),
    result
  );
}

function decisionIdentityFromTerminalOutcome(
  assignmentId: string,
  decision: NonNullable<Extract<HostRunRecord["terminalOutcome"], { kind: "decision" }>>["decision"]
): DecisionIdentity {
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

function resultIdentityFromTerminalOutcome(
  assignmentId: string,
  result: NonNullable<Extract<HostRunRecord["terminalOutcome"], { kind: "result" }>>["result"]
): ResultIdentity {
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

function optionsEqual(
  left: DecisionPacket["options"],
  right: DecisionPacket["options"]
): boolean {
  return (
    left.length === right.length &&
    left.every((option, index) => {
      const candidate = right[index];
      return candidate !== undefined &&
        option.id === candidate.id &&
        option.label === candidate.label &&
        option.summary === candidate.summary;
    })
  );
}

function changedFilesEqual(
  left: ResultPacket["changedFiles"],
  right: ResultPacket["changedFiles"]
): boolean {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}
