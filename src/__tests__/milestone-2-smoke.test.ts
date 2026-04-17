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

const concurrentRunBlockedError =
  /(already has an active host run lease|is already claimed by authoritative attachment)/;

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
  assert.equal(resumed.mode, "prepared");
  assert.equal(snapshot?.decisions.length, 1);
  assert.equal(snapshot?.decisions[0]?.assignmentId, setup.assignmentId);
  assert.equal(snapshot?.decisions[0]?.state, "open");
  assert.equal(snapshot?.assignments[0]?.state, "blocked");
  assert.deepEqual(snapshot?.status.activeAssignmentIds, [setup.assignmentId]);
  assert.match(resumed.brief.nextRequiredAction, /Resolve decision/);
  assert.equal(resumed.brief.unresolvedDecisions.length, 1);
});

test("milestone-2 smoke: completed host outcomes are reconciled from terminal-only durable state", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used in completed recovery smoke setup");
  });
  const completedAt = nowIso();
  const resultId = "smoke-completed-recovery-result";
  const summary = "Completed host run was recovered from terminal-only durable state.";
  const sessionId = (await loadOperatorProjection(setup.store)).sessionId;

  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, {
    assignmentId: setup.assignmentId,
    state: "completed",
    startedAt: completedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus: "completed",
    summary,
    terminalOutcome: {
      kind: "result",
      result: {
        resultId,
        producerId: "codex",
        status: "completed",
        summary,
        changedFiles: ["src/cli/run-operations.ts"],
        createdAt: completedAt
      }
    },
    adapterData: {
      nativeRunId: "smoke-thread-completed-recovery"
    }
  });
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", {
    assignmentId: setup.assignmentId,
    state: "completed",
    startedAt: completedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus: "completed",
    summary,
    terminalOutcome: {
      kind: "result",
      result: {
        resultId,
        producerId: "codex",
        status: "completed",
        summary,
        changedFiles: ["src/cli/run-operations.ts"],
        createdAt: completedAt
      }
    },
    adapterData: {
      nativeRunId: "smoke-thread-completed-recovery"
    }
  });
  await setup.store.appendEvent({
    eventId: randomUUID(),
    sessionId,
    timestamp: completedAt,
    type: "result.submitted",
    payload: {
      result: {
        resultId,
        assignmentId: setup.assignmentId,
        producerId: "codex",
        status: "completed",
        summary,
        changedFiles: ["src/cli/run-operations.ts"],
        createdAt: completedAt
      }
    }
  });
  await setup.store.syncSnapshotFromEvents();

  const recovered = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);
  const snapshot = await setup.store.loadSnapshot();
  const persistedRun = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.ok(!recovered.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(persistedRun?.state, "completed");
  assert.equal(persistedRun?.terminalOutcome?.kind, "result");
  assert.equal(snapshot?.results.at(-1)?.assignmentId, setup.assignmentId);
  assert.equal(recovered.projection.assignments.get(setup.assignmentId)?.state, "completed");
  assert.equal(
    [...recovered.projection.results.values()].at(-1)?.summary,
    summary
  );
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, []);
  assert.equal(await countQueuedAssignmentUpdatedEvents(setup.store, setup.assignmentId), 0);
});

test("milestone-2 smoke: failed host outcomes are recovered in place from terminal-only durable state", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used in failed recovery smoke setup");
  });
  const completedAt = nowIso();
  const resultId = "smoke-failed-recovery-result";
  const summary = "Durable failed host outcome was recovered from terminal-only durable state.";
  const sessionId = (await loadOperatorProjection(setup.store)).sessionId;

  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, {
    assignmentId: setup.assignmentId,
    state: "completed",
    startedAt: completedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus: "failed",
    summary,
    terminalOutcome: {
      kind: "result",
      result: {
        resultId,
        producerId: "codex",
        status: "failed",
        summary,
        changedFiles: [],
        createdAt: completedAt
      }
    },
    adapterData: {
      nativeRunId: "smoke-thread-failed-recovery"
    }
  });
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", {
    assignmentId: setup.assignmentId,
    state: "completed",
    startedAt: completedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus: "failed",
    summary,
    terminalOutcome: {
      kind: "result",
      result: {
        resultId,
        producerId: "codex",
        status: "failed",
        summary,
        changedFiles: [],
        createdAt: completedAt
      }
    },
    adapterData: {
      nativeRunId: "smoke-thread-failed-recovery"
    }
  });
  await setup.store.appendEvent({
    eventId: randomUUID(),
    sessionId,
    timestamp: completedAt,
    type: "result.submitted",
    payload: {
      result: {
        resultId,
        assignmentId: setup.assignmentId,
        producerId: "codex",
        status: "failed",
        summary,
        changedFiles: [],
        createdAt: completedAt
      }
    }
  });
  await setup.store.syncSnapshotFromEvents();

  const recovered = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.ok(!recovered.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(recovered.projection.assignments.get(setup.assignmentId)?.state, "failed");
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, []);
  assert.equal(await countQueuedAssignmentUpdatedEvents(setup.store, setup.assignmentId), 0);
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
  let firstRunFailure: unknown;
  let blockedRunFailure: unknown;
  try {
    await waitFor(
      async () => (await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId))?.state === "running"
    );
    await assert.rejects(runRuntime(setup.store, setup.adapter), concurrentRunBlockedError);
  } catch (error) {
    blockedRunFailure = error;
  } finally {
    releaseRun();
    try {
      await firstRun;
    } catch (error) {
      firstRunFailure = error;
    }
  }
  if (blockedRunFailure) {
    throw blockedRunFailure;
  }
  if (firstRunFailure) {
    throw firstRunFailure;
  }
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
