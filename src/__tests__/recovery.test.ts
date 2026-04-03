import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeConfig } from "../config/types.js";
import { RuntimeStore } from "../persistence/store.js";
import { createBootstrapRuntime } from "../core/runtime.js";
import { buildRecoveryBrief } from "../recovery/brief.js";
import type { RuntimeEvent } from "../core/events.js";
import { nowIso } from "../utils/time.js";

test("recovery brief derives actionable state from durable runtime artifacts", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-recovery-"));
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
        status: "partial",
        summary: "Wrote part of the recovery flow.",
        changedFiles: ["src/recovery/brief.ts"],
        createdAt: nowIso()
      }
    }
  };
  const decisionEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId,
    timestamp: nowIso(),
    type: "decision.created",
    payload: {
      decision: {
        decisionId: randomUUID(),
        assignmentId,
        requesterId: "worker-1",
        blockerSummary: "Choose whether to compact the recovery brief further.",
        options: [
          { id: "keep", label: "Keep", summary: "Keep the current recovery size." },
          { id: "compact", label: "Compact", summary: "Compact the recovery summary." }
        ],
        recommendedOption: "compact",
        state: "open",
        createdAt: nowIso()
      }
    }
  };

  await store.appendEvent(resultEvent);
  await store.appendEvent(decisionEvent);

  const projection = await store.rebuildProjection();
  const brief = buildRecoveryBrief(projection);

  assert.equal(brief.activeAssignments.length, 1);
  assert.equal(brief.lastDurableResults.length, 1);
  assert.equal(brief.unresolvedDecisions.length, 1);
  assert.match(brief.nextRequiredAction, /Resolve decision/);
});
