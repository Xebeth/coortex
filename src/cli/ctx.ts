#!/usr/bin/env node
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeConfig } from "../config/types.js";
import { createBootstrapRuntime } from "../core/runtime.js";
import { buildRecoveryBrief } from "../recovery/brief.js";
import { RuntimeStore, toPrettyJson } from "../persistence/store.js";
import { toSnapshot } from "../projections/runtime-projection.js";
import { writeJsonAtomic } from "../persistence/files.js";
import { CodexAdapter } from "../codex/adapter/index.js";
import { recordTelemetry } from "../telemetry/recorder.js";
import { nowIso } from "../utils/time.js";

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
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
    default:
      printUsage();
      process.exitCode = command ? 1 : 0;
  }
}

async function initCommand(
  projectRoot: string,
  store: RuntimeStore,
  adapter: CodexAdapter
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
    host: adapter.host
  });

  for (const event of bootstrap.events) {
    await store.appendEvent(event);
  }

  const projection = await store.syncSnapshotFromEvents();
  await adapter.initialize(store, projection);
  await recordTelemetry({
    store,
    eventType: "runtime.initialized",
    taskId: sessionId,
    assignmentId: bootstrap.initialAssignmentId,
    host: adapter.host,
    adapter: adapter.id,
    metadata: {
      projectRoot,
      repoName: basename(projectRoot)
    }
  });

  console.log(`Initialized Coortex runtime at ${store.rootDir}`);
  console.log(`Session: ${sessionId}`);
  console.log(`Adapter: ${adapter.id}`);
}

async function doctorCommand(store: RuntimeStore, adapter: CodexAdapter): Promise<void> {
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
  console.log(`Session: ${projection.sessionId}`);
  console.log(`Objective: ${projection.status.currentObjective}`);
  console.log(`Host: ${projection.status.activeHost}`);
  console.log(`Adapter: ${projection.status.activeAdapter}`);
  console.log(`Active assignments: ${activeAssignments.length}`);
  for (const assignment of activeAssignments) {
    console.log(`- ${assignment.id} ${assignment.state} ${assignment.objective}`);
  }
}

async function resumeCommand(store: RuntimeStore, adapter: CodexAdapter): Promise<void> {
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
  await writeJsonAtomic(envelopePath, envelope);
  await recordTelemetry({
    store,
    eventType: "resume.requested",
    taskId: projection.sessionId,
    host: adapter.host,
    adapter: adapter.id,
    metadata: {
      envelopeChars: envelope.estimatedChars,
      trimApplied: envelope.trimApplied,
      trimmedFields: envelope.trimmedFields.length
    }
  });

  console.log(`Recovery brief generated for ${projection.status.currentObjective}`);
  console.log(`Envelope: ${resolve(envelopePath)}`);
  console.log(toPrettyJson(envelope).trimEnd());
}

function printUsage(): void {
  console.log("Usage: ctx <init|doctor|status|resume>");
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
