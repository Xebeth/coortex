import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
