import test from "node:test";
import assert from "node:assert/strict";

import {
  matchesCompletedRunDecision,
  matchesCompletedRunResult,
  matchesDecisionIdentity,
  matchesResultIdentity
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
      blockerSummary: "Need approval",
      recommendedOption: "approve",
      createdAt: "2026-04-19T02:00:00.000Z"
    }),
    true
  );
  assert.equal(
    matchesCompletedRunResult(resultRecord, {
      assignmentId: "assignment-2",
      resultId: "",
      status: "failed",
      summary: "Failed",
      createdAt: "2026-04-19T04:00:00.000Z"
    }),
    true
  );
});
