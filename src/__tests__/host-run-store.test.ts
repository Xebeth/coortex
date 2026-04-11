import test from "node:test";
import assert from "node:assert/strict";

import { HostRunStore, type HostRunArtifactPaths } from "../adapters/host-run-store.js";
import type { RuntimeArtifactStore } from "../adapters/contract.js";
import type { HostRunRecord } from "../core/types.js";

class MemoryArtifactStore implements RuntimeArtifactStore {
  readonly rootDir = "/memory";
  readonly runtimeDir = "/memory/runtime";
  readonly adaptersDir = "/memory/adapters";
  private readonly artifacts = new Map<string, string>();

  async readJsonArtifact<T>(relativePath: string, label: string): Promise<T | undefined> {
    const content = this.artifacts.get(relativePath);
    if (content === undefined) {
      return undefined;
    }
    return JSON.parse(content) as T;
  }

  async readTextArtifact(relativePath: string, _label: string): Promise<string | undefined> {
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

test("host run store uses adapter-provided artifact roles instead of codex paths", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const runStore = new HostRunStore(store, "custom", artifacts);
  const runningRecord: HostRunRecord = {
    assignmentId: "assignment-1",
    state: "running",
    startedAt: "2026-04-11T10:00:00.000Z",
    heartbeatAt: "2026-04-11T10:00:00.000Z",
    leaseExpiresAt: "2026-04-11T10:00:30.000Z"
  };

  await runStore.claim(runningRecord);
  assert.deepEqual(await runStore.inspect("assignment-1"), runningRecord);

  const completedRecord: HostRunRecord = {
    ...runningRecord,
    state: "completed",
    completedAt: "2026-04-11T10:01:00.000Z",
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Recovered from a custom artifact store.",
    terminalOutcome: {
      kind: "result",
      result: {
        producerId: "custom-host",
        status: "completed",
        summary: "Recovered from a custom artifact store.",
        changedFiles: [],
        createdAt: "2026-04-11T10:01:00.000Z"
      }
    }
  };

  await runStore.write(completedRecord);
  assert.deepEqual(await runStore.inspect("assignment-1"), completedRecord);
  await runStore.release("assignment-1");
  assert.equal(await runStore.inspect("assignment-1"), undefined);
});

test("host run store inspection matrix matches recovery invariants", async (t) => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const runStore = new HostRunStore(store, "custom", artifacts);
  const runningRecord = (assignmentId: string, leaseExpiresAt = "2999-04-11T10:00:30.000Z"): HostRunRecord => ({
    assignmentId,
    state: "running",
    startedAt: "2026-04-11T10:00:00.000Z",
    heartbeatAt: "2026-04-11T10:00:00.000Z",
    leaseExpiresAt
  });
  const completedRecord = (assignmentId: string, summary: string): HostRunRecord => ({
    assignmentId,
    state: "completed",
    startedAt: "2026-04-11T10:00:00.000Z",
    completedAt: "2026-04-11T10:01:00.000Z",
    outcomeKind: "result",
    resultStatus: "completed",
    summary
  });
  interface InspectionMatrixCase {
    name: string;
    assignmentId: string;
    runRecord?: HostRunRecord;
    leaseRecord?: HostRunRecord;
    leaseContent?: string;
    inspectLastRun?: boolean;
    expected: Partial<HostRunRecord> & Pick<HostRunRecord, "assignmentId" | "state">;
  }

  const cases: InspectionMatrixCase[] = [
    {
      name: "completed run record wins over a leftover active lease for the same assignment",
      assignmentId: "assignment-active-lease",
      runRecord: completedRecord("assignment-active-lease", "Older completed record"),
      leaseRecord: runningRecord("assignment-active-lease"),
      expected: completedRecord("assignment-active-lease", "Older completed record")
    },
    {
      name: "malformed lease without a durable run record becomes stale running state",
      assignmentId: "assignment-malformed-only",
      leaseContent: "{",
      expected: {
        assignmentId: "assignment-malformed-only",
        state: "running",
        staleReasonCode: "malformed_lease_artifact",
        staleReason: "malformed lease file"
      }
    },
    {
      name: "completed run record wins over malformed lease metadata",
      assignmentId: "assignment-completed-over-malformed",
      runRecord: completedRecord("assignment-completed-over-malformed", "Completed record wins"),
      leaseContent: "{",
      expected: completedRecord("assignment-completed-over-malformed", "Completed record wins")
    },
    {
      name: "lease-less running record becomes stale completed state",
      assignmentId: "assignment-missing-lease",
      runRecord: runningRecord("assignment-missing-lease", "2026-04-11T10:00:30.000Z"),
      expected: {
        ...runningRecord("assignment-missing-lease", "2026-04-11T10:00:30.000Z"),
        state: "completed",
        staleReasonCode: "missing_lease_artifact",
        staleReason: "Run record remained in running state without an active lease artifact."
      }
    },
    {
      name: "last-run inspection uses the same precedence as assignment-specific inspection",
      assignmentId: "assignment-last-run",
      inspectLastRun: true,
      runRecord: completedRecord("assignment-last-run", "Older completed record"),
      leaseRecord: runningRecord("assignment-last-run"),
      expected: completedRecord("assignment-last-run", "Older completed record")
    }
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      if (testCase.runRecord) {
        await store.writeJsonArtifact(
          artifacts.runRecordPath(testCase.assignmentId),
          testCase.runRecord
        );
        await store.writeJsonArtifact(artifacts.lastRunPath(), testCase.runRecord);
      }
      if (testCase.leaseRecord) {
        await store.writeJsonArtifact(
          artifacts.runLeasePath(testCase.assignmentId),
          testCase.leaseRecord
        );
      }
      if (testCase.leaseContent) {
        await store.writeTextArtifact(
          artifacts.runLeasePath(testCase.assignmentId),
          testCase.leaseContent
        );
        if (!testCase.runRecord) {
          await store.writeJsonArtifact(artifacts.lastRunPath(), {
            assignmentId: testCase.assignmentId,
            state: "running",
            startedAt: "2026-04-11T10:00:00.000Z"
          });
        }
      }

      const inspected = testCase.inspectLastRun
        ? await runStore.inspect()
        : await runStore.inspect(testCase.assignmentId);

      for (const [key, value] of Object.entries(testCase.expected)) {
        assert.deepEqual(inspected?.[key as keyof HostRunRecord], value, `${testCase.name}: ${key}`);
      }

      await store.deleteArtifact(artifacts.runRecordPath(testCase.assignmentId));
      await store.deleteArtifact(artifacts.runLeasePath(testCase.assignmentId));
      await store.deleteArtifact(artifacts.lastRunPath());
    });
  }
});

test("host run store clears abandoned running artifacts when claim metadata persistence fails", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const runStore = new HostRunStore(store, "custom", artifacts);
  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  let writeCount = 0;
  store.writeJsonArtifact = async (relativePath, value) => {
    writeCount += 1;
    if (writeCount === 2) {
      throw new Error("simulated last-run write failure");
    }
    return originalWriteJsonArtifact(relativePath, value);
  };

  await assert.rejects(
    runStore.claim({
      assignmentId: "assignment-2",
      state: "running",
      startedAt: "2026-04-11T10:00:00.000Z",
      heartbeatAt: "2026-04-11T10:00:00.000Z",
      leaseExpiresAt: "2026-04-11T10:00:30.000Z"
    }),
    /simulated last-run write failure/
  );

  assert.equal(await store.readTextArtifact(artifacts.runLeasePath("assignment-2"), "lease"), undefined);
  assert.equal(await store.readJsonArtifact(artifacts.runRecordPath("assignment-2"), "record"), undefined);
});

test("host run store clears the lease when final non-running persistence degrades to a warning", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const runStore = new HostRunStore(store, "custom", artifacts);
  const runningRecord: HostRunRecord = {
    assignmentId: "assignment-warning",
    state: "running",
    startedAt: "2026-04-11T10:00:00.000Z",
    heartbeatAt: "2026-04-11T10:00:00.000Z",
    leaseExpiresAt: "2999-04-11T10:00:30.000Z"
  };
  const completedRecord: HostRunRecord = {
    assignmentId: "assignment-warning",
    state: "completed",
    startedAt: "2026-04-11T10:00:00.000Z",
    completedAt: "2026-04-11T10:01:00.000Z",
    outcomeKind: "decision",
    summary: "Need a human decision."
  };

  await runStore.claim(runningRecord);

  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  let writes = 0;
  store.writeJsonArtifact = async (relativePath, value) => {
    writes += 1;
    if (relativePath === artifacts.lastRunPath() && writes >= 2) {
      throw new Error("simulated last-run persistence failure");
    }
    return originalWriteJsonArtifact(relativePath, value);
  };

  const warning = await runStore.persistWarning(completedRecord);

  assert.match(warning ?? "", /final run record could not be persisted/i);
  assert.equal(await store.readTextArtifact(artifacts.runLeasePath("assignment-warning"), "lease"), undefined);
});
