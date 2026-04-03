import test from "node:test";
import assert from "node:assert/strict";

import { buildTaskEnvelope } from "../adapters/envelope.js";
import { createEmptyProjection } from "../projections/runtime-projection.js";
import type { Assignment, RecoveryBrief, RuntimeStatus } from "../core/types.js";

test("task envelope trims oversized result summaries and preserves references", () => {
  const projection = createEmptyProjection("session-1", "/tmp/project", "codex");
  const assignment: Assignment = {
    id: "assignment-1",
    parentTaskId: "session-1",
    workflow: "milestone-1",
    ownerType: "runtime",
    ownerId: "codex:bootstrap",
    objective: "Implement trimming.",
    writeScope: ["src/"],
    requiredOutputs: ["tests"],
    state: "in_progress",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z"
  };
  const status: RuntimeStatus = {
    activeMode: "solo",
    currentObjective: assignment.objective,
    activeAssignmentIds: [assignment.id],
    activeHost: "codex",
    activeAdapter: "codex",
    lastDurableOutputAt: "2026-04-03T00:00:00.000Z",
    resumeReady: true
  };
  projection.assignments.set(assignment.id, assignment);
  projection.status = status;

  const brief: RecoveryBrief = {
    activeObjective: assignment.objective,
    activeAssignments: [
      {
        id: assignment.id,
        objective: assignment.objective,
        state: assignment.state,
        writeScope: assignment.writeScope,
        requiredOutputs: assignment.requiredOutputs
      }
    ],
    lastDurableResults: [
      {
        resultId: "result-1",
        assignmentId: assignment.id,
        status: "partial",
        summary: "x".repeat(1_000),
        changedFiles: ["src/adapters/envelope.ts"],
        createdAt: "2026-04-03T00:00:00.000Z"
      }
    ],
    unresolvedDecisions: [],
    nextRequiredAction: "Continue assignment assignment-1",
    generatedAt: "2026-04-03T00:00:00.000Z"
  };

  const envelope = buildTaskEnvelope(projection, brief, {
    host: "codex",
    adapter: "codex",
    maxChars: 3_000,
    resultSummaryLimit: 120
  });

  assert.equal(envelope.trimApplied, true);
  assert.equal(envelope.recentResults[0]?.trimmed, true);
  assert.equal(envelope.recentResults[0]?.reference, "result:result-1");
  assert.ok(envelope.estimatedChars <= 3_000);
});
