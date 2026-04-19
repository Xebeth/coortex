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
import { createEmptyProjection } from "../projections/runtime-projection.js";
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

test("recovery brief generation is deterministic for unchanged durable state", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-recovery-deterministic-"));
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

  const projection = await store.rebuildProjection();
  const first = buildRecoveryBrief(projection);
  const second = buildRecoveryBrief(projection);

  assert.deepEqual(second, first);
});

test("recovery brief ignores open decisions for inactive assignments", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-recovery-inactive-decision-"));
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

  const inactiveAssignmentId = randomUUID();
  const timestamp = nowIso();
  await store.appendEvent({
    eventId: randomUUID(),
    sessionId,
    timestamp,
    type: "assignment.created",
    payload: {
      assignment: {
        id: inactiveAssignmentId,
        parentTaskId: sessionId,
        workflow: "default",
        ownerType: "runtime",
        ownerId: "codex:test",
        objective: "Inactive blocked assignment should not steer the brief.",
        writeScope: ["README.md"],
        requiredOutputs: ["result"],
        state: "blocked",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    }
  });
  await store.appendEvent({
    eventId: randomUUID(),
    sessionId,
    timestamp,
    type: "decision.created",
    payload: {
      decision: {
        decisionId: "inactive-decision",
        assignmentId: inactiveAssignmentId,
        requesterId: "codex",
        blockerSummary: "Inactive decision should not displace the active assignment.",
        options: [{ id: "wait", label: "Wait", summary: "Pause." }],
        recommendedOption: "wait",
        state: "open",
        createdAt: timestamp
      }
    }
  });

  const projection = await store.rebuildProjection();
  const brief = buildRecoveryBrief(projection);

  assert.equal(brief.activeAssignments.length, 1);
  assert.deepEqual(brief.unresolvedDecisions, []);
  assert.doesNotMatch(brief.nextRequiredAction, /Resolve decision/);
  assert.match(
    brief.nextRequiredAction,
    new RegExp(`(?:Start|Continue) assignment ${bootstrap.initialAssignmentId}:`)
  );
});

test("workflow recovery brief ignores open decisions from earlier attempts", () => {
  const projection = createEmptyProjection("session-workflow-brief-attempts", "/tmp/project", "codex");
  const assignmentId = "review-assignment-current";
  const objective = "Assess the accepted plan artifact and produce a review verdict.";
  projection.assignments.set(assignmentId, {
    id: assignmentId,
    parentTaskId: "session-workflow-brief-attempts",
    workflow: "default",
    ownerType: "runtime",
    ownerId: "codex:bootstrap",
    objective,
    writeScope: ["src/"],
    requiredOutputs: ["reviewSummary"],
    state: "queued",
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T10:00:00.000Z"
  });
  projection.status = {
    activeMode: "solo",
    currentObjective: objective,
    activeAssignmentIds: [assignmentId],
    activeHost: "codex",
    activeAdapter: "codex",
    lastDurableOutputAt: "2026-04-19T10:00:00.000Z",
    resumeReady: true
  };
  projection.workflowProgress = {
    workflowId: "default",
    orderedModuleIds: ["plan", "review", "verify"],
    currentModuleId: "review",
    workflowCycle: 1,
    currentAssignmentId: assignmentId,
    currentModuleAttempt: 2,
    modules: {
      review: {
        moduleId: "review",
        workflowCycle: 1,
        moduleAttempt: 2,
        assignmentId,
        moduleState: "queued",
        sourceResultIds: [],
        sourceDecisionIds: [],
        artifactReferences: [],
        enteredAt: "2026-04-19T10:00:00.000Z"
      }
    }
  };
  projection.decisions.set("old-review-decision", {
    decisionId: "old-review-decision",
    assignmentId,
    requesterId: "codex",
    blockerSummary: "A prior-attempt decision should not block the current attempt.",
    options: [{ id: "wait", label: "Wait", summary: "Pause." }],
    recommendedOption: "wait",
    state: "open",
    createdAt: "2026-04-19T09:00:00.000Z"
  });

  const brief = buildRecoveryBrief(projection);

  assert.deepEqual(brief.unresolvedDecisions, []);
  assert.equal(
    brief.nextRequiredAction,
    `Start review assignment ${assignmentId}: ${objective}`
  );
});
