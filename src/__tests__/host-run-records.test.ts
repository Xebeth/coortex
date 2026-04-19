import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCompletedHostExecutionOutcomeFromDecisionCapture,
  matchesCompletedRunDecision,
  matchesCompletedRunResult,
  matchesDecisionIdentity,
  matchesResultIdentity,
  synthesizeHostExecutionOutcomeFromCompletedRecord
} from "../adapters/host-run-records.js";
import type { DecisionPacket, HostRunRecord, ResultPacket } from "../core/types.js";

test("decision identity matching prefers decision ids and falls back to stable fields", () => {
  const decision: DecisionPacket = {
    decisionId: "decision-1",
    assignmentId: "assignment-1",
    requesterId: "worker-1",
    blockerSummary: "Need approval",
    options: [],
    recommendedOption: "approve",
    state: "open",
    createdAt: "2026-04-19T01:00:00.000Z"
  };

  assert.equal(matchesDecisionIdentity(decision, { ...decision }), true);
  assert.equal(
    matchesDecisionIdentity(
      {
        ...decision,
        decisionId: ""
      },
      {
        ...decision,
        decisionId: "different"
      }
    ),
    true
  );
  assert.equal(
    matchesDecisionIdentity(decision, {
      ...decision,
      decisionId: "different"
    }),
    false
  );
  assert.equal(
    matchesDecisionIdentity(
      {
        ...decision,
        decisionId: ""
      },
      {
        ...decision,
        decisionId: "",
        requesterId: "worker-2"
      }
    ),
    false
  );
  assert.equal(
    matchesDecisionIdentity(
      {
        ...decision,
        decisionId: ""
      },
      {
        ...decision,
        decisionId: "",
        options: [{ id: "deny", label: "Deny", summary: "Reject the work." }]
      }
    ),
    false
  );
  assert.equal(
    matchesDecisionIdentity(
      {
        ...decision,
        decisionId: "",
        state: "resolved",
        resolvedAt: "2026-04-19T01:05:00.000Z",
        resolutionSummary: "Operator approved the work."
      },
      {
        ...decision,
        decisionId: "",
        state: "resolved",
        resolvedAt: "2026-04-19T01:06:00.000Z",
        resolutionSummary: "Operator rejected the work."
      }
    ),
    false
  );
});

test("result identity matching prefers result ids and falls back to stable fields", () => {
  const result: ResultPacket = {
    resultId: "result-1",
    assignmentId: "assignment-1",
    producerId: "worker-1",
    status: "completed",
    summary: "Finished",
    changedFiles: [],
    createdAt: "2026-04-19T01:00:00.000Z"
  };

  assert.equal(matchesResultIdentity(result, { ...result }), true);
  assert.equal(
    matchesResultIdentity(
      {
        ...result,
        resultId: ""
      },
      {
        ...result,
        resultId: "different"
      }
    ),
    true
  );
  assert.equal(
    matchesResultIdentity(result, {
      ...result,
      resultId: "different"
    }),
    false
  );
  assert.equal(
    matchesResultIdentity(
      {
        ...result,
        resultId: ""
      },
      {
        ...result,
        resultId: "",
        producerId: "worker-2"
      }
    ),
    false
  );
  assert.equal(
    matchesResultIdentity(
      {
        ...result,
        resultId: ""
      },
      {
        ...result,
        resultId: "",
        changedFiles: ["src/new-file.ts"]
      }
    ),
    false
  );
});

test("completed run matchers reuse the same decision and result identity rules", () => {
  const decisionRecord: HostRunRecord = {
    assignmentId: "assignment-1",
    state: "completed",
    startedAt: "2026-04-19T01:00:00.000Z",
    completedAt: "2026-04-19T02:00:00.000Z",
    outcomeKind: "decision",
    summary: "Need approval",
    terminalOutcome: {
      kind: "decision",
      decision: {
        requesterId: "worker-1",
        blockerSummary: "Need approval",
        options: [],
        recommendedOption: "approve",
        state: "open",
        createdAt: "2026-04-19T02:00:00.000Z"
      }
    }
  };
  const resultRecord: HostRunRecord = {
    assignmentId: "assignment-2",
    state: "completed",
    startedAt: "2026-04-19T03:00:00.000Z",
    completedAt: "2026-04-19T04:00:00.000Z",
    outcomeKind: "result",
    resultStatus: "failed",
    summary: "Failed",
    terminalOutcome: {
      kind: "result",
      result: {
        producerId: "worker-1",
        status: "failed",
        summary: "Failed",
        changedFiles: [],
        createdAt: "2026-04-19T04:00:00.000Z"
      }
    }
  };

  assert.equal(
    matchesCompletedRunDecision(decisionRecord, {
      assignmentId: "assignment-1",
      decisionId: "",
      requesterId: "worker-1",
      blockerSummary: "Need approval",
      options: [],
      recommendedOption: "approve",
      state: "open",
      createdAt: "2026-04-19T02:00:00.000Z"
    }),
    true
  );
  const resolvedDecisionRecord: HostRunRecord = {
    ...decisionRecord,
    summary: "Need approval after review",
    terminalOutcome: {
      kind: "decision",
      decision: {
        requesterId: "worker-1",
        blockerSummary: "Need approval",
        options: [],
        recommendedOption: "approve",
        state: "resolved",
        createdAt: "2026-04-19T02:00:00.000Z",
        resolvedAt: "2026-04-19T02:30:00.000Z",
        resolutionSummary: "Operator approved the work."
      }
    }
  };
  assert.equal(
    matchesCompletedRunDecision(resolvedDecisionRecord, {
      assignmentId: "assignment-1",
      decisionId: "",
      requesterId: "worker-1",
      blockerSummary: "Need approval",
      options: [],
      recommendedOption: "approve",
      state: "resolved",
      createdAt: "2026-04-19T02:00:00.000Z",
      resolvedAt: "2026-04-19T02:31:00.000Z",
      resolutionSummary: "Operator rejected the work."
    }),
    false
  );
  assert.equal(
    matchesCompletedRunResult(resultRecord, {
      assignmentId: "assignment-2",
      resultId: "",
      producerId: "worker-1",
      status: "failed",
      summary: "Failed",
      changedFiles: [],
      createdAt: "2026-04-19T04:00:00.000Z"
    }),
    true
  );
});

test("resolved decisions keep resolution metadata through host-run helpers", () => {
  const resolvedAt = "2026-04-19T02:30:00.000Z";
  const capture = {
    assignmentId: "assignment-1",
    requesterId: "worker-1",
    blockerSummary: "Need approval",
    options: [{ id: "approve", label: "Approve", summary: "Approve the change." }],
    recommendedOption: "approve",
    state: "resolved" as const,
    createdAt: "2026-04-19T02:00:00.000Z",
    resolvedAt,
    resolutionSummary: "Operator approved the change.",
    decisionId: "decision-1"
  };

  const execution = buildCompletedHostExecutionOutcomeFromDecisionCapture(capture);
  assert.equal(execution.run.terminalOutcome?.kind, "decision");
  assert.deepEqual(execution.run.terminalOutcome?.decision, {
    decisionId: "decision-1",
    requesterId: "worker-1",
    blockerSummary: "Need approval",
    options: [{ id: "approve", label: "Approve", summary: "Approve the change." }],
    recommendedOption: "approve",
    state: "resolved",
    createdAt: "2026-04-19T02:00:00.000Z",
    resolvedAt,
    resolutionSummary: "Operator approved the change."
  });

  const synthesized = synthesizeHostExecutionOutcomeFromCompletedRecord(execution.run);
  assert.equal(synthesized?.outcome.kind, "decision");
  assert.deepEqual(synthesized?.outcome.capture, capture);
});
