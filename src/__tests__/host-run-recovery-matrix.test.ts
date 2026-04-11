import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  AdapterCapabilities,
  DoctorCheck,
  HostAdapter,
  HostDecisionCapture,
  HostExecutionOutcome,
  HostResultCapture,
  HostTelemetryCapture,
  RuntimeArtifactStore,
  TaskEnvelope
} from "../adapters/contract.js";
import { HostRunStore, type HostRunArtifactPaths } from "../adapters/host-run-store.js";
import { buildCompletedRunRecord } from "../adapters/host-run-records.js";
import type { RuntimeConfig } from "../config/types.js";
import { createBootstrapRuntime } from "../core/runtime.js";
import type { DecisionPacket, HostRunRecord, RecoveryBrief, ResultPacket, RuntimeProjection } from "../core/types.js";
import { RuntimeStore } from "../persistence/store.js";
import { loadOperatorProjection } from "../cli/runtime-state.js";
import { reconcileActiveRuns } from "../cli/run-operations.js";
import { runRuntime } from "../cli/commands.js";
import { nowIso } from "../utils/time.js";

const capabilities: AdapterCapabilities = {
  supportsProfiles: false,
  supportsHooks: false,
  supportsResume: true,
  supportsFork: false,
  supportsExactUsage: false,
  supportsCompactionHooks: false,
  supportsMcp: false,
  supportsPlugins: false,
  supportsPermissionsModel: false
};

test("host-run recovery matrix matches the supported command semantics", async (t) => {
  const cases = [
    {
      name: "valid active lease stays authoritative and blocks new execution",
      seed: async (ctx: MatrixContext) => {
        const record = runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z");
        await ctx.adapter.claimRunLease(ctx.store, ctx.projection, ctx.assignmentId, record);
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, [ctx.assignmentId]);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "in_progress");
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "active-run-present"));
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "running");
      }
    },
    {
      name: "expired running lease is reconciled into a queued retry",
      seed: async (ctx: MatrixContext) => {
        await ctx.adapter.runStore.write(
          runningRecord(ctx.assignmentId, "2000-01-01T00:00:00.000Z")
        );
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "queued");
        assert.match(result.projection.status.currentObjective, new RegExp(`^Retry assignment ${ctx.assignmentId}:`));
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.staleReasonCode, "expired_lease");
      }
    },
    {
      name: "missing lease expiry is reconciled into a queued retry",
      seed: async (ctx: MatrixContext) => {
        const record = runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z");
        const { leaseExpiresAt: _leaseExpiresAt, ...withoutLeaseExpiry } = record;
        await ctx.adapter.runStore.write({
          ...withoutLeaseExpiry
        });
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "queued");
        assert.match(result.projection.status.currentObjective, new RegExp(`^Retry assignment ${ctx.assignmentId}:`));
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.staleReasonCode, "missing_lease_expiry");
      }
    },
    {
      name: "invalid lease expiry is reconciled into a queued retry",
      seed: async (ctx: MatrixContext) => {
        await ctx.adapter.runStore.write({
          ...runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z"),
          leaseExpiresAt: "not-a-timestamp"
        });
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "queued");
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.staleReasonCode, "invalid_lease_expiry");
      }
    },
    {
      name: "lease-only stale state is reconciled into a queued retry",
      seed: async (ctx: MatrixContext) => {
        const leaseOnly = runningRecord(ctx.assignmentId, "2000-01-01T00:00:00.000Z");
        await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, leaseOnly);
        await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", leaseOnly);
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "queued");
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.staleReasonCode, "expired_lease");
      }
    },
    {
      name: "completed record with leftover active lease is recovered into runtime truth",
      seed: async (ctx: MatrixContext) => {
        await ctx.adapter.runStore.write(
          completedResultRecord(ctx.assignmentId, "completed", "Older completed result.")
        );
        await ctx.store.writeJsonArtifact(
          `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
          runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z")
        );
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "completed");
        assert.deepEqual(result.projection.status.activeAssignmentIds, []);
        assert.equal(result.projection.results.size, 1);
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.resultStatus, "completed");
        assert.equal(
          await ctx.store.readTextArtifact(
            `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
            "matrix lease"
          ),
          undefined
        );
      }
    },
    {
      name: "completed record with leftover expired lease is recovered into runtime truth",
      seed: async (ctx: MatrixContext) => {
        await ctx.adapter.runStore.write(
          completedResultRecord(ctx.assignmentId, "completed", "Older completed result.")
        );
        await ctx.store.writeJsonArtifact(
          `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
          runningRecord(ctx.assignmentId, "2000-01-01T00:00:00.000Z")
        );
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "completed");
        assert.deepEqual(result.projection.status.activeAssignmentIds, []);
        assert.equal(result.projection.results.size, 1);
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.resultStatus, "completed");
        assert.equal(
          await ctx.store.readTextArtifact(
            `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
            "matrix lease"
          ),
          undefined
        );
      }
    },
    {
      name: "durable completed result is absorbed back into runtime truth",
      seed: async (ctx: MatrixContext) => {
        await ctx.adapter.runStore.write(
          completedResultRecord(ctx.assignmentId, "completed", "Recovered completed result.")
        );
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "completed");
        assert.deepEqual(result.projection.status.activeAssignmentIds, []);
        assert.equal(result.projection.results.size, 1);
        assert.equal([...result.projection.results.values()][0]?.status, "completed");
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
      }
    },
    {
      name: "durable failed result is absorbed back into runtime truth",
      seed: async (ctx: MatrixContext) => {
        await ctx.adapter.runStore.write(
          completedResultRecord(ctx.assignmentId, "failed", "Recovered failed result.")
        );
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "failed");
        assert.deepEqual(result.projection.status.activeAssignmentIds, []);
        assert.equal(result.projection.status.currentObjective, `Review failed assignment ${ctx.assignmentId}.`);
        assert.equal(result.projection.results.size, 1);
        assert.equal([...result.projection.results.values()][0]?.status, "failed");
      }
    }
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const ctx = await createMatrixContext();
      await testCase.seed(ctx);
      const result = await reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection);
      await testCase.assertResult(ctx, result);
    });
  }
});

test("host-run command matrix preserves duplicate-run protection", async (t) => {
  const cases = [
    {
      name: "concurrent run attempts do not launch duplicate host executions"
    }
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const adapter = new ConcurrentRunMatrixAdapter();
      const ctx = await createMatrixContext(adapter);

      const firstRun = runRuntime(ctx.store, ctx.adapter);
      await waitFor(async () => (await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId))?.state === "running");
      await assert.rejects(
        runRuntime(ctx.store, ctx.adapter),
        /already has an active host run lease/
      );

      adapter.releaseRun();
      const result = await firstRun;

      assert.equal(adapter.invocationCount, 1);
      assert.equal(result.execution.outcome.kind, "result");
      assert.equal(result.execution.outcome.capture.status, "completed");
      assert.equal(result.projectionAfter.results.size, 1);
    });
  }
});

interface MatrixContext {
  store: RuntimeStore;
  projection: RuntimeProjection;
  assignmentId: string;
  adapter: MatrixAdapter;
}

class MatrixAdapter implements HostAdapter {
  readonly id = "matrix";
  readonly host = "matrix";
  runStore: HostRunStore;

  constructor(private readonly artifacts: HostRunArtifactPaths) {
    this.runStore = new HostRunStore({} as RuntimeArtifactStore, this.id, this.artifacts);
  }

  bindStore(store: RuntimeArtifactStore): void {
    this.runStore = new HostRunStore(store, this.id, this.artifacts);
  }

  getCapabilities(): AdapterCapabilities {
    return capabilities;
  }

  async initialize(_store: RuntimeArtifactStore, _projection: RuntimeProjection): Promise<void> {}

  async doctor(_store: RuntimeArtifactStore): Promise<DoctorCheck[]> {
    return [];
  }

  async buildResumeEnvelope(
    _store: RuntimeArtifactStore,
    _projection: RuntimeProjection,
    _brief: RecoveryBrief
  ): Promise<TaskEnvelope> {
    throw new Error("buildResumeEnvelope is not used in host-run recovery matrix tests");
  }

  async executeAssignment(
    _store: RuntimeArtifactStore,
    _projection: RuntimeProjection,
    _envelope: TaskEnvelope,
    _claimedRun?: HostRunRecord
  ): Promise<HostExecutionOutcome> {
    throw new Error("executeAssignment is not used in host-run recovery matrix tests");
  }

  async claimRunLease(
    store: RuntimeArtifactStore,
    _projection: RuntimeProjection,
    assignmentId: string,
    claimedRun?: HostRunRecord
  ): Promise<HostRunRecord> {
    this.bindStore(store);
    const record = claimedRun ?? runningRecord(assignmentId, "2999-04-11T10:00:30.000Z");
    await this.runStore.claim(record);
    return record;
  }

  async releaseRunLease(store: RuntimeArtifactStore, assignmentId: string): Promise<void> {
    this.bindStore(store);
    await this.runStore.release(assignmentId);
  }

  async reconcileStaleRun(store: RuntimeArtifactStore, record: HostRunRecord): Promise<void> {
    this.bindStore(store);
    await this.runStore.write(record);
  }

  async inspectRun(store: RuntimeArtifactStore, assignmentId?: string): Promise<HostRunRecord | undefined> {
    this.bindStore(store);
    return this.runStore.inspect(assignmentId);
  }

  normalizeResult(capture: HostResultCapture): ResultPacket {
    return {
      resultId: capture.resultId ?? randomUUID(),
      assignmentId: capture.assignmentId,
      producerId: capture.producerId,
      status: capture.status,
      summary: capture.summary,
      changedFiles: [...capture.changedFiles],
      createdAt: capture.createdAt ?? nowIso()
    };
  }

  normalizeDecision(capture: HostDecisionCapture): DecisionPacket {
    return {
      decisionId: capture.decisionId ?? randomUUID(),
      assignmentId: capture.assignmentId,
      requesterId: capture.requesterId,
      blockerSummary: capture.blockerSummary,
      options: capture.options.map((option) => ({ ...option })),
      recommendedOption: capture.recommendedOption,
      state: capture.state ?? "open",
      createdAt: capture.createdAt ?? nowIso()
    };
  }

  normalizeTelemetry(capture: HostTelemetryCapture) {
    return {
      eventType: capture.eventType,
      taskId: capture.taskId,
      host: this.host,
      adapter: this.id,
      metadata: capture.metadata,
      ...capture.usage,
      ...(capture.assignmentId ? { assignmentId: capture.assignmentId } : {})
    };
  }
}

class ConcurrentRunMatrixAdapter extends MatrixAdapter {
  invocationCount = 0;
  private release!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  constructor() {
    super({
      runRecordPath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.json`,
      runLeasePath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.lease.json`,
      lastRunPath: () => "adapters/matrix/last-run.json"
    });
  }

  releaseRun(): void {
    this.release();
  }

  override async buildResumeEnvelope(
    _store: RuntimeArtifactStore,
    projection: RuntimeProjection,
    _brief: RecoveryBrief
  ): Promise<TaskEnvelope> {
    const assignmentId = projection.status.activeAssignmentIds[0]!;
    const assignment = projection.assignments.get(assignmentId)!;
    return {
      host: this.host,
      adapter: this.id,
      objective: assignment.objective,
      writeScope: [...assignment.writeScope],
      requiredOutputs: [...assignment.requiredOutputs],
      recoveryBrief: {
        activeObjective: assignment.objective,
        activeAssignments: [
          {
            id: assignment.id,
            objective: assignment.objective,
            state: assignment.state,
            writeScope: [...assignment.writeScope],
            requiredOutputs: [...assignment.requiredOutputs]
          }
        ],
        lastDurableResults: [],
        unresolvedDecisions: [],
        nextRequiredAction: `Continue assignment ${assignment.id}.`,
        generatedAt: nowIso()
      },
      recentResults: [],
      metadata: { activeAssignmentId: assignment.id },
      estimatedChars: 0,
      trimApplied: false,
      trimmedFields: []
    };
  }

  override async executeAssignment(
    store: RuntimeArtifactStore,
    projection: RuntimeProjection,
    _envelope: TaskEnvelope,
    claimedRun?: HostRunRecord
  ): Promise<HostExecutionOutcome> {
    this.bindStore(store);
    this.invocationCount += 1;
    await this.released;
    const assignmentId = claimedRun?.assignmentId ?? projection.status.activeAssignmentIds[0]!;
    const completedAt = nowIso();
    const outcome = {
      outcome: {
        kind: "result" as const,
        capture: {
          assignmentId,
          producerId: "matrix-host",
          status: "completed" as const,
          summary: "Concurrent run protection kept a single host run.",
          changedFiles: [],
          createdAt: completedAt
        }
      }
    };
    const run = buildCompletedRunRecord(
      outcome,
      assignmentId,
      claimedRun?.startedAt ?? completedAt,
      completedAt
    );
    await this.runStore.write(run);
    return {
      ...outcome,
      run
    };
  }
}

async function createMatrixContext(adapter = new MatrixAdapter({
  runRecordPath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.json`,
  runLeasePath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.lease.json`,
  lastRunPath: () => "adapters/matrix/last-run.json"
})): Promise<MatrixContext> {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-host-run-matrix-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "matrix",
    host: "matrix",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "matrix",
    host: "matrix",
    workflow: "milestone-2"
  });
  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  await adapter.initialize(store, await loadOperatorProjection(store));
  adapter.bindStore(store);

  return {
    store,
    projection: await loadOperatorProjection(store),
    assignmentId: bootstrap.initialAssignmentId,
    adapter
  };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms.`);
}

function runningRecord(assignmentId: string, leaseExpiresAt: string): HostRunRecord {
  return {
    assignmentId,
    state: "running",
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    leaseExpiresAt,
    adapterData: { nativeRunId: `native-${assignmentId}` }
  };
}

function completedResultRecord(
  assignmentId: string,
  status: ResultPacket["status"],
  summary: string
): HostRunRecord {
  const createdAt = nowIso();
  return {
    assignmentId,
    state: "completed",
    startedAt: createdAt,
    completedAt: createdAt,
    outcomeKind: "result",
    resultStatus: status,
    summary,
    adapterData: { nativeRunId: `native-${assignmentId}` },
    terminalOutcome: {
      kind: "result",
        result: {
          resultId: randomUUID(),
          producerId: "matrix-host",
          status,
          summary,
        changedFiles: [],
        createdAt
      }
    }
  };
}
