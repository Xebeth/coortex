import test from "node:test";
import assert from "node:assert/strict";

import { executeHostRunSession, type HostRunHandle } from "../adapters/host-run-session.js";
import { HostRunStore, type HostRunArtifactPaths } from "../adapters/host-run-store.js";
import type { RuntimeArtifactStore } from "../adapters/contract.js";
import { createRunningRunRecord } from "../adapters/host-run-records.js";
import type { HostRunRecord } from "../core/types.js";

class MemoryArtifactStore implements RuntimeArtifactStore {
  readonly rootDir = "/memory";
  readonly runtimeDir = "/memory/runtime";
  readonly adaptersDir = "/memory/adapters";
  private readonly artifacts = new Map<string, string>();

  async readJsonArtifact<T>(relativePath: string): Promise<T | undefined> {
    const content = this.artifacts.get(relativePath);
    return content === undefined ? undefined : (JSON.parse(content) as T);
  }

  async readTextArtifact(relativePath: string): Promise<string | undefined> {
    return this.artifacts.get(relativePath);
  }

  async claimTextArtifact(relativePath: string, content: string): Promise<string> {
    if (this.artifacts.has(relativePath)) {
      const error = new Error("already exists") as Error & { code: string };
      error.code = "EEXIST";
      throw error;
    }
    this.artifacts.set(relativePath, content);
    return `${this.rootDir}/${relativePath}`;
  }

  async writeJsonArtifact(relativePath: string, value: unknown): Promise<string> {
    this.artifacts.set(relativePath, JSON.stringify(value));
    return `${this.rootDir}/${relativePath}`;
  }

  async writeTextArtifact(relativePath: string, content: string): Promise<string> {
    this.artifacts.set(relativePath, content);
    return `${this.rootDir}/${relativePath}`;
  }

  async deleteArtifact(relativePath: string): Promise<void> {
    this.artifacts.delete(relativePath);
  }
}

test("host-run session matrix keeps completed state authoritative after a queued heartbeat callback", async (t) => {
  const cases = [
    {
      name: "completed result is not rewritten back to running by a queued heartbeat"
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
      const assignmentId = "assignment-heartbeat";
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

      try {
        let activeRun: HostRunHandle<{ exitCode: number }> | undefined;
        const execution = await executeHostRunSession({
          assignmentId,
          startedAt,
          taskId: "session-heartbeat",
          runStore,
          runRecord: claimedRun,
          leaseMs: 30_000,
          heartbeatMs: 5_000,
          startRun: async ({ onNativeRunId }) => {
            await onNativeRunId("native-heartbeat-1");
            const result = Promise.resolve({ exitCode: 0 });
            activeRun = {
              result,
              terminate: async () => undefined,
              waitForExit: async () => ({ code: 0 })
            };
            return activeRun;
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
                  status: "completed",
                  summary: "Queued heartbeat did not rewrite the completed run.",
                  changedFiles: [],
                  createdAt: "2026-04-11T10:01:00.000Z"
                }
              }
            },
            ...(nativeRunId ? { nativeRunId } : {})
          }),
          setActiveRun: (run) => {
            activeRun = run;
          },
          setActiveExecutionSettled: () => undefined
        });

        queuedHeartbeat?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const inspected = await runStore.inspect(assignmentId);

        assert.equal(execution.run.state, "completed");
        assert.equal(inspected?.state, "completed");
        assert.equal(await store.readTextArtifact(artifacts.runLeasePath(assignmentId)), undefined);
        assert.equal(activeRun, undefined);
      } finally {
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
      }
    });
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
