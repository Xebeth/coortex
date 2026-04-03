import test from "node:test";
import assert from "node:assert/strict";

import { CodexAdapter } from "../hosts/codex/adapter/index.js";

test("codex adapter normalizes host result, decision, and telemetry captures", () => {
  const adapter = new CodexAdapter();

  const result = adapter.normalizeResult({
    assignmentId: "assignment-1",
    producerId: "codex",
    status: "completed",
    summary: "Finished milestone wiring.",
    changedFiles: ["src/hosts/codex/adapter/index.ts"],
    createdAt: "2026-04-03T10:00:00.000Z",
    resultId: "result-1"
  });
  assert.deepEqual(result, {
    resultId: "result-1",
    assignmentId: "assignment-1",
    producerId: "codex",
    status: "completed",
    summary: "Finished milestone wiring.",
    changedFiles: ["src/hosts/codex/adapter/index.ts"],
    createdAt: "2026-04-03T10:00:00.000Z"
  });

  const decision = adapter.normalizeDecision({
    assignmentId: "assignment-1",
    requesterId: "codex",
    blockerSummary: "Need approval before touching production secrets.",
    options: [
      { id: "wait", label: "Wait", summary: "Pause until approval arrives." },
      { id: "skip", label: "Skip", summary: "Proceed without the secret-dependent step." }
    ],
    recommendedOption: "wait",
    createdAt: "2026-04-03T10:01:00.000Z",
    decisionId: "decision-1"
  });
  assert.deepEqual(decision, {
    decisionId: "decision-1",
    assignmentId: "assignment-1",
    requesterId: "codex",
    blockerSummary: "Need approval before touching production secrets.",
    options: [
      { id: "wait", label: "Wait", summary: "Pause until approval arrives." },
      { id: "skip", label: "Skip", summary: "Proceed without the secret-dependent step." }
    ],
    recommendedOption: "wait",
    state: "open",
    createdAt: "2026-04-03T10:01:00.000Z"
  });

  const telemetry = adapter.normalizeTelemetry({
    eventType: "resume.requested",
    taskId: "session-1",
    assignmentId: "assignment-1",
    metadata: { envelopeChars: 512 },
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 }
  });
  assert.deepEqual(telemetry, {
    eventType: "resume.requested",
    taskId: "session-1",
    assignmentId: "assignment-1",
    host: "codex",
    adapter: "codex",
    metadata: { envelopeChars: 512 },
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 18
  });
});
