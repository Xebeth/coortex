import test from "node:test";
import assert from "node:assert/strict";

import type { DecisionPacket, ResultPacket } from "../core/types.js";
import {
  findLatestAssignmentDecision,
  findLatestOpenAssignmentDecision,
  findLatestTerminalAssignmentResult,
  listOpenDecisions,
  listRecentResults
} from "../projections/assignment-outcome-queries.js";
import { createEmptyProjection } from "../projections/runtime-projection.js";

test("assignment decision queries select the latest matching decision by createdAt", () => {
  const projection = createEmptyProjection("session-1", "/tmp/project", "codex");
  const assignmentId = "assignment-1";

  const resolvedDecision: DecisionPacket = {
    decisionId: "decision-1",
    assignmentId,
    requesterId: "worker-1",
    blockerSummary: "Old blocked work",
    options: [],
    recommendedOption: "wait",
    state: "resolved",
    createdAt: "2026-04-19T01:00:00.000Z",
    resolvedAt: "2026-04-19T01:05:00.000Z",
    resolutionSummary: "Done"
  };
  const openDecision: DecisionPacket = {
    decisionId: "decision-2",
    assignmentId,
    requesterId: "worker-1",
    blockerSummary: "Newest blocked work",
    options: [],
    recommendedOption: "wait",
    state: "open",
    createdAt: "2026-04-19T02:00:00.000Z"
  };
  const olderOpenDecision: DecisionPacket = {
    decisionId: "decision-3",
    assignmentId,
    requesterId: "worker-1",
    blockerSummary: "Earlier open work",
    options: [],
    recommendedOption: "wait",
    state: "open",
    createdAt: "2026-04-19T01:30:00.000Z"
  };

  projection.decisions.set(openDecision.decisionId, openDecision);
  projection.decisions.set(resolvedDecision.decisionId, resolvedDecision);
  projection.decisions.set(olderOpenDecision.decisionId, olderOpenDecision);

  assert.equal(
    findLatestAssignmentDecision(projection, assignmentId)?.decisionId,
    openDecision.decisionId
  );
  assert.equal(
    findLatestOpenAssignmentDecision(projection, assignmentId)?.decisionId,
    openDecision.decisionId
  );
  assert.equal(
    findLatestAssignmentDecision(projection, assignmentId, {
      createdAtOnOrAfter: "2026-04-19T01:45:00.000Z"
    })?.decisionId,
    openDecision.decisionId
  );
});

test("assignment result queries select the latest terminal result by createdAt", () => {
  const projection = createEmptyProjection("session-2", "/tmp/project", "codex");
  const assignmentId = "assignment-2";

  const partialResult: ResultPacket = {
    resultId: "result-1",
    assignmentId,
    producerId: "worker-1",
    status: "partial",
    summary: "Interim output",
    changedFiles: [],
    createdAt: "2026-04-19T01:00:00.000Z"
  };
  const completedResult: ResultPacket = {
    resultId: "result-2",
    assignmentId,
    producerId: "worker-1",
    status: "completed",
    summary: "Completed output",
    changedFiles: [],
    createdAt: "2026-04-19T01:30:00.000Z"
  };
  const failedResult: ResultPacket = {
    resultId: "result-3",
    assignmentId,
    producerId: "worker-1",
    status: "failed",
    summary: "Recovered failure",
    changedFiles: [],
    createdAt: "2026-04-19T02:00:00.000Z"
  };

  projection.results.set(failedResult.resultId, failedResult);
  projection.results.set(partialResult.resultId, partialResult);
  projection.results.set(completedResult.resultId, completedResult);

  assert.equal(
    findLatestTerminalAssignmentResult(projection, assignmentId)?.resultId,
    failedResult.resultId
  );
  assert.equal(
    findLatestTerminalAssignmentResult(projection, assignmentId, {
      createdAtOnOrAfter: "2026-04-19T01:45:00.000Z"
    })?.resultId,
    failedResult.resultId
  );
  assert.equal(
    findLatestTerminalAssignmentResult(projection, assignmentId, {
      createdAtOnOrAfter: "2026-04-19T02:30:00.000Z"
    }),
    undefined
  );
});

test("global outcome queries sort open decisions ascending and recent results descending", () => {
  const projection = createEmptyProjection("session-3", "/tmp/project", "codex");

  const olderDecision: DecisionPacket = {
    decisionId: "decision-4",
    assignmentId: "assignment-3",
    requesterId: "worker-1",
    blockerSummary: "First blocker",
    options: [],
    recommendedOption: "wait",
    state: "open",
    createdAt: "2026-04-19T01:00:00.000Z"
  };
  const newerDecision: DecisionPacket = {
    decisionId: "decision-5",
    assignmentId: "assignment-4",
    requesterId: "worker-1",
    blockerSummary: "Second blocker",
    options: [],
    recommendedOption: "wait",
    state: "open",
    createdAt: "2026-04-19T02:00:00.000Z"
  };
  const resolvedDecision: DecisionPacket = {
    decisionId: "decision-6",
    assignmentId: "assignment-5",
    requesterId: "worker-1",
    blockerSummary: "Resolved blocker",
    options: [],
    recommendedOption: "wait",
    state: "resolved",
    createdAt: "2026-04-19T03:00:00.000Z",
    resolvedAt: "2026-04-19T03:05:00.000Z",
    resolutionSummary: "done"
  };
  const olderResult: ResultPacket = {
    resultId: "result-4",
    assignmentId: "assignment-3",
    producerId: "worker-1",
    status: "completed",
    summary: "Older result",
    changedFiles: [],
    createdAt: "2026-04-19T01:00:00.000Z"
  };
  const newerResult: ResultPacket = {
    resultId: "result-5",
    assignmentId: "assignment-4",
    producerId: "worker-1",
    status: "completed",
    summary: "Newer result",
    changedFiles: [],
    createdAt: "2026-04-19T02:00:00.000Z"
  };

  projection.decisions.set(newerDecision.decisionId, newerDecision);
  projection.decisions.set(resolvedDecision.decisionId, resolvedDecision);
  projection.decisions.set(olderDecision.decisionId, olderDecision);
  projection.results.set(olderResult.resultId, olderResult);
  projection.results.set(newerResult.resultId, newerResult);

  assert.deepEqual(
    listOpenDecisions(projection).map((decision) => decision.decisionId),
    [olderDecision.decisionId, newerDecision.decisionId]
  );
  assert.deepEqual(
    listRecentResults(projection).map((result) => result.resultId),
    [newerResult.resultId, olderResult.resultId]
  );
  assert.deepEqual(
    listRecentResults(projection, 1).map((result) => result.resultId),
    [newerResult.resultId]
  );
});
