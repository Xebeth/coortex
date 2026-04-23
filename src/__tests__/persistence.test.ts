import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeConfig } from "../config/types.js";
import { withPathLock } from "../persistence/files.js";
import { ProjectionRecoveryService } from "../persistence/projection-recovery.js";
import { RuntimeStore } from "../persistence/store.js";
import { createBootstrapRuntime } from "../core/runtime.js";
import { applyRuntimeEvent, fromSnapshot, toSnapshot } from "../projections/runtime-projection.js";
import type { RuntimeEvent } from "../core/events.js";
import { nowIso } from "../utils/time.js";

test("runtime store rebuilds projection from durable events and snapshots", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });

  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const assignmentId = bootstrap.initialAssignmentId;
  const resultEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "result.submitted",
    payload: {
      result: {
        resultId: randomUUID(),
        assignmentId,
        producerId: "worker-1",
        status: "completed",
        summary: "Implemented persistence layer.",
        changedFiles: ["src/persistence/store.ts"],
        createdAt: nowIso()
      }
    }
  };

  await store.appendEvent(resultEvent);
  const rebuilt = await store.rebuildProjection();
  await store.writeSnapshot(toSnapshot(rebuilt));

  const loaded = await store.loadProjection();
  assert.equal(loaded.sessionId, sessionId);
  assert.equal(loaded.assignments.size, 1);
  assert.equal(loaded.results.size, 1);
  assert.equal(loaded.status.activeAdapter, "codex");
});

test("projection recovery service repairs a salvageable event log through store primitives", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-projection-recovery-repair-"));
  const store = RuntimeStore.forProject(projectRoot);
  const service = new ProjectionRecoveryService(store);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });
  await store.appendEvents(bootstrap.events);

  const resultEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "result.submitted",
    payload: {
      result: {
        resultId: randomUUID(),
        assignmentId: bootstrap.initialAssignmentId,
        producerId: "worker-1",
        status: "completed",
        summary: "Direct recovery service repair.",
        changedFiles: ["src/persistence/projection-recovery.ts"],
        createdAt: nowIso()
      }
    }
  };
  await store.appendEvent(resultEvent);
  await writeFile(store.eventsPath, `${await readFile(store.eventsPath, "utf8")}{"broken":\n`, "utf8");

  const warning = await service.repairEventLog();
  const repairedEvents = (await readFile(store.eventsPath, "utf8")).split("\n").filter(Boolean);
  const recovered = await service.loadProjectionWithRecovery();

  assert.match(warning ?? "", /Rewrote .*events\.ndjson with \d+ replayable event\(s\)\./);
  assert.equal(repairedEvents.length, bootstrap.events.length + 1);
  assert.equal(recovered.projection.results.size, 1);
  assert.equal(
    recovered.projection.results.get(resultEvent.payload.result.resultId)?.summary,
    "Direct recovery service repair."
  );
});

test("runtime store rejects malformed claim suffixes after the snapshot boundary", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-broken-claim-suffix-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });
  await store.appendEvents(bootstrap.events);
  await store.writeSnapshot(toSnapshot(await store.rebuildProjection()));

  await store.appendEvent({
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "claim.created",
    payload: {
      claim: {
        id: randomUUID(),
        assignmentId: bootstrap.initialAssignmentId,
        attachmentId: "missing-attachment",
        state: "active",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        provenance: {
          kind: "resume",
          source: "ctx.resume"
        }
      }
    }
  });

  await assert.rejects(
    store.loadProjectionWithRecovery(),
    /claim graph references missing attachments/
  );
  await assert.rejects(
    store.syncSnapshotFromEventsWithRecovery(),
    /claim graph references missing attachments/
  );
});

test("runtime store appendEvents preserves concurrent batch writers", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-concurrent-batches-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });
  await store.appendEvents(bootstrap.events);

  const batches = Array.from({ length: 20 }, (_, index) => {
    const timestamp = nowIso();
    return [
      {
        eventId: randomUUID(),
        sessionId,
        timestamp,
        type: "host.setup.completed" as const,
        payload: {
          adapter: "codex",
          host: "codex",
          completedAt: timestamp
        }
      },
      {
        eventId: randomUUID(),
        sessionId,
        timestamp,
        type: "host.setup.completed" as const,
        payload: {
          adapter: "codex",
          host: "codex",
          completedAt: timestamp
        }
      }
    ] satisfies RuntimeEvent[];
  });

  await Promise.all(batches.map((batch) => store.appendEvents(batch)));

  const events = await store.loadEvents();
  const appendedIds = new Set(events.slice(bootstrap.events.length).map((event) => event.eventId));

  assert.equal(events.length, bootstrap.events.length + batches.length * 2);
  assert.equal(appendedIds.size, batches.length * 2);
});

test("runtime store repair serializes with concurrent appenders", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-repair-lock-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });
  await store.appendEvents(bootstrap.events);
  await writeFile(store.eventsPath, `${await readFile(store.eventsPath, "utf8")}{"broken":\n`, "utf8");

  const assignmentId = bootstrap.initialAssignmentId;
  const resultId = randomUUID();
  const resultEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "result.submitted",
    payload: {
      result: {
        resultId,
        assignmentId,
        producerId: "worker-1",
        status: "completed",
        summary: "Concurrent append survives repair.",
        changedFiles: ["src/persistence/store.ts"],
        createdAt: nowIso()
      }
    }
  };

  const originalLoadEventLines = store.loadEventLines.bind(store);
  let releaseRecovery!: () => void;
  const recoveryReleased = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  let signalRecoveryEntered!: () => void;
  const recoveryEntered = new Promise<void>((resolve) => {
    signalRecoveryEntered = resolve;
  });
  let blocked = false;
  (store as RuntimeStore & {
    loadEventLines: RuntimeStore["loadEventLines"];
  }).loadEventLines = async () => {
    if (!blocked) {
      blocked = true;
      signalRecoveryEntered();
      await recoveryReleased;
    }
    return originalLoadEventLines();
  };

  const syncPromise = store.syncSnapshotFromEventsWithRecovery();
  await recoveryEntered;
  const appendPromise = store.appendEvents([resultEvent]);
  releaseRecovery();

  await Promise.all([syncPromise, appendPromise]);
  (store as RuntimeStore & {
    loadEventLines: RuntimeStore["loadEventLines"];
  }).loadEventLines = originalLoadEventLines;

  const recovered = await store.loadProjectionWithRecovery();
  const replayedResult = [...recovered.projection.results.values()].find((result) => result.resultId === resultId);

  assert.ok(replayedResult);
  assert.ok((await store.loadEvents()).some((event) => event.eventId === resultEvent.eventId));
});

test("runtime store serializes concurrent snapshot projection mutations", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-snapshot-mutate-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });
  await store.appendEvents(bootstrap.events);
  await store.syncSnapshotFromEvents();

  const assignmentId = bootstrap.initialAssignmentId;
  const buildResultEvent = (summary: string): RuntimeEvent => ({
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "result.submitted",
    payload: {
      result: {
        resultId: randomUUID(),
        assignmentId,
        producerId: "worker-1",
        status: "partial",
        summary,
        changedFiles: ["src/persistence/store.ts"],
        createdAt: nowIso()
      }
    }
  });

  let releaseFirstMutation!: () => void;
  const firstMutationReleased = new Promise<void>((resolve) => {
    releaseFirstMutation = resolve;
  });
  let signalFirstMutation!: () => void;
  const firstMutationEntered = new Promise<void>((resolve) => {
    signalFirstMutation = resolve;
  });

  const applyEvent = (
    projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>,
    event: RuntimeEvent
  ) => {
    const nextProjection = fromSnapshot(toSnapshot(projection));
    applyRuntimeEvent(nextProjection, event);
    return nextProjection;
  };

  const firstMutation = store.mutateSnapshotProjection(async (projection) => {
    signalFirstMutation();
    await firstMutationReleased;
    return applyEvent(projection, buildResultEvent("First serialized snapshot mutation."));
  });

  await firstMutationEntered;
  const secondMutation = store.mutateSnapshotProjection(async (projection) =>
    applyEvent(projection, buildResultEvent("Second serialized snapshot mutation."))
  );
  releaseFirstMutation();

  await Promise.all([firstMutation, secondMutation]);
  const snapshot = await store.loadSnapshot();
  const summaries = snapshot?.results.map((result) => result.summary).sort();

  assert.deepEqual(summaries, [
    "First serialized snapshot mutation.",
    "Second serialized snapshot mutation."
  ]);
});

test("runtime store snapshot recovery sync preserves newer snapshot-only truth under the lock", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-sync-lock-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });
  await store.appendEvents(bootstrap.events);
  await store.syncSnapshotFromEvents();

  const assignmentId = bootstrap.initialAssignmentId;
  const recoveredEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "result.submitted",
    payload: {
      result: {
        resultId: randomUUID(),
        assignmentId,
        producerId: "worker-1",
        status: "partial",
        summary: "Recovered event survives snapshot sync.",
        changedFiles: ["src/persistence/store.ts"],
        createdAt: nowIso()
      }
    }
  };
  const concurrentMutationEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "result.submitted",
    payload: {
      result: {
        resultId: randomUUID(),
        assignmentId,
        producerId: "worker-2",
        status: "partial",
        summary: "Concurrent snapshot mutation also survives.",
        changedFiles: ["src/persistence/store.ts"],
        createdAt: nowIso()
      }
    }
  };
  await store.appendEvent(recoveredEvent);

  const originalWithSnapshotLock = store.withSnapshotLock.bind(store);
  let releaseSyncLock!: () => void;
  const syncLockReleased = new Promise<void>((resolve) => {
    releaseSyncLock = resolve;
  });
  let signalSyncLockEntered!: () => void;
  const syncLockEntered = new Promise<void>((resolve) => {
    signalSyncLockEntered = resolve;
  });
  let blockedFirstSnapshotLock = false;
  (store as RuntimeStore & {
    withSnapshotLock: RuntimeStore["withSnapshotLock"];
  }).withSnapshotLock = async (action) => {
    if (!blockedFirstSnapshotLock) {
      blockedFirstSnapshotLock = true;
      signalSyncLockEntered();
      await syncLockReleased;
    }
    return originalWithSnapshotLock(action);
  };

  const syncPromise = store.syncSnapshotFromEventsWithRecovery();
  await syncLockEntered;
  let signalMutationEntered!: () => void;
  const mutationEntered = new Promise<void>((resolve) => {
    signalMutationEntered = resolve;
  });
  const mutationPromise = store.mutateSnapshotProjection((projection) => {
    signalMutationEntered();
    const nextProjection = fromSnapshot(toSnapshot(projection));
    applyRuntimeEvent(nextProjection, concurrentMutationEvent);
    return nextProjection;
  });
  await mutationEntered;
  await mutationPromise;
  releaseSyncLock();

  try {
    await syncPromise;
  } finally {
    (store as RuntimeStore & {
      withSnapshotLock: RuntimeStore["withSnapshotLock"];
    }).withSnapshotLock = originalWithSnapshotLock;
  }

  const syncResult = await syncPromise;
  const snapshot = await store.loadSnapshot();
  const summaries = snapshot?.results.map((result) => result.summary).sort();

  assert.equal(syncResult.projection.results.size, 1);
  assert.equal(
    [...syncResult.projection.results.values()][0]?.summary,
    "Concurrent snapshot mutation also survives."
  );
  assert.deepEqual(summaries, ["Concurrent snapshot mutation also survives."]);
});

test("withPathLock times out instead of reaping a live holder", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-live-lock-"));
  const lockPath = join(projectRoot, "runtime", "events.ndjson");
  let releaseHolder!: () => void;
  const holderReleased = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  let signalHolderEntered!: () => void;
  const holderEntered = new Promise<void>((resolve) => {
    signalHolderEntered = resolve;
  });
  let secondEntered = false;

  const firstHolder = withPathLock(lockPath, async () => {
    signalHolderEntered();
    await holderReleased;
  });

  await holderEntered;
  await assert.rejects(
    withPathLock(
      lockPath,
      async () => {
        secondEntered = true;
      },
      {
        retryMs: 5,
        timeoutMs: 25
      }
    ),
    /Timed out acquiring file lock/
  );

  assert.equal(secondEntered, false);
  releaseHolder();
  await firstHolder;
});

test("withPathLock times out instead of reaping an identity-unavailable holder", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-stale-lock-"));
  const lockPath = join(projectRoot, "runtime", "events.ndjson");
  const lockDir = `${lockPath}.lock`;
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: 999_999,
      acquiredAt: "2026-04-18T00:00:00.000Z"
    }),
    "utf8"
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  let entered = false;
  await assert.rejects(
    withPathLock(
      lockPath,
      async () => {
        entered = true;
      },
      {
        retryMs: 5,
        timeoutMs: 25
      }
    ),
    /Timed out acquiring file lock/
  );

  assert.equal(entered, false);
});

test("withPathLock reaps a stale holder when the pid identity does not match", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-reused-pid-lock-"));
  const lockPath = join(projectRoot, "runtime", "events.ndjson");
  const lockDir = `${lockPath}.lock`;
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      acquiredAt: "2026-04-18T00:00:00.000Z",
      processIdentity: "stale-holder"
    }),
    "utf8"
  );

  let entered = false;
  await withPathLock(lockPath, async () => {
    entered = true;
  });

  assert.equal(entered, true);
});

test("withPathLock times out instead of reaping unreadable owner metadata", async () => {
  if (process.platform === "win32") {
    return;
  }
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-unreadable-lock-"));
  const lockPath = join(projectRoot, "runtime", "events.ndjson");
  const lockDir = `${lockPath}.lock`;
  const ownerPath = join(lockDir, "owner.json");
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    ownerPath,
    JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      processIdentity: "unreadable-owner"
    }),
    "utf8"
  );
  await chmod(ownerPath, 0o000);

  let entered = false;
  try {
    await assert.rejects(
      withPathLock(
        lockPath,
        async () => {
          entered = true;
        },
        {
          retryMs: 5,
          timeoutMs: 25
        }
      ),
      /Timed out acquiring file lock/
    );
  } finally {
    await chmod(ownerPath, 0o600).catch(() => undefined);
  }

  assert.equal(entered, false);
});

test("withPathLock cleanup does not delete a newer owner when successor metadata is unreadable", async () => {
  if (process.platform === "win32") {
    return;
  }
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-unreadable-successor-"));
  const lockPath = join(projectRoot, "runtime", "events.ndjson");
  const lockDir = `${lockPath}.lock`;
  const ownerPath = join(lockDir, "owner.json");
  let releaseHolder!: () => void;
  const holderReleased = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  let holderEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    holderEntered = resolve;
  });

  const firstHolder = withPathLock(lockPath, async () => {
    holderEntered();
    await holderReleased;
  });

  await entered;
  await writeFile(
    ownerPath,
    JSON.stringify({
      pid: 999_997,
      acquiredAt: "2026-04-19T00:00:00.000Z",
      processIdentity: "unreadable-newer-holder"
    }),
    "utf8"
  );
  await chmod(ownerPath, 0o000);

  releaseHolder();
  await firstHolder;

  await chmod(ownerPath, 0o600);
  const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { processIdentity?: string };
  assert.equal(owner.processIdentity, "unreadable-newer-holder");
});

test("withPathLock cleanup does not delete a newer owner", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-owner-cleanup-"));
  const lockPath = join(projectRoot, "runtime", "events.ndjson");
  const lockDir = `${lockPath}.lock`;
  const ownerPath = join(lockDir, "owner.json");
  let releaseHolder!: () => void;
  const holderReleased = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  let holderEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    holderEntered = resolve;
  });

  const firstHolder = withPathLock(lockPath, async () => {
    holderEntered();
    await holderReleased;
  });

  await entered;
  await mkdir(lockDir, { recursive: true }).catch(() => undefined);
  await writeFile(
    ownerPath,
    JSON.stringify({
      pid: 999_998,
      acquiredAt: "2026-04-19T00:00:00.000Z",
      processIdentity: "newer-holder"
    }),
    "utf8"
  );

  releaseHolder();
  await firstHolder;

  const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { processIdentity?: string };
  assert.equal(owner.processIdentity, "newer-holder");
});


test("runtime store lease CAS survives a stale path lock from a reused pid", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-stale-cas-lock-"));
  const store = RuntimeStore.forProject(projectRoot);
  const relativePath = "adapters/custom/runs/assignment-1.lease.json";
  await store.writeTextArtifact(relativePath, "{\"state\":\"running\"}");
  const current = await store.readVersionedTextArtifact(relativePath, "custom run lease");
  const lockDir = join(store.rootDir, `${relativePath}.lock`);
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      acquiredAt: "2026-04-18T00:00:00.000Z",
      processIdentity: "stale-holder"
    }),
    "utf8"
  );

  const updated = await store.writeTextArtifactCas(
    relativePath,
    current.version,
    "{\"state\":\"completed\"}"
  );

  assert.equal(updated.ok, true);
  assert.equal((await store.readTextArtifact(relativePath, "custom run lease"))?.trim(), "{\"state\":\"completed\"}");
});

test("runtime store rebuildProjection stays strict on malformed events", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-strict-rebuild-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });
  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  await writeFile(store.eventsPath, `${await readFile(store.eventsPath, "utf8")}{"broken":\n`, "utf8");

  await assert.rejects(
    store.rebuildProjection(),
    /Failed to parse runtime event .*Unexpected end of JSON input/
  );
});

test("readJsonArtifact surfaces malformed JSON errors", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-json-"));
  const store = RuntimeStore.forProject(projectRoot);
  const config: RuntimeConfig = {
    version: 1,
    sessionId: randomUUID(),
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);

  const artifactPath = join(store.rootDir, "adapters", "codex", "broken.json");
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, "{not-valid-json", "utf8");

  await assert.rejects(
    store.readJsonArtifact("adapters/codex/broken.json", "broken artifact"),
    /Failed to parse broken artifact/
  );
});

test("runtime store falls back to the snapshot when the event log is malformed", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-malformed-events-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });

  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const snapshot = toSnapshot(await store.rebuildProjection());
  await store.writeSnapshot(snapshot);
  await writeFile(store.eventsPath, `${await readFile(store.eventsPath, "utf8")}{"broken":\n`, "utf8");

  const projection = await store.loadProjection();

  assert.equal(projection.sessionId, snapshot.sessionId);
  assert.deepEqual(projection.status.activeAssignmentIds, snapshot.status.activeAssignmentIds);
  assert.equal(projection.assignments.size, snapshot.assignments.length);
});

test("runtime store falls back to the snapshot when the event log is cleanly truncated past runtime.initialized", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-clean-truncation-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });

  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const rebuilt = await store.rebuildProjection();
  const snapshot = toSnapshot(rebuilt);
  await store.writeSnapshot(snapshot);

  const cleanTruncatedEvents = (await readFile(store.eventsPath, "utf8"))
    .trimEnd()
    .split("\n")
    .filter((line) => {
      const parsed = JSON.parse(line) as { type?: string };
      return parsed.type === "assignment.created";
    });
  assert.equal(cleanTruncatedEvents.length, 1);
  await writeFile(store.eventsPath, `${cleanTruncatedEvents[0]}\n`, "utf8");

  const recovered = await store.loadProjectionWithRecovery();
  const synced = await store.syncSnapshotFromEventsWithRecovery();
  const repairedSnapshot = await store.loadSnapshot();

  assert.match(recovered.warning ?? "", /(runtime\.initialized|snapshot boundary)/);
  assert.equal(recovered.projection.status.activeHost, snapshot.status.activeHost);
  assert.equal(recovered.projection.status.currentObjective, snapshot.status.currentObjective);
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, snapshot.status.activeAssignmentIds);
  assert.match(synced.warning ?? "", /(runtime\.initialized|snapshot boundary)/);
  assert.equal(repairedSnapshot?.status.activeHost, snapshot.status.activeHost);
  assert.equal(repairedSnapshot?.status.currentObjective, snapshot.status.currentObjective);
  assert.deepEqual(repairedSnapshot?.status.activeAssignmentIds, snapshot.status.activeAssignmentIds);
});

test("runtime store recovery matrix follows the snapshot boundary rule", async () => {
  const cases = [
    {
      name: "malformed tail rebuilds safely from the snapshot boundary",
      appendValidSuffix: false,
      corruptDependentSuffix: false,
      expectedResultCount: 0,
      warningPattern: /snapshot\.json plus replayable events after/i
    },
    {
      name: "malformed tail with replayable suffix keeps valid later events",
      appendValidSuffix: true,
      corruptDependentSuffix: false,
      expectedResultCount: 1,
      warningPattern: /snapshot\.json plus replayable events after/i
    },
    {
      name: "malformed suffix that no longer replays falls back to the snapshot",
      appendValidSuffix: false,
      corruptDependentSuffix: true,
      expectedResultCount: 0,
      warningPattern: /fell back to .*snapshot\.json/i
    }
  ] as const;

  for (const testCase of cases) {
    const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-recovery-matrix-"));
    const store = RuntimeStore.forProject(projectRoot);
    const sessionId = randomUUID();
    const config: RuntimeConfig = {
      version: 1,
      sessionId,
      adapter: "codex",
      host: "codex",
      rootPath: projectRoot,
      createdAt: nowIso()
    };

    await store.initialize(config);
    const bootstrap = createBootstrapRuntime({
      rootPath: projectRoot,
      sessionId,
      adapter: "codex",
      host: "codex"
    });
    for (const event of bootstrap.events) {
      await store.appendEvent(event);
    }

    const assignmentId = bootstrap.initialAssignmentId;
    await store.writeSnapshot(toSnapshot(await store.rebuildProjection()));

    if (testCase.appendValidSuffix) {
      await store.appendEvent({
        eventId: randomUUID(),
        sessionId,
        timestamp: nowIso(),
        type: "result.submitted",
        payload: {
          result: {
            resultId: randomUUID(),
            assignmentId,
            producerId: "worker-1",
            status: "partial",
            summary: "Replayable suffix result.",
            changedFiles: ["src/persistence/store.ts"],
            createdAt: nowIso()
          }
        }
      });
      await writeFile(store.eventsPath, `${await readFile(store.eventsPath, "utf8")}{"broken":\n`, "utf8");
    } else if (testCase.corruptDependentSuffix) {
      const decisionId = randomUUID();
      await store.appendEvent({
        eventId: randomUUID(),
        sessionId,
        timestamp: nowIso(),
        type: "decision.created",
        payload: {
          decision: {
            decisionId,
            assignmentId,
            requesterId: "codex",
            blockerSummary: "Need a decision.",
            options: [{ id: "wait", label: "Wait", summary: "Pause." }],
            recommendedOption: "wait",
            state: "open",
            createdAt: nowIso()
          }
        }
      });
      await store.appendEvent({
        eventId: randomUUID(),
        sessionId,
        timestamp: nowIso(),
        type: "decision.resolved",
        payload: {
          decisionId,
          resolvedAt: nowIso(),
          resolutionSummary: "Resolved."
        }
      });
      const lines = (await readFile(store.eventsPath, "utf8")).split("\n").filter(Boolean);
      await writeFile(store.eventsPath, `${lines.slice(0, 2).join("\n")}\n{"broken":\n${lines.at(-1)}\n`, "utf8");
    } else {
      await writeFile(store.eventsPath, `${await readFile(store.eventsPath, "utf8")}{"broken":\n`, "utf8");
    }

    const recovered = await store.loadProjectionWithRecovery();

    assert.equal(recovered.projection.results.size, testCase.expectedResultCount, testCase.name);
    assert.match(recovered.warning ?? "", testCase.warningPattern, testCase.name);
  }
});

test("runtime store falls back to the snapshot when a parseable suffix no longer applies cleanly", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-invalid-suffix-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });
  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const snapshot = toSnapshot(await store.rebuildProjection());
  await store.writeSnapshot(snapshot);
  await store.appendEvent({
    eventId: randomUUID(),
    sessionId,
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

  const recovered = await store.loadProjectionWithRecovery();

  assert.match(recovered.warning ?? "", /could not rebuild runtime state; fell back to .*snapshot\.json/i);
  assert.equal(recovered.projection.status.currentObjective, snapshot.status.currentObjective);
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, snapshot.status.activeAssignmentIds);
});

test("runtime store rebuilds from snapshot plus replayable events after a malformed tail", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-salvage-events-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });

  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const baseProjection = await store.rebuildProjection();
  await store.writeSnapshot(toSnapshot(baseProjection));

  const assignmentId = bootstrap.initialAssignmentId;
  const resultEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "result.submitted",
    payload: {
      result: {
        resultId: randomUUID(),
        assignmentId,
        producerId: "worker-1",
        status: "partial",
        summary: "Valid event after the snapshot.",
        changedFiles: ["src/persistence/store.ts"],
        createdAt: nowIso()
      }
    }
  };

  await store.appendEvent(resultEvent);
  await writeFile(store.eventsPath, `${await readFile(store.eventsPath, "utf8")}{"broken":\n`, "utf8");

  const { projection, warning } = await store.loadProjectionWithRecovery();
  const recovered = await store.syncSnapshotFromEventsWithRecovery();
  const persistedSnapshot = await store.loadSnapshot();
  const persistedEvents = await readFile(store.eventsPath, "utf8");

  assert.equal(projection.results.size, 1);
  assert.equal(projection.results.get(resultEvent.payload.result.resultId)?.summary, "Valid event after the snapshot.");
  assert.match(warning ?? "", /snapshot\.json plus replayable events after/i);
  assert.equal(recovered.projection.results.size, 1);
  assert.match(recovered.warning ?? "", /snapshot\.json plus replayable events after/i);
  assert.equal(persistedSnapshot?.results[0]?.summary, "Valid event after the snapshot.");
  assert.match(persistedEvents, /Valid event after the snapshot\./);
});

test("runtime store replays valid later events after a malformed middle line", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-malformed-middle-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });

  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const assignmentId = bootstrap.initialAssignmentId;
  const validResult: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "result.submitted",
    payload: {
      result: {
        resultId: randomUUID(),
        assignmentId,
        producerId: "worker-1",
        status: "partial",
        summary: "Later valid event survives mid-log corruption.",
        changedFiles: ["src/persistence/store.ts"],
        createdAt: nowIso()
      }
    }
  };

  const lines = (await readFile(store.eventsPath, "utf8")).split("\n").filter(Boolean);
  const corrupted = `${lines[0]}\n${lines[1]}\n{"broken":\n${JSON.stringify(validResult)}\n`;
  await writeFile(store.eventsPath, corrupted, "utf8");

  const { projection, warning } = await store.loadProjectionWithRecovery();

  assert.equal(projection.results.size, 1);
  assert.equal(projection.results.get(validResult.payload.result.resultId)?.summary, "Later valid event survives mid-log corruption.");
  assert.match(warning ?? "", /skipped malformed line 3/);
  assert.equal(await readFile(store.eventsPath, "utf8"), corrupted);
});

test("runtime store salvages repeated malformed lines and keeps later valid events", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-multi-malformed-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });

  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const assignmentId = bootstrap.initialAssignmentId;
  const resultOne: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "result.submitted",
    payload: {
      result: {
        resultId: randomUUID(),
        assignmentId,
        producerId: "worker-1",
        status: "partial",
        summary: "First valid result survives repeated corruption.",
        changedFiles: ["src/persistence/store.ts"],
        createdAt: nowIso()
      }
    }
  };
  const resultTwo: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "result.submitted",
    payload: {
      result: {
        resultId: randomUUID(),
        assignmentId,
        producerId: "worker-2",
        status: "partial",
        summary: "Second valid result also survives.",
        changedFiles: ["src/cli/commands.ts"],
        createdAt: nowIso()
      }
    }
  };

  const baseLines = (await readFile(store.eventsPath, "utf8")).split("\n").filter(Boolean);
  const corrupted = [
    baseLines[0],
    '{"broken":',
    baseLines[1],
    '{"stillBroken"',
    JSON.stringify(resultOne),
    JSON.stringify(resultTwo)
  ].join("\n") + "\n";
  await writeFile(store.eventsPath, corrupted, "utf8");

  const { projection, warning } = await store.loadProjectionWithRecovery();
  const repaired = await store.syncSnapshotFromEventsWithRecovery();
  const repairedEvents = (await readFile(store.eventsPath, "utf8")).split("\n").filter(Boolean);

  assert.equal(projection.results.size, 2);
  assert.equal(
    projection.results.get(resultOne.payload.result.resultId)?.summary,
    "First valid result survives repeated corruption."
  );
  assert.equal(
    projection.results.get(resultTwo.payload.result.resultId)?.summary,
    "Second valid result also survives."
  );
  assert.match(warning ?? "", /skipped malformed line 2/);
  assert.match(warning ?? "", /skipped malformed line 4/);
  assert.equal(repaired.projection.results.size, 2);
  assert.equal(repairedEvents.length, 4);
  assert.equal(await readFile(store.eventsPath, "utf8") === corrupted, false);
});

test("runtime store does not rewrite a salvaged log that no longer projects cleanly", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-invalid-salvage-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });

  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const dependentEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "assignment.updated",
    payload: {
      assignmentId: bootstrap.initialAssignmentId,
      patch: {
        state: "queued",
        updatedAt: nowIso()
      }
    }
  };
  await store.appendEvent(dependentEvent);

  const lines = (await readFile(store.eventsPath, "utf8")).split("\n").filter(Boolean);
  const corrupted = `{"broken":\n${lines.slice(1).join("\n")}\n`;
  await writeFile(store.eventsPath, corrupted, "utf8");

  const warning = await store.repairEventLog();

  assert.equal(warning, undefined);
  assert.equal(await readFile(store.eventsPath, "utf8"), corrupted);
  await assert.rejects(
    store.syncSnapshotFromEventsWithRecovery(),
    /no longer starts at runtime\.initialized/
  );
});

test("runtime store snapshot-only mutations preserve the durable event boundary", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-boundary-preserve-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });
  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }
  await store.syncSnapshotFromEvents();
  const boundaryBefore = (await store.loadSnapshot())?.lastEventId;
  assert.ok(boundaryBefore, "expected an event boundary before snapshot-only mutation");

  const assignmentId = bootstrap.initialAssignmentId;
  const snapshotOnlyTimestamp = nowIso();
  await store.mutateSnapshotProjection((projection) => {
    const assignment = projection.assignments.get(assignmentId)!;
    const assignments = new Map(projection.assignments);
    assignments.set(assignmentId, {
      ...assignment,
      state: "queued",
      updatedAt: snapshotOnlyTimestamp
    });
    return {
      ...projection,
      assignments,
      status: {
        ...projection.status,
        currentObjective: `Retry assignment ${assignmentId}: ${assignment.objective}`,
        lastDurableOutputAt: snapshotOnlyTimestamp
      }
    };
  });

  assert.equal((await store.loadSnapshot())?.lastEventId, boundaryBefore);

  await store.appendEvent({
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "result.submitted",
    payload: {
      result: {
        resultId: randomUUID(),
        assignmentId,
        producerId: "worker-1",
        status: "completed",
        summary: "Later event-log suffix survived the snapshot-only mutation.",
        changedFiles: ["src/persistence/store.ts"],
        createdAt: nowIso()
      }
    }
  });

  const recovered = await store.loadProjectionWithRecovery();
  assert.equal([...recovered.projection.results.values()].at(-1)?.summary, "Later event-log suffix survived the snapshot-only mutation.");
});

test("projection persistence handle snapshot fallback preserves later real event suffixes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-handle-boundary-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });
  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }
  const initialProjection = await store.syncSnapshotFromEvents();
  const boundaryBefore = (await store.loadSnapshot())?.lastEventId;
  assert.ok(boundaryBefore, "expected an event boundary before snapshot-fallback write");
  const originalEventLog = await readFile(store.eventsPath, "utf8");

  const assignmentId = bootstrap.initialAssignmentId;
  const timestamp = nowIso();
  const eventLines = (await readFile(store.eventsPath, "utf8")).trimEnd().split("\n");
  const boundaryIndex = eventLines.findIndex((line) => {
    const parsed = JSON.parse(line) as { eventId?: string };
    return parsed.eventId === boundaryBefore;
  });
  assert.ok(boundaryIndex >= 0, "expected to find the snapshot boundary before forcing fallback writes");
  eventLines[boundaryIndex] = "{\"broken\":";
  await writeFile(store.eventsPath, `${eventLines.join("\n")}\n`, "utf8");
  const fallbackLoaded = await store.loadProjectionWithRecovery();
  assert.match(fallbackLoaded.warning ?? "", /fell back to .*snapshot\.json/i);
  const projectionAfterFallback = await fallbackLoaded.persistence.persistEvents([
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "assignment.updated",
      payload: {
        assignmentId,
        patch: {
          state: "queued",
          updatedAt: timestamp
        }
      }
    }
  ]);
  assert.equal(projectionAfterFallback.projection.assignments.get(assignmentId)?.state, "queued");
  assert.equal((await store.loadSnapshot())?.lastEventId, boundaryBefore);
  await writeFile(store.eventsPath, originalEventLog, "utf8");

  await store.appendEvent({
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "decision.created",
    payload: {
      decision: {
        decisionId: randomUUID(),
        assignmentId,
        requesterId: "worker-1",
        blockerSummary: "Later durable decision survived the snapshot-fallback write.",
        options: [{ id: "wait", label: "Wait", summary: "Pause." }],
        recommendedOption: "wait",
        state: "open",
        createdAt: nowIso()
      }
    }
  });

  const recovered = await store.loadProjectionWithRecovery();
  assert.equal([...recovered.projection.decisions.values()].at(-1)?.blockerSummary, "Later durable decision survived the snapshot-fallback write.");
});

test("runtime store rebuilds from snapshot plus a structurally valid salvaged suffix", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-snapshot-fallback-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });
  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }
  await store.writeSnapshot(toSnapshot(await store.rebuildProjection()));

  await store.appendEvent({
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "assignment.updated",
    payload: {
      assignmentId: bootstrap.initialAssignmentId,
      patch: {
        state: "queued",
        updatedAt: nowIso()
      }
    }
  });

  const lines = (await readFile(store.eventsPath, "utf8")).split("\n").filter(Boolean);
  const corrupted = `{"broken":\n${lines.slice(1).join("\n")}\n`;
  await writeFile(store.eventsPath, corrupted, "utf8");

  const recovered = await store.loadProjectionWithRecovery();

  assert.equal(recovered.projection.assignments.size, 1);
  assert.equal(
    recovered.projection.assignments.get(bootstrap.initialAssignmentId)?.state,
    "queued"
  );
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, [bootstrap.initialAssignmentId]);
  assert.match(recovered.warning ?? "", /snapshot\.json plus replayable events after/i);
});

test("runtime store falls back to snapshot when a salvaged suffix no longer replays", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-suffix-fallback-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });
  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }
  const snapshot = toSnapshot(await store.rebuildProjection());
  await store.writeSnapshot(snapshot);

  const decisionId = randomUUID();
  await store.appendEvent({
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "decision.created",
    payload: {
      decision: {
        decisionId,
        assignmentId: bootstrap.initialAssignmentId,
        requesterId: "codex",
        blockerSummary: "Need a decision before continuing.",
        options: [{ id: "wait", label: "Wait", summary: "Pause." }],
        recommendedOption: "wait",
        state: "open",
        createdAt: nowIso()
      }
    }
  });
  await store.appendEvent({
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "decision.resolved",
    payload: {
      decisionId,
      resolvedAt: nowIso(),
      resolutionSummary: "Decision resolved after review."
    }
  });

  const lines = (await readFile(store.eventsPath, "utf8")).split("\n").filter(Boolean);
  const corrupted = `${lines.slice(0, 2).join("\n")}\n{"broken":\n${lines.at(-1)}\n`;
  await writeFile(store.eventsPath, `${corrupted}`, "utf8");
  const snapshotBefore = await readFile(store.snapshotPath, "utf8");
  const eventsBefore = await readFile(store.eventsPath, "utf8");

  const recovered = await store.syncSnapshotFromEventsWithRecovery();

  assert.equal(recovered.projection.decisions.size, 0);
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, [bootstrap.initialAssignmentId]);
  assert.match(recovered.warning ?? "", /fell back to .*snapshot\.json/i);
  assert.equal(await readFile(store.snapshotPath, "utf8"), snapshotBefore);
  assert.equal(await readFile(store.eventsPath, "utf8"), eventsBefore);
});

test("runtime store preserves the snapshot when the event log has no replayable lines", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-no-replayable-"));
  const store = RuntimeStore.forProject(projectRoot);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });
  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const snapshot = toSnapshot(await store.rebuildProjection());
  await store.writeSnapshot(snapshot);
  await writeFile(store.eventsPath, '{"broken":\n{"stillBroken"\n', "utf8");

  const repaired = await store.syncSnapshotFromEventsWithRecovery();
  const persistedSnapshot = await store.loadSnapshot();

  assert.equal(repaired.projection.assignments.size, 1);
  assert.deepEqual(repaired.projection.status.activeAssignmentIds, [bootstrap.initialAssignmentId]);
  assert.match(repaired.warning ?? "", /skipped malformed line 1/);
  assert.equal(await readFile(store.eventsPath, "utf8"), '{"broken":\n{"stillBroken"\n');
  assert.deepEqual(persistedSnapshot, snapshot);
});

test("projection recovery syncProjectionSnapshot preserves malformed replay warnings during snapshot fallback sync", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-fallback-sync-warning-"));
  const store = RuntimeStore.forProject(projectRoot);
  const service = new ProjectionRecoveryService(store);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });
  await store.appendEvents(bootstrap.events);
  await store.writeSnapshot(toSnapshot(await store.rebuildProjection()));
  await writeFile(store.eventsPath, `${await readFile(store.eventsPath, "utf8")}{"broken":\n`, "utf8");

  const synced = await service.syncProjectionSnapshot();

  assert.match(synced.warning ?? "", /skipped malformed line \d+/);
  assert.equal(synced.projection.assignments.size, 1);
  assert.deepEqual(synced.projection.status.activeAssignmentIds, [bootstrap.initialAssignmentId]);
});

test("projection recovery applyRecoveryProjectionEvents preserves malformed replay warnings during snapshot fallback repair", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-persistence-fallback-apply-warning-"));
  const store = RuntimeStore.forProject(projectRoot);
  const service = new ProjectionRecoveryService(store);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: nowIso()
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: "codex",
    host: "codex"
  });
  await store.appendEvents(bootstrap.events);
  const baseProjection = await store.rebuildProjection();
  await store.writeSnapshot(toSnapshot(baseProjection));
  await writeFile(store.eventsPath, `${await readFile(store.eventsPath, "utf8")}{"broken":\n`, "utf8");

  const updatedObjective = "Snapshot fallback warning propagation test.";
  const timestamp = nowIso();
  const repaired = await service.applyRecoveryProjectionEvents([
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "status.updated",
      payload: {
        status: {
          ...baseProjection.status,
          currentObjective: updatedObjective,
          lastDurableOutputAt: timestamp
        }
      }
    }
  ]);

  assert.match(repaired.warning ?? "", /skipped malformed line \d+/);
  assert.equal(repaired.projection.status.currentObjective, updatedObjective);
  assert.equal((await store.loadSnapshot())?.status.currentObjective, updatedObjective);
});
