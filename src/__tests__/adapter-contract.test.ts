import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { CodexAdapter } from "../hosts/codex/adapter/index.js";
import type { CodexCommandRunner } from "../hosts/codex/adapter/cli.js";
import { RuntimeStore } from "../persistence/store.js";
import type { RuntimeConfig } from "../config/types.js";
import { createBootstrapRuntime } from "../core/runtime.js";
import { buildRecoveryBrief } from "../recovery/brief.js";
import { nowIso } from "../utils/time.js";

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

test("codex adapter executes a bounded run and persists minimal reconnect metadata", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-adapter-run-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex",
    workflow: "milestone-2"
  });
  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const projection = await store.rebuildProjection();
  const brief = buildRecoveryBrief(projection);
  const assignmentId = bootstrap.initialAssignmentId;
  const runner: CodexCommandRunner = {
    async runExec(input) {
      await mkdir(dirname(input.outputPath), { recursive: true });
      await writeFile(
        input.outputPath,
        JSON.stringify({
          outcomeType: "result",
          resultStatus: "completed",
          resultSummary: "Implemented the bounded Codex execution slice.",
          changedFiles: ["src/cli/ctx.ts", "src/hosts/codex/adapter/index.ts"],
          blockerSummary: "",
          decisionOptions: [],
          recommendedOption: ""
        }),
        "utf8"
      );
      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
          JSON.stringify({
            type: "turn.completed",
            usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 30
            }
          })
        ].join("\n"),
        stderr: ""
      };
    }
  };

  const adapter = new CodexAdapter(runner);
  await adapter.initialize(store, projection);
  const envelope = await adapter.buildResumeEnvelope(store, projection, brief);
  const execution = await adapter.executeAssignment(store, projection, envelope);

  assert.equal(execution.outcome.kind, "result");
  assert.equal(execution.outcome.capture.status, "completed");
  assert.equal(execution.run.assignmentId, assignmentId);
  assert.equal(execution.run.hostRunId, "thread-123");
  assert.equal(execution.telemetry?.usage?.inputTokens, 100);
  assert.equal(execution.telemetry?.usage?.cachedTokens, 20);
  assert.equal(execution.telemetry?.usage?.totalTokens, 130);

  const persisted = await adapter.inspectRun(store, assignmentId);
  assert.deepEqual(persisted, execution.run);
});

test("codex adapter does not replay stale last-message artifacts on rerun", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-adapter-rerun-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex",
    workflow: "milestone-2"
  });
  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const projection = await store.rebuildProjection();
  const brief = buildRecoveryBrief(projection);
  const assignmentId = bootstrap.initialAssignmentId;
  let invocation = 0;
  const runner: CodexCommandRunner = {
    async runExec(input) {
      invocation += 1;
      await input.onEvent?.({ type: "thread.started", thread_id: `thread-rerun-${invocation}` });
      if (invocation === 1) {
        await store.writeJsonArtifact(
          `adapters/codex/runs/${assignmentId}-stale-fixture.json`,
          { stale: true }
        );
        await mkdir(dirname(input.outputPath), { recursive: true });
        await writeFile(
          input.outputPath,
          JSON.stringify({
            outcomeType: "result",
            resultStatus: "partial",
            resultSummary: "Initial partial result.",
            changedFiles: ["src/cli/ctx.ts"],
            blockerSummary: "",
            decisionOptions: [],
            recommendedOption: ""
          }),
          "utf8"
        );
        return {
          exitCode: 0,
          stdout: JSON.stringify({ type: "thread.started", thread_id: "thread-rerun-1" }),
          stderr: ""
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ type: "thread.started", thread_id: "thread-rerun-2" }),
        stderr: ""
      };
    }
  };

  const adapter = new CodexAdapter(runner);
  await adapter.initialize(store, projection);
  const envelope = await adapter.buildResumeEnvelope(store, projection, brief);
  const first = await adapter.executeAssignment(store, projection, envelope);
  assert.equal(first.outcome.kind, "result");
  assert.equal(first.outcome.capture.status, "partial");

  const second = await adapter.executeAssignment(store, projection, envelope);
  assert.equal(second.outcome.kind, "result");
  assert.equal(second.outcome.capture.status, "failed");
  assert.match(second.outcome.capture.summary, /invalid structured output/i);
  assert.equal(second.run.hostRunId, "thread-rerun-2");
});

test("codex adapter converts malformed structured output into a failed result", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-adapter-malformed-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex",
    workflow: "milestone-2"
  });
  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const projection = await store.rebuildProjection();
  const brief = buildRecoveryBrief(projection);
  const runner: CodexCommandRunner = {
    async runExec(input) {
      await input.onEvent?.({ type: "thread.started", thread_id: "thread-bad-output" });
      await mkdir(dirname(input.outputPath), { recursive: true });
      await writeFile(
        input.outputPath,
        JSON.stringify({
          outcomeType: "result",
          resultStatus: "completed",
          resultSummary: "This payload is malformed.",
          changedFiles: { not: "an-array" },
          blockerSummary: "",
          decisionOptions: [],
          recommendedOption: ""
        }),
        "utf8"
      );
      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "thread-bad-output" }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } })
        ].join("\n"),
        stderr: ""
      };
    }
  };

  const adapter = new CodexAdapter(runner);
  await adapter.initialize(store, projection);
  const envelope = await adapter.buildResumeEnvelope(store, projection, brief);
  const execution = await adapter.executeAssignment(store, projection, envelope);

  assert.equal(execution.outcome.kind, "result");
  assert.equal(execution.outcome.capture.status, "failed");
  assert.match(execution.outcome.capture.summary, /invalid structured output/i);
  assert.equal(execution.run.state, "completed");
  assert.equal(execution.run.hostRunId, "thread-bad-output");
});

test("codex adapter persists the thread handle before a run fails", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-adapter-interrupt-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex",
    workflow: "milestone-2"
  });
  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const projection = await store.rebuildProjection();
  const brief = buildRecoveryBrief(projection);
  const assignmentId = bootstrap.initialAssignmentId;
  let observedRunningRecord = false;
  let adapter!: CodexAdapter;
  const runner: CodexCommandRunner = {
    async runExec(input) {
      await input.onEvent?.({ type: "thread.started", thread_id: "thread-interrupt-1" });
      const record = await adapter.inspectRun(store, assignmentId);
      observedRunningRecord =
        record?.state === "running" && record.hostRunId === "thread-interrupt-1";
      throw new Error("simulated interruption");
    }
  };

  adapter = new CodexAdapter(runner);
  await adapter.initialize(store, projection);
  const envelope = await adapter.buildResumeEnvelope(store, projection, brief);
  const execution = await adapter.executeAssignment(store, projection, envelope);

  assert.equal(observedRunningRecord, true);
  assert.equal(execution.outcome.kind, "result");
  assert.equal(execution.outcome.capture.status, "failed");
  assert.equal(execution.run.hostRunId, "thread-interrupt-1");
  assert.equal(execution.run.state, "completed");
});
