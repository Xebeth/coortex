import test from "node:test";
import assert from "node:assert/strict";

import {
  executeHostResumeSession,
  executeHostRunSession,
  type HostRunHandle
} from "../adapters/host-run-session.js";
import { HostRunStore, type HostRunArtifactPaths } from "../adapters/host-run-store.js";
import type { RuntimeArtifactStore } from "../adapters/contract.js";
import { createRunningRunRecord } from "../adapters/host-run-records.js";
import type { HostRunRecord } from "../core/types.js";

class MemoryArtifactStore implements RuntimeArtifactStore {
  readonly rootDir = "/memory";
  readonly runtimeDir = "/memory/runtime";
  readonly adaptersDir = "/memory/adapters";
  private readonly artifacts = new Map<string, { content: string; version: string }>();
  private versionCounter = 0;

  async readJsonArtifact<T>(relativePath: string): Promise<T | undefined> {
    const artifact = this.artifacts.get(relativePath);
    return artifact === undefined ? undefined : (JSON.parse(artifact.content) as T);
  }

  async readTextArtifact(relativePath: string): Promise<string | undefined> {
    return this.artifacts.get(relativePath)?.content;
  }

  async readVersionedTextArtifact(relativePath: string): Promise<{
    content?: string;
    version: string | null;
  }> {
    const artifact = this.artifacts.get(relativePath);
    return artifact ? { content: artifact.content, version: artifact.version } : { version: null };
  }

  async claimTextArtifact(relativePath: string, content: string): Promise<string> {
    if (this.artifacts.has(relativePath)) {
      const error = new Error("already exists") as Error & { code: string };
      error.code = "EEXIST";
      throw error;
    }
    this.artifacts.set(relativePath, { content, version: this.nextVersion() });
    return `${this.rootDir}/${relativePath}`;
  }

  async writeTextArtifactCas(
    relativePath: string,
    expectedVersion: string | null,
    nextContent: string
  ): Promise<{ ok: boolean; version: string | null }> {
    const current = this.artifacts.get(relativePath);
    const currentVersion = current?.version ?? null;
    if (currentVersion !== expectedVersion) {
      return { ok: false, version: currentVersion };
    }
    const version = this.nextVersion();
    this.artifacts.set(relativePath, { content: nextContent, version });
    return { ok: true, version };
  }

  async writeJsonArtifact(relativePath: string, value: unknown): Promise<string> {
    this.artifacts.set(relativePath, {
      content: JSON.stringify(value),
      version: this.nextVersion()
    });
    return `${this.rootDir}/${relativePath}`;
  }

  async writeTextArtifact(relativePath: string, content: string): Promise<string> {
    this.artifacts.set(relativePath, { content, version: this.nextVersion() });
    return `${this.rootDir}/${relativePath}`;
  }

  async deleteArtifact(relativePath: string): Promise<void> {
    this.artifacts.delete(relativePath);
  }

  private nextVersion(): string {
    this.versionCounter += 1;
    return `v${this.versionCounter}`;
  }
}

test("host-run session matrix keeps completed state authoritative after a queued heartbeat callback", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.json`,
    runLeasePath: (assignmentId) => `leases/${assignmentId}.json`,
    lastRunPath: () => "runs/last.json"
  };
  const runStore = new HostRunStore(store, "matrix", artifacts);
  const startedAt = "2026-04-11T10:00:00.000Z";
  const assignmentId = "assignment-heartbeat";
  const claimedRun = createRunningRunRecord(assignmentId, startedAt, 30_000);
  await runStore.claim(claimedRun);

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const writeEvents: Array<{ relativePath: string; state: string | undefined }> = [];
  let queuedHeartbeat: (() => void) | undefined;
  let heartbeatRegistered!: () => void;
  const heartbeatReady = new Promise<void>((resolve) => {
    heartbeatRegistered = resolve;
  });
  let resolveExecution!: (execution: { exitCode: number }) => void;
  const executionResult = new Promise<{ exitCode: number }>((resolve) => {
    resolveExecution = resolve;
  });
  let deriveCompletedCalls = 0;
  let runningLeaseWrites = 0;
  let heartbeatWriteObserved!: () => void;
  const heartbeatWriteSeen = new Promise<void>((resolve) => {
    heartbeatWriteObserved = resolve;
  });
  let releaseHeartbeatWrite!: () => void;
  const heartbeatWriteReleased = new Promise<void>((resolve) => {
    releaseHeartbeatWrite = resolve;
  });
  let heartbeatWriteBlocked = false;

  globalThis.setInterval = ((callback: Parameters<typeof globalThis.setInterval>[0]) => {
    queuedHeartbeat = typeof callback === "function" ? callback : undefined;
    heartbeatRegistered();
    return 1 as unknown as NodeJS.Timeout;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = (() => undefined) as typeof globalThis.clearInterval;

  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  store.writeJsonArtifact = async (relativePath, value) => {
    const state =
      typeof value === "object" && value !== null && "state" in value
        ? String((value as { state?: unknown }).state)
        : undefined;
    writeEvents.push({ relativePath, state });
    if (
      relativePath === artifacts.runLeasePath(assignmentId) &&
      state === "running"
    ) {
      runningLeaseWrites += 1;
      if (!heartbeatWriteBlocked && runningLeaseWrites === 3) {
        heartbeatWriteBlocked = true;
        heartbeatWriteObserved();
        await heartbeatWriteReleased;
      }
    }
    return originalWriteJsonArtifact(relativePath, value);
  };

  try {
    const executionPromise = executeHostRunSession({
      assignmentId,
      startedAt,
      taskId: "session-heartbeat",
      runStore,
      runRecord: claimedRun,
      leaseMs: 30_000,
      heartbeatMs: 5_000,
      startRun: async ({ onNativeRunId }) => {
        await onNativeRunId("native-heartbeat-1");
        return {
          result: executionResult,
          terminate: async () => undefined,
          waitForExit: async () => ({ code: 0 })
        };
      },
      summarizeExecutionFailure: (error) =>
        error instanceof Error ? error.message : String(error),
      buildFailedOutcome: (failedAssignmentId, completedAt, summary) => ({
        outcome: {
          kind: "result",
          capture: {
            assignmentId: failedAssignmentId,
            producerId: "matrix-host",
            status: "failed",
            summary,
            changedFiles: [],
            createdAt: completedAt
          }
        }
      }),
      deriveCompleted: async (_execution, nativeRunId) => {
        deriveCompletedCalls += 1;
        return {
          outcome: {
            outcome: {
              kind: "result",
              capture: {
                assignmentId,
                producerId: "matrix-host",
                status: "completed",
                summary: "Queued heartbeat did not rewrite the completed run.",
                changedFiles: [],
                createdAt: "2026-04-11T10:01:00.000Z"
              }
            }
          },
          ...(nativeRunId ? { nativeRunId } : {})
        };
      },
      setActiveRun: () => undefined,
      setActiveExecutionSettled: () => undefined
    });

    await heartbeatReady;
    assert.ok(queuedHeartbeat, "heartbeat callback should be registered");
    queuedHeartbeat?.();
    await heartbeatWriteSeen;
    assert.equal(deriveCompletedCalls, 0);

    resolveExecution({ exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(deriveCompletedCalls, 0, "completion must wait for the queued heartbeat write");

    releaseHeartbeatWrite();
    const execution = await executionPromise;
    const inspected = await runStore.inspect(assignmentId);

    assert.equal(deriveCompletedCalls, 1);
    assert.equal(execution.run.state, "completed");
    assert.equal(inspected?.state, "completed");
    assert.equal(await store.readTextArtifact(artifacts.runLeasePath(assignmentId)), undefined);
    const completionWriteIndex = writeEvents.reduce((lastIndex, event, index) => {
      if (
        (event.relativePath === artifacts.runRecordPath(assignmentId) ||
          event.relativePath === artifacts.lastRunPath()) &&
        event.state === "completed"
      ) {
        return index;
      }
      return lastIndex;
    }, -1);
    assert.ok(completionWriteIndex >= 0, "completed run write should be recorded");
    const postCompletionRunningWrite = writeEvents.slice(completionWriteIndex + 1).find(
      (event) => event.state === "running"
    );
    assert.equal(postCompletionRunningWrite, undefined, JSON.stringify(writeEvents));
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    store.writeJsonArtifact = originalWriteJsonArtifact;
  }
});

test("host-run session matrix refreshes the lease before derived completion metadata", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.json`,
    runLeasePath: (assignmentId) => `leases/${assignmentId}.json`,
    lastRunPath: () => "runs/last.json"
  };
  const runStore = new HostRunStore(store, "matrix", artifacts);
  const startedAt = "2026-04-11T10:00:00.000Z";
  const assignmentId = "assignment-lease-order";
  const claimedRun = createRunningRunRecord(assignmentId, startedAt, 30_000);
  await runStore.claim(claimedRun);

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((callback: Parameters<typeof globalThis.setInterval>[0]) => {
    return 1 as unknown as NodeJS.Timeout;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = (() => undefined) as typeof globalThis.clearInterval;

  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  const writeEvents: Array<{ relativePath: string; state: string | undefined }> = [];
  let leaseRefreshObserved!: () => void;
  const leaseRefreshSeen = new Promise<void>((resolve) => {
    leaseRefreshObserved = resolve;
  });
  let releaseLeaseRefresh!: () => void;
  const leaseRefreshReleased = new Promise<void>((resolve) => {
    releaseLeaseRefresh = resolve;
  });
  let leaseRefreshBlocked = false;
  let deriveCompletedCalls = 0;
  store.writeJsonArtifact = async (relativePath, value) => {
    writeEvents.push({
      relativePath,
      state:
        typeof value === "object" && value !== null && "state" in value
          ? String((value as { state?: unknown }).state)
          : undefined
    });
    if (!leaseRefreshBlocked && relativePath === artifacts.runLeasePath(assignmentId)) {
      leaseRefreshBlocked = true;
      leaseRefreshObserved();
      await leaseRefreshReleased;
    }
    return originalWriteJsonArtifact(relativePath, value);
  };

  try {
    const executionPromise = executeHostRunSession({
      assignmentId,
      startedAt,
      taskId: "session-lease-order",
      runStore,
      runRecord: claimedRun,
      leaseMs: 30_000,
      heartbeatMs: 5_000,
      startRun: async ({ onNativeRunId }) => {
        await onNativeRunId("native-lease-order-1");
        return {
          result: Promise.resolve({ exitCode: 0 }),
          terminate: async () => undefined,
          waitForExit: async () => ({ code: 0 })
        };
      },
      summarizeExecutionFailure: (error) => (error instanceof Error ? error.message : String(error)),
      buildFailedOutcome: (failedAssignmentId, completedAt, summary) => ({
        outcome: {
          kind: "result",
          capture: {
            assignmentId: failedAssignmentId,
            producerId: "matrix-host",
            status: "failed",
            summary,
            changedFiles: [],
            createdAt: completedAt
          }
        }
      }),
      deriveCompleted: async (_execution, nativeRunId) => {
        deriveCompletedCalls += 1;
        return {
          outcome: {
            outcome: {
              kind: "result",
              capture: {
                assignmentId,
                producerId: "matrix-host",
                status: "completed",
                summary: "Lease refresh happened before derived completion metadata.",
                changedFiles: [],
                createdAt: "2026-04-11T10:01:00.000Z"
              }
            }
          },
          ...(nativeRunId ? { nativeRunId } : {})
        };
      },
      setActiveRun: () => undefined,
      setActiveExecutionSettled: () => undefined
    });

    await leaseRefreshSeen;
    assert.equal(deriveCompletedCalls, 0);
    assert.equal(
      writeEvents.filter((event) => event.state === "completed").length,
      0,
      JSON.stringify(writeEvents)
    );

    releaseLeaseRefresh();
    const execution = await executionPromise;
    const inspected = await runStore.inspect(assignmentId);

    assert.equal(deriveCompletedCalls, 1);
    assert.equal(execution.outcome.kind, "result");
    assert.equal(execution.outcome.capture.status, "completed");
    assert.equal(inspected?.state, "completed");
    assert.equal(inspected?.resultStatus, "completed");
    assert.equal(await store.readTextArtifact(artifacts.runLeasePath(assignmentId)), undefined);
    const leaseWriteIndex = writeEvents.findIndex(
      (event) => event.relativePath === artifacts.runLeasePath(assignmentId) && event.state === "running"
    );
    const completedWriteIndex = writeEvents.findIndex(
      (event) => event.relativePath === artifacts.runRecordPath(assignmentId) && event.state === "completed"
    );
    assert.ok(leaseWriteIndex >= 0 && completedWriteIndex > leaseWriteIndex, JSON.stringify(writeEvents));
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    store.writeJsonArtifact = originalWriteJsonArtifact;
  }
});

test("host-run session matrix fails the run when heartbeat persistence stops working", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.json`,
    runLeasePath: (assignmentId) => `leases/${assignmentId}.json`,
    lastRunPath: () => "runs/last.json"
  };
  const runStore = new HostRunStore(store, "matrix", artifacts);
  const startedAt = "2026-04-11T10:00:00.000Z";
  const assignmentId = "assignment-heartbeat-failure";
  const claimedRun = createRunningRunRecord(assignmentId, startedAt, 30_000);
  await runStore.claim(claimedRun);

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let queuedHeartbeat: (() => void) | undefined;
  globalThis.setInterval = ((callback: Parameters<typeof globalThis.setInterval>[0]) => {
    queuedHeartbeat = typeof callback === "function" ? callback : undefined;
    return 1 as unknown as NodeJS.Timeout;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = (() => undefined) as typeof globalThis.clearInterval;

  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  let leaseWriteCount = 0;
  store.writeJsonArtifact = async (relativePath, value) => {
    if (
      relativePath === artifacts.runLeasePath(assignmentId) &&
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      value.state === "running"
    ) {
      leaseWriteCount += 1;
      if (leaseWriteCount >= 3) {
        throw new Error("simulated heartbeat persistence failure");
      }
    }
    return originalWriteJsonArtifact(relativePath, value);
  };

  try {
    const executionPromise = executeHostRunSession({
      assignmentId,
      startedAt,
      taskId: "session-heartbeat-failure",
      runStore,
      runRecord: claimedRun,
      leaseMs: 30_000,
      heartbeatMs: 5_000,
      startRun: async ({ onNativeRunId }) => {
        await onNativeRunId("native-heartbeat-failure-1");
        return {
          result: new Promise<{ exitCode: number }>(() => undefined),
          terminate: async () => undefined,
          waitForExit: async () => ({ code: 0 })
        };
      },
      summarizeExecutionFailure: (error) =>
        error instanceof Error ? error.message : String(error),
      buildFailedOutcome: (failedAssignmentId, completedAt, summary) => ({
        outcome: {
          kind: "result",
          capture: {
            assignmentId: failedAssignmentId,
            producerId: "matrix-host",
            status: "failed",
            summary,
            changedFiles: [],
            createdAt: completedAt
          }
        }
      }),
      deriveCompleted: async () => {
        throw new Error("deriveCompleted should not run after heartbeat failure");
      },
      setActiveRun: () => undefined,
      setActiveExecutionSettled: () => undefined
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(queuedHeartbeat, "heartbeat callback should be registered");
    queuedHeartbeat?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const execution = await executionPromise;
    const inspected = await runStore.inspect(assignmentId);

    assert.equal(execution.outcome.kind, "result");
    assert.equal(execution.outcome.capture.status, "failed");
    assert.match(execution.outcome.capture.summary, /heartbeat persistence failure/);
    assert.equal(inspected?.state, "completed");
    assert.equal(inspected?.resultStatus, "failed");
    assert.equal(await store.readTextArtifact(artifacts.runLeasePath(assignmentId)), undefined);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("host-run session matrix persists a terminal failure if post-exit outcome derivation throws", async (t) => {
  const cases = [
    {
      name: "deriveCompleted failure after exit clears the running lease and records a failed run"
    }
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const store = new MemoryArtifactStore();
      const artifacts: HostRunArtifactPaths = {
        runRecordPath: (assignmentId) => `records/${assignmentId}.json`,
        runLeasePath: (assignmentId) => `leases/${assignmentId}.json`,
        lastRunPath: () => "runs/last.json"
      };
      const runStore = new HostRunStore(store, "matrix", artifacts);
      const startedAt = "2026-04-11T10:00:00.000Z";
      const assignmentId = "assignment-derive-error";
      const claimedRun = createRunningRunRecord(assignmentId, startedAt, 30_000);
      await runStore.claim(claimedRun);

      const execution = await executeHostRunSession({
        assignmentId,
        startedAt,
        taskId: "session-derive-error",
        runStore,
        runRecord: claimedRun,
        leaseMs: 30_000,
        heartbeatMs: 5_000,
        startRun: async ({ onNativeRunId }) => {
          await onNativeRunId("native-derive-error-1");
          return {
            result: Promise.resolve({ exitCode: 0 }),
            terminate: async () => undefined,
            waitForExit: async () => ({ code: 0 })
          };
        },
        summarizeExecutionFailure: (error) =>
          error instanceof Error ? error.message : String(error),
        buildFailedOutcome: (failedAssignmentId, completedAt, summary) => ({
          outcome: {
            kind: "result",
            capture: {
              assignmentId: failedAssignmentId,
              producerId: "matrix-host",
              status: "failed",
              summary,
              changedFiles: [],
              createdAt: completedAt
            }
          }
        }),
        deriveCompleted: async () => {
          throw new Error("simulated deriveCompleted failure");
        },
        setActiveRun: () => undefined,
        setActiveExecutionSettled: () => undefined
      });

      const inspected = await runStore.inspect(assignmentId);

      assert.equal(execution.outcome.kind, "result");
      assert.equal(execution.outcome.capture.status, "failed");
      assert.match(execution.outcome.capture.summary, /deriveCompleted failure/);
      assert.equal(inspected?.state, "completed");
      assert.equal(inspected?.resultStatus, "failed");
      assert.equal(await store.readTextArtifact(artifacts.runLeasePath(assignmentId)), undefined);
    });
  }
});

test("host-run session does not surface launch identity when metadata persistence fails", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.json`,
    runLeasePath: (assignmentId) => `leases/${assignmentId}.json`,
    lastRunPath: () => "runs/last.json"
  };
  const runStore = new HostRunStore(store, "matrix", artifacts);
  const startedAt = "2026-04-11T10:00:00.000Z";
  const assignmentId = "assignment-launch-identity-failure";
  const claimedRun = createRunningRunRecord(assignmentId, startedAt, 30_000);
  await runStore.claim(claimedRun);

  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  store.writeJsonArtifact = async (relativePath, value) => {
    if (
      relativePath === artifacts.runLeasePath(assignmentId) &&
      typeof value === "object" &&
      value !== null &&
      "adapterData" in value
    ) {
      throw new Error("simulated thread-start metadata failure");
    }
    return originalWriteJsonArtifact(relativePath, value);
  };

  let seenIdentity: string | undefined;
  try {
    const execution = await executeHostRunSession({
      assignmentId,
      startedAt,
      taskId: "session-launch-identity-failure",
      runStore,
      runRecord: claimedRun,
      leaseMs: 30_000,
      heartbeatMs: 30_000,
      startRun: async ({ onNativeRunId }) => {
        await onNativeRunId("native-launch-failure-1");
        return {
          result: Promise.resolve({ exitCode: 0 }),
          terminate: async () => undefined,
          waitForExit: async () => ({ code: 0 })
        };
      },
      onSessionIdentity: async (identity) => {
        seenIdentity = identity.nativeSessionId;
      },
      summarizeExecutionFailure: (error) =>
        error instanceof Error ? error.message : String(error),
      buildFailedOutcome: (failedAssignmentId, completedAt, summary) => ({
        outcome: {
          kind: "result",
          capture: {
            assignmentId: failedAssignmentId,
            producerId: "matrix-host",
            status: "failed",
            summary,
            changedFiles: [],
            createdAt: completedAt
          }
        }
      }),
      deriveCompleted: async (_execution, nativeRunId) => ({
        outcome: {
          outcome: {
            kind: "result",
            capture: {
              assignmentId,
              producerId: "matrix-host",
              status: "partial",
              summary: "Completed despite missing durable identity persistence.",
              changedFiles: [],
              createdAt: "2026-04-11T10:01:00.000Z"
            }
          }
        },
        ...(nativeRunId ? { nativeRunId } : {})
      }),
      setActiveRun: () => undefined,
      setActiveExecutionSettled: () => undefined
    });

    assert.equal(seenIdentity, undefined);
    assert.equal(execution.run.adapterData?.nativeRunId, undefined);
    assert.match(execution.warning ?? "", /thread-start metadata failure/);
  } finally {
    store.writeJsonArtifact = originalWriteJsonArtifact;
  }
});

test("host-run resume preserves verified reclaim proof after post-exit failure", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.json`,
    runLeasePath: (assignmentId) => `leases/${assignmentId}.json`,
    lastRunPath: () => "runs/last.json"
  };
  const runStore = new HostRunStore(store, "matrix", artifacts);
  const startedAt = "2026-04-11T10:00:00.000Z";
  const assignmentId = "assignment-resume-verified-failure";
  const requestedSessionId = "native-resume-verified-1";
  const claimedRun = createRunningRunRecord(assignmentId, startedAt, 30_000, requestedSessionId);
  await runStore.claim(claimedRun);

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (() => 1 as unknown as NodeJS.Timeout) as typeof globalThis.setInterval;
  globalThis.clearInterval = (() => undefined) as typeof globalThis.clearInterval;

  try {
    const result = await executeHostResumeSession({
      assignmentId,
      startedAt,
      taskId: "session-resume-verified-failure",
      requestedSessionId,
      runStore,
      runRecord: claimedRun,
      leaseMs: 30_000,
      heartbeatMs: 30_000,
      startRun: async () => ({
        result: Promise.resolve({ exitCode: 0 }),
        terminate: async () => undefined,
        waitForExit: async () => ({ code: 0 })
      }),
      summarizeExecutionFailure: (error) =>
        error instanceof Error ? error.message : String(error),
      summarizeVerificationFailure: (_requestedSessionId, _observedSessionId, execution) =>
        `verification failed after exit ${execution.exitCode}`,
      deriveCompleted: async () => {
        throw new Error("simulated resume post-exit failure");
      },
      getObservedSessionId: () => requestedSessionId,
      getVerifiedSessionId: () => requestedSessionId,
      setActiveRun: () => undefined,
      setActiveExecutionSettled: () => undefined
    });

    assert.equal(result.reclaimed, false);
    assert.equal(result.reclaimState, "verified_then_failed");
    assert.equal(result.verifiedSessionId, requestedSessionId);
    assert.equal(result.sessionVerified, true);
    assert.match(result.warning ?? "", /simulated resume post-exit failure/);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
