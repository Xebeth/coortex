import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { CodexAdapter } from "../hosts/codex/adapter/index.js";
import type { CodexCommandRunner } from "../hosts/codex/adapter/cli.js";
import type { RuntimeConfig } from "../config/types.js";
import { getNativeRunId } from "../core/run-state.js";
import type { HostRunRecord } from "../core/types.js";
import type { RuntimeEvent } from "../core/events.js";
import { RuntimeStore } from "../persistence/store.js";
import {
  initRuntime,
  inspectRuntimeRun,
  loadReconciledProjectionWithDiagnostics,
  loadOperatorProjection,
  resumeRuntime,
  runRuntime
} from "../cli/commands.js";
import { nowIso } from "../utils/time.js";

interface SmokeSetup {
  projectRoot: string;
  store: RuntimeStore;
  adapter: CodexAdapter;
  assignmentId: string;
}

test("milestone-2 smoke: happy-path execution persists result, status, and telemetry through the real run path", async () => {
  let invocationCount = 0;
  let promptSeen = "";
  const setup = await createSmokeSetup(async (input) => {
    invocationCount += 1;
    promptSeen = input.prompt;
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Smoke path completed a tiny assignment.",
      changedFiles: ["src/cli/ctx.ts"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-1" });
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 15, cached_input_tokens: 5, output_tokens: 8 }
      }),
      stderr: ""
    };
  });

  const run = await runRuntime(setup.store, setup.adapter);
  const snapshot = await setup.store.loadSnapshot();
  const telemetry = await setup.store.loadTelemetry();
  const runRecord = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(invocationCount, 1);
  assert.match(promptSeen, /Bounded envelope:/);
  assert.equal(run.assignment.id, setup.assignmentId);
  assert.equal(run.envelope.metadata.activeAssignmentId, setup.assignmentId);
  assert.equal(snapshot?.results.length, 1);
  assert.equal(snapshot?.results[0]?.status, "completed");
  assert.equal(snapshot?.status.activeAssignmentIds.length, 0);
  assert.equal(snapshot?.status.currentObjective, "Await the next assignment.");
  assert.equal(getNativeRunId(runRecord), "smoke-thread-1");
  assert.equal(runRecord?.state, "completed");
  assert.equal(telemetry.at(-1)?.inputTokens, 15);
  assert.equal(telemetry.at(-1)?.cachedTokens, 5);
  assert.equal(telemetry.at(-1)?.totalTokens, 23);
  await assert.rejects(
    resumeRuntime(setup.store, setup.adapter),
    /No active assignment is available to resume\./
  );
});

test("milestone-2 smoke: decision path persists a blocker through the real run path", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "decision",
      resultStatus: "",
      resultSummary: "",
      changedFiles: [],
      blockerSummary: "Need a human decision before changing deployment config.",
      decisionOptions: [
        { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
        { id: "skip", label: "Skip", summary: "Skip the deployment config change." }
      ],
      recommendedOption: "wait"
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-decision" });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const run = await runRuntime(setup.store, setup.adapter);
  const snapshot = await setup.store.loadSnapshot();
  const resumed = await resumeRuntime(setup.store, setup.adapter);

  assert.equal(run.execution.outcome.kind, "decision");
  assert.equal(snapshot?.decisions.length, 1);
  assert.equal(snapshot?.decisions[0]?.state, "open");
  assert.equal(snapshot?.assignments[0]?.state, "blocked");
  assert.deepEqual(snapshot?.status.activeAssignmentIds, [setup.assignmentId]);
  assert.match(resumed.brief.nextRequiredAction, /Resolve decision/);
  assert.equal(resumed.brief.unresolvedDecisions.length, 1);
});

test("milestone-2 smoke: trimming keeps the real run envelope bounded and records trimming telemetry", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Follow-up smoke run completed.",
      changedFiles: ["src/hosts/codex/adapter/envelope.ts"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-trim" });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  await appendPartialResult(setup, "smoke-result-long", "trim-me ".repeat(250));
  const run = await runRuntime(setup.store, setup.adapter);
  const telemetry = await setup.store.loadTelemetry();
  const artifactPath = join(
    setup.projectRoot,
    ".coortex",
    "artifacts",
    "results",
    "smoke-result-long.txt"
  );
  const artifact = await readFile(artifactPath, "utf8");
  const startedTelemetry = findLastTelemetry(telemetry, "host.run.started");

  assert.equal(run.envelope.trimApplied, true);
  assert.equal(run.envelope.recentResults[0]?.trimmed, true);
  assert.equal(run.envelope.recentResults[0]?.reference, ".coortex/artifacts/results/smoke-result-long.txt");
  assert.ok(run.envelope.estimatedChars <= 4_000);
  assert.equal(artifact.trim(), ("trim-me ".repeat(250)).trim());
  assert.equal(startedTelemetry?.metadata.trimApplied, true);
  assert.equal(startedTelemetry?.metadata.trimmedFields, 1);
});

test("milestone-2 smoke: resume rebuilds partial progress from snapshot-backed interrupted durable state", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in interrupted recovery smoke test");
  });

  await appendPartialResult(setup, "smoke-interrupted-partial", "Interrupted smoke work is partially complete.");
  await rm(join(setup.projectRoot, ".coortex", "runtime", "events.ndjson"));

  const runningRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    adapterData: {
      nativeRunId: "smoke-thread-interrupted"
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, runningRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, runningRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", runningRecord);

  const statusProjection = await loadOperatorProjection(setup.store);
  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(statusProjection.status.activeAssignmentIds[0], setup.assignmentId);
  assert.equal(resumed.brief.activeAssignments.length, 1);
  assert.equal(resumed.brief.lastDurableResults.length, 1);
  assert.equal(
    resumed.brief.lastDurableResults[0]?.summary,
    "Interrupted smoke work is partially complete."
  );
  assert.match(resumed.brief.nextRequiredAction, /Continue assignment/);
  assert.equal(resumed.envelope.metadata.activeAssignmentId, setup.assignmentId);
  assert.equal(resumed.envelope.recoveryBrief.lastDurableResults.length, 1);
  assert.equal(inspected?.state, "running");
  assert.equal(getNativeRunId(inspected), "smoke-thread-interrupted");
});

test("milestone-2 smoke: profile and kernel artifacts are generated as small static files", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in profile smoke test");
  });

  const kernelPath = join(setup.projectRoot, ".coortex", "adapters", "codex", "kernel.md");
  const profilePath = join(setup.projectRoot, ".coortex", "adapters", "codex", "profile.json");
  const codexConfigPath = join(setup.projectRoot, ".codex", "config.toml");

  const kernel = await readFile(kernelPath, "utf8");
  const profile = JSON.parse(await readFile(profilePath, "utf8")) as { modelInstructionsFile: string };
  const codexConfig = await readFile(codexConfigPath, "utf8");
  const kernelStats = await stat(kernelPath);

  assert.match(kernel, /# Coortex Codex Kernel/);
  assert.match(kernel, /Consult Coortex runtime state before acting\./);
  assert.doesNotMatch(kernel, /activeAssignmentIds|sessionId|runtime\/snapshot/);
  assert.ok(kernelStats.size < 512);
  assert.equal(profile.modelInstructionsFile, kernelPath);
  assert.match(codexConfig, /# BEGIN COORTEX CODEX PROFILE/);
  assert.match(codexConfig, /model_instructions_file = ".*kernel\.md"/);
});

test("milestone-2 smoke: telemetry write failures do not block init, resume, or run", async () => {
  let invocationCount = 0;
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-m2-telemetry-failure-"));
  await mkdir(join(projectRoot, ".coortex", "runtime", "telemetry.ndjson"), { recursive: true });

  const store = RuntimeStore.forProject(projectRoot);
  const adapter = new CodexAdapter({
    async startExec(input) {
      invocationCount += 1;
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "completed",
        resultSummary: "Telemetry failure path still completed the run.",
        changedFiles: ["README.md"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-telemetry" });
      return {
        result: Promise.resolve({
          exitCode: 0,
          stdout: "",
          stderr: ""
        }),
        terminate: async () => undefined,
        waitForExit: async () => ({ code: 0 })
      };
    },
    runExec: async () => {
      throw new Error("runExec should not be called when startExec is stubbed");
    }
  });

  const initialized = await initRuntime(projectRoot, store, adapter);
  assert.ok(initialized);

  const resumed = await resumeRuntime(store, adapter);
  const run = await runRuntime(store, adapter);
  const snapshot = await store.loadSnapshot();

  assert.equal(resumed.brief.activeAssignments.length, 1);
  assert.ok(resumed.diagnostics.some((diagnostic) => diagnostic.code === "telemetry-write-failed"));
  assert.equal(invocationCount, 1);
  assert.equal(run.execution.outcome.kind, "result");
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "telemetry-write-failed"));
  assert.equal(snapshot?.results.length, 1);
  assert.equal(snapshot?.results[0]?.status, "completed");
});

test("milestone-2 smoke: final run-record write failures do not drop a completed host outcome", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Completed host outcome survived a final run-record write failure.",
      changedFiles: ["src/hosts/codex/adapter/index.ts"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-persist-warning" });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const originalWriteJsonArtifact = setup.store.writeJsonArtifact.bind(setup.store);
  let failedFinalWrite = false;
  (setup.store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
  }).writeJsonArtifact = async (artifactPath, value) => {
    if (
      artifactPath === `adapters/codex/runs/${setup.assignmentId}.json` &&
      !failedFinalWrite &&
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      value.state === "completed"
    ) {
      failedFinalWrite = true;
      throw new Error("simulated final run-record write failure");
    }
    return originalWriteJsonArtifact(artifactPath, value);
  };

  const run = await runRuntime(setup.store, setup.adapter);
  const projection = await loadOperatorProjection(setup.store);
  const snapshot = await setup.store.loadSnapshot();

  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.status, "completed");
  assert.match(run.execution.warning ?? "", /final run record could not be persisted/i);
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "completed");
  assert.equal(snapshot?.results.at(-1)?.summary, "Completed host outcome survived a final run-record write failure.");
  assert.equal(snapshot?.status.activeAssignmentIds.length, 0);
});

test("milestone-2 smoke: completed host outcomes are reconciled after runtime event persistence fails", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Completed host run was recovered after runtime event persistence failed.",
      changedFiles: ["src/cli/run-operations.ts"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-completed-recovery" });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const originalAppendEvent = setup.store.appendEvent.bind(setup.store);
  let failedOutcomeAppend = false;
  (setup.store as RuntimeStore & {
    appendEvent: RuntimeStore["appendEvent"];
  }).appendEvent = async (event) => {
    if (!failedOutcomeAppend && event.type === "result.submitted") {
      failedOutcomeAppend = true;
      throw new Error("simulated runtime event persistence failure");
    }
    await originalAppendEvent(event);
  };

  const run = await runRuntime(setup.store, setup.adapter);

  (setup.store as RuntimeStore & {
    appendEvent: RuntimeStore["appendEvent"];
  }).appendEvent = originalAppendEvent;

  const persistedRun = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.status, "completed");
  assert.ok(
    run.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed")
  );
  assert.ok(
    run.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled")
  );
  assert.equal(persistedRun?.state, "completed");
  assert.equal(persistedRun?.terminalOutcome?.kind, "result");
  assert.equal(run.projectionAfter.assignments.get(setup.assignmentId)?.state, "completed");
  assert.equal(
    [...run.projectionAfter.results.values()].at(-1)?.summary,
    "Completed host run was recovered after runtime event persistence failed."
  );
  assert.deepEqual(run.projectionAfter.status.activeAssignmentIds, []);
});

test("milestone-2 smoke: failed host outcomes are recovered in place after runtime event persistence fails", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "failed",
      resultSummary: "Durable failed host outcome was recovered after runtime event persistence failed.",
      changedFiles: [],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-failed-recovery" });
    return {
      exitCode: 2,
      stdout: "",
      stderr: ""
    };
  });

  const originalAppendEvent = setup.store.appendEvent.bind(setup.store);
  let failedOutcomeAppend = false;
  (setup.store as RuntimeStore & {
    appendEvent: RuntimeStore["appendEvent"];
  }).appendEvent = async (event) => {
    if (!failedOutcomeAppend && event.type === "result.submitted") {
      failedOutcomeAppend = true;
      throw new Error("simulated failed-result persistence interruption");
    }
    await originalAppendEvent(event);
  };

  const run = await runRuntime(setup.store, setup.adapter);

  (setup.store as RuntimeStore & {
    appendEvent: RuntimeStore["appendEvent"];
  }).appendEvent = originalAppendEvent;

  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.status, "failed");
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(run.projectionAfter.assignments.get(setup.assignmentId)?.state, "failed");
  assert.deepEqual(run.projectionAfter.status.activeAssignmentIds, []);
});

test("milestone-2 smoke: run recovers a durable outcome even if the adapter throws after completion", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Adapter throw recovery still preserved the durable result.",
      changedFiles: ["src/cli/commands.ts"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-adapter-throw" });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const originalExecuteAssignment = setup.adapter.executeAssignment.bind(setup.adapter);
  setup.adapter.executeAssignment = async (store, projection, envelope, claimedRun) => {
    const execution = await originalExecuteAssignment(store, projection, envelope, claimedRun);
    throw new Error(`simulated adapter throw after ${execution.run.state}`);
  };

  const run = await runRuntime(setup.store, setup.adapter);

  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.status, "completed");
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(run.projectionAfter.assignments.get(setup.assignmentId)?.state, "completed");
});

test("milestone-2 smoke: completed host recovery finishes convergence when only the terminal event persisted", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Recovered completed host run after only the terminal event persisted.",
      changedFiles: ["src/cli/run-operations.ts"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-terminal-only" });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const originalAppendEvent = setup.store.appendEvent.bind(setup.store);
  let failedStatusUpdate = false;
  (setup.store as RuntimeStore & {
    appendEvent: RuntimeStore["appendEvent"];
  }).appendEvent = async (event) => {
    if (!failedStatusUpdate && event.type === "status.updated") {
      failedStatusUpdate = true;
      throw new Error("simulated post-terminal event failure");
    }
    await originalAppendEvent(event);
  };

  const run = await runRuntime(setup.store, setup.adapter);

  (setup.store as RuntimeStore & {
    appendEvent: RuntimeStore["appendEvent"];
  }).appendEvent = originalAppendEvent;

  const projectionBefore = await loadOperatorProjection(setup.store);

  assert.equal(projectionBefore.assignments.get(setup.assignmentId)?.state, "completed");
  assert.deepEqual(projectionBefore.status.activeAssignmentIds, []);
  assert.ok(
    run.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed")
  );
  assert.ok(
    run.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled")
  );
  assert.equal(run.projectionAfter.assignments.get(setup.assignmentId)?.state, "completed");
  assert.deepEqual(run.projectionAfter.status.activeAssignmentIds, []);
});

test("milestone-2 smoke: completed host recovery reuses the original durable result id", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Recovered completed host run keeps a stable result id.",
      changedFiles: ["src/cli/run-operations.ts"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-stable-result-id" });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const originalAppendEvent = setup.store.appendEvent.bind(setup.store);
  let failedAssignmentUpdate = false;
  (setup.store as RuntimeStore & {
    appendEvent: RuntimeStore["appendEvent"];
  }).appendEvent = async (event) => {
    if (!failedAssignmentUpdate && event.type === "assignment.updated") {
      failedAssignmentUpdate = true;
      throw new Error("simulated post-result persistence failure");
    }
    await originalAppendEvent(event);
  };

  const run = await runRuntime(setup.store, setup.adapter);

  (setup.store as RuntimeStore & {
    appendEvent: RuntimeStore["appendEvent"];
  }).appendEvent = originalAppendEvent;

  const results = [...run.projectionAfter.results.values()].filter(
    (result) => result.assignmentId === setup.assignmentId
  );

  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.resultId, run.execution.outcome.capture.resultId);
});

test("milestone-2 smoke: non-terminal persist warnings still clear the finished lease", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "decision",
      resultStatus: "",
      resultSummary: "",
      changedFiles: [],
      blockerSummary: "Need approval before continuing the active assignment.",
      decisionOptions: [{ id: "wait", label: "Wait", summary: "Pause until guidance arrives." }],
      recommendedOption: "wait"
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-decision-persist-warning" });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const originalWriteJsonArtifact = setup.store.writeJsonArtifact.bind(setup.store);
  let failedDecisionWrite = false;
  (setup.store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
  }).writeJsonArtifact = async (artifactPath, value) => {
    if (
      artifactPath === `adapters/codex/runs/${setup.assignmentId}.json` &&
      !failedDecisionWrite &&
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      value.state === "completed"
    ) {
      failedDecisionWrite = true;
      throw new Error("simulated decision run-record write failure");
    }
    return originalWriteJsonArtifact(artifactPath, value);
  };

  const run = await runRuntime(setup.store, setup.adapter);

  assert.equal(run.execution.outcome.kind, "decision");
  assert.match(run.execution.warning ?? "", /final run record could not be persisted/i);
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 smoke: pre-launch claim failures leave runtime state unchanged", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used when pre-launch claim fails");
  });

  const originalWriteJsonArtifact = setup.store.writeJsonArtifact.bind(setup.store);
  let failedClaimWrite = false;
  (setup.store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
  }).writeJsonArtifact = async (artifactPath, value) => {
    if (
      artifactPath === `adapters/codex/runs/${setup.assignmentId}.json` &&
      !failedClaimWrite &&
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      value.state === "running"
    ) {
      failedClaimWrite = true;
      throw new Error("simulated pre-launch claim failure");
    }
    return originalWriteJsonArtifact(artifactPath, value);
  };

  await assert.rejects(
    runRuntime(setup.store, setup.adapter),
    /simulated pre-launch claim failure/
  );
  const projection = await loadOperatorProjection(setup.store);
  const snapshot = await setup.store.loadSnapshot();
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "in_progress");
  assert.equal(snapshot?.results.length, 0);
  assert.deepEqual(snapshot?.status.activeAssignmentIds, [setup.assignmentId]);
  assert.equal(inspected, undefined);
});

test("milestone-2 smoke: run repairs a malformed event log and still reports success", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Malformed-log recovery still completed the run.",
      changedFiles: ["README.md"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-malformed-log" });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const resultEventId = randomUUID();
  await writeFile(
    setup.store.eventsPath,
    `${await readFile(setup.store.eventsPath, "utf8")}${JSON.stringify({
      eventId: resultEventId,
      sessionId: (await loadOperatorProjection(setup.store)).sessionId,
      timestamp: nowIso(),
      type: "result.submitted",
      payload: {
        result: {
          resultId: randomUUID(),
          assignmentId: setup.assignmentId,
          producerId: "worker-1",
          status: "partial",
          summary: "Valid progress before malformed tail.",
          changedFiles: ["README.md"],
          createdAt: nowIso()
        }
      }
    })}\n{"broken":\n`,
    "utf8"
  );

  const run = await runRuntime(setup.store, setup.adapter);
  const projection = await loadOperatorProjection(setup.store);
  const eventLog = await readFile(setup.store.eventsPath, "utf8");

  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.projectionAfter.results.size, 2);
  assert.equal(projection.results.size, 2);
  assert.match(eventLog, /\{"broken":/);
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "event-log-repaired"));
});

test("milestone-2 smoke: equivalent executions produce stable persisted shapes", async () => {
  const [first, second] = await Promise.all([
    createSmokeSetup(stableRunner("repeatable thread", "Repeatable smoke result.")),
    createSmokeSetup(stableRunner("repeatable thread", "Repeatable smoke result."))
  ]);

  const firstRun = await runRuntime(first.store, first.adapter);
  const secondRun = await runRuntime(second.store, second.adapter);
  const firstSnapshot = await first.store.loadSnapshot();
  const secondSnapshot = await second.store.loadSnapshot();
  const firstTelemetry = findLastTelemetry(await first.store.loadTelemetry(), "host.run.completed");
  const secondTelemetry = findLastTelemetry(await second.store.loadTelemetry(), "host.run.completed");

  assert.deepEqual(
    normalizeRunArtifacts(firstRun, firstSnapshot, firstTelemetry),
    normalizeRunArtifacts(secondRun, secondSnapshot, secondTelemetry)
  );
});

test("milestone-2 smoke: resume reconciles a stale running host lease into a queued retry", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in stale reconciliation smoke test");
  });

  const staleAt = new Date(Date.now() - 60_000).toISOString();
  const expiredRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-stale" },
    startedAt: staleAt,
    heartbeatAt: staleAt,
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, expiredRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, expiredRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", expiredRecord);

  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const snapshot = await setup.store.loadSnapshot();
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.ok(resumed.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(snapshot?.assignments[0]?.state, "queued");
  assert.match(snapshot?.status.currentObjective ?? "", /Retry assignment/);
  assert.match(resumed.brief.nextRequiredAction, /Start assignment/);
  assert.equal(inspected?.state, "completed");
  assert.ok(typeof inspected?.staleAt === "string");
  assert.match(inspected?.staleReason ?? "", /lease expired/i);
});

test("milestone-2 smoke: resume uses the latest projection across multiple stale leases", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in multi-stale reconciliation smoke test");
  });

  const projection = await loadOperatorProjection(setup.store);
  const secondAssignmentId = randomUUID();
  const timestamp = nowIso();
  const secondAssignmentEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.created",
    payload: {
      assignment: {
        id: secondAssignmentId,
        parentTaskId: "task-follow-up",
        workflow: "milestone-2",
        ownerType: "host",
        ownerId: "codex",
        objective: undefined as unknown as string,
        writeScope: ["README.md"],
        requiredOutputs: ["result"],
        state: "queued",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    }
  };
  const statusEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "status.updated",
    payload: {
      status: {
        ...projection.status,
        activeAssignmentIds: [setup.assignmentId, secondAssignmentId],
        lastDurableOutputAt: timestamp
      }
    }
  };
  for (const event of [secondAssignmentEvent, statusEvent]) {
    await setup.store.appendEvent(event);
  }
  await setup.store.syncSnapshotFromEvents();

  const staleAt = new Date(Date.now() - 60_000).toISOString();
  const expiredAt = new Date(Date.now() - 1_000).toISOString();
  const firstExpiredRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-stale-first" },
    startedAt: staleAt,
    heartbeatAt: staleAt,
    leaseExpiresAt: expiredAt
  };
  const secondExpiredRecord: HostRunRecord = {
    assignmentId: secondAssignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-stale-second" },
    startedAt: staleAt,
    heartbeatAt: staleAt,
    leaseExpiresAt: expiredAt
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, firstExpiredRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${secondAssignmentId}.json`, secondExpiredRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", secondExpiredRecord);

  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const snapshot = await setup.store.loadSnapshot();
  const staleDiagnostics = resumed.diagnostics.filter(
    (diagnostic) => diagnostic.code === "stale-run-reconciled"
  );

  assert.equal(staleDiagnostics.length, 2);
  assert.equal(snapshot?.assignments.find((assignment) => assignment.id === setup.assignmentId)?.state, "queued");
  assert.equal(snapshot?.assignments.find((assignment) => assignment.id === secondAssignmentId)?.state, "queued");
  assert.deepEqual(snapshot?.status.activeAssignmentIds, [setup.assignmentId, secondAssignmentId]);
  assert.match(snapshot?.status.currentObjective ?? "", new RegExp(setup.assignmentId));
  assert.match(snapshot?.status.currentObjective ?? "", new RegExp(secondAssignmentId));
});

test("milestone-2 smoke: run refuses to start while an active host lease is still present", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used when active lease blocks rerun");
  });

  const now = new Date();
  const runningRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-active" },
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, runningRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, runningRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", runningRecord);

  await assert.rejects(
    runRuntime(setup.store, setup.adapter),
    /already has an active host run lease/
  );
});

test("milestone-2 smoke: run chooses a later active assignment when an earlier one is blocked", async () => {
  let invocationCount = 0;
  let promptSeen = "";
  const setup = await createSmokeSetup(async (input) => {
    invocationCount += 1;
    promptSeen = input.prompt;
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Second active assignment ran successfully.",
      changedFiles: [],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const projection = await loadOperatorProjection(setup.store);
  const blockedAssignmentId = setup.assignmentId;
  const runnableAssignmentId = randomUUID();
  const timestamp = nowIso();
  const newAssignmentEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.created",
    payload: {
      assignment: {
        id: runnableAssignmentId,
        parentTaskId: "task-follow-up",
        workflow: "milestone-2",
        ownerType: "host",
        ownerId: "codex",
        objective: "Handle the second active assignment.",
        writeScope: ["README.md"],
        requiredOutputs: ["result"],
        state: "queued",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    }
  };
  const blockEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.updated",
    payload: {
      assignmentId: blockedAssignmentId,
      patch: {
        state: "blocked",
        updatedAt: timestamp
      }
    }
  };
  const decisionEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "decision.created",
    payload: {
      decision: {
        decisionId: randomUUID(),
        assignmentId: blockedAssignmentId,
        requesterId: "codex",
        blockerSummary: "Need input before continuing the original assignment.",
        options: [{ id: "wait", label: "Wait", summary: "Pause until guidance arrives." }],
        recommendedOption: "wait",
        state: "open",
        createdAt: timestamp
      }
    }
  };
  const statusEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "status.updated",
    payload: {
      status: {
        ...projection.status,
        activeAssignmentIds: [blockedAssignmentId, runnableAssignmentId],
        lastDurableOutputAt: timestamp
      }
    }
  };

  for (const event of [newAssignmentEvent, blockEvent, decisionEvent, statusEvent]) {
    await setup.store.appendEvent(event);
  }
  await setup.store.syncSnapshotFromEvents();

  const run = await runRuntime(setup.store, setup.adapter);

  assert.equal(invocationCount, 1);
  assert.equal(run.assignment.id, runnableAssignmentId);
  assert.match(promptSeen, new RegExp(runnableAssignmentId));
  assert.doesNotMatch(promptSeen, new RegExp(`activeAssignmentId\\\":\\s*\\\"${blockedAssignmentId}\\\"`));
  assert.equal(run.envelope.recoveryBrief.activeAssignments.length, 1);
  assert.equal(run.envelope.recoveryBrief.activeAssignments[0]?.id, runnableAssignmentId);
  assert.match(run.envelope.recoveryBrief.nextRequiredAction, new RegExp(runnableAssignmentId));
  assert.doesNotMatch(run.envelope.recoveryBrief.nextRequiredAction, /Resolve decision|Unblock assignment/);
});

test("milestone-2 smoke: resume reconciles a running host record without a lease expiry", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in lease-less reconciliation smoke test");
  });

  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const leaseLessRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-missing-lease" },
    startedAt,
    heartbeatAt: startedAt
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, leaseLessRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-missing-lease" },
    startedAt
  });
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", leaseLessRecord);

  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const snapshot = await setup.store.loadSnapshot();
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.ok(resumed.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(snapshot?.assignments[0]?.state, "queued");
  assert.match(inspected?.staleReason ?? "", /without a lease expiry/i);
});

test("milestone-2 smoke: stale lease-only runs are reconciled and cleared for rerun", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-lease-only" });
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Lease-only recovery allowed the replacement run to finish.",
      changedFiles: [],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const expiredLeaseOnlyRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-lease-only-stale" },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  await setup.store.writeJsonArtifact(
    `adapters/codex/runs/${setup.assignmentId}.lease.json`,
    expiredLeaseOnlyRecord
  );

  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const run = await runRuntime(setup.store, setup.adapter);

  assert.ok(resumed.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.status, "completed");
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 smoke: malformed lease JSON is ignored and recovery still reruns the assignment", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-malformed-lease" });
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Malformed lease recovery allowed the replacement run to finish.",
      changedFiles: [],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  await mkdir(join(setup.projectRoot, ".coortex", "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
    "{",
    "utf8"
  );

  const inspectedBeforeRun = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
  const leaseBeforeRun = await readFile(
    join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
    "utf8"
  );
  const run = await runRuntime(setup.store, setup.adapter);

  assert.equal(inspectedBeforeRun?.state, "running");
  assert.equal(leaseBeforeRun, "{");
  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.status, "completed");
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 smoke: malformed lease reconciliation preserves the malformed lease reason", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in malformed lease reconciliation reason smoke test");
  });

  await mkdir(join(setup.projectRoot, ".coortex", "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
    "{",
    "utf8"
  );

  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.ok(resumed.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(inspected?.state, "completed");
  assert.equal(inspected?.staleReasonCode, "malformed_lease_artifact");
  assert.equal(inspected?.staleReason, "malformed lease file");
});

test("milestone-2 smoke: completed run record wins over a leftover lease during recovery", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in completed-record lease recovery smoke test");
  });

  const completedRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    adapterData: { nativeRunId: "smoke-thread-completed" },
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    completedAt: new Date(Date.now() - 110_000).toISOString(),
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Old completed run",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: randomUUID(),
        producerId: "codex",
        status: "completed",
        summary: "Old completed run",
        changedFiles: [],
        createdAt: new Date(Date.now() - 110_000).toISOString()
      }
    }
  };
  const staleLease: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-stale-lease" },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/last-run.json`, completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, staleLease);

  const resumed = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(resumed.projection.assignments.get(setup.assignmentId)?.state, "completed");
  assert.deepEqual(resumed.projection.status.activeAssignmentIds, []);
  assert.equal([...resumed.projection.results.values()].length, 1);
  assert.ok(!resumed.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(inspected?.state, "completed");
  assert.equal(inspected?.resultStatus, "completed");
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 smoke: stale reconciliation is idempotent after the first recovery", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in stale reconciliation idempotence smoke test");
  });

  const staleRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-stale-repeat" },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, staleRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", staleRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, staleRecord);

  const firstResume = await resumeRuntime(setup.store, setup.adapter);
  const secondResume = await resumeRuntime(setup.store, setup.adapter);
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
  const telemetry = await setup.store.loadTelemetry();
  const staleTelemetryCount = telemetry.filter(
    (event) => event.eventType === "host.run.stale_reconciled"
  ).length;

  assert.ok(firstResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(!secondResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(inspected?.state, "completed");
  assert.equal(staleTelemetryCount, 1);
});

test("milestone-2 smoke: stale reconciliation retries artifact cleanup after runtime state is durable", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in stale reconciliation retry smoke test");
  });

  const staleRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-stale-retry-artifacts" },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, staleRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", staleRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, staleRecord);

  const originalReconcile = setup.adapter.reconcileStaleRun.bind(setup.adapter);
  let reconcileAttempts = 0;
  setup.adapter.reconcileStaleRun = async (store, record) => {
    reconcileAttempts += 1;
    if (reconcileAttempts === 1) {
      throw new Error("simulated stale artifact write failure");
    }
    await originalReconcile(store, record);
  };

  const firstResume = await resumeRuntime(setup.store, setup.adapter);
  const snapshotAfterFirst = await setup.store.loadSnapshot();
  const inspectedAfterFirst = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
  const secondStatusProjection = await loadOperatorProjection(setup.store);
  const secondResume = await resumeRuntime(setup.store, setup.adapter);
  const inspectedAfterSecond = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
  const telemetry = await setup.store.loadTelemetry();
  const staleTelemetryCount = telemetry.filter(
    (event) => event.eventType === "host.run.stale_reconciled"
  ).length;

  assert.ok(firstResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(firstResume.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.equal(snapshotAfterFirst?.assignments[0]?.state, "queued");
  assert.equal(inspectedAfterFirst?.state, "running");
  assert.equal(secondStatusProjection.assignments.get(setup.assignmentId)?.state, "queued");
  assert.ok(!secondResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(inspectedAfterSecond?.state, "completed");
  assert.equal(reconcileAttempts, 2);
  assert.equal(staleTelemetryCount, 1);
});

test("milestone-2 smoke: stale retries move back to in-progress before the replacement host run", async () => {
  let assignmentStateDuringRetry = "";
  const setup = await createSmokeSetup(async (input) => {
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-retry" });
    const projection = await loadOperatorProjection(setup.store);
    assignmentStateDuringRetry = projection.assignments.get(setup.assignmentId)?.state ?? "";
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Retry run completed after stale reconciliation.",
      changedFiles: [],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const expiredRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-old-stale" },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, expiredRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", expiredRecord);

  const run = await runRuntime(setup.store, setup.adapter);

  assert.equal(assignmentStateDuringRetry, "in_progress");
  assert.equal(run.projectionBefore.assignments.get(setup.assignmentId)?.state, "in_progress");
});

test("milestone-2 smoke: concurrent run attempts do not launch duplicate host executions", async () => {
  let invocationCount = 0;
  let releaseRun!: () => void;
  const runReleased = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });

  const setup = await createSmokeSetup(async (input) => {
    invocationCount += 1;
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-concurrent" });
    await runReleased;
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Concurrent run protection kept a single host run.",
      changedFiles: [],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const firstRun = runRuntime(setup.store, setup.adapter);
  await waitFor(async () => (await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId))?.state === "running");
  await assert.rejects(
    runRuntime(setup.store, setup.adapter),
    /already has an active host run lease/
  );
  releaseRun();
  await firstRun;
  const snapshot = await setup.store.loadSnapshot();

  assert.equal(invocationCount, 1);
  assert.equal(snapshot?.results.length, 1);
  assert.equal(snapshot?.results[0]?.status, "completed");
});

async function createSmokeSetup(runExec: CodexCommandRunner["runExec"]): Promise<SmokeSetup> {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-m2-smoke-"));
  const store = RuntimeStore.forProject(projectRoot);
  const adapter = new CodexAdapter({
    async startExec(input) {
      const result = runExec({
        ...input,
        onEvent: async (event) => {
          await input.onEvent?.(event);
        }
      });
      return {
        result,
        terminate: async () => undefined,
        waitForExit: async () => {
          const execResult = await result;
          return { code: execResult.exitCode };
        }
      };
    },
    runExec
  });
  const initialized = await initRuntime(projectRoot, store, adapter);
  if (!initialized) {
    throw new Error("Expected a fresh smoke runtime.");
  }
  const projection = await loadOperatorProjection(store);
  const assignmentId = projection.status.activeAssignmentIds[0];
  if (!assignmentId) {
    throw new Error("Expected an active assignment after smoke setup.");
  }
  return {
    projectRoot,
    store,
    adapter,
    assignmentId
  };
}

async function appendPartialResult(setup: SmokeSetup, resultId: string, summary: string): Promise<void> {
  await setup.store.appendEvent({
    eventId: randomUUID(),
    sessionId: (await loadOperatorProjection(setup.store)).sessionId,
    timestamp: nowIso(),
    type: "result.submitted",
    payload: {
      result: {
        resultId,
        assignmentId: setup.assignmentId,
        producerId: "codex",
        status: "partial",
        summary,
        changedFiles: ["src/hosts/codex/adapter/envelope.ts"],
        createdAt: nowIso()
      }
    }
  });
  await setup.store.syncSnapshotFromEvents();
}

async function writeStructuredOutput(outputPath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload), "utf8");
}

function stableRunner(threadId: string, summary: string): CodexCommandRunner["runExec"] {
  return async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: summary,
      changedFiles: ["src/cli/ctx.ts"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: threadId });
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 6 }
      }),
      stderr: ""
    };
  };
}

function normalizeRunArtifacts(
  run: Awaited<ReturnType<typeof runRuntime>>,
  snapshot: Awaited<ReturnType<RuntimeStore["loadSnapshot"]>>,
  completedTelemetry:
    | Awaited<ReturnType<RuntimeStore["loadTelemetry"]>>[number]
    | undefined
) {
  return {
    envelope: {
      host: run.envelope.host,
      adapter: run.envelope.adapter,
      objective: normalizeBootstrapObjective(run.envelope.objective),
      writeScope: [...run.envelope.writeScope],
      requiredOutputs: [...run.envelope.requiredOutputs],
      recentResults: run.envelope.recentResults.map((result) => ({
        trimmed: result.trimmed,
        summary: result.summary,
        hasReference: typeof result.reference === "string"
      })),
      metadata: {
        ...run.envelope.metadata,
        activeAssignmentId: "<active-assignment>"
      },
      estimatedChars: run.envelope.estimatedChars,
      trimApplied: run.envelope.trimApplied,
      trimmedFields: run.envelope.trimmedFields.map((field) => ({
        label: field.label,
        originalChars: field.originalChars,
        keptChars: field.keptChars,
        hasReference: field.reference.length > 0
      }))
    },
    execution: {
      outcomeKind: run.execution.outcome.kind,
      runState: run.execution.run.state,
      nativeRunId: getNativeRunId(run.execution.run),
      result:
        run.execution.outcome.kind === "result"
          ? {
              status: run.execution.outcome.capture.status,
              summary: run.execution.outcome.capture.summary,
              changedFiles: [...run.execution.outcome.capture.changedFiles]
            }
          : undefined,
      decision:
        run.execution.outcome.kind === "decision"
          ? {
              blockerSummary: run.execution.outcome.capture.blockerSummary,
              recommendedOption: run.execution.outcome.capture.recommendedOption,
              options: run.execution.outcome.capture.options.map((option) => ({
                id: option.id,
                label: option.label,
                summary: option.summary
              }))
            }
          : undefined
    },
    snapshot: snapshot
      ? {
          status: {
            activeMode: snapshot.status.activeMode,
            currentObjective: snapshot.status.currentObjective,
            activeAssignmentCount: snapshot.status.activeAssignmentIds.length,
            activeHost: snapshot.status.activeHost,
            activeAdapter: snapshot.status.activeAdapter,
            resumeReady: snapshot.status.resumeReady
          },
          assignments: snapshot.assignments.map((assignment) => ({
          workflow: assignment.workflow,
          ownerType: assignment.ownerType,
          ownerId: assignment.ownerId,
          objective: normalizeBootstrapObjective(assignment.objective),
            writeScope: [...assignment.writeScope],
            requiredOutputs: [...assignment.requiredOutputs],
            state: assignment.state
          })),
          results: snapshot.results.map((result) => ({
            assignmentIdMatchesActive: result.assignmentId.length > 0,
            producerId: result.producerId,
            status: result.status,
            summary: result.summary,
            changedFiles: [...result.changedFiles]
          })),
          decisions: snapshot.decisions.map((decision) => ({
            requesterId: decision.requesterId,
            blockerSummary: decision.blockerSummary,
            recommendedOption: decision.recommendedOption,
            state: decision.state,
            options: decision.options.map((option) => ({
              id: option.id,
              label: option.label,
              summary: option.summary
            }))
          }))
        }
      : undefined,
    completedTelemetry: completedTelemetry
      ? {
          eventType: completedTelemetry.eventType,
          host: completedTelemetry.host,
          adapter: completedTelemetry.adapter,
          metadata: completedTelemetry.metadata,
          inputTokens: completedTelemetry.inputTokens,
          outputTokens: completedTelemetry.outputTokens,
          totalTokens: completedTelemetry.totalTokens,
          cachedTokens: completedTelemetry.cachedTokens
        }
      : undefined
  };
}

function findLastTelemetry(
  events: Awaited<ReturnType<RuntimeStore["loadTelemetry"]>>,
  eventType: string
) {
  return [...events].reverse().find((event) => event.eventType === eventType);
}

function normalizeBootstrapObjective(value: string): string {
  return value.replace(
    /Coordinate work for coortex-m2-smoke-[^ ]+ through the Coortex runtime\./g,
    "Coordinate work for <smoke-project> through the Coortex runtime."
  );
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
  throw new Error("Timed out waiting for smoke state.");
}
