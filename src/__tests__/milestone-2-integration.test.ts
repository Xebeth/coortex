import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { CodexAdapter } from "../hosts/codex/adapter/index.js";
import type { CodexCommandRunner } from "../hosts/codex/adapter/cli.js";
import type { RuntimeConfig } from "../config/types.js";
import { getNativeRunId } from "../core/run-state.js";
import type { HostRunRecord } from "../core/types.js";
import type { RuntimeEvent } from "../core/events.js";
import { RuntimeStore } from "../persistence/store.js";
import {
  initRuntime,
  inspectRuntimeRun,
  loadReconciledProjectionWithDiagnostics,
  loadOperatorProjection,
  prepareResumeRuntime,
  resumeRuntime,
  runRuntime
} from "../cli/commands.js";
import { nowIso } from "../utils/time.js";

interface SmokeSetup {
  projectRoot: string;
  store: RuntimeStore;
  adapter: CodexAdapter;
  assignmentId: string;
}

async function countQueuedAssignmentUpdatedEvents(
  store: RuntimeStore,
  assignmentId: string
): Promise<number> {
  const events = (await store.loadEvents()) as Array<{
    type: string;
    payload: { assignmentId?: string; patch?: { state?: string } };
  }>;

  return events.filter(
    (event) =>
      event.type === "assignment.updated" &&
      event.payload.assignmentId === assignmentId &&
      event.payload.patch?.state === "queued"
  ).length;
}

test("milestone-2 integration: trimming keeps the real run envelope bounded and records trimming telemetry", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Follow-up smoke run completed.",
      changedFiles: ["src/hosts/codex/adapter/envelope.ts"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-trim" });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  await appendPartialResult(setup, "smoke-result-long", "trim-me ".repeat(250));
  const run = await runRuntime(setup.store, setup.adapter);
  const telemetry = await setup.store.loadTelemetry();
  const artifactPath = join(
    setup.projectRoot,
    ".coortex",
    "artifacts",
    "results",
    "smoke-result-long.txt"
  );
  const artifact = await readFile(artifactPath, "utf8");
  const startedTelemetry = findLastTelemetry(telemetry, "host.run.started");

  assert.equal(run.envelope.trimApplied, true);
  assert.equal(run.envelope.recentResults[0]?.trimmed, true);
  assert.equal(run.envelope.recentResults[0]?.reference, ".coortex/artifacts/results/smoke-result-long.txt");
  assert.ok(run.envelope.estimatedChars <= 4_000);
  assert.equal(artifact.trim(), ("trim-me ".repeat(250)).trim());
  assert.equal(startedTelemetry?.metadata.trimApplied, true);
  assert.equal(startedTelemetry?.metadata.trimmedFields, 1);
});

test("milestone-2 integration: resume reclaims snapshot-backed interrupted state after legacy live-lease normalization", async () => {
  let resumedSessionId = "";
  const setup = await createSmokeSetupWithRunner({
    runExec: async () => {
      throw new Error("runExec should not be used in interrupted recovery smoke test");
    },
    runResume: async (input) => {
      resumedSessionId = input.sessionId;
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "partial",
        resultSummary: "Resume captured additional interrupted progress.",
        changedFiles: ["src/cli/commands.ts"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.resumed", thread_id: input.sessionId });
      return {
        exitCode: 0,
        stdout: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } }),
        stderr: ""
      };
    }
  });

  await appendPartialResult(setup, "smoke-interrupted-partial", "Interrupted smoke work is partially complete.");
  await rm(join(setup.projectRoot, ".coortex", "runtime", "events.ndjson"));

  const runningRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    adapterData: {
      nativeRunId: "smoke-thread-interrupted"
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, runningRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, runningRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", runningRecord);

  const statusProjection = await loadOperatorProjection(setup.store);
  const reconciled = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);
  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const projectionAfterResume = await loadOperatorProjection(setup.store);
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
  const attachments = [...projectionAfterResume.attachments.values()];
  const claims = [...projectionAfterResume.claims.values()];
  const telemetry = await setup.store.loadTelemetry();
  const resumeStartedTelemetry = findLastTelemetry(telemetry, "host.resume.started");
  const resumeCompletedTelemetry = findLastTelemetry(telemetry, "host.resume.completed");

  assert.equal(statusProjection.status.activeAssignmentIds[0], setup.assignmentId);
  assert.deepEqual(reconciled.activeLeases, [setup.assignmentId]);
  assert.ok(
    reconciled.diagnostics.some((diagnostic) => diagnostic.code === "legacy-lease-normalized")
  );
  assert.equal(resumed.mode, "reclaimed");
  assert.equal(resumedSessionId, "smoke-thread-interrupted");
  assert.equal(resumed.attachment.nativeSessionId, "smoke-thread-interrupted");
  assert.equal(resumed.attachment.state, "detached_resumable");
  assert.equal(resumed.claim.assignmentId, setup.assignmentId);
  assert.equal(resumed.claim.state, "active");
  assert.equal(reconciled.projection.results.size, 1);
  assert.equal(
    [...reconciled.projection.results.values()][0]?.summary,
    "Interrupted smoke work is partially complete."
  );
  assert.equal(projectionAfterResume.results.size, 2);
  assert.equal(
    [...projectionAfterResume.results.values()].at(-1)?.summary,
    "Resume captured additional interrupted progress."
  );
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]?.state, "detached_resumable");
  assert.equal(attachments[0]?.nativeSessionId, "smoke-thread-interrupted");
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.state, "active");
  assert.equal(projectionAfterResume.assignments.get(setup.assignmentId)?.state, "in_progress");
  assert.equal(inspected?.assignmentId, setup.assignmentId);
  assert.equal(inspected?.state, "completed");
  assert.equal(inspected?.resultStatus, "partial");
  assert.equal(inspected?.summary, "Resume captured additional interrupted progress.");
  assert.equal(resumeStartedTelemetry?.assignmentId, setup.assignmentId);
  assert.equal(resumeStartedTelemetry?.metadata.attachmentId, attachments[0]?.id);
  assert.equal(resumeCompletedTelemetry?.assignmentId, setup.assignmentId);
  assert.equal(resumeCompletedTelemetry?.metadata.reclaimed, true);
  assert.equal(resumeCompletedTelemetry?.metadata.sessionVerified, true);
  assert.equal(resumeCompletedTelemetry?.metadata.outcomeKind, "result");
  assert.equal(resumeCompletedTelemetry?.metadata.resultStatus, "partial");
});

test("milestone-2 integration: prepareResumeRuntime stays read-only against live lease normalization candidates", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runExec should not be used in prepare-only smoke test");
  });

  const runningRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    adapterData: {
      nativeRunId: "smoke-thread-read-only-prepare"
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, runningRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, runningRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", runningRecord);

  const projectionBefore = await loadOperatorProjection(setup.store);
  const prepared = await prepareResumeRuntime(setup.store, setup.adapter);
  const projectionAfter = await loadOperatorProjection(setup.store);

  assert.equal(prepared.brief.activeAssignments.length, 1);
  assert.equal(prepared.envelope.metadata.activeAssignmentId, setup.assignmentId);
  assert.equal(prepared.diagnostics.length, 0);
  assert.equal(projectionBefore.attachments.size, 0);
  assert.equal(projectionBefore.claims.size, 0);
  assert.equal(projectionAfter.attachments.size, 0);
  assert.equal(projectionAfter.claims.size, 0);
});

test("milestone-2 integration: failed same-session reclaim orphans the attachment and requeues the assignment", async () => {
  let resumeAttempts = 0;
  const setup = await createSmokeSetupWithRunner({
    runExec: async (input) => {
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "partial",
        resultSummary: "Launch produced partial progress before reconnect was needed.",
        changedFiles: ["src/cli/commands.ts"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-reclaim-failure" });
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    },
    runResume: async (input) => {
      resumeAttempts += 1;
      assert.equal(input.sessionId, "smoke-thread-reclaim-failure");
      return {
        exitCode: 1,
        stdout: "",
        stderr: "resume failed for smoke-thread-reclaim-failure"
      };
    }
  });

  const firstRun = await runRuntime(setup.store, setup.adapter);
  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const projection = await loadOperatorProjection(setup.store);
  const attachment = [...projection.attachments.values()][0];
  const claim = [...projection.claims.values()][0];

  assert.equal(firstRun.execution.outcome.kind, "result");
  assert.equal(firstRun.execution.outcome.capture.status, "partial");
  assert.equal(firstRun.projectionAfter.attachments.size, 1);
  assert.equal(
    [...firstRun.projectionAfter.attachments.values()][0]?.state,
    "detached_resumable"
  );
  assert.equal(resumeAttempts, 1);
  assert.equal(resumed.mode, "prepared");
  assert.ok(
    resumed.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed")
  );
  assert.equal(attachment?.state, "orphaned");
  assert.equal(claim?.state, "orphaned");
  assert.match(attachment?.orphanedReason ?? "", /did not confirm the requested session/);
  assert.match(claim?.orphanedReason ?? "", /did not confirm the requested session/);
  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "queued");
  assert.deepEqual(projection.status.activeAssignmentIds, [setup.assignmentId]);
  assert.match(projection.status.currentObjective, new RegExp(`Retry assignment ${setup.assignmentId}:`));
});

test("milestone-2 integration: wrapped resume rejects a foreign native session reclaim and requeues the assignment", async () => {
  const setup = await createSmokeSetupWithRunner({
    runExec: async (input) => {
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "partial",
        resultSummary: "Launch produced partial progress before foreign reclaim coverage.",
        changedFiles: ["src/cli/commands.ts"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-foreign-expected" });
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    },
    runResume: async (input) => {
      await input.onEvent?.({ type: "thread.resumed", thread_id: "smoke-thread-foreign-observed" });
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    }
  });

  await runRuntime(setup.store, setup.adapter);
  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const projection = await loadOperatorProjection(setup.store);
  const attachment = [...projection.attachments.values()][0];
  const claim = [...projection.claims.values()][0];
  const telemetry = await setup.store.loadTelemetry();
  const resumeCompletedTelemetry = findLastTelemetry(telemetry, "host.resume.completed");

  assert.equal(resumed.mode, "prepared");
  assert.ok(
    resumed.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed")
  );
  assert.equal(attachment?.state, "orphaned");
  assert.equal(claim?.state, "orphaned");
  assert.match(attachment?.orphanedReason ?? "", /instead of requested session/);
  assert.match(claim?.orphanedReason ?? "", /instead of requested session/);
  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "queued");
  assert.equal(resumeCompletedTelemetry?.metadata.reclaimed, false);
  assert.equal(resumeCompletedTelemetry?.metadata.sessionVerified, false);
});

test("milestone-2 integration: snapshot-only reclaim failure preserves orphaned attachment truth and queued retry state", async () => {
  const setup = await createSmokeSetupWithRunner({
    runExec: async (input) => {
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "partial",
        resultSummary: "Launch produced partial progress before snapshot-only reclaim failure.",
        changedFiles: ["src/cli/commands.ts"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-snapshot-resume" });
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    },
    runResume: async () => {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "snapshot-only resume failed"
      };
    }
  });

  await runRuntime(setup.store, setup.adapter);
  await rm(join(setup.projectRoot, ".coortex", "runtime", "events.ndjson"));

  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const snapshot = await setup.store.loadSnapshot();
  const attachment = snapshot?.attachments?.[0];
  const claim = snapshot?.claims?.[0];

  assert.equal(resumed.mode, "prepared");
  assert.ok(
    resumed.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed")
  );
  assert.equal(attachment?.state, "orphaned");
  assert.equal(claim?.state, "orphaned");
  assert.match(attachment?.orphanedReason ?? "", /snapshot-only resume failed/);
  assert.match(claim?.orphanedReason ?? "", /snapshot-only resume failed/);
  assert.equal(snapshot?.assignments[0]?.state, "queued");
  assert.deepEqual(snapshot?.status.activeAssignmentIds, [setup.assignmentId]);
});

test("milestone-2 integration: provisional live-lease authority is promoted before same-session resume selection", async () => {
  let resumedSessionId = "";
  const setup = await createSmokeSetupWithRunner({
    runExec: async () => {
      throw new Error("runExec should not be used in provisional promotion smoke test");
    },
    runResume: async (input) => {
      resumedSessionId = input.sessionId;
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "partial",
        resultSummary: "Promoted provisional attachment resumed successfully.",
        changedFiles: ["src/cli/run-operations.ts"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.resumed", thread_id: input.sessionId });
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    }
  });

  const projection = await loadOperatorProjection(setup.store);
  const timestamp = nowIso();
  const attachmentId = randomUUID();
  const claimId = randomUUID();
  const provisionalEvents: RuntimeEvent[] = [
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "attachment.created",
      payload: {
        attachment: {
          id: attachmentId,
          adapter: "codex",
          host: "codex",
          state: "provisional",
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
      sessionId: projection.sessionId,
      timestamp,
      type: "claim.created",
      payload: {
        claim: {
          id: claimId,
          assignmentId: setup.assignmentId,
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
  ];
  for (const event of provisionalEvents) {
    await setup.store.appendEvent(event);
  }
  await setup.store.syncSnapshotFromEvents();

  const runningRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    adapterData: {
      nativeRunId: "smoke-thread-provisional-promoted"
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, runningRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, runningRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", runningRecord);

  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const projectionAfter = await loadOperatorProjection(setup.store);
  const attachment = projectionAfter.attachments.get(attachmentId);

  assert.equal(resumed.mode, "reclaimed");
  assert.equal(resumedSessionId, "smoke-thread-provisional-promoted");
  assert.ok(
    resumed.diagnostics.some((diagnostic) => diagnostic.code === "provisional-attachment-promoted")
  );
  assert.equal(attachment?.state, "detached_resumable");
  assert.equal(attachment?.nativeSessionId, "smoke-thread-provisional-promoted");
});

test("milestone-2 integration: wrapped resume persists a terminal completed result and releases attachment authority", async () => {
  const setup = await createSmokeSetupWithRunner({
    runExec: async (input) => {
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "partial",
        resultSummary: "Launch created resumable state before terminal resume coverage.",
        changedFiles: ["src/cli/commands.ts"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-terminal-resume" });
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    },
    runResume: async (input) => {
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "completed",
        resultSummary: "Wrapped resume finished the assignment.",
        changedFiles: ["src/cli/commands.ts", "src/cli/run-operations.ts"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.resumed", thread_id: input.sessionId });
      return {
        exitCode: 0,
        stdout: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 8, output_tokens: 5 } }),
        stderr: ""
      };
    }
  });

  await runRuntime(setup.store, setup.adapter);
  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const projection = await loadOperatorProjection(setup.store);
  const attachment = [...projection.attachments.values()][0];
  const claim = [...projection.claims.values()][0];
  const telemetry = await setup.store.loadTelemetry();
  const resumeCompletedTelemetry = findLastTelemetry(telemetry, "host.resume.completed");
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(resumed.mode, "reclaimed");
  assert.equal(attachment?.state, "released");
  assert.equal(claim?.state, "released");
  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "completed");
  assert.deepEqual(projection.status.activeAssignmentIds, []);
  assert.equal(projection.status.currentObjective, "Await the next assignment.");
  assert.equal(projection.results.size, 2);
  assert.equal([...projection.results.values()].at(-1)?.status, "completed");
  assert.equal([...projection.results.values()].at(-1)?.summary, "Wrapped resume finished the assignment.");
  assert.equal(inspected?.state, "completed");
  assert.equal(inspected?.resultStatus, "completed");
  assert.equal(inspected?.summary, "Wrapped resume finished the assignment.");
  assert.equal(resumeCompletedTelemetry?.metadata.reclaimed, true);
  assert.equal(resumeCompletedTelemetry?.metadata.sessionVerified, true);
  assert.equal(resumeCompletedTelemetry?.metadata.resultStatus, "completed");
});

test("milestone-2 integration: wrapped resume persists a decision outcome and keeps the claim resumable", async () => {
  const setup = await createSmokeSetupWithRunner({
    runExec: async (input) => {
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "partial",
        resultSummary: "Launch created resumable state before decision resume coverage.",
        changedFiles: ["src/cli/commands.ts"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-decision-resume" });
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    },
    runResume: async (input) => {
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "decision",
        resultStatus: "",
        resultSummary: "",
        changedFiles: [],
        blockerSummary: "Need operator guidance before continuing resumed work.",
        decisionOptions: [
          { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
          { id: "skip", label: "Skip", summary: "Skip the blocked step." }
        ],
        recommendedOption: "wait"
      });
      await input.onEvent?.({ type: "thread.resumed", thread_id: input.sessionId });
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    }
  });

  await runRuntime(setup.store, setup.adapter);
  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const projection = await loadOperatorProjection(setup.store);
  const attachment = [...projection.attachments.values()][0];
  const claim = [...projection.claims.values()][0];
  const decision = [...projection.decisions.values()].at(-1);
  const telemetry = await setup.store.loadTelemetry();
  const resumeCompletedTelemetry = findLastTelemetry(telemetry, "host.resume.completed");
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(resumed.mode, "reclaimed");
  assert.equal(attachment?.state, "detached_resumable");
  assert.equal(claim?.state, "active");
  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "blocked");
  assert.deepEqual(projection.status.activeAssignmentIds, [setup.assignmentId]);
  assert.equal(
    projection.status.currentObjective,
    "Need operator guidance before continuing resumed work."
  );
  assert.equal(decision?.state, "open");
  assert.equal(decision?.blockerSummary, "Need operator guidance before continuing resumed work.");
  assert.equal(decision?.recommendedOption, "wait");
  assert.equal(inspected?.state, "completed");
  assert.equal(inspected?.outcomeKind, "decision");
  assert.equal(inspected?.summary, "Need operator guidance before continuing resumed work.");
  assert.equal(resumeCompletedTelemetry?.metadata.reclaimed, true);
  assert.equal(resumeCompletedTelemetry?.metadata.sessionVerified, true);
  assert.equal(resumeCompletedTelemetry?.metadata.outcomeKind, "decision");
  assert.equal(resumeCompletedTelemetry?.metadata.resultStatus, "");
});

test("milestone-2 integration: run rejects foreign resumable claims and prevents duplicate issuance", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used when an authoritative attachment already owns the runtime");
  });

  const projection = await loadOperatorProjection(setup.store);
  const foreignAssignmentId = setup.assignmentId;
  const runnableAssignmentId = randomUUID();
  const timestamp = nowIso();
  const attachmentId = randomUUID();
  const claimId = randomUUID();
  const secondAssignmentEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.created",
    payload: {
      assignment: {
        id: runnableAssignmentId,
        parentTaskId: "task-foreign-claim",
        workflow: "milestone-2",
        ownerType: "host",
        ownerId: "codex",
        objective: "Try to run a different assignment while another claim is still authoritative.",
        writeScope: ["README.md"],
        requiredOutputs: ["result"],
        state: "queued",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    }
  };
  const statusEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "status.updated",
    payload: {
      status: {
        ...projection.status,
        activeAssignmentIds: [runnableAssignmentId],
        currentObjective: "Run the replacement assignment.",
        lastDurableOutputAt: timestamp
      }
    }
  };
  const attachmentEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
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
        nativeSessionId: "smoke-thread-foreign-claim",
        provenance: {
          kind: "launch",
          source: "ctx.run"
        }
      }
    }
  };
  const claimEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "claim.created",
    payload: {
      claim: {
        id: claimId,
        assignmentId: foreignAssignmentId,
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
  };

  for (const event of [secondAssignmentEvent, statusEvent, attachmentEvent, claimEvent]) {
    await setup.store.appendEvent(event);
  }
  await setup.store.syncSnapshotFromEvents();

  await assert.rejects(
    runRuntime(setup.store, setup.adapter),
    new RegExp(
      `Assignment ${foreignAssignmentId} already has an active host run lease\\. Claimed by attachment ${attachmentId}\\.`
    )
  );

  const projectionAfter = await loadOperatorProjection(setup.store);
  assert.deepEqual(projectionAfter.status.activeAssignmentIds, [runnableAssignmentId]);
  assert.equal(
    [...projectionAfter.claims.values()].filter((claim) => claim.state === "active").length,
    1
  );
  assert.equal(
    [...projectionAfter.attachments.values()].filter(
      (attachment) => attachment.state === "detached_resumable"
    ).length,
    1
  );
});

test("milestone-2 integration: resume fails deterministically when multiple resumable attachments exist", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used when resumable attachment cardinality is invalid");
  });

  const projection = await loadOperatorProjection(setup.store);
  const secondAssignmentId = randomUUID();
  const timestamp = nowIso();
  const secondAssignmentEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.created",
    payload: {
      assignment: {
        id: secondAssignmentId,
        parentTaskId: "task-multiple-attachments",
        workflow: "milestone-2",
        ownerType: "host",
        ownerId: "codex",
        objective: "Second assignment for invalid resumable attachment coverage.",
        writeScope: ["README.md"],
        requiredOutputs: ["result"],
        state: "queued",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    }
  };

  await setup.store.appendEvent(secondAssignmentEvent);
  for (const [assignmentId, nativeSessionId] of [
    [setup.assignmentId, "smoke-thread-attachment-one"],
    [secondAssignmentId, "smoke-thread-attachment-two"]
  ] as const) {
    const attachmentId = randomUUID();
    await setup.store.appendEvent({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
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
          nativeSessionId,
          provenance: {
            kind: "launch",
            source: "ctx.run"
          }
        }
      }
    });
    await setup.store.appendEvent({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "claim.created",
      payload: {
        claim: {
          id: randomUUID(),
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
    });
  }
  await setup.store.syncSnapshotFromEvents();

  await assert.rejects(
    resumeRuntime(setup.store, setup.adapter),
    /multiple resumable attachments are present/
  );
});

test("milestone-2 integration: launch without native identity finalization leaves no authoritative attachment behind", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "partial",
      resultSummary: "Partial work finished without surfacing a native session identity.",
      changedFiles: ["src/hosts/codex/adapter/index.ts"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const run = await runRuntime(setup.store, setup.adapter);
  const projection = await loadOperatorProjection(setup.store);
  const attachments = [...projection.attachments.values()];
  const claims = [...projection.claims.values()];

  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.status, "partial");
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]?.state, "orphaned");
  assert.equal(attachments[0]?.nativeSessionId, undefined);
  assert.match(
    attachments[0]?.orphanedReason ?? "",
    /without native session identity finalization/i
  );
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.state, "orphaned");
  assert.equal(
    claims.filter((claim) => claim.state === "active").length,
    0
  );
});

test("milestone-2 integration: profile and kernel artifacts are generated as small static files", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in profile smoke test");
  });

  const kernelPath = join(setup.projectRoot, ".coortex", "adapters", "codex", "kernel.md");
  const profilePath = join(setup.projectRoot, ".coortex", "adapters", "codex", "profile.json");
  const codexConfigPath = join(setup.projectRoot, ".codex", "config.toml");

  const kernel = await readFile(kernelPath, "utf8");
  const profile = JSON.parse(await readFile(profilePath, "utf8")) as { modelInstructionsFile: string };
  const codexConfig = await readFile(codexConfigPath, "utf8");
  const kernelStats = await stat(kernelPath);

  assert.match(kernel, /# Coortex Codex Kernel/);
  assert.match(kernel, /Consult Coortex runtime state before acting\./);
  assert.doesNotMatch(kernel, /activeAssignmentIds|sessionId|runtime\/snapshot/);
  assert.ok(kernelStats.size < 512);
  assert.equal(profile.modelInstructionsFile, kernelPath);
  assert.match(codexConfig, /# BEGIN COORTEX CODEX PROFILE/);
  assert.match(codexConfig, /model_instructions_file = ".*kernel\.md"/);
});

test("milestone-2 integration: telemetry write failures do not block init, resume, or run", async () => {
  let invocationCount = 0;
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-m2-telemetry-failure-"));
  await mkdir(join(projectRoot, ".coortex", "runtime", "telemetry.ndjson"), { recursive: true });

  const store = RuntimeStore.forProject(projectRoot);
  const adapter = new CodexAdapter({
    async startExec(input) {
      invocationCount += 1;
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "completed",
        resultSummary: "Telemetry failure path still completed the run.",
        changedFiles: ["README.md"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-telemetry" });
      return {
        result: Promise.resolve({
          exitCode: 0,
          stdout: "",
          stderr: ""
        }),
        terminate: async () => undefined,
        waitForExit: async () => ({ code: 0 })
      };
    },
    runExec: async () => {
      throw new Error("runExec should not be called when startExec is stubbed");
    }
  });

  const initialized = await initRuntime(projectRoot, store, adapter);
  assert.ok(initialized);

  const resumed = await resumeRuntime(store, adapter);
  const run = await runRuntime(store, adapter);
  const snapshot = await store.loadSnapshot();

  assert.equal(resumed.brief.activeAssignments.length, 1);
  assert.ok(resumed.diagnostics.some((diagnostic) => diagnostic.code === "telemetry-write-failed"));
  assert.equal(invocationCount, 1);
  assert.equal(run.execution.outcome.kind, "result");
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "telemetry-write-failed"));
  assert.equal(snapshot?.results.length, 1);
  assert.equal(snapshot?.results[0]?.status, "completed");
});

test("milestone-2 integration: final run-record write failures do not drop a completed host outcome", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Completed host outcome survived a final run-record write failure.",
      changedFiles: ["src/hosts/codex/adapter/index.ts"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-persist-warning" });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const originalWriteJsonArtifact = setup.store.writeJsonArtifact.bind(setup.store);
  let failedFinalWrite = false;
  (setup.store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
  }).writeJsonArtifact = async (artifactPath, value) => {
    if (
      artifactPath === `adapters/codex/runs/${setup.assignmentId}.json` &&
      !failedFinalWrite &&
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      value.state === "completed"
    ) {
      failedFinalWrite = true;
      throw new Error("simulated final run-record write failure");
    }
    return originalWriteJsonArtifact(artifactPath, value);
  };

  const run = await runRuntime(setup.store, setup.adapter);
  const projection = await loadOperatorProjection(setup.store);
  const snapshot = await setup.store.loadSnapshot();

  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.status, "completed");
  assert.match(run.execution.warning ?? "", /final run record could not be persisted/i);
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "completed");
  assert.equal(snapshot?.results.at(-1)?.summary, "Completed host outcome survived a final run-record write failure.");
  assert.equal(snapshot?.status.activeAssignmentIds.length, 0);
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: completed host outcomes are not reported as recovered when no durable terminal record exists", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "This outcome should not be synthesized without durable host metadata.",
      changedFiles: ["src/cli/commands.ts"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-no-durable-recovery" });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const originalWriteJsonArtifact = setup.store.writeJsonArtifact.bind(setup.store);
  let failedFinalWrite = false;
  (setup.store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
  }).writeJsonArtifact = async (artifactPath, value) => {
    if (
      artifactPath === `adapters/codex/runs/${setup.assignmentId}.json` &&
      !failedFinalWrite &&
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      value.state === "completed"
    ) {
      failedFinalWrite = true;
      throw new Error("simulated final run-record write failure");
    }
    return originalWriteJsonArtifact(artifactPath, value);
  };

  const originalAppendEvents = setup.store.appendEvents.bind(setup.store);
  let failedOutcomeAppend = false;
  (setup.store as RuntimeStore & {
    appendEvents: RuntimeStore["appendEvents"];
  }).appendEvents = async (events) => {
    if (!failedOutcomeAppend && events.some((event) => event.type === "result.submitted")) {
      failedOutcomeAppend = true;
      throw new Error("simulated runtime event persistence failure");
    }
    await originalAppendEvents(events);
  };

  await assert.rejects(
    runRuntime(setup.store, setup.adapter),
    /simulated runtime event persistence failure/
  );

  (setup.store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
    appendEvents: RuntimeStore["appendEvents"];
  }).writeJsonArtifact = originalWriteJsonArtifact;
  (setup.store as RuntimeStore & {
    appendEvents: RuntimeStore["appendEvents"];
  }).appendEvents = originalAppendEvents;

  const projection = await loadOperatorProjection(setup.store);
  const snapshot = await setup.store.loadSnapshot();
  const persistedRun = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "in_progress");
  assert.deepEqual(projection.status.activeAssignmentIds, [setup.assignmentId]);
  assert.equal(snapshot?.results.length, 0);
  assert.equal(persistedRun?.state, "completed");
  assert.equal(persistedRun?.terminalOutcome, undefined);
  assert.equal(persistedRun?.staleReasonCode, "missing_lease_artifact");
});

test("milestone-2 integration: run recovers a durable outcome even if the adapter throws after completion", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Adapter throw recovery still preserved the durable result.",
      changedFiles: ["src/cli/commands.ts"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-adapter-throw" });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const originalExecuteAssignment = setup.adapter.executeAssignment.bind(setup.adapter);
  setup.adapter.executeAssignment = async (store, projection, envelope, claimedRun) => {
    const execution = await originalExecuteAssignment(store, projection, envelope, claimedRun);
    throw new Error(`simulated adapter throw after ${execution.run.state}`);
  };

  const run = await runRuntime(setup.store, setup.adapter);
  const snapshot = await setup.store.loadSnapshot();

  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.status, "completed");
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(run.projectionAfter.assignments.get(setup.assignmentId)?.state, "completed");
  assert.equal(snapshot?.results.at(-1)?.assignmentId, setup.assignmentId);
  assert.deepEqual(run.projectionAfter.status.activeAssignmentIds, []);
  assert.equal(await countQueuedAssignmentUpdatedEvents(setup.store, setup.assignmentId), 0);
});

test("milestone-2 integration: completed host recovery finishes convergence when only the terminal event is already durable", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used in terminal-only recovery setup");
  });
  const completedAt = nowIso();
  const resultId = "result-terminal-only-recovery";
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, {
    assignmentId: setup.assignmentId,
    state: "completed",
    startedAt: completedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Recovered completed host run after only the terminal event persisted.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId,
        producerId: "codex",
        status: "completed",
        summary: "Recovered completed host run after only the terminal event persisted.",
        changedFiles: ["src/cli/run-operations.ts"],
        createdAt: completedAt
      }
    },
    adapterData: {
      nativeRunId: "smoke-thread-terminal-only"
    }
  });
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", {
    assignmentId: setup.assignmentId,
    state: "completed",
    startedAt: completedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Recovered completed host run after only the terminal event persisted.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId,
        producerId: "codex",
        status: "completed",
        summary: "Recovered completed host run after only the terminal event persisted.",
        changedFiles: ["src/cli/run-operations.ts"],
        createdAt: completedAt
      }
    },
    adapterData: {
      nativeRunId: "smoke-thread-terminal-only"
    }
  });
  await setup.store.appendEvent({
    eventId: randomUUID(),
    sessionId: (await loadOperatorProjection(setup.store)).sessionId,
    timestamp: completedAt,
    type: "result.submitted",
    payload: {
      result: {
        resultId,
        assignmentId: setup.assignmentId,
        producerId: "codex",
        status: "completed",
        summary: "Recovered completed host run after only the terminal event persisted.",
        changedFiles: ["src/cli/run-operations.ts"],
        createdAt: completedAt
      }
    }
  });
  await setup.store.syncSnapshotFromEvents();

  const recovered = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);
  const snapshot = await setup.store.loadSnapshot();

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.ok(!recovered.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(recovered.projection.assignments.get(setup.assignmentId)?.state, "completed");
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, []);
  assert.equal(snapshot?.results.at(-1)?.assignmentId, setup.assignmentId);
  assert.equal(await countQueuedAssignmentUpdatedEvents(setup.store, setup.assignmentId), 0);
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: completed host recovery reuses the original durable result id", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used in stable-result recovery setup");
  });
  const completedAt = nowIso();
  const resultId = "result-stable-recovery-id";
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, {
    assignmentId: setup.assignmentId,
    state: "completed",
    startedAt: completedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Recovered completed host run keeps a stable result id.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId,
        producerId: "codex",
        status: "completed",
        summary: "Recovered completed host run keeps a stable result id.",
        changedFiles: ["src/cli/run-operations.ts"],
        createdAt: completedAt
      }
    },
    adapterData: {
      nativeRunId: "smoke-thread-stable-result-id"
    }
  });
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", {
    assignmentId: setup.assignmentId,
    state: "completed",
    startedAt: completedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Recovered completed host run keeps a stable result id.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId,
        producerId: "codex",
        status: "completed",
        summary: "Recovered completed host run keeps a stable result id.",
        changedFiles: ["src/cli/run-operations.ts"],
        createdAt: completedAt
      }
    },
    adapterData: {
      nativeRunId: "smoke-thread-stable-result-id"
    }
  });
  await setup.store.appendEvent({
    eventId: randomUUID(),
    sessionId: (await loadOperatorProjection(setup.store)).sessionId,
    timestamp: completedAt,
    type: "result.submitted",
    payload: {
      result: {
        resultId,
        assignmentId: setup.assignmentId,
        producerId: "codex",
        status: "completed",
        summary: "Recovered completed host run keeps a stable result id.",
        changedFiles: ["src/cli/run-operations.ts"],
        createdAt: completedAt
      }
    }
  });
  await setup.store.syncSnapshotFromEvents();

  const recovered = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);
  const results = [...recovered.projection.results.values()].filter(
    (result) => result.assignmentId === setup.assignmentId
  );

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.ok(!recovered.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(recovered.projection.assignments.get(setup.assignmentId)?.state, "completed");
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, []);
  assert.equal(await countQueuedAssignmentUpdatedEvents(setup.store, setup.assignmentId), 0);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.resultId, resultId);
});

test("milestone-2 integration: non-terminal persist warnings still clear the finished lease", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "decision",
      resultStatus: "",
      resultSummary: "",
      changedFiles: [],
      blockerSummary: "Need approval before continuing the active assignment.",
      decisionOptions: [{ id: "wait", label: "Wait", summary: "Pause until guidance arrives." }],
      recommendedOption: "wait"
    });
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-decision-persist-warning" });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const originalWriteJsonArtifact = setup.store.writeJsonArtifact.bind(setup.store);
  let failedDecisionWrite = false;
  (setup.store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
  }).writeJsonArtifact = async (artifactPath, value) => {
    if (
      artifactPath === `adapters/codex/runs/${setup.assignmentId}.json` &&
      !failedDecisionWrite &&
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      value.state === "completed"
    ) {
      failedDecisionWrite = true;
      throw new Error("simulated decision run-record write failure");
    }
    return originalWriteJsonArtifact(artifactPath, value);
  };

  const run = await runRuntime(setup.store, setup.adapter);

  assert.equal(run.execution.outcome.kind, "decision");
  assert.match(run.execution.warning ?? "", /final run record could not be persisted/i);
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: pre-launch claim failures leave runtime state unchanged", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used when pre-launch claim fails");
  });

  const originalWriteJsonArtifact = setup.store.writeJsonArtifact.bind(setup.store);
  let failedClaimWrite = false;
  (setup.store as RuntimeStore & {
    writeJsonArtifact: RuntimeStore["writeJsonArtifact"];
  }).writeJsonArtifact = async (artifactPath, value) => {
    if (
      artifactPath === `adapters/codex/runs/${setup.assignmentId}.json` &&
      !failedClaimWrite &&
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      value.state === "running"
    ) {
      failedClaimWrite = true;
      throw new Error("simulated pre-launch claim failure");
    }
    return originalWriteJsonArtifact(artifactPath, value);
  };

  await assert.rejects(
    runRuntime(setup.store, setup.adapter),
    /simulated pre-launch claim failure/
  );
  const projection = await loadOperatorProjection(setup.store);
  const snapshot = await setup.store.loadSnapshot();
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "in_progress");
  assert.equal(snapshot?.results.length, 0);
  assert.deepEqual(snapshot?.status.activeAssignmentIds, [setup.assignmentId]);
  assert.equal(inspected, undefined);
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: launch authority batch persistence failures roll back the claimed lease", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used when authority persistence fails");
  });

  const originalClaimRunLease = setup.adapter.claimRunLease.bind(setup.adapter);
  let claimAttempted = false;
  setup.adapter.claimRunLease = async (store, projection, assignmentId) => {
    claimAttempted = true;
    return originalClaimRunLease(store, projection, assignmentId);
  };

  const originalAppendEvents = setup.store.appendEvents.bind(setup.store);
  let failedAuthorityAppend = false;
  (setup.store as RuntimeStore & {
    appendEvents: RuntimeStore["appendEvents"];
  }).appendEvents = async (events) => {
    if (
      !failedAuthorityAppend &&
      events.length === 2 &&
      events[0]?.type === "attachment.created" &&
      events[1]?.type === "claim.created"
    ) {
      failedAuthorityAppend = true;
      throw new Error("simulated launch authority persistence failure");
    }
    return originalAppendEvents(events);
  };

  await assert.rejects(
    runRuntime(setup.store, setup.adapter),
    /simulated launch authority persistence failure/
  );
  const projection = await loadOperatorProjection(setup.store);
  const snapshot = await setup.store.loadSnapshot();
  const events = await setup.store.loadEvents();
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(claimAttempted, true);
  assert.equal(projection.attachments.size, 0);
  assert.equal(projection.claims.size, 0);
  assert.equal(snapshot?.attachments?.length ?? 0, 0);
  assert.equal(snapshot?.claims?.length ?? 0, 0);
  assert.equal(events.some((event) => event.type === "attachment.created"), false);
  assert.equal(events.some((event) => event.type === "claim.created"), false);
  assert.equal(inspected, undefined);
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: legacy lease normalization batch failures do not synthesize partial authority", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used in legacy normalization fault injection");
  });
  const runningRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    adapterData: {
      nativeRunId: "smoke-thread-legacy-batch-failure"
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, runningRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, runningRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", runningRecord);

  const originalAppendEvents = setup.store.appendEvents.bind(setup.store);
  let failedNormalizationBatch = false;
  (setup.store as RuntimeStore & {
    appendEvents: RuntimeStore["appendEvents"];
  }).appendEvents = async (events) => {
    if (
      !failedNormalizationBatch &&
      events.length === 2 &&
      events[0]?.type === "attachment.created" &&
      events[1]?.type === "claim.created"
    ) {
      failedNormalizationBatch = true;
      throw new Error("simulated legacy normalization batch failure");
    }
    return originalAppendEvents(events);
  };

  await assert.rejects(
    loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter),
    /simulated legacy normalization batch failure/
  );
  const projection = await loadOperatorProjection(setup.store);
  const snapshot = await setup.store.loadSnapshot();
  const events = await setup.store.loadEvents();
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(projection.attachments.size, 0);
  assert.equal(projection.claims.size, 0);
  assert.equal(snapshot?.attachments?.length ?? 0, 0);
  assert.equal(snapshot?.claims?.length ?? 0, 0);
  assert.equal(events.some((event) => event.type === "attachment.created"), false);
  assert.equal(events.some((event) => event.type === "claim.created"), false);
  assert.equal(inspected?.state, "running");
  assert.equal(getNativeRunId(inspected), "smoke-thread-legacy-batch-failure");
});

test("milestone-2 integration: equivalent executions produce stable persisted shapes", async () => {
  const [first, second] = await Promise.all([
    createSmokeSetup(stableRunner("repeatable thread", "Repeatable smoke result.")),
    createSmokeSetup(stableRunner("repeatable thread", "Repeatable smoke result."))
  ]);

  const firstRun = await runRuntime(first.store, first.adapter);
  const secondRun = await runRuntime(second.store, second.adapter);
  const firstSnapshot = await first.store.loadSnapshot();
  const secondSnapshot = await second.store.loadSnapshot();
  const firstTelemetry = findLastTelemetry(await first.store.loadTelemetry(), "host.run.completed");
  const secondTelemetry = findLastTelemetry(await second.store.loadTelemetry(), "host.run.completed");

  assert.deepEqual(
    normalizeRunArtifacts(firstRun, firstSnapshot, firstTelemetry),
    normalizeRunArtifacts(secondRun, secondSnapshot, secondTelemetry)
  );
});

test("milestone-2 integration: resume uses the latest projection across multiple stale leases", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in multi-stale reconciliation smoke test");
  });

  const projection = await loadOperatorProjection(setup.store);
  const secondAssignmentId = randomUUID();
  const timestamp = nowIso();
  const secondAssignmentEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.created",
    payload: {
      assignment: {
        id: secondAssignmentId,
        parentTaskId: "task-follow-up",
        workflow: "milestone-2",
        ownerType: "host",
        ownerId: "codex",
        objective: undefined as unknown as string,
        writeScope: ["README.md"],
        requiredOutputs: ["result"],
        state: "queued",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    }
  };
  const statusEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "status.updated",
    payload: {
      status: {
        ...projection.status,
        activeAssignmentIds: [setup.assignmentId, secondAssignmentId],
        lastDurableOutputAt: timestamp
      }
    }
  };
  for (const event of [secondAssignmentEvent, statusEvent]) {
    await setup.store.appendEvent(event);
  }
  await setup.store.syncSnapshotFromEvents();

  const staleAt = new Date(Date.now() - 60_000).toISOString();
  const expiredAt = new Date(Date.now() - 1_000).toISOString();
  const firstExpiredRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-stale-first" },
    startedAt: staleAt,
    heartbeatAt: staleAt,
    leaseExpiresAt: expiredAt
  };
  const secondExpiredRecord: HostRunRecord = {
    assignmentId: secondAssignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-stale-second" },
    startedAt: staleAt,
    heartbeatAt: staleAt,
    leaseExpiresAt: expiredAt
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, firstExpiredRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${secondAssignmentId}.json`, secondExpiredRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", secondExpiredRecord);

  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const snapshot = await setup.store.loadSnapshot();
  const staleDiagnostics = resumed.diagnostics.filter(
    (diagnostic) => diagnostic.code === "stale-run-reconciled"
  );

  assert.equal(staleDiagnostics.length, 2);
  assert.equal(snapshot?.assignments.find((assignment) => assignment.id === setup.assignmentId)?.state, "queued");
  assert.equal(snapshot?.assignments.find((assignment) => assignment.id === secondAssignmentId)?.state, "queued");
  assert.deepEqual(snapshot?.status.activeAssignmentIds, [setup.assignmentId, secondAssignmentId]);
  assert.match(snapshot?.status.currentObjective ?? "", new RegExp(setup.assignmentId));
  assert.match(snapshot?.status.currentObjective ?? "", new RegExp(secondAssignmentId));
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${secondAssignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: run chooses a later active assignment when an earlier one is blocked", async () => {
  let invocationCount = 0;
  let promptSeen = "";
  const setup = await createSmokeSetup(async (input) => {
    invocationCount += 1;
    promptSeen = input.prompt;
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Second active assignment ran successfully.",
      changedFiles: [],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const projection = await loadOperatorProjection(setup.store);
  const blockedAssignmentId = setup.assignmentId;
  const runnableAssignmentId = randomUUID();
  const timestamp = nowIso();
  const newAssignmentEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.created",
    payload: {
      assignment: {
        id: runnableAssignmentId,
        parentTaskId: "task-follow-up",
        workflow: "milestone-2",
        ownerType: "host",
        ownerId: "codex",
        objective: "Handle the second active assignment.",
        writeScope: ["README.md"],
        requiredOutputs: ["result"],
        state: "queued",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    }
  };
  const blockEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.updated",
    payload: {
      assignmentId: blockedAssignmentId,
      patch: {
        state: "blocked",
        updatedAt: timestamp
      }
    }
  };
  const decisionEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "decision.created",
    payload: {
      decision: {
        decisionId: randomUUID(),
        assignmentId: blockedAssignmentId,
        requesterId: "codex",
        blockerSummary: "Need input before continuing the original assignment.",
        options: [{ id: "wait", label: "Wait", summary: "Pause until guidance arrives." }],
        recommendedOption: "wait",
        state: "open",
        createdAt: timestamp
      }
    }
  };
  const statusEvent: RuntimeEvent = {
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "status.updated",
    payload: {
      status: {
        ...projection.status,
        activeAssignmentIds: [blockedAssignmentId, runnableAssignmentId],
        lastDurableOutputAt: timestamp
      }
    }
  };

  for (const event of [newAssignmentEvent, blockEvent, decisionEvent, statusEvent]) {
    await setup.store.appendEvent(event);
  }
  await setup.store.syncSnapshotFromEvents();

  const run = await runRuntime(setup.store, setup.adapter);

  assert.equal(invocationCount, 1);
  assert.equal(run.assignment.id, runnableAssignmentId);
  assert.match(promptSeen, new RegExp(runnableAssignmentId));
  assert.doesNotMatch(promptSeen, new RegExp(`activeAssignmentId\\\":\\s*\\\"${blockedAssignmentId}\\\"`));
  assert.equal(run.envelope.recoveryBrief.activeAssignments.length, 1);
  assert.equal(run.envelope.recoveryBrief.activeAssignments[0]?.id, runnableAssignmentId);
  assert.match(run.envelope.recoveryBrief.nextRequiredAction, new RegExp(runnableAssignmentId));
  assert.doesNotMatch(run.envelope.recoveryBrief.nextRequiredAction, /Resolve decision|Unblock assignment/);
});

test("milestone-2 integration: resume reconciles a running host record without a lease expiry", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in lease-less reconciliation smoke test");
  });

  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const leaseLessRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-missing-lease" },
    startedAt,
    heartbeatAt: startedAt
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, leaseLessRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-missing-lease" },
    startedAt
  });
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", leaseLessRecord);

  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const snapshot = await setup.store.loadSnapshot();
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.ok(resumed.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(snapshot?.assignments[0]?.state, "queued");
  assert.match(inspected?.staleReason ?? "", /without a lease expiry/i);
});

test("milestone-2 integration: stale lease-only runs are reconciled and cleared for rerun", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-lease-only" });
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Lease-only recovery allowed the replacement run to finish.",
      changedFiles: [],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const expiredLeaseOnlyRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-lease-only-stale" },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  await setup.store.writeJsonArtifact(
    `adapters/codex/runs/${setup.assignmentId}.lease.json`,
    expiredLeaseOnlyRecord
  );

  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const run = await runRuntime(setup.store, setup.adapter);

  assert.ok(resumed.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.status, "completed");
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: malformed lease JSON is ignored and recovery still reruns the assignment", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-malformed-lease" });
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Malformed lease recovery allowed the replacement run to finish.",
      changedFiles: [],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  await mkdir(join(setup.projectRoot, ".coortex", "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
    "{",
    "utf8"
  );

  const inspectedBeforeRun = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
  const leaseBeforeRun = await readFile(
    join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
    "utf8"
  );
  const run = await runRuntime(setup.store, setup.adapter);

  assert.equal(inspectedBeforeRun?.state, "running");
  assert.equal(leaseBeforeRun, "{");
  assert.equal(run.execution.outcome.kind, "result");
  assert.equal(run.execution.outcome.capture.status, "completed");
  assert.ok(run.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: malformed lease reconciliation preserves the malformed lease reason", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in malformed lease reconciliation reason smoke test");
  });

  await mkdir(join(setup.projectRoot, ".coortex", "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
    "{",
    "utf8"
  );

  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.ok(resumed.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(inspected?.state, "completed");
  assert.equal(inspected?.staleReasonCode, "malformed_lease_artifact");
  assert.equal(inspected?.staleReason, "malformed lease file");
});

test("milestone-2 integration: completed run record wins over a leftover lease during recovery", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in completed-record lease recovery smoke test");
  });

  const completedRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    adapterData: { nativeRunId: "smoke-thread-completed" },
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    completedAt: new Date(Date.now() - 110_000).toISOString(),
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Old completed run",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: randomUUID(),
        producerId: "codex",
        status: "completed",
        summary: "Old completed run",
        changedFiles: [],
        createdAt: new Date(Date.now() - 110_000).toISOString()
      }
    }
  };
  const staleLease: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-stale-lease" },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/last-run.json`, completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, staleLease);

  const resumed = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(resumed.projection.assignments.get(setup.assignmentId)?.state, "completed");
  assert.deepEqual(resumed.projection.status.activeAssignmentIds, []);
  assert.equal([...resumed.projection.results.values()].length, 1);
  assert.ok(!resumed.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(inspected?.state, "completed");
  assert.equal(inspected?.resultStatus, "completed");
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: resume ignores an active leftover lease when a completed run record exists", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in active-leftover-lease resume smoke test");
  });

  const completedRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    adapterData: { nativeRunId: "smoke-thread-completed-active-lease" },
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    completedAt: new Date(Date.now() - 110_000).toISOString(),
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Completed run beats an active leftover lease",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: randomUUID(),
        producerId: "codex",
        status: "completed",
        summary: "Completed run beats an active leftover lease",
        changedFiles: [],
        createdAt: new Date(Date.now() - 110_000).toISOString()
      }
    }
  };
  const activeLease: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-active-leftover-lease" },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/last-run.json`, completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, activeLease);

  await assert.rejects(
    resumeRuntime(setup.store, setup.adapter),
    /No active assignment is available to resume\./
  );
  const snapshot = await setup.store.loadSnapshot();
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(snapshot?.assignments[0]?.state, "completed");
  assert.deepEqual(snapshot?.status.activeAssignmentIds, []);
  assert.equal(snapshot?.status.currentObjective, "Await the next assignment.");
  assert.equal(snapshot?.results.length, 1);
  assert.equal(snapshot?.results[0]?.status, "completed");
  assert.equal(snapshot?.results[0]?.summary, "Completed run beats an active leftover lease");
  assert.equal(inspected?.state, "completed");
  assert.equal(inspected?.resultStatus, "completed");
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: stale reconciliation is idempotent after the first recovery", async () => {
  const setup = await createSmokeSetup(
    stableRunner("smoke-thread-stale-repeat", "Recovered stale assignment after status/run follow-up.")
  );

  const staleRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-stale-repeat" },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, staleRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", staleRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, staleRecord);

  const firstResume = await resumeRuntime(setup.store, setup.adapter);
  const driftTimestamp = new Date().toISOString();
  await setup.store.appendEvent({
    eventId: randomUUID(),
    sessionId: firstResume.projection.sessionId,
    timestamp: driftTimestamp,
    type: "status.updated",
    payload: {
      status: {
        ...firstResume.projection.status,
        currentObjective: "Operator updated the status after stale reconciliation.",
        lastDurableOutputAt: driftTimestamp
      }
    }
  });
  await setup.store.syncSnapshotFromEvents();
  const secondResume = await resumeRuntime(setup.store, setup.adapter);
  const statusResult = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);
  const run = await runRuntime(setup.store, setup.adapter);
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
  const telemetry = await setup.store.loadTelemetry();
  const events = await setup.store.loadEvents();
  const staleTelemetryCount = telemetry.filter(
    (event) => event.eventType === "host.run.stale_reconciled"
  ).length;
  const queuedTransitionCount = events.filter(
    (event) =>
      event.type === "assignment.updated" &&
      event.payload.assignmentId === setup.assignmentId &&
      event.payload.patch.state === "queued"
  ).length;

  assert.ok(firstResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.ok(!secondResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(statusResult.projection.assignments.get(setup.assignmentId)?.state, "queued");
  assert.equal(
    statusResult.projection.status.currentObjective,
    "Operator updated the status after stale reconciliation."
  );
  assert.ok(!statusResult.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(run.execution.outcome.kind, "result");
  assert.ok(!run.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(queuedTransitionCount, 1);
  assert.equal(inspected?.state, "completed");
  assert.equal(staleTelemetryCount, 1);
});

test("milestone-2 integration: stale reconciliation retries artifact cleanup after runtime state is durable", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner not used in stale reconciliation retry smoke test");
  });

  const staleRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-stale-retry-artifacts" },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, staleRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", staleRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, staleRecord);

  const originalReconcile = setup.adapter.reconcileStaleRun.bind(setup.adapter);
  let reconcileAttempts = 0;
  setup.adapter.reconcileStaleRun = async (store, record) => {
    reconcileAttempts += 1;
    if (reconcileAttempts === 1) {
      throw new Error("simulated stale artifact write failure");
    }
    await originalReconcile(store, record);
  };

  await assert.rejects(
    resumeRuntime(setup.store, setup.adapter),
    /Host run reconciliation failed to clear the active lease for assignment/
  );
  const snapshotAfterFirst = await setup.store.loadSnapshot();
  const inspectedAfterFirst = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
  const secondStatusProjection = await loadOperatorProjection(setup.store);
  const secondResume = await resumeRuntime(setup.store, setup.adapter);
  const inspectedAfterSecond = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
  const telemetry = await setup.store.loadTelemetry();
  const staleTelemetryCount = telemetry.filter(
    (event) => event.eventType === "host.run.stale_reconciled"
  ).length;

  assert.equal(snapshotAfterFirst?.assignments[0]?.state, "queued");
  assert.equal(inspectedAfterFirst?.state, "completed");
  assert.equal(inspectedAfterFirst?.staleReasonCode, "expired_lease");
  assert.equal(secondStatusProjection.assignments.get(setup.assignmentId)?.state, "queued");
  assert.ok(!secondResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
  assert.equal(inspectedAfterSecond?.state, "completed");
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
  assert.equal(reconcileAttempts, 2);
  assert.equal(staleTelemetryCount, 1);
});

test("milestone-2 integration: stale retries move back to in-progress before the replacement host run", async () => {
  let assignmentStateDuringRetry = "";
  const setup = await createSmokeSetup(async (input) => {
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-retry" });
    const projection = await loadOperatorProjection(setup.store);
    assignmentStateDuringRetry = projection.assignments.get(setup.assignmentId)?.state ?? "";
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Retry run completed after stale reconciliation.",
      changedFiles: [],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  });

  const expiredRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    adapterData: { nativeRunId: "smoke-thread-old-stale" },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, expiredRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", expiredRecord);

  const run = await runRuntime(setup.store, setup.adapter);

  assert.equal(assignmentStateDuringRetry, "in_progress");
  assert.equal(run.projectionBefore.assignments.get(setup.assignmentId)?.state, "in_progress");
});
async function createSmokeSetup(runExec: CodexCommandRunner["runExec"]): Promise<SmokeSetup> {
  return createSmokeSetupWithRunner({ runExec });
}

async function createSmokeSetupWithRunner(runner: {
  runExec: CodexCommandRunner["runExec"];
  runResume?: CodexCommandRunner["runResume"];
}): Promise<SmokeSetup> {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-m2-smoke-"));
  const store = RuntimeStore.forProject(projectRoot);
  const adapter = new CodexAdapter({
    async startExec(input) {
      const result = runner.runExec({
        ...input,
        onEvent: async (event) => {
          await input.onEvent?.(event);
        }
      });
      return {
        result,
        terminate: async () => undefined,
        waitForExit: async () => {
          const execResult = await result;
          return { code: execResult.exitCode };
        }
      };
    },
    runExec: runner.runExec,
    ...(runner.runResume ? { runResume: runner.runResume } : {})
  });
  const initialized = await initRuntime(projectRoot, store, adapter);
  if (!initialized) {
    throw new Error("Expected a fresh smoke runtime.");
  }
  const projection = await loadOperatorProjection(store);
  const assignmentId = projection.status.activeAssignmentIds[0];
  if (!assignmentId) {
    throw new Error("Expected an active assignment after smoke setup.");
  }
  return {
    projectRoot,
    store,
    adapter,
    assignmentId
  };
}

async function appendPartialResult(setup: SmokeSetup, resultId: string, summary: string): Promise<void> {
  await setup.store.appendEvent({
    eventId: randomUUID(),
    sessionId: (await loadOperatorProjection(setup.store)).sessionId,
    timestamp: nowIso(),
    type: "result.submitted",
    payload: {
      result: {
        resultId,
        assignmentId: setup.assignmentId,
        producerId: "codex",
        status: "partial",
        summary,
        changedFiles: ["src/hosts/codex/adapter/envelope.ts"],
        createdAt: nowIso()
      }
    }
  });
  await setup.store.syncSnapshotFromEvents();
}

async function writeStructuredOutput(outputPath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload), "utf8");
}

function stableRunner(threadId: string, summary: string): CodexCommandRunner["runExec"] {
  return async (input) => {
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: summary,
      changedFiles: ["src/cli/ctx.ts"],
      blockerSummary: "",
      decisionOptions: [],
      recommendedOption: ""
    });
    await input.onEvent?.({ type: "thread.started", thread_id: threadId });
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 6 }
      }),
      stderr: ""
    };
  };
}

function normalizeRunArtifacts(
  run: Awaited<ReturnType<typeof runRuntime>>,
  snapshot: Awaited<ReturnType<RuntimeStore["loadSnapshot"]>>,
  completedTelemetry:
    | Awaited<ReturnType<RuntimeStore["loadTelemetry"]>>[number]
    | undefined
) {
  return {
    envelope: {
      host: run.envelope.host,
      adapter: run.envelope.adapter,
      objective: normalizeBootstrapObjective(run.envelope.objective),
      writeScope: [...run.envelope.writeScope],
      requiredOutputs: [...run.envelope.requiredOutputs],
      recentResults: run.envelope.recentResults.map((result) => ({
        trimmed: result.trimmed,
        summary: result.summary,
        hasReference: typeof result.reference === "string"
      })),
      metadata: {
        ...run.envelope.metadata,
        activeAssignmentId: "<active-assignment>"
      },
      estimatedChars: run.envelope.estimatedChars,
      trimApplied: run.envelope.trimApplied,
      trimmedFields: run.envelope.trimmedFields.map((field) => ({
        label: field.label,
        originalChars: field.originalChars,
        keptChars: field.keptChars,
        hasReference: field.reference.length > 0
      }))
    },
    execution: {
      outcomeKind: run.execution.outcome.kind,
      runState: run.execution.run.state,
      nativeRunId: getNativeRunId(run.execution.run),
      result:
        run.execution.outcome.kind === "result"
          ? {
              status: run.execution.outcome.capture.status,
              summary: run.execution.outcome.capture.summary,
              changedFiles: [...run.execution.outcome.capture.changedFiles]
            }
          : undefined,
      decision:
        run.execution.outcome.kind === "decision"
          ? {
              blockerSummary: run.execution.outcome.capture.blockerSummary,
              recommendedOption: run.execution.outcome.capture.recommendedOption,
              options: run.execution.outcome.capture.options.map((option) => ({
                id: option.id,
                label: option.label,
                summary: option.summary
              }))
            }
          : undefined
    },
    snapshot: snapshot
      ? {
          status: {
            activeMode: snapshot.status.activeMode,
            currentObjective: snapshot.status.currentObjective,
            activeAssignmentCount: snapshot.status.activeAssignmentIds.length,
            activeHost: snapshot.status.activeHost,
            activeAdapter: snapshot.status.activeAdapter,
            resumeReady: snapshot.status.resumeReady
          },
          assignments: snapshot.assignments.map((assignment) => ({
          workflow: assignment.workflow,
          ownerType: assignment.ownerType,
          ownerId: assignment.ownerId,
          objective: normalizeBootstrapObjective(assignment.objective),
            writeScope: [...assignment.writeScope],
            requiredOutputs: [...assignment.requiredOutputs],
            state: assignment.state
          })),
          results: snapshot.results.map((result) => ({
            assignmentIdMatchesActive: result.assignmentId.length > 0,
            producerId: result.producerId,
            status: result.status,
            summary: result.summary,
            changedFiles: [...result.changedFiles]
          })),
          decisions: snapshot.decisions.map((decision) => ({
            requesterId: decision.requesterId,
            blockerSummary: decision.blockerSummary,
            recommendedOption: decision.recommendedOption,
            state: decision.state,
            options: decision.options.map((option) => ({
              id: option.id,
              label: option.label,
              summary: option.summary
            }))
          }))
        }
      : undefined,
    completedTelemetry: completedTelemetry
      ? {
          eventType: completedTelemetry.eventType,
          host: completedTelemetry.host,
          adapter: completedTelemetry.adapter,
          metadata: completedTelemetry.metadata,
          inputTokens: completedTelemetry.inputTokens,
          outputTokens: completedTelemetry.outputTokens,
          totalTokens: completedTelemetry.totalTokens,
          cachedTokens: completedTelemetry.cachedTokens
        }
      : undefined
  };
}

function findLastTelemetry(
  events: Awaited<ReturnType<RuntimeStore["loadTelemetry"]>>,
  eventType: string
) {
  return [...events].reverse().find((event) => event.eventType === eventType);
}

function normalizeBootstrapObjective(value: string): string {
  return value.replace(
    /Coordinate work for coortex-m2-smoke-[^ ]+ through the Coortex runtime\./g,
    "Coordinate work for <smoke-project> through the Coortex runtime."
  );
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("Timed out waiting for smoke state.");
}
