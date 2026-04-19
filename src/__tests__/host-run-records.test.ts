import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCompletedRunRecord,
  createRunningRunRecord,
  normalizeHostDecisionCapture,
  normalizeHostResultCapture
} from "../adapters/host-run-records.js";

test("host run record builders stamp workflow attempt and native run identity", () => {
  const workflowAttempt = {
    workflowId: "default",
    workflowCycle: 2,
    moduleId: "review",
    moduleAttempt: 3
  };
  const startedAt = "2026-04-19T10:00:00.000Z";
  const completedAt = "2026-04-19T10:01:00.000Z";
  const options = {
    workflowAttempt,
    nativeRunId: "native-host-run"
  };

  const runningRecord = createRunningRunRecord("assignment-running", startedAt, 30_000, options);
  assert.deepEqual(runningRecord.workflowAttempt, workflowAttempt);
  assert.deepEqual(runningRecord.adapterData, { nativeRunId: "native-host-run" });

  const completedResult = buildCompletedRunRecord(
    {
      outcome: {
        kind: "result",
        capture: {
          assignmentId: "assignment-result",
          producerId: "host-adapter",
          status: "completed",
          summary: "Completed result outcome",
          changedFiles: ["src/example.ts"],
          createdAt: completedAt
        }
      }
    },
    "assignment-result",
    startedAt,
    completedAt,
    options
  );
  assert.deepEqual(completedResult.workflowAttempt, workflowAttempt);
  assert.deepEqual(completedResult.adapterData, { nativeRunId: "native-host-run" });

  const completedDecision = buildCompletedRunRecord(
    {
      outcome: {
        kind: "decision",
        capture: {
          assignmentId: "assignment-decision",
          requesterId: "host-adapter",
          blockerSummary: "Need a reviewer decision",
          options: [{ id: "approve", label: "Approve", summary: "Ship it" }],
          recommendedOption: "approve",
          createdAt: completedAt
        }
      }
    },
    "assignment-decision",
    startedAt,
    completedAt,
    options
  );
  assert.deepEqual(completedDecision.workflowAttempt, workflowAttempt);
  assert.deepEqual(completedDecision.adapterData, { nativeRunId: "native-host-run" });
});


test("host run record normalization mints ids and timestamps for host captures", () => {
  const normalizedResult = normalizeHostResultCapture({
    assignmentId: "assignment-result",
    producerId: "codex",
    status: "completed",
    summary: "done",
    changedFiles: []
  });
  assert.equal(normalizedResult.assignmentId, "assignment-result");
  assert.equal(typeof normalizedResult.resultId, "string");
  assert.equal(normalizedResult.resultId.length > 0, true);
  assert.equal(typeof normalizedResult.createdAt, "string");

  const normalizedDecision = normalizeHostDecisionCapture({
    assignmentId: "assignment-decision",
    requesterId: "codex",
    blockerSummary: "Need approval",
    options: [{ id: "yes", label: "Yes", summary: "approve" }],
    recommendedOption: "yes"
  });
  assert.equal(normalizedDecision.assignmentId, "assignment-decision");
  assert.equal(typeof normalizedDecision.decisionId, "string");
  assert.equal(normalizedDecision.decisionId.length > 0, true);
  assert.equal(normalizedDecision.state, "open");
  assert.equal(typeof normalizedDecision.createdAt, "string");
});
