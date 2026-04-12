import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeConfig } from "../config/types.js";
import { RuntimeStore } from "../persistence/store.js";
import { createBootstrapRuntime } from "../core/runtime.js";
import { toSnapshot } from "../projections/runtime-projection.js";
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
  await assert.rejects(store.syncSnapshotFromEventsWithRecovery(), /Cannot update missing assignment/);
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
