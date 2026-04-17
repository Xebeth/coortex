import test from "node:test";
import assert from "node:assert/strict";

import {
  HostRunStore,
  MalformedHostRunLeaseArtifactError,
  type HostRunArtifactPaths
} from "../adapters/host-run-store.js";
import { HostRunLeaseRepository } from "../adapters/host-run-lease-repository.js";
import type { RuntimeArtifactStore } from "../adapters/contract.js";
import type { HostRunRecord } from "../core/types.js";

class MemoryArtifactStore implements RuntimeArtifactStore {
  readonly rootDir = "/memory";
  readonly runtimeDir = "/memory/runtime";
  readonly adaptersDir = "/memory/adapters";
  private readonly artifacts = new Map<string, { content: string; version: string }>();
  private versionCounter = 0;

  async readJsonArtifact<T>(relativePath: string, label: string): Promise<T | undefined> {
    const artifact = this.artifacts.get(relativePath);
    if (artifact === undefined) {
      return undefined;
    }
    return JSON.parse(artifact.content) as T;
  }

  async readTextArtifact(relativePath: string, _label: string): Promise<string | undefined> {
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

  async listArtifacts(relativeDir: string): Promise<string[]> {
    return [...this.artifacts.keys()]
      .filter((relativePath) => relativePath.startsWith(`${relativeDir}/`))
      .sort((left, right) => left.localeCompare(right));
  }

  async deleteArtifact(relativePath: string): Promise<void> {
    this.artifacts.delete(relativePath);
  }

  private nextVersion(): string {
    this.versionCounter += 1;
    return `v${this.versionCounter}`;
  }
}

test("host run lease repository exposes durable missing, valid, and malformed lease facts", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const repository = new HostRunLeaseRepository(store, "custom", artifacts);
  const validLease: HostRunRecord = {
    assignmentId: "assignment-valid",
    state: "running",
    startedAt: "2026-04-11T10:00:00.000Z",
    heartbeatAt: "2026-04-11T10:00:00.000Z",
    leaseExpiresAt: "2999-04-11T10:00:30.000Z"
  };

  await store.writeJsonArtifact(artifacts.runLeasePath(validLease.assignmentId), validLease);
  await store.writeTextArtifact(artifacts.runLeasePath("assignment-malformed"), "{");

  assert.equal((await repository.readLease("assignment-missing")).state, "missing");

  const readValidLease = await repository.readLease(validLease.assignmentId);
  assert.equal(readValidLease.state, "valid");
  assert.deepEqual(readValidLease.record, validLease);

  const malformedLease = await repository.readLease("assignment-malformed");
  assert.equal(malformedLease.state, "malformed");
  assert.equal(malformedLease.raw, "{");
});

test("host run lease repository preserves malformed last-run pointers as typed facts", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const repository = new HostRunLeaseRepository(store, "custom", artifacts);

  await store.writeTextArtifact(artifacts.lastRunPath(), "{");

  const pointer = await repository.readLastRunPointer();

  assert.equal(pointer.state, "malformed");
  assert.equal(pointer.raw, "{");
  assert.equal(await repository.inspect(), undefined);
});

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

test("host run store clears leftover leases without deleting the durable run record", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const runStore = new HostRunStore(store, "custom", artifacts);
  const completedRecord: HostRunRecord = {
    assignmentId: "assignment-clear-lease",
    state: "completed",
    startedAt: "2026-04-11T10:00:00.000Z",
    completedAt: "2026-04-11T10:01:00.000Z",
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Completed run survives leftover lease cleanup.",
    terminalOutcome: {
      kind: "result",
      result: {
        producerId: "custom-host",
        status: "completed",
        summary: "Completed run survives leftover lease cleanup.",
        changedFiles: [],
        createdAt: "2026-04-11T10:01:00.000Z"
      }
    }
  };
  const leftoverLease: HostRunRecord = {
    assignmentId: completedRecord.assignmentId,
    state: "running",
    startedAt: "2026-04-11T10:02:00.000Z",
    heartbeatAt: "2026-04-11T10:02:00.000Z",
    leaseExpiresAt: "2999-04-11T10:02:30.000Z"
  };

  await runStore.write(completedRecord);
  await store.writeJsonArtifact(artifacts.runLeasePath(completedRecord.assignmentId), leftoverLease);

  await runStore.clearLease(completedRecord.assignmentId);

  assert.deepEqual(await runStore.inspect(completedRecord.assignmentId), completedRecord);
  assert.equal(
    await store.readTextArtifact(artifacts.runLeasePath(completedRecord.assignmentId), "lease"),
    undefined
  );
  assert.deepEqual(
    await store.readJsonArtifact<HostRunRecord>(artifacts.lastRunPath(), "last-run"),
    completedRecord
  );
});

test("host run store atomically adopts a reusable live lease exactly once", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const runStore = new HostRunStore(store, "custom", artifacts);
  const runningRecord: HostRunRecord = {
    assignmentId: "assignment-adopt",
    state: "running",
    startedAt: "2026-04-11T10:00:00.000Z",
    heartbeatAt: "2026-04-11T10:00:00.000Z",
    leaseExpiresAt: "2999-04-11T10:00:30.000Z",
    adapterData: {
      nativeRunId: "thread-adopt-1"
    }
  };

  await runStore.claim(runningRecord);

  let releaseAdoptionWrite!: () => void;
  const adoptionWriteReleased = new Promise<void>((resolve) => {
    releaseAdoptionWrite = resolve;
  });
  let adoptionWriteSeen!: () => void;
  const adoptionWriteSeenPromise = new Promise<void>((resolve) => {
    adoptionWriteSeen = resolve;
  });
  const originalWriteTextArtifactCas = store.writeTextArtifactCas.bind(store);
  store.writeTextArtifactCas = async (relativePath, expectedVersion, nextContent) => {
    if (
      relativePath === artifacts.runLeasePath("assignment-adopt") &&
      nextContent.includes("\"coortexReclaimLease\": true")
    ) {
      adoptionWriteSeen();
      await adoptionWriteReleased;
    }
    return originalWriteTextArtifactCas(relativePath, expectedVersion, nextContent);
  };

  const adoptRecord = (current: HostRunRecord): HostRunRecord => ({
    ...current,
    heartbeatAt: "2026-04-11T10:00:05.000Z",
    leaseExpiresAt: "2999-04-11T10:00:35.000Z",
    adapterData: {
      ...(current.adapterData ?? {}),
      nativeRunId: "thread-adopt-1",
      coortexReclaimLease: true
    }
  });

  try {
    const firstAdoption = runStore.claimOrAdopt(
      runningRecord,
      (current) =>
        current.adapterData?.nativeRunId === "thread-adopt-1" &&
        current.adapterData?.coortexReclaimLease !== true,
      adoptRecord
    );
    await adoptionWriteSeenPromise;
    const secondAdoption = runStore.claimOrAdopt(
      runningRecord,
      (current) =>
        current.adapterData?.nativeRunId === "thread-adopt-1" &&
        current.adapterData?.coortexReclaimLease !== true,
      adoptRecord
    );

    releaseAdoptionWrite();
    const adopted = await firstAdoption;
    await assert.rejects(secondAdoption, /already has an active host run lease/);

    const inspected = await runStore.inspect("assignment-adopt");
    assert.equal(adopted.adapterData?.coortexReclaimLease, true);
    assert.equal(inspected?.adapterData?.coortexReclaimLease, true);
  } finally {
    store.writeTextArtifactCas = originalWriteTextArtifactCas;
  }
});

test("host run store rolls back adopt metadata when persistence fails", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const runStore = new HostRunStore(store, "custom", artifacts);
  const assignmentId = "assignment-adopt-rollback";
  const runningRecord: HostRunRecord = {
    assignmentId,
    state: "running",
    startedAt: "2026-04-11T10:00:00.000Z",
    heartbeatAt: "2026-04-11T10:00:00.000Z",
    leaseExpiresAt: "2999-04-11T10:00:30.000Z",
    adapterData: {
      nativeRunId: "thread-adopt-rollback-1"
    }
  };

  await runStore.claim(runningRecord);

  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  let failed = false;
  store.writeJsonArtifact = async (relativePath, value) => {
    if (!failed && relativePath === artifacts.runRecordPath(assignmentId)) {
      failed = true;
      throw new Error("simulated adopt metadata failure");
    }
    return originalWriteJsonArtifact(relativePath, value);
  };

  const adoptRecord = (current: HostRunRecord): HostRunRecord => ({
    ...current,
    heartbeatAt: "2026-04-11T10:00:05.000Z",
    leaseExpiresAt: "2999-04-11T10:00:35.000Z",
    adapterData: {
      ...(current.adapterData ?? {}),
      nativeRunId: "thread-adopt-rollback-1",
      coortexReclaimLease: true
    }
  });

  try {
    await assert.rejects(
      runStore.claimOrAdopt(
        runningRecord,
        (current) =>
          current.adapterData?.nativeRunId === "thread-adopt-rollback-1" &&
          current.adapterData?.coortexReclaimLease !== true,
        adoptRecord
      ),
      /simulated adopt metadata failure/
    );

    const inspected = await runStore.inspect(assignmentId);
    const lease = await store.readJsonArtifact<HostRunRecord>(artifacts.runLeasePath(assignmentId), "lease");
    const runRecord = await store.readJsonArtifact<HostRunRecord>(artifacts.runRecordPath(assignmentId), "record");
    const lastRun = await store.readJsonArtifact<HostRunRecord>(artifacts.lastRunPath(), "last-run");

    assert.equal(inspected?.adapterData?.coortexReclaimLease, undefined);
    assert.equal(lease?.adapterData?.coortexReclaimLease, undefined);
    assert.equal(runRecord?.adapterData?.coortexReclaimLease, undefined);
    assert.equal(lastRun?.adapterData?.coortexReclaimLease, undefined);
  } finally {
    store.writeJsonArtifact = originalWriteJsonArtifact;
  }
});

test("host run store blocks adopt on malformed lease artifacts without fabricating a running blocker", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const runStore = new HostRunStore(store, "custom", artifacts);
  const assignmentId = "assignment-adopt-malformed";
  const requestedRecord: HostRunRecord = {
    assignmentId,
    state: "running",
    startedAt: "2026-04-11T10:00:00.000Z",
    heartbeatAt: "2026-04-11T10:00:00.000Z",
    leaseExpiresAt: "2999-04-11T10:00:30.000Z",
    adapterData: {
      nativeRunId: "thread-adopt-malformed-1"
    }
  };

  await store.writeTextArtifact(artifacts.runLeasePath(assignmentId), "{ definitely-not-json");

  await assert.rejects(
    runStore.claimOrAdopt(
      requestedRecord,
      () => true,
      (current) => current
    ),
    (error: unknown) =>
      error instanceof MalformedHostRunLeaseArtifactError &&
      error.assignmentId === assignmentId &&
      error.relativePath === artifacts.runLeasePath(assignmentId)
  );

  assert.equal(
    await store.readTextArtifact(artifacts.runLeasePath(assignmentId), "custom run lease"),
    "{ definitely-not-json"
  );
  assert.equal(
    await store.readJsonArtifact(artifacts.runRecordPath(assignmentId), "custom run record"),
    undefined
  );
  assert.equal(
    await store.readJsonArtifact(artifacts.lastRunPath(), "custom run record"),
    undefined
  );

  const inspected = await runStore.inspect(assignmentId);
  const inspection = await runStore.inspectArtifacts(assignmentId);
  assert.equal(inspected, undefined);
  assert.equal(inspection?.assignmentId, assignmentId);
  assert.equal(inspection?.lease.state, "malformed");
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
    expected: (Partial<HostRunRecord> & Pick<HostRunRecord, "assignmentId" | "state">) | null;
    expectedLeaseState?: "missing" | "valid" | "malformed";
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
      name: "malformed lease without a durable run record stays a malformed artifact fact",
      assignmentId: "assignment-malformed-only",
      leaseContent: "{",
      expected: null,
      expectedLeaseState: "malformed"
    },
    {
      name: "parsed empty-object lease without a durable run record stays a malformed artifact fact",
      assignmentId: "assignment-empty-object-lease",
      leaseContent: "{}",
      expected: null,
      expectedLeaseState: "malformed"
    },
    {
      name: "parsed null lease without a durable run record stays a malformed artifact fact",
      assignmentId: "assignment-null-lease",
      leaseContent: "null",
      expected: null,
      expectedLeaseState: "malformed"
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
      const inspection = testCase.inspectLastRun
        ? await runStore.inspectArtifacts()
        : await runStore.inspectArtifacts(testCase.assignmentId);

      if (testCase.expected) {
        for (const [key, value] of Object.entries(testCase.expected)) {
          assert.deepEqual(inspected?.[key as keyof HostRunRecord], value, `${testCase.name}: ${key}`);
        }
      } else {
        assert.equal(inspected, undefined, `${testCase.name}: inspection`);
      }
      if ("expectedLeaseState" in testCase) {
        assert.equal(inspection?.lease.state, testCase.expectedLeaseState, `${testCase.name}: lease.state`);
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

test("host run store ignores a malformed last-run pointer during inspection", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const runStore = new HostRunStore(store, "custom", artifacts);
  const runningRecord: HostRunRecord = {
    assignmentId: "assignment-valid",
    state: "running",
    startedAt: "2026-04-11T10:00:00.000Z",
    heartbeatAt: "2026-04-11T10:00:00.000Z",
    leaseExpiresAt: "2999-04-11T10:00:30.000Z"
  };

  await store.writeJsonArtifact(artifacts.runRecordPath(runningRecord.assignmentId), runningRecord);
  await store.writeJsonArtifact(artifacts.runLeasePath(runningRecord.assignmentId), runningRecord);
  await store.writeTextArtifact(artifacts.lastRunPath(), "{");

  assert.equal(await runStore.inspect(), undefined);
  assert.deepEqual(await runStore.inspectAll(), [runningRecord]);
  assert.deepEqual(await runStore.inspect(runningRecord.assignmentId), runningRecord);
});

test("host run store ignores a parseable but invalid last-run pointer during inspection", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const runStore = new HostRunStore(store, "custom", artifacts);
  const runningRecord: HostRunRecord = {
    assignmentId: "assignment-valid",
    state: "running",
    startedAt: "2026-04-11T10:00:00.000Z",
    heartbeatAt: "2026-04-11T10:00:00.000Z",
    leaseExpiresAt: "2999-04-11T10:00:30.000Z"
  };

  await store.writeJsonArtifact(artifacts.runRecordPath(runningRecord.assignmentId), runningRecord);
  await store.writeJsonArtifact(artifacts.runLeasePath(runningRecord.assignmentId), runningRecord);
  await store.writeJsonArtifact(artifacts.lastRunPath(), {});

  assert.equal(await runStore.inspect(), undefined);
  assert.deepEqual(await runStore.inspectAll(), [runningRecord]);
  assert.deepEqual(await runStore.inspect(runningRecord.assignmentId), runningRecord);
});

test("host run store ignores a malformed last-run pointer during release cleanup", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const runStore = new HostRunStore(store, "custom", artifacts);
  const runningRecord: HostRunRecord = {
    assignmentId: "assignment-release-malformed-pointer",
    state: "running",
    startedAt: "2026-04-11T10:00:00.000Z",
    heartbeatAt: "2026-04-11T10:00:00.000Z",
    leaseExpiresAt: "2999-04-11T10:00:30.000Z"
  };

  await runStore.claim(runningRecord);
  await store.writeTextArtifact(artifacts.lastRunPath(), "{");

  await runStore.release(runningRecord.assignmentId);

  assert.equal(
    await store.readTextArtifact(artifacts.runLeasePath(runningRecord.assignmentId), "lease"),
    undefined
  );
  assert.equal(
    await store.readJsonArtifact(artifacts.runRecordPath(runningRecord.assignmentId), "record"),
    undefined
  );
});

test("host run store ignores a parseable but invalid last-run pointer during claim rollback cleanup", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const runStore = new HostRunStore(store, "custom", artifacts);
  await store.writeJsonArtifact(artifacts.lastRunPath(), {});

  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  store.writeJsonArtifact = async (relativePath, value) => {
    if (relativePath === artifacts.lastRunPath()) {
      throw new Error("simulated last-run write failure");
    }
    return originalWriteJsonArtifact(relativePath, value);
  };

  await assert.rejects(
    runStore.claim({
      assignmentId: "assignment-rollback-invalid-pointer",
      state: "running",
      startedAt: "2026-04-11T10:00:00.000Z",
      heartbeatAt: "2026-04-11T10:00:00.000Z",
      leaseExpiresAt: "2026-04-11T10:00:30.000Z"
    }),
    /simulated last-run write failure/
  );

  assert.equal(
    await store.readTextArtifact(artifacts.runLeasePath("assignment-rollback-invalid-pointer"), "lease"),
    undefined
  );
  assert.equal(
    await store.readJsonArtifact(artifacts.runRecordPath("assignment-rollback-invalid-pointer"), "record"),
    undefined
  );
});

test("host run store surfaces lease cleanup failure during claim rollback", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const runStore = new HostRunStore(store, "custom", artifacts);
  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  const originalDeleteArtifact = store.deleteArtifact.bind(store);
  let writeCount = 0;
  store.writeJsonArtifact = async (relativePath, value) => {
    writeCount += 1;
    if (writeCount === 2) {
      throw new Error("simulated last-run write failure");
    }
    return originalWriteJsonArtifact(relativePath, value);
  };
  store.deleteArtifact = async (relativePath) => {
    if (relativePath === artifacts.runLeasePath("assignment-rollback-cleanup")) {
      throw new Error("simulated lease cleanup failure");
    }
    return originalDeleteArtifact(relativePath);
  };

  await assert.rejects(
    runStore.claim({
      assignmentId: "assignment-rollback-cleanup",
      state: "running",
      startedAt: "2026-04-11T10:00:00.000Z",
      heartbeatAt: "2026-04-11T10:00:00.000Z",
      leaseExpiresAt: "2026-04-11T10:00:30.000Z"
    }),
    /rollback cleanup also failed/
  );

  assert.notEqual(
    await store.readTextArtifact(artifacts.runLeasePath("assignment-rollback-cleanup"), "lease"),
    undefined
  );
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

test("host run store escalates final persistence when lease cleanup fails", async () => {
  const store = new MemoryArtifactStore();
  const artifacts: HostRunArtifactPaths = {
    runRecordPath: (assignmentId) => `records/${assignmentId}.state`,
    runLeasePath: (assignmentId) => `locks/${assignmentId}.claim`,
    lastRunPath: () => "pointers/current-run"
  };
  const runStore = new HostRunStore(store, "custom", artifacts);
  const runningRecord: HostRunRecord = {
    assignmentId: "assignment-warning-cleanup",
    state: "running",
    startedAt: "2026-04-11T10:00:00.000Z",
    heartbeatAt: "2026-04-11T10:00:00.000Z",
    leaseExpiresAt: "2999-04-11T10:00:30.000Z"
  };
  const completedRecord: HostRunRecord = {
    assignmentId: "assignment-warning-cleanup",
    state: "completed",
    startedAt: "2026-04-11T10:00:00.000Z",
    completedAt: "2026-04-11T10:01:00.000Z",
    outcomeKind: "decision",
    summary: "Need a human decision."
  };

  await runStore.claim(runningRecord);

  const originalWriteJsonArtifact = store.writeJsonArtifact.bind(store);
  const originalDeleteArtifact = store.deleteArtifact.bind(store);
  let writes = 0;
  store.writeJsonArtifact = async (relativePath, value) => {
    writes += 1;
    if (relativePath === artifacts.lastRunPath() && writes >= 2) {
      throw new Error("simulated last-run persistence failure");
    }
    return originalWriteJsonArtifact(relativePath, value);
  };
  store.deleteArtifact = async (relativePath) => {
    if (relativePath === artifacts.runLeasePath("assignment-warning-cleanup")) {
      throw new Error("simulated lease cleanup failure");
    }
    return originalDeleteArtifact(relativePath);
  };

  await assert.rejects(
    runStore.persistWarning(completedRecord),
    /active lease cleanup failed/
  );

  assert.notEqual(
    await store.readTextArtifact(artifacts.runLeasePath("assignment-warning-cleanup"), "lease"),
    undefined
  );
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
