import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeConfig } from "../config/types.js";
import type { HostAdapter } from "../adapters/contract.js";
import type { RuntimeEvent } from "../core/events.js";
import { createBootstrapRuntime } from "../core/runtime.js";
import { buildRecoveryBrief } from "../recovery/brief.js";
import { RuntimeStore } from "../persistence/store.js";
import { toSnapshot } from "../projections/runtime-projection.js";
import { recordNormalizedTelemetry } from "../telemetry/recorder.js";
import { nowIso } from "../utils/time.js";

export interface InitRuntimeResult {
  sessionId: string;
  adapterId: string;
  rootDir: string;
}

export interface ResumeRuntimeResult {
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>;
  brief: ReturnType<typeof buildRecoveryBrief>;
  envelope: Awaited<ReturnType<HostAdapter["buildResumeEnvelope"]>>;
  envelopePath: string;
}

export interface RunRuntimeResult {
  projectionBefore: Awaited<ReturnType<typeof loadOperatorProjection>>;
  projectionAfter: Awaited<ReturnType<typeof loadOperatorProjection>>;
  assignment: ReturnType<typeof getRunnableAssignment>;
  envelope: Awaited<ReturnType<HostAdapter["buildResumeEnvelope"]>>;
  execution: Awaited<ReturnType<HostAdapter["executeAssignment"]>>;
}

export async function initRuntime(
  projectRoot: string,
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<InitRuntimeResult | undefined> {
  const existing = await store.loadConfig();
  if (existing) {
    return undefined;
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

  return {
    sessionId,
    adapterId: adapter.id,
    rootDir: store.rootDir
  };
}

export async function resumeRuntime(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<ResumeRuntimeResult> {
  const config = await store.loadConfig();
  if (!config) {
    throw new Error("Coortex is not initialized. Run `ctx init` first.");
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

  return {
    projection,
    brief,
    envelope,
    envelopePath: resolve(envelopePath)
  };
}

export async function runRuntime(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<RunRuntimeResult> {
  const config = await store.loadConfig();
  if (!config) {
    throw new Error("Coortex is not initialized. Run `ctx init` first.");
  }

  const projectionBefore = await loadOperatorProjection(store);
  const assignment = getRunnableAssignment(projectionBefore);
  const brief = buildRecoveryBrief(projectionBefore);
  const envelope = await adapter.buildResumeEnvelope(store, projectionBefore, brief);

  await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry({
      eventType: "host.run.started",
      taskId: projectionBefore.sessionId,
      assignmentId: assignment.id,
      metadata: {
        envelopeChars: envelope.estimatedChars,
        trimApplied: envelope.trimApplied,
        trimmedFields: envelope.trimmedFields.length
      }
    })
  );

  const execution = await adapter.executeAssignment(store, projectionBefore, envelope);
  const events = buildOutcomeEvents(projectionBefore, execution, adapter);
  for (const event of events) {
    await store.appendEvent(event);
  }
  const projectionAfter = await store.syncSnapshotFromEvents();

  if (execution.telemetry) {
    await recordNormalizedTelemetry(store, adapter.normalizeTelemetry(execution.telemetry));
  }

  return {
    projectionBefore,
    projectionAfter,
    assignment,
    envelope,
    execution
  };
}

export async function inspectRuntimeRun(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId?: string
) {
  const config = await store.loadConfig();
  if (!config) {
    throw new Error("Coortex is not initialized. Run `ctx init` first.");
  }
  return adapter.inspectRun(store, assignmentId);
}

export async function loadOperatorProjection(store: RuntimeStore) {
  if (await store.hasEvents()) {
    return store.syncSnapshotFromEvents();
  }
  return store.loadProjection();
}

export function buildOutcomeEvents(
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

export function getRunnableAssignment(
  projection: Awaited<ReturnType<typeof loadOperatorProjection>>
) {
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
