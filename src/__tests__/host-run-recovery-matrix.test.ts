import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { materializeInspectableRunRecord } from "../adapters/host-run-inspection.js";
import { HostRunStore, type HostRunArtifactPaths } from "../adapters/host-run-store.js";
import { buildCompletedRunRecord } from "../adapters/host-run-records.js";
import type { RuntimeConfig } from "../config/types.js";
import { createBootstrapRuntime } from "../core/runtime.js";
import type { RuntimeEvent } from "../core/events.js";
import type { DecisionPacket, HostRunRecord, RecoveryBrief, ResultPacket, RuntimeProjection } from "../core/types.js";
import { RuntimeStore } from "../persistence/store.js";
import { loadOperatorProjection, loadOperatorProjectionWithDiagnostics } from "../cli/runtime-state.js";
import { getRunnableAssignment } from "../cli/run-operations.js";
import { reconcileActiveRuns } from "../cli/run-reconciliation.js";
import { fromSnapshot, toSnapshot } from "../projections/runtime-projection.js";
import {
  loadReconciledProjectionWithDiagnostics,
  prepareResumeRuntime,
  resumeRuntime,
  runRuntime
} from "../cli/commands.js";
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
      name: "stale lease artifact without a run record is reconciled into a queued retry",
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
        assert.equal(
          result.projection.status.currentObjective,
          "Need operator confirmation before proceeding."
        );
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
      name: "authoritative active lease blocks a run when runtime status drifts to a different assignment",
      run: async () => {
        const artifacts: HostRunArtifactPaths = {
          runRecordPath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.json`,
          runLeasePath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.lease.json`,
          lastRunPath: () => "adapters/matrix/last-run.json"
        };
        const adapter = new ExecutionSentinelMatrixAdapter(artifacts);
        const ctx = await createMatrixContext(adapter);
        const driftedAssignmentId = await appendActiveAssignment(ctx);
        const driftTimestamp = nowIso();

        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp: driftTimestamp,
          type: "status.updated",
          payload: {
            status: {
              ...ctx.projection.status,
              activeAssignmentIds: [driftedAssignmentId],
              currentObjective: "Run the drifted assignment.",
              lastDurableOutputAt: driftTimestamp
            }
          }
        });
        await ctx.store.syncSnapshotFromEvents();
        ctx.projection = await loadOperatorProjection(ctx.store);

        await ctx.adapter.claimRunLease(
          ctx.store,
          ctx.projection,
          ctx.assignmentId,
          runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z")
        );

        await assert.rejects(
          runRuntime(ctx.store, ctx.adapter),
          new RegExp(`Assignment ${ctx.assignmentId} already has an active host run lease\\.`)
        );

        const authoritativeRun = await ctx.adapter.inspectRun(ctx.store);
        const driftedRun = await ctx.adapter.inspectRun(ctx.store, driftedAssignmentId);
        assert.equal(authoritativeRun?.assignmentId, ctx.assignmentId);
        assert.equal(authoritativeRun?.state, "running");
        assert.equal(driftedRun, undefined);
        assert.equal(adapter.buildResumeEnvelopeCount, 0);
        assert.equal(adapter.executeAssignmentCount, 0);
      }
    },
    {
      name: "valid active lease still blocks a run when last-run points at an unrelated completed assignment",
      run: async () => {
        const artifacts: HostRunArtifactPaths = {
          runRecordPath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.json`,
          runLeasePath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.lease.json`,
          lastRunPath: () => "adapters/matrix/last-run.json"
        };
        const adapter = new ExecutionSentinelMatrixAdapter(artifacts);
        const ctx = await createMatrixContext(adapter);
        const runnableAssignmentId = await appendActiveAssignment(ctx);
        const unrelatedCompletedAssignmentId = await appendActiveAssignment(ctx);
        const driftTimestamp = nowIso();

        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp: driftTimestamp,
          type: "status.updated",
          payload: {
            status: {
              ...ctx.projection.status,
              activeAssignmentIds: [runnableAssignmentId],
              currentObjective: "Run the drifted assignment.",
              lastDurableOutputAt: driftTimestamp
            }
          }
        });
        await ctx.store.syncSnapshotFromEvents();
        ctx.projection = await loadOperatorProjection(ctx.store);

        await ctx.adapter.claimRunLease(
          ctx.store,
          ctx.projection,
          ctx.assignmentId,
          runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z")
        );
        await ctx.adapter.runStore.write(
          completedResultRecord(
            unrelatedCompletedAssignmentId,
            "completed",
            "Unrelated completed run should not bypass lease detection."
          )
        );

        await assert.rejects(
          runRuntime(ctx.store, ctx.adapter),
          new RegExp(`Assignment ${ctx.assignmentId} already has an active host run lease\\.`)
        );

        const authoritativeRun = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);
        const pointedRun = await ctx.adapter.inspectRun(ctx.store);
        assert.equal(authoritativeRun?.assignmentId, ctx.assignmentId);
        assert.equal(authoritativeRun?.state, "running");
        assert.equal(pointedRun?.assignmentId, unrelatedCompletedAssignmentId);
        assert.equal(pointedRun?.state, "completed");
        assert.equal(adapter.buildResumeEnvelopeCount, 0);
        assert.equal(adapter.executeAssignmentCount, 0);
      }
    },
    {
      name: "snapshot fallback still blocks a run when a hidden assignment keeps a valid active lease",
      run: async () => {
        const artifacts: HostRunArtifactPaths = {
          runRecordPath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.json`,
          runLeasePath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.lease.json`,
          lastRunPath: () => "adapters/matrix/last-run.json"
        };
        const adapter = new ExecutionSentinelMatrixAdapter(artifacts);
        const ctx = await createMatrixContext(adapter);
        await ctx.store.syncSnapshotFromEvents();
        const hiddenAssignmentId = await appendAssignmentBeyondSnapshotBoundary(ctx);
        await corruptSnapshotBoundary(ctx.store);
        await ctx.adapter.claimRunLease(
          ctx.store,
          ctx.projection,
          hiddenAssignmentId,
          runningRecord(hiddenAssignmentId, "2999-04-11T10:00:30.000Z")
        );

        const loaded = await loadOperatorProjectionWithDiagnostics(ctx.store);
        assert.equal(loaded.snapshotFallback, true);
        const reconciled = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);

        assert.deepEqual(reconciled.hiddenActiveLeases, [hiddenAssignmentId]);
        assert.ok(
          reconciled.diagnostics.some(
            (diagnostic) =>
              diagnostic.code === "active-run-present" &&
              diagnostic.message.includes(hiddenAssignmentId)
          )
        );
        await assert.rejects(
          resumeRuntime(ctx.store, ctx.adapter),
          new RegExp(`Assignment ${hiddenAssignmentId} already has an active host run lease\\.`)
        );
        await assert.rejects(
          runRuntime(ctx.store, ctx.adapter),
          new RegExp(`Assignment ${hiddenAssignmentId} already has an active host run lease\\.`)
        );
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
        let blockedRunFailure: unknown;
        let firstRunFailure: unknown;
        let result: Awaited<ReturnType<typeof runRuntime>> | undefined;
        try {
          await waitFor(async () => (await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId))?.state === "running");
          await assert.rejects(
            runRuntime(ctx.store, ctx.adapter),
            /(already has an active host run lease|is already claimed by authoritative attachment)/
          );
        } catch (error) {
          blockedRunFailure = error;
        } finally {
          adapter.releaseRun();
          try {
            result = await firstRun;
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
        assert.ok(result);

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
      name: "status path reconciles a stale lease artifact before reporting work",
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
        assert.equal(
          result.projection.status.currentObjective,
          "Need operator confirmation before proceeding."
        );
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
      name: "status path preserves durable runtime results when only degraded completed host metadata remains",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        const timestamp = nowIso();
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp,
          type: "result.submitted",
          payload: {
            result: {
              resultId: randomUUID(),
              assignmentId: ctx.assignmentId,
              producerId: "matrix-host",
              status: "completed",
              summary: "Durable runtime result must not be requeued.",
              changedFiles: [],
              createdAt: timestamp
            }
          }
        });
        await ctx.store.syncSnapshotFromEvents();
        await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, {
          assignmentId: ctx.assignmentId,
          state: "completed",
          startedAt: timestamp,
          completedAt: timestamp,
          staleAt: timestamp,
          staleReasonCode: "missing_lease_artifact",
          staleReason: "Run record remained in running state without an active lease artifact.",
          adapterData: { nativeRunId: `native-${ctx.assignmentId}` }
        });
        await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", {
          assignmentId: ctx.assignmentId,
          state: "completed",
          startedAt: timestamp,
          completedAt: timestamp,
          staleAt: timestamp,
          staleReasonCode: "missing_lease_artifact",
          staleReason: "Run record remained in running state without an active lease artifact.",
          adapterData: { nativeRunId: `native-${ctx.assignmentId}` }
        });

        const result = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);

        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "completed");
        assert.deepEqual(result.projection.status.activeAssignmentIds, []);
        assert.equal(result.projection.results.size, 1);
        assert.equal(
          [...result.projection.results.values()].at(-1)?.summary,
          "Durable runtime result must not be requeued."
        );
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.terminalOutcome, undefined);
        assert.equal(inspected?.staleReasonCode, "missing_lease_artifact");
      }
    },
    {
      name: "status path preserves durable runtime results when only a malformed leftover lease remains",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        const timestamp = nowIso();
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp,
          type: "result.submitted",
          payload: {
            result: {
              resultId: randomUUID(),
              assignmentId: ctx.assignmentId,
              producerId: "matrix-host",
              status: "completed",
              summary: "Durable runtime result must clear malformed leftover leases.",
              changedFiles: [],
              createdAt: timestamp
            }
          }
        });
        await ctx.store.syncSnapshotFromEvents();
        await ctx.store.writeTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "{");

        const result = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);

        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "completed");
        assert.deepEqual(result.projection.status.activeAssignmentIds, []);
        assert.equal(result.projection.results.size, 1);
        assert.equal(
          [...result.projection.results.values()].at(-1)?.summary,
          "Durable runtime result must clear malformed leftover leases."
        );
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.terminalOutcome?.kind, "result");
        assert.equal(inspected?.staleReasonCode, "malformed_lease_artifact");
        assert.equal(inspected?.staleReason, "malformed lease file");
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
      }
    },
    {
      name: "status path preserves durable runtime decisions behind a malformed leftover lease",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        const timestamp = nowIso();
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp,
          type: "decision.created",
          payload: {
            decision: {
              decisionId: randomUUID(),
              assignmentId: ctx.assignmentId,
              requesterId: "matrix-host",
              blockerSummary: "Durable runtime decision must clear malformed leftover leases.",
              options: [
                { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
                { id: "skip", label: "Skip", summary: "Skip the blocked work." }
              ],
              recommendedOption: "wait",
              state: "open",
              createdAt: timestamp
            }
          }
        });
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp,
          type: "assignment.updated",
          payload: {
            assignmentId: ctx.assignmentId,
            patch: {
              state: "blocked",
              updatedAt: timestamp
            }
          }
        });
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp,
          type: "status.updated",
          payload: {
            status: {
              ...ctx.projection.status,
              activeAssignmentIds: [ctx.assignmentId],
              currentObjective: "Resolve the recovered decision before continuing.",
              lastDurableOutputAt: timestamp,
              resumeReady: true
            }
          }
        });
        await ctx.store.syncSnapshotFromEvents();
        await ctx.store.writeTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "{");

        const result = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);

        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "blocked");
        assert.deepEqual(result.projection.status.activeAssignmentIds, [ctx.assignmentId]);
        assert.equal(
          result.projection.status.currentObjective,
          "Resolve the recovered decision before continuing."
        );
        assert.equal(result.projection.decisions.size, 1);
        assert.equal(
          [...result.projection.decisions.values()].at(-1)?.blockerSummary,
          "Durable runtime decision must clear malformed leftover leases."
        );
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.terminalOutcome?.kind, "decision");
        assert.equal(inspected?.staleReasonCode, "malformed_lease_artifact");
        assert.equal(inspected?.staleReason, "malformed lease file");
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
      }
    },
    {
      name: "status path reconciles stale leases for non-active assignments while the drifted assignment stays active",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        const driftedAssignmentId = await appendActiveAssignment(ctx);
        const timestamp = nowIso();
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp,
          type: "status.updated",
          payload: {
            status: {
              ...ctx.projection.status,
              activeAssignmentIds: [driftedAssignmentId],
              currentObjective: "Run the drifted assignment.",
              lastDurableOutputAt: timestamp
            }
          }
        });
        await ctx.store.syncSnapshotFromEvents();

        const staleRecord = runningRecord(ctx.assignmentId, "2000-01-01T00:00:00.000Z");
        await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, staleRecord);
        await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, staleRecord);
        await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", staleRecord);

        const result = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);

        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "queued");
        assert.equal(result.projection.assignments.get(driftedAssignmentId)?.state, "queued");
        assert.deepEqual(result.projection.status.activeAssignmentIds, [driftedAssignmentId]);
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.staleReasonCode, "expired_lease");
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
      }
    },
    {
      name: "status path recovers durable completed runs for non-active assignments while the drifted assignment stays active",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        const driftedAssignmentId = await appendActiveAssignment(ctx);
        const timestamp = nowIso();
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp,
          type: "status.updated",
          payload: {
            status: {
              ...ctx.projection.status,
              activeAssignmentIds: [driftedAssignmentId],
              currentObjective: "Run the drifted assignment.",
              lastDurableOutputAt: timestamp
            }
          }
        });
        await ctx.store.syncSnapshotFromEvents();
        await ctx.adapter.runStore.write(
          completedResultRecord(ctx.assignmentId, "completed", "Recovered non-active completed result.")
        );

        const result = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);
        const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);

        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "completed");
        assert.equal(result.projection.assignments.get(driftedAssignmentId)?.state, "queued");
        assert.deepEqual(result.projection.status.activeAssignmentIds, [driftedAssignmentId]);
        assert.equal(
          [...result.projection.results.values()].find((candidate) => candidate.assignmentId === ctx.assignmentId)?.summary,
          "Recovered non-active completed result."
        );
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.terminalOutcome?.kind, "result");
      }
    },
    {
      name: "status path leaves hidden completed runs out of projection when the snapshot boundary is unusable",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        await ctx.store.syncSnapshotFromEvents();
        const hiddenAssignmentId = await appendAssignmentBeyondSnapshotBoundary(ctx);
        await ctx.adapter.runStore.write(
          completedResultRecord(hiddenAssignmentId, "completed", "Recovered hidden snapshot-fallback result.")
        );
        await corruptSnapshotBoundary(ctx.store);

        const loaded = await loadOperatorProjectionWithDiagnostics(ctx.store);
        assert.equal(loaded.snapshotFallback, true);

        const result = await reconcileActiveRuns(ctx.store, ctx.adapter, loaded.projection, {
          snapshotFallback: loaded.snapshotFallback
        });
        const inspected = await ctx.adapter.inspectRun(ctx.store, hiddenAssignmentId);

        assert.equal(result.projection.assignments.has(hiddenAssignmentId), false);
        assert.deepEqual(result.projection.status.activeAssignmentIds, [ctx.assignmentId]);
        assert.equal(
          [...result.projection.results.values()].find((candidate) => candidate.assignmentId === hiddenAssignmentId),
          undefined
        );
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.terminalOutcome?.kind, "result");
      }
    },
    {
      name: "snapshot-fallback stale cleanup does not hydrate assignments from pre-boundary events behind a later boundary",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        const degradedAssignmentId = randomUUID();
        const createdAt = new Date(Date.now() + 1_000).toISOString();
        const laterBoundaryAt = new Date(Date.now() + 2_000).toISOString();
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp: createdAt,
          type: "assignment.created",
          payload: {
            assignment: {
              id: degradedAssignmentId,
              parentTaskId: "task-pre-boundary-hidden-assignment",
              workflow: "milestone-2",
              ownerType: "host",
              ownerId: "matrix",
              objective: "Pre-boundary assignment that should stay absent during fallback.",
              writeScope: ["README.md"],
              requiredOutputs: ["result"],
              state: "queued",
              createdAt,
              updatedAt: createdAt
            }
          }
        });
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp: laterBoundaryAt,
          type: "assignment.updated",
          payload: {
            assignmentId: ctx.assignmentId,
            patch: {
              updatedAt: laterBoundaryAt
            }
          }
        });
        await ctx.store.syncSnapshotFromEvents();
        await removeAssignmentFromSnapshot(ctx.store, degradedAssignmentId);
        await ctx.adapter.runStore.write(runningRecord(degradedAssignmentId, "2000-01-01T00:00:00.000Z"));
        await corruptSnapshotBoundary(ctx.store);

        const loaded = await loadOperatorProjectionWithDiagnostics(ctx.store);
        assert.equal(loaded.snapshotFallback, true);

        const result = await reconcileActiveRuns(ctx.store, ctx.adapter, loaded.projection, {
          snapshotFallback: loaded.snapshotFallback
        });
        const repairedSnapshot = await ctx.store.loadSnapshot();
        const inspected = await ctx.adapter.inspectRun(ctx.store, degradedAssignmentId);

        assert.equal(result.projection.assignments.has(degradedAssignmentId), false);
        assert.equal(
          repairedSnapshot?.assignments.some((assignment) => assignment.id === degradedAssignmentId),
          false
        );
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.staleReasonCode, "expired_lease");
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${degradedAssignmentId}.lease.json`, "matrix lease"),
          undefined
        );
      }
    },
    {
      name: "snapshot-fallback stale hidden runs are cleaned without hydrating when boundary proof is unusable",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        await ctx.store.syncSnapshotFromEvents();
        const hiddenAssignmentId = await appendAssignmentBeyondSnapshotBoundary(ctx);
        await ctx.adapter.runStore.write(runningRecord(hiddenAssignmentId, "2000-01-01T00:00:00.000Z"));
        await corruptSnapshotBoundary(ctx.store);

        const loaded = await loadOperatorProjectionWithDiagnostics(ctx.store);
        assert.equal(loaded.snapshotFallback, true);

        const result = await reconcileActiveRuns(ctx.store, ctx.adapter, loaded.projection, {
          snapshotFallback: loaded.snapshotFallback
        });
        const inspected = await ctx.adapter.inspectRun(ctx.store, hiddenAssignmentId);
        const snapshot = await ctx.store.loadSnapshot();

        assert.equal(result.projection.assignments.has(hiddenAssignmentId), false);
        assert.equal(snapshot?.assignments.some((assignment) => assignment.id === hiddenAssignmentId), false);
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "active-run-present"));
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.staleReasonCode, "expired_lease");
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${hiddenAssignmentId}.lease.json`, "matrix lease"),
          undefined
        );
      }
    },
    {
      name: "snapshot-fallback stale repair preserves snapshot-owned assignments and status",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        const relatedAssignmentId = await appendActiveAssignment(ctx);
        await ctx.adapter.runStore.write(runningRecord(ctx.assignmentId, "2000-01-01T00:00:00.000Z"));
        await corruptSnapshotBoundary(ctx.store);

        const loaded = await loadOperatorProjectionWithDiagnostics(ctx.store);
        assert.equal(loaded.snapshotFallback, true);

        const result = await reconcileActiveRuns(ctx.store, ctx.adapter, loaded.projection, {
          snapshotFallback: loaded.snapshotFallback
        });
        const snapshot = await ctx.store.loadSnapshot();

        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "queued");
        assert.equal(result.projection.assignments.get(relatedAssignmentId)?.state, "queued");
        assert.deepEqual(result.projection.status.activeAssignmentIds, [ctx.assignmentId, relatedAssignmentId]);
        assert.equal(
          result.projection.status.currentObjective,
          `Retry assignment ${ctx.assignmentId}: ${ctx.projection.assignments.get(ctx.assignmentId)?.objective}`
        );
        assert.equal(snapshot?.assignments.find((assignment) => assignment.id === ctx.assignmentId)?.state, "queued");
        assert.equal(snapshot?.assignments.find((assignment) => assignment.id === relatedAssignmentId)?.state, "queued");
        assert.deepEqual(snapshot?.status.activeAssignmentIds, [ctx.assignmentId, relatedAssignmentId]);
        assert.equal(
          snapshot?.status.currentObjective,
          `Retry assignment ${ctx.assignmentId}: ${ctx.projection.assignments.get(ctx.assignmentId)?.objective}`
        );
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
      }
    },
    {
      name: "snapshot-fallback malformed hidden leases are cleaned without hydrating when boundary proof is unusable",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        await ctx.store.syncSnapshotFromEvents();
        const hiddenAssignmentId = await appendAssignmentBeyondSnapshotBoundary(ctx);
        await ctx.store.writeTextArtifact(
          `adapters/matrix/runs/${hiddenAssignmentId}.lease.json`,
          "{\"broken\":\n"
        );
        await corruptSnapshotBoundary(ctx.store);

        const loaded = await loadOperatorProjectionWithDiagnostics(ctx.store);
        assert.equal(loaded.snapshotFallback, true);

        const result = await reconcileActiveRuns(ctx.store, ctx.adapter, loaded.projection, {
          snapshotFallback: loaded.snapshotFallback
        });
        const inspected = await ctx.adapter.inspectRun(ctx.store, hiddenAssignmentId);

        assert.equal(result.projection.assignments.has(hiddenAssignmentId), false);
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "active-run-present"));
        assert.equal(inspected?.state, "completed");
        assert.equal(inspected?.staleReasonCode, "malformed_lease_artifact");
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${hiddenAssignmentId}.lease.json`, "matrix lease"),
          undefined
        );
      }
    },
    {
      name: "snapshot-fallback completed-run repair preserves snapshot-owned assignments and status",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        const relatedAssignmentId = await appendActiveAssignment(ctx);
        const timestamp = nowIso();
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp,
          type: "status.updated",
          payload: {
            status: {
              ...ctx.projection.status,
              activeAssignmentIds: [ctx.assignmentId, relatedAssignmentId],
              currentObjective: "Continue visible work while the second assignment stays queued.",
              lastDurableOutputAt: timestamp
            }
          }
        });
        await ctx.store.syncSnapshotFromEvents();
        await ctx.adapter.runStore.write(
          completedResultRecord(ctx.assignmentId, "completed", "Recovered snapshot-fallback result.")
        );
        await corruptSnapshotBoundary(ctx.store);

        const loaded = await loadOperatorProjectionWithDiagnostics(ctx.store);
        assert.equal(loaded.snapshotFallback, true);

        const result = await reconcileActiveRuns(ctx.store, ctx.adapter, loaded.projection, {
          snapshotFallback: loaded.snapshotFallback
        });
        const snapshot = await ctx.store.loadSnapshot();

        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "completed");
        assert.equal(result.projection.assignments.get(relatedAssignmentId)?.state, "queued");
        assert.deepEqual(result.projection.status.activeAssignmentIds, [relatedAssignmentId]);
        assert.equal(
          result.projection.status.currentObjective,
          "Continue visible work while the second assignment stays queued."
        );
        assert.equal(snapshot?.assignments.find((assignment) => assignment.id === ctx.assignmentId)?.state, "completed");
        assert.equal(snapshot?.assignments.find((assignment) => assignment.id === relatedAssignmentId)?.state, "queued");
        assert.deepEqual(snapshot?.status.activeAssignmentIds, [relatedAssignmentId]);
        assert.equal(
          snapshot?.status.currentObjective,
          "Continue visible work while the second assignment stays queued."
        );
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
      }
    },
    {
      name: "status path hydrates snapshot-fallback decisions before runnable selection",
      run: async () => {
        const adapter = new BriefingMatrixAdapter();
        const ctx = await createMatrixContext(adapter);
        await ctx.store.syncSnapshotFromEvents();
        const record = completedDecisionRecord(ctx.assignmentId, "Need operator confirmation before proceeding.");
        assert.equal(record.terminalOutcome?.kind, "decision");
        const decision = record.terminalOutcome.decision;
        await ctx.adapter.runStore.write(record);
        const recoveryTimestamp = decision.createdAt;
        for (const event of [
          {
            eventId: randomUUID(),
            sessionId: ctx.projection.sessionId,
            timestamp: recoveryTimestamp,
            type: "decision.created" as const,
            payload: {
              decision: {
                decisionId: decision.decisionId ?? randomUUID(),
                assignmentId: ctx.assignmentId,
                requesterId: decision.requesterId,
                blockerSummary: decision.blockerSummary,
                options: decision.options.map((option) => ({ ...option })),
                recommendedOption: decision.recommendedOption,
                state: decision.state,
                createdAt: decision.createdAt
              }
            }
          },
          {
            eventId: randomUUID(),
            sessionId: ctx.projection.sessionId,
            timestamp: recoveryTimestamp,
            type: "assignment.updated" as const,
            payload: {
              assignmentId: ctx.assignmentId,
              patch: {
                state: "blocked" as const,
                updatedAt: recoveryTimestamp
              }
            }
          },
          {
            eventId: randomUUID(),
            sessionId: ctx.projection.sessionId,
            timestamp: recoveryTimestamp,
            type: "status.updated" as const,
            payload: {
              status: {
                ...ctx.projection.status,
                activeAssignmentIds: [ctx.assignmentId],
                currentObjective: "Resolve the recovered decision before continuing.",
                lastDurableOutputAt: recoveryTimestamp
              }
            }
          }
        ]) {
          await ctx.store.appendEvent(event);
        }
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp: nowIso(),
          type: "assignment.updated",
          payload: {
            assignmentId: randomUUID(),
            patch: {
              state: "queued",
              updatedAt: nowIso()
            }
          }
        });

        const loaded = await loadOperatorProjectionWithDiagnostics(ctx.store);
        assert.equal(loaded.snapshotFallback, true);

        const result = await reconcileActiveRuns(ctx.store, ctx.adapter, loaded.projection, {
          snapshotFallback: loaded.snapshotFallback
        });

        assert.equal(result.projection.assignments.get(ctx.assignmentId)?.state, "blocked");
        assert.equal(result.projection.decisions.size, 1);
        assert.equal([...result.projection.decisions.values()][0]?.state, "open");
        assert.equal(
          result.projection.status.currentObjective,
          "Resolve the recovered decision before continuing."
        );
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.throws(
          () => getRunnableAssignment(result.projection),
          /is blocked and cannot be run|Resolve decision/
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
      name: "run path surfaces a recovered completed result instead of rerun error",
      run: async () => {
        const adapter = new ExecutionSentinelMatrixAdapter({
          runRecordPath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.json`,
          runLeasePath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.lease.json`,
          lastRunPath: () => "adapters/matrix/last-run.json"
        });
        const ctx = await createMatrixContext(adapter);
        await ctx.adapter.runStore.write(
          completedResultRecord(ctx.assignmentId, "completed", "Recovered completed result.")
        );
        await ctx.store.writeJsonArtifact(
          `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
          runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z")
        );

        const run = await runRuntime(ctx.store, ctx.adapter);

        assert.equal(run.assignment.id, ctx.assignmentId);
        assert.equal(run.execution.outcome.kind, "result");
        assert.equal(run.execution.outcome.capture.status, "completed");
        assert.equal(run.execution.outcome.capture.summary, "Recovered completed result.");
        assert.equal(run.projectionBefore.assignments.get(ctx.assignmentId)?.state, "completed");
        assert.equal(run.projectionAfter.assignments.get(ctx.assignmentId)?.state, "completed");
        assert.deepEqual(run.projectionAfter.status.activeAssignmentIds, []);
        assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.equal(adapter.buildResumeEnvelopeCount, 0);
        assert.equal(adapter.executeAssignmentCount, 0);
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
      }
    },
    {
      name: "run path surfaces a recovered completed decision instead of blocked rerun error",
      run: async () => {
        const adapter = new ExecutionSentinelMatrixAdapter({
          runRecordPath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.json`,
          runLeasePath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.lease.json`,
          lastRunPath: () => "adapters/matrix/last-run.json"
        });
        const ctx = await createMatrixContext(adapter);
        await ctx.adapter.runStore.write(
          completedDecisionRecord(ctx.assignmentId, "Need operator confirmation before proceeding.")
        );
        await ctx.store.writeJsonArtifact(
          `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
          runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z")
        );

        const run = await runRuntime(ctx.store, ctx.adapter);

        assert.equal(run.assignment.id, ctx.assignmentId);
        assert.equal(run.execution.outcome.kind, "decision");
        assert.equal(run.execution.outcome.capture.blockerSummary, "Need operator confirmation before proceeding.");
        assert.equal(run.execution.outcome.capture.recommendedOption, "wait");
        assert.equal(run.projectionBefore.assignments.get(ctx.assignmentId)?.state, "blocked");
        assert.equal(run.projectionAfter.assignments.get(ctx.assignmentId)?.state, "blocked");
        assert.deepEqual(run.projectionAfter.status.activeAssignmentIds, [ctx.assignmentId]);
        assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
        assert.equal(adapter.buildResumeEnvelopeCount, 0);
        assert.equal(adapter.executeAssignmentCount, 0);
        assert.equal(
          await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
          undefined
        );
      }
    },
    {
      name: "run path keeps the active blocked error ahead of unrelated recovered results",
      run: async () => {
        const adapter = new ExecutionSentinelMatrixAdapter({
          runRecordPath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.json`,
          runLeasePath: (assignmentId) => `adapters/matrix/runs/${assignmentId}.lease.json`,
          lastRunPath: () => "adapters/matrix/last-run.json"
        });
        const ctx = await createMatrixContext(adapter);
        const recoveredAssignmentId = await appendActiveAssignment(ctx);
        const timestamp = nowIso();

        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp,
          type: "assignment.updated",
          payload: {
            assignmentId: ctx.assignmentId,
            patch: {
              state: "blocked",
              updatedAt: timestamp
            }
          }
        });
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp,
          type: "decision.created",
          payload: {
            decision: {
              decisionId: randomUUID(),
              assignmentId: ctx.assignmentId,
              requesterId: "matrix-host",
              blockerSummary: "Need input before continuing the active assignment.",
              options: [{ id: "wait", label: "Wait", summary: "Pause until guidance arrives." }],
              recommendedOption: "wait",
              state: "open",
              createdAt: timestamp
            }
          }
        });
        await ctx.store.appendEvent({
          eventId: randomUUID(),
          sessionId: ctx.projection.sessionId,
          timestamp,
          type: "status.updated",
          payload: {
            status: {
              ...ctx.projection.status,
              activeAssignmentIds: [ctx.assignmentId],
              currentObjective: "Resolve the active blocked assignment first.",
              lastDurableOutputAt: timestamp
            }
          }
        });
        await ctx.store.syncSnapshotFromEvents();
        await ctx.adapter.runStore.write(
          completedResultRecord(recoveredAssignmentId, "completed", "Recovered hidden completed result.")
        );

        await assert.rejects(
          runRuntime(ctx.store, ctx.adapter),
          /Assignment .* is blocked and cannot be run\. Resolve decision .* first\./
        );
        assert.equal(adapter.buildResumeEnvelopeCount, 0);
        assert.equal(adapter.executeAssignmentCount, 0);
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

test("host-run command matrix keeps prepareResumeRuntime read-only while reconciled entrypoints keep active leases host-owned", async () => {
  const adapter = new BriefingMatrixAdapter();
  const ctx = await createMatrixContext(adapter);
  const record = runningRecord(ctx.assignmentId, "2999-04-11T10:00:30.000Z");
  await adapter.claimRunLease(ctx.store, ctx.projection, ctx.assignmentId, record);

  const projectionBefore = await loadOperatorProjection(ctx.store);
  const telemetryBefore = await ctx.store.loadTelemetry();
  const prepared = await prepareResumeRuntime(ctx.store, adapter);
  const projectionAfterPrepare = await loadOperatorProjection(ctx.store);
  const reconciled = await loadReconciledProjectionWithDiagnostics(ctx.store, adapter);
  const telemetryAfter = await ctx.store.loadTelemetry();
  const persistedEnvelope = await ctx.store.readJsonArtifact(
    "runtime/last-resume-envelope.json",
    "resume envelope"
  );

  assert.equal(prepared.envelope.metadata.activeAssignmentId, ctx.assignmentId);
  assert.equal(prepared.projection.attachments.size, 0);
  assert.equal(prepared.projection.claims.size, 0);
  assert.equal(projectionBefore.attachments.size, 0);
  assert.equal(projectionBefore.claims.size, 0);
  assert.equal(projectionAfterPrepare.attachments.size, 0);
  assert.equal(projectionAfterPrepare.claims.size, 0);
  assert.equal(adapter.lastBuildProjection?.attachments.size, 0);
  assert.equal(adapter.lastBuildProjection?.claims?.size ?? 0, 0);
  assert.equal(telemetryAfter.length, telemetryBefore.length);
  assert.equal(persistedEnvelope, undefined);
  assert.ok(reconciled.diagnostics.some((diagnostic) => diagnostic.code === "active-run-present"));
  assert.equal(reconciled.projection.attachments.size, 0);
  assert.equal(reconciled.projection.claims.size, 0);
  assert.deepEqual(reconciled.activeLeases, [ctx.assignmentId]);
});

test("host-run command matrix rejects ambiguous resumable attachments during read-only resume preparation", async () => {
  const adapter = new ReclaimFailureMatrixAdapter();
  const ctx = await createMatrixContext(adapter);
  const secondAssignmentId = await appendActiveAssignment(ctx);

  await appendDetachedResumableAttachmentClaim(ctx, ctx.assignmentId);
  await appendDetachedResumableAttachmentClaim(ctx, secondAssignmentId);

  await assert.rejects(
    prepareResumeRuntime(ctx.store, adapter),
    /multiple resumable attachments are present/
  );

  const loaded = await loadOperatorProjection(ctx.store);
  assert.equal(loaded.attachments.size, 2);
  assert.equal(loaded.claims.size, 2);
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

  const originalAppendEvents = ctx.store.appendEvents.bind(ctx.store);
  let failedStatusUpdate = false;
  (ctx.store as RuntimeStore & {
    appendEvents: RuntimeStore["appendEvents"];
  }).appendEvents = async (events) => {
    if (
      !failedStatusUpdate &&
      events.length === 2 &&
      events[0]?.type === "assignment.updated" &&
      events[1]?.type === "status.updated"
    ) {
      failedStatusUpdate = true;
      throw new Error("simulated stale-run status persistence failure");
    }
    await originalAppendEvents(events);
  };

  await assert.rejects(
    reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection),
    /simulated stale-run status persistence failure/
  );

  (ctx.store as RuntimeStore & {
    appendEvents: RuntimeStore["appendEvents"];
  }).appendEvents = originalAppendEvents;

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

  assert.equal(interrupted.projection.assignments.get(ctx.assignmentId)?.state, "in_progress");
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

test("host-run recovery matrix uses snapshot truth when stale recovery lines become malformed", async () => {
  const ctx = await createMatrixContext();
  const staleRecord = runningRecord(ctx.assignmentId, "2000-01-01T00:00:00.000Z");
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, staleRecord);
  await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", staleRecord);
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, staleRecord);

  const originalReconcileStaleRun = ctx.adapter.reconcileStaleRun.bind(ctx.adapter);
  let reconcileAttempts = 0;
  ctx.adapter.reconcileStaleRun = async (store, record) => {
    reconcileAttempts += 1;
    if (reconcileAttempts === 1) {
      throw new Error("simulated stale cleanup failure");
    }
    await originalReconcileStaleRun(store, record);
  };

  await assert.rejects(
    reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection),
    /Host run reconciliation failed to clear the active lease for assignment/
  );

  const repairedSnapshot = await ctx.store.loadSnapshot();
  assert.equal(repairedSnapshot?.assignments.find((assignment) => assignment.id === ctx.assignmentId)?.state, "queued");
  assert.match(
    repairedSnapshot?.status.currentObjective ?? "",
    new RegExp(`^Retry assignment ${ctx.assignmentId}:`)
  );

  const eventLines = (await readFile(ctx.store.eventsPath, "utf8")).trimEnd().split("\n");
  eventLines[eventLines.length - 2] = "{\"broken\":";
  eventLines[eventLines.length - 1] = "{\"broken\":";
  await writeFile(ctx.store.eventsPath, `${eventLines.join("\n")}\n`, "utf8");

  const loaded = await loadOperatorProjectionWithDiagnostics(ctx.store);
  assert.equal(loaded.snapshotFallback, true);

  const retried = await reconcileActiveRuns(ctx.store, ctx.adapter, loaded.projection, {
    snapshotFallback: loaded.snapshotFallback
  });
  const replayable = await ctx.store.loadReplayableEvents();
  const replayableQueuedTransitionCount = replayable.events.filter(
    (event) =>
      event.type === "assignment.updated" &&
      event.payload.assignmentId === ctx.assignmentId &&
      event.payload.patch.state === "queued"
  ).length;
  const replayableStatusCount = replayable.events.filter(
    (event) =>
      event.type === "status.updated" &&
      event.payload.status.currentObjective.startsWith(`Retry assignment ${ctx.assignmentId}:`)
  ).length;

  assert.equal(reconcileAttempts, 2);
  assert.equal(retried.projection.assignments.get(ctx.assignmentId)?.state, "queued");
  assert.match(
    retried.projection.status.currentObjective,
    new RegExp(`^Retry assignment ${ctx.assignmentId}:`)
  );
  assert.ok(!retried.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(replayableQueuedTransitionCount, 0);
  assert.equal(replayableStatusCount, 0);
  assert.equal(
    await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
    undefined
  );
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

  const originalAppendEvents = ctx.store.appendEvents.bind(ctx.store);
  let failedStatusUpdate = false;
  (ctx.store as RuntimeStore & {
    appendEvents: RuntimeStore["appendEvents"];
  }).appendEvents = async (events) => {
    if (
      !failedStatusUpdate &&
      events.some((event) => event.type === "result.submitted") &&
      events.some((event) => event.type === "status.updated")
    ) {
      failedStatusUpdate = true;
      throw new Error("simulated completed-run status persistence failure");
    }
    await originalAppendEvents(events);
  };

  await assert.rejects(
    reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection),
    /simulated completed-run status persistence failure/
  );

  (ctx.store as RuntimeStore & {
    appendEvents: RuntimeStore["appendEvents"];
  }).appendEvents = originalAppendEvents;

  const interrupted = await ctx.store.syncSnapshotFromEventsWithRecovery();
  const firstEventCount = await countRecoveredOutcomeEvents(ctx.store, ctx.assignmentId, "result.submitted");
  const recovered = await reconcileActiveRuns(ctx.store, ctx.adapter, interrupted.projection);
  const secondEventCount = await countRecoveredOutcomeEvents(ctx.store, ctx.assignmentId, "result.submitted");

  assert.equal(firstEventCount, 0);
  assert.equal(secondEventCount, 1);
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

  const originalAppendEvents = ctx.store.appendEvents.bind(ctx.store);
  let failedAssignmentUpdate = false;
  (ctx.store as RuntimeStore & {
    appendEvents: RuntimeStore["appendEvents"];
  }).appendEvents = async (events) => {
    if (
      !failedAssignmentUpdate &&
      events.some((event) => event.type === "decision.created") &&
      events.some((event) => event.type === "assignment.updated")
    ) {
      failedAssignmentUpdate = true;
      throw new Error("simulated completed-run assignment persistence failure");
    }
    await originalAppendEvents(events);
  };

  await assert.rejects(
    reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection),
    /simulated completed-run assignment persistence failure/
  );

  (ctx.store as RuntimeStore & {
    appendEvents: RuntimeStore["appendEvents"];
  }).appendEvents = originalAppendEvents;

  const interrupted = await ctx.store.syncSnapshotFromEventsWithRecovery();
  const firstDecisionCount = await countRecoveredOutcomeEvents(ctx.store, ctx.assignmentId, "decision.created");
  const recovered = await reconcileActiveRuns(ctx.store, ctx.adapter, interrupted.projection);
  const secondDecisionCount = await countRecoveredOutcomeEvents(ctx.store, ctx.assignmentId, "decision.created");

  assert.equal(firstDecisionCount, 0);
  assert.equal(secondDecisionCount, 1);
  assert.equal(interrupted.projection.decisions.size, 0);
  assert.equal(interrupted.projection.assignments.get(ctx.assignmentId)?.state, "in_progress");
  assert.equal(recovered.projection.decisions.size, 1);
  assert.equal(recovered.projection.assignments.get(ctx.assignmentId)?.state, "blocked");
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, [ctx.assignmentId]);
  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
});

test("host-run recovery matrix replays completed-decision status when only the objective text drifted", async () => {
  const ctx = await createMatrixContext();
  await ctx.adapter.runStore.write(
    completedDecisionRecord(ctx.assignmentId, "Need operator confirmation before proceeding.")
  );

  const firstRecovery = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);
  const staleObjective = firstRecovery.projection.assignments.get(ctx.assignmentId)?.objective;
  assert.notEqual(staleObjective, undefined);
  const driftedAt = nowIso();
  await ctx.store.appendEvent({
    eventId: randomUUID(),
    sessionId: firstRecovery.projection.sessionId,
    timestamp: driftedAt,
    type: "status.updated",
    payload: {
      status: {
        ...firstRecovery.projection.status,
        currentObjective: staleObjective!,
        lastDurableOutputAt: driftedAt
      }
    }
  });
  await ctx.store.syncSnapshotFromEvents();

  const recovered = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);

  assert.equal(recovered.projection.assignments.get(ctx.assignmentId)?.state, "blocked");
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, [ctx.assignmentId]);
  assert.equal(
    recovered.projection.status.currentObjective,
    "Need operator confirmation before proceeding."
  );
  assert.equal(recovered.projection.decisions.size, 1);
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

  (ctx.adapter as MatrixAdapter).reconcileStaleRun = async () => {
    throw new Error("simulated completed-run cleanup failure");
  };

  await assert.rejects(
    reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection),
    /Host run reconciliation failed to clear the active lease for assignment/
  );
  const firstLeaseContents = await ctx.store.readTextArtifact(
    `adapters/matrix/runs/${ctx.assignmentId}.lease.json`,
    "matrix lease"
  );
  assert.notEqual(firstLeaseContents, undefined);
});

test("host-run recovery matrix releases authoritative attachment truth during completed-run recovery", async () => {
  const ctx = await createMatrixContext();
  const { attachmentId, claimId } = await appendDetachedResumableAttachmentClaim(ctx, ctx.assignmentId);
  const completedRecord = completedResultRecord(
    ctx.assignmentId,
    "completed",
    "Recovered completed result releases attachment authority."
  );
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, completedRecord);
  await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", completedRecord);
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, completedRecord);

  const recovered = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(recovered.projection.attachments.get(attachmentId)?.state, "released");
  assert.equal(recovered.projection.claims.get(claimId)?.state, "released");
  assert.match(
    recovered.projection.attachments.get(attachmentId)?.releasedReason ?? "",
    /Recovered completed assignment finished/
  );
  await assert.rejects(
    resumeRuntime(ctx.store, ctx.adapter),
    /No active assignment is available to resume/
  );
});

test("host-run recovery matrix detaches attached authority for recovered completed decisions", async () => {
  const ctx = await createMatrixContext();
  const { attachmentId, claimId } = await appendAttachedAttachmentClaim(ctx, ctx.assignmentId);
  const completedRecord = completedDecisionRecord(
    ctx.assignmentId,
    "Recovered decision keeps the same-session claim resumable."
  );
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, completedRecord);
  await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", completedRecord);
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, completedRecord);

  const recovered = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(recovered.projection.attachments.get(attachmentId)?.state, "detached_resumable");
  assert.equal(recovered.projection.claims.get(claimId)?.state, "active");
  assert.equal(recovered.projection.assignments.get(ctx.assignmentId)?.state, "blocked");
  assert.equal(recovered.projection.status.activeAssignmentIds[0], ctx.assignmentId);
  assert.equal(
    await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
    undefined
  );
});

test("host-run recovery matrix detaches attached authority for recovered partial results", async () => {
  const ctx = await createMatrixContext();
  const { attachmentId, claimId } = await appendAttachedAttachmentClaim(ctx, ctx.assignmentId);
  const completedRecord = completedResultRecord(
    ctx.assignmentId,
    "partial",
    "Recovered partial host completion keeps the claim resumable."
  );
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, completedRecord);
  await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", completedRecord);
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, completedRecord);

  const recovered = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(recovered.projection.attachments.get(attachmentId)?.state, "detached_resumable");
  assert.equal(recovered.projection.claims.get(claimId)?.state, "active");
  assert.equal(recovered.projection.assignments.get(ctx.assignmentId)?.state, "in_progress");
  assert.equal(getRunnableAssignment(recovered.projection).id, ctx.assignmentId);
  assert.equal(
    await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
    undefined
  );
});

test("host-run recovery matrix does not treat an earlier completion as proof for a later stale attempt", async () => {
  const ctx = await createMatrixContext();
  const assignment = ctx.projection.assignments.get(ctx.assignmentId);
  assert.ok(assignment, "expected bootstrap assignment");
  const completedAt = "2026-04-11T10:01:00.000Z";
  const retryStartedAt = "2026-04-11T10:05:00.000Z";

  await ctx.store.appendEvents([
    {
      eventId: randomUUID(),
      sessionId: ctx.projection.sessionId,
      timestamp: completedAt,
      type: "result.submitted",
      payload: {
        result: {
          resultId: randomUUID(),
          assignmentId: ctx.assignmentId,
          producerId: "matrix-host",
          status: "completed",
          summary: "Earlier completion stays historical only.",
          changedFiles: [],
          createdAt: completedAt
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId: ctx.projection.sessionId,
      timestamp: completedAt,
      type: "assignment.updated",
      payload: {
        assignmentId: ctx.assignmentId,
        patch: {
          state: "completed",
          updatedAt: completedAt
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId: ctx.projection.sessionId,
      timestamp: completedAt,
      type: "status.updated",
      payload: {
        status: {
          ...ctx.projection.status,
          activeAssignmentIds: [],
          currentObjective: "Await the next assignment.",
          lastDurableOutputAt: completedAt,
          resumeReady: false
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId: ctx.projection.sessionId,
      timestamp: retryStartedAt,
      type: "assignment.updated",
      payload: {
        assignmentId: ctx.assignmentId,
        patch: {
          state: "in_progress",
          updatedAt: retryStartedAt
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId: ctx.projection.sessionId,
      timestamp: retryStartedAt,
      type: "status.updated",
      payload: {
        status: {
          ...ctx.projection.status,
          activeAssignmentIds: [ctx.assignmentId],
          currentObjective: `Retry assignment ${ctx.assignmentId}: ${assignment.objective}`,
          lastDurableOutputAt: retryStartedAt,
          resumeReady: true
        }
      }
    }
  ]);
  await ctx.store.syncSnapshotFromEvents();

  const staleRecord: HostRunRecord = {
    assignmentId: ctx.assignmentId,
    state: "running",
    startedAt: retryStartedAt,
    heartbeatAt: retryStartedAt,
    leaseExpiresAt: "2000-01-01T00:00:00.000Z",
    adapterData: {
      nativeRunId: `native-${ctx.assignmentId}-retry`
    }
  };
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, staleRecord);
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, staleRecord);
  await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", staleRecord);

  const recovered = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);
  const inspected = await ctx.adapter.inspectRun(ctx.store, ctx.assignmentId);

  assert.equal(recovered.projection.results.size, 1);
  assert.equal(
    [...recovered.projection.results.values()].at(-1)?.summary,
    "Earlier completion stays historical only."
  );
  assert.equal(recovered.projection.assignments.get(ctx.assignmentId)?.state, "queued");
  assert.match(
    recovered.projection.status.currentObjective,
    new RegExp(`^Retry assignment ${ctx.assignmentId}:`)
  );
  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(!recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(inspected?.state, "completed");
  assert.equal(inspected?.staleReasonCode, "expired_lease");
});

test("host-run recovery matrix promotes provisional authority for recovered completed decisions", async () => {
  const ctx = await createMatrixContext();
  const { attachmentId, claimId } = await appendProvisionalAttachmentClaim(ctx, ctx.assignmentId);
  const completedRecord = completedDecisionRecord(
    ctx.assignmentId,
    "Recovered decision promotes provisional authority into resumable state."
  );
  completedRecord.adapterData = {
    nativeRunId: "matrix-thread-provisional-decision"
  };
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, completedRecord);
  await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", completedRecord);
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, completedRecord);

  const recovered = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(recovered.projection.attachments.get(attachmentId)?.state, "detached_resumable");
  assert.equal(
    recovered.projection.attachments.get(attachmentId)?.nativeSessionId,
    "matrix-thread-provisional-decision"
  );
  assert.deepEqual(recovered.projection.attachments.get(attachmentId)?.provenance, {
    kind: "recovery",
    source: "recovery.reconcile"
  });
  assert.equal(recovered.projection.claims.get(claimId)?.state, "active");
  assert.deepEqual(recovered.projection.claims.get(claimId)?.provenance, {
    kind: "recovery",
    source: "recovery.reconcile"
  });
  assert.equal(recovered.projection.assignments.get(ctx.assignmentId)?.state, "blocked");
  assert.equal(recovered.projection.status.activeAssignmentIds[0], ctx.assignmentId);
  assert.equal(
    await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
    undefined
  );
});

test("host-run recovery matrix promotes provisional authority for recovered partial results", async () => {
  const ctx = await createMatrixContext();
  const { attachmentId, claimId } = await appendProvisionalAttachmentClaim(ctx, ctx.assignmentId);
  const completedRecord = completedResultRecord(
    ctx.assignmentId,
    "partial",
    "Recovered partial host completion promotes provisional authority into resumable state."
  );
  completedRecord.adapterData = {
    nativeRunId: "matrix-thread-provisional-partial"
  };
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, completedRecord);
  await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", completedRecord);
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, completedRecord);

  const recovered = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(recovered.projection.attachments.get(attachmentId)?.state, "detached_resumable");
  assert.equal(
    recovered.projection.attachments.get(attachmentId)?.nativeSessionId,
    "matrix-thread-provisional-partial"
  );
  assert.deepEqual(recovered.projection.attachments.get(attachmentId)?.provenance, {
    kind: "recovery",
    source: "recovery.reconcile"
  });
  assert.equal(recovered.projection.claims.get(claimId)?.state, "active");
  assert.deepEqual(recovered.projection.claims.get(claimId)?.provenance, {
    kind: "recovery",
    source: "recovery.reconcile"
  });
  assert.equal(recovered.projection.assignments.get(ctx.assignmentId)?.state, "in_progress");
  assert.equal(getRunnableAssignment(recovered.projection).id, ctx.assignmentId);
  assert.equal(
    await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
    undefined
  );
});

test("host-run recovery matrix backfills missing native session id on detached authority for recovered partial results", async () => {
  const ctx = await createMatrixContext();
  const { attachmentId, claimId } = await appendDetachedResumableAttachmentClaim(
    ctx,
    ctx.assignmentId,
    null
  );
  const completedRecord = completedResultRecord(
    ctx.assignmentId,
    "partial",
    "Recovered partial host completion heals detached authority identity."
  );
  completedRecord.adapterData = {
    nativeRunId: "matrix-thread-detached-missing-id"
  };
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, completedRecord);
  await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", completedRecord);
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, completedRecord);

  const recovered = await loadReconciledProjectionWithDiagnostics(ctx.store, ctx.adapter);

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(recovered.projection.attachments.get(attachmentId)?.state, "detached_resumable");
  assert.equal(
    recovered.projection.attachments.get(attachmentId)?.nativeSessionId,
    "matrix-thread-detached-missing-id"
  );
  assert.equal(recovered.projection.claims.get(claimId)?.state, "active");
  assert.equal(recovered.projection.assignments.get(ctx.assignmentId)?.state, "in_progress");
});

test("host-run recovery matrix orphans authoritative attachment truth during stale-run recovery", async () => {
  const ctx = await createMatrixContext();
  const { attachmentId, claimId } = await appendDetachedResumableAttachmentClaim(ctx, ctx.assignmentId);
  await ctx.adapter.runStore.write(runningRecord(ctx.assignmentId, "2000-01-01T00:00:00.000Z"));

  const recovered = await reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection);

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(recovered.projection.attachments.get(attachmentId)?.state, "orphaned");
  assert.equal(recovered.projection.claims.get(claimId)?.state, "orphaned");
  assert.equal(recovered.projection.assignments.get(ctx.assignmentId)?.state, "queued");
  assert.match(
    recovered.projection.attachments.get(attachmentId)?.orphanedReason ?? "",
    /Stale host run was requeued for retry/
  );
});

test("host-run recovery matrix flushes completed-decision snapshot before cleanup on retry when recovery events are already durable", async () => {
  const ctx = await createMatrixContext();
  await ctx.adapter.runStore.write(
    completedDecisionRecord(ctx.assignmentId, "Need operator confirmation before proceeding.")
  );

  const originalWriteSnapshot = ctx.store.writeSnapshot.bind(ctx.store);
  let failedWriteSnapshot = false;
  (ctx.store as RuntimeStore & {
    writeSnapshot: RuntimeStore["writeSnapshot"];
  }).writeSnapshot = async (snapshot) => {
    if (!failedWriteSnapshot) {
      failedWriteSnapshot = true;
      throw new Error("simulated snapshot write failure");
    }
    await originalWriteSnapshot(snapshot);
  };

  await assert.rejects(
    reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection),
    /simulated snapshot write failure/
  );

  (ctx.store as RuntimeStore & {
    writeSnapshot: RuntimeStore["writeSnapshot"];
  }).writeSnapshot = originalWriteSnapshot;

  const originalReconcileStaleRun = ctx.adapter.reconcileStaleRun.bind(ctx.adapter);
  ctx.adapter.reconcileStaleRun = async (store, record) => {
    const snapshot = await ctx.store.loadSnapshot();
    assert.equal(
      snapshot?.assignments.find((assignment) => assignment.id === ctx.assignmentId)?.state,
      "blocked"
    );
    assert.deepEqual(snapshot?.status.activeAssignmentIds, [ctx.assignmentId]);
    await originalReconcileStaleRun(store, record);
  };

  const retried = await loadOperatorProjectionWithDiagnostics(ctx.store);
  assert.equal(retried.snapshotFallback, false);

  const recovered = await reconcileActiveRuns(ctx.store, ctx.adapter, retried.projection, {
    snapshotFallback: retried.snapshotFallback
  });
  const snapshot = await ctx.store.loadSnapshot();
  const recoveredDecisionCount = await countRecoveredOutcomeEvents(
    ctx.store,
    ctx.assignmentId,
    "decision.created"
  );

  assert.equal(recoveredDecisionCount, 1);
  assert.equal(recovered.projection.assignments.get(ctx.assignmentId)?.state, "blocked");
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, [ctx.assignmentId]);
  assert.equal(
    snapshot?.assignments.find((assignment) => assignment.id === ctx.assignmentId)?.state,
    "blocked"
  );
  assert.deepEqual(snapshot?.status.activeAssignmentIds, [ctx.assignmentId]);
});

test("host-run recovery matrix retries snapshot-fallback completed-run repair without duplicating recovery events", async () => {
  const ctx = await createMatrixContext();
  await ctx.store.syncSnapshotFromEvents();
  const completedRecord = completedResultRecord(
    ctx.assignmentId,
    "completed",
    "Recovered completed result."
  );
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, completedRecord);
  await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", completedRecord);
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, completedRecord);

  const eventLines = (await readFile(ctx.store.eventsPath, "utf8")).trimEnd().split("\n");
  eventLines.push(
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: ctx.projection.sessionId,
      timestamp: nowIso(),
      type: "assignment.updated",
      payload: {
        assignmentId: randomUUID(),
        patch: {
          state: "queued",
          updatedAt: nowIso()
        }
      }
    })
  );
  await writeFile(ctx.store.eventsPath, `${eventLines.join("\n")}\n`, "utf8");
  const brokenEventsContent = await readFile(ctx.store.eventsPath, "utf8");

  const originalWriteSnapshot = ctx.store.writeSnapshot.bind(ctx.store);
  let failedWriteSnapshot = false;
  (ctx.store as RuntimeStore & {
    writeSnapshot: RuntimeStore["writeSnapshot"];
  }).writeSnapshot = async (snapshot) => {
    if (!failedWriteSnapshot) {
      failedWriteSnapshot = true;
      throw new Error("simulated snapshot write failure");
    }
    await originalWriteSnapshot(snapshot);
  };

  const loaded = await loadOperatorProjectionWithDiagnostics(ctx.store);
  assert.equal(loaded.snapshotFallback, true);

  await assert.rejects(
    reconcileActiveRuns(ctx.store, ctx.adapter, loaded.projection, {
      snapshotFallback: loaded.snapshotFallback
    }),
    /simulated snapshot write failure/
  );

  (ctx.store as RuntimeStore & {
    writeSnapshot: RuntimeStore["writeSnapshot"];
  }).writeSnapshot = originalWriteSnapshot;

  const retried = await loadOperatorProjectionWithDiagnostics(ctx.store);
  const recovered = await reconcileActiveRuns(ctx.store, ctx.adapter, retried.projection, {
    snapshotFallback: retried.snapshotFallback
  });
  const recoveredEventCount = await countRecoveredOutcomeEvents(ctx.store, ctx.assignmentId, "result.submitted");

  assert.equal(recoveredEventCount, 0);
  assert.equal(recovered.projection.results.size, 1);
  assert.equal(recovered.projection.assignments.get(ctx.assignmentId)?.state, "completed");
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, []);
  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(await readFile(ctx.store.eventsPath, "utf8"), brokenEventsContent);
});

test("host-run recovery matrix preserves orphaned attachment truth across snapshot-only reclaim failure", async () => {
  const adapter = new ReclaimFailureMatrixAdapter();
  const ctx = await createMatrixContext(adapter);
  const attachmentId = randomUUID();
  const claimId = randomUUID();
  const timestamp = nowIso();
  const nativeSessionId = "matrix-resume-snapshot-only";

  const events: RuntimeEvent[] = [
    {
      eventId: randomUUID(),
      sessionId: ctx.projection.sessionId,
      timestamp,
      type: "assignment.updated",
      payload: {
        assignmentId: ctx.assignmentId,
        patch: {
          state: "in_progress",
          updatedAt: timestamp
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId: ctx.projection.sessionId,
      timestamp,
      type: "attachment.created",
      payload: {
        attachment: {
          id: attachmentId,
          adapter: ctx.projection.adapter,
          host: ctx.projection.status.activeHost,
          state: "detached_resumable",
          createdAt: timestamp,
          updatedAt: timestamp,
          detachedAt: timestamp,
          nativeSessionId,
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId: ctx.projection.sessionId,
      timestamp,
      type: "claim.created",
      payload: {
        claim: {
          id: claimId,
          assignmentId: ctx.assignmentId,
          attachmentId,
          state: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    }
  ];

  for (const event of events) {
    await ctx.store.appendEvent(event);
  }
  await ctx.store.syncSnapshotFromEvents();
  await writeFile(ctx.store.eventsPath, "", "utf8");

  const resumed = await resumeRuntime(ctx.store, adapter);
  const repairedSnapshot = await ctx.store.loadSnapshot();
  const repairedProjection = await loadOperatorProjection(ctx.store);
  const repairedAssignment = repairedProjection.assignments.get(ctx.assignmentId);
  const repairedAttachment = repairedProjection.attachments.get(attachmentId);
  const repairedClaim = repairedProjection.claims.get(claimId);

  assert.equal(resumed.mode, "prepared");
  assert.equal(adapter.resumeSessionCount, 1);
  assert.equal(repairedSnapshot?.attachments?.find((attachment) => attachment.id === attachmentId)?.state, "orphaned");
  assert.equal(repairedSnapshot?.claims?.find((claim) => claim.id === claimId)?.state, "orphaned");
  assert.match(
    repairedSnapshot?.attachments?.find((attachment) => attachment.id === attachmentId)?.orphanedReason ?? "",
    /simulated snapshot-only resume failure/
  );
  assert.match(
    repairedSnapshot?.claims?.find((claim) => claim.id === claimId)?.orphanedReason ?? "",
    /simulated snapshot-only resume failure/
  );
  assert.equal(repairedAssignment?.state, "queued");
  assert.equal(repairedAttachment?.state, "orphaned");
  assert.equal(repairedClaim?.state, "orphaned");
});

test("host-run recovery matrix replays completed results when snapshot-boundary proof is unusable", async () => {
  const ctx = await createMatrixContext();
  await ctx.store.syncSnapshotFromEvents();
  const completedRecord = completedResultRecord(
    ctx.assignmentId,
    "completed",
    "Recovered completed result."
  );
  const completedAt = completedRecord.completedAt!;
  const terminalOutcome = completedRecord.terminalOutcome;
  assert.equal(terminalOutcome?.kind, "result");
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.json`, completedRecord);
  await ctx.store.writeJsonArtifact("adapters/matrix/last-run.json", completedRecord);
  await ctx.store.writeJsonArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, completedRecord);

  const eventLines = (await readFile(ctx.store.eventsPath, "utf8")).trimEnd().split("\n");
  eventLines.push(
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: ctx.projection.sessionId,
      timestamp: completedAt,
      type: "result.submitted",
      payload: {
        result: {
          resultId: terminalOutcome.result.resultId ?? randomUUID(),
          assignmentId: ctx.assignmentId,
          producerId: "matrix-host",
          status: "completed",
          summary: "Recovered completed result.",
          changedFiles: [],
          createdAt: completedAt
        }
      }
    }),
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: ctx.projection.sessionId,
      timestamp: completedAt,
      type: "assignment.updated",
      payload: {
        assignmentId: ctx.assignmentId,
        patch: {
          state: "completed",
          updatedAt: completedAt
        }
      }
    }),
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: ctx.projection.sessionId,
      timestamp: completedAt,
      type: "status.updated",
      payload: {
        status: {
          ...ctx.projection.status,
          activeMode: "idle",
          currentObjective: "Await the next assignment.",
          activeAssignmentIds: [],
          lastDurableOutputAt: completedAt,
          resumeReady: true
        }
      }
    })
  );
  await writeFile(ctx.store.eventsPath, `${eventLines.join("\n")}\n`, "utf8");
  await corruptSnapshotBoundary(ctx.store);

  const loaded = await loadOperatorProjectionWithDiagnostics(ctx.store);
  assert.equal(loaded.snapshotFallback, true);

  const recovered = await reconcileActiveRuns(ctx.store, ctx.adapter, loaded.projection, {
    snapshotFallback: loaded.snapshotFallback
  });
  const repairedSnapshot = await ctx.store.loadSnapshot();

  assert.equal(recovered.projection.results.size, 1);
  assert.equal(recovered.projection.assignments.get(ctx.assignmentId)?.state, "completed");
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, []);
  assert.equal(repairedSnapshot?.results.length, 1);
  assert.equal(
    await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
    undefined
  );
});

test("host-run recovery matrix repairs stale snapshot before cleanup on retry when stale recovery events are already durable", async () => {
  const ctx = await createMatrixContext();
  await ctx.store.syncSnapshotFromEvents();
  await ctx.adapter.runStore.write({
    assignmentId: ctx.assignmentId,
    state: "completed",
    startedAt: nowIso(),
    completedAt: nowIso(),
    staleAt: nowIso(),
    staleReasonCode: "expired_lease",
    staleReason: "Run lease expired at 2000-01-01T00:00:00.000Z."
  });

  const originalWriteSnapshot = ctx.store.writeSnapshot.bind(ctx.store);
  let failedWriteSnapshot = false;
  (ctx.store as RuntimeStore & {
    writeSnapshot: RuntimeStore["writeSnapshot"];
  }).writeSnapshot = async (snapshot) => {
    if (!failedWriteSnapshot) {
      failedWriteSnapshot = true;
      throw new Error("simulated snapshot write failure");
    }
    await originalWriteSnapshot(snapshot);
  };

  await assert.rejects(
    reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection),
    /simulated snapshot write failure/
  );

  (ctx.store as RuntimeStore & {
    writeSnapshot: RuntimeStore["writeSnapshot"];
  }).writeSnapshot = originalWriteSnapshot;

  const originalReconcileStaleRun = ctx.adapter.reconcileStaleRun.bind(ctx.adapter);
  ctx.adapter.reconcileStaleRun = async (store, record) => {
    const snapshot = await ctx.store.loadSnapshot();
    assert.equal(
      snapshot?.assignments.find((assignment) => assignment.id === ctx.assignmentId)?.state,
      "completed"
    );
    assert.deepEqual(snapshot?.status.activeAssignmentIds, []);
    assert.equal(snapshot?.status.currentObjective, "Await the next assignment.");
    await originalReconcileStaleRun(store, record);
  };

  const retried = await loadOperatorProjectionWithDiagnostics(ctx.store);
  assert.equal(retried.snapshotFallback, false);

  const recovered = await reconcileActiveRuns(ctx.store, ctx.adapter, retried.projection, {
    snapshotFallback: retried.snapshotFallback
  });
  const snapshot = await ctx.store.loadSnapshot();

  assert.equal(recovered.projection.assignments.get(ctx.assignmentId)?.state, "queued");
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, [ctx.assignmentId]);
  assert.equal(snapshot?.assignments.find((assignment) => assignment.id === ctx.assignmentId)?.state, "queued");
  assert.deepEqual(snapshot?.status.activeAssignmentIds, [ctx.assignmentId]);
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

  await assert.rejects(
    reconcileActiveRuns(ctx.store, ctx.adapter, ctx.projection),
    /Host run reconciliation failed to clear the active lease for assignment/
  );
  const retried = await loadOperatorProjectionWithDiagnostics(ctx.store);
  const secondRecovery = await reconcileActiveRuns(ctx.store, ctx.adapter, retried.projection, {
    snapshotFallback: retried.snapshotFallback
  });
  const events = await ctx.store.loadEvents();
  const queuedTransitionCount = events.filter(
    (event) =>
      event.type === "assignment.updated" &&
      event.payload.assignmentId === ctx.assignmentId &&
      event.payload.patch.state === "queued"
  ).length;

  assert.equal(secondRecovery.projection.assignments.get(ctx.assignmentId)?.state, "queued");
  assert.equal(reconcileAttempts, 2);
  assert.equal(queuedTransitionCount, 1);
  assert.equal(
    await ctx.store.readTextArtifact(`adapters/matrix/runs/${ctx.assignmentId}.lease.json`, "matrix lease"),
    undefined
  );
});

test("host-run recovery matrix verifies stale cleanup against adapter-defined lease paths", async () => {
  const customArtifacts = {
    runRecordPath: (assignmentId: string) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId: string) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };

  class LeakyLeaseMatrixAdapter extends MatrixAdapter {
    constructor() {
      super(customArtifacts);
    }

    override async reconcileStaleRun(store: RuntimeArtifactStore, record: HostRunRecord): Promise<void> {
      this.bindStore(store);
      await store.writeJsonArtifact(customArtifacts.runRecordPath(record.assignmentId), record);
      await store.writeJsonArtifact(customArtifacts.lastRunPath(), record);
    }
  }

  const adapter = new LeakyLeaseMatrixAdapter();
  const ctx = await createMatrixContext(adapter);
  await adapter.runStore.write(runningRecord(ctx.assignmentId, "2000-01-01T00:00:00.000Z"));

  await assert.rejects(
    reconcileActiveRuns(ctx.store, adapter, ctx.projection),
    /Host run reconciliation failed to clear the active lease for assignment/
  );
  assert.notEqual(
    await ctx.store.readTextArtifact(customArtifacts.runLeasePath(ctx.assignmentId), "custom matrix lease"),
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

  async hasRunLease(store: RuntimeArtifactStore, assignmentId: string): Promise<boolean> {
    this.bindStore(store);
    return this.runStore.hasLease(assignmentId);
  }

  async clearRunLease(store: RuntimeArtifactStore, assignmentId: string): Promise<void> {
    this.bindStore(store);
    await this.runStore.clearLease(assignmentId);
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
    return materializeInspectableRunRecord(
      await this.runStore.inspectArtifacts(assignmentId),
      { includeMalformedLeaseRecord: true }
    );
  }

  async inspectRuns(store: RuntimeArtifactStore): Promise<HostRunRecord[]> {
    this.bindStore(store);
    return (await this.runStore.inspectAllArtifacts())
      .map((inspection) =>
        materializeInspectableRunRecord(inspection, { includeMalformedLeaseRecord: true })
      )
      .filter((record) => record !== undefined);
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

class ReclaimFailureMatrixAdapter extends BriefingMatrixAdapter {
  resumeSessionCount = 0;

  override getCapabilities(): AdapterCapabilities {
    return {
      ...super.getCapabilities(),
      supportsNativeSessionResume: true
    };
  }

  async resumeSession(
    _store: RuntimeArtifactStore,
    _projection: RuntimeProjection,
    _envelope: TaskEnvelope,
    attachment: import("../core/types.js").RuntimeAttachment
  ) {
    this.resumeSessionCount += 1;
    return {
      reclaimed: false as const,
      reclaimState: "unverified_failed" as const,
      requestedSessionId: attachment.nativeSessionId ?? "missing-native-session",
      sessionVerified: false,
      exitCode: 1,
      stoppedAt: nowIso(),
      warning: "simulated snapshot-only resume failure"
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

async function appendAssignmentBeyondSnapshotBoundary(ctx: MatrixContext): Promise<string> {
  const assignmentId = randomUUID();
  const timestamp = nowIso();
  await ctx.store.appendEvent({
    eventId: randomUUID(),
    sessionId: ctx.projection.sessionId,
    timestamp,
    type: "assignment.created",
    payload: {
      assignment: {
        id: assignmentId,
        parentTaskId: "task-hidden-beyond-snapshot",
        workflow: "milestone-2",
        ownerType: "host",
        ownerId: "matrix",
        objective: "Hidden assignment beyond the snapshot boundary.",
        writeScope: ["README.md"],
        requiredOutputs: ["result"],
        state: "queued",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    }
  });
  return assignmentId;
}

async function appendDetachedResumableAttachmentClaim(
  ctx: MatrixContext,
  assignmentId: string,
  nativeSessionId: string | null = `native-${assignmentId}`
): Promise<{ attachmentId: string; claimId: string }> {
  return appendAttachmentClaimBinding(ctx, assignmentId, {
    state: "detached_resumable",
    nativeSessionId
  });
}

async function appendAttachedAttachmentClaim(
  ctx: MatrixContext,
  assignmentId: string,
  nativeSessionId = `native-${assignmentId}`
): Promise<{ attachmentId: string; claimId: string }> {
  return appendAttachmentClaimBinding(ctx, assignmentId, {
    state: "attached",
    nativeSessionId
  });
}

async function appendProvisionalAttachmentClaim(
  ctx: MatrixContext,
  assignmentId: string
): Promise<{ attachmentId: string; claimId: string }> {
  return appendAttachmentClaimBinding(ctx, assignmentId, {
    state: "provisional"
  });
}

async function appendAttachmentClaimBinding(
  ctx: MatrixContext,
  assignmentId: string,
  options: {
    state: "attached" | "detached_resumable" | "provisional";
    nativeSessionId?: string | null;
  }
): Promise<{ attachmentId: string; claimId: string }> {
  const attachmentId = randomUUID();
  const claimId = randomUUID();
  const timestamp = nowIso();
  const nativeSessionId =
    options.nativeSessionId === undefined ? `native-${assignmentId}` : options.nativeSessionId;
  await ctx.store.appendEvents([
    {
      eventId: randomUUID(),
      sessionId: ctx.projection.sessionId,
      timestamp,
      type: "attachment.created",
      payload: {
        attachment: {
          id: attachmentId,
          adapter: "matrix",
          host: "matrix",
          state: options.state,
          createdAt: timestamp,
          updatedAt: timestamp,
          ...(options.state === "attached"
            ? { attachedAt: timestamp }
            : options.state === "detached_resumable"
              ? { detachedAt: timestamp }
              : {}),
          ...(options.state === "provisional" || !nativeSessionId ? {} : { nativeSessionId }),
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId: ctx.projection.sessionId,
      timestamp,
      type: "claim.created",
      payload: {
        claim: {
          id: claimId,
          assignmentId,
          attachmentId,
          state: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    }
  ]);
  await ctx.store.syncSnapshotFromEvents();
  ctx.projection = await loadOperatorProjection(ctx.store);
  return { attachmentId, claimId };
}

function projectionForSingleAssignment(
  projection: RuntimeProjection,
  assignmentId: string
): RuntimeProjection {
  const snapshot = toSnapshot(projection);
  snapshot.assignments = snapshot.assignments.filter((assignment) => assignment.id === assignmentId);
  snapshot.results = snapshot.results.filter((result) => result.assignmentId === assignmentId);
  snapshot.decisions = snapshot.decisions.filter((decision) => decision.assignmentId === assignmentId);
  snapshot.claims = (snapshot.claims ?? []).filter((claim) => claim.assignmentId === assignmentId);
  const attachmentIds = new Set(snapshot.claims.map((claim) => claim.attachmentId));
  snapshot.attachments = (snapshot.attachments ?? []).filter((attachment) => attachmentIds.has(attachment.id));
  snapshot.status = {
    ...snapshot.status,
    activeAssignmentIds: snapshot.status.activeAssignmentIds.filter((id) => id === assignmentId),
    currentObjective:
      snapshot.assignments[0]?.objective ??
      projection.assignments.get(assignmentId)?.objective ??
      snapshot.status.currentObjective
  };
  return fromSnapshot(snapshot);
}

async function corruptSnapshotBoundary(store: RuntimeStore): Promise<void> {
  const snapshot = await store.loadSnapshot();
  assert.ok(snapshot?.lastEventId, "expected a snapshot boundary before corruption");
  const eventLines = (await readFile(store.eventsPath, "utf8")).trimEnd().split("\n");
  const boundaryIndex = eventLines.findIndex((line) => {
    const parsed = JSON.parse(line) as { eventId?: string };
    return parsed.eventId === snapshot.lastEventId;
  });
  assert.ok(boundaryIndex >= 0, "expected to find the snapshot boundary event");
  eventLines[boundaryIndex] = "{\"broken\":";
  await writeFile(store.eventsPath, `${eventLines.join("\n")}\n`, "utf8");
}

async function removeAssignmentFromSnapshot(store: RuntimeStore, assignmentId: string): Promise<void> {
  const snapshot = await store.loadSnapshot();
  assert.ok(snapshot, "expected a snapshot before degrading it");
  snapshot.assignments = snapshot.assignments.filter((assignment) => assignment.id !== assignmentId);
  snapshot.status = {
    ...snapshot.status,
    activeAssignmentIds: snapshot.status.activeAssignmentIds.filter((id) => id !== assignmentId)
  };
  await store.writeSnapshot(snapshot);
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
