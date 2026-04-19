import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { CodexAdapter } from "../hosts/codex/adapter/index.js";
import type { CodexCommandRunner } from "../hosts/codex/adapter/cli.js";
import { deriveWorkflowRunAttemptIdentity } from "../adapters/host-run-records.js";
import type { RuntimeConfig } from "../config/types.js";
import { getNativeRunId } from "../core/run-state.js";
import type { HostRunRecord } from "../core/types.js";
import type { RuntimeEvent } from "../core/events.js";
import { RuntimeStore } from "../persistence/store.js";
import {
  initRuntime,
  inspectRuntimeContext,
  inspectRuntimeRun,
  loadReconciledProjectionWithDiagnostics,
  loadOperatorProjection,
  resumeRuntime,
  runRuntime
} from "../cli/commands.js";
import {
  loadWorkflowAwareProjection,
  loadWorkflowAwareProjectionWithDiagnostics
} from "../cli/runtime-state.js";
import { nowIso } from "../utils/time.js";
import { evaluateWorkflowProgression, workflowArtifactPath } from "../workflows/index.js";
import type { WorkflowArtifactDocument } from "../workflows/types.js";

interface SmokeSetup {
  projectRoot: string;
  store: RuntimeStore;
  adapter: CodexAdapter;
  assignmentId: string;
}

async function currentWorkflowAttempt(
  store: RuntimeStore,
  assignmentId: string
): Promise<NonNullable<HostRunRecord["workflowAttempt"]>> {
  const workflowAttempt = deriveWorkflowRunAttemptIdentity(
    await loadOperatorProjection(store),
    assignmentId
  );
  assert.ok(workflowAttempt, "expected workflow attempt identity for the current workflow assignment");
  return workflowAttempt;
}

async function countQueuedAssignmentUpdatedEvents(
  store: RuntimeStore,
  assignmentId: string
): Promise<number> {
  const events = (await store.loadEvents()) as Array<{
    type: string;
    payload: { assignmentId?: string; patch?: { state?: string } };
  }>;

  return events.filter(
    (event) =>
      event.type === "assignment.updated" &&
      event.payload.assignmentId === assignmentId &&
      event.payload.patch?.state === "queued"
  ).length;
}

test("milestone-2 integration: command helpers share one initialization guard", async () => {
  const expectedMessage = "Coortex is not initialized. Run `ctx init` first.";
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-m2-uninitialized-commands-"));
  const store = RuntimeStore.forProject(projectRoot);
  const adapter = new CodexAdapter();

  await assert.rejects(() => resumeRuntime(store, adapter), {
    message: expectedMessage
  });
  await assert.rejects(() => runRuntime(store, adapter), {
    message: expectedMessage
  });
  await assert.rejects(() => inspectRuntimeRun(store, adapter), {
    message: expectedMessage
  });
  await assert.rejects(() => inspectRuntimeContext(store, adapter), {
    message: expectedMessage
  });
});

test("milestone-2 integration: trimming keeps the real run envelope bounded and records trimming telemetry", async () => {
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

test("milestone-2 integration: resume refuses snapshot-backed interrupted state behind an authoritative live lease", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in interrupted recovery smoke test");
  });

  await appendPartialResult(setup, "smoke-interrupted-partial", "Interrupted smoke work is partially complete.");
  await rm(join(setup.projectRoot, ".coortex", "runtime", "events.ndjson"));
  const workflowAttempt = await currentWorkflowAttempt(setup.store, setup.assignmentId);

  const runningRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    workflowAttempt,
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
  const reconciled = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);
  await assert.rejects(
    resumeRuntime(setup.store, setup.adapter),
    new RegExp(`Assignment ${setup.assignmentId} already has an active host run lease\\.`)
  );
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(statusProjection.status.activeAssignmentIds[0], setup.assignmentId);
  assert.deepEqual(reconciled.activeLeases, [setup.assignmentId]);
  assert.equal(reconciled.projection.results.size, 1);
  assert.equal(
    [...reconciled.projection.results.values()][0]?.summary,
    "Interrupted smoke work is partially complete."
  );
  assert.equal(
    inspected?.assignmentId,
    setup.assignmentId
  );
  assert.equal(inspected?.state, "running");
  assert.equal(getNativeRunId(inspected), "smoke-thread-interrupted");
});

test("milestone-2 integration: profile and kernel artifacts are generated as small static files", async () => {
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

test("milestone-2 integration: telemetry write failures do not block init, resume, or run", async () => {
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

test("milestone-2 integration: final run-record write failures do not drop a completed host outcome", async () => {
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
  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "queued");
  assert.equal(snapshot?.results.at(-1)?.summary, "Completed host outcome survived a final run-record write failure.");
  assert.deepEqual(snapshot?.status.activeAssignmentIds, [setup.assignmentId]);
  assert.match(snapshot?.status.currentObjective ?? "", new RegExp(`Start plan assignment ${setup.assignmentId}:`));
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: completed host outcomes are not reported as recovered when no durable terminal record exists", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "This outcome should not be synthesized without durable host metadata.",
      changedFiles: ["src/cli/commands.ts"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-no-durable-recovery" });
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

  await assert.rejects(
    runRuntime(setup.store, setup.adapter),
    /simulated runtime event persistence failure/
  );

  (setup.store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
    appendEvent: RuntimeStore["appendEvent"];
  }).writeJsonArtifact = originalWriteJsonArtifact;
  (setup.store as RuntimeStore & {
    appendEvent: RuntimeStore["appendEvent"];
  }).appendEvent = originalAppendEvent;

  const projection = await loadOperatorProjection(setup.store);
  const snapshot = await setup.store.loadSnapshot();
  const persistedRun = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "in_progress");
  assert.deepEqual(projection.status.activeAssignmentIds, [setup.assignmentId]);
  assert.equal(snapshot?.results.length, 0);
  assert.equal(persistedRun?.state, "completed");
  assert.equal(persistedRun?.terminalOutcome, undefined);
  assert.equal(persistedRun?.staleReasonCode, "missing_lease_artifact");
});

test("milestone-2 integration: run recovers a durable outcome even if the adapter throws after completion", async () => {
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
  const snapshot = await setup.store.loadSnapshot();
  const persistedEnvelope = JSON.parse(
    await readFile(join(setup.projectRoot, ".coortex", "runtime", "last-resume-envelope.json"), "utf8")
  ) as typeof run.envelope;

  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.status, "completed");
  assert.equal(run.recoveredOutcome, true);
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(run.projectionAfter.assignments.get(setup.assignmentId)?.state, "queued");
  assert.equal(snapshot?.results.at(-1)?.assignmentId, setup.assignmentId);
  assert.deepEqual(run.projectionAfter.status.activeAssignmentIds, [setup.assignmentId]);
  assert.match(
    run.projectionAfter.status.currentObjective,
    new RegExp(`Start plan assignment ${setup.assignmentId}:`)
  );
  assert.equal(run.envelope.metadata.recoveredOutcome, true);
  assert.equal(run.envelope.metadata.activeAssignmentId, setup.assignmentId);
  assert.equal(run.envelope.objective, run.projectionAfter.assignments.get(setup.assignmentId)?.objective);
  assert.equal(persistedEnvelope.metadata.recoveredOutcome, true);
  assert.equal(persistedEnvelope.metadata.activeAssignmentId, setup.assignmentId);
  assert.equal(persistedEnvelope.objective, run.envelope.objective);
  assert.equal(await countQueuedAssignmentUpdatedEvents(setup.store, setup.assignmentId), 1);
});

test("milestone-2 integration: recovered plan advancement envelope matches the converged review assignment", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in recovered plan advancement smoke test");
  });
  const workflowAttempt = await currentWorkflowAttempt(setup.store, setup.assignmentId);

  await setup.store.writeJsonArtifact(
    workflowArtifactPath("default", 1, "plan", setup.assignmentId, 1),
    {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "plan",
      moduleAttempt: 1,
      assignmentId: setup.assignmentId,
      createdAt: "2026-04-16T09:01:00.000Z",
      payload: {
        planSummary: "Recovered plan is ready for review.",
        implementationSteps: ["Advance directly to review."],
        reviewEvidenceSummary: "Recovered plan output is complete."
      }
    } satisfies WorkflowArtifactDocument
  );

  const completedRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    workflowAttempt,
    adapterData: { nativeRunId: "plan-advance-recovered-thread" },
    startedAt: "2026-04-16T09:00:00.000Z",
    completedAt: "2026-04-16T09:01:00.000Z",
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Recovered plan advancement completed.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: "plan-advance-recovered-result",
        producerId: "codex",
        status: "completed",
        summary: "Recovered plan advancement completed.",
        changedFiles: ["src/workflows/modules/plan.ts"],
        createdAt: "2026-04-16T09:01:00.000Z"
      }
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", completedRecord);

  const run = await runRuntime(setup.store, setup.adapter);
  const reviewAssignmentId = run.projectionAfter.workflowProgress?.currentAssignmentId;
  const reviewAssignment = reviewAssignmentId
    ? run.projectionAfter.assignments.get(reviewAssignmentId)
    : undefined;
  const persistedEnvelope = JSON.parse(
    await readFile(join(setup.projectRoot, ".coortex", "runtime", "last-resume-envelope.json"), "utf8")
  ) as typeof run.envelope;

  assert.equal(run.recoveredOutcome, true);
  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.assignmentId, setup.assignmentId);
  assert.ok(reviewAssignmentId, "expected recovery to advance into review");
  assert.equal(run.envelope.workflow?.currentModuleId, "review");
  assert.equal(run.envelope.workflow?.currentAssignmentId, reviewAssignmentId);
  assert.equal(run.envelope.metadata.activeAssignmentId, reviewAssignmentId);
  assert.equal(run.envelope.objective, reviewAssignment?.objective);
  assert.deepEqual(run.envelope.requiredOutputs, reviewAssignment?.requiredOutputs);
  assert.equal(persistedEnvelope.metadata.recoveredOutcome, true);
  assert.equal(persistedEnvelope.workflow?.currentModuleId, "review");
  assert.equal(persistedEnvelope.workflow?.currentAssignmentId, reviewAssignmentId);
  assert.equal(persistedEnvelope.metadata.activeAssignmentId, reviewAssignmentId);
  assert.equal(persistedEnvelope.objective, reviewAssignment?.objective);
});

test("milestone-2 integration: inspect converges onto a pre-created review assignment when advance transition persistence is interrupted", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in interrupted advance convergence smoke test");
  });
  const interruptedEvents = await appendWorkflowProgressionWithOmissions(setup.store, {
    artifact: {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "plan",
      moduleAttempt: 1,
      assignmentId: setup.assignmentId,
      createdAt: "2026-04-18T09:01:00.000Z",
      payload: {
        planSummary: "Plan ready for review.",
        implementationSteps: ["Reuse the durable review assignment."],
        reviewEvidenceSummary: "Interrupted advance should converge onto the pre-created review assignment."
      }
    },
    resultId: "plan-result-interrupted-advance",
    summary: "Plan completed before transition persistence finished.",
    createdAt: "2026-04-18T09:01:00.000Z",
    progressionAt: "2026-04-18T09:01:01.000Z",
    omitEventTypes: ["workflow.transition.applied"]
  });
  const createdReviewAssignment = interruptedEvents.find(
    (event): event is Extract<RuntimeEvent, { type: "assignment.created" }> =>
      event.type === "assignment.created"
  );
  assert.ok(createdReviewAssignment, "expected the interrupted advance to pre-create a review assignment");

  const reviewAssignmentId = createdReviewAssignment.payload.assignment.id;
  const activeLeaseStartedAt = new Date(Date.now() - 60_000).toISOString();
  const activeLeaseHeartbeatAt = new Date(Date.now() - 5_000).toISOString();
  const activeLeaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const reviewRun: HostRunRecord = {
    assignmentId: reviewAssignmentId,
    state: "running",
    workflowAttempt: {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "review",
      moduleAttempt: 1
    },
    adapterData: { nativeRunId: "interrupted-advance-review-thread" },
    startedAt: activeLeaseStartedAt,
    heartbeatAt: activeLeaseHeartbeatAt,
    leaseExpiresAt: activeLeaseExpiresAt
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${reviewAssignmentId}.json`, reviewRun);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${reviewAssignmentId}.lease.json`, reviewRun);

  const loaded = await loadWorkflowAwareProjectionWithDiagnostics(setup.store, setup.adapter);
  const inspected = await inspectRuntimeContext(setup.store, setup.adapter);
  const visibleRun = inspected.record?.run as HostRunRecord | null;

  assert.equal(loaded.projection.workflowProgress?.currentAssignmentId, reviewAssignmentId);
  assert.deepEqual(loaded.activeLeases, [reviewAssignmentId]);
  assert.deepEqual(loaded.hiddenActiveLeases, []);
  assert.equal(inspected.record?.workflow?.currentModuleId, "review");
  assert.equal(inspected.record?.workflow?.currentAssignmentId, reviewAssignmentId);
  assert.equal(inspected.record?.assignment?.id, reviewAssignmentId);
  assert.equal(visibleRun?.assignmentId, reviewAssignmentId);
  assert.equal(visibleRun?.workflowAttempt?.moduleId, "review");
});

test("milestone-2 integration: loadWorkflowAwareProjection returns the converged projection", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in workflow-aware projection load smoke test");
  });

  const projection = await loadWorkflowAwareProjection(setup.store, setup.adapter);
  const loaded = await loadWorkflowAwareProjectionWithDiagnostics(setup.store, setup.adapter);

  assert.equal(projection.sessionId, loaded.projection.sessionId);
  assert.deepEqual(projection.status, loaded.projection.status);
  assert.equal(
    projection.workflowProgress?.currentAssignmentId,
    loaded.projection.workflowProgress?.currentAssignmentId
  );
  assert.equal(
    projection.workflowProgress?.currentModuleId,
    loaded.projection.workflowProgress?.currentModuleId
  );
});

test("milestone-2 integration: interrupted advance recovers a completed run on the newly current assignment in the same load", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in interrupted advance completed-recovery smoke test");
  });
  const interruptedEvents = await appendWorkflowProgressionWithOmissions(setup.store, {
    artifact: {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "plan",
      moduleAttempt: 1,
      assignmentId: setup.assignmentId,
      createdAt: "2026-04-18T09:11:00.000Z",
      payload: {
        planSummary: "Plan ready for review.",
        implementationSteps: ["Recover the pre-created review completion in one load."],
        reviewEvidenceSummary: "Interrupted advance should still absorb the durable review outcome."
      }
    },
    resultId: "plan-result-interrupted-advance-completed",
    summary: "Plan completed before transition persistence finished.",
    createdAt: "2026-04-18T09:11:00.000Z",
    progressionAt: "2026-04-18T09:11:01.000Z",
    omitEventTypes: ["workflow.transition.applied"]
  });
  const reviewAssignmentId = interruptedEvents.find(
    (event): event is Extract<RuntimeEvent, { type: "assignment.created" }> =>
      event.type === "assignment.created"
  )?.payload.assignment.id;
  assert.ok(reviewAssignmentId, "expected interrupted advance to pre-create a review assignment");

  await setup.store.writeJsonArtifact(
    workflowArtifactPath("default", 1, "review", reviewAssignmentId, 1),
    {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "review",
      moduleAttempt: 1,
      assignmentId: reviewAssignmentId,
      createdAt: "2026-04-18T09:12:00.000Z",
      payload: {
        verdict: "approved",
        rationaleSummary: "Review approved after the interrupted advance."
      }
    } satisfies WorkflowArtifactDocument
  );
  const completedReviewRun: HostRunRecord = {
    assignmentId: reviewAssignmentId,
    state: "completed",
    workflowAttempt: {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "review",
      moduleAttempt: 1
    },
    adapterData: { nativeRunId: "interrupted-advance-review-completed" },
    startedAt: "2026-04-18T09:11:30.000Z",
    completedAt: "2026-04-18T09:12:00.000Z",
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Recovered review completion.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: "review-result-interrupted-advance-completed",
        producerId: "codex",
        status: "completed",
        summary: "Recovered review completion.",
        changedFiles: ["src/workflows/modules/review.ts"],
        createdAt: "2026-04-18T09:12:00.000Z"
      }
    }
  };
  await setup.store.writeJsonArtifact(
    `adapters/codex/runs/${reviewAssignmentId}.json`,
    completedReviewRun
  );
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", completedReviewRun);

  const loaded = await loadWorkflowAwareProjectionWithDiagnostics(setup.store, setup.adapter);

  assert.equal(loaded.recoveredRunRecord?.assignmentId, reviewAssignmentId);
  assert.match(
    loaded.diagnostics.map((diagnostic) => diagnostic.code).join(","),
    /completed-run-reconciled/
  );
  assert.equal(loaded.projection.workflowProgress?.currentModuleId, "verify");
  assert.equal(loaded.projection.workflowProgress?.workflowCycle, 1);
});

test("milestone-2 integration: interrupted advance treats a stale pre-created next assignment as current stale recovery, not hidden cleanup", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in interrupted advance stale-recovery smoke test");
  });
  const interruptedEvents = await appendWorkflowProgressionWithOmissions(setup.store, {
    artifact: {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "plan",
      moduleAttempt: 1,
      assignmentId: setup.assignmentId,
      createdAt: "2026-04-18T09:21:00.000Z",
      payload: {
        planSummary: "Plan ready for review.",
        implementationSteps: ["Repair the stale review run after interrupted advance."],
        reviewEvidenceSummary: "The stale pre-created review assignment should rerun as current work."
      }
    },
    resultId: "plan-result-interrupted-advance-stale",
    summary: "Plan completed before transition persistence finished.",
    createdAt: "2026-04-18T09:21:00.000Z",
    progressionAt: "2026-04-18T09:21:01.000Z",
    omitEventTypes: ["workflow.transition.applied"]
  });
  const reviewAssignmentId = interruptedEvents.find(
    (event): event is Extract<RuntimeEvent, { type: "assignment.created" }> =>
      event.type === "assignment.created"
  )?.payload.assignment.id;
  assert.ok(reviewAssignmentId, "expected interrupted advance to pre-create a review assignment");

  const staleReviewRun: HostRunRecord = {
    assignmentId: reviewAssignmentId,
    state: "running",
    workflowAttempt: {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "review",
      moduleAttempt: 1
    },
    adapterData: { nativeRunId: "interrupted-advance-review-stale" },
    startedAt: "2026-01-18T09:21:30.000Z",
    heartbeatAt: "2026-01-18T09:21:30.000Z",
    leaseExpiresAt: "2026-01-18T09:21:31.000Z"
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${reviewAssignmentId}.json`, staleReviewRun);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${reviewAssignmentId}.lease.json`, staleReviewRun);

  const loaded = await loadWorkflowAwareProjectionWithDiagnostics(setup.store, setup.adapter);
  const diagnosticCodes = loaded.diagnostics.map((diagnostic) => diagnostic.code);

  assert.equal(loaded.projection.workflowProgress?.currentAssignmentId, reviewAssignmentId);
  assert.equal(loaded.projection.workflowProgress?.currentModuleId, "review");
  assert.equal(loaded.projection.workflowProgress?.currentModuleAttempt, 2);
  assert.ok(diagnosticCodes.includes("stale-run-reconciled"));
  assert.ok(!diagnosticCodes.includes("hidden-run-cleaned"));
  assert.deepEqual(loaded.activeLeases, []);
  assert.deepEqual(loaded.hiddenActiveLeases, []);
});

test("milestone-2 integration: completed host recovery finishes convergence when only the terminal event persisted", async () => {
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
  const snapshot = await setup.store.loadSnapshot();

  assert.equal(projectionBefore.assignments.get(setup.assignmentId)?.state, "queued");
  assert.deepEqual(projectionBefore.status.activeAssignmentIds, [setup.assignmentId]);
  assert.match(
    projectionBefore.status.currentObjective,
    new RegExp(`Start plan assignment ${setup.assignmentId}:`)
  );
  assert.ok(
    run.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed")
  );
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(run.projectionAfter.assignments.get(setup.assignmentId)?.state, "queued");
  assert.deepEqual(run.projectionAfter.status.activeAssignmentIds, [setup.assignmentId]);
  assert.match(
    run.projectionAfter.status.currentObjective,
    new RegExp(`Start plan assignment ${setup.assignmentId}:`)
  );
  assert.equal(snapshot?.results.at(-1)?.assignmentId, setup.assignmentId);
  assert.equal(await countQueuedAssignmentUpdatedEvents(setup.store, setup.assignmentId), 1);
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: completed host recovery reuses the original durable result id", async () => {
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
    if (
      !failedAssignmentUpdate &&
      event.type === "assignment.updated" &&
      event.payload.assignmentId === setup.assignmentId &&
      event.payload.patch.state === "queued"
    ) {
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
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(run.projectionAfter.assignments.get(setup.assignmentId)?.state, "queued");
  assert.deepEqual(run.projectionAfter.status.activeAssignmentIds, [setup.assignmentId]);
  assert.match(
    run.projectionAfter.status.currentObjective,
    new RegExp(`Start plan assignment ${setup.assignmentId}:`)
  );
  assert.equal(await countQueuedAssignmentUpdatedEvents(setup.store, setup.assignmentId), 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.resultId, run.execution.outcome.capture.resultId);
});

test("milestone-2 integration: recovered legacy outcomes use the shared bounded envelope builder", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used when a legacy recovered outcome is synthesized");
  });
  await stripWorkflowStateFromRuntime(setup.store);

  const summary = "Recovered legacy result ".repeat(40).trim();
  const completedAt = new Date(Date.now() - 20_000).toISOString();
  const completedRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    adapterData: { nativeRunId: "legacy-recovery-thread" },
    startedAt: new Date(Date.now() - 30_000).toISOString(),
    completedAt,
    outcomeKind: "result",
    resultStatus: "completed",
    summary,
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: "legacy-recovered-result",
        producerId: "codex",
        status: "completed",
        summary,
        changedFiles: ["README.md"],
        createdAt: completedAt
      }
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", completedRecord);

  const run = await runRuntime(setup.store, setup.adapter);
  const artifact = await readFile(
    join(setup.projectRoot, ".coortex", "artifacts", "results", "legacy-recovered-result.txt"),
    "utf8"
  );

  assert.equal(run.recoveredOutcome, true);
  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.resultId, "legacy-recovered-result");
  assert.equal(run.execution.outcome.capture.summary, summary);
  assert.equal(getNativeRunId(run.execution.run), "legacy-recovery-thread");
  assert.equal(run.envelope.metadata.recoveredOutcome, true);
  assert.ok(run.envelope.estimatedChars > 0);
  assert.equal(run.envelope.trimApplied, true);
  assert.equal(run.envelope.recentResults[0]?.trimmed, true);
  assert.equal(run.envelope.recentResults[0]?.reference, ".coortex/artifacts/results/legacy-recovered-result.txt");
  assert.equal(run.envelope.recoveryBrief.lastDurableResults[0]?.trimmed, true);
  assert.equal(artifact.trim(), summary);
});

test("milestone-2 integration: recovered legacy decisions preserve durable host run metadata", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used when a legacy recovered decision is synthesized");
  });
  await stripWorkflowStateFromRuntime(setup.store);

  const completedAt = new Date(Date.now() - 20_000).toISOString();
  const completedRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    adapterData: { nativeRunId: "legacy-decision-thread" },
    startedAt: new Date(Date.now() - 30_000).toISOString(),
    completedAt,
    outcomeKind: "decision",
    summary: "Need operator confirmation before continuing the legacy assignment.",
    terminalOutcome: {
      kind: "decision",
      decision: {
        decisionId: "legacy-decision-recovered",
        requesterId: "codex",
        blockerSummary: "Need operator confirmation before continuing the legacy assignment.",
        options: [
          { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
          { id: "skip", label: "Skip", summary: "Skip the blocked work." }
        ],
        recommendedOption: "wait",
        state: "open",
        createdAt: completedAt
      }
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", completedRecord);

  const run = await runRuntime(setup.store, setup.adapter);

  assert.equal(run.recoveredOutcome, true);
  assert.equal(run.execution.outcome.kind, "decision");
  assert.equal(run.execution.outcome.capture.decisionId, "legacy-decision-recovered");
  assert.equal(
    run.execution.outcome.capture.blockerSummary,
    "Need operator confirmation before continuing the legacy assignment."
  );
  assert.equal(getNativeRunId(run.execution.run), "legacy-decision-thread");
  assert.equal(run.envelope.metadata.recoveredOutcome, true);
});

test("milestone-2 integration: inspect exposes the active assignment in legacy mode without a host run", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used in legacy inspect smoke test");
  });
  await stripWorkflowStateFromRuntime(setup.store);

  const inspected = await inspectRuntimeContext(setup.store, setup.adapter);

  assert.equal(inspected.record?.workflow, null);
  assert.equal(inspected.record?.assignment?.id, setup.assignmentId);
  assert.equal(inspected.record?.assignment?.state, "queued");
  assert.equal(inspected.record?.run, null);
});

test("milestone-2 integration: inspect prefers the active legacy assignment over an unrelated last run", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used in legacy inspect precedence smoke test");
  });
  await stripWorkflowStateFromRuntime(setup.store);

  const unrelatedRun: HostRunRecord = {
    assignmentId: randomUUID(),
    state: "completed",
    adapterData: { nativeRunId: "legacy-inspect-unrelated-thread" },
    startedAt: new Date(Date.now() - 30_000).toISOString(),
    completedAt: new Date(Date.now() - 20_000).toISOString(),
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Unrelated legacy last-run record.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: "legacy-inspect-unrelated-result",
        producerId: "codex",
        status: "completed",
        summary: "Unrelated legacy last-run record.",
        changedFiles: [],
        createdAt: new Date(Date.now() - 20_000).toISOString()
      }
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${unrelatedRun.assignmentId}.json`, unrelatedRun);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", unrelatedRun);

  const inspected = await inspectRuntimeContext(setup.store, setup.adapter);

  assert.equal(inspected.record?.workflow, null);
  assert.equal(inspected.record?.assignment?.id, setup.assignmentId);
  assert.equal(inspected.record?.run, null);
});

test("milestone-2 integration: run surfaces a recovered verify completion after the workflow closes", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in recovered verify completion smoke test");
  });
  const planAssignmentId = setup.assignmentId;

  await setAssignmentState(setup.store, planAssignmentId, "in_progress", "2026-04-15T14:00:00.000Z");
  await advanceWorkflowModule(setup.store, {
    artifact: {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "plan",
      moduleAttempt: 1,
      assignmentId: planAssignmentId,
      createdAt: "2026-04-15T14:01:00.000Z",
      payload: {
        planSummary: "Plan complete.",
        implementationSteps: ["Advance to review."],
        reviewEvidenceSummary: "Ready for review."
      }
    },
    resultId: "plan-result-recovered-complete",
    summary: "Plan completed.",
    createdAt: "2026-04-15T14:01:00.000Z",
    progressionAt: "2026-04-15T14:01:01.000Z"
  });

  let projection = await loadOperatorProjection(setup.store);
  const reviewAssignmentId = projection.workflowProgress?.currentAssignmentId;
  assert.ok(reviewAssignmentId, "expected the workflow to advance to review");

  await setAssignmentState(
    setup.store,
    reviewAssignmentId,
    "in_progress",
    "2026-04-15T14:02:00.000Z"
  );
  await advanceWorkflowModule(setup.store, {
    artifact: {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "review",
      moduleAttempt: 1,
      assignmentId: reviewAssignmentId,
      createdAt: "2026-04-15T14:03:00.000Z",
      payload: {
        verdict: "approved",
        rationaleSummary: "Review approved."
      }
    },
    resultId: "review-result-recovered-complete",
    summary: "Review completed.",
    createdAt: "2026-04-15T14:03:00.000Z",
    progressionAt: "2026-04-15T14:03:01.000Z"
  });

  projection = await loadOperatorProjection(setup.store);
  const verifyAssignmentId = projection.workflowProgress?.currentAssignmentId;
  assert.ok(verifyAssignmentId, "expected the workflow to advance to verify");

  await setAssignmentState(
    setup.store,
    verifyAssignmentId,
    "in_progress",
    "2026-04-15T14:04:00.000Z"
  );
  await setup.store.writeJsonArtifact(
    workflowArtifactPath("default", 1, "verify", verifyAssignmentId, 1),
    {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "verify",
      moduleAttempt: 1,
      assignmentId: verifyAssignmentId,
      createdAt: "2026-04-15T14:05:00.000Z",
      payload: {
        verdict: "verified",
        verificationSummary: "Verification recovered from the completed host run.",
        evidenceResultIds: ["review-result-recovered-complete"]
      }
    } satisfies WorkflowArtifactDocument
  );

  const completedRecord: HostRunRecord = {
    assignmentId: verifyAssignmentId,
    state: "completed",
    workflowAttempt: await currentWorkflowAttempt(setup.store, verifyAssignmentId),
    adapterData: { nativeRunId: "verify-recovered-thread" },
    startedAt: "2026-04-15T14:04:00.000Z",
    completedAt: "2026-04-15T14:05:00.000Z",
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Workflow verification complete.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: "verify-result-recovered-complete",
        producerId: "codex",
        status: "completed",
        summary: "Workflow verification complete.",
        changedFiles: ["src/workflows/modules/verify.ts"],
        createdAt: "2026-04-15T14:05:00.000Z"
      }
    }
  };
  await setup.store.writeJsonArtifact(
    `adapters/codex/runs/${verifyAssignmentId}.json`,
    completedRecord
  );
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", completedRecord);

  const run = await runRuntime(setup.store, setup.adapter);

  assert.equal(run.recoveredOutcome, true);
  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.resultId, "verify-result-recovered-complete");
  assert.equal(run.execution.outcome.capture.summary, "Workflow verification complete.");
  assert.equal(run.envelope.metadata.recoveredOutcome, true);
  assert.equal(run.envelope.workflow?.currentAssignmentId, null);
  assert.equal(run.envelope.metadata.activeAssignmentId, null);
  assert.equal(run.envelope.objective, "Workflow default complete.");
  assert.deepEqual(run.envelope.requiredOutputs, []);
  assert.deepEqual(run.envelope.writeScope, []);
  assert.equal(run.projectionAfter.workflowProgress?.currentAssignmentId, null);
  assert.equal(run.projectionAfter.workflowProgress?.lastTransition?.transition, "complete");
  assert.deepEqual(run.projectionAfter.status.activeAssignmentIds, []);
});

test("milestone-2 integration: inspect converges onto a pre-created review assignment when rewind transition persistence is interrupted", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in interrupted rewind convergence smoke test");
  });
  const planAssignmentId = setup.assignmentId;

  await advanceWorkflowModule(setup.store, {
    artifact: {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "plan",
      moduleAttempt: 1,
      assignmentId: planAssignmentId,
      createdAt: "2026-04-18T10:01:00.000Z",
      payload: {
        planSummary: "Plan complete.",
        implementationSteps: ["Advance to review."],
        reviewEvidenceSummary: "Ready for review."
      }
    },
    resultId: "plan-result-interrupted-rewind",
    summary: "Plan completed.",
    createdAt: "2026-04-18T10:01:00.000Z",
    progressionAt: "2026-04-18T10:01:01.000Z"
  });

  let projection = await loadOperatorProjection(setup.store);
  const reviewAssignmentId = projection.workflowProgress?.currentAssignmentId;
  assert.ok(reviewAssignmentId, "expected the workflow to advance to review");

  await advanceWorkflowModule(setup.store, {
    artifact: {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "review",
      moduleAttempt: 1,
      assignmentId: reviewAssignmentId,
      createdAt: "2026-04-18T10:03:00.000Z",
      payload: {
        verdict: "approved",
        rationaleSummary: "Review approved."
      }
    },
    resultId: "review-result-interrupted-rewind",
    summary: "Review completed.",
    createdAt: "2026-04-18T10:03:00.000Z",
    progressionAt: "2026-04-18T10:03:01.000Z"
  });

  projection = await loadOperatorProjection(setup.store);
  const verifyAssignmentId = projection.workflowProgress?.currentAssignmentId;
  assert.ok(verifyAssignmentId, "expected the workflow to advance to verify");

  const interruptedEvents = await appendWorkflowProgressionWithOmissions(setup.store, {
    artifact: {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "verify",
      moduleAttempt: 1,
      assignmentId: verifyAssignmentId,
      createdAt: "2026-04-18T10:05:00.000Z",
      payload: {
        verdict: "failed",
        verificationSummary: "Verification failed and should rewind to review.",
        evidenceResultIds: ["review-result-interrupted-rewind"]
      }
    },
    resultId: "verify-result-interrupted-rewind",
    summary: "Verification failed before transition persistence finished.",
    createdAt: "2026-04-18T10:05:00.000Z",
    progressionAt: "2026-04-18T10:05:01.000Z",
    omitEventTypes: ["workflow.transition.applied"]
  });
  const createdReviewAssignment = interruptedEvents.find(
    (event): event is Extract<RuntimeEvent, { type: "assignment.created" }> =>
      event.type === "assignment.created"
  );
  assert.ok(createdReviewAssignment, "expected the interrupted rewind to pre-create a review assignment");

  const rewoundReviewAssignmentId = createdReviewAssignment.payload.assignment.id;
  const activeLeaseStartedAt = new Date(Date.now() - 60_000).toISOString();
  const activeLeaseHeartbeatAt = new Date(Date.now() - 5_000).toISOString();
  const activeLeaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const rewoundReviewRun: HostRunRecord = {
    assignmentId: rewoundReviewAssignmentId,
    state: "running",
    workflowAttempt: {
      workflowId: "default",
      workflowCycle: 2,
      moduleId: "review",
      moduleAttempt: 1
    },
    adapterData: { nativeRunId: "interrupted-rewind-review-thread" },
    startedAt: activeLeaseStartedAt,
    heartbeatAt: activeLeaseHeartbeatAt,
    leaseExpiresAt: activeLeaseExpiresAt
  };
  await setup.store.writeJsonArtifact(
    `adapters/codex/runs/${rewoundReviewAssignmentId}.json`,
    rewoundReviewRun
  );
  await setup.store.writeJsonArtifact(
    `adapters/codex/runs/${rewoundReviewAssignmentId}.lease.json`,
    rewoundReviewRun
  );

  const loaded = await loadWorkflowAwareProjectionWithDiagnostics(setup.store, setup.adapter);
  const inspected = await inspectRuntimeContext(setup.store, setup.adapter);
  const visibleRun = inspected.record?.run as HostRunRecord | null;

  assert.equal(loaded.projection.workflowProgress?.currentAssignmentId, rewoundReviewAssignmentId);
  assert.deepEqual(loaded.activeLeases, [rewoundReviewAssignmentId]);
  assert.deepEqual(loaded.hiddenActiveLeases, []);
  assert.equal(inspected.record?.workflow?.workflowCycle, 2);
  assert.equal(inspected.record?.workflow?.currentModuleId, "review");
  assert.equal(inspected.record?.workflow?.currentAssignmentId, rewoundReviewAssignmentId);
  assert.equal(inspected.record?.assignment?.id, rewoundReviewAssignmentId);
  assert.equal(visibleRun?.assignmentId, rewoundReviewAssignmentId);
  assert.equal(visibleRun?.workflowAttempt?.workflowCycle, 2);
});

test("milestone-2 integration: same-assignment reruns ignore old completed results when completedAt is missing", async () => {
  const setup = await createSmokeSetup(
    stableRunner("missing-completed-at-old-result", "Current rerun result succeeded.")
  );
  await rerunWorkflowSameAssignment(setup.store, setup.assignmentId, "2026-04-18T12:10:00.000Z");
  const priorAttempt = {
    workflowId: "default",
    workflowCycle: 1,
    moduleId: "plan",
    moduleAttempt: 1
  };

  const oldAttemptRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    workflowAttempt: priorAttempt,
    adapterData: { nativeRunId: "old-attempt-result-missing-completed-at" },
    startedAt: "2026-04-18T12:00:30.000Z",
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Old attempt result should not be recovered.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: "old-attempt-result-missing-completed-at",
        producerId: "codex",
        status: "completed",
        summary: "Old attempt result should not be recovered.",
        changedFiles: ["src/cli/runtime-state.ts"],
        createdAt: "2026-04-18T12:01:00.000Z"
      }
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, oldAttemptRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", oldAttemptRecord);
  await setup.store.writeJsonArtifact(
    `adapters/codex/runs/${setup.assignmentId}.lease.json`,
    {
      assignmentId: setup.assignmentId,
      state: "running",
      workflowAttempt: priorAttempt,
      adapterData: { nativeRunId: "old-attempt-result-lease" },
      startedAt: "2026-04-18T12:00:30.000Z",
      heartbeatAt: "2026-04-18T12:09:30.000Z",
      leaseExpiresAt: "2999-04-11T10:00:30.000Z"
    } satisfies HostRunRecord
  );

  const run = await runRuntime(setup.store, setup.adapter);

  assert.equal(run.projectionBefore.workflowProgress?.currentModuleAttempt, 2);
  assert.equal(run.recoveredOutcome, false);
  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.summary, "Current rerun result succeeded.");
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(
    ![...run.projectionBefore.results.values()].some(
      (result) => result.summary === "Old attempt result should not be recovered."
    )
  );
});

test("milestone-2 integration: same-assignment reruns ignore old completed decisions when completedAt is missing", async () => {
  const setup = await createSmokeSetup(
    stableRunner("missing-completed-at-old-decision", "Current rerun after old decision succeeded.")
  );
  await rerunWorkflowSameAssignment(setup.store, setup.assignmentId, "2026-04-18T12:10:00.000Z");
  const priorAttempt = {
    workflowId: "default",
    workflowCycle: 1,
    moduleId: "plan",
    moduleAttempt: 1
  };

  const oldAttemptRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    workflowAttempt: priorAttempt,
    adapterData: { nativeRunId: "old-attempt-decision-missing-completed-at" },
    startedAt: "2026-04-18T12:00:30.000Z",
    outcomeKind: "decision",
    summary: "Old attempt decision should not be recovered.",
    terminalOutcome: {
      kind: "decision",
      decision: {
        decisionId: "old-attempt-decision-missing-completed-at",
        requesterId: "codex",
        blockerSummary: "Old attempt decision should not be recovered.",
        options: [{ id: "wait", label: "Wait", summary: "Pause." }],
        recommendedOption: "wait",
        state: "open",
        createdAt: "2026-04-18T12:01:00.000Z"
      }
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, oldAttemptRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", oldAttemptRecord);
  await setup.store.writeTextArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, "{");

  const run = await runRuntime(setup.store, setup.adapter);

  assert.equal(run.projectionBefore.workflowProgress?.currentModuleAttempt, 2);
  assert.equal(run.recoveredOutcome, false);
  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.summary, "Current rerun after old decision succeeded.");
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(
    ![...run.projectionBefore.decisions.values()].some(
      (decision) => decision.blockerSummary === "Old attempt decision should not be recovered."
    )
  );
});

test("milestone-2 integration: cleanup-only active leftover completed result lease does not block a same-assignment rerun", async () => {
  const setup = await createSmokeSetup(
    stableRunner("cleanup-only-result-rerun", "Cleanup-only result rerun succeeded.")
  );
  const priorAttempt = await currentWorkflowAttempt(setup.store, setup.assignmentId);

  const completedRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    workflowAttempt: priorAttempt,
    adapterData: { nativeRunId: "cleanup-only-result-recovered" },
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    completedAt: new Date(Date.now() - 110_000).toISOString(),
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Recovered result should not block the rerun.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: randomUUID(),
        producerId: "codex",
        status: "completed",
        summary: "Recovered result should not block the rerun.",
        changedFiles: [],
        createdAt: new Date(Date.now() - 110_000).toISOString()
      }
    }
  };
  const activeLease: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    workflowAttempt: priorAttempt,
    adapterData: { nativeRunId: "cleanup-only-result-lease" },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, activeLease);

  const recovered = await resumeRuntime(setup.store, setup.adapter);
  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));

  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, activeLease);

  const run = await runRuntime(setup.store, setup.adapter);

  assert.equal(run.recoveredOutcome, false);
  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.summary, "Cleanup-only result rerun succeeded.");
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
});

test("milestone-2 integration: cleanup-only active leftover completed decision lease does not block a same-assignment rerun", async () => {
  const setup = await createSmokeSetup(
    stableRunner("cleanup-only-decision-rerun", "Cleanup-only decision rerun succeeded.")
  );
  const priorAttempt = await currentWorkflowAttempt(setup.store, setup.assignmentId);

  const decisionCreatedAt = new Date(Date.now() - 110_000).toISOString();
  const completedRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    workflowAttempt: priorAttempt,
    adapterData: { nativeRunId: "cleanup-only-decision-recovered" },
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    completedAt: decisionCreatedAt,
    outcomeKind: "decision",
    summary: "Recovered decision should not block the rerun.",
    terminalOutcome: {
      kind: "decision",
      decision: {
        decisionId: randomUUID(),
        requesterId: "codex",
        blockerSummary: "Recovered decision should not block the rerun.",
        options: [{ id: "continue", label: "Continue", summary: "Continue after review." }],
        recommendedOption: "continue",
        state: "open",
        createdAt: decisionCreatedAt
      }
    }
  };
  const activeLease: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    workflowAttempt: priorAttempt,
    adapterData: { nativeRunId: "cleanup-only-decision-lease" },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, activeLease);

  const recovered = await resumeRuntime(setup.store, setup.adapter);
  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));

  const recoveredProjection = await loadOperatorProjection(setup.store);
  const recoveredDecision = [...recoveredProjection.decisions.values()].find(
    (decision) => decision.assignmentId === setup.assignmentId && decision.state === "open"
  );
  assert.ok(recoveredDecision, "expected the recovered decision to be durable");
  await setup.store.appendEvent({
    eventId: randomUUID(),
    sessionId: recoveredProjection.sessionId,
    timestamp: nowIso(),
    type: "decision.resolved",
    payload: {
      decisionId: recoveredDecision.decisionId,
      resolvedAt: nowIso(),
      resolutionSummary: "Operator resolved the recovered decision."
    }
  });
  await setup.store.syncSnapshotFromEvents();

  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, activeLease);

  const run = await runRuntime(setup.store, setup.adapter);

  assert.equal(run.recoveredOutcome, false);
  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.summary, "Cleanup-only decision rerun succeeded.");
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
});

test("milestone-2 integration: hidden stale workflow cleanup is silent after the first pass", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in hidden stale workflow cleanup smoke test");
  });

  const hiddenAssignmentId = randomUUID();
  const hiddenStaleRecord: HostRunRecord = {
    assignmentId: hiddenAssignmentId,
    state: "running",
    adapterData: { nativeRunId: "hidden-stale-workflow-run" },
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() - 60_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${hiddenAssignmentId}.json`, hiddenStaleRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${hiddenAssignmentId}.lease.json`, hiddenStaleRecord);

  const firstLoad = await withSteppedClock(() =>
    loadWorkflowAwareProjectionWithDiagnostics(setup.store, setup.adapter)
  );
  const secondLoad = await loadWorkflowAwareProjectionWithDiagnostics(setup.store, setup.adapter);
  const inspectedHidden = await inspectRuntimeRun(setup.store, setup.adapter, hiddenAssignmentId);
  const telemetry = await setup.store.loadTelemetry();
  const hiddenCleanupTelemetry = findLastTelemetry(telemetry, "host.run.hidden_stale_cleaned");
  const hiddenCleanupDiagnostic = firstLoad.diagnostics.find(
    (diagnostic) => diagnostic.code === "hidden-run-cleaned"
  );

  assert.ok(hiddenCleanupDiagnostic);
  assert.match(
    hiddenCleanupDiagnostic.message,
    new RegExp(`Cleared stale host run artifacts for non-current workflow assignment ${hiddenAssignmentId}`)
  );
  assert.ok(!firstLoad.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(!secondLoad.diagnostics.some((diagnostic) => diagnostic.code === "hidden-run-cleaned"));
  assert.equal(
    telemetry.filter((event) => event.eventType === "host.run.hidden_stale_cleaned").length,
    1
  );
  assert.equal(
    telemetry.filter((event) => event.eventType === "host.run.stale_reconciled").length,
    0
  );
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${hiddenAssignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: hidden stale workflow cleanup reports success only after the lease is actually cleared", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in hidden stale workflow cleanup retry smoke test");
  });

  const hiddenAssignmentId = randomUUID();
  const hiddenStaleRecord: HostRunRecord = {
    assignmentId: hiddenAssignmentId,
    state: "running",
    adapterData: { nativeRunId: "hidden-stale-workflow-retry" },
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() - 60_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${hiddenAssignmentId}.json`, hiddenStaleRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${hiddenAssignmentId}.lease.json`, hiddenStaleRecord);

  const originalReconcile = setup.adapter.reconcileStaleRun.bind(setup.adapter);
  let reconcileAttempts = 0;
  setup.adapter.reconcileStaleRun = async (store, record) => {
    reconcileAttempts += 1;
    if (reconcileAttempts === 1) {
      throw new Error("simulated hidden cleanup failure");
    }
    await originalReconcile(store, record);
  };

  const firstLoad = await withSteppedClock(() =>
    loadWorkflowAwareProjectionWithDiagnostics(setup.store, setup.adapter)
  );
  const secondLoad = await loadWorkflowAwareProjectionWithDiagnostics(setup.store, setup.adapter);
  const inspectedHidden = await inspectRuntimeRun(setup.store, setup.adapter, hiddenAssignmentId);
  const telemetry = await setup.store.loadTelemetry();
  const hiddenCleanupTelemetry = findLastTelemetry(telemetry, "host.run.hidden_stale_cleaned");

  assert.ok(!firstLoad.diagnostics.some((diagnostic) => diagnostic.code === "hidden-run-cleaned"));
  assert.ok(firstLoad.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.ok(secondLoad.diagnostics.some((diagnostic) => diagnostic.code === "hidden-run-cleaned"));
  assert.ok(!secondLoad.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.equal(
    telemetry.filter((event) => event.eventType === "host.run.hidden_stale_cleaned").length,
    1
  );
  assert.equal(
    telemetry.filter((event) => event.eventType === "host.run.stale_reconciled").length,
    0
  );
  assert.equal(reconcileAttempts, 2);
  assert.equal(hiddenCleanupTelemetry?.metadata.staleAt, inspectedHidden?.staleAt);
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${hiddenAssignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: hidden stale workflow cleanup still reports success after a non-terminal cleanup warning", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in hidden stale workflow cleanup warning smoke test");
  });

  const hiddenAssignmentId = randomUUID();
  const hiddenStaleRecord: HostRunRecord = {
    assignmentId: hiddenAssignmentId,
    state: "running",
    adapterData: { nativeRunId: "hidden-stale-workflow-warning" },
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() - 60_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${hiddenAssignmentId}.json`, hiddenStaleRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${hiddenAssignmentId}.lease.json`, hiddenStaleRecord);

  const originalReconcile = setup.adapter.reconcileStaleRun.bind(setup.adapter);
  let reconcileAttempts = 0;
  setup.adapter.reconcileStaleRun = async (store, record) => {
    reconcileAttempts += 1;
    await originalReconcile(store, record);
    throw new Error("simulated hidden cleanup warning after lease release");
  };

  const firstLoad = await withSteppedClock(() =>
    loadWorkflowAwareProjectionWithDiagnostics(setup.store, setup.adapter)
  );
  const secondLoad = await loadWorkflowAwareProjectionWithDiagnostics(setup.store, setup.adapter);
  const inspectedHidden = await inspectRuntimeRun(setup.store, setup.adapter, hiddenAssignmentId);
  const telemetry = await setup.store.loadTelemetry();
  const hiddenCleanupTelemetry = findLastTelemetry(telemetry, "host.run.hidden_stale_cleaned");

  assert.ok(firstLoad.diagnostics.some((diagnostic) => diagnostic.code === "hidden-run-cleaned"));
  assert.ok(firstLoad.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.ok(!secondLoad.diagnostics.some((diagnostic) => diagnostic.code === "hidden-run-cleaned"));
  assert.ok(!secondLoad.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.equal(
    telemetry.filter((event) => event.eventType === "host.run.hidden_stale_cleaned").length,
    1
  );
  assert.equal(reconcileAttempts, 1);
  assert.equal(hiddenCleanupTelemetry?.metadata.staleAt, inspectedHidden?.staleAt);
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${hiddenAssignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: non-terminal persist warnings still clear the finished lease", async () => {
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

test("milestone-2 integration: pre-launch claim failures leave runtime state unchanged", async () => {
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

  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "queued");
  assert.equal(snapshot?.results.length, 0);
  assert.deepEqual(snapshot?.status.activeAssignmentIds, [setup.assignmentId]);
  assert.equal(inspected, undefined);
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: equivalent executions produce stable persisted shapes", async () => {
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

test("milestone-2 integration: resume uses the latest projection across multiple stale leases", async () => {
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
  const workflowAttempt = await currentWorkflowAttempt(setup.store, setup.assignmentId);
  const firstExpiredRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    workflowAttempt,
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

  assert.equal(staleDiagnostics.length, 1);
  assert.equal(snapshot?.assignments.find((assignment) => assignment.id === setup.assignmentId)?.state, "queued");
  assert.equal(snapshot?.assignments.find((assignment) => assignment.id === secondAssignmentId)?.state, "queued");
  assert.deepEqual(snapshot?.status.activeAssignmentIds, [setup.assignmentId]);
  assert.match(snapshot?.status.currentObjective ?? "", new RegExp(setup.assignmentId));
  assert.doesNotMatch(snapshot?.status.currentObjective ?? "", new RegExp(secondAssignmentId));
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${secondAssignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: run refuses later queued work when the workflow assignment is blocked", async () => {
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

  await assert.rejects(
    runRuntime(setup.store, setup.adapter),
    /Workflow assignment .* is not runnable for module plan\. Resolve decision .*:/
  );

  assert.equal(invocationCount, 0);
  assert.equal(promptSeen, "");
});

test("milestone-2 integration: resume reconciles a running host record without a lease expiry", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in lease-less reconciliation smoke test");
  });

  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const workflowAttempt = await currentWorkflowAttempt(setup.store, setup.assignmentId);
  const leaseLessRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    workflowAttempt,
    adapterData: { nativeRunId: "smoke-thread-missing-lease" },
    startedAt,
    heartbeatAt: startedAt
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, leaseLessRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, {
    assignmentId: setup.assignmentId,
    state: "running",
    workflowAttempt,
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

test("milestone-2 integration: stale lease-only runs are reconciled and cleared for rerun", async () => {
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

  const workflowAttempt = await currentWorkflowAttempt(setup.store, setup.assignmentId);
  const expiredLeaseOnlyRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    workflowAttempt,
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

test("milestone-2 integration: malformed workflow lease metadata is cleaned without inferring stale ownership", async () => {
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
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: malformed workflow lease cleanup preserves the malformed lease reason", async () => {
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

  assert.ok(!resumed.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(inspected?.state, "completed");
  assert.equal(inspected?.staleReasonCode, "malformed_lease_artifact");
  assert.equal(inspected?.staleReason, "malformed lease file");
});

test("milestone-2 integration: completed run record wins over a leftover lease during recovery", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in completed-record lease recovery smoke test");
  });

  const workflowAttempt = await currentWorkflowAttempt(setup.store, setup.assignmentId);
  const completedRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    workflowAttempt,
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
    workflowAttempt,
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

test("milestone-2 integration: resume ignores an active leftover lease when a completed run record exists", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in active-leftover-lease resume smoke test");
  });

  const workflowAttempt = await currentWorkflowAttempt(setup.store, setup.assignmentId);
  const completedRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    workflowAttempt,
    adapterData: { nativeRunId: "smoke-thread-completed-active-lease" },
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    completedAt: new Date(Date.now() - 110_000).toISOString(),
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Completed run beats an active leftover lease",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: randomUUID(),
        producerId: "codex",
        status: "completed",
        summary: "Completed run beats an active leftover lease",
        changedFiles: [],
        createdAt: new Date(Date.now() - 110_000).toISOString()
      }
    }
  };
  const activeLease: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    workflowAttempt,
    adapterData: { nativeRunId: "smoke-thread-active-leftover-lease" },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/last-run.json`, completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, activeLease);

  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const snapshot = await setup.store.loadSnapshot();
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.ok(resumed.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(snapshot?.assignments[0]?.state, "queued");
  assert.deepEqual(snapshot?.status.activeAssignmentIds, [setup.assignmentId]);
  assert.match(snapshot?.status.currentObjective ?? "", new RegExp(`Start plan assignment ${setup.assignmentId}:`));
  assert.equal(snapshot?.results.length, 1);
  assert.equal(snapshot?.results[0]?.status, "completed");
  assert.equal(snapshot?.results[0]?.summary, "Completed run beats an active leftover lease");
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

test("milestone-2 integration: stale reconciliation is idempotent after the first recovery", async () => {
  const setup = await createSmokeSetup(
    stableRunner("smoke-thread-stale-repeat", "Recovered stale assignment after status/run follow-up.")
  );

  const workflowAttempt = await currentWorkflowAttempt(setup.store, setup.assignmentId);
  const staleRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    workflowAttempt,
    adapterData: { nativeRunId: "smoke-thread-stale-repeat" },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, staleRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", staleRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, staleRecord);

  const firstResume = await resumeRuntime(setup.store, setup.adapter);
  const driftTimestamp = new Date().toISOString();
  await setup.store.appendEvent({
    eventId: randomUUID(),
    sessionId: firstResume.projection.sessionId,
    timestamp: driftTimestamp,
    type: "status.updated",
    payload: {
      status: {
        ...firstResume.projection.status,
        currentObjective: "Operator updated the status after stale reconciliation.",
        lastDurableOutputAt: driftTimestamp
      }
    }
  });
  await setup.store.syncSnapshotFromEvents();
  const secondResume = await resumeRuntime(setup.store, setup.adapter);
  const statusProjection = await loadOperatorProjection(setup.store);
  const run = await runRuntime(setup.store, setup.adapter);
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
  const telemetry = await setup.store.loadTelemetry();
  const events = await setup.store.loadEvents();
  const staleTelemetryCount = telemetry.filter(
    (event) => event.eventType === "host.run.stale_reconciled"
  ).length;
  const queuedTransitionCount = events.filter(
    (event) =>
      event.type === "assignment.updated" &&
      event.payload.assignmentId === setup.assignmentId &&
      event.payload.patch.state === "queued"
  ).length;

  assert.ok(firstResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(!secondResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(statusProjection.assignments.get(setup.assignmentId)?.state, "queued");
  assert.match(
    statusProjection.status.currentObjective,
    new RegExp(`Start plan assignment ${setup.assignmentId}:`)
  );
  assert.equal(run.execution.outcome.kind, "result");
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(queuedTransitionCount, 1);
  assert.equal(inspected?.state, "completed");
  assert.equal(staleTelemetryCount, 1);
});

test("milestone-2 integration: stale reconciliation retries artifact cleanup after runtime state is durable", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in stale reconciliation retry smoke test");
  });

  const workflowAttempt = await currentWorkflowAttempt(setup.store, setup.assignmentId);
  const staleRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    workflowAttempt,
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
    if (reconcileAttempts <= 2) {
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

  assert.ok(!firstResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(firstResume.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.equal(snapshotAfterFirst?.assignments[0]?.state, "queued");
  assert.equal(inspectedAfterFirst?.state, "completed");
  assert.equal(inspectedAfterFirst?.staleReasonCode, "expired_lease");
  assert.equal(secondStatusProjection.assignments.get(setup.assignmentId)?.state, "queued");
  assert.ok(secondResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(!secondResume.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.equal(inspectedAfterSecond?.state, "completed");
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
  assert.equal(reconcileAttempts, 3);
  assert.equal(staleTelemetryCount, 1);
});

test("milestone-2 integration: stale reconciliation still reports success after a non-terminal cleanup warning", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in stale reconciliation warning smoke test");
  });

  const workflowAttempt = await currentWorkflowAttempt(setup.store, setup.assignmentId);
  const staleRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    workflowAttempt,
    adapterData: { nativeRunId: "smoke-thread-stale-warning-artifacts" },
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
    await originalReconcile(store, record);
    throw new Error("simulated stale cleanup warning after lease release");
  };

  const firstResume = await resumeRuntime(setup.store, setup.adapter);
  const snapshotAfterFirst = await setup.store.loadSnapshot();
  const inspectedAfterFirst = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
  const secondResume = await resumeRuntime(setup.store, setup.adapter);
  const telemetry = await setup.store.loadTelemetry();
  const staleTelemetryCount = telemetry.filter(
    (event) => event.eventType === "host.run.stale_reconciled"
  ).length;

  assert.ok(firstResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(firstResume.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.equal(snapshotAfterFirst?.assignments[0]?.state, "queued");
  assert.equal(inspectedAfterFirst?.state, "completed");
  assert.equal(inspectedAfterFirst?.staleReasonCode, "expired_lease");
  assert.ok(!secondResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(!secondResume.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.equal(reconcileAttempts, 1);
  assert.equal(staleTelemetryCount, 1);
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: stale retries move back to in-progress before the replacement host run", async () => {
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
    workflowAttempt: await currentWorkflowAttempt(setup.store, setup.assignmentId),
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

async function setAssignmentState(
  store: RuntimeStore,
  assignmentId: string,
  state: "queued" | "in_progress" | "blocked" | "completed" | "failed",
  timestamp: string
): Promise<void> {
  const projection = await loadOperatorProjection(store);
  await store.appendEvent({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.updated",
    payload: {
      assignmentId,
      patch: {
        state,
        updatedAt: timestamp
      }
    }
  });
  await store.syncSnapshotFromEvents();
}

async function rerunWorkflowSameAssignment(
  store: RuntimeStore,
  assignmentId: string,
  appliedAt: string
): Promise<void> {
  const projection = await loadOperatorProjection(store);
  await store.appendEvent({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp: appliedAt,
    type: "workflow.transition.applied",
    payload: {
      workflowId: "default",
      fromModuleId: "plan",
      toModuleId: "plan",
      workflowCycle: 1,
      moduleAttempt: 2,
      transition: "rerun_same_module",
      previousAssignmentId: assignmentId,
      nextAssignmentId: assignmentId,
      appliedAt
    }
  });
  await store.syncSnapshotFromEvents();
}

async function advanceWorkflowModule(
  store: RuntimeStore,
  input: {
    artifact: WorkflowArtifactDocument;
    resultId: string;
    summary: string;
    createdAt: string;
    progressionAt: string;
  }
): Promise<void> {
  await store.writeJsonArtifact(
    workflowArtifactPath(
      input.artifact.workflowId,
      input.artifact.workflowCycle,
      input.artifact.moduleId,
      input.artifact.assignmentId,
      input.artifact.moduleAttempt
    ),
    input.artifact
  );
  const projection = await loadOperatorProjection(store);
  await store.appendEvent({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp: input.createdAt,
    type: "result.submitted",
    payload: {
      result: {
        resultId: input.resultId,
        assignmentId: input.artifact.assignmentId,
        producerId: "codex",
        status: "completed",
        summary: input.summary,
        changedFiles: [],
        createdAt: input.createdAt
      }
    }
  });
  const progressedProjection = await loadOperatorProjection(store);
  const progression = await evaluateWorkflowProgression(progressedProjection, store, {
    timestamp: input.progressionAt
  });
  for (const event of progression.events) {
    await store.appendEvent(event);
  }
  await store.syncSnapshotFromEvents();
}

async function appendWorkflowProgressionWithOmissions(
  store: RuntimeStore,
  input: {
    artifact: WorkflowArtifactDocument;
    resultId: string;
    summary: string;
    createdAt: string;
    progressionAt: string;
    omitEventTypes: RuntimeEvent["type"][];
  }
): Promise<RuntimeEvent[]> {
  await store.writeJsonArtifact(
    workflowArtifactPath(
      input.artifact.workflowId,
      input.artifact.workflowCycle,
      input.artifact.moduleId,
      input.artifact.assignmentId,
      input.artifact.moduleAttempt
    ),
    input.artifact
  );
  const projection = await loadOperatorProjection(store);
  await store.appendEvent({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp: input.createdAt,
    type: "result.submitted",
    payload: {
      result: {
        resultId: input.resultId,
        assignmentId: input.artifact.assignmentId,
        producerId: "codex",
        status: "completed",
        summary: input.summary,
        changedFiles: [],
        createdAt: input.createdAt
      }
    }
  });
  const progressedProjection = await loadOperatorProjection(store);
  const progression = await evaluateWorkflowProgression(progressedProjection, store, {
    timestamp: input.progressionAt
  });
  for (const event of progression.events.filter((event) => !input.omitEventTypes.includes(event.type))) {
    await store.appendEvent(event);
  }
  await store.syncSnapshotFromEvents();
  return progression.events;
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

async function stripWorkflowStateFromRuntime(store: RuntimeStore): Promise<void> {
  const filteredEvents = (await readFile(store.eventsPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      const event = JSON.parse(line) as { type?: string };
      return !event.type?.startsWith("workflow.");
    });
  await writeFile(store.eventsPath, `${filteredEvents.join("\n")}\n`, "utf8");
  const projection = await store.syncSnapshotFromEvents();
  assert.equal(projection.workflowProgress, undefined);
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
  return normalizeStructuredStrings({
    envelope: {
      host: run.envelope.host,
      adapter: run.envelope.adapter,
      objective: normalizeBootstrapObjective(run.envelope.objective),
      writeScope: [...run.envelope.writeScope],
      requiredOutputs: [...run.envelope.requiredOutputs],
      recentResults: run.envelope.recentResults.map((result) => ({
        trimmed: result.trimmed,
        summary: normalizeWorkflowDerivedString(result.summary),
        hasReference: typeof result.reference === "string"
      })),
      metadata: normalizeStructuredStrings({
        ...run.envelope.metadata,
        activeAssignmentId: "<active-assignment>"
      }),
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
              summary: normalizeWorkflowDerivedString(run.execution.outcome.capture.summary),
              changedFiles: run.execution.outcome.capture.changedFiles.map(normalizeWorkflowDerivedString)
            }
          : undefined,
      decision:
        run.execution.outcome.kind === "decision"
          ? {
              blockerSummary: normalizeWorkflowDerivedString(run.execution.outcome.capture.blockerSummary),
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
            currentObjective: normalizeWorkflowDerivedString(snapshot.status.currentObjective),
            activeAssignmentCount: snapshot.status.activeAssignmentIds.length,
            activeHost: snapshot.status.activeHost,
            activeAdapter: snapshot.status.activeAdapter,
            resumeReady: snapshot.status.resumeReady
          },
          assignments: snapshot.assignments.map((assignment) => ({
            workflow: assignment.workflow,
            ownerType: assignment.ownerType,
            ownerId: assignment.ownerId,
            objective: normalizeBootstrapObjective(
              normalizeWorkflowDerivedString(assignment.objective)
            ),
            writeScope: [...assignment.writeScope],
            requiredOutputs: [...assignment.requiredOutputs],
            state: assignment.state
          })),
          results: snapshot.results.map((result) => ({
            assignmentIdMatchesActive: result.assignmentId.length > 0,
            producerId: result.producerId,
            status: result.status,
            summary: normalizeWorkflowDerivedString(result.summary),
            changedFiles: result.changedFiles.map(normalizeWorkflowDerivedString)
          })),
          decisions: snapshot.decisions.map((decision) => ({
            requesterId: decision.requesterId,
            blockerSummary: normalizeWorkflowDerivedString(decision.blockerSummary),
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
          metadata: normalizeStructuredStrings(completedTelemetry.metadata),
          inputTokens: completedTelemetry.inputTokens,
          outputTokens: completedTelemetry.outputTokens,
          totalTokens: completedTelemetry.totalTokens,
          cachedTokens: completedTelemetry.cachedTokens
        }
      : undefined
  });
}

function findLastTelemetry(
  events: Awaited<ReturnType<RuntimeStore["loadTelemetry"]>>,
  eventType: string
) {
  return [...events].reverse().find((event) => event.eventType === eventType);
}

function normalizeBootstrapObjective(value: string): string {
  return normalizeWorkflowDerivedString(
    value.replace(
      /Coordinate work for coortex-m2-smoke-[^ ]+ through the Coortex runtime\./g,
      "Coordinate work for <smoke-project> through the Coortex runtime."
    )
  );
}

function normalizeWorkflowDerivedString(value: string): string {
  return value
    .replace(
      /\.coortex\/runtime\/workflows\/default\/cycles\/\d+\/[a-z]+\/[0-9a-f-]{36}\/attempt-\d+\.json/g,
      ".coortex/runtime/workflows/default/cycles/<cycle>/<module>/<assignment>/attempt-<attempt>.json"
    )
    .replace(
      /(Start|Retry|Continue) [a-z]+ assignment [0-9a-f-]{36}:/g,
      "$1 <module> assignment <assignment>:"
    )
    .replace(/Resolve decision [0-9a-f-]{36}:/g, "Resolve decision <decision>:");
}

function normalizeStructuredStrings<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) =>
      typeof nested === "string" ? normalizeWorkflowDerivedString(nested) : nested
    )
  ) as T;
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

async function withSteppedClock<T>(work: () => Promise<T>): Promise<T> {
  const realDate = Date;
  const baseMs = realDate.now();
  let tick = 0;

  class SteppedDate extends realDate {
    constructor(value?: string | number | Date) {
      if (arguments.length === 0) {
        super(baseMs + tick * 1_000);
        tick += 1;
        return;
      }
      super(value as string | number | Date);
    }

    static override now(): number {
      const value = baseMs + tick * 1_000;
      tick += 1;
      return value;
    }

    static override parse(value: string): number {
      return realDate.parse(value);
    }

    static override UTC(
      year: number,
      monthIndex: number,
      date?: number,
      hours?: number,
      minutes?: number,
      seconds?: number,
      ms?: number
    ): number {
      return realDate.UTC(year, monthIndex, date, hours, minutes, seconds, ms);
    }
  }

  globalThis.Date = SteppedDate as unknown as DateConstructor;
  try {
    return await work();
  } finally {
    globalThis.Date = realDate;
  }
}
