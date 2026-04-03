#!/usr/bin/env node
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeConfig } from "../config/types.js";
import type { HostAdapter } from "../adapters/contract.js";
import type { RuntimeEvent } from "../core/events.js";
import { createBootstrapRuntime } from "../core/runtime.js";
import { buildRecoveryBrief } from "../recovery/brief.js";
import { RuntimeStore, toPrettyJson } from "../persistence/store.js";
import { toSnapshot } from "../projections/runtime-projection.js";
import { CodexAdapter } from "../hosts/codex/adapter/index.js";
import { recordNormalizedTelemetry } from "../telemetry/recorder.js";
import { nowIso } from "../utils/time.js";

async function main(): Promise<void> {
  const [command, assignmentIdArg] = process.argv.slice(2);
  const projectRoot = process.cwd();
  const store = RuntimeStore.forProject(projectRoot);
  const adapter = new CodexAdapter();

  switch (command) {
    case "init":
      await initCommand(projectRoot, store, adapter);
      return;
    case "doctor":
      await doctorCommand(store, adapter);
      return;
    case "status":
      await statusCommand(store);
      return;
    case "resume":
      await resumeCommand(store, adapter);
      return;
    case "run":
      await runCommand(store, adapter);
      return;
    case "inspect":
      await inspectCommand(store, adapter, assignmentIdArg);
      return;
    default:
      printUsage();
      process.exitCode = command ? 1 : 0;
  }
}

async function initCommand(
  projectRoot: string,
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<void> {
  const existing = await store.loadConfig();
  if (existing) {
    console.log(`Coortex already initialized at ${store.rootDir}`);
    return;
  }

  const createdAt = nowIso();
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    version: 1,
    sessionId,
    adapter: adapter.id,
    host: adapter.host,
    rootPath: projectRoot,
    createdAt
  };

  await store.initialize(config);
  const bootstrap = createBootstrapRuntime({
    rootPath: projectRoot,
    sessionId,
    adapter: adapter.id,
    host: adapter.host,
    workflow: "milestone-2"
  });

  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const projection = await store.syncSnapshotFromEvents();
  await adapter.initialize(store, projection);
  await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry({
      eventType: "runtime.initialized",
      taskId: sessionId,
      assignmentId: bootstrap.initialAssignmentId,
      metadata: {
        projectRoot,
        repoName: basename(projectRoot)
      }
    })
  );

  console.log(`Initialized Coortex runtime at ${store.rootDir}`);
  console.log(`Session: ${sessionId}`);
  console.log(`Adapter: ${adapter.id}`);
}

async function doctorCommand(store: RuntimeStore, adapter: HostAdapter): Promise<void> {
  const config = await store.loadConfig();
  if (!config) {
    console.log(`Coortex is not initialized at ${store.rootDir}`);
    process.exitCode = 1;
    return;
  }

  const projection = await loadOperatorProjection(store);
  const checks = [
    {
      label: "config",
      ok: true,
      detail: store.configPath
    },
    {
      label: "snapshot",
      ok: projection.status.activeAdapter === config.adapter,
      detail: store.snapshotPath
    },
    ...(await adapter.doctor(store))
  ];

  const hasFailure = checks.some((check) => !check.ok);
  for (const check of checks) {
    console.log(`${check.ok ? "OK" : "FAIL"} ${check.label} ${check.detail}`);
  }
  process.exitCode = hasFailure ? 1 : 0;
}

async function statusCommand(store: RuntimeStore): Promise<void> {
  const config = await store.loadConfig();
  if (!config) {
    console.log("Coortex is not initialized. Run `ctx init` first.");
    process.exitCode = 1;
    return;
  }

  const projection = await loadOperatorProjection(store);
  const activeAssignments = [...projection.assignments.values()].filter((assignment) =>
    projection.status.activeAssignmentIds.includes(assignment.id)
  );
  const openDecisions = [...projection.decisions.values()].filter((decision) => decision.state === "open");

  console.log(`Session: ${projection.sessionId}`);
  console.log(`Objective: ${projection.status.currentObjective}`);
  console.log(`Host: ${projection.status.activeHost}`);
  console.log(`Adapter: ${projection.status.activeAdapter}`);
  console.log(`Last durable output: ${projection.status.lastDurableOutputAt || "n/a"}`);
  console.log(`Active assignments: ${activeAssignments.length}`);
  console.log(`Results: ${projection.results.size}`);
  console.log(`Open decisions: ${openDecisions.length}`);
  for (const assignment of activeAssignments) {
    console.log(`- ${assignment.id} ${assignment.state} ${assignment.objective}`);
  }
}

async function resumeCommand(store: RuntimeStore, adapter: HostAdapter): Promise<void> {
  const config = await store.loadConfig();
  if (!config) {
    console.log("Coortex is not initialized. Run `ctx init` first.");
    process.exitCode = 1;
    return;
  }

  const projection = await loadOperatorProjection(store);
  const brief = buildRecoveryBrief(projection);
  const envelope = await adapter.buildResumeEnvelope(store, projection, brief);
  const envelopePath = join(store.runtimeDir, "last-resume-envelope.json");
  await store.writeSnapshot(toSnapshot(projection));
  await store.writeJsonArtifact("runtime/last-resume-envelope.json", envelope);
  await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry({
      eventType: "resume.requested",
      taskId: projection.sessionId,
      metadata: {
        envelopeChars: envelope.estimatedChars,
        trimApplied: envelope.trimApplied,
        trimmedFields: envelope.trimmedFields.length
      }
    })
  );

  console.log(`Recovery brief generated for ${projection.status.currentObjective}`);
  console.log(`Envelope: ${resolve(envelopePath)}`);
  console.log(toPrettyJson(envelope).trimEnd());
}

async function runCommand(store: RuntimeStore, adapter: HostAdapter): Promise<void> {
  const config = await store.loadConfig();
  if (!config) {
    console.log("Coortex is not initialized. Run `ctx init` first.");
    process.exitCode = 1;
    return;
  }

  const projection = await loadOperatorProjection(store);
  const assignment = getRunnableAssignment(projection);
  const brief = buildRecoveryBrief(projection);
  const envelope = await adapter.buildResumeEnvelope(store, projection, brief);

  await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry({
      eventType: "host.run.started",
      taskId: projection.sessionId,
      assignmentId: assignment.id,
      metadata: {
        envelopeChars: envelope.estimatedChars,
        trimApplied: envelope.trimApplied,
        trimmedFields: envelope.trimmedFields.length
      }
    })
  );

  const execution = await adapter.executeAssignment(store, projection, envelope);
  const events = buildOutcomeEvents(projection, execution, adapter);
  for (const event of events) {
    await store.appendEvent(event);
  }
  await store.syncSnapshotFromEvents();

  if (execution.telemetry) {
    await recordNormalizedTelemetry(store, adapter.normalizeTelemetry(execution.telemetry));
  }

  console.log(`Executed assignment ${assignment.id} through ${adapter.id}`);
  if (execution.run.hostRunId) {
    console.log(`Host run: ${execution.run.hostRunId}`);
  }
  if (execution.outcome.kind === "decision") {
    console.log(`Decision: ${execution.outcome.capture.blockerSummary}`);
    console.log(`Recommended option: ${execution.outcome.capture.recommendedOption}`);
  } else {
    console.log(`Result (${execution.outcome.capture.status}): ${execution.outcome.capture.summary}`);
  }
}

async function inspectCommand(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId?: string
): Promise<void> {
  const config = await store.loadConfig();
  if (!config) {
    console.log("Coortex is not initialized. Run `ctx init` first.");
    process.exitCode = 1;
    return;
  }

  const record = await adapter.inspectRun(store, assignmentId);
  if (!record) {
    console.log("No recorded host run found.");
    process.exitCode = 1;
    return;
  }

  console.log(toPrettyJson(record).trimEnd());
}

function buildOutcomeEvents(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  execution: Awaited<ReturnType<HostAdapter["executeAssignment"]>>,
  adapter: HostAdapter
): RuntimeEvent[] {
  const timestamp = nowIso();
  const assignmentId = execution.run.assignmentId;
  const status = nextRuntimeStatus(projection, execution);
  const events: RuntimeEvent[] = [];

  if (execution.outcome.kind === "decision") {
    const decision = adapter.normalizeDecision(execution.outcome.capture);
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "decision.created",
      payload: { decision }
    });
  } else {
    const result = adapter.normalizeResult(execution.outcome.capture);
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "result.submitted",
      payload: { result }
    });
  }

  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.updated",
    payload: {
      assignmentId,
      patch: {
        state: nextAssignmentState(execution),
        updatedAt: timestamp
      }
    }
  });
  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "status.updated",
    payload: { status }
  });

  return events;
}

function nextAssignmentState(execution: Awaited<ReturnType<HostAdapter["executeAssignment"]>>) {
  if (execution.outcome.kind === "decision") {
    return "blocked" as const;
  }
  switch (execution.outcome.capture.status) {
    case "completed":
      return "completed" as const;
    case "failed":
      return "failed" as const;
    default:
      return "in_progress" as const;
  }
}

function nextRuntimeStatus(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>,
  execution: Awaited<ReturnType<HostAdapter["executeAssignment"]>>
) {
  const assignmentId = execution.run.assignmentId;
  const terminal =
    execution.outcome.kind === "result" &&
    (execution.outcome.capture.status === "completed" || execution.outcome.capture.status === "failed");
  const activeAssignmentIds = terminal
    ? projection.status.activeAssignmentIds.filter((id) => id !== assignmentId)
    : projection.status.activeAssignmentIds;

  return {
    ...projection.status,
    activeMode: activeAssignmentIds.length === 0 ? "idle" : projection.status.activeMode,
    currentObjective:
      activeAssignmentIds.length === 0
        ? execution.outcome.kind === "result" && execution.outcome.capture.status === "failed"
          ? `Review failed assignment ${assignmentId}.`
          : "Await the next assignment."
        : projection.status.currentObjective,
    activeAssignmentIds,
    lastDurableOutputAt: nowIso(),
    resumeReady: true
  };
}

function getRunnableAssignment(projection: Awaited<ReturnType<typeof loadOperatorProjection>>) {
  const activeAssignment = [...projection.assignments.values()].find((assignment) =>
    projection.status.activeAssignmentIds.includes(assignment.id)
  );
  if (!activeAssignment) {
    throw new Error("No active assignment is available to run.");
  }
  const unresolvedDecisions = [...projection.decisions.values()].filter(
    (decision) => decision.assignmentId === activeAssignment.id && decision.state === "open"
  );
  if (activeAssignment.state === "blocked" || unresolvedDecisions.length > 0) {
    const suffix =
      unresolvedDecisions.length > 0
        ? ` Resolve decision ${unresolvedDecisions[0]!.decisionId} first.`
        : "";
    throw new Error(`Assignment ${activeAssignment.id} is blocked and cannot be run.${suffix}`);
  }
  return activeAssignment;
}

function printUsage(): void {
  console.log("Usage: ctx <init|doctor|status|resume|run|inspect> [assignment-id]");
}

async function loadOperatorProjection(store: RuntimeStore) {
  if (await store.hasEvents()) {
    return store.syncSnapshotFromEvents();
  }
  return store.loadProjection();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
