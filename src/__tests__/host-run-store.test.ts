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
    leaseExpiresAt: "2999-04-11T10:00:30.000Z"
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
    summary,
    terminalOutcome: {
      kind: "result",
      result: {
        producerId: "custom-host",
        status: "completed",
        summary,
        changedFiles: [],
        createdAt: "2026-04-11T10:01:00.000Z"
      }
    }
  });
  interface InspectionMatrixCase {
    name: string;
    assignmentId: string;
    runRecord?: HostRunRecord;
    leaseRecord?: HostRunRecord;
    leaseContent?: string;
    inspectLastRun?: boolean;
    lastRunRecord?: HostRunRecord;
    lastRunLeaseRecord?: HostRunRecord;
    expected: Partial<HostRunRecord> & Pick<HostRunRecord, "assignmentId" | "state">;
  }

  const cases: InspectionMatrixCase[] = [
    {
      name: "expired lease-backed running record becomes stale completed state",
      assignmentId: "assignment-expired-lease",
      leaseRecord: runningRecord("assignment-expired-lease", "2000-01-01T00:00:00.000Z"),
      expected: {
        ...runningRecord("assignment-expired-lease", "2000-01-01T00:00:00.000Z"),
        state: "completed",
        staleReasonCode: "expired_lease",
        staleReason: "Run lease expired at 2000-01-01T00:00:00.000Z."
      }
    },
    {
      name: "missing-expiry lease-backed running record becomes stale completed state",
      assignmentId: "assignment-missing-expiry-lease",
      leaseRecord: {
        assignmentId: "assignment-missing-expiry-lease",
        state: "running",
        startedAt: "2026-04-11T10:00:00.000Z",
        heartbeatAt: "2026-04-11T10:00:00.000Z"
      },
      expected: {
        assignmentId: "assignment-missing-expiry-lease",
        state: "completed",
        startedAt: "2026-04-11T10:00:00.000Z",
        heartbeatAt: "2026-04-11T10:00:00.000Z",
        staleReasonCode: "missing_lease_expiry",
        staleReason: "Run record remained in running state without a lease expiry."
      }
    },
    {
      name: "invalid-expiry lease-backed running record becomes stale completed state",
      assignmentId: "assignment-invalid-expiry-lease",
      leaseRecord: {
        ...runningRecord("assignment-invalid-expiry-lease"),
        leaseExpiresAt: "not-a-timestamp"
      },
      expected: {
        ...runningRecord("assignment-invalid-expiry-lease"),
        leaseExpiresAt: "not-a-timestamp",
        state: "completed",
        staleReasonCode: "invalid_lease_expiry",
        staleReason: "Run record has an invalid lease expiry: not-a-timestamp."
      }
    },
    {
      name: "completed run record wins over a leftover active lease for the same assignment",
      assignmentId: "assignment-active-lease",
      runRecord: completedRecord("assignment-active-lease", "Older completed record"),
      leaseRecord: runningRecord("assignment-active-lease"),
      expected: completedRecord("assignment-active-lease", "Older completed record")
    },
    {
      name: "completed run record wins over a leftover expired lease for the same assignment",
      assignmentId: "assignment-completed-over-expired-lease",
      runRecord: completedRecord("assignment-completed-over-expired-lease", "Completed record wins"),
      leaseRecord: runningRecord(
        "assignment-completed-over-expired-lease",
        "2000-01-01T00:00:00.000Z"
      ),
      expected: completedRecord("assignment-completed-over-expired-lease", "Completed record wins")
    },
    {
      name: "completed run record wins over a leftover missing-expiry lease for the same assignment",
      assignmentId: "assignment-completed-over-missing-expiry-lease",
      runRecord: completedRecord(
        "assignment-completed-over-missing-expiry-lease",
        "Completed record wins"
      ),
      leaseRecord: {
        assignmentId: "assignment-completed-over-missing-expiry-lease",
        state: "running",
        startedAt: "2026-04-11T10:00:00.000Z",
        heartbeatAt: "2026-04-11T10:00:00.000Z"
      },
      expected: completedRecord(
        "assignment-completed-over-missing-expiry-lease",
        "Completed record wins"
      )
    },
    {
      name: "completed run record wins over a leftover invalid-expiry lease for the same assignment",
      assignmentId: "assignment-completed-over-invalid-expiry-lease",
      runRecord: completedRecord(
        "assignment-completed-over-invalid-expiry-lease",
        "Completed record wins"
      ),
      leaseRecord: {
        ...runningRecord("assignment-completed-over-invalid-expiry-lease"),
        leaseExpiresAt: "not-a-timestamp"
      },
      expected: completedRecord("assignment-completed-over-invalid-expiry-lease", "Completed record wins")
    },
    {
      name: "valid lease overrides expired running metadata for the same assignment",
      assignmentId: "assignment-fresh-over-expired",
      runRecord: runningRecord("assignment-fresh-over-expired", "2000-01-01T00:00:00.000Z"),
      leaseRecord: runningRecord("assignment-fresh-over-expired"),
      expected: runningRecord("assignment-fresh-over-expired")
    },
    {
      name: "valid lease overrides missing-expiry running metadata for the same assignment",
      assignmentId: "assignment-fresh-over-missing-expiry",
      runRecord: {
        assignmentId: "assignment-fresh-over-missing-expiry",
        state: "running",
        startedAt: "2026-04-11T10:00:00.000Z",
        heartbeatAt: "2026-04-11T10:00:00.000Z"
      },
      leaseRecord: runningRecord("assignment-fresh-over-missing-expiry"),
      expected: runningRecord("assignment-fresh-over-missing-expiry")
    },
    {
      name: "valid lease overrides invalid-expiry running metadata for the same assignment",
      assignmentId: "assignment-fresh-over-invalid-expiry",
      runRecord: {
        ...runningRecord("assignment-fresh-over-invalid-expiry"),
        leaseExpiresAt: "not-a-timestamp"
      },
      leaseRecord: runningRecord("assignment-fresh-over-invalid-expiry"),
      expected: runningRecord("assignment-fresh-over-invalid-expiry")
    },
    {
      name: "valid lease overrides stale-completed metadata without a durable terminal outcome",
      assignmentId: "assignment-fresh-over-stale-completed",
      runRecord: {
        assignmentId: "assignment-fresh-over-stale-completed",
        state: "completed",
        startedAt: "2026-04-11T10:00:00.000Z",
        completedAt: "2026-04-11T10:01:00.000Z",
        staleAt: "2026-04-11T10:01:00.000Z",
        staleReasonCode: "expired_lease",
        staleReason: "Run lease expired at 2000-01-01T00:00:00.000Z."
      },
      leaseRecord: runningRecord("assignment-fresh-over-stale-completed"),
      expected: runningRecord("assignment-fresh-over-stale-completed")
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
      runRecord: completedRecord("assignment-last-run", "Assignment-specific completed record"),
      leaseRecord: runningRecord("assignment-last-run"),
      lastRunRecord: {
        assignmentId: "assignment-last-run-pointer",
        state: "running",
        startedAt: "2026-04-11T10:00:00.000Z",
        heartbeatAt: "2026-04-11T10:00:00.000Z",
        leaseExpiresAt: "2000-01-01T00:00:00.000Z",
        adapterData: { nativeRunId: "native-assignment-last-run-pointer" }
      },
      lastRunLeaseRecord: {
        assignmentId: "assignment-last-run-pointer",
        state: "running",
        startedAt: "2026-04-11T10:00:00.000Z",
        heartbeatAt: "2026-04-11T10:00:00.000Z",
        leaseExpiresAt: "2999-04-11T10:00:30.000Z",
        adapterData: { nativeRunId: "native-assignment-last-run-pointer" }
      },
      expected: {
        assignmentId: "assignment-last-run-pointer",
        state: "running",
        startedAt: "2026-04-11T10:00:00.000Z",
        heartbeatAt: "2026-04-11T10:00:00.000Z",
        leaseExpiresAt: "2999-04-11T10:00:30.000Z",
        adapterData: { nativeRunId: "native-assignment-last-run-pointer" }
      }
    }
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      if (testCase.runRecord) {
        await store.writeJsonArtifact(
          artifacts.runRecordPath(testCase.assignmentId),
          testCase.runRecord
        );
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
      }
      if (testCase.lastRunRecord) {
        await store.writeJsonArtifact(
          artifacts.runRecordPath(testCase.lastRunRecord.assignmentId),
          testCase.lastRunRecord
        );
        await store.writeJsonArtifact(artifacts.lastRunPath(), testCase.lastRunRecord);
      } else if (testCase.runRecord) {
        await store.writeJsonArtifact(artifacts.lastRunPath(), testCase.runRecord);
      }
      if (testCase.lastRunLeaseRecord) {
        await store.writeJsonArtifact(
          artifacts.runLeasePath(testCase.lastRunLeaseRecord.assignmentId),
          testCase.lastRunLeaseRecord
        );
      }

      const inspected = testCase.inspectLastRun
        ? await runStore.inspect()
        : await runStore.inspect(testCase.assignmentId);

      for (const [key, value] of Object.entries(testCase.expected)) {
        assert.deepEqual(inspected?.[key as keyof HostRunRecord], value, `${testCase.name}: ${key}`);
      }

      await store.deleteArtifact(artifacts.runRecordPath(testCase.assignmentId));
      await store.deleteArtifact(artifacts.runLeasePath(testCase.assignmentId));
      if (testCase.lastRunRecord) {
        await store.deleteArtifact(artifacts.runRecordPath(testCase.lastRunRecord.assignmentId));
        await store.deleteArtifact(artifacts.runLeasePath(testCase.lastRunRecord.assignmentId));
      }
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

test("host run store removes the lease before a completed record becomes visible", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const runStore = new HostRunStore(store, "custom", artifacts);
  const runningRecord: HostRunRecord = {
    assignmentId: "assignment-ordering",
    state: "running",
    startedAt: "2026-04-11T10:00:00.000Z",
    heartbeatAt: "2026-04-11T10:00:00.000Z",
    leaseExpiresAt: "2999-04-11T10:00:30.000Z"
  };
  const completedRecord: HostRunRecord = {
    assignmentId: "assignment-ordering",
    state: "completed",
    startedAt: "2026-04-11T10:00:00.000Z",
    completedAt: "2026-04-11T10:01:00.000Z",
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Completed ordering check.",
    terminalOutcome: {
      kind: "result",
      result: {
        producerId: "custom-host",
        status: "completed",
        summary: "Completed ordering check.",
        changedFiles: [],
        createdAt: "2026-04-11T10:01:00.000Z"
      }
    }
  };

  await runStore.claim(runningRecord);

  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  let observedCompletedWrite = false;
  store.writeJsonArtifact = async (relativePath, value) => {
    if (
      relativePath === artifacts.runRecordPath("assignment-ordering") &&
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      value.state === "completed"
    ) {
      observedCompletedWrite = true;
      assert.equal(
        await store.readTextArtifact(artifacts.runLeasePath("assignment-ordering"), "lease"),
        undefined
      );
    }
    return originalWriteJsonArtifact(relativePath, value);
  };

  await runStore.write(completedRecord);

  assert.equal(observedCompletedWrite, true);
});
