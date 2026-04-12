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
import type { RuntimeEvent } from "../core/events.js";
import type { DecisionPacket, HostRunRecord, RecoveryBrief, ResultPacket, RuntimeProjection } from "../core/types.js";
import { RuntimeStore } from "../persistence/store.js";
import { loadOperatorProjection } from "../cli/runtime-state.js";
import { reconcileActiveRuns } from "../cli/run-operations.js";
import { loadReconciledProjectionWithDiagnostics, resumeRuntime, runRuntime } from "../cli/commands.js";
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
  let staleRecoverySecondAssignmentId: string | undefined;
  const conflictingObjective = "Conflicting objective before stale recovery.";
  const cases = [
    {
      name: "valid active lease stays authoritative during reconciliation",
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
      name: "valid active lease overrides expired running metadata during reconciliation",
      seed: async (ctx: MatrixContext) => {
        await ctx.store.writeJsonArtifact(
          `adapters/matrix/runs/${ctx.assignmentId}.json`,
          runningRecord(ctx.assignmentId, "2000-01-01T00:00:00.000Z")
        );
        await ctx.store.writeJsonArtifact(
          `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
          runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z")
        );
        await ctx.store.writeJsonArtifact(
          "adapters/matrix/last-run.json",
          runningRecord(ctx.assignmentId, "2000-01-01T00:00:00.000Z")
        );
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, [ctx.assignmentId]);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "in_progress");
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "active-run-present"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "running");
        assert.equal(inspected?.leaseExpiresAt, "2999-04-11T10:00:30.000Z");
      }
    },
    {
      name: "valid active lease overrides missing-expiry running metadata during reconciliation",
      seed: async (ctx: MatrixContext) => {
        await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, {
          assignmentId: ctx.assignmentId,
          state: "running",
          startedAt: "2026-04-11T10:00:00.000Z",
          heartbeatAt: "2026-04-11T10:00:00.000Z"
        });
        await ctx.store.writeJsonArtifact(
          `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
          runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z")
        );
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, [ctx.assignmentId]);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "in_progress");
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "active-run-present"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "running");
        assert.equal(inspected?.leaseExpiresAt, "2999-04-11T10:00:30.000Z");
      }
    },
    {
      name: "valid active lease overrides invalid-expiry running metadata during reconciliation",
      seed: async (ctx: MatrixContext) => {
        await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, {
          ...runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z"),
          leaseExpiresAt: "not-a-timestamp"
        });
        await ctx.store.writeJsonArtifact(
          `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
          runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z")
        );
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, [ctx.assignmentId]);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "in_progress");
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "active-run-present"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "running");
        assert.equal(inspected?.leaseExpiresAt, "2999-04-11T10:00:30.000Z");
      }
    },
    {
      name: "valid active lease overrides stale-completed metadata during reconciliation",
      seed: async (ctx: MatrixContext) => {
        await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, {
          assignmentId: ctx.assignmentId,
          state: "completed",
          startedAt: "2026-04-11T10:00:00.000Z",
          completedAt: "2026-04-11T10:01:00.000Z",
          staleAt: "2026-04-11T10:01:00.000Z",
          staleReasonCode: "expired_lease",
          staleReason: "Run lease expired at 2000-01-01T00:00:00.000Z."
        });
        await ctx.store.writeJsonArtifact(
          `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
          runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z")
        );
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, [ctx.assignmentId]);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "in_progress");
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "active-run-present"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "running");
        assert.equal(inspected?.leaseExpiresAt, "2999-04-11T10:00:30.000Z");
      }
    },
    {
      name: "multiple stale leases update runtime status from the latest projection",
      seed: async (ctx: MatrixContext) => {
        staleRecoverySecondAssignmentId = await appendActiveAssignment(ctx);
        ctx.projection.status.currentObjective = conflictingObjective;
        const expiredAt = "2000-01-01T00:00:00.000Z";
        await ctx.adapter.runStore.write(runningRecord(ctx.assignmentId, expiredAt));
        await ctx.adapter.runStore.write(runningRecord(staleRecoverySecondAssignmentId, expiredAt));
        await ctx.store.writeJsonArtifact(
          "adapters/matrix/last-run.json",
          runningRecord(staleRecoverySecondAssignmentId, expiredAt)
        );
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        const assignmentIds = result.projection.status.activeAssignmentIds;
        assert.ok(staleRecoverySecondAssignmentId, "second assignment should remain in the reconciled active list");
        assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.code === "stale-run-reconciled").length, 2);
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "queued");
        assert.equal(result.projection.assignments.get(staleRecoverySecondAssignmentId)?.state, "queued");
        assert.deepEqual(assignmentIds, [ctx.assignmentId, staleRecoverySecondAssignmentId]);
        assert.equal(
          result.projection.status.currentObjective,
          `Retry assignment ${staleRecoverySecondAssignmentId}: Retry assignment ${ctx.assignmentId}: ${ctx.projection.assignments.get(ctx.assignmentId)?.objective}`
        );
        assert.notEqual(result.projection.status.currentObjective, conflictingObjective);
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
        assert.equal(
          await ctx.store.readTextArtifact(
            `adapters/matrix/runs/${staleRecoverySecondAssignmentId}.lease.json`,
            "matrix lease"
          ),
          undefined
        );
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
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
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
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.staleReasonCode, "missing_lease_expiry");
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
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
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.staleReasonCode, "invalid_lease_expiry");
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
      }
    },
    {
      name: "lease-only stale state is reconciled into a queued retry",
      seed: async (ctx: MatrixContext) => {
        const leaseOnly = runningRecord(ctx.assignmentId, "2000-01-01T00:00:00.000Z");
        await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, leaseOnly);
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "queued");
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.staleReasonCode, "expired_lease");
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
      }
    },
    {
      name: "malformed lease without a durable run record is reconciled into a queued retry",
      seed: async (ctx: MatrixContext) => {
        await ctx.store.writeTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "{");
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "queued");
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.staleReasonCode, "malformed_lease_artifact");
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
      }
    },
    {
      name: "completed record with malformed leftover lease is recovered into runtime truth",
      seed: async (ctx: MatrixContext) => {
        await ctx.adapter.runStore.write(
          completedResultRecord(ctx.assignmentId, "completed", "Older completed result.")
        );
        await ctx.store.writeTextArtifact(
          `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
          "{"
        );
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "completed");
        assert.deepEqual(result.projection.status.activeAssignmentIds, []);
        assert.equal(result.projection.results.size, 1);
        assert.equal([...result.projection.results.values()][0]?.assignmentId, ctx.assignmentId);
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
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
        assert.equal([...result.projection.results.values()][0]?.assignmentId, ctx.assignmentId);
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
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
        assert.equal([...result.projection.results.values()][0]?.assignmentId, ctx.assignmentId);
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
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
      name: "completed record with leftover missing-expiry lease is recovered into runtime truth",
      seed: async (ctx: MatrixContext) => {
        await ctx.adapter.runStore.write(
          completedResultRecord(ctx.assignmentId, "completed", "Older completed result.")
        );
        await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, {
          assignmentId: ctx.assignmentId,
          state: "running",
          startedAt: "2026-04-11T10:00:00.000Z",
          heartbeatAt: "2026-04-11T10:00:00.000Z"
        });
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "completed");
        assert.deepEqual(result.projection.status.activeAssignmentIds, []);
        assert.equal(result.projection.results.size, 1);
        assert.equal([...result.projection.results.values()][0]?.assignmentId, ctx.assignmentId);
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
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
      name: "completed record with leftover invalid-expiry lease is recovered into runtime truth",
      seed: async (ctx: MatrixContext) => {
        await ctx.adapter.runStore.write(
          completedResultRecord(ctx.assignmentId, "completed", "Older completed result.")
        );
        await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, {
          ...runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z"),
          leaseExpiresAt: "not-a-timestamp"
        });
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "completed");
        assert.deepEqual(result.projection.status.activeAssignmentIds, []);
        assert.equal(result.projection.results.size, 1);
        assert.equal([...result.projection.results.values()][0]?.assignmentId, ctx.assignmentId);
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
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
        const durableRecord = JSON.parse(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, "matrix run") ?? "{}"
        ) as HostRunRecord;
        assert.equal(durableRecord.terminalOutcome?.kind, "result");
        assert.deepEqual([...result.projection.results.values()][0], {
          assignmentId: ctx.assignmentId,
          ...durableRecord.terminalOutcome.result
        });
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
      }
    },
    {
      name: "durable failed result is absorbed back into runtime truth",
      seed: async (ctx: MatrixContext) => {
        await ctx.adapter.runStore.write(
          completedResultRecord(ctx.assignmentId, "failed", "Recovered failed result.")
        );
        await ctx.store.writeJsonArtifact(
          `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
          runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z")
        );
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "failed");
        assert.deepEqual(result.projection.status.activeAssignmentIds, []);
        assert.equal(result.projection.status.currentObjective, `Review failed assignment ${ctx.assignmentId}.`);
        assert.equal(result.projection.results.size, 1);
        const durableRecord = JSON.parse(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, "matrix run") ?? "{}"
        ) as HostRunRecord;
        assert.equal(durableRecord.terminalOutcome?.kind, "result");
        assert.deepEqual([...result.projection.results.values()][0], {
          assignmentId: ctx.assignmentId,
          ...durableRecord.terminalOutcome.result
        });
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
      }
    },
    {
      name: "durable completed decision is absorbed back into runtime truth",
      seed: async (ctx: MatrixContext) => {
        await ctx.adapter.runStore.write(
          completedDecisionRecord(ctx.assignmentId, "Need operator confirmation before proceeding.")
        );
        await ctx.store.writeJsonArtifact(
          `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
          runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z")
        );
      },
      assertResult: async (ctx: MatrixContext, result: Awaited<ReturnType<typeof reconcileActiveRuns>>) => {
        assert.deepEqual(result.activeLeases, []);
        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "blocked");
        assert.deepEqual(result.projection.status.activeAssignmentIds, [ctx.assignmentId]);
        assert.equal(result.projection.decisions.size, 1);
        const durableRecord = JSON.parse(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, "matrix run") ?? "{}"
        ) as HostRunRecord;
        assert.equal(durableRecord.terminalOutcome?.kind, "decision");
        assert.deepEqual([...result.projection.decisions.values()][0], {
          assignmentId: ctx.assignmentId,
          ...durableRecord.terminalOutcome.decision
        });
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
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
      name: "valid active lease blocks a new run before execution starts",
      run: async () => {
        const artifacts: HostRunArtifactPaths = {
          runRecordPath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.json`,
          runLeasePath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.lease.json`,
          lastRunPath: () => "adapters/matrix/last-run.json"
        };
        const adapter = new ExecutionSentinelMatrixAdapter(artifacts);
        const ctx = await createMatrixContext(adapter);
        await ctx.adapter.claimRunLease(
          ctx.store,
          ctx.projection,
          ctx.assignmentId,
          runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z")
        );

        await assert.rejects(
          runRuntime(ctx.store, ctx.adapter),
          /already has an active host run lease/
        );

        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        assert.equal(inspected?.state, "running");
        assert.equal(adapter.buildResumeEnvelopeCount, 0);
        assert.equal(adapter.executeAssignmentCount, 0);
      }
    },
    {
      name: "concurrent run attempts do not launch duplicate host executions"
      ,
      run: async () => {
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
      }
    }
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await testCase.run();
    });
  }
});

test("host-run command matrix reconciles operator-visible runtime truth", async (t) => {
  const cases = [
    {
      name: "status path reconciles stale lease-only state before reporting work",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        const leaseOnly = runningRecord(ctx.assignmentId, "2000-01-01T00:00:00.000Z");
        await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, leaseOnly);

        const result = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);

        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "queued");
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
      }
    },
    {
      name: "status path recovers a durable completed decision before exposing runtime truth",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        await ctx.adapter.runStore.write(
          completedDecisionRecord(ctx.assignmentId, "Need operator confirmation before proceeding.")
        );
        await ctx.store.writeJsonArtifact(
          `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
          runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z")
        );

        const result = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);

        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "blocked");
        assert.deepEqual(result.projection.status.activeAssignmentIds, [ctx.assignmentId]);
        assert.equal(result.projection.decisions.size, 1);
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
      }
    },
    {
      name: "resume path recovers a durable completed decision before brief shaping",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        await ctx.adapter.runStore.write(
          completedDecisionRecord(ctx.assignmentId, "Need operator confirmation before proceeding.")
        );
        await ctx.store.writeJsonArtifact(
          `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
          runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z")
        );

        const resumed = await resumeRuntime(ctx.store, ctx.adapter);

        assert.equal(resumed.projection.assignments.get(ctx.assignmentId)?.state, "blocked");
        assert.deepEqual(resumed.projection.status.activeAssignmentIds, [ctx.assignmentId]);
        assert.equal(resumed.brief.activeAssignments.length, 1);
        assert.equal(resumed.brief.activeAssignments[0]?.id, ctx.assignmentId);
        assert.equal(resumed.brief.unresolvedDecisions.length, 1);
        assert.equal(resumed.brief.unresolvedDecisions[0]?.assignmentId, ctx.assignmentId);
        assert.ok(resumed.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.ok(!resumed.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
      }
    },
    {
      name: "run path scopes the envelope to the runnable assignment among multiple active assignments",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        const runnableAssignmentId = await appendActiveAssignment(ctx);
        const timestamp = nowIso();
        const blockedAssignmentId = ctx.assignmentId;
        for (const event of [
          {
            eventId: randomUUID(),
            sessionId: ctx.projection.sessionId,
            timestamp,
            type: "assignment.updated" as const,
            payload: {
              assignmentId: blockedAssignmentId,
              patch: {
                state: "blocked" as const,
                updatedAt: timestamp
              }
            }
          },
          {
            eventId: randomUUID(),
            sessionId: ctx.projection.sessionId,
            timestamp,
            type: "decision.created" as const,
            payload: {
              decision: {
                decisionId: randomUUID(),
                assignmentId: blockedAssignmentId,
                requesterId: "matrix-host",
                blockerSummary: "Need input before continuing the original assignment.",
                options: [{ id: "wait", label: "Wait", summary: "Pause until guidance arrives." }],
                recommendedOption: "wait",
                state: "open" as const,
                createdAt: timestamp
              }
            }
          },
          {
            eventId: randomUUID(),
            sessionId: ctx.projection.sessionId,
            timestamp,
            type: "status.updated" as const,
            payload: {
              status: {
                ...ctx.projection.status,
                activeAssignmentIds: [blockedAssignmentId, runnableAssignmentId],
                lastDurableOutputAt: timestamp
              }
            }
          }
        ]) {
          await ctx.store.appendEvent(event);
        }
        await ctx.store.syncSnapshotFromEvents();

        const run = await runRuntime(ctx.store, ctx.adapter);

        assert.equal(run.assignment.id, runnableAssignmentId);
        assert.equal(run.envelope.metadata.activeAssignmentId, runnableAssignmentId);
        assert.equal(run.envelope.recoveryBrief.activeAssignments.length, 1);
        assert.equal(run.envelope.recoveryBrief.activeAssignments[0]?.id, runnableAssignmentId);
        assert.equal(run.envelope.recoveryBrief.unresolvedDecisions.length, 0);
        assert.deepEqual(adapter.lastBuildProjection?.status.activeAssignmentIds, [runnableAssignmentId]);
        assert.equal(adapter.lastBuildBrief?.activeAssignments.length, 1);
        assert.equal(adapter.lastBuildBrief?.activeAssignments[0]?.id, runnableAssignmentId);
      }
    },
    {
      name: "completed metadata without a terminal outcome does not drive completed-run reconciliation",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        const startedAt = nowIso();
        await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, {
          assignmentId: ctx.assignmentId,
          state: "completed",
          startedAt,
          completedAt: startedAt,
          summary: "Outcome-less completed metadata should not reconcile runtime truth.",
          adapterData: { nativeRunId: `native-${ctx.assignmentId}` }
        });
        await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", {
          assignmentId: ctx.assignmentId,
          state: "completed",
          startedAt,
          completedAt: startedAt,
          summary: "Outcome-less completed metadata should not reconcile runtime truth.",
          adapterData: { nativeRunId: `native-${ctx.assignmentId}` }
        });

        const result = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);

        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "in_progress");
        assert.deepEqual(result.projection.status.activeAssignmentIds, [ctx.assignmentId]);
        assert.equal(result.projection.results.size, 0);
        assert.equal(result.projection.decisions.size, 0);
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.terminalOutcome, undefined);
      }
    }
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await testCase.run();
    });
  }
});

test("host-run command matrix keeps stale-run reconciliation idempotent", async () => {
  const adapter = new BriefingMatrixAdapter();
  const ctx = await createMatrixContext(adapter);
  const staleRecord = runningRecord(ctx.assignmentId, "2000-01-01T00:00:00.000Z");
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, staleRecord);
  await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", staleRecord);
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, staleRecord);

  const firstResume = await resumeRuntime(ctx.store, ctx.adapter);
  const driftTimestamp = nowIso();
  await ctx.store.appendEvent({
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
  await ctx.store.syncSnapshotFromEvents();
  const secondResume = await resumeRuntime(ctx.store, ctx.adapter);
  const statusResult = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);
  const run = await runRuntime(ctx.store, ctx.adapter);
  const telemetry = await ctx.store.loadTelemetry();
  const events = await ctx.store.loadEvents();
  const staleTelemetryCount = telemetry.filter((event) => event.eventType === "host.run.stale_reconciled").length;
  const queuedTransitionCount = events.filter(
    (event) =>
      event.type === "assignment.updated" &&
      event.payload.assignmentId === ctx.assignmentId &&
      event.payload.patch.state === "queued"
  ).length;

  assert.ok(firstResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(!secondResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(!statusResult.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(statusResult.projection.assignments.get(ctx.assignmentId)?.state, "queued");
  assert.equal(
    statusResult.projection.status.currentObjective,
    "Operator updated the status after stale reconciliation."
  );
  assert.equal(queuedTransitionCount, 1);
  assert.equal(staleTelemetryCount, 1);
  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.status, "completed");
});

test("host-run command matrix treats a later stale retry as a new stale run", async () => {
  const adapter = new BriefingMatrixAdapter();
  const ctx = await createMatrixContext(adapter);
  const firstStaleRecord = runningRecord(ctx.assignmentId, "2000-01-01T00:00:00.000Z");
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, firstStaleRecord);
  await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", firstStaleRecord);
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, firstStaleRecord);

  const firstResume = await resumeRuntime(ctx.store, ctx.adapter);
  assert.ok(firstResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));

  const retryStartedAt = nowIso();
  const secondStaleRecord: HostRunRecord = {
    assignmentId: ctx.assignmentId,
    state: "running",
    startedAt: retryStartedAt,
    heartbeatAt: retryStartedAt,
    leaseExpiresAt: "2000-01-01T00:00:00.000Z",
    adapterData: { nativeRunId: `retry-${ctx.assignmentId}` }
  };
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, secondStaleRecord);
  await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", secondStaleRecord);
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, secondStaleRecord);

  const secondResume = await resumeRuntime(ctx.store, ctx.adapter);
  const telemetry = await ctx.store.loadTelemetry();
  const events = await ctx.store.loadEvents();
  const staleTelemetryCount = telemetry.filter((event) => event.eventType === "host.run.stale_reconciled").length;
  const queuedTransitionCount = events.filter(
    (event) =>
      event.type === "assignment.updated" &&
      event.payload.assignmentId === ctx.assignmentId &&
      event.payload.patch.state === "queued"
  ).length;

  assert.ok(secondResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(queuedTransitionCount, 2);
  assert.equal(staleTelemetryCount, 2);
});

test("host-run recovery matrix repairs missing stale status convergence after queued transition", async () => {
  const ctx = await createMatrixContext();
  const staleRecord = runningRecord(ctx.assignmentId, "2000-01-01T00:00:00.000Z");
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, staleRecord);
  await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", staleRecord);
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, staleRecord);

  const originalAppendEvent = ctx.store.appendEvent.bind(ctx.store);
  let failedStatusUpdate = false;
  (ctx.store as RuntimeStore & {
    appendEvent: RuntimeStore["appendEvent"];
  }).appendEvent = async (event) => {
    if (!failedStatusUpdate && event.type === "status.updated") {
      failedStatusUpdate = true;
      throw new Error("simulated stale-run status persistence failure");
    }
    await originalAppendEvent(event);
  };

  await assert.rejects(
    reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection),
    /simulated stale-run status persistence failure/
  );

  (ctx.store as RuntimeStore & {
    appendEvent: RuntimeStore["appendEvent"];
  }).appendEvent = originalAppendEvent;

  const interrupted = await ctx.store.syncSnapshotFromEventsWithRecovery();
  const secondRecovery = await reconcileActiveRuns(ctx.store, ctx.adapter, interrupted.projection);
  const thirdRecovery = await reconcileActiveRuns(ctx.store, ctx.adapter, secondRecovery.projection);
  const events = await ctx.store.loadEvents();
  const queuedTransitionCount = events.filter(
    (event) =>
      event.type === "assignment.updated" &&
      event.payload.assignmentId === ctx.assignmentId &&
      event.payload.patch.state === "queued"
  ).length;
  const staleStatusCount = events.filter(
    (event) =>
      event.type === "status.updated" &&
      event.payload.status.currentObjective.startsWith(`Retry assignment ${ctx.assignmentId}:`)
  ).length;

  assert.equal(interrupted.projection.assignments.get(ctx.assignmentId)?.state, "queued");
  assert.doesNotMatch(
    interrupted.projection.status.currentObjective,
    new RegExp(`^Retry assignment ${ctx.assignmentId}:`)
  );
  assert.ok(secondRecovery.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(secondRecovery.projection.assignments.get(ctx.assignmentId)?.state, "queued");
  assert.match(
    secondRecovery.projection.status.currentObjective,
    new RegExp(`^Retry assignment ${ctx.assignmentId}:`)
  );
  assert.equal(queuedTransitionCount, 1);
  assert.equal(staleStatusCount, 1);
  assert.ok(!thirdRecovery.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
});

test("host-run recovery matrix keeps completed-run reconciliation idempotent", async (t) => {
  const cases = [
    {
      name: "recovered completed results do not replay on a second pass",
      eventType: "result.submitted" as const,
      seed: async (ctx: MatrixContext) => {
        await ctx.adapter.runStore.write(
          completedResultRecord(ctx.assignmentId, "completed", "Recovered completed result.")
        );
      },
      assertStable: async (
        ctx: MatrixContext,
        once: Awaited<ReturnType<typeof reconcileActiveRuns>>,
        twice: Awaited<ReturnType<typeof reconcileActiveRuns>>,
        firstEventCount: number,
        secondEventCount: number
      ) => {
        const firstResult = [...once.projection.results.values()][0]!;
        const secondResult = [...twice.projection.results.values()][0]!;
        assert.equal(once.projection.results.size, 1);
        assert.equal(twice.projection.results.size, 1);
        assert.equal(once.projection.assignments.get(ctx.assignmentId)?.state, "completed");
        assert.equal(twice.projection.assignments.get(ctx.assignmentId)?.state, "completed");
        assert.deepEqual(once.projection.status.activeAssignmentIds, []);
        assert.deepEqual(twice.projection.status.activeAssignmentIds, []);
        assert.deepEqual(secondResult, firstResult);
        assert.equal(twice.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"), false);
        assert.equal(twice.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"), false);
        assert.equal(firstEventCount, 1);
        assert.equal(secondEventCount, firstEventCount);
      }
    },
    {
      name: "recovered completed decisions do not replay after later resolution",
      eventType: "decision.created" as const,
      seed: async (ctx: MatrixContext) => {
        await ctx.adapter.runStore.write(
          completedDecisionRecord(ctx.assignmentId, "Need operator confirmation before proceeding.")
        );
      },
      assertStable: async (
        ctx: MatrixContext,
        once: Awaited<ReturnType<typeof reconcileActiveRuns>>,
        twice: Awaited<ReturnType<typeof reconcileActiveRuns>>,
        firstEventCount: number,
        secondEventCount: number
      ) => {
        const firstDecision = [...once.projection.decisions.values()][0]!;
        const resolutionTimestamp = nowIso();
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: once.projection.sessionId,
          timestamp: resolutionTimestamp,
          type: "decision.resolved",
          payload: {
            decisionId: firstDecision.decisionId,
            resolvedAt: resolutionTimestamp,
            resolutionSummary: "Operator chose to continue after recovery."
          }
        });
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: once.projection.sessionId,
          timestamp: resolutionTimestamp,
          type: "assignment.updated",
          payload: {
            assignmentId: ctx.assignmentId,
            patch: {
              state: "in_progress",
              updatedAt: resolutionTimestamp
            }
          }
        });
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: once.projection.sessionId,
          timestamp: resolutionTimestamp,
          type: "status.updated",
          payload: {
            status: {
              ...once.projection.status,
              currentObjective: "Continue after the recovered decision was resolved.",
              lastDurableOutputAt: resolutionTimestamp
            }
          }
        });
        const progressed = await ctx.store.syncSnapshotFromEventsWithRecovery();
        twice = await reconcileActiveRuns(ctx.store, ctx.adapter, progressed.projection);
        const secondDecision = [...twice.projection.decisions.values()][0]!;
        assert.equal(once.projection.decisions.size, 1);
        assert.equal(twice.projection.decisions.size, 1);
        assert.equal(once.projection.assignments.get(ctx.assignmentId)?.state, "blocked");
        assert.equal(twice.projection.assignments.get(ctx.assignmentId)?.state, "in_progress");
        assert.deepEqual(once.projection.status.activeAssignmentIds, [ctx.assignmentId]);
        assert.deepEqual(twice.projection.status.activeAssignmentIds, [ctx.assignmentId]);
        assert.equal(secondDecision.decisionId, firstDecision.decisionId);
        assert.equal(secondDecision.state, "resolved");
        assert.equal(twice.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"), false);
        assert.equal(twice.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"), false);
        assert.equal(firstEventCount, 1);
        assert.equal(secondEventCount, firstEventCount);
      }
    }
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const ctx = await createMatrixContext();
      await testCase.seed(ctx);
      const first = await reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection);
      const firstEventCount = await countRecoveredOutcomeEvents(ctx.store, ctx.assignmentId, testCase.eventType);
      const second = await reconcileActiveRuns(ctx.store, ctx.adapter, first.projection);
      const secondEventCount = await countRecoveredOutcomeEvents(ctx.store, ctx.assignmentId, testCase.eventType);
      await testCase.assertStable(ctx, first, second, firstEventCount, secondEventCount);
    });
  }
});

test("host-run recovery matrix does not replay recovered results after a status-update interruption", async () => {
  const ctx = await createMatrixContext();
  await ctx.adapter.runStore.write(
    completedResultRecord(ctx.assignmentId, "completed", "Recovered completed result.")
  );

  const originalAppendEvent = ctx.store.appendEvent.bind(ctx.store);
  let failedStatusUpdate = false;
  (ctx.store as RuntimeStore & {
    appendEvent: RuntimeStore["appendEvent"];
  }).appendEvent = async (event) => {
    if (!failedStatusUpdate && event.type === "status.updated") {
      failedStatusUpdate = true;
      throw new Error("simulated completed-run status persistence failure");
    }
    await originalAppendEvent(event);
  };

  await assert.rejects(
    reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection),
    /simulated completed-run status persistence failure/
  );

  (ctx.store as RuntimeStore & {
    appendEvent: RuntimeStore["appendEvent"];
  }).appendEvent = originalAppendEvent;

  const interrupted = await ctx.store.syncSnapshotFromEventsWithRecovery();
  const firstEventCount = await countRecoveredOutcomeEvents(ctx.store, ctx.assignmentId, "result.submitted");
  const recovered = await reconcileActiveRuns(ctx.store, ctx.adapter, interrupted.projection);
  const secondEventCount = await countRecoveredOutcomeEvents(ctx.store, ctx.assignmentId, "result.submitted");

  assert.equal(firstEventCount, 1);
  assert.equal(secondEventCount, firstEventCount);
  assert.equal(recovered.projection.results.size, 1);
  assert.equal(recovered.projection.assignments.get(ctx.assignmentId)?.state, "completed");
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, []);
  assert.equal(recovered.projection.status.currentObjective, "Await the next assignment.");
  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
});

test("host-run recovery matrix repairs completed decisions after an assignment-update interruption", async () => {
  const ctx = await createMatrixContext();
  await ctx.adapter.runStore.write(
    completedDecisionRecord(ctx.assignmentId, "Need operator confirmation before proceeding.")
  );

  const originalAppendEvent = ctx.store.appendEvent.bind(ctx.store);
  let failedAssignmentUpdate = false;
  (ctx.store as RuntimeStore & {
    appendEvent: RuntimeStore["appendEvent"];
  }).appendEvent = async (event) => {
    if (!failedAssignmentUpdate && event.type === "assignment.updated") {
      failedAssignmentUpdate = true;
      throw new Error("simulated completed-run assignment persistence failure");
    }
    await originalAppendEvent(event);
  };

  await assert.rejects(
    reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection),
    /simulated completed-run assignment persistence failure/
  );

  (ctx.store as RuntimeStore & {
    appendEvent: RuntimeStore["appendEvent"];
  }).appendEvent = originalAppendEvent;

  const interrupted = await ctx.store.syncSnapshotFromEventsWithRecovery();
  const firstDecisionCount = await countRecoveredOutcomeEvents(ctx.store, ctx.assignmentId, "decision.created");
  const recovered = await reconcileActiveRuns(ctx.store, ctx.adapter, interrupted.projection);
  const secondDecisionCount = await countRecoveredOutcomeEvents(ctx.store, ctx.assignmentId, "decision.created");

  assert.equal(firstDecisionCount, 1);
  assert.equal(secondDecisionCount, firstDecisionCount);
  assert.equal(interrupted.projection.decisions.size, 1);
  assert.equal(interrupted.projection.assignments.get(ctx.assignmentId)?.state, "in_progress");
  assert.equal(recovered.projection.decisions.size, 1);
  assert.equal(recovered.projection.assignments.get(ctx.assignmentId)?.state, "blocked");
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, [ctx.assignmentId]);
  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
});

test("host-run recovery matrix retries completed-run cleanup after the outcome is already durable", async () => {
  const ctx = await createMatrixContext();
  const completedRecord = completedResultRecord(
    ctx.assignmentId,
    "completed",
    "Recovered completed result."
  );
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, completedRecord);
  await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", completedRecord);
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, completedRecord);

  const originalReconcileStaleRun = ctx.adapter.reconcileStaleRun.bind(ctx.adapter);
  let reconcileAttempts = 0;
  (ctx.adapter as MatrixAdapter).reconcileStaleRun = async (store, record) => {
    reconcileAttempts += 1;
    if (reconcileAttempts === 1) {
      throw new Error("simulated completed-run cleanup failure");
    }
    await originalReconcileStaleRun(store, record);
  };

  const firstRecovery = await reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection);
  const firstEventCount = await countRecoveredOutcomeEvents(ctx.store, ctx.assignmentId, "result.submitted");
  const firstLeaseContents = await ctx.store.readTextArtifact(
    `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
    "matrix lease"
  );
  const secondRecovery = await reconcileActiveRuns(ctx.store, ctx.adapter, firstRecovery.projection);
  const secondEventCount = await countRecoveredOutcomeEvents(ctx.store, ctx.assignmentId, "result.submitted");
  const leaseAfterSecondRecovery = await ctx.store.readTextArtifact(
    `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
    "matrix lease"
  );

  assert.ok(firstRecovery.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.ok(firstRecovery.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.equal(firstEventCount, 1);
  assert.equal(secondEventCount, firstEventCount);
  assert.equal(reconcileAttempts, 2);
  assert.notEqual(firstLeaseContents, undefined);
  assert.equal(secondRecovery.projection.results.size, 1);
  assert.equal(secondRecovery.projection.assignments.get(ctx.assignmentId)?.state, "completed");
  assert.deepEqual(secondRecovery.projection.status.activeAssignmentIds, []);
  assert.equal(leaseAfterSecondRecovery, undefined);
});
test("host-run recovery matrix retries malformed lease cleanup without duplicating queued transitions", async () => {
  const ctx = await createMatrixContext();
  await ctx.store.writeTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "{");

  const originalReconcileStaleRun = ctx.adapter.reconcileStaleRun.bind(ctx.adapter);
  let reconcileAttempts = 0;
  ctx.adapter.reconcileStaleRun = async (store, record) => {
    reconcileAttempts += 1;
    if (reconcileAttempts === 1) {
      throw new Error("simulated malformed lease cleanup failure");
    }
    await originalReconcileStaleRun(store, record);
  };

  const firstRecovery = await reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection);
  const secondRecovery = await reconcileActiveRuns(ctx.store, ctx.adapter, firstRecovery.projection);
  const events = await ctx.store.loadEvents();
  const queuedTransitionCount = events.filter(
    (event) =>
      event.type === "assignment.updated" &&
      event.payload.assignmentId === ctx.assignmentId &&
      event.payload.patch.state === "queued"
  ).length;

  assert.ok(firstRecovery.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(firstRecovery.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.equal(firstRecovery.projection.assignments.get(ctx.assignmentId)?.state, "queued");
  assert.equal(secondRecovery.projection.assignments.get(ctx.assignmentId)?.state, "queued");
  assert.ok(!secondRecovery.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(reconcileAttempts, 2);
  assert.equal(queuedTransitionCount, 1);
  assert.equal(
    await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
    undefined
  );
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

class ExecutionSentinelMatrixAdapter extends MatrixAdapter {
  buildResumeEnvelopeCount = 0;
  executeAssignmentCount = 0;

  constructor(artifacts: HostRunArtifactPaths) {
    super(artifacts);
  }

  override async buildResumeEnvelope(
    _store: RuntimeArtifactStore,
    _projection: RuntimeProjection,
    _brief: RecoveryBrief
  ): Promise<TaskEnvelope> {
    this.buildResumeEnvelopeCount += 1;
    throw new Error("buildResumeEnvelope should not run while an active host run lease is present.");
  }

  override async executeAssignment(
    _store: RuntimeArtifactStore,
    _projection: RuntimeProjection,
    _envelope: TaskEnvelope,
    _claimedRun?: HostRunRecord
  ): Promise<HostExecutionOutcome> {
    this.executeAssignmentCount += 1;
    throw new Error("executeAssignment should not run while an active host run lease is present.");
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

class BriefingMatrixAdapter extends MatrixAdapter {
  lastBuildProjection?: RuntimeProjection;
  lastBuildBrief?: RecoveryBrief;

  constructor() {
    super({
      runRecordPath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.json`,
      runLeasePath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.lease.json`,
      lastRunPath: () => "adapters/matrix/last-run.json"
    });
  }

  override async buildResumeEnvelope(
    _store: RuntimeArtifactStore,
    projection: RuntimeProjection,
    brief: RecoveryBrief
  ): Promise<TaskEnvelope> {
    this.lastBuildProjection = {
      ...projection,
      assignments: new Map(projection.assignments),
      results: new Map(projection.results),
      decisions: new Map(projection.decisions)
    };
    this.lastBuildBrief = {
      ...brief,
      activeAssignments: brief.activeAssignments.map((assignment) => ({ ...assignment })),
      lastDurableResults: brief.lastDurableResults.map((result) => ({ ...result })),
      unresolvedDecisions: brief.unresolvedDecisions.map((decision) => ({ ...decision }))
    };
    const assignmentId = projection.status.activeAssignmentIds[0]!;
    const assignment = projection.assignments.get(assignmentId)!;
    return {
      host: this.host,
      adapter: this.id,
      objective: assignment.objective,
      writeScope: [...assignment.writeScope],
      requiredOutputs: [...assignment.requiredOutputs],
      recoveryBrief: this.lastBuildBrief,
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
    const assignmentId = claimedRun?.assignmentId ?? projection.status.activeAssignmentIds[0]!;
    const completedAt = nowIso();
    const outcome = {
      outcome: {
        kind: "result" as const,
        capture: {
          assignmentId,
          producerId: "matrix-host",
          status: "completed" as const,
          summary: "Matrix command execution completed successfully.",
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

async function appendActiveAssignment(ctx: MatrixContext): Promise<string> {
  const secondAssignmentId = randomUUID();
  const timestamp = nowIso();
  const secondAssignmentEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: ctx.projection.sessionId,
    timestamp,
    type: "assignment.created",
    payload: {
      assignment: {
        id: secondAssignmentId,
        parentTaskId: "task-follow-up",
        workflow: "milestone-2",
        ownerType: "host",
        ownerId: "matrix",
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
    sessionId: ctx.projection.sessionId,
    timestamp,
    type: "status.updated",
    payload: {
      status: {
        ...ctx.projection.status,
        activeAssignmentIds: [ctx.assignmentId, secondAssignmentId],
        lastDurableOutputAt: timestamp
      }
    }
  };
  for (const event of [secondAssignmentEvent, statusEvent]) {
    await ctx.store.appendEvent(event);
  }
  await ctx.store.syncSnapshotFromEvents();
  ctx.projection = await loadOperatorProjection(ctx.store);
  return secondAssignmentId;
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

async function countRecoveredOutcomeEvents(
  store: RuntimeStore,
  assignmentId: string,
  eventType: "result.submitted" | "decision.created"
): Promise<number> {
  const events = await store.loadEvents();
  if (eventType === "result.submitted") {
    return events.filter(
      (event) => event.type === "result.submitted" && event.payload.result.assignmentId === assignmentId
    ).length;
  }
  return events.filter(
    (event) => event.type === "decision.created" && event.payload.decision.assignmentId === assignmentId
  ).length;
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

function completedDecisionRecord(
  assignmentId: string,
  blockerSummary: string
): HostRunRecord {
  const createdAt = nowIso();
  return {
    assignmentId,
    state: "completed",
    startedAt: createdAt,
    completedAt: createdAt,
    outcomeKind: "decision",
    summary: blockerSummary,
    adapterData: { nativeRunId: `native-${assignmentId}` },
    terminalOutcome: {
      kind: "decision",
      decision: {
        decisionId: randomUUID(),
        requesterId: "matrix-host",
        blockerSummary,
        options: [
          { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
          { id: "skip", label: "Skip", summary: "Skip the blocked work." }
        ],
        recommendedOption: "wait",
        state: "open",
        createdAt
      }
    }
  };
}
