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

test("recovery brief can suppress attachment-resume next actions when wrapped reclaim is unavailable", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-recovery-manual-resume-"));
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
  const timestamp = nowIso();
  const attachmentId = randomUUID();
  const claimId = randomUUID();
  const decisionId = randomUUID();

  const events: RuntimeEvent[] = [
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "attachment.created",
      payload: {
        attachment: {
          id: attachmentId,
          adapter: "codex",
          host: "codex",
          state: "detached_resumable",
          createdAt: timestamp,
          updatedAt: timestamp,
          detachedAt: timestamp,
          nativeSessionId: "thread-recovery-brief",
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "claim.created",
      payload: {
        claim: {
          id: claimId,
          assignmentId,
          attachmentId,
          state: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "decision.created",
      payload: {
        decision: {
          decisionId,
          assignmentId,
          requesterId: "worker-1",
          blockerSummary: "Need a human decision before continuing.",
          options: [
            { id: "wait", label: "Wait", summary: "Pause for input." },
            { id: "skip", label: "Skip", summary: "Skip the blocked work." }
          ],
          recommendedOption: "wait",
          state: "open",
          createdAt: timestamp
        }
      }
    }
  ];
  for (const event of events) {
    await store.appendEvent(event);
  }

  const projection = await store.rebuildProjection();
  const wrapped = buildRecoveryBrief(projection);
  const manual = buildRecoveryBrief(projection, {
    allowAttachmentResumeAction: false
  });

  assert.match(wrapped.nextRequiredAction, /Resume attachment/);
  assert.match(manual.nextRequiredAction, /Resolve decision/);
});

test("recovery brief does not advertise wrapped resume without a stored native session id", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-recovery-missing-native-id-"));
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
  const timestamp = nowIso();
  const attachmentId = randomUUID();
  const claimId = randomUUID();

  await store.appendEvents([
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "attachment.created",
      payload: {
        attachment: {
          id: attachmentId,
          adapter: "codex",
          host: "codex",
          state: "detached_resumable",
          createdAt: timestamp,
          updatedAt: timestamp,
          detachedAt: timestamp,
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "claim.created",
      payload: {
        claim: {
          id: claimId,
          assignmentId,
          attachmentId,
          state: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    }
  ]);

  const projection = await store.rebuildProjection();
  const brief = buildRecoveryBrief(projection);

  assert.doesNotMatch(brief.nextRequiredAction, /Resume attachment/);
  assert.match(brief.nextRequiredAction, /Continue assignment/);
});

test("recovery brief rejects duplicate active claims for the same assignment", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-recovery-duplicate-claims-"));
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

  const assignmentId = bootstrap.initialAssignmentId;
  const timestamp = nowIso();
  const firstAttachmentId = randomUUID();
  const secondAttachmentId = randomUUID();

  await store.appendEvents([
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "attachment.created",
      payload: {
        attachment: {
          id: firstAttachmentId,
          adapter: "codex",
          host: "codex",
          state: "detached_resumable",
          createdAt: timestamp,
          updatedAt: timestamp,
          detachedAt: timestamp,
          nativeSessionId: "thread-duplicate-1",
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "attachment.created",
      payload: {
        attachment: {
          id: secondAttachmentId,
          adapter: "codex",
          host: "codex",
          state: "detached_resumable",
          createdAt: timestamp,
          updatedAt: timestamp,
          detachedAt: timestamp,
          nativeSessionId: "thread-duplicate-2",
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "claim.created",
      payload: {
        claim: {
          id: randomUUID(),
          assignmentId,
          attachmentId: firstAttachmentId,
          state: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "claim.created",
      payload: {
        claim: {
          id: randomUUID(),
          assignmentId,
          attachmentId: secondAttachmentId,
          state: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    }
  ]);

  const projection = await store.rebuildProjection();

  assert.throws(() => buildRecoveryBrief(projection), /multiple active claims are present/);
});

test("recovery brief rejects ambiguous resumable attachments across active assignments", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-recovery-ambiguous-resume-"));
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

  const primaryAssignmentId = bootstrap.initialAssignmentId;
  const secondAssignmentId = randomUUID();
  const timestamp = nowIso();
  const firstAttachmentId = randomUUID();
  const secondAttachmentId = randomUUID();

  await store.appendEvents([
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "assignment.created",
      payload: {
        assignment: {
          id: secondAssignmentId,
          parentTaskId: "task-follow-up",
          workflow: "milestone-2",
          ownerType: "host",
          ownerId: "codex",
          objective: "Resume the follow-up assignment.",
          writeScope: ["README.md"],
          requiredOutputs: ["result"],
          state: "queued",
          createdAt: timestamp,
          updatedAt: timestamp
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "status.updated",
      payload: {
        status: {
          ...(await store.rebuildProjection()).status,
          activeAssignmentIds: [primaryAssignmentId, secondAssignmentId],
          lastDurableOutputAt: timestamp
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "attachment.created",
      payload: {
        attachment: {
          id: firstAttachmentId,
          adapter: "codex",
          host: "codex",
          state: "detached_resumable",
          createdAt: timestamp,
          updatedAt: timestamp,
          detachedAt: timestamp,
          nativeSessionId: "thread-ambiguous-1",
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "attachment.created",
      payload: {
        attachment: {
          id: secondAttachmentId,
          adapter: "codex",
          host: "codex",
          state: "detached_resumable",
          createdAt: timestamp,
          updatedAt: timestamp,
          detachedAt: timestamp,
          nativeSessionId: "thread-ambiguous-2",
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "claim.created",
      payload: {
        claim: {
          id: randomUUID(),
          assignmentId: primaryAssignmentId,
          attachmentId: firstAttachmentId,
          state: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId,
      timestamp,
      type: "claim.created",
      payload: {
        claim: {
          id: randomUUID(),
          assignmentId: secondAssignmentId,
          attachmentId: secondAttachmentId,
          state: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    }
  ]);

  const projection = await store.rebuildProjection();

  assert.throws(
    () => buildRecoveryBrief(projection),
    /multiple resumable attachments are present/
  );
});
