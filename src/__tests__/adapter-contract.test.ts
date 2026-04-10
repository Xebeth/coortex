import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter } from "node:path";
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
    async startExec(input) {
      return createMockRunningExec(this, input);
    },
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
    async startExec(input) {
      return createMockRunningExec(this, input);
    },
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
    async startExec(input) {
      return createMockRunningExec(this, input);
    },
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
    async startExec(input) {
      return createMockRunningExec(this, input);
    },
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

test("codex adapter terminates a spawned run if the initial lease refresh fails", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-adapter-refresh-failure-"));
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
  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  let runningWriteCount = 0;
  (store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
  }).writeJsonArtifact = async (artifactPath, value) => {
    if (
      artifactPath === `adapters/codex/runs/${assignmentId}.json` &&
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      value.state === "running"
    ) {
      runningWriteCount += 1;
      if (runningWriteCount === 2) {
        throw new Error("simulated initial refresh failure");
      }
    }
    return originalWriteJsonArtifact(artifactPath, value);
  };

  let terminateSignals: Array<"graceful" | "force" | undefined> = [];
  let waitForExitCalls = 0;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<{ exitCode: number; stdout: string; stderr: string }>((_, reject) => {
    rejectResult = reject;
  });
  void result.catch(() => undefined);

  const runner: CodexCommandRunner = {
    async startExec() {
      return {
        result,
        terminate: async (signal) => {
          terminateSignals.push(signal);
          queueMicrotask(() => {
            rejectResult(new Error("terminated after refresh failure"));
          });
        },
        waitForExit: async () => {
          waitForExitCalls += 1;
          return { code: 1 };
        }
      };
    },
    async runExec() {
      throw new Error("runExec should not be called when startExec is stubbed");
    }
  };

  const adapter = new CodexAdapter(runner);
  await adapter.initialize(store, projection);
  const envelope = await adapter.buildResumeEnvelope(store, projection, brief);
  const execution = await adapter.executeAssignment(store, projection, envelope);

  assert.equal(execution.outcome.kind, "result");
  assert.equal(execution.outcome.capture.status, "failed");
  assert.match(execution.outcome.capture.summary, /simulated initial refresh failure/i);
  assert.deepEqual(terminateSignals, ["graceful"]);
  assert.equal(waitForExitCalls, 1);
});

test("codex adapter serializes run-record writes so heartbeat updates do not drop the thread handle", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-adapter-serialized-"));
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
  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  let capturedRunRecordWrites = 0;
  (store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
  }).writeJsonArtifact = async (artifactPath, value) => {
    if (artifactPath === `adapters/codex/runs/${assignmentId}.json`) {
      capturedRunRecordWrites += 1;
      if (capturedRunRecordWrites === 2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return originalWriteJsonArtifact(artifactPath, value);
  };

  const runner: CodexCommandRunner = {
    async startExec(input) {
      return createMockRunningExec(this, input);
    },
    async runExec(input) {
      await input.onEvent?.({ type: "thread.started", thread_id: "thread-serialized-1" });
      await mkdir(dirname(input.outputPath), { recursive: true });
      await writeFile(
        input.outputPath,
        JSON.stringify({
          outcomeType: "result",
          resultStatus: "completed",
          resultSummary: "Serialized writes preserved the thread handle.",
          changedFiles: [],
          blockerSummary: "",
          decisionOptions: [],
          recommendedOption: ""
        }),
        "utf8"
      );
      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "thread-serialized-1" }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } })
        ].join("\n"),
        stderr: ""
      };
    }
  };

  const adapter = new CodexAdapter(runner);
  await adapter.initialize(store, projection);
  const envelope = await adapter.buildResumeEnvelope(store, projection, brief);
  const execution = await adapter.executeAssignment(store, projection, envelope);
  const inspected = await adapter.inspectRun(store, assignmentId);

  assert.equal(execution.run.hostRunId, "thread-serialized-1");
  assert.equal(inspected?.hostRunId, "thread-serialized-1");
});

test("codex adapter waits for canceled runs to persist a terminal record", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-adapter-cancel-"));
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
  let rejectResult!: (error: Error) => void;
  const result = new Promise<{ exitCode: number; stdout: string; stderr: string }>((_, reject) => {
    rejectResult = reject;
  });
  void result.catch(() => undefined);

  const runner: CodexCommandRunner = {
    async startExec(input) {
      await input.onEvent?.({ type: "thread.started", thread_id: "thread-cancel-1" });
      return {
        result,
        terminate: async () => {
          queueMicrotask(() => {
            rejectResult(new Error("simulated cancellation"));
          });
        },
        waitForExit: async () => ({ code: 130 })
      };
    },
    async runExec() {
      throw new Error("runExec should not be called when startExec is stubbed");
    }
  };

  const adapter = new CodexAdapter(runner);
  await adapter.initialize(store, projection);
  const envelope = await adapter.buildResumeEnvelope(store, projection, brief);
  const executionPromise = adapter.executeAssignment(store, projection, envelope);

  await waitFor(async () => Boolean((await adapter.inspectRun(store, assignmentId))?.hostRunId));
  await adapter.cancelActiveRun("graceful");
  const execution = await executionPromise;
  const inspected = await adapter.inspectRun(store, assignmentId);

  assert.equal(execution.run.state, "completed");
  assert.equal(execution.run.hostRunId, "thread-cancel-1");
  assert.equal(execution.outcome.kind, "result");
  assert.equal(execution.outcome.capture.status, "failed");
  assert.equal(inspected?.state, "completed");
  assert.equal(inspected?.hostRunId, "thread-cancel-1");
});

test("codex adapter recovers final run-record writes after a transient write failure", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-adapter-write-recover-"));
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
  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  let failedFinalWrite = false;
  (store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
  }).writeJsonArtifact = async (artifactPath, value) => {
    if (
      artifactPath === `adapters/codex/runs/${assignmentId}.json` &&
      !failedFinalWrite &&
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      value.state === "completed"
    ) {
      failedFinalWrite = true;
      throw new Error("simulated run-record write failure");
    }
    return originalWriteJsonArtifact(artifactPath, value);
  };

  const runner: CodexCommandRunner = {
    async startExec(input) {
      return createMockRunningExec(this, input);
    },
    async runExec(input) {
      await input.onEvent?.({ type: "thread.started", thread_id: "thread-write-recover-1" });
      await mkdir(dirname(input.outputPath), { recursive: true });
      await writeFile(
        input.outputPath,
        JSON.stringify({
          outcomeType: "result",
          resultStatus: "completed",
          resultSummary: "This should be replaced by the failed write path.",
          changedFiles: [],
          blockerSummary: "",
          decisionOptions: [],
          recommendedOption: ""
        }),
        "utf8"
      );
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    }
  };

  const adapter = new CodexAdapter(runner);
  await adapter.initialize(store, projection);
  const envelope = await adapter.buildResumeEnvelope(store, projection, brief);
  const execution = await adapter.executeAssignment(store, projection, envelope);
  const inspected = await adapter.inspectRun(store, assignmentId);

  assert.equal(execution.outcome.kind, "result");
  assert.equal(execution.outcome.capture.status, "completed");
  assert.match(execution.outcome.capture.summary, /This should be replaced by the failed write path\./i);
  assert.match(execution.warning ?? "", /final run record could not be persisted/i);
  assert.equal(inspected?.state, "running");
  assert.equal(inspected?.hostRunId, "thread-write-recover-1");
});

test("codex adapter keeps a successful outcome when thread-start metadata persistence fails", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-adapter-thread-warning-"));
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
  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  let failedThreadWrite = false;
  (store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
  }).writeJsonArtifact = async (artifactPath, value) => {
    if (
      artifactPath === `adapters/codex/runs/${assignmentId}.json` &&
      !failedThreadWrite &&
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      value.state === "running" &&
      "hostRunId" in value &&
      value.hostRunId === "thread-warning-1"
    ) {
      failedThreadWrite = true;
      throw new Error("simulated thread metadata write failure");
    }
    return originalWriteJsonArtifact(artifactPath, value);
  };

  const runner: CodexCommandRunner = {
    async startExec(input) {
      return createMockRunningExec(this, input);
    },
    async runExec(input) {
      await input.onEvent?.({ type: "thread.started", thread_id: "thread-warning-1" });
      await mkdir(dirname(input.outputPath), { recursive: true });
      await writeFile(
        input.outputPath,
        JSON.stringify({
          outcomeType: "result",
          resultStatus: "completed",
          resultSummary: "Thread metadata warning did not poison the host outcome.",
          changedFiles: [],
          blockerSummary: "",
          decisionOptions: [],
          recommendedOption: ""
        }),
        "utf8"
      );
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    }
  };

  const adapter = new CodexAdapter(runner);
  await adapter.initialize(store, projection);
  const envelope = await adapter.buildResumeEnvelope(store, projection, brief);
  const execution = await adapter.executeAssignment(store, projection, envelope);
  const inspected = await adapter.inspectRun(store, assignmentId);

  assert.equal(execution.outcome.kind, "result");
  assert.equal(execution.outcome.capture.status, "completed");
  assert.match(execution.warning ?? "", /thread-start handling/i);
  assert.equal(inspected?.state, "completed");
  assert.equal(inspected?.hostRunId, "thread-warning-1");
});

test("codex adapter treats malformed lease JSON as stale inspection state", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-adapter-malformed-lease-"));
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
  const assignmentId = bootstrap.initialAssignmentId;
  const adapter = new CodexAdapter();
  await adapter.initialize(store, projection);
  await mkdir(join(projectRoot, ".coortex", "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(projectRoot, ".coortex", "adapters", "codex", "runs", `${assignmentId}.lease.json`),
    "{",
    "utf8"
  );

  const inspected = await adapter.inspectRun(store, assignmentId);

  assert.equal(inspected?.assignmentId, assignmentId);
  assert.equal(inspected?.state, "running");
  await assert.rejects(
    readFile(
      join(projectRoot, ".coortex", "adapters", "codex", "runs", `${assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("codex adapter fails the run when heartbeat lease refreshes stop persisting", async () => {
  const originalHeartbeat = process.env.COORTEX_RUN_HEARTBEAT_MS;
  process.env.COORTEX_RUN_HEARTBEAT_MS = "10";

  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-adapter-heartbeat-failure-"));
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
  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  let heartbeatWriteFailed = false;
  let runWriteCount = 0;
  (store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
  }).writeJsonArtifact = async (artifactPath, value) => {
    if (artifactPath === `adapters/codex/runs/${assignmentId}.json`) {
      runWriteCount += 1;
      if (!heartbeatWriteFailed && runWriteCount >= 4) {
        heartbeatWriteFailed = true;
        throw new Error("simulated heartbeat write failure");
      }
    }
    return originalWriteJsonArtifact(artifactPath, value);
  };

  let releaseRun!: () => void;
  const runReleased = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const runner: CodexCommandRunner = {
    async startExec(input) {
      return createMockRunningExec(this, input);
    },
    async runExec(input) {
      await input.onEvent?.({ type: "thread.started", thread_id: "thread-heartbeat-failure-1" });
      await waitFor(async () => heartbeatWriteFailed);
      releaseRun();
      await runReleased;
      await mkdir(dirname(input.outputPath), { recursive: true });
      await writeFile(
        input.outputPath,
        JSON.stringify({
          outcomeType: "result",
          resultStatus: "completed",
          resultSummary: "Heartbeat failure was ignored and the run still completed.",
          changedFiles: [],
          blockerSummary: "",
          decisionOptions: [],
          recommendedOption: ""
        }),
        "utf8"
      );
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    }
  };

  try {
    const adapter = new CodexAdapter(runner);
    await adapter.initialize(store, projection);
    const envelope = await adapter.buildResumeEnvelope(store, projection, brief);
    const execution = await adapter.executeAssignment(store, projection, envelope);
    const inspected = await adapter.inspectRun(store, assignmentId);

    assert.equal(heartbeatWriteFailed, true);
    assert.equal(execution.outcome.kind, "result");
    assert.equal(execution.outcome.capture.status, "failed");
    assert.match(execution.outcome.capture.summary, /heartbeat refresh/i);
    assert.equal(inspected?.state, "completed");
    assert.equal(inspected?.hostRunId, "thread-heartbeat-failure-1");
  } finally {
    if (originalHeartbeat === undefined) {
      delete process.env.COORTEX_RUN_HEARTBEAT_MS;
    } else {
      process.env.COORTEX_RUN_HEARTBEAT_MS = originalHeartbeat;
    }
  }
});

test("codex adapter ignores a queued heartbeat callback after completion", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-adapter-late-heartbeat-"));
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
    async startExec(input) {
      return createMockRunningExec(this, input);
    },
    async runExec(input) {
      await input.onEvent?.({ type: "thread.started", thread_id: "thread-late-heartbeat-1" });
      await mkdir(dirname(input.outputPath), { recursive: true });
      await writeFile(
        input.outputPath,
        JSON.stringify({
          outcomeType: "result",
          resultStatus: "completed",
          resultSummary: "Late heartbeat did not resurrect the running lease.",
          changedFiles: [],
          blockerSummary: "",
          decisionOptions: [],
          recommendedOption: ""
        }),
        "utf8"
      );
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    }
  };

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let queuedHeartbeat: (() => void) | undefined;
  globalThis.setInterval = ((callback: Parameters<typeof globalThis.setInterval>[0]) => {
    queuedHeartbeat = typeof callback === "function" ? callback : undefined;
    return 1 as unknown as NodeJS.Timeout;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = (() => undefined) as typeof globalThis.clearInterval;

  try {
    const adapter = new CodexAdapter(runner);
    await adapter.initialize(store, projection);
    const envelope = await adapter.buildResumeEnvelope(store, projection, brief);
    const execution = await adapter.executeAssignment(store, projection, envelope);
    queuedHeartbeat?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const inspected = await adapter.inspectRun(store, assignmentId);

    assert.equal(execution.run.state, "completed");
    assert.equal(inspected?.state, "completed");
    await assert.rejects(
      readFile(
        join(projectRoot, ".coortex", "adapters", "codex", "runs", `${assignmentId}.lease.json`),
        "utf8"
      ),
      /ENOENT/
    );
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("codex adapter writes running lease updates atomically", async () => {
  const originalHeartbeat = process.env.COORTEX_RUN_HEARTBEAT_MS;
  process.env.COORTEX_RUN_HEARTBEAT_MS = "10";

  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-adapter-atomic-lease-"));
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
  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  let leaseWrites = 0;
  (store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
  }).writeJsonArtifact = async (artifactPath, value) => {
    if (artifactPath === `adapters/codex/runs/${assignmentId}.lease.json`) {
      leaseWrites += 1;
      if (leaseWrites === 2) {
        const leasePath = join(
          projectRoot,
          ".coortex",
          "adapters",
          "codex",
          "runs",
          `${assignmentId}.lease.json`
        );
        const current = await readFile(leasePath, "utf8");
        assert.doesNotMatch(current, /\{\s*$/);
      }
    }
    return originalWriteJsonArtifact(artifactPath, value);
  };

  let releaseRun!: () => void;
  const runReleased = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const runner: CodexCommandRunner = {
    async startExec(input) {
      return createMockRunningExec(this, input);
    },
    async runExec(input) {
      await input.onEvent?.({ type: "thread.started", thread_id: "thread-atomic-lease-1" });
      await waitFor(async () => leaseWrites >= 2);
      releaseRun();
      await runReleased;
      await mkdir(dirname(input.outputPath), { recursive: true });
      await writeFile(
        input.outputPath,
        JSON.stringify({
          outcomeType: "result",
          resultStatus: "completed",
          resultSummary: "Atomic lease writes avoid torn JSON.",
          changedFiles: [],
          blockerSummary: "",
          decisionOptions: [],
          recommendedOption: ""
        }),
        "utf8"
      );
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    }
  };

  try {
    const adapter = new CodexAdapter(runner);
    await adapter.initialize(store, projection);
    const envelope = await adapter.buildResumeEnvelope(store, projection, brief);
    const execution = await adapter.executeAssignment(store, projection, envelope);

    assert.equal(execution.outcome.kind, "result");
    assert.equal(execution.outcome.capture.status, "completed");
  } finally {
    if (originalHeartbeat === undefined) {
      delete process.env.COORTEX_RUN_HEARTBEAT_MS;
    } else {
      process.env.COORTEX_RUN_HEARTBEAT_MS = originalHeartbeat;
    }
  }
});

function codexFixtureName(): string {
  return process.platform === "win32" ? "codex.cmd" : "codex";
}

function prependPath(dir: string, originalPath: string | undefined): string {
  return [dir, originalPath].filter((value): value is string => typeof value === "string").join(delimiter);
}

test("codex adapter records a failed outcome and removes the lease file when claim-time metadata persistence fails", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-adapter-claim-cleanup-"));
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
  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  let failedClaimWrite = false;
  (store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
  }).writeJsonArtifact = async (artifactPath, value) => {
    if (
      artifactPath === `adapters/codex/runs/${assignmentId}.json` &&
      !failedClaimWrite &&
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      value.state === "running"
    ) {
      failedClaimWrite = true;
      throw new Error("simulated claim metadata write failure");
    }
    return originalWriteJsonArtifact(artifactPath, value);
  };

  const runner: CodexCommandRunner = {
    async startExec() {
      throw new Error("startExec should not be reached when claim-time metadata fails");
    },
    async runExec() {
      throw new Error("runExec should not be called when startExec is stubbed");
    }
  };

  const adapter = new CodexAdapter(runner);
  await adapter.initialize(store, projection);
  const envelope = await adapter.buildResumeEnvelope(store, projection, brief);

  const execution = await adapter.executeAssignment(store, projection, envelope);

  assert.equal(execution.outcome.kind, "result");
  assert.equal(execution.outcome.capture.status, "failed");
  assert.match(execution.outcome.capture.summary, /failed before launch: simulated claim metadata write failure/i);
  assert.equal(execution.run.state, "completed");
  await assert.rejects(
    readFile(
      join(projectRoot, ".coortex", "adapters", "codex", "runs", `${assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("codex adapter claimRunLease persists a readable running lease", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-adapter-claim-lease-"));
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
  const assignmentId = bootstrap.initialAssignmentId;
  const adapter = new CodexAdapter();
  await adapter.initialize(store, projection);

  const claimed = await adapter.claimRunLease(store, projection, assignmentId);
  const inspected = await adapter.inspectRun(store, assignmentId);

  assert.equal(claimed.assignmentId, assignmentId);
  assert.equal(claimed.state, "running");
  assert.equal(inspected?.assignmentId, assignmentId);
  assert.equal(inspected?.state, "running");
  assert.equal(inspected?.startedAt, claimed.startedAt);
  assert.equal(inspected?.leaseExpiresAt, claimed.leaseExpiresAt);
});

async function createMockRunningExec(
  runner: Pick<CodexCommandRunner, "runExec">,
  input: Parameters<CodexCommandRunner["runExec"]>[0]
) {
  const result = runner.runExec({
    ...input,
    onEvent: async (event) => {
      await input.onEvent?.(event);
    }
  });
  void result.catch(() => undefined);

  return {
    result,
    terminate: async () => undefined,
    waitForExit: async () => {
      const execResult = await result;
      return { code: execResult.exitCode };
    }
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("Timed out waiting for adapter state.");
}
