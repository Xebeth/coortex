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
import { createRunningRunRecord, deriveWorkflowRunAttemptIdentity } from "../adapters/host-run-records.js";
import type { DecisionPacket, HostRunRecord, RecoveryBrief, ResultPacket, RuntimeProjection } from "../core/types.js";
import { RuntimeStore } from "../persistence/store.js";
import { buildWorkflowBootstrap } from "../workflows/index.js";
import { loadOperatorProjection } from "../cli/commands.js";
import { loadInspectRuntimeContext } from "../cli/inspect-context.js";
import type { RuntimeConfig } from "../config/types.js";
import type { TelemetryEvent } from "../telemetry/types.js";

test("inspect context reuses the last-run lookup when it already points at the workflow assignment", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-inspect-context-"));
  const store = RuntimeStore.forProject(projectRoot);
  const adapter = new CountingInspectAdapter();
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: adapter.id,
    host: adapter.host,
    rootPath: projectRoot,
    createdAt: "2026-04-19T00:00:00.000Z"
  };

  await store.initialize(config);
  const bootstrap = buildWorkflowBootstrap({
    sessionId,
    adapterId: adapter.id,
    host: adapter.host,
    timestamp: "2026-04-19T00:00:00.000Z"
  });
  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }
  await store.syncSnapshotFromEvents();

  const projection = await loadOperatorProjection(store);
  const workflowAttempt = deriveWorkflowRunAttemptIdentity(projection, bootstrap.initialAssignmentId);
  assert.ok(workflowAttempt, "expected workflow attempt identity for the bootstrap assignment");
  const startedAt = new Date().toISOString();

  adapter.record = createRunningRunRecord(
    bootstrap.initialAssignmentId,
    startedAt,
    60_000,
    {
      workflowAttempt,
      nativeRunId: "inspect-context-thread"
    }
  );

  const inspection = await loadInspectRuntimeContext(store, adapter);

  assert.equal(inspection.record?.assignment?.id, bootstrap.initialAssignmentId);
  assert.equal(inspection.record?.run?.assignmentId, bootstrap.initialAssignmentId);
  assert.deepEqual(adapter.inspectCalls, [bootstrap.initialAssignmentId, undefined]);
});

class CountingInspectAdapter implements HostAdapter {
  readonly id = "counting";
  readonly host = "counting";
  inspectCalls: Array<string | undefined> = [];
  record: HostRunRecord | undefined;

  getCapabilities(): AdapterCapabilities {
    return {
      supportsProfiles: false,
      supportsHooks: false,
      supportsResume: false,
      supportsFork: false,
      supportsExactUsage: false,
      supportsCompactionHooks: false,
      supportsMcp: false,
      supportsPlugins: false,
      supportsPermissionsModel: false
    };
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
    throw new Error("buildResumeEnvelope should not be called in inspect-context tests");
  }

  async executeAssignment(
    _store: RuntimeArtifactStore,
    _projection: RuntimeProjection,
    _envelope: TaskEnvelope,
    _claimedRun?: HostRunRecord
  ): Promise<HostExecutionOutcome> {
    throw new Error("executeAssignment should not be called in inspect-context tests");
  }

  async claimRunLease(
    _store: RuntimeArtifactStore,
    _projection: RuntimeProjection,
    _assignmentId: string
  ): Promise<HostRunRecord> {
    throw new Error("claimRunLease should not be called in inspect-context tests");
  }

  async hasRunLease(_store: RuntimeArtifactStore, _assignmentId: string): Promise<boolean> {
    return false;
  }

  async releaseRunLease(_store: RuntimeArtifactStore, _assignmentId: string): Promise<void> {
    throw new Error("releaseRunLease should not be called in inspect-context tests");
  }

  async reconcileStaleRun(_store: RuntimeArtifactStore, _record: HostRunRecord): Promise<void> {
    throw new Error("reconcileStaleRun should not be called in inspect-context tests");
  }

  async inspectRun(
    _store: RuntimeArtifactStore,
    assignmentId?: string
  ): Promise<HostRunRecord | undefined> {
    this.inspectCalls.push(assignmentId);
    if (!this.record) {
      return undefined;
    }
    if (assignmentId && assignmentId !== this.record.assignmentId) {
      return undefined;
    }
    return {
      ...this.record,
      ...(this.record.workflowAttempt
        ? { workflowAttempt: { ...this.record.workflowAttempt } }
        : {})
    };
  }

  async inspectRuns(_store: RuntimeArtifactStore): Promise<HostRunRecord[]> {
    return [];
  }

  normalizeResult(_capture: HostResultCapture): ResultPacket {
    throw new Error("normalizeResult should not be called in inspect-context tests");
  }

  normalizeDecision(_capture: HostDecisionCapture): DecisionPacket {
    throw new Error("normalizeDecision should not be called in inspect-context tests");
  }

  normalizeTelemetry(_capture: HostTelemetryCapture): Omit<TelemetryEvent, "timestamp"> {
    throw new Error("normalizeTelemetry should not be called in inspect-context tests");
  }
}
