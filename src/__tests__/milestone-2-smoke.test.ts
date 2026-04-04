import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { CodexAdapter } from "../hosts/codex/adapter/index.js";
import type { CodexCommandRunner } from "../hosts/codex/adapter/cli.js";
import type { RuntimeConfig } from "../config/types.js";
import type { HostRunRecord } from "../adapters/contract.js";
import { RuntimeStore } from "../persistence/store.js";
import { initRuntime, inspectRuntimeRun, loadOperatorProjection, resumeRuntime, runRuntime } from "../cli/commands.js";
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
  assert.equal(runRecord?.hostRunId, "smoke-thread-1");
  assert.equal(runRecord?.state, "completed");
  assert.equal(telemetry.at(-1)?.inputTokens, 15);
  assert.equal(telemetry.at(-1)?.cachedTokens, 5);
  assert.equal(telemetry.at(-1)?.totalTokens, 23);
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
    hostRunId: "smoke-thread-interrupted",
    startedAt: nowIso()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, runningRecord);
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
  assert.equal(inspected?.hostRunId, "smoke-thread-interrupted");
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

async function createSmokeSetup(runExec: CodexCommandRunner["runExec"]): Promise<SmokeSetup> {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-m2-smoke-"));
  const store = RuntimeStore.forProject(projectRoot);
  const adapter = new CodexAdapter({ runExec });
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
      hostRunId: run.execution.run.hostRunId,
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
