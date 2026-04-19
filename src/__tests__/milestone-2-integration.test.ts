import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { CodexAdapter } from "../hosts/codex/adapter/index.js";
import type { CodexCommandRunner } from "../hosts/codex/adapter/cli.js";
import { buildCodexExecutionPrompt } from "../hosts/codex/adapter/prompt.js";
import type { RuntimeConfig } from "../config/types.js";
import { getNativeRunId } from "../core/run-state.js";
import type { HostRunRecord } from "../core/types.js";
import type { RuntimeEvent } from "../core/events.js";
import { RuntimeStore } from "../persistence/store.js";
import {
  initRuntime,
  inspectRuntimeRun,
  inspectRuntimeRunWithContext,
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

const serial = { concurrency: false } as const;

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
  const promptChars = buildCodexExecutionPrompt(run.envelope).length;

  assert.equal(run.envelope.trimApplied, true);
  assert.equal(run.envelope.recentResults[0]?.trimmed, true);
  assert.equal(run.envelope.recentResults[0]?.reference, ".coortex/artifacts/results/smoke-result-long.txt");
  assert.ok(run.envelope.estimatedChars <= 4_000);
  assert.equal(run.envelope.estimatedChars, promptChars);
  assert.equal(artifact.trim(), ("trim-me ".repeat(250)).trim());
  assert.equal(startedTelemetry?.metadata.envelopeChars, promptChars);
  assert.equal(startedTelemetry?.metadata.trimApplied, true);
  assert.equal(startedTelemetry?.metadata.trimmedFields, 1);
});

test("milestone-2 integration: live host leases without runtime attachment truth stay blocked", serial, async () => {
  const setup = await createSmokeSetupWithRunner({
    runExec: async () => {
      throw new Error("runExec should not be used in active-lease blocker coverage");
    },
    runResume: async () => {
      throw new Error("runResume should not be used in active-lease blocker coverage");
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
  await assert.rejects(
    resumeRuntime(setup.store, setup.adapter),
    /already has an active host run lease/
  );
  const projectionAfterResume = await loadOperatorProjection(setup.store);
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(statusProjection.status.activeAssignmentIds[0], setup.assignmentId);
  assert.deepEqual(reconciled.activeLeases, [setup.assignmentId]);
  assert.ok(reconciled.diagnostics.some((diagnostic) => diagnostic.code === "active-run-present"));
  assert.equal(reconciled.projection.results.size, 1);
  assert.equal(
    [...reconciled.projection.results.values()][0]?.summary,
    "Interrupted smoke work is partially complete."
  );
  assert.equal(projectionAfterResume.results.size, 1);
  assert.equal(projectionAfterResume.attachments.size, 0);
  assert.equal(projectionAfterResume.claims.size, 0);
  assert.equal(projectionAfterResume.assignments.get(setup.assignmentId)?.state, "in_progress");
  assert.equal(inspected?.assignmentId, setup.assignmentId);
  assert.equal(inspected?.state, "running");
});

test("milestone-2 integration: malformed claim graphs fail closed across run, resume, recovery, and inspect", async () => {
  const setup = await createSmokeSetup(async () => ({
    exitCode: 0,
    stdout: "",
    stderr: ""
  }));
  const snapshot = await setup.store.loadSnapshot();
  if (!snapshot) {
    throw new Error("Expected a seeded runtime snapshot.");
  }
  const timestamp = nowIso();

  await rm(join(setup.projectRoot, ".coortex", "runtime", "events.ndjson"));
  await setup.store.writeJsonArtifact("runtime/snapshot.json", {
    ...snapshot,
    attachments: [],
    claims: [
      {
        id: "broken-claim",
        assignmentId: setup.assignmentId,
        attachmentId: "missing-attachment",
        state: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        provenance: {
          kind: "resume",
          source: "ctx.resume"
        }
      }
    ]
  });

  await assert.rejects(
    () => loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter),
    /claim graph references missing attachments/
  );
  await assert.rejects(
    () => prepareResumeRuntime(setup.store, setup.adapter),
    /claim graph references missing attachments/
  );
  await assert.rejects(
    () => resumeRuntime(setup.store, setup.adapter),
    /claim graph references missing attachments/
  );
  await assert.rejects(
    () => runRuntime(setup.store, setup.adapter),
    /claim graph references missing attachments/
  );
  await assert.rejects(
    () => inspectRuntimeRunWithContext(setup.store, setup.adapter, setup.assignmentId),
    /claim graph references missing attachments/
  );
});

test("milestone-2 integration: malformed claim suffixes after the snapshot boundary fail closed", async () => {
  const setup = await createSmokeSetup(async () => ({
    exitCode: 0,
    stdout: "",
    stderr: ""
  }));
  const snapshot = await setup.store.loadSnapshot();
  if (!snapshot) {
    throw new Error("Expected a seeded runtime snapshot.");
  }
  const timestamp = nowIso();

  await setup.store.appendEvent({
    eventId: randomUUID(),
    sessionId: snapshot.sessionId,
    timestamp,
    type: "claim.created",
    payload: {
      claim: {
        id: randomUUID(),
        assignmentId: setup.assignmentId,
        attachmentId: "missing-attachment",
        state: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        provenance: {
          kind: "resume",
          source: "ctx.resume"
        }
      }
    }
  });

  await assert.rejects(
    () => loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter),
    /claim graph references missing attachments/
  );
  await assert.rejects(
    () => prepareResumeRuntime(setup.store, setup.adapter),
    /claim graph references missing attachments/
  );
  await assert.rejects(
    () => resumeRuntime(setup.store, setup.adapter),
    /claim graph references missing attachments/
  );
  await assert.rejects(
    () => runRuntime(setup.store, setup.adapter),
    /claim graph references missing attachments/
  );
  await assert.rejects(
    () => inspectRuntimeRunWithContext(setup.store, setup.adapter, setup.assignmentId),
    /claim graph references missing attachments/
  );
});

test("milestone-2 integration: inspect context uses the active claim for the host run assignment", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used in inspect-context claim selection coverage");
  });
  const sessionId = (await loadOperatorProjection(setup.store)).sessionId;
  const activeTimestamp = "2026-04-19T10:00:00.000Z";
  const staleCreatedTimestamp = "2026-04-19T10:05:00.000Z";
  const staleReleasedTimestamp = "2026-04-19T10:10:00.000Z";
  const staleReleaseReason = "stale claim should not override the active attachment context";
  const hostRunRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    startedAt: activeTimestamp,
    heartbeatAt: staleReleasedTimestamp,
    leaseExpiresAt: "2026-04-19T10:20:00.000Z",
    adapterData: {
      nativeRunId: "smoke-thread-inspect-active-claim"
    }
  };

  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, hostRunRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", hostRunRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, hostRunRecord);

  const { attachmentId, claimId } = await appendAuthoritativeAttachmentClaim(setup, {
    state: "attached",
    nativeSessionId: "native-active-claim"
  });
  const staleAttachmentId = randomUUID();
  const staleClaimId = randomUUID();

  await setup.store.appendEvents([
    {
      eventId: randomUUID(),
      sessionId,
      timestamp: staleCreatedTimestamp,
      type: "attachment.created",
      payload: {
        attachment: {
          id: staleAttachmentId,
          adapter: "codex",
          host: "codex",
          state: "attached",
          createdAt: staleCreatedTimestamp,
          updatedAt: staleCreatedTimestamp,
          attachedAt: staleCreatedTimestamp,
          nativeSessionId: "native-stale-claim",
          provenance: {
            kind: "resume",
            source: "ctx.resume"
          }
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId,
      timestamp: staleCreatedTimestamp,
      type: "claim.created",
      payload: {
        claim: {
          id: staleClaimId,
          assignmentId: setup.assignmentId,
          attachmentId: staleAttachmentId,
          state: "active",
          createdAt: staleCreatedTimestamp,
          updatedAt: staleCreatedTimestamp,
          provenance: {
            kind: "resume",
            source: "ctx.resume"
          }
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId,
      timestamp: staleReleasedTimestamp,
      type: "attachment.updated",
      payload: {
        attachmentId: staleAttachmentId,
        patch: {
          state: "released",
          updatedAt: staleReleasedTimestamp,
          releasedAt: staleReleasedTimestamp,
          releasedReason: staleReleaseReason
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId,
      timestamp: staleReleasedTimestamp,
      type: "claim.updated",
      payload: {
        claimId: staleClaimId,
        patch: {
          state: "released",
          updatedAt: staleReleasedTimestamp,
          releasedAt: staleReleasedTimestamp,
          releasedReason: staleReleaseReason
        }
      }
    }
  ]);
  await setup.store.syncSnapshotFromEvents();

  const inspection = await inspectRuntimeRunWithContext(setup.store, setup.adapter, setup.assignmentId);

  assert.equal(inspection?.hostRun.assignmentId, setup.assignmentId);
  assert.deepEqual(inspection?.runtimeAttachment, {
    id: attachmentId,
    state: "attached",
    nativeSessionId: "native-active-claim",
    claimId,
    claimState: "active"
  });
});

test("milestone-2 integration: prepareResumeRuntime stays read-only against live lease blockers", async () => {
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
  const telemetryBefore = await setup.store.loadTelemetry();
  const prepared = await prepareResumeRuntime(setup.store, setup.adapter);
  const projectionAfter = await loadOperatorProjection(setup.store);
  const telemetryAfter = await setup.store.loadTelemetry();
  const persistedEnvelope = await setup.store.readJsonArtifact(
    "runtime/last-resume-envelope.json",
    "resume envelope"
  );

  assert.equal(prepared.brief.activeAssignments.length, 1);
  assert.equal(prepared.envelope.metadata.activeAssignmentId, setup.assignmentId);
  assert.equal(prepared.diagnostics.length, 0);
  assert.equal(projectionBefore.attachments.size, 0);
  assert.equal(projectionBefore.claims.size, 0);
  assert.equal(projectionAfter.attachments.size, 0);
  assert.equal(projectionAfter.claims.size, 0);
  assert.equal(telemetryAfter.length, telemetryBefore.length);
  assert.equal(persistedEnvelope, undefined);
});

test("milestone-2 integration: failed same-session reclaim orphans the attachment and requeues the assignment", serial, async () => {
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
  assert.equal(attachment?.state, "orphaned");
  assert.equal(claim?.state, "orphaned");
  assert.deepEqual(attachment?.provenance, { kind: "resume", source: "ctx.resume" });
  assert.deepEqual(claim?.provenance, { kind: "resume", source: "ctx.resume" });
  assert.match(attachment?.orphanedReason ?? "", /did not confirm the requested session/);
  assert.match(claim?.orphanedReason ?? "", /did not confirm the requested session/);
  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "queued");
  assert.deepEqual(projection.status.activeAssignmentIds, [setup.assignmentId]);
  assert.match(projection.status.currentObjective, new RegExp(`Retry assignment ${setup.assignmentId}:`));
});

test("milestone-2 integration: wrapped resume rejects a foreign native session reclaim and requeues the assignment", serial, async () => {
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
  const originalBuildResumeEnvelope = setup.adapter.buildResumeEnvelope.bind(setup.adapter);
  let poisonResumeEnvelope = true;
  setup.adapter.buildResumeEnvelope = async (store, projection, brief) => {
    const envelope = await originalBuildResumeEnvelope(store, projection, brief);
    if (!poisonResumeEnvelope) {
      return envelope;
    }
    poisonResumeEnvelope = false;
    return {
      ...envelope,
      objective: "stale pre-reclaim objective",
      recentResults: [{ resultId: "stale-result", summary: "stale recent result", trimmed: true }],
      trimApplied: true,
      trimmedFields: [{ label: "stale", originalChars: 999, keptChars: 1, reference: "stale.txt" }],
      estimatedChars: 999
    };
  };
  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const projection = await loadOperatorProjection(setup.store);
  const attachment = [...projection.attachments.values()][0];
  const claim = [...projection.claims.values()][0];
  const telemetry = await setup.store.loadTelemetry();
  const resumeCompletedTelemetry = findLastTelemetry(telemetry, "host.resume.completed");

  assert.equal(resumed.mode, "prepared");
  assert.equal(attachment?.state, "orphaned");
  assert.equal(claim?.state, "orphaned");
  assert.match(attachment?.orphanedReason ?? "", /instead of requested session/);
  assert.match(claim?.orphanedReason ?? "", /instead of requested session/);
  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "queued");
  assert.equal(resumeCompletedTelemetry?.metadata.reclaimed, false);
  assert.equal(resumeCompletedTelemetry?.metadata.sessionVerified, false);
});

test("milestone-2 integration: wrapped resume claims a host lease and blocks duplicate reclaim", serial, async () => {
  let releaseResume!: () => void;
  let resumeReleasedOnce = false;
  const resumeReleased = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  const releaseResumeOnce = () => {
    if (!resumeReleasedOnce) {
      resumeReleasedOnce = true;
      releaseResume();
    }
  };
  let resumeStarted!: () => void;
  const resumeStartedPromise = new Promise<void>((resolve) => {
    resumeStarted = resolve;
  });
  let resumeAttempts = 0;
  const setup = await createSmokeSetupWithRunner({
    runExec: async (input) => {
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "partial",
        resultSummary: "Launch produced partial progress before concurrent reclaim coverage.",
        changedFiles: ["src/cli/commands.ts"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-duplicate-reclaim" });
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    },
    runResume: async (input) => {
      resumeAttempts += 1;
      await input.onEvent?.({ type: "thread.resumed", thread_id: input.sessionId });
      resumeStarted();
      await resumeReleased;
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "partial",
        resultSummary: "Wrapped reclaim completed without duplicating the host attempt.",
        changedFiles: ["src/cli/commands.ts"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    }
  });

  await runRuntime(setup.store, setup.adapter);
  const firstResume = resumeRuntime(setup.store, setup.adapter);
  try {
    await resumeStartedPromise;
    await waitFor(async () => {
      const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
      return inspected?.state === "running";
    });

    const inFlight = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
    const inFlightReconciled = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);

    assert.equal(inFlight?.state, "running");
    assert.equal(getNativeRunId(inFlight), "smoke-thread-duplicate-reclaim");
    assert.deepEqual(inFlightReconciled.activeLeases, [setup.assignmentId]);
    assert.ok(
      inFlightReconciled.diagnostics.some((diagnostic) => diagnostic.code === "active-run-present")
    );
    await assert.rejects(
      resumeRuntime(setup.store, setup.adapter),
      /already has an active host run lease/
    );
    const projectionDuringBlock = await loadOperatorProjection(setup.store);
    const blockedAttachment = [...projectionDuringBlock.attachments.values()][0];
    const blockedClaim = [...projectionDuringBlock.claims.values()][0];
    assert.equal(blockedAttachment?.state, "attached");
    assert.equal(blockedClaim?.state, "active");
    assert.equal(projectionDuringBlock.assignments.get(setup.assignmentId)?.state, "in_progress");
  } finally {
    releaseResumeOnce();
  }

  const resumed = await firstResume;

  assert.equal(resumed.mode, "reclaimed");
  assert.equal(resumeAttempts, 1);
});

test("milestone-2 integration: snapshot-only reclaim failure preserves orphaned attachment truth and queued retry state", serial, async () => {
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
  assert.equal(attachment?.state, "orphaned");
  assert.equal(claim?.state, "orphaned");
  assert.match(attachment?.orphanedReason ?? "", /snapshot-only resume failed/);
  assert.match(claim?.orphanedReason ?? "", /snapshot-only resume failed/);
  assert.equal(snapshot?.assignments[0]?.state, "queued");
  assert.deepEqual(snapshot?.status.activeAssignmentIds, [setup.assignmentId]);
});

test("milestone-2 integration: reclaim cleanup failure does not surface queued retry truth while the lease blocker remains", serial, async () => {
  const setup = await createSmokeSetupWithRunner({
    runExec: async (input) => {
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "partial",
        resultSummary: "Launch produced resumable state before cleanup-failure coverage.",
        changedFiles: ["src/cli/commands.ts"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-cleanup-failure" });
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    },
    runResume: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: ""
    })
  });

  await runRuntime(setup.store, setup.adapter);
  const originalResumeSession = setup.adapter.resumeSession?.bind(setup.adapter);
  const originalReconcileStaleRun = setup.adapter.reconcileStaleRun.bind(setup.adapter);
  setup.adapter.resumeSession = async (store, projection) => {
    await setup.adapter.claimRunLease(store, projection, setup.assignmentId);
    throw new Error("resume failed before cleanup");
  };
  setup.adapter.reconcileStaleRun = async () => {
    throw new Error("simulated resume cleanup failure");
  };

  await assert.rejects(
    resumeRuntime(setup.store, setup.adapter),
    /Host run cleanup failed to clear the active lease for assignment/
  );

  if (originalResumeSession) {
    setup.adapter.resumeSession = originalResumeSession;
  }
  setup.adapter.reconcileStaleRun = originalReconcileStaleRun;

  const projection = await loadOperatorProjection(setup.store);
  const attachment = [...projection.attachments.values()][0];
  const claim = [...projection.claims.values()][0];

  assert.equal(attachment?.state, "detached_resumable");
  assert.equal(claim?.state, "active");
  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "in_progress");
  assert.ok(!projection.status.currentObjective.startsWith(`Retry assignment ${setup.assignmentId}:`));
  await assert.rejects(
    runRuntime(setup.store, setup.adapter),
    /already claimed by authoritative attachment/
  );
});

test("milestone-2 integration: provisional cleanup failure does not surface queued retry truth while the lease blocker remains", serial, async () => {
  const setup = await createSmokeSetupWithRunner({
    runExec: async () => {
      throw new Error("runExec should not be used in provisional cleanup failure coverage");
    }
  });

  const projection = await loadOperatorProjection(setup.store);
  const timestamp = nowIso();
  const attachmentId = randomUUID();
  const claimId = randomUUID();
  await setup.store.appendEvents([
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "assignment.updated",
      payload: {
        assignmentId: setup.assignmentId,
        patch: {
          state: "in_progress",
          updatedAt: timestamp
        }
      }
    },
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
  ]);
  await setup.store.syncSnapshotFromEvents();

  const runningRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, runningRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, runningRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", runningRecord);

  const originalReconcileStaleRun = setup.adapter.reconcileStaleRun.bind(setup.adapter);
  setup.adapter.reconcileStaleRun = async () => {
    throw new Error("simulated provisional cleanup failure");
  };

  await assert.rejects(
    loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter),
    /Host run cleanup failed to clear the active lease for assignment/
  );

  setup.adapter.reconcileStaleRun = originalReconcileStaleRun;

  const projectionAfter = await loadOperatorProjection(setup.store);
  const attachment = projectionAfter.attachments.get(attachmentId);
  const claim = projectionAfter.claims.get(claimId);

  assert.equal(attachment?.state, "orphaned");
  assert.equal(claim?.state, "orphaned");
  assert.equal(projectionAfter.assignments.get(setup.assignmentId)?.state, "in_progress");
  assert.ok(!projectionAfter.status.currentObjective.startsWith(`Retry assignment ${setup.assignmentId}:`));
  await assert.rejects(
    runRuntime(setup.store, setup.adapter),
    /already has an active host run lease/
  );
});

test("milestone-2 integration: provisional cleanup removes the lease before reconciled status surfaces blocker truth", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used in successful provisional cleanup coverage");
  });

  const projection = await loadOperatorProjection(setup.store);
  const timestamp = nowIso();
  const attachmentId = randomUUID();
  const claimId = randomUUID();
  await setup.store.appendEvents([
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
  ]);
  await setup.store.syncSnapshotFromEvents();

  const runningRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "running",
    startedAt: timestamp,
    heartbeatAt: timestamp,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, runningRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, runningRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", runningRecord);

  const reconciled = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);
  const repairedAttachment = reconciled.projection.attachments.get(attachmentId);
  const repairedClaim = reconciled.projection.claims.get(claimId);
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);

  assert.deepEqual(reconciled.activeLeases, []);
  assert.equal(
    reconciled.diagnostics.some((diagnostic) => diagnostic.code === "active-run-present"),
    false
  );
  assert.equal(repairedAttachment?.state, "orphaned");
  assert.equal(repairedClaim?.state, "orphaned");
  assert.equal(reconciled.projection.assignments.get(setup.assignmentId)?.state, "queued");
  assert.equal(inspected?.state, "completed");
});

test("milestone-2 integration: provisional live-lease authority is promoted before same-session resume selection", serial, async () => {
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

  const reconciled = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);
  const reconciledAttachment = reconciled.projection.attachments.get(attachmentId);
  const reconciledClaim = reconciled.projection.claims.get(claimId);

  assert.ok(
    reconciled.diagnostics.some((diagnostic) => diagnostic.code === "provisional-attachment-promoted")
  );
  assert.deepEqual(reconciledAttachment?.provenance, {
    kind: "recovery",
    source: "recovery.reconcile"
  });
  assert.deepEqual(reconciledClaim?.provenance, {
    kind: "recovery",
    source: "recovery.reconcile"
  });

  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const projectionAfter = await loadOperatorProjection(setup.store);
  const attachment = projectionAfter.attachments.get(attachmentId);

  assert.equal(resumed.mode, "reclaimed");
  assert.equal(resumedSessionId, "smoke-thread-provisional-promoted");
  assert.equal(attachment?.state, "detached_resumable");
  assert.equal(attachment?.nativeSessionId, "smoke-thread-provisional-promoted");
});

test("milestone-2 integration: provisional live-lease reclaim takeover is atomic", serial, async () => {
  let releaseResume!: () => void;
  let resumeReleasedOnce = false;
  const resumeReleased = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  const releaseResumeOnce = () => {
    if (!resumeReleasedOnce) {
      resumeReleasedOnce = true;
      releaseResume();
    }
  };
  let resumeStarted!: () => void;
  const resumeStartedPromise = new Promise<void>((resolve) => {
    resumeStarted = resolve;
  });
  let resumeAttempts = 0;
  const setup = await createSmokeSetupWithRunner({
    runExec: async () => {
      throw new Error("runExec should not be used in provisional reclaim takeover coverage");
    },
    runResume: async (input) => {
      resumeAttempts += 1;
      await input.onEvent?.({ type: "thread.resumed", thread_id: input.sessionId });
      resumeStarted();
      await resumeReleased;
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "partial",
        resultSummary: "Atomic provisional reclaim takeover avoided duplicate resume.",
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
      nativeRunId: "smoke-thread-provisional-atomic"
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, runningRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, runningRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", runningRecord);

  const firstResume = resumeRuntime(setup.store, setup.adapter);
  try {
    await resumeStartedPromise;
    await waitFor(async () => {
      const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
      return inspected?.state === "running";
    });

    const inFlight = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
    const inFlightReconciled = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);

    assert.equal(inFlight?.state, "running");
    assert.equal(getNativeRunId(inFlight), "smoke-thread-provisional-atomic");
    assert.deepEqual(inFlightReconciled.activeLeases, [setup.assignmentId]);
    assert.ok(
      inFlightReconciled.diagnostics.some((diagnostic) => diagnostic.code === "active-run-present")
    );
    await assert.rejects(
      resumeRuntime(setup.store, setup.adapter),
      /already has an active host run lease/
    );
    const projectionDuringBlock = await loadOperatorProjection(setup.store);
    const blockedAttachment = projectionDuringBlock.attachments.get(attachmentId);
    const blockedClaim = projectionDuringBlock.claims.get(claimId);
    assert.equal(blockedAttachment?.state, "attached");
    assert.equal(blockedClaim?.state, "active");
    assert.equal(projectionDuringBlock.assignments.get(setup.assignmentId)?.state, "in_progress");
  } finally {
    releaseResumeOnce();
  }

  const resumed = await firstResume;

  assert.equal(resumed.mode, "reclaimed");
  assert.equal(resumeAttempts, 1);
});

test("milestone-2 integration: wrapped resume prompt omits redundant resume-next-action guidance", serial, async () => {
  let promptSeen = "";
  const setup = await createSmokeSetupWithRunner({
    runExec: async (input) => {
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "partial",
        resultSummary: "Launch created resumable state before prompt coverage.",
        changedFiles: ["src/cli/commands.ts"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-resume-prompt" });
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    },
    runResume: async (input) => {
      promptSeen = input.prompt ?? "";
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "completed",
        resultSummary: "Wrapped resume completed after prompt coverage.",
        changedFiles: ["src/cli/commands.ts"],
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

  await runRuntime(setup.store, setup.adapter);
  await resumeRuntime(setup.store, setup.adapter);

  assert.doesNotMatch(promptSeen, /"nextRequiredAction":"Resume attachment /);
  assert.match(promptSeen, /"nextRequiredAction":"Continue assignment /);
});

test("milestone-2 integration: wrapped resume rebuilds an inactive bounded envelope after a long terminal result", serial, async () => {
  const longSummary = "Wrapped resume finished with a very long summary. ".repeat(20);
  const setup = await createSmokeSetupWithRunner({
    runExec: async (input) => {
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "partial",
        resultSummary: "Launch created resumable state before bounded inactive envelope coverage.",
        changedFiles: ["src/cli/commands.ts"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-bounded-inactive-envelope" });
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
        resultSummary: longSummary,
        changedFiles: ["src/hosts/codex/adapter/envelope.ts"],
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

  await runRuntime(setup.store, setup.adapter);
  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const persistedEnvelope = JSON.parse(
    await readFile(join(setup.projectRoot, ".coortex", "runtime", "last-resume-envelope.json"), "utf8")
  ) as {
    trimApplied: boolean;
    trimmedFields: Array<{ label: string }>;
    recentResults: Array<{ summary: string; trimmed: boolean; reference?: string }>;
    estimatedChars: number;
  };

  assert.equal(resumed.mode, "reclaimed");
  assert.equal(resumed.envelope.trimApplied, true);
  assert.ok(resumed.envelope.trimmedFields.some((field) => field.label.startsWith("result:")));
  assert.equal(resumed.envelope.recentResults[0]?.trimmed, true);
  assert.match(resumed.envelope.recentResults[0]?.summary ?? "", /\.\.\.\[trimmed\]$/);
  assert.match(resumed.envelope.recentResults[0]?.reference ?? "", /\.coortex\/artifacts\/results\//);
  assert.ok(resumed.envelope.estimatedChars <= 4_000);
  assert.equal(persistedEnvelope.trimApplied, true);
  assert.ok(persistedEnvelope.trimmedFields.some((field) => field.label.startsWith("result:")));
  assert.equal(persistedEnvelope.recentResults[0]?.trimmed, true);
  assert.match(persistedEnvelope.recentResults[0]?.summary ?? "", /\.\.\.\[trimmed\]$/);
  assert.match(persistedEnvelope.recentResults[0]?.reference ?? "", /\.coortex\/artifacts\/results\//);
  assert.ok(persistedEnvelope.estimatedChars <= 4_000);
});

test("milestone-2 integration: wrapped resume persists a terminal completed result and releases attachment authority", serial, async () => {
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
  const originalCompletedResumeEnvelope = setup.adapter.buildResumeEnvelope.bind(setup.adapter);
  let poisonCompletedResumeEnvelope = true;
  setup.adapter.buildResumeEnvelope = async (store, projection, brief) => {
    const envelope = await originalCompletedResumeEnvelope(store, projection, brief);
    if (!poisonCompletedResumeEnvelope) {
      return envelope;
    }
    poisonCompletedResumeEnvelope = false;
    return {
      ...envelope,
      objective: "stale pre-reclaim objective",
      recentResults: [{ resultId: "stale-result", summary: "stale recent result", trimmed: true }],
      trimApplied: true,
      trimmedFields: [{ label: "stale", originalChars: 999, keptChars: 1, reference: "stale.txt" }],
      estimatedChars: 999
    };
  };
  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const projection = await loadOperatorProjection(setup.store);
  const attachment = [...projection.attachments.values()][0];
  const claim = [...projection.claims.values()][0];
  const telemetry = await setup.store.loadTelemetry();
  const resumeCompletedTelemetry = findLastTelemetry(telemetry, "host.resume.completed");
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
  const persistedEnvelope = JSON.parse(
    await readFile(join(setup.projectRoot, ".coortex", "runtime", "last-resume-envelope.json"), "utf8")
  ) as {
    objective: string;
    recentResults: Array<{ summary: string }>;
    trimApplied: boolean;
    trimmedFields: unknown[];
    estimatedChars: number;
  };

  assert.equal(resumed.mode, "reclaimed");
  assert.equal(resumed.execution.outcome.kind, "result");
  assert.equal(resumed.execution.outcome.capture.status, "completed");
  assert.equal(resumed.execution.outcome.capture.summary, "Wrapped resume finished the assignment.");
  assert.equal(resumed.execution.run.resultStatus, "completed");
  assert.equal(attachment?.state, "released");
  assert.equal(claim?.state, "released");
  assert.deepEqual(attachment?.provenance, { kind: "resume", source: "ctx.resume" });
  assert.deepEqual(claim?.provenance, { kind: "resume", source: "ctx.resume" });
  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "completed");
  assert.deepEqual(projection.status.activeAssignmentIds, []);
  assert.equal(projection.status.currentObjective, "Await the next assignment.");
  assert.equal(resumed.brief.activeObjective, "Await the next assignment.");
  assert.equal(resumed.brief.activeAssignments.length, 0);
  assert.equal(resumed.envelope.recoveryBrief.activeObjective, "Await the next assignment.");
  assert.equal(resumed.envelope.recoveryBrief.activeAssignments.length, 0);
  assert.equal(resumed.envelope.objective, "Await the next assignment.");
  assert.equal(resumed.envelope.recentResults[0]?.summary, "Wrapped resume finished the assignment.");
  assert.equal(resumed.envelope.trimApplied, false);
  assert.deepEqual(resumed.envelope.trimmedFields, []);
  assert.notEqual(resumed.envelope.estimatedChars, 999);
  assert.equal(persistedEnvelope.objective, "Await the next assignment.");
  assert.equal(persistedEnvelope.recentResults[0]?.summary, "Wrapped resume finished the assignment.");
  assert.equal(persistedEnvelope.trimApplied, false);
  assert.deepEqual(persistedEnvelope.trimmedFields, []);
  assert.notEqual(persistedEnvelope.estimatedChars, 999);
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

test("milestone-2 integration: wrapped resume recovers a terminal completed result after persistence interruption", serial, async () => {
  const setup = await createSmokeSetupWithRunner({
    runExec: async (input) => {
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "partial",
        resultSummary: "Launch created resumable state before recovered terminal resume coverage.",
        changedFiles: ["src/cli/commands.ts"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-recovered-terminal-resume" });
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
        resultSummary: "Wrapped resume recovered a completed result after persistence interruption.",
        changedFiles: ["src/cli/commands.ts", "src/cli/run-operations.ts"],
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

  await runRuntime(setup.store, setup.adapter);
  const originalCompletedResumeEnvelope = setup.adapter.buildResumeEnvelope.bind(setup.adapter);
  let poisonCompletedResumeEnvelope = true;
  setup.adapter.buildResumeEnvelope = async (store, projection, brief) => {
    const envelope = await originalCompletedResumeEnvelope(store, projection, brief);
    if (!poisonCompletedResumeEnvelope) {
      return envelope;
    }
    poisonCompletedResumeEnvelope = false;
    return {
      ...envelope,
      objective: "stale pre-recovery objective",
      recentResults: [{ resultId: "stale-result", summary: "stale recent result", trimmed: true }],
      trimApplied: true,
      trimmedFields: [{ label: "stale", originalChars: 999, keptChars: 1, reference: "stale.txt" }],
      estimatedChars: 999
    };
  };
  const restoreAppend = failNextOutcomeAppend(
    setup.store,
    "result.submitted",
    "simulated resume result persistence failure"
  );
  let resumed!: Awaited<ReturnType<typeof resumeRuntime>>;
  try {
    resumed = await resumeRuntime(setup.store, setup.adapter);
  } finally {
    restoreAppend();
  }
  const projection = await loadOperatorProjection(setup.store);
  const attachment = [...projection.attachments.values()][0];
  const claim = [...projection.claims.values()][0];
  const telemetry = await setup.store.loadTelemetry();
  const resumeCompletedTelemetry = findLastTelemetry(telemetry, "host.resume.completed");
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
  const persistedEnvelope = JSON.parse(
    await readFile(join(setup.projectRoot, ".coortex", "runtime", "last-resume-envelope.json"), "utf8")
  ) as {
    objective: string;
    recentResults: Array<{ summary: string }>;
    trimApplied: boolean;
    trimmedFields: unknown[];
    estimatedChars: number;
  };

  assert.equal(resumed.mode, "reclaimed");
  assert.ok(resumed.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.equal(resumed.execution.outcome.kind, "result");
  assert.equal(resumed.execution.outcome.capture.status, "completed");
  assert.equal(
    resumed.execution.outcome.capture.summary,
    "Wrapped resume recovered a completed result after persistence interruption."
  );
  assert.equal(resumed.execution.run.resultStatus, "completed");
  assert.equal(attachment?.state, "released");
  assert.equal(claim?.state, "released");
  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "completed");
  assert.deepEqual(projection.status.activeAssignmentIds, []);
  assert.equal(projection.status.currentObjective, "Await the next assignment.");
  assert.equal(resumed.brief.activeObjective, "Await the next assignment.");
  assert.equal(resumed.envelope.objective, "Await the next assignment.");
  assert.equal(
    resumed.envelope.recentResults[0]?.summary,
    "Wrapped resume recovered a completed result after persistence interruption."
  );
  assert.equal(resumed.envelope.trimApplied, false);
  assert.deepEqual(resumed.envelope.trimmedFields, []);
  assert.notEqual(resumed.envelope.estimatedChars, 999);
  assert.equal(persistedEnvelope.objective, "Await the next assignment.");
  assert.equal(
    persistedEnvelope.recentResults[0]?.summary,
    "Wrapped resume recovered a completed result after persistence interruption."
  );
  assert.equal(persistedEnvelope.trimApplied, false);
  assert.deepEqual(persistedEnvelope.trimmedFields, []);
  assert.notEqual(persistedEnvelope.estimatedChars, 999);
  assert.equal(inspected?.state, "completed");
  assert.equal(inspected?.resultStatus, "completed");
  assert.equal(
    inspected?.summary,
    "Wrapped resume recovered a completed result after persistence interruption."
  );
  assert.equal(resumeCompletedTelemetry?.metadata.reclaimed, true);
  assert.equal(resumeCompletedTelemetry?.metadata.sessionVerified, true);
  assert.equal(resumeCompletedTelemetry?.metadata.resultStatus, "completed");
});

test("milestone-2 integration: wrapped resume persists a decision outcome and keeps the claim resumable", serial, async () => {
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
  const originalDecisionResumeEnvelope = setup.adapter.buildResumeEnvelope.bind(setup.adapter);
  let poisonDecisionResumeEnvelope = true;
  setup.adapter.buildResumeEnvelope = async (store, projection, brief) => {
    const envelope = await originalDecisionResumeEnvelope(store, projection, brief);
    if (!poisonDecisionResumeEnvelope) {
      return envelope;
    }
    poisonDecisionResumeEnvelope = false;
    return {
      ...envelope,
      objective: "stale decision objective",
      recentResults: [{ resultId: "stale-result", summary: "stale recent result", trimmed: true }],
      trimApplied: true,
      trimmedFields: [{ label: "stale", originalChars: 999, keptChars: 1, reference: "stale.txt" }],
      estimatedChars: 999
    };
  };
  const resumed = await resumeRuntime(setup.store, setup.adapter);
  const projection = await loadOperatorProjection(setup.store);
  const attachment = [...projection.attachments.values()][0];
  const claim = [...projection.claims.values()][0];
  const decision = [...projection.decisions.values()].at(-1);
  const telemetry = await setup.store.loadTelemetry();
  const resumeCompletedTelemetry = findLastTelemetry(telemetry, "host.resume.completed");
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
  const persistedEnvelope = JSON.parse(
    await readFile(join(setup.projectRoot, ".coortex", "runtime", "last-resume-envelope.json"), "utf8")
  ) as {
    objective: string;
    recentResults: Array<{ summary: string }>;
    trimApplied: boolean;
    trimmedFields: unknown[];
    estimatedChars: number;
  };

  assert.equal(resumed.mode, "reclaimed");
  assert.equal(resumed.execution.outcome.kind, "decision");
  assert.equal(
    resumed.execution.outcome.capture.blockerSummary,
    "Need operator guidance before continuing resumed work."
  );
  assert.equal(resumed.execution.run.outcomeKind, "decision");
  assert.equal(attachment?.state, "detached_resumable");
  assert.deepEqual(attachment?.provenance, {
    kind: "resume",
    source: "ctx.resume"
  });
  assert.equal(claim?.state, "active");
  assert.deepEqual(claim?.provenance, {
    kind: "resume",
    source: "ctx.resume"
  });
  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "blocked");
  assert.deepEqual(projection.status.activeAssignmentIds, [setup.assignmentId]);
  assert.equal(
    projection.status.currentObjective,
    "Need operator guidance before continuing resumed work."
  );
  assert.equal(decision?.state, "open");
  assert.equal(decision?.blockerSummary, "Need operator guidance before continuing resumed work.");
  assert.equal(resumed.brief.activeObjective, "Need operator guidance before continuing resumed work.");
  assert.equal(resumed.brief.unresolvedDecisions[0]?.blockerSummary, "Need operator guidance before continuing resumed work.");
  assert.equal(resumed.envelope.recoveryBrief.activeObjective, "Need operator guidance before continuing resumed work.");
  assert.equal(
    resumed.envelope.recoveryBrief.unresolvedDecisions[0]?.blockerSummary,
    "Need operator guidance before continuing resumed work."
  );
  assert.equal(
    resumed.envelope.objective,
    projection.assignments.get(setup.assignmentId)?.objective
  );
  assert.equal(
    resumed.envelope.recentResults[0]?.summary,
    "Launch created resumable state before decision resume coverage."
  );
  assert.equal(resumed.envelope.trimApplied, false);
  assert.deepEqual(resumed.envelope.trimmedFields, []);
  assert.notEqual(resumed.envelope.estimatedChars, 999);
  assert.equal(
    persistedEnvelope.objective,
    projection.assignments.get(setup.assignmentId)?.objective
  );
  assert.equal(
    persistedEnvelope.recentResults[0]?.summary,
    "Launch created resumable state before decision resume coverage."
  );
  assert.equal(persistedEnvelope.trimApplied, false);
  assert.deepEqual(persistedEnvelope.trimmedFields, []);
  assert.notEqual(persistedEnvelope.estimatedChars, 999);
  assert.equal(decision?.recommendedOption, "wait");
  assert.equal(inspected?.state, "completed");
  assert.equal(inspected?.outcomeKind, "decision");
  assert.equal(inspected?.summary, "Need operator guidance before continuing resumed work.");
  assert.equal(resumeCompletedTelemetry?.metadata.reclaimed, true);
  assert.equal(resumeCompletedTelemetry?.metadata.sessionVerified, true);
  assert.equal(resumeCompletedTelemetry?.metadata.outcomeKind, "decision");
  assert.equal(resumeCompletedTelemetry?.metadata.resultStatus, "");
});

test("milestone-2 integration: wrapped resume recovers a decision outcome after persistence interruption", serial, async () => {
  const setup = await createSmokeSetupWithRunner({
    runExec: async (input) => {
      await writeStructuredOutput(input.outputPath, {
        outcomeType: "result",
        resultStatus: "partial",
        resultSummary: "Launch created resumable state before recovered decision resume coverage.",
        changedFiles: ["src/cli/commands.ts"],
        blockerSummary: "",
        decisionOptions: [],
        recommendedOption: ""
      });
      await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-recovered-decision-resume" });
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
        blockerSummary: "Recovered decision remained available after persistence interruption.",
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
  const originalDecisionResumeEnvelope = setup.adapter.buildResumeEnvelope.bind(setup.adapter);
  let poisonDecisionResumeEnvelope = true;
  setup.adapter.buildResumeEnvelope = async (store, projection, brief) => {
    const envelope = await originalDecisionResumeEnvelope(store, projection, brief);
    if (!poisonDecisionResumeEnvelope) {
      return envelope;
    }
    poisonDecisionResumeEnvelope = false;
    return {
      ...envelope,
      objective: "stale recovered decision objective",
      recentResults: [{ resultId: "stale-result", summary: "stale recent result", trimmed: true }],
      trimApplied: true,
      trimmedFields: [{ label: "stale", originalChars: 999, keptChars: 1, reference: "stale.txt" }],
      estimatedChars: 999
    };
  };
  const restoreAppend = failNextOutcomeAppend(
    setup.store,
    "decision.created",
    "simulated resume decision persistence failure"
  );
  let resumed!: Awaited<ReturnType<typeof resumeRuntime>>;
  try {
    resumed = await resumeRuntime(setup.store, setup.adapter);
  } finally {
    restoreAppend();
  }
  const projection = await loadOperatorProjection(setup.store);
  const attachment = [...projection.attachments.values()][0];
  const claim = [...projection.claims.values()][0];
  const decision = [...projection.decisions.values()].at(-1);
  const telemetry = await setup.store.loadTelemetry();
  const resumeCompletedTelemetry = findLastTelemetry(telemetry, "host.resume.completed");
  const inspected = await inspectRuntimeRun(setup.store, setup.adapter, setup.assignmentId);
  const persistedEnvelope = JSON.parse(
    await readFile(join(setup.projectRoot, ".coortex", "runtime", "last-resume-envelope.json"), "utf8")
  ) as {
    objective: string;
    recentResults: Array<{ summary: string }>;
    trimApplied: boolean;
    trimmedFields: unknown[];
    estimatedChars: number;
  };

  assert.equal(resumed.mode, "reclaimed");
  assert.ok(resumed.diagnostics.some((diagnostic) => diagnostic.code === "host-run-persist-failed"));
  assert.equal(resumed.execution.outcome.kind, "decision");
  assert.equal(
    resumed.execution.outcome.capture.blockerSummary,
    "Recovered decision remained available after persistence interruption."
  );
  assert.equal(resumed.execution.run.outcomeKind, "decision");
  assert.equal(attachment?.state, "detached_resumable");
  assert.deepEqual(attachment?.provenance, {
    kind: "recovery",
    source: "recovery.reconcile"
  });
  assert.equal(claim?.state, "active");
  assert.deepEqual(claim?.provenance, {
    kind: "recovery",
    source: "recovery.reconcile"
  });
  assert.equal(projection.assignments.get(setup.assignmentId)?.state, "blocked");
  assert.deepEqual(projection.status.activeAssignmentIds, [setup.assignmentId]);
  assert.equal(
    projection.status.currentObjective,
    "Recovered decision remained available after persistence interruption."
  );
  assert.equal(decision?.state, "open");
  assert.equal(
    decision?.blockerSummary,
    "Recovered decision remained available after persistence interruption."
  );
  assert.equal(resumed.brief.activeObjective, "Recovered decision remained available after persistence interruption.");
  assert.equal(
    resumed.envelope.recoveryBrief.activeObjective,
    "Recovered decision remained available after persistence interruption."
  );
  assert.equal(
    resumed.envelope.objective,
    projection.assignments.get(setup.assignmentId)?.objective
  );
  assert.equal(
    resumed.envelope.recentResults[0]?.summary,
    "Launch created resumable state before recovered decision resume coverage."
  );
  assert.equal(resumed.envelope.trimApplied, false);
  assert.deepEqual(resumed.envelope.trimmedFields, []);
  assert.notEqual(resumed.envelope.estimatedChars, 999);
  assert.equal(
    persistedEnvelope.objective,
    projection.assignments.get(setup.assignmentId)?.objective
  );
  assert.equal(
    persistedEnvelope.recentResults[0]?.summary,
    "Launch created resumable state before recovered decision resume coverage."
  );
  assert.equal(persistedEnvelope.trimApplied, false);
  assert.deepEqual(persistedEnvelope.trimmedFields, []);
  assert.notEqual(persistedEnvelope.estimatedChars, 999);
  assert.equal(decision?.recommendedOption, "wait");
  assert.equal(inspected?.state, "completed");
  assert.equal(inspected?.outcomeKind, "decision");
  assert.equal(
    inspected?.summary,
    "Recovered decision remained available after persistence interruption."
  );
  assert.equal(resumeCompletedTelemetry?.metadata.reclaimed, true);
  assert.equal(resumeCompletedTelemetry?.metadata.sessionVerified, true);
  assert.equal(resumeCompletedTelemetry?.metadata.outcomeKind, "decision");
  assert.equal(resumeCompletedTelemetry?.metadata.resultStatus, "");
});

test("milestone-2 integration: completed decision recovery detaches attached authority and keeps the claim active", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used during completed decision recovery coverage");
  });
  const completedAt = nowIso();
  const { attachmentId, claimId } = await appendAuthoritativeAttachmentClaim(setup, {
    state: "attached",
    nativeSessionId: "smoke-thread-recovered-decision"
  });
  const completedRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    startedAt: completedAt,
    completedAt,
    outcomeKind: "decision",
    summary: "Recovered decision preserves resumable attachment authority.",
    terminalOutcome: {
      kind: "decision",
      decision: {
        decisionId: "decision-recovered-attached",
        requesterId: "codex",
        blockerSummary: "Recovered decision should preserve same-session claim authority.",
        options: [{ id: "wait", label: "Wait", summary: "Pause until guidance arrives." }],
        recommendedOption: "wait",
        state: "open",
        createdAt: completedAt
      }
    },
    adapterData: {
      nativeRunId: "smoke-thread-recovered-decision"
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, completedRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", completedRecord);

  const recovered = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(recovered.projection.attachments.get(attachmentId)?.state, "detached_resumable");
  assert.equal(recovered.projection.claims.get(claimId)?.state, "active");
  assert.equal(recovered.projection.assignments.get(setup.assignmentId)?.state, "blocked");
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, [setup.assignmentId]);
  assert.equal(
    recovered.projection.decisions.get("decision-recovered-attached")?.blockerSummary,
    "Recovered decision should preserve same-session claim authority."
  );
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: recovered partial host completion detaches attached authority", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used during partial recovery coverage");
  });
  const completedAt = nowIso();
  const { attachmentId, claimId } = await appendAuthoritativeAttachmentClaim(setup, {
    state: "attached",
    nativeSessionId: "smoke-thread-recovered-partial"
  });
  const completedRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    startedAt: completedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus: "partial",
    summary: "Recovered partial host completion keeps the session resumable.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: "result-recovered-partial",
        producerId: "codex",
        status: "partial",
        summary: "Recovered partial host completion keeps the session resumable.",
        changedFiles: ["src/cli/run-operations.ts"],
        createdAt: completedAt
      }
    },
    adapterData: {
      nativeRunId: "smoke-thread-recovered-partial"
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, completedRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", completedRecord);

  const recovered = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(recovered.projection.attachments.get(attachmentId)?.state, "detached_resumable");
  assert.equal(recovered.projection.claims.get(claimId)?.state, "active");
  assert.equal(recovered.projection.assignments.get(setup.assignmentId)?.state, "in_progress");
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, [setup.assignmentId]);
  assert.equal(
    [...recovered.projection.results.values()].at(-1)?.resultId,
    "result-recovered-partial"
  );
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: detached authority without a native session id is not wrapped-reclaimable", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used when wrapped reclaim is not possible");
  });
  await appendAuthoritativeAttachmentClaim(setup, {
    state: "detached_resumable",
    nativeSessionId: null
  });

  const prepared = await resumeRuntime(setup.store, setup.adapter);

  assert.equal(prepared.mode, "prepared");
  assert.doesNotMatch(prepared.brief.nextRequiredAction, /Resume attachment/);
  assert.match(prepared.brief.nextRequiredAction, /Continue assignment/);
});

test("milestone-2 integration: completed decision recovery backfills missing native session id on detached authority", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used during detached authority recovery coverage");
  });
  const completedAt = nowIso();
  const { attachmentId, claimId } = await appendAuthoritativeAttachmentClaim(setup, {
    state: "detached_resumable",
    nativeSessionId: null
  });
  const completedRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    startedAt: completedAt,
    completedAt,
    outcomeKind: "decision",
    summary: "Recovered decision backfills native identity onto detached authority.",
    terminalOutcome: {
      kind: "decision",
      decision: {
        decisionId: "decision-recovered-detached-missing-id",
        requesterId: "codex",
        blockerSummary: "Recovered decision should heal detached authority identity.",
        options: [{ id: "wait", label: "Wait", summary: "Pause until guidance arrives." }],
        recommendedOption: "wait",
        state: "open",
        createdAt: completedAt
      }
    },
    adapterData: {
      nativeRunId: "smoke-thread-recovered-detached-missing-id"
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, completedRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", completedRecord);

  const recovered = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(recovered.projection.attachments.get(attachmentId)?.state, "detached_resumable");
  assert.equal(
    recovered.projection.attachments.get(attachmentId)?.nativeSessionId,
    "smoke-thread-recovered-detached-missing-id"
  );
  assert.equal(recovered.projection.claims.get(claimId)?.state, "active");
  assert.equal(recovered.projection.assignments.get(setup.assignmentId)?.state, "blocked");
});

test("milestone-2 integration: completed decision recovery promotes provisional authority into resumable state", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used during provisional decision recovery coverage");
  });
  const completedAt = nowIso();
  const { attachmentId, claimId } = await appendAuthoritativeAttachmentClaim(setup, {
    state: "provisional"
  });
  const completedRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    startedAt: completedAt,
    completedAt,
    outcomeKind: "decision",
    summary: "Recovered decision promotes provisional authority into resumable state.",
    terminalOutcome: {
      kind: "decision",
      decision: {
        decisionId: "decision-recovered-provisional",
        requesterId: "codex",
        blockerSummary: "Recovered provisional decision should preserve same-session claim authority.",
        options: [{ id: "wait", label: "Wait", summary: "Pause until guidance arrives." }],
        recommendedOption: "wait",
        state: "open",
        createdAt: completedAt
      }
    },
    adapterData: {
      nativeRunId: "smoke-thread-recovered-provisional-decision"
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, completedRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", completedRecord);

  const recovered = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(recovered.projection.attachments.get(attachmentId)?.state, "detached_resumable");
  assert.equal(
    recovered.projection.attachments.get(attachmentId)?.nativeSessionId,
    "smoke-thread-recovered-provisional-decision"
  );
  assert.deepEqual(recovered.projection.attachments.get(attachmentId)?.provenance, {
    kind: "recovery",
    source: "recovery.reconcile"
  });
  assert.equal(recovered.projection.claims.get(claimId)?.state, "active");
  assert.deepEqual(recovered.projection.claims.get(claimId)?.provenance, {
    kind: "recovery",
    source: "recovery.reconcile"
  });
  assert.equal(recovered.projection.assignments.get(setup.assignmentId)?.state, "blocked");
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, [setup.assignmentId]);
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
});

test("milestone-2 integration: recovered partial host completion promotes provisional authority into resumable state", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used during provisional partial recovery coverage");
  });
  const completedAt = nowIso();
  const { attachmentId, claimId } = await appendAuthoritativeAttachmentClaim(setup, {
    state: "provisional"
  });
  const completedRecord: HostRunRecord = {
    assignmentId: setup.assignmentId,
    state: "completed",
    startedAt: completedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus: "partial",
    summary: "Recovered partial host completion promotes provisional authority into resumable state.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: "result-recovered-provisional-partial",
        producerId: "codex",
        status: "partial",
        summary: "Recovered partial host completion promotes provisional authority into resumable state.",
        changedFiles: ["src/cli/run-operations.ts"],
        createdAt: completedAt
      }
    },
    adapterData: {
      nativeRunId: "smoke-thread-recovered-provisional-partial"
    }
  };
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.json`, completedRecord);
  await setup.store.writeJsonArtifact(`adapters/codex/runs/${setup.assignmentId}.lease.json`, completedRecord);
  await setup.store.writeJsonArtifact("adapters/codex/last-run.json", completedRecord);

  const recovered = await loadReconciledProjectionWithDiagnostics(setup.store, setup.adapter);

  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.code === "completed-run-reconciled"));
  assert.equal(recovered.projection.attachments.get(attachmentId)?.state, "detached_resumable");
  assert.equal(
    recovered.projection.attachments.get(attachmentId)?.nativeSessionId,
    "smoke-thread-recovered-provisional-partial"
  );
  assert.equal(recovered.projection.claims.get(claimId)?.state, "active");
  assert.equal(recovered.projection.assignments.get(setup.assignmentId)?.state, "in_progress");
  assert.deepEqual(recovered.projection.status.activeAssignmentIds, [setup.assignmentId]);
  await assert.rejects(
    readFile(
      join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
      "utf8"
    ),
    /ENOENT/
  );
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
      `Assignment ${foreignAssignmentId} is already claimed by authoritative attachment ${attachmentId}\\.`
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

test("milestone-2 integration: resume fails closed when multiple authoritative attachments exist", async () => {
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
  const firstAttachmentId = randomUUID();
  await setup.store.appendEvent({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
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
        nativeSessionId: "smoke-thread-attachment-one",
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
        assignmentId: setup.assignmentId,
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
  });
  await setup.store.appendEvent({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "attachment.created",
    payload: {
      attachment: {
        id: randomUUID(),
        adapter: "codex",
        host: "codex",
        state: "detached_resumable",
        createdAt: timestamp,
        updatedAt: timestamp,
        detachedAt: timestamp,
        nativeSessionId: "smoke-thread-attachment-two",
        provenance: {
          kind: "launch",
          source: "ctx.run"
        }
      }
    }
  });
  await assert.rejects(
    resumeRuntime(setup.store, setup.adapter),
    /multiple authoritative attachments are present/
  );

  await assert.rejects(
    loadOperatorProjection(setup.store),
    /multiple authoritative attachments are present/
  );
});

test("milestone-2 integration: resume fails closed when one authoritative attachment is claimed across assignments", async () => {
  const setup = await createSmokeSetup(async () => {
    throw new Error("runner should not be used when attachment-claim exclusivity is invalid");
  });

  const projection = await loadOperatorProjection(setup.store);
  const secondAssignmentId = randomUUID();
  const timestamp = nowIso();
  const attachmentId = randomUUID();

  await setup.store.appendEvents([
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "assignment.created",
      payload: {
        assignment: {
          id: secondAssignmentId,
          parentTaskId: "task-shared-authority-claims",
          workflow: "milestone-2",
          ownerType: "host",
          ownerId: "codex",
          objective: "Second assignment for shared-authority attachment claim coverage.",
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
          nativeSessionId: "smoke-thread-shared-authority",
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
          id: randomUUID(),
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
    },
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "claim.created",
      payload: {
        claim: {
          id: randomUUID(),
          assignmentId: secondAssignmentId,
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

  await assert.rejects(
    resumeRuntime(setup.store, setup.adapter),
    /multiple active claims are present/
  );
  await assert.rejects(
    loadOperatorProjection(setup.store),
    /multiple active claims are present/
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
  assert.equal(
    snapshot?.status.currentObjective,
    `Retry assignment ${setup.assignmentId}: ${projection.assignments.get(setup.assignmentId)?.objective}`
  );
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

test("milestone-2 integration: stale host lease artifacts are reconciled and cleared for rerun", async () => {
  const setup = await createSmokeSetup(async (input) => {
    await input.onEvent?.({ type: "thread.started", thread_id: "smoke-thread-stale-lease" });
    await writeStructuredOutput(input.outputPath, {
      outcomeType: "result",
      resultStatus: "completed",
      resultSummary: "Stale host-lease recovery allowed the replacement run to finish.",
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
    adapterData: { nativeRunId: "smoke-thread-stale-lease-artifact" },
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

  const leaseBeforeRun = await readFile(
    join(setup.projectRoot, ".coortex", "adapters", "codex", "runs", `${setup.assignmentId}.lease.json`),
    "utf8"
  );
  const run = await runRuntime(setup.store, setup.adapter);

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

  assert.equal(snapshotAfterFirst?.assignments[0]?.state, "in_progress");
  assert.equal(inspectedAfterFirst?.state, "completed");
  assert.equal(inspectedAfterFirst?.staleReasonCode, "expired_lease");
  assert.equal(secondStatusProjection.assignments.get(setup.assignmentId)?.state, "in_progress");
  assert.ok(secondResume.diagnostics.some((diagnostic) => diagnostic.code === "stale-run-reconciled"));
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
    ...(
      runner.runResume
        ? {
            async startResume(input) {
              const result = runner.runResume!({
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
            }
          }
        : {}
    )
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

function failNextOutcomeAppend(
  store: RuntimeStore,
  eventType: "result.submitted" | "decision.created",
  message: string
): () => void {
  const originalAppendEvents = store.appendEvents.bind(store);
  let failed = false;
  (store as RuntimeStore & {
    appendEvents: RuntimeStore["appendEvents"];
  }).appendEvents = async (events) => {
    if (!failed && events.some((event) => event.type === eventType)) {
      failed = true;
      throw new Error(message);
    }
    await originalAppendEvents(events);
  };
  return () => {
    (store as RuntimeStore & {
      appendEvents: RuntimeStore["appendEvents"];
    }).appendEvents = originalAppendEvents;
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

async function appendAuthoritativeAttachmentClaim(
  setup: SmokeSetup,
  options: {
    state: "attached" | "detached_resumable" | "provisional";
    nativeSessionId?: string | null;
  }
): Promise<{ attachmentId: string; claimId: string }> {
  const projection = await loadOperatorProjection(setup.store);
  const timestamp = nowIso();
  const attachmentId = randomUUID();
  const claimId = randomUUID();
  const nativeSessionId =
    options.nativeSessionId === undefined ? `native-${setup.assignmentId}` : options.nativeSessionId;
  await setup.store.appendEvents([
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
          state: options.state,
          createdAt: timestamp,
          updatedAt: timestamp,
          ...(options.state === "attached"
            ? { attachedAt: timestamp }
            : options.state === "detached_resumable"
              ? { detachedAt: timestamp }
              : {}),
          ...(options.state === "provisional" || !nativeSessionId ? {} : { nativeSessionId }),
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
  ]);
  await setup.store.syncSnapshotFromEvents();
  return {
    attachmentId,
    claimId
  };
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
