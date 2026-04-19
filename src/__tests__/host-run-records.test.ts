import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCompletedRunRecord,
  createRunningRunRecord
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
