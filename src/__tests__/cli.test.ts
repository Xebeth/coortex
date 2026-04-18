import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { RuntimeStore } from "../persistence/store.js";
import type { RuntimeEvent } from "../core/events.js";
import type { HostRunRecord } from "../core/types.js";
import {
  evaluateWorkflowProgression,
  workflowArtifactPath
} from "../workflows/index.js";
import type { WorkflowArtifactDocument } from "../workflows/types.js";

const execFileAsync = promisify(execFile);
const liveCodexEnv = {
  ...process.env,
  COORTEX_CODEX_DANGEROUS_BYPASS: "1"
};

async function runCliCommand(
  cliPath: string,
  command: string,
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    args?: string[];
  }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, command, ...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function workflowAttemptFromSnapshot(snapshot: {
  workflowProgress?: {
    workflowId: string;
    workflowCycle: number;
    currentModuleId: string;
    currentModuleAttempt: number;
  };
}) {
  assert.ok(snapshot.workflowProgress, "expected workflow progress in snapshot");
  return {
    workflowId: snapshot.workflowProgress.workflowId,
    workflowCycle: snapshot.workflowProgress.workflowCycle,
    moduleId: snapshot.workflowProgress.currentModuleId,
    moduleAttempt: snapshot.workflowProgress.currentModuleAttempt
  };
}

async function appendWorkflowModuleProgression(
  store: RuntimeStore,
  input: {
    artifact: WorkflowArtifactDocument;
    resultId: string;
    summary: string;
    createdAt: string;
    progressionAt: string;
    omitEventTypes?: RuntimeEvent["type"][];
  }
): Promise<{
  createdAssignmentId?: string;
}> {
  await store.writeJsonArtifact(
    workflowArtifactPath(
      input.artifact.workflowId,
      input.artifact.workflowCycle,
      input.artifact.moduleId,
      input.artifact.assignmentId,
      input.artifact.moduleAttempt
    ),
    input.artifact
  );
  const projection = await store.loadProjection();
  await store.appendEvent({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp: input.createdAt,
    type: "result.submitted",
    payload: {
      result: {
        resultId: input.resultId,
        assignmentId: input.artifact.assignmentId,
        producerId: "codex",
        status: "completed",
        summary: input.summary,
        changedFiles: [],
        createdAt: input.createdAt
      }
    }
  });
  const progressedProjection = await store.loadProjection();
  const progression = await evaluateWorkflowProgression(progressedProjection, store, {
    timestamp: input.progressionAt
  });
  const omittedEventTypes = new Set(input.omitEventTypes ?? []);
  for (const event of progression.events) {
    if (omittedEventTypes.has(event.type)) {
      continue;
    }
    await store.appendEvent(event);
  }
  await store.syncSnapshotFromEvents();
  const createdAssignmentId = progression.events.find(
    (event): event is Extract<RuntimeEvent, { type: "assignment.created" }> =>
      event.type === "assignment.created"
  )?.payload.assignment.id;
  return {
    ...(createdAssignmentId ? { createdAssignmentId } : {})
  };
}

async function createCompletedDecisionRecoverySetup(options?: { includeLeftoverLease?: boolean }) {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-completed-decision-status-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const runtimeDir = join(projectRoot, ".coortex");
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string }>;
    workflowProgress: {
      workflowId: string;
      workflowCycle: number;
      currentModuleId: string;
      currentModuleAttempt: number;
    };
  };
  const assignmentId = snapshot.assignments[0]!.id;
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  const completedAt = new Date(Date.now() - 110_000).toISOString();
  const workflowAttempt = workflowAttemptFromSnapshot(snapshot);
  const completedRecord = {
    assignmentId,
    state: "completed",
    workflowAttempt,
    adapterData: {
      nativeRunId: "thread-cli-completed-decision"
    },
    startedAt,
    completedAt,
    outcomeKind: "decision",
    summary: "Need operator confirmation before proceeding.",
    terminalOutcome: {
      kind: "decision",
      decision: {
        decisionId: "decision-cli-completed-status",
        requesterId: "codex",
        blockerSummary: "Need operator confirmation before proceeding.",
        options: [
          { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
          { id: "skip", label: "Skip", summary: "Skip the blocked work." }
        ],
        recommendedOption: "wait",
        state: "open",
        createdAt: completedAt
      }
    }
  };
  await mkdir(join(runtimeDir, "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.json`),
    JSON.stringify(completedRecord, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "last-run.json"),
    JSON.stringify(completedRecord, null, 2),
    "utf8"
  );
  if (options?.includeLeftoverLease) {
    const leftoverLease = {
      assignmentId,
      state: "running",
      adapterData: {
        nativeRunId: "thread-cli-leftover-decision-lease"
      },
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    await writeFile(
      join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`),
      JSON.stringify(leftoverLease, null, 2),
      "utf8"
    );
  }

  return { projectRoot, cliPath, runtimeDir, assignmentId, completedAt };
}

async function createCompletedResultRecoverySetup(options?: {
  resultStatus?: "completed" | "failed";
  summary?: string;
  resultId?: string;
}) {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-completed-result-status-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const runtimeDir = join(projectRoot, ".coortex");
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string }>;
    workflowProgress: {
      workflowId: string;
      workflowCycle: number;
      currentModuleId: string;
      currentModuleAttempt: number;
    };
  };
  const assignmentId = snapshot.assignments[0]!.id;
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  const completedAt = new Date(Date.now() - 110_000).toISOString();
  const workflowAttempt = workflowAttemptFromSnapshot(snapshot);
  const resultStatus = options?.resultStatus ?? "completed";
  const summary = options?.summary ?? "Recovered completed host run for command recovery.";
  const resultId = options?.resultId ?? `result-cli-${resultStatus}-recovery`;
  const completedRecord = {
    assignmentId,
    state: "completed",
    workflowAttempt,
    adapterData: {
      nativeRunId: "thread-cli-completed-result"
    },
    startedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus,
    summary,
    terminalOutcome: {
      kind: "result",
      result: {
        resultId,
        assignmentId,
        producerId: "codex",
        status: resultStatus,
        summary,
        changedFiles: ["src/cli/ctx.ts"],
        createdAt: completedAt
      }
    }
  };
  const leftoverLease = {
    assignmentId,
    state: "running",
    workflowAttempt,
    adapterData: {
      nativeRunId: "thread-cli-leftover-result-lease"
    },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await mkdir(join(runtimeDir, "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.json`),
    JSON.stringify(completedRecord, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "last-run.json"),
    JSON.stringify(completedRecord, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`),
    JSON.stringify(leftoverLease, null, 2),
    "utf8"
  );

  return { projectRoot, cliPath, runtimeDir, assignmentId, completedAt };
}

async function createSameAssignmentRerunInspectSetup(options: {
  terminalKind: "result" | "decision";
  omitCompletedAt?: boolean;
}) {
  const projectRoot = await mkdtemp(join(tmpdir(), `coortex-cli-same-assignment-inspect-${options.terminalKind}-`));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const store = RuntimeStore.forProject(projectRoot);

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const runtimeDir = join(projectRoot, ".coortex");
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    sessionId: string;
    assignments: Array<{ id: string }>;
  };
  const assignmentId = snapshot.assignments[0]!.id;
  const startedAt = "2026-04-18T12:00:30.000Z";
  const terminalAt = "2026-04-18T12:01:00.000Z";
  const appliedAt = "2026-04-18T12:10:00.000Z";

  await store.appendEvent({
    eventId: randomUUID(),
    sessionId: snapshot.sessionId,
    timestamp: appliedAt,
    type: "workflow.transition.applied",
    payload: {
      workflowId: "default",
      fromModuleId: "plan",
      toModuleId: "plan",
      workflowCycle: 1,
      moduleAttempt: 2,
      transition: "rerun_same_module",
      previousAssignmentId: assignmentId,
      nextAssignmentId: assignmentId,
      appliedAt
    }
  });
  await store.syncSnapshotFromEvents();

  const runRecord: HostRunRecord = options.terminalKind === "result"
    ? {
        assignmentId,
        state: "completed" as const,
        adapterData: {
          nativeRunId: "thread-cli-inspect-old-result"
        },
        startedAt,
        outcomeKind: "result" as const,
        resultStatus: "completed" as const,
        summary: "Prior attempt result should stay hidden from ctx inspect.",
        terminalOutcome: {
          kind: "result" as const,
          result: {
            resultId: "result-cli-inspect-old-attempt",
            producerId: "codex",
            status: "completed" as const,
            summary: "Prior attempt result should stay hidden from ctx inspect.",
            changedFiles: [],
            createdAt: terminalAt
          }
        }
      }
    : {
        assignmentId,
        state: "completed" as const,
        adapterData: {
          nativeRunId: "thread-cli-inspect-old-decision"
        },
        startedAt,
        outcomeKind: "decision" as const,
        summary: "Prior attempt decision should stay hidden from ctx inspect.",
        terminalOutcome: {
          kind: "decision" as const,
          decision: {
            decisionId: "decision-cli-inspect-old-attempt",
            requesterId: "codex",
            blockerSummary: "Prior attempt decision should stay hidden from ctx inspect.",
            options: [{ id: "wait", label: "Wait", summary: "Pause." }],
            recommendedOption: "wait",
            state: "open" as const,
            createdAt: terminalAt
          }
        }
      };
  const persistedRun: HostRunRecord = options.omitCompletedAt
    ? runRecord
    : {
        ...runRecord,
        completedAt: terminalAt
      };
  persistedRun.workflowAttempt = {
    workflowId: "default",
    workflowCycle: 1,
    moduleId: "plan",
    moduleAttempt: 1
  };

  await mkdir(join(runtimeDir, "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.json`),
    JSON.stringify(persistedRun, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "last-run.json"),
    JSON.stringify(persistedRun, null, 2),
    "utf8"
  );

  return { projectRoot, cliPath, assignmentId };
}

async function createRuntimeCompletedResultMalformedLeaseSetup() {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-runtime-result-malformed-lease-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const runtimeDir = join(projectRoot, ".coortex");
  const store = RuntimeStore.forProject(projectRoot);
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    sessionId: string;
    assignments: Array<{ id: string }>;
    status: {
      activeMode: string;
      currentObjective: string;
      activeAssignmentIds: string[];
      activeHost: string;
      activeAdapter: string;
      lastDurableOutputAt: string;
      resumeReady: boolean;
    };
  };
  const assignmentId = snapshot.assignments[0]!.id;
  const completedAt = new Date(Date.now() - 110_000).toISOString();

  await store.appendEvent({
    eventId: randomUUID(),
    sessionId: snapshot.sessionId,
    timestamp: completedAt,
    type: "result.submitted",
    payload: {
      result: {
        resultId: "result-cli-runtime-malformed-lease",
        assignmentId,
        producerId: "codex",
        status: "completed",
        summary: "Recovered completed runtime result despite malformed leftover lease.",
        changedFiles: ["src/cli/ctx.ts"],
        createdAt: completedAt
      }
    }
  });
  await store.syncSnapshotFromEvents();
  await mkdir(join(runtimeDir, "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`),
    "{",
    "utf8"
  );

  return { projectRoot, cliPath, runtimeDir, assignmentId, completedAt };
}

async function createRuntimeCompletedDecisionMalformedLeaseSetup() {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-runtime-decision-malformed-lease-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const runtimeDir = join(projectRoot, ".coortex");
  const store = RuntimeStore.forProject(projectRoot);
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    sessionId: string;
    assignments: Array<{ id: string }>;
    status: {
      activeMode: string;
      currentObjective: string;
      activeAssignmentIds: string[];
      activeHost: string;
      activeAdapter: string;
      lastDurableOutputAt: string;
      resumeReady: boolean;
    };
  };
  const assignmentId = snapshot.assignments[0]!.id;
  const completedAt = new Date(Date.now() - 110_000).toISOString();

  await store.appendEvent({
    eventId: randomUUID(),
    sessionId: snapshot.sessionId,
    timestamp: completedAt,
    type: "decision.created",
    payload: {
      decision: {
        decisionId: "decision-cli-runtime-malformed-lease",
        assignmentId,
        requesterId: "codex",
        blockerSummary: "Recovered completed runtime decision despite malformed leftover lease.",
        options: [
          { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
          { id: "skip", label: "Skip", summary: "Skip the blocked work." }
        ],
        recommendedOption: "wait",
        state: "open",
        createdAt: completedAt
      }
    }
  });
  await store.appendEvent({
    eventId: randomUUID(),
    sessionId: snapshot.sessionId,
    timestamp: completedAt,
    type: "assignment.updated",
    payload: {
      assignmentId,
      patch: {
        state: "blocked",
        updatedAt: completedAt
      }
    }
  });
  await store.appendEvent({
    eventId: randomUUID(),
    sessionId: snapshot.sessionId,
    timestamp: completedAt,
    type: "status.updated",
    payload: {
      status: {
        ...snapshot.status,
        currentObjective: "Resolve the recovered decision before continuing.",
        activeAssignmentIds: [assignmentId],
        lastDurableOutputAt: completedAt,
        resumeReady: true
      }
    }
  });
  await store.syncSnapshotFromEvents();
  await mkdir(join(runtimeDir, "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`),
    "{",
    "utf8"
  );

  return { projectRoot, cliPath, runtimeDir, assignmentId, completedAt };
}

async function appendCompletedResultStatusDrift(
  runtimeDir: string,
  currentObjective: string
): Promise<void> {
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    sessionId: string;
    status: {
      activeMode: string;
      currentObjective: string;
      activeAssignmentIds: string[];
      activeHost: string;
      activeAdapter: string;
      lastDurableOutputAt: string;
      resumeReady: boolean;
    };
  };
  const driftTimestamp = new Date(Date.now() + 1_000).toISOString();
  const existingEvents = (await readFile(join(runtimeDir, "runtime", "events.ndjson"), "utf8"))
    .split("\n")
    .filter(Boolean);
  existingEvents.push(
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: snapshot.sessionId,
      timestamp: driftTimestamp,
      type: "status.updated",
      payload: {
        status: {
          ...snapshot.status,
          currentObjective,
          lastDurableOutputAt: driftTimestamp
        }
      }
    })
  );
  await writeFile(join(runtimeDir, "runtime", "events.ndjson"), `${existingEvents.join("\n")}\n`, "utf8");
  await writeFile(
    join(runtimeDir, "runtime", "snapshot.json"),
    JSON.stringify(
      {
        ...snapshot,
        status: {
          ...snapshot.status,
          currentObjective,
          lastDurableOutputAt: driftTimestamp
        }
      },
      null,
      2
    ),
    "utf8"
  );
}

async function appendHistoricalRecoveredCompletedResultStatusEvent(runtimeDir: string): Promise<void> {
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    sessionId: string;
    status: {
      activeMode: string;
      currentObjective: string;
      activeAssignmentIds: string[];
      activeHost: string;
      activeAdapter: string;
      lastDurableOutputAt: string;
      resumeReady: boolean;
    };
  };
  const recoveredTimestamp = new Date(Date.now() - 1_000).toISOString();
  const existingEvents = (await readFile(join(runtimeDir, "runtime", "events.ndjson"), "utf8"))
    .split("\n")
    .filter(Boolean);
  existingEvents.push(
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: snapshot.sessionId,
      timestamp: recoveredTimestamp,
      type: "status.updated",
      payload: {
        status: {
          ...snapshot.status,
          activeMode: "idle",
          currentObjective: "Await the next assignment.",
          activeAssignmentIds: [],
          lastDurableOutputAt: recoveredTimestamp,
          resumeReady: true
        }
      }
    })
  );
  await writeFile(join(runtimeDir, "runtime", "events.ndjson"), `${existingEvents.join("\n")}\n`, "utf8");
}

async function appendHistoricalRecoveredCompletedResultSequence(
  runtimeDir: string,
  assignmentId: string,
  completedAt: string
): Promise<void> {
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    sessionId: string;
    status: {
      activeMode: string;
      currentObjective: string;
      activeAssignmentIds: string[];
      activeHost: string;
      activeAdapter: string;
      lastDurableOutputAt: string;
      resumeReady: boolean;
    };
  };
  const existingEvents = (await readFile(join(runtimeDir, "runtime", "events.ndjson"), "utf8"))
    .split("\n")
    .filter(Boolean);
  existingEvents.push(
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: snapshot.sessionId,
      timestamp: completedAt,
      type: "result.submitted",
      payload: {
        result: {
          resultId: "result-cli-completed-recovery",
          assignmentId,
          producerId: "codex",
          status: "completed",
          summary: "Recovered completed host run for command recovery.",
          changedFiles: ["src/cli/ctx.ts"],
          createdAt: completedAt
        }
      }
    }),
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: snapshot.sessionId,
      timestamp: completedAt,
      type: "assignment.updated",
      payload: {
        assignmentId,
        patch: {
          state: "completed",
          updatedAt: completedAt
        }
      }
    }),
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: snapshot.sessionId,
      timestamp: completedAt,
      type: "status.updated",
      payload: {
        status: {
          ...snapshot.status,
          activeMode: "idle",
          currentObjective: "Await the next assignment.",
          activeAssignmentIds: [],
          lastDurableOutputAt: completedAt,
          resumeReady: true
        }
      }
    })
  );
  await writeFile(join(runtimeDir, "runtime", "events.ndjson"), `${existingEvents.join("\n")}\n`, "utf8");
}

async function appendHistoricalRecoveredCompletedDecisionSequence(
  runtimeDir: string,
  assignmentId: string,
  completedAt: string
): Promise<void> {
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    sessionId: string;
    status: {
      activeMode: string;
      currentObjective: string;
      activeAssignmentIds: string[];
      activeHost: string;
      activeAdapter: string;
      lastDurableOutputAt: string;
      resumeReady: boolean;
    };
  };
  const existingEvents = (await readFile(join(runtimeDir, "runtime", "events.ndjson"), "utf8"))
    .split("\n")
    .filter(Boolean);
  existingEvents.push(
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: snapshot.sessionId,
      timestamp: completedAt,
      type: "decision.created",
      payload: {
        decision: {
          decisionId: "decision-cli-completed-status",
          assignmentId,
          requesterId: "codex",
          blockerSummary: "Need operator confirmation before proceeding.",
          options: [
            { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
            { id: "skip", label: "Skip", summary: "Skip the blocked work." }
          ],
          recommendedOption: "wait",
          state: "open",
          createdAt: completedAt
        }
      }
    }),
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: snapshot.sessionId,
      timestamp: completedAt,
      type: "assignment.updated",
      payload: {
        assignmentId,
        patch: {
          state: "blocked",
          updatedAt: completedAt
        }
      }
    }),
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: snapshot.sessionId,
      timestamp: completedAt,
      type: "status.updated",
      payload: {
        status: {
          ...snapshot.status,
          currentObjective: "Resolve the recovered decision before continuing.",
          lastDurableOutputAt: completedAt,
          resumeReady: true
        }
      }
    })
  );
  await writeFile(join(runtimeDir, "runtime", "events.ndjson"), `${existingEvents.join("\n")}\n`, "utf8");
}

async function countRecoveredOutcomeEvents(
  runtimeDir: string,
  assignmentId: string,
  eventType: "result.submitted" | "decision.created"
): Promise<number> {
  const events = (await readFile(join(runtimeDir, "runtime", "events.ndjson"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as {
          type: string;
          payload: { result?: { assignmentId: string }; decision?: { assignmentId: string } };
        }];
      } catch {
        return [];
      }
    });

  if (eventType === "result.submitted") {
    return events.filter(
      (event) => event.type === "result.submitted" && event.payload.result?.assignmentId === assignmentId
    ).length;
  }

  return events.filter(
    (event) => event.type === "decision.created" && event.payload.decision?.assignmentId === assignmentId
  ).length;
}

async function countQueuedAssignmentUpdatedEvents(runtimeDir: string, assignmentId: string): Promise<number> {
  const events = (await readFile(join(runtimeDir, "runtime", "events.ndjson"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      type: string;
      payload: { assignmentId?: string; patch?: { state?: string } };
    });

  return events.filter(
    (event) =>
      event.type === "assignment.updated" &&
      event.payload.assignmentId === assignmentId &&
      event.payload.patch?.state === "queued"
  ).length;
}

async function corruptSnapshotBoundary(runtimeDir: string): Promise<void> {
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as { lastEventId?: string };
  assert.ok(snapshot.lastEventId, "expected a snapshot boundary before corruption");
  const eventLines = (await readFile(join(runtimeDir, "runtime", "events.ndjson"), "utf8")).trimEnd().split("\n");
  const boundaryIndex = eventLines.findIndex((line) => {
    const parsed = JSON.parse(line) as { eventId?: string };
    return parsed.eventId === snapshot.lastEventId;
  });
  assert.ok(boundaryIndex >= 0, "expected to find the snapshot boundary event");
  eventLines[boundaryIndex] = "{\"broken\":";
  await writeFile(join(runtimeDir, "runtime", "events.ndjson"), `${eventLines.join("\n")}\n`, "utf8");
}

test("ctx init, status, resume, run, inspect, and doctor work against persisted runtime state", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const fixturePath = join(projectRoot, "codex-exec-fixture.json");

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        exitCode: 0,
        stdoutLines: [
          { type: "thread.started", thread_id: "thread-cli-1" },
          {
            type: "turn.completed",
            usage: {
              input_tokens: 44,
              cached_input_tokens: 10,
              output_tokens: 12
            }
          }
        ],
        lastMessage: {
          outcomeType: "result",
          resultStatus: "completed",
          resultSummary: "Completed the Milestone 2 execution slice.",
          changedFiles: ["src/cli/ctx.ts"],
          blockerSummary: "",
          decisionOptions: [],
          recommendedOption: ""
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const env = {
    ...process.env,
    COORTEX_CODEX_EXEC_FIXTURE: fixturePath
  };

  const init = await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot,
    env
  });
  assert.match(init.stdout, /Initialized Coortex runtime/);

  const status = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot,
    env
  });
  assert.match(status.stdout, /Active assignments: 1/);
  assert.match(status.stdout, /Results: 0/);
  assert.match(status.stdout, /Workflow: default/);
  assert.match(status.stdout, /Current module: plan/);

  const resume = await execFileAsync(process.execPath, [cliPath, "resume"], {
    cwd: projectRoot,
    env
  });
  assert.match(resume.stdout, /Recovery brief generated/);

  const run = await execFileAsync(process.execPath, [cliPath, "run"], {
    cwd: projectRoot,
    env
  });
  assert.match(run.stdout, /Executed assignment/);
  assert.match(run.stdout, /Host run: thread-cli-1/);
  assert.match(run.stdout, /Result \(completed\): Completed the Milestone 2 execution slice\./);

  const inspect = await execFileAsync(process.execPath, [cliPath, "inspect"], {
    cwd: projectRoot,
    env
  });
  assert.match(inspect.stdout, /"workflow": \{/);
  assert.match(inspect.stdout, /"run": null/);

  const doctor = await execFileAsync(process.execPath, [cliPath, "doctor"], {
    cwd: projectRoot,
    env
  });
  assert.match(doctor.stdout, /OK codex-profile/);
  assert.match(doctor.stdout, /OK codex-skill-pack/);
  assert.match(doctor.stdout, /OK codex-exec-schema/);
  assert.match(doctor.stdout, /OK codex-danger-mode disabled/);

  const codexConfig = await readFile(join(projectRoot, ".codex", "config.toml"), "utf8");
  assert.match(codexConfig, /model_instructions_file = "/);
  const skillPackManifest = JSON.parse(
    await readFile(join(projectRoot, ".coortex", "adapters", "codex", "skill-pack.json"), "utf8")
  ) as { managedSkills: string[] };
  assert.deepEqual(skillPackManifest.managedSkills, [
    "coortex-review-lane",
    "review-baseline",
    "review-fixer",
    "review-orchestrator"
  ]);
  for (const skillName of skillPackManifest.managedSkills) {
    await readFile(join(projectRoot, ".codex", "skills", skillName, "SKILL.md"), "utf8");
  }
  const reviewFixerSkill = await readFile(join(projectRoot, ".codex", "skills", "review-fixer", "SKILL.md"), "utf8");
  const reviewLaneSkill = await readFile(join(projectRoot, ".codex", "skills", "coortex-review-lane", "SKILL.md"), "utf8");
  assert.match(reviewFixerSkill, /Review Fixer/);
  assert.match(reviewLaneSkill, /Coortex Review Lane/);

  const envelope = await readFile(
    join(projectRoot, ".coortex", "runtime", "last-resume-envelope.json"),
    "utf8"
  );
  assert.match(envelope, /"adapter": "codex"/);

  const snapshot = JSON.parse(
    await readFile(join(projectRoot, ".coortex", "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    results: Array<{ status: string; summary: string }>;
    status: { activeAssignmentIds: string[] };
    workflowProgress: { currentModuleId: string; currentModuleAttempt: number };
  };
  assert.equal(snapshot.results.length, 1);
  assert.equal(snapshot.results[0]?.status, "completed");
  assert.deepEqual(snapshot.status.activeAssignmentIds, [snapshot.assignments[0]!.id]);
  assert.equal(snapshot.assignments[0]?.state, "queued");
  assert.equal(snapshot.workflowProgress.currentModuleId, "plan");
  assert.equal(snapshot.workflowProgress.currentModuleAttempt, 2);

  const telemetry = await readFile(join(projectRoot, ".coortex", "runtime", "telemetry.ndjson"), "utf8");
  assert.match(telemetry, /"eventType":"host.run.started"/);
  assert.match(telemetry, /"eventType":"host.run.completed"/);
  assert.match(telemetry, /"inputTokens":44/);
});

test("ctx run exits 0 and records a decision outcome from a fixture", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-decision-run-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const fixturePath = join(projectRoot, "codex-decision-fixture.json");

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        exitCode: 0,
        stdoutLines: [{ type: "thread.started", thread_id: "thread-cli-decision-1" }],
        lastMessage: {
          outcomeType: "decision",
          resultStatus: "",
          resultSummary: "",
          changedFiles: [],
          blockerSummary: "Need operator guidance before proceeding.",
          decisionOptions: [
            { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
            { id: "skip", label: "Skip", summary: "Skip the blocked work." }
          ],
          recommendedOption: "wait"
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const env = {
    ...process.env,
    COORTEX_CODEX_EXEC_FIXTURE: fixturePath
  };

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot,
    env
  });

  const run = await runCliCommand(cliPath, "run", {
    cwd: projectRoot,
    env
  });
  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /Executed assignment/);
  assert.match(run.stdout, /Host run: thread-cli-decision-1/);
  assert.match(run.stdout, /Decision: Need operator guidance before proceeding\./);
  assert.match(run.stdout, /Recommended option: wait/);

  const snapshot = JSON.parse(
    await readFile(join(projectRoot, ".coortex", "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    decisions: Array<{
      assignmentId: string;
      blockerSummary: string;
      recommendedOption: string;
      state: string;
    }>;
    status: { activeAssignmentIds: string[] };
  };

  assert.equal(snapshot.assignments[0]?.state, "blocked");
  assert.equal(snapshot.assignments[0]?.id, snapshot.status.activeAssignmentIds[0]);
  assert.equal(snapshot.decisions.length, 1);
  assert.equal(snapshot.decisions[0]?.assignmentId, snapshot.assignments[0]?.id);
  assert.equal(snapshot.decisions[0]?.state, "open");
  assert.equal(snapshot.decisions[0]?.blockerSummary, "Need operator guidance before proceeding.");
  assert.equal(snapshot.decisions[0]?.recommendedOption, "wait");
});

test("ctx status and resume recover from snapshot when the event log is missing", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-snapshot-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  await rm(join(projectRoot, ".coortex", "runtime", "events.ndjson"));

  const status = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  assert.match(status.stdout, /Active assignments: 1/);
  assert.doesNotMatch(status.stdout, /No active objective/);

  const resume = await execFileAsync(process.execPath, [cliPath, "resume"], {
    cwd: projectRoot
  });
  assert.match(resume.stdout, /Recovery brief generated/);
});

test("ctx status and resume ignore a malformed convenience last-run pointer", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-malformed-last-run-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const runtimeDir = join(projectRoot, ".coortex");
  await mkdir(join(runtimeDir, "adapters", "codex"), { recursive: true });
  await writeFile(join(runtimeDir, "adapters", "codex", "last-run.json"), "{", "utf8");

  const status = await runCliCommand(cliPath, "status", {
    cwd: projectRoot
  });
  const resume = await runCliCommand(cliPath, "resume", {
    cwd: projectRoot
  });

  assert.equal(status.exitCode, 0);
  assert.match(status.stdout, /Active assignments: 1/);
  assert.doesNotMatch(status.stderr, /Failed to parse codex run record/);

  assert.equal(resume.exitCode, 0);
  assert.match(resume.stdout, /Recovery brief generated/);
  assert.doesNotMatch(resume.stderr, /Failed to parse codex run record/);
});

test("ctx inspect ignores a parseable but invalid convenience last-run pointer", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-invalid-last-run-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const runtimeDir = join(projectRoot, ".coortex");
  await mkdir(join(runtimeDir, "adapters", "codex"), { recursive: true });
  await writeFile(join(runtimeDir, "adapters", "codex", "last-run.json"), "{}\n", "utf8");

  const inspect = await runCliCommand(cliPath, "inspect", {
    cwd: projectRoot
  });

  assert.equal(inspect.exitCode, 0);
  assert.match(inspect.stdout, /"workflow": \{/);
  assert.match(inspect.stdout, /"run": null/);
  assert.equal(inspect.stderr.trim(), "");
});

test("ctx inspect prefers the current workflow assignment over an unrelated last recorded host run", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-inspect-workflow-precedence-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const store = RuntimeStore.forProject(projectRoot);

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const snapshot = await store.loadSnapshot();
  assert.ok(snapshot, "expected snapshot after init");
  const workflowAssignmentId = snapshot.assignments[0]!.id;
  const secondaryAssignmentId = randomUUID();
  const assignmentTimestamp = new Date(Date.now() - 10_000).toISOString();

  await store.appendEvent({
    eventId: randomUUID(),
    sessionId: snapshot.sessionId,
    timestamp: assignmentTimestamp,
    type: "assignment.created",
    payload: {
      assignment: {
        id: secondaryAssignmentId,
        parentTaskId: snapshot.sessionId,
        workflow: "default",
        ownerType: "runtime",
        ownerId: "codex:test",
        objective: "Inspect the non-workflow assignment.",
        writeScope: ["README.md"],
        requiredOutputs: ["result"],
        state: "queued",
        createdAt: assignmentTimestamp,
        updatedAt: assignmentTimestamp
      }
    }
  });
  await store.syncSnapshotFromEvents();

  const unrelatedLastRun = {
    assignmentId: secondaryAssignmentId,
    state: "completed",
    adapterData: {
      nativeRunId: "thread-cli-inspect-secondary"
    },
    startedAt: new Date(Date.now() - 20_000).toISOString(),
    completedAt: new Date(Date.now() - 15_000).toISOString(),
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Last recorded run belongs to another assignment.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: randomUUID(),
        producerId: "codex",
        status: "completed",
        summary: "Last recorded run belongs to another assignment.",
        changedFiles: [],
        createdAt: new Date(Date.now() - 15_000).toISOString()
      }
    }
  };
  await store.writeJsonArtifact(`adapters/codex/runs/${secondaryAssignmentId}.json`, unrelatedLastRun);
  await store.writeJsonArtifact("adapters/codex/last-run.json", unrelatedLastRun);

  const inspect = await runCliCommand(cliPath, "inspect", {
    cwd: projectRoot
  });
  const payload = JSON.parse(inspect.stdout) as {
    workflow: { currentAssignmentId: string | null };
    assignment: { id: string } | null;
    run: { assignmentId: string } | null;
  };

  assert.equal(inspect.exitCode, 0);
  assert.equal(payload.workflow.currentAssignmentId, workflowAssignmentId);
  assert.equal(payload.assignment?.id, workflowAssignmentId);
  assert.equal(payload.run, null);
});

test("ctx inspect explicit assignment id overrides workflow and last-run targets", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-inspect-explicit-precedence-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const store = RuntimeStore.forProject(projectRoot);

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const snapshot = await store.loadSnapshot();
  assert.ok(snapshot, "expected snapshot after init");
  const explicitAssignmentId = randomUUID();
  const lastRunAssignmentId = randomUUID();
  const assignmentTimestamp = new Date(Date.now() - 10_000).toISOString();

  for (const [assignmentId, objective] of [
    [explicitAssignmentId, "Inspect the explicitly requested assignment."],
    [lastRunAssignmentId, "Inspect the last-run assignment."]
  ] as const) {
    await store.appendEvent({
      eventId: randomUUID(),
      sessionId: snapshot.sessionId,
      timestamp: assignmentTimestamp,
      type: "assignment.created",
      payload: {
        assignment: {
          id: assignmentId,
          parentTaskId: snapshot.sessionId,
          workflow: "default",
          ownerType: "runtime",
          ownerId: "codex:test",
          objective,
          writeScope: ["README.md"],
          requiredOutputs: ["result"],
          state: "queued",
          createdAt: assignmentTimestamp,
          updatedAt: assignmentTimestamp
        }
      }
    });
  }
  await store.syncSnapshotFromEvents();

  const explicitRun = {
    assignmentId: explicitAssignmentId,
    state: "completed",
    adapterData: {
      nativeRunId: "thread-cli-inspect-explicit"
    },
    startedAt: new Date(Date.now() - 20_000).toISOString(),
    completedAt: new Date(Date.now() - 18_000).toISOString(),
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Explicit assignment run.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: randomUUID(),
        producerId: "codex",
        status: "completed",
        summary: "Explicit assignment run.",
        changedFiles: [],
        createdAt: new Date(Date.now() - 18_000).toISOString()
      }
    }
  };
  const lastRun = {
    assignmentId: lastRunAssignmentId,
    state: "completed",
    adapterData: {
      nativeRunId: "thread-cli-inspect-last-run"
    },
    startedAt: new Date(Date.now() - 17_000).toISOString(),
    completedAt: new Date(Date.now() - 16_000).toISOString(),
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Last-run assignment record.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: randomUUID(),
        producerId: "codex",
        status: "completed",
        summary: "Last-run assignment record.",
        changedFiles: [],
        createdAt: new Date(Date.now() - 16_000).toISOString()
      }
    }
  };
  await store.writeJsonArtifact(`adapters/codex/runs/${explicitAssignmentId}.json`, explicitRun);
  await store.writeJsonArtifact(`adapters/codex/runs/${lastRunAssignmentId}.json`, lastRun);
  await store.writeJsonArtifact("adapters/codex/last-run.json", lastRun);

  const inspect = await runCliCommand(cliPath, "inspect", {
    cwd: projectRoot,
    args: [explicitAssignmentId]
  });
  const payload = JSON.parse(inspect.stdout) as {
    workflow: { currentAssignmentId: string | null };
    assignment: { id: string; objective: string } | null;
    run: { assignmentId: string; adapterData?: { nativeRunId?: string } } | null;
  };

  assert.equal(inspect.exitCode, 0);
  assert.notEqual(payload.workflow.currentAssignmentId, explicitAssignmentId);
  assert.equal(payload.assignment?.id, explicitAssignmentId);
  assert.equal(payload.assignment?.objective, "Inspect the explicitly requested assignment.");
  assert.equal(payload.run?.assignmentId, explicitAssignmentId);
  assert.equal(payload.run?.adapterData?.nativeRunId, "thread-cli-inspect-explicit");
});

test("ctx inspect fails when an explicit assignment id matches neither assignment nor run", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-inspect-missing-explicit-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const inspect = await runCliCommand(cliPath, "inspect", {
    cwd: projectRoot,
    args: ["00000000-0000-0000-0000-000000000000"]
  });

  assert.equal(inspect.exitCode, 1);
  assert.equal(inspect.stdout.trim(), "No runtime context found.");
  assert.equal(inspect.stderr.trim(), "");
});

test("ctx inspect prints reconciliation diagnostics when it repairs a completed host run", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-completed-inspect-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const runtimeDir = join(projectRoot, ".coortex");
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string }>;
    results: Array<{ status: string; summary: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
    workflowProgress: {
      workflowId: string;
      workflowCycle: number;
      currentModuleId: string;
      currentModuleAttempt: number;
    };
  };
  const assignmentId = snapshot.assignments[0]!.id;
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  const completedAt = new Date(Date.now() - 110_000).toISOString();
  const workflowAttempt = workflowAttemptFromSnapshot(snapshot);
  const completedRecord = {
    assignmentId,
    state: "completed",
    workflowAttempt,
    adapterData: {
      nativeRunId: "thread-cli-completed-inspect"
    },
    startedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Recovered completed host run for ctx inspect.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: "result-cli-completed-inspect",
        assignmentId,
        producerId: "codex",
        status: "completed",
        summary: "Recovered completed host run for ctx inspect.",
        changedFiles: ["src/cli/ctx.ts"],
        createdAt: completedAt
      }
    }
  };
  const leftoverLease = {
    assignmentId,
    state: "running",
    workflowAttempt,
    adapterData: {
      nativeRunId: "thread-cli-completed-inspect-leftover-lease"
    },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await mkdir(join(runtimeDir, "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.json`),
    JSON.stringify(completedRecord, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "last-run.json"),
    JSON.stringify(completedRecord, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`),
    JSON.stringify(leftoverLease, null, 2),
    "utf8"
  );

  const inspect = await runCliCommand(cliPath, "inspect", {
    cwd: projectRoot
  });
  const payload = JSON.parse(inspect.stdout) as {
    workflow: { currentAssignmentId: string | null; currentModuleState: string };
    assignment: { id: string; state: string } | null;
    run: { assignmentId: string; summary?: string } | null;
  };

  assert.equal(inspect.exitCode, 0);
  assert.match(
    inspect.stderr,
    /WARNING completed-run-reconciled Recovered completed host outcome/
  );
  assert.equal(payload.workflow.currentAssignmentId, assignmentId);
  assert.equal(payload.workflow.currentModuleState, "queued");
  assert.equal(payload.assignment?.id, assignmentId);
  assert.equal(payload.assignment?.state, "queued");
  assert.equal(payload.run, null);
});

test("ctx inspect hides prior-attempt same-assignment runs after a rerun", async () => {
  for (const variant of [
    { terminalKind: "result" as const, omitCompletedAt: false },
    { terminalKind: "result" as const, omitCompletedAt: true },
    { terminalKind: "decision" as const, omitCompletedAt: true }
  ]) {
    const { projectRoot, cliPath, assignmentId } = await createSameAssignmentRerunInspectSetup(variant);

    const inspect = await runCliCommand(cliPath, "inspect", {
      cwd: projectRoot
    });
    const explicitInspect = await runCliCommand(cliPath, "inspect", {
      cwd: projectRoot,
      args: [assignmentId]
    });

    for (const commandResult of [inspect, explicitInspect]) {
      const payload = JSON.parse(commandResult.stdout) as {
        workflow: { currentAssignmentId: string | null; currentModuleState: string };
        assignment: { id: string; state: string } | null;
        run: { assignmentId: string } | null;
      };

      assert.equal(commandResult.exitCode, 0);
      assert.equal(payload.workflow.currentAssignmentId, assignmentId);
      assert.equal(payload.workflow.currentModuleState, "queued");
      assert.equal(payload.assignment?.id, assignmentId);
      assert.equal(payload.assignment?.state, "queued");
      assert.equal(payload.run, null);
      assert.equal(commandResult.stderr.trim(), "");
    }
  }
});

test("ctx status reconciles stale host run leases before reporting active work", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-stale-status-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const runtimeDir = join(projectRoot, ".coortex");
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string }>;
    workflowProgress?: {
      workflowId: string;
      workflowCycle: number;
      currentModuleId: string;
      currentModuleAttempt: number;
    };
  };
  const assignmentId = snapshot.assignments[0]!.id;
  const workflowAttempt = workflowAttemptFromSnapshot(snapshot);
  const staleAt = new Date(Date.now() - 60_000).toISOString();
  const staleRecord = {
    assignmentId,
    state: "running",
    workflowAttempt,
    adapterData: {
      nativeRunId: "thread-cli-stale-status"
    },
    startedAt: staleAt,
    heartbeatAt: staleAt,
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  await mkdir(join(runtimeDir, "adapters", "codex", "runs"), { recursive: true });

  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.json`),
    JSON.stringify(staleRecord, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "last-run.json"),
    JSON.stringify(staleRecord, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`),
    JSON.stringify(staleRecord, null, 2),
    "utf8"
  );
  const eventsPath = join(runtimeDir, "runtime", "events.ndjson");
  const originalEvents = await readFile(eventsPath, "utf8");
  await writeFile(eventsPath, `${originalEvents.trimEnd()}\n{"broken":\n`, "utf8");

  const status = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  const repairedSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
  };

  assert.match(status.stderr, /WARNING stale-run-reconciled/);
  assert.match(status.stderr, /WARNING event-log-salvaged .*skipped malformed line/);
  assert.match(status.stdout, new RegExp(`- ${assignmentId} queued `));
  assert.equal(repairedSnapshot.assignments[0]?.state, "queued");
  await assert.rejects(
    readFile(join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`), "utf8"),
    /ENOENT/
  );
});

test("ctx status repairs stale host run leases after snapshot fallback", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-stale-status-fallback-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const runtimeDir = join(projectRoot, ".coortex");
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    sessionId: string;
    lastEventId?: string;
    assignments: Array<{ id: string; objective: string; state: string }>;
    status: {
      activeHost: string;
      activeAdapter: string;
      currentObjective: string;
      activeAssignmentIds: string[];
      lastDurableOutputAt: string;
      resumeReady: boolean;
    };
    workflowProgress?: {
      workflowId: string;
      workflowCycle: number;
      currentModuleId: string;
      currentModuleAttempt: number;
    };
  };
  const assignmentId = snapshot.assignments[0]!.id;
  const workflowAttempt = workflowAttemptFromSnapshot(snapshot);
  const staleAt = new Date(Date.now() - 60_000).toISOString();
  const staleRecord = {
    assignmentId,
    state: "running",
    workflowAttempt,
    adapterData: {
      nativeRunId: "thread-cli-stale-status-fallback"
    },
    startedAt: staleAt,
    heartbeatAt: staleAt,
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  await mkdir(join(runtimeDir, "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.json`),
    JSON.stringify(staleRecord, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "last-run.json"),
    JSON.stringify(staleRecord, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`),
    JSON.stringify(staleRecord, null, 2),
    "utf8"
  );

  const eventsPath = join(runtimeDir, "runtime", "events.ndjson");
  const originalEvents = (await readFile(eventsPath, "utf8")).trimEnd().split("\n");
  const boundaryIndex = originalEvents.findIndex((line) => {
    const parsed = JSON.parse(line) as { eventId: string };
    return parsed.eventId === snapshot.lastEventId;
  });
  assert.ok(boundaryIndex >= 0, "expected to find the snapshot boundary event");

  const queuedTimestamp = new Date(Date.now() + 1_000).toISOString();
  const statusTimestamp = new Date(Date.now() + 2_000).toISOString();
  originalEvents.push(
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: snapshot.sessionId,
      timestamp: queuedTimestamp,
      type: "assignment.updated",
      payload: {
        assignmentId,
        patch: {
          state: "queued",
          updatedAt: queuedTimestamp
        }
      }
    }),
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: snapshot.sessionId,
      timestamp: statusTimestamp,
      type: "status.updated",
      payload: {
        status: {
          ...snapshot.status,
          activeAssignmentIds: [assignmentId],
          currentObjective: `Retry assignment ${assignmentId}: ${snapshot.assignments[0]!.objective}`,
          lastDurableOutputAt: statusTimestamp,
          resumeReady: true
        }
      }
    })
  );
  originalEvents[boundaryIndex] = '{"broken":';
  await writeFile(eventsPath, `${originalEvents.join("\n")}\n`, "utf8");

  const status = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  const repairedSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
  };

  assert.match(status.stderr, /WARNING stale-run-reconciled/);
  assert.match(status.stderr, /WARNING event-log-salvaged .*Fell back to .*snapshot\.json/);
  assert.match(status.stdout, new RegExp(`- ${assignmentId} queued `));
  assert.equal(repairedSnapshot.assignments[0]?.state, "queued");
  await assert.rejects(
    readFile(join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`), "utf8"),
    /ENOENT/
  );
});

test("ctx status cleans hidden stale snapshot-fallback runs without hydrating them", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-hidden-stale-status-fallback-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const runtimeDir = join(projectRoot, ".coortex");
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    sessionId: string;
    lastEventId?: string;
    status: {
      activeHost: string;
      activeAdapter: string;
      currentObjective: string;
      activeAssignmentIds: string[];
      lastDurableOutputAt: string;
      resumeReady: boolean;
    };
  };
  const hiddenAssignmentId = randomUUID();
  const hiddenTimestamp = new Date(Date.now() + 1_000).toISOString();
  const hiddenAssignmentEvent = {
    eventId: randomUUID(),
    sessionId: snapshot.sessionId,
    timestamp: hiddenTimestamp,
    type: "assignment.created" as const,
    payload: {
      assignment: {
        id: hiddenAssignmentId,
        parentTaskId: "task-hidden-stale-snapshot-fallback",
        workflow: "milestone-2",
        ownerType: "host" as const,
        ownerId: "codex",
        objective: "Hidden stale assignment beyond the snapshot boundary.",
        writeScope: ["README.md"],
        requiredOutputs: ["result"],
        state: "queued" as const,
        createdAt: hiddenTimestamp,
        updatedAt: hiddenTimestamp
      }
    }
  };
  const eventsPath = join(runtimeDir, "runtime", "events.ndjson");
  const originalEvents = (await readFile(eventsPath, "utf8")).trimEnd().split("\n");
  originalEvents.push(JSON.stringify(hiddenAssignmentEvent));
  await writeFile(eventsPath, `${originalEvents.join("\n")}\n`, "utf8");

  const staleRecord = {
    assignmentId: hiddenAssignmentId,
    state: "running",
    adapterData: {
      nativeRunId: "thread-cli-hidden-stale-status-fallback"
    },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString()
  };
  await mkdir(join(runtimeDir, "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${hiddenAssignmentId}.json`),
    JSON.stringify(staleRecord, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${hiddenAssignmentId}.lease.json`),
    JSON.stringify(staleRecord, null, 2),
    "utf8"
  );
  await corruptSnapshotBoundary(runtimeDir);

  const status = await runCliCommand(cliPath, "status", {
    cwd: projectRoot
  });
  const repairedSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
  };

  assert.equal(status.exitCode, 0);
  assert.match(status.stderr, /WARNING hidden-run-cleaned Cleared stale host run artifacts for non-current workflow assignment/);
  assert.doesNotMatch(status.stderr, /WARNING stale-run-reconciled/);
  assert.match(status.stderr, /WARNING event-log-salvaged .*Fell back to .*snapshot\.json/);
  assert.doesNotMatch(status.stdout, new RegExp(hiddenAssignmentId));
  assert.match(status.stdout, /Active assignments: 1/);
  assert.equal(
    repairedSnapshot.assignments.some((assignment) => assignment.id === hiddenAssignmentId),
    false
  );
  await assert.rejects(
    readFile(join(runtimeDir, "adapters", "codex", "runs", `${hiddenAssignmentId}.lease.json`), "utf8"),
    /ENOENT/
  );
});

test("ctx status and resume surface hidden snapshot-fallback active lease blockers", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-hidden-active-lease-fallback-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const runtimeDir = join(projectRoot, ".coortex");
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    sessionId: string;
  };
  const hiddenAssignmentId = randomUUID();
  const hiddenTimestamp = new Date(Date.now() + 1_000).toISOString();
  const hiddenAssignmentEvent = {
    eventId: randomUUID(),
    sessionId: snapshot.sessionId,
    timestamp: hiddenTimestamp,
    type: "assignment.created" as const,
    payload: {
      assignment: {
        id: hiddenAssignmentId,
        parentTaskId: "task-hidden-active-lease-snapshot-fallback",
        workflow: "milestone-2",
        ownerType: "host" as const,
        ownerId: "codex",
        objective: "Hidden assignment behind an authoritative active lease.",
        writeScope: ["README.md"],
        requiredOutputs: ["result"],
        state: "in_progress" as const,
        createdAt: hiddenTimestamp,
        updatedAt: hiddenTimestamp
      }
    }
  };
  const eventsPath = join(runtimeDir, "runtime", "events.ndjson");
  const originalEvents = (await readFile(eventsPath, "utf8")).trimEnd().split("\n");
  originalEvents.push(JSON.stringify(hiddenAssignmentEvent));
  await writeFile(eventsPath, `${originalEvents.join("\n")}\n`, "utf8");

  const activeLease = {
    assignmentId: hiddenAssignmentId,
    state: "running",
    adapterData: {
      nativeRunId: "thread-cli-hidden-active-lease-fallback"
    },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await mkdir(join(runtimeDir, "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${hiddenAssignmentId}.json`),
    JSON.stringify(activeLease, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${hiddenAssignmentId}.lease.json`),
    JSON.stringify(activeLease, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "last-run.json"),
    JSON.stringify(activeLease, null, 2),
    "utf8"
  );
  await corruptSnapshotBoundary(runtimeDir);

  const initialEnvelope = await readFile(
    join(runtimeDir, "runtime", "last-resume-envelope.json"),
    "utf8"
  );
  const status = await runCliCommand(cliPath, "status", {
    cwd: projectRoot
  });
  const resume = await runCliCommand(cliPath, "resume", {
    cwd: projectRoot
  });
  const finalEnvelope = await readFile(
    join(runtimeDir, "runtime", "last-resume-envelope.json"),
    "utf8"
  );

  assert.equal(status.exitCode, 0);
  assert.match(status.stderr, /WARNING active-run-present .*active host run lease/);
  assert.match(status.stderr, /WARNING event-log-salvaged .*Fell back to .*snapshot\.json/);
  assert.match(status.stdout, /Active assignments: 1/);
  assert.match(status.stdout, /Authoritative host leases: 1/);
  assert.match(
    status.stdout,
    new RegExp(`- ${hiddenAssignmentId} active host run lease outside the current projection`)
  );
  assert.equal(resume.exitCode, 1);
  assert.doesNotMatch(resume.stdout, /Recovery brief generated/);
  assert.match(
    resume.stderr,
    new RegExp(`Assignment ${hiddenAssignmentId} already has an active host run lease\\.`)
  );
  assert.equal(finalEnvelope, initialEnvelope);
});

test("ctx status and resume surface in-projection authoritative lease blockers", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-in-projection-active-lease-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const runtimeDir = join(projectRoot, ".coortex");
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    sessionId: string;
    assignments: Array<{
      id: string;
      parentTaskId: string;
      workflow: string;
      ownerType: "runtime" | "host";
      ownerId: string;
      objective: string;
      writeScope: string[];
      requiredOutputs: string[];
      state: "queued" | "in_progress" | "blocked" | "completed" | "failed";
      createdAt: string;
      updatedAt: string;
    }>;
    status: {
      activeMode: string;
      currentObjective: string;
      activeAssignmentIds: string[];
      activeHost: string;
      activeAdapter: string;
      lastDurableOutputAt: string;
      resumeReady: boolean;
    };
    workflowProgress?: {
      workflowId: string;
      workflowCycle: number;
      currentModuleId: string;
      currentModuleAttempt: number;
    };
  };
  const authoritativeAssignmentId = snapshot.assignments[0]!.id;
  const workflowAttempt = workflowAttemptFromSnapshot(snapshot);
  const driftedAssignmentId = randomUUID();
  const driftTimestamp = new Date(Date.now() + 1_000).toISOString();
  const driftedAssignment = {
    id: driftedAssignmentId,
    parentTaskId: "task-cli-in-projection-active-lease",
    workflow: "milestone-2",
    ownerType: "host" as const,
    ownerId: "codex",
    objective: "Drifted assignment selected by runtime status.",
    writeScope: ["README.md"],
    requiredOutputs: ["result"],
    state: "in_progress" as const,
    createdAt: driftTimestamp,
    updatedAt: driftTimestamp
  };
  const eventsPath = join(runtimeDir, "runtime", "events.ndjson");
  const originalEvents = (await readFile(eventsPath, "utf8")).trimEnd().split("\n");
  originalEvents.push(
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: snapshot.sessionId,
      timestamp: driftTimestamp,
      type: "assignment.created",
      payload: {
        assignment: driftedAssignment
      }
    }),
    JSON.stringify({
      eventId: randomUUID(),
      sessionId: snapshot.sessionId,
      timestamp: driftTimestamp,
      type: "status.updated",
      payload: {
        status: {
          ...snapshot.status,
          activeAssignmentIds: [driftedAssignmentId],
          currentObjective: "Run the drifted assignment.",
          lastDurableOutputAt: driftTimestamp
        }
      }
    })
  );
  await writeFile(eventsPath, `${originalEvents.join("\n")}\n`, "utf8");
  await writeFile(
    join(runtimeDir, "runtime", "snapshot.json"),
    JSON.stringify(
      {
        ...snapshot,
        assignments: [...snapshot.assignments, driftedAssignment],
        status: {
          ...snapshot.status,
          activeAssignmentIds: [driftedAssignmentId],
          currentObjective: "Run the drifted assignment.",
          lastDurableOutputAt: driftTimestamp
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const activeLease = {
    assignmentId: authoritativeAssignmentId,
    state: "running",
    workflowAttempt,
    adapterData: {
      nativeRunId: "thread-cli-in-projection-active-lease"
    },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await mkdir(join(runtimeDir, "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${authoritativeAssignmentId}.json`),
    JSON.stringify(activeLease, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${authoritativeAssignmentId}.lease.json`),
    JSON.stringify(activeLease, null, 2),
    "utf8"
  );

  const initialEnvelope = await readFile(
    join(runtimeDir, "runtime", "last-resume-envelope.json"),
    "utf8"
  );
  const status = await runCliCommand(cliPath, "status", {
    cwd: projectRoot
  });
  const resume = await runCliCommand(cliPath, "resume", {
    cwd: projectRoot
  });
  const finalEnvelope = await readFile(
    join(runtimeDir, "runtime", "last-resume-envelope.json"),
    "utf8"
  );

  assert.equal(status.exitCode, 0);
  assert.match(status.stderr, /WARNING active-run-present .*active host run lease/);
  assert.match(status.stdout, /Active assignments: 1/);
  assert.match(status.stdout, /Authoritative host leases: 1/);
  assert.match(
    status.stdout,
    new RegExp(`- ${authoritativeAssignmentId} active host run lease on the current active assignment`)
  );
  assert.equal(resume.exitCode, 1);
  assert.doesNotMatch(resume.stdout, /Recovery brief generated/);
  assert.match(
    resume.stderr,
    new RegExp(`Assignment ${authoritativeAssignmentId} already has an active host run lease\\.`)
  );
  assert.equal(finalEnvelope, initialEnvelope);
});

test("ctx status reports interrupted-transition active leases against the converged current assignment", async () => {
  for (const scenario of ["advance", "rewind"] as const) {
    const projectRoot = await mkdtemp(
      join(tmpdir(), `coortex-cli-interrupted-transition-active-lease-${scenario}-`)
    );
    const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
    const store = RuntimeStore.forProject(projectRoot);

    await execFileAsync(process.execPath, [cliPath, "init"], {
      cwd: projectRoot
    });

    const runtimeDir = join(projectRoot, ".coortex");
    const initialSnapshot = JSON.parse(
      await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
    ) as {
      assignments: Array<{ id: string }>;
      workflowProgress: {
        currentAssignmentId: string | null;
      };
    };

    let expectedAssignmentId: string | undefined;
    let expectedWorkflowAttempt: NonNullable<HostRunRecord["workflowAttempt"]> | undefined;

    if (scenario === "advance") {
      const planAssignmentId = initialSnapshot.assignments[0]!.id;
      const interrupted = await appendWorkflowModuleProgression(store, {
        artifact: {
          workflowId: "default",
          workflowCycle: 1,
          moduleId: "plan",
          moduleAttempt: 1,
          assignmentId: planAssignmentId,
          createdAt: "2026-04-19T09:01:00.000Z",
          payload: {
            planSummary: "Plan ready for review.",
            implementationSteps: ["Reuse the pre-created review assignment."],
            reviewEvidenceSummary: "Interrupted advance should converge onto the review assignment with the active lease."
          }
        },
        resultId: "cli-status-interrupted-advance-plan",
        summary: "Plan completed before transition persistence finished.",
        createdAt: "2026-04-19T09:01:00.000Z",
        progressionAt: "2026-04-19T09:01:01.000Z",
        omitEventTypes: ["workflow.transition.applied"]
      });
      expectedAssignmentId = interrupted.createdAssignmentId;
      expectedWorkflowAttempt = {
        workflowId: "default",
        workflowCycle: 1,
        moduleId: "review",
        moduleAttempt: 1
      };
    } else {
      const planAssignmentId = initialSnapshot.assignments[0]!.id;
      await appendWorkflowModuleProgression(store, {
        artifact: {
          workflowId: "default",
          workflowCycle: 1,
          moduleId: "plan",
          moduleAttempt: 1,
          assignmentId: planAssignmentId,
          createdAt: "2026-04-19T10:01:00.000Z",
          payload: {
            planSummary: "Plan complete.",
            implementationSteps: ["Advance to review."],
            reviewEvidenceSummary: "Ready for review."
          }
        },
        resultId: "cli-status-interrupted-rewind-plan",
        summary: "Plan completed.",
        createdAt: "2026-04-19T10:01:00.000Z",
        progressionAt: "2026-04-19T10:01:01.000Z"
      });
      const afterPlanSnapshot = await store.loadSnapshot();
      const reviewAssignmentId = afterPlanSnapshot?.workflowProgress?.currentAssignmentId;
      assert.ok(reviewAssignmentId, "expected review assignment after plan advancement");
      await appendWorkflowModuleProgression(store, {
        artifact: {
          workflowId: "default",
          workflowCycle: 1,
          moduleId: "review",
          moduleAttempt: 1,
          assignmentId: reviewAssignmentId,
          createdAt: "2026-04-19T10:03:00.000Z",
          payload: {
            verdict: "approved",
            rationaleSummary: "Review approved."
          }
        },
        resultId: "cli-status-interrupted-rewind-review",
        summary: "Review completed.",
        createdAt: "2026-04-19T10:03:00.000Z",
        progressionAt: "2026-04-19T10:03:01.000Z"
      });
      const afterReviewSnapshot = await store.loadSnapshot();
      const verifyAssignmentId = afterReviewSnapshot?.workflowProgress?.currentAssignmentId;
      assert.ok(verifyAssignmentId, "expected verify assignment after review advancement");
      const interrupted = await appendWorkflowModuleProgression(store, {
        artifact: {
          workflowId: "default",
          workflowCycle: 1,
          moduleId: "verify",
          moduleAttempt: 1,
          assignmentId: verifyAssignmentId,
          createdAt: "2026-04-19T10:05:00.000Z",
          payload: {
            verdict: "failed",
            verificationSummary: "Verification failed and should rewind to review.",
            evidenceResultIds: ["cli-status-interrupted-rewind-review"]
          }
        },
        resultId: "cli-status-interrupted-rewind-verify",
        summary: "Verification failed before transition persistence finished.",
        createdAt: "2026-04-19T10:05:00.000Z",
        progressionAt: "2026-04-19T10:05:01.000Z",
        omitEventTypes: ["workflow.transition.applied"]
      });
      expectedAssignmentId = interrupted.createdAssignmentId;
      expectedWorkflowAttempt = {
        workflowId: "default",
        workflowCycle: 2,
        moduleId: "review",
        moduleAttempt: 1
      };
    }

    assert.ok(expectedAssignmentId, "expected interrupted transition to pre-create the next assignment");
    assert.ok(expectedWorkflowAttempt, "expected workflow attempt identity for the active lease");
    const activeLease: HostRunRecord = {
      assignmentId: expectedAssignmentId,
      state: "running",
      workflowAttempt: expectedWorkflowAttempt,
      adapterData: {
        nativeRunId: `thread-cli-interrupted-${scenario}-active-lease`
      },
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    await mkdir(join(runtimeDir, "adapters", "codex", "runs"), { recursive: true });
    await writeFile(
      join(runtimeDir, "adapters", "codex", "runs", `${expectedAssignmentId}.json`),
      JSON.stringify(activeLease, null, 2),
      "utf8"
    );
    await writeFile(
      join(runtimeDir, "adapters", "codex", "runs", `${expectedAssignmentId}.lease.json`),
      JSON.stringify(activeLease, null, 2),
      "utf8"
    );

    const status = await runCliCommand(cliPath, "status", {
      cwd: projectRoot
    });

    assert.equal(status.exitCode, 0);
    assert.match(status.stderr, /WARNING active-run-present .*active host run lease/);
    assert.match(status.stdout, /Authoritative host leases: 1/);
    assert.match(
      status.stdout,
      new RegExp(`- ${expectedAssignmentId} active host run lease on the current active assignment`)
    );
    assert.doesNotMatch(
      status.stdout,
      new RegExp(`- ${expectedAssignmentId} active host run lease outside the current projection`)
    );
  }
});

test("ctx status recovers a completed host run and requeues the workflow module", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-completed-status-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const runtimeDir = join(projectRoot, ".coortex");
  const snapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    results: Array<{ status: string; summary: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
    workflowProgress: {
      workflowId: string;
      workflowCycle: number;
      currentModuleId: string;
      currentModuleAttempt: number;
    };
  };
  const assignmentId = snapshot.assignments[0]!.id;
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  const completedAt = new Date(Date.now() - 110_000).toISOString();
  const workflowAttempt = workflowAttemptFromSnapshot(snapshot);
  const completedRecord = {
    assignmentId,
    state: "completed",
    workflowAttempt,
    adapterData: {
      nativeRunId: "thread-cli-completed-status"
    },
    startedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Recovered completed host run for ctx status.",
    terminalOutcome: {
      kind: "result",
      result: {
        resultId: "result-cli-completed-status",
        assignmentId,
        producerId: "codex",
        status: "completed",
        summary: "Recovered completed host run for ctx status.",
        changedFiles: ["src/cli/ctx.ts"],
        createdAt: completedAt
      }
    }
  };
  const leftoverLease = {
    assignmentId,
    state: "running",
    workflowAttempt,
    adapterData: {
      nativeRunId: "thread-cli-leftover-lease"
    },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await mkdir(join(runtimeDir, "adapters", "codex", "runs"), { recursive: true });
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.json`),
    JSON.stringify(completedRecord, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "last-run.json"),
    JSON.stringify(completedRecord, null, 2),
    "utf8"
  );
  await writeFile(
    join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`),
    JSON.stringify(leftoverLease, null, 2),
    "utf8"
  );

  const status = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  const repairedSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    results: Array<{ resultId: string; assignmentId: string; status: string; summary: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
    workflowProgress: { currentModuleId: string; currentModuleAttempt: number };
  };

  assert.match(status.stderr, /WARNING completed-run-reconciled/);
  assert.doesNotMatch(status.stderr, /WARNING stale-run-reconciled/);
  assert.match(status.stdout, /Workflow: default/);
  assert.match(status.stdout, /Current module: plan/);
  assert.match(status.stdout, /Last gate: blocked/);
  assert.match(status.stdout, /Last advancement: Rerun plan attempt 2\./);
  assert.match(status.stdout, /Active assignments: 1/);
  assert.match(status.stdout, /Results: 1/);
  assert.match(status.stdout, /Open decisions: 0/);
  assert.match(status.stdout, new RegExp(`Objective: Start plan assignment ${assignmentId}:`));
  assert.match(status.stdout, new RegExp(`- ${assignmentId} queued `));
  assert.equal(repairedSnapshot.assignments[0]?.state, "queued");
  assert.deepEqual(repairedSnapshot.status.activeAssignmentIds, [assignmentId]);
  assert.match(repairedSnapshot.status.currentObjective, new RegExp(`Start plan assignment ${assignmentId}:`));
  assert.equal(repairedSnapshot.workflowProgress.currentModuleId, "plan");
  assert.equal(repairedSnapshot.workflowProgress.currentModuleAttempt, 2);
  assert.equal(repairedSnapshot.results.length, 1);
  assert.deepEqual(repairedSnapshot.results[0], {
    resultId: "result-cli-completed-status",
    assignmentId,
    producerId: "codex",
    status: "completed",
    summary: "Recovered completed host run for ctx status.",
    changedFiles: ["src/cli/ctx.ts"],
    createdAt: completedAt
  });
  await assert.rejects(
    readFile(join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`), "utf8"),
    /ENOENT/
  );

  const firstRecoveryEventCount = await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "result.submitted");

  const secondStatus = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  const secondSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    results: Array<{ resultId: string; assignmentId: string; status: string; summary: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
    workflowProgress: { currentModuleId: string; currentModuleAttempt: number };
  };

  assert.doesNotMatch(secondStatus.stderr, /WARNING completed-run-reconciled/);
  assert.doesNotMatch(secondStatus.stderr, /WARNING stale-run-reconciled/);
  assert.match(secondStatus.stdout, /Active assignments: 1/);
  assert.match(secondStatus.stdout, /Results: 1/);
  assert.match(secondStatus.stdout, /Open decisions: 0/);
  assert.match(secondStatus.stdout, new RegExp(`Objective: Start plan assignment ${assignmentId}:`));
  assert.equal(secondSnapshot.assignments[0]?.state, "queued");
  assert.deepEqual(secondSnapshot.status.activeAssignmentIds, [assignmentId]);
  assert.match(secondSnapshot.status.currentObjective, new RegExp(`Start plan assignment ${assignmentId}:`));
  assert.equal(secondSnapshot.workflowProgress.currentModuleId, "plan");
  assert.equal(secondSnapshot.workflowProgress.currentModuleAttempt, 2);
  assert.equal(secondSnapshot.results.length, 1);
  assert.deepEqual(secondSnapshot.results[0], {
    resultId: "result-cli-completed-status",
    assignmentId,
    producerId: "codex",
    status: "completed",
    summary: "Recovered completed host run for ctx status.",
    changedFiles: ["src/cli/ctx.ts"],
    createdAt: completedAt
  });
  const secondRecoveryEventCount = await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "result.submitted");
  assert.equal(firstRecoveryEventCount, 1);
  assert.equal(secondRecoveryEventCount, firstRecoveryEventCount);
  await assert.rejects(
    readFile(join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`), "utf8"),
    /ENOENT/
  );
});

test("ctx status and resume keep workflow-derived status after completed-result recovery", async () => {
  const { projectRoot, cliPath, runtimeDir, assignmentId, completedAt } =
    await createCompletedResultRecoverySetup();

  const firstStatus = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  assert.match(firstStatus.stderr, /WARNING completed-run-reconciled/);
  assert.match(firstStatus.stdout, new RegExp(`Objective: Start plan assignment ${assignmentId}:`));

  await appendCompletedResultStatusDrift(
    runtimeDir,
    "Operator adjusted the status after completed recovery."
  );

  const secondStatus = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  const secondSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    results: Array<{ resultId: string; assignmentId: string; status: string; summary: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
    workflowProgress: { currentModuleId: string; currentModuleAttempt: number };
  };

  assert.doesNotMatch(secondStatus.stderr, /WARNING completed-run-reconciled/);
  assert.doesNotMatch(secondStatus.stderr, /WARNING stale-run-reconciled/);
  assert.match(secondStatus.stdout, new RegExp(`Objective: Start plan assignment ${assignmentId}:`));
  assert.equal(secondSnapshot.assignments[0]?.state, "queued");
  assert.deepEqual(secondSnapshot.status.activeAssignmentIds, [assignmentId]);
  assert.match(secondSnapshot.status.currentObjective, new RegExp(`Start plan assignment ${assignmentId}:`));
  assert.equal(secondSnapshot.workflowProgress.currentModuleId, "plan");
  assert.equal(secondSnapshot.workflowProgress.currentModuleAttempt, 2);
  assert.equal(secondSnapshot.results.length, 1);
  assert.deepEqual(secondSnapshot.results[0], {
    resultId: "result-cli-completed-recovery",
    assignmentId,
    producerId: "codex",
    status: "completed",
    summary: "Recovered completed host run for command recovery.",
    changedFiles: ["src/cli/ctx.ts"],
    createdAt: completedAt
  });
  assert.equal(await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "result.submitted"), 1);

  const resumed = await runCliCommand(cliPath, "resume", {
    cwd: projectRoot
  });
  assert.equal(resumed.exitCode, 0);
  assert.match(resumed.stdout, /Recovery brief generated/);
  assert.doesNotMatch(resumed.stderr, /WARNING completed-run-reconciled/);
  assert.doesNotMatch(resumed.stderr, /WARNING stale-run-reconciled/);

  const finalSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    results: Array<{ resultId: string; assignmentId: string; status: string; summary: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
    workflowProgress: { currentModuleId: string; currentModuleAttempt: number };
  };

  assert.equal(finalSnapshot.assignments[0]?.state, "queued");
  assert.deepEqual(finalSnapshot.status.activeAssignmentIds, [assignmentId]);
  assert.match(finalSnapshot.status.currentObjective, new RegExp(`Start plan assignment ${assignmentId}:`));
  assert.equal(finalSnapshot.workflowProgress.currentModuleId, "plan");
  assert.equal(finalSnapshot.workflowProgress.currentModuleAttempt, 2);
  assert.equal(finalSnapshot.results.length, 1);
  assert.deepEqual(finalSnapshot.results[0], {
    resultId: "result-cli-completed-recovery",
    assignmentId,
    producerId: "codex",
    status: "completed",
    summary: "Recovered completed host run for command recovery.",
    changedFiles: ["src/cli/ctx.ts"],
    createdAt: completedAt
  });
  assert.equal(await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "result.submitted"), 1);
});

test("ctx status and resume repair a completed result despite older matching status history", async () => {
  const { projectRoot, cliPath, runtimeDir, assignmentId, completedAt } =
    await createCompletedResultRecoverySetup();

  await appendHistoricalRecoveredCompletedResultStatusEvent(runtimeDir);
  await corruptSnapshotBoundary(runtimeDir);

  const status = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  const repairedSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    results: Array<{ resultId: string; assignmentId: string; status: string; summary: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
    workflowProgress: { currentModuleId: string; currentModuleAttempt: number };
  };

  assert.match(status.stderr, /WARNING completed-run-reconciled/);
  assert.match(status.stderr, /WARNING event-log-salvaged .*Fell back to .*snapshot\.json/);
  assert.match(status.stdout, /Active assignments: 1/);
  assert.match(status.stdout, /Results: 1/);
  assert.match(status.stdout, /Open decisions: 0/);
  assert.match(status.stdout, new RegExp(`Objective: Start plan assignment ${assignmentId}:`));
  assert.equal(repairedSnapshot.assignments[0]?.state, "queued");
  assert.deepEqual(repairedSnapshot.status.activeAssignmentIds, [assignmentId]);
  assert.match(repairedSnapshot.status.currentObjective, new RegExp(`Start plan assignment ${assignmentId}:`));
  assert.equal(repairedSnapshot.workflowProgress.currentModuleId, "plan");
  assert.equal(repairedSnapshot.workflowProgress.currentModuleAttempt, 2);
  assert.equal(repairedSnapshot.results.length, 1);
  assert.deepEqual(repairedSnapshot.results[0], {
    resultId: "result-cli-completed-recovery",
    assignmentId,
    producerId: "codex",
    status: "completed",
    summary: "Recovered completed host run for command recovery.",
    changedFiles: ["src/cli/ctx.ts"],
    createdAt: completedAt
  });
  assert.equal(await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "result.submitted"), 1);

  const resume = await runCliCommand(cliPath, "resume", {
    cwd: projectRoot
  });
  assert.equal(resume.exitCode, 0);
  assert.match(resume.stdout, /Recovery brief generated/);
  assert.doesNotMatch(resume.stderr, /WARNING completed-run-reconciled/);
  assert.doesNotMatch(resume.stderr, /WARNING stale-run-reconciled/);
});

test("ctx status repairs snapshot-fallback completed results into a workflow rerun", async () => {
  const { projectRoot, cliPath, runtimeDir, assignmentId, completedAt } =
    await createCompletedResultRecoverySetup();

  await appendHistoricalRecoveredCompletedResultSequence(runtimeDir, assignmentId, completedAt);
  await corruptSnapshotBoundary(runtimeDir);

  const status = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  const repairedSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    results: Array<{ resultId: string; assignmentId: string; status: string; summary: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
    workflowProgress: { currentModuleId: string; currentModuleAttempt: number };
  };

  assert.match(status.stderr, /WARNING completed-run-reconciled/);
  assert.match(status.stderr, /WARNING event-log-salvaged .*Fell back to .*snapshot\.json/);
  assert.match(status.stdout, /Active assignments: 1/);
  assert.match(status.stdout, /Results: 1/);
  assert.match(status.stdout, new RegExp(`Objective: Start plan assignment ${assignmentId}:`));
  assert.equal(repairedSnapshot.assignments[0]?.state, "queued");
  assert.deepEqual(repairedSnapshot.status.activeAssignmentIds, [assignmentId]);
  assert.match(repairedSnapshot.status.currentObjective, new RegExp(`Start plan assignment ${assignmentId}:`));
  assert.equal(repairedSnapshot.workflowProgress.currentModuleId, "plan");
  assert.equal(repairedSnapshot.workflowProgress.currentModuleAttempt, 2);
  assert.equal(repairedSnapshot.results.length, 1);
  assert.deepEqual(repairedSnapshot.results[0], {
    resultId: "result-cli-completed-recovery",
    assignmentId,
    producerId: "codex",
    status: "completed",
    summary: "Recovered completed host run for command recovery.",
    changedFiles: ["src/cli/ctx.ts"],
    createdAt: completedAt
  });
  await assert.rejects(
    readFile(join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`), "utf8"),
    /ENOENT/
  );
});

test("ctx resume recovers a completed host run before generating a rerun brief", async () => {
  const { projectRoot, cliPath, runtimeDir, assignmentId, completedAt } =
    await createCompletedResultRecoverySetup();

  const firstResume = await runCliCommand(cliPath, "resume", {
    cwd: projectRoot
  });
  assert.equal(firstResume.exitCode, 0);
  assert.match(firstResume.stdout, /Recovery brief generated/);
  assert.match(firstResume.stderr, /WARNING completed-run-reconciled/);

  const firstRecoveryEventCount = await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "result.submitted");
  const firstQueuedTransitionCount = await countQueuedAssignmentUpdatedEvents(runtimeDir, assignmentId);
  const secondResume = await runCliCommand(cliPath, "resume", {
    cwd: projectRoot
  });
  assert.equal(secondResume.exitCode, 0);
  assert.match(secondResume.stdout, /Recovery brief generated/);
  assert.doesNotMatch(secondResume.stderr, /WARNING completed-run-reconciled/);
  assert.doesNotMatch(secondResume.stderr, /WARNING stale-run-reconciled/);

  const secondRecoveryEventCount = await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "result.submitted");
  const secondQueuedTransitionCount = await countQueuedAssignmentUpdatedEvents(runtimeDir, assignmentId);
  assert.equal(firstRecoveryEventCount, 1);
  assert.equal(secondRecoveryEventCount, firstRecoveryEventCount);
  assert.equal(firstQueuedTransitionCount, 0);
  assert.equal(secondQueuedTransitionCount, firstQueuedTransitionCount);

  const repairedSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    results: Array<{ resultId: string; assignmentId: string; status: string; summary: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
    workflowProgress: { currentModuleId: string; currentModuleAttempt: number };
  };

  assert.equal(repairedSnapshot.assignments[0]?.state, "queued");
  assert.deepEqual(repairedSnapshot.status.activeAssignmentIds, [assignmentId]);
  assert.match(repairedSnapshot.status.currentObjective, new RegExp(`Start plan assignment ${assignmentId}:`));
  assert.equal(repairedSnapshot.workflowProgress.currentModuleId, "plan");
  assert.equal(repairedSnapshot.workflowProgress.currentModuleAttempt, 2);
  assert.equal(repairedSnapshot.results.length, 1);
  assert.deepEqual(repairedSnapshot.results[0], {
    resultId: "result-cli-completed-recovery",
    assignmentId,
    producerId: "codex",
    status: "completed",
    summary: "Recovered completed host run for command recovery.",
    changedFiles: ["src/cli/ctx.ts"],
    createdAt: completedAt
  });
  await assert.rejects(
    readFile(join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`), "utf8"),
    /ENOENT/
  );
});

test("ctx run surfaces a recovered completed host run before the next workflow rerun", async () => {
  const { projectRoot, cliPath, runtimeDir, assignmentId, completedAt } =
    await createCompletedResultRecoverySetup();

  const firstRun = await runCliCommand(cliPath, "run", {
    cwd: projectRoot
  });
  assert.equal(firstRun.exitCode, 0);
  assert.doesNotMatch(firstRun.stdout, /Executed assignment/);
  assert.match(firstRun.stdout, /Result \(completed\): Recovered completed host run for command recovery\./);
  assert.match(firstRun.stderr, /WARNING completed-run-reconciled/);
  assert.doesNotMatch(firstRun.stderr, /WARNING stale-run-reconciled/);

  const firstRecoveryEventCount = await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "result.submitted");
  const firstQueuedTransitionCount = await countQueuedAssignmentUpdatedEvents(runtimeDir, assignmentId);

  const status = await runCliCommand(cliPath, "status", {
    cwd: projectRoot
  });
  assert.equal(status.exitCode, 0);
  assert.match(status.stdout, new RegExp(`Objective: Start plan assignment ${assignmentId}:`));
  assert.doesNotMatch(status.stderr, /WARNING completed-run-reconciled/);
  assert.doesNotMatch(status.stderr, /WARNING stale-run-reconciled/);

  const secondRecoveryEventCount = await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "result.submitted");
  const secondQueuedTransitionCount = await countQueuedAssignmentUpdatedEvents(runtimeDir, assignmentId);
  assert.equal(firstRecoveryEventCount, 1);
  assert.equal(secondRecoveryEventCount, firstRecoveryEventCount);
  assert.equal(firstQueuedTransitionCount, 0);
  assert.equal(secondQueuedTransitionCount, firstQueuedTransitionCount);

  const repairedSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    results: Array<{ resultId: string; assignmentId: string; status: string; summary: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
    workflowProgress: { currentModuleId: string; currentModuleAttempt: number };
  };

  assert.equal(repairedSnapshot.assignments[0]?.state, "queued");
  assert.deepEqual(repairedSnapshot.status.activeAssignmentIds, [assignmentId]);
  assert.match(repairedSnapshot.status.currentObjective, new RegExp(`Start plan assignment ${assignmentId}:`));
  assert.equal(repairedSnapshot.workflowProgress.currentModuleId, "plan");
  assert.equal(repairedSnapshot.workflowProgress.currentModuleAttempt, 2);
  assert.equal(repairedSnapshot.results.length, 1);
  assert.deepEqual(repairedSnapshot.results[0], {
    resultId: "result-cli-completed-recovery",
    assignmentId,
    producerId: "codex",
    status: "completed",
    summary: "Recovered completed host run for command recovery.",
    changedFiles: ["src/cli/ctx.ts"],
    createdAt: completedAt
  });
  await assert.rejects(
    readFile(join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`), "utf8"),
    /ENOENT/
  );
});

test("ctx run surfaces a recovered failed host run with a non-zero exit", async () => {
  const { projectRoot, cliPath, runtimeDir, assignmentId, completedAt } =
    await createCompletedResultRecoverySetup({
      resultStatus: "failed",
      summary: "Recovered failed host run for command recovery."
    });

  const run = await runCliCommand(cliPath, "run", {
    cwd: projectRoot
  });
  const repairedSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    results: Array<{ resultId: string; assignmentId: string; status: string; summary: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
    workflowProgress: { currentModuleId: string; currentModuleAttempt: number };
  };

  assert.equal(run.exitCode, 1);
  assert.doesNotMatch(run.stdout, /Executed assignment/);
  assert.match(run.stdout, /Result \(failed\): Recovered failed host run for command recovery\./);
  assert.match(run.stderr, /WARNING completed-run-reconciled/);
  assert.equal(await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "result.submitted"), 1);
  assert.equal(repairedSnapshot.assignments[0]?.state, "queued");
  assert.deepEqual(repairedSnapshot.status.activeAssignmentIds, [assignmentId]);
  assert.match(repairedSnapshot.status.currentObjective, new RegExp(`Start plan assignment ${assignmentId}:`));
  assert.equal(repairedSnapshot.workflowProgress.currentModuleId, "plan");
  assert.equal(repairedSnapshot.workflowProgress.currentModuleAttempt, 2);
  assert.deepEqual(repairedSnapshot.results[0], {
    resultId: "result-cli-failed-recovery",
    assignmentId,
    producerId: "codex",
    status: "failed",
    summary: "Recovered failed host run for command recovery.",
    changedFiles: ["src/cli/ctx.ts"],
    createdAt: completedAt
  });
});

test("ctx status and resume preserve workflow reruns behind a malformed leftover lease", async () => {
  const cases = [
    {
      command: "status",
      expectedExitCode: 0,
      expectedError: undefined
    },
    {
      command: "resume",
      expectedExitCode: 0,
      expectedError: undefined
    }
  ] as const;

  for (const testCase of cases) {
    const { projectRoot, cliPath, runtimeDir, assignmentId, completedAt } =
      await createRuntimeCompletedResultMalformedLeaseSetup();

    const commandResult = await runCliCommand(cliPath, testCase.command, {
      cwd: projectRoot
    });
    const repairedSnapshot = JSON.parse(
      await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
    ) as {
      assignments: Array<{ id: string; state: string }>;
      results: Array<{ resultId: string; assignmentId: string; status: string; summary: string }>;
      status: { activeAssignmentIds: string[]; currentObjective: string };
      workflowProgress: { currentModuleId: string; currentModuleAttempt: number };
    };

    assert.equal(commandResult.exitCode, testCase.expectedExitCode);
    assert.equal(commandResult.stderr, "");
    assert.doesNotMatch(commandResult.stderr, /Host run reconciliation failed to clear the active lease/);
    if (testCase.expectedError) {
      assert.match(commandResult.stderr, testCase.expectedError);
    } else if (testCase.command === "status") {
      assert.match(commandResult.stdout, new RegExp(`Objective: Start plan assignment ${assignmentId}:`));
      assert.match(commandResult.stdout, /Active assignments: 1/);
      assert.match(commandResult.stdout, /Results: 1/);
      assert.match(commandResult.stdout, /Open decisions: 0/);
    } else {
      assert.match(commandResult.stdout, /Recovery brief generated/);
    }
    assert.equal(repairedSnapshot.assignments[0]?.state, "queued");
    assert.deepEqual(repairedSnapshot.status.activeAssignmentIds, [assignmentId]);
    assert.match(repairedSnapshot.status.currentObjective, new RegExp(`Start plan assignment ${assignmentId}:`));
    assert.equal(repairedSnapshot.workflowProgress.currentModuleId, "plan");
    assert.equal(repairedSnapshot.workflowProgress.currentModuleAttempt, 2);
    assert.equal(repairedSnapshot.results.length, 1);
    assert.deepEqual(repairedSnapshot.results[0], {
      resultId: "result-cli-runtime-malformed-lease",
      assignmentId,
      producerId: "codex",
      status: "completed",
      summary: "Recovered completed runtime result despite malformed leftover lease.",
      changedFiles: ["src/cli/ctx.ts"],
      createdAt: completedAt
    });
    await assert.rejects(
      readFile(join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`), "utf8"),
      /ENOENT/
    );

    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("ctx status, resume, and run preserve completed runtime decisions behind a malformed leftover lease", async () => {
  const cases = [
    {
      command: "status",
      expectedExitCode: 0,
      expectedError: undefined
    },
    {
      command: "resume",
      expectedExitCode: 0,
      expectedError: undefined
    },
    {
      command: "run",
      expectedExitCode: 1,
      expectedError: /Workflow assignment .* is not runnable for module plan\. Resolve decision .*:/
    }
  ] as const;

  for (const testCase of cases) {
    const { projectRoot, cliPath, runtimeDir, assignmentId, completedAt } =
      await createRuntimeCompletedDecisionMalformedLeaseSetup();

    const commandResult = await runCliCommand(cliPath, testCase.command, {
      cwd: projectRoot
    });
    const repairedSnapshot = JSON.parse(
      await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
    ) as {
      assignments: Array<{ id: string; state: string }>;
      decisions: Array<{ decisionId: string; assignmentId: string; blockerSummary: string; state: string }>;
      status: { activeAssignmentIds: string[]; currentObjective: string };
    };

    assert.equal(commandResult.exitCode, testCase.expectedExitCode);
    assert.doesNotMatch(commandResult.stderr, /WARNING completed-run-reconciled/);
    assert.doesNotMatch(commandResult.stderr, /WARNING stale-run-reconciled/);
    assert.doesNotMatch(commandResult.stderr, /Host run reconciliation failed to clear the active lease/);
    if (testCase.expectedError) {
      assert.match(commandResult.stderr, testCase.expectedError);
    } else if (testCase.command === "status") {
      assert.match(commandResult.stdout, /Active assignments: 1/);
      assert.match(commandResult.stdout, /Open decisions: 1/);
    } else {
      assert.match(commandResult.stdout, /Recovery brief generated/);
      assert.match(commandResult.stdout, /Resolve decision decision-cli-runtime-malformed-lease:/);
    }
    assert.equal(repairedSnapshot.assignments[0]?.state, "blocked");
    assert.deepEqual(repairedSnapshot.status.activeAssignmentIds, [assignmentId]);
    assert.equal(
      repairedSnapshot.status.currentObjective,
      "Resolve decision decision-cli-runtime-malformed-lease: Recovered completed runtime decision despite malformed leftover lease."
    );
    assert.equal(repairedSnapshot.decisions.length, 1);
    assert.deepEqual(repairedSnapshot.decisions[0], {
      decisionId: "decision-cli-runtime-malformed-lease",
      assignmentId,
      requesterId: "codex",
      blockerSummary: "Recovered completed runtime decision despite malformed leftover lease.",
      options: [
        { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
        { id: "skip", label: "Skip", summary: "Skip the blocked work." }
      ],
      recommendedOption: "wait",
      state: "open",
      createdAt: completedAt
    });
    await assert.rejects(
      readFile(join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`), "utf8"),
      /ENOENT/
    );

    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("ctx status recovers a completed host decision before further action", async () => {
  const { projectRoot, cliPath, runtimeDir, assignmentId, completedAt } = await createCompletedDecisionRecoverySetup({
    includeLeftoverLease: true
  });

  const status = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  const repairedSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    decisions: Array<{ decisionId: string; assignmentId: string; blockerSummary: string; state: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
  };

  assert.match(status.stderr, /WARNING completed-run-reconciled/);
  assert.doesNotMatch(status.stderr, /WARNING stale-run-reconciled/);
  assert.match(status.stdout, /Active assignments: 1/);
  assert.match(status.stdout, /Results: 0/);
  assert.match(status.stdout, /Open decisions: 1/);
  assert.match(status.stdout, new RegExp(`- ${assignmentId} blocked `));
  assert.equal(repairedSnapshot.assignments[0]?.state, "blocked");
  assert.deepEqual(repairedSnapshot.status.activeAssignmentIds, [assignmentId]);
  assert.equal(repairedSnapshot.decisions.length, 1);
  assert.deepEqual(repairedSnapshot.decisions[0], {
    decisionId: "decision-cli-completed-status",
    assignmentId,
    requesterId: "codex",
    blockerSummary: "Need operator confirmation before proceeding.",
    options: [
      { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
      { id: "skip", label: "Skip", summary: "Skip the blocked work." }
    ],
    recommendedOption: "wait",
    state: "open",
    createdAt: completedAt
  });
  await assert.rejects(
    readFile(join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`), "utf8"),
    /ENOENT/
  );

  const firstRecoveryEventCount = await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "decision.created");

  const secondStatus = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  const secondSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    decisions: Array<{ decisionId: string; assignmentId: string; blockerSummary: string; state: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
  };

  assert.doesNotMatch(secondStatus.stderr, /WARNING completed-run-reconciled/);
  assert.doesNotMatch(secondStatus.stderr, /WARNING stale-run-reconciled/);
  assert.match(secondStatus.stdout, /Active assignments: 1/);
  assert.match(secondStatus.stdout, /Results: 0/);
  assert.match(secondStatus.stdout, /Open decisions: 1/);
  assert.match(secondStatus.stdout, new RegExp(`- ${assignmentId} blocked `));
  assert.equal(secondSnapshot.assignments[0]?.state, "blocked");
  assert.deepEqual(secondSnapshot.status.activeAssignmentIds, [assignmentId]);
  assert.equal(secondSnapshot.decisions.length, 1);
  assert.deepEqual(secondSnapshot.decisions[0], {
    decisionId: "decision-cli-completed-status",
    assignmentId,
    requesterId: "codex",
    blockerSummary: "Need operator confirmation before proceeding.",
    options: [
      { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
      { id: "skip", label: "Skip", summary: "Skip the blocked work." }
    ],
    recommendedOption: "wait",
    state: "open",
    createdAt: completedAt
  });
  const secondRecoveryEventCount = await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "decision.created");
  assert.equal(firstRecoveryEventCount, 1);
  assert.equal(secondRecoveryEventCount, firstRecoveryEventCount);
  await assert.rejects(
    readFile(join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`), "utf8"),
    /ENOENT/
  );
});

test("ctx status advances to a queued rerun after a recovered decision resolves", async () => {
  const { projectRoot, cliPath, runtimeDir, assignmentId, completedAt } = await createCompletedDecisionRecoverySetup({
    includeLeftoverLease: true
  });

  const firstStatus = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  assert.match(firstStatus.stderr, /WARNING completed-run-reconciled/);

  const firstSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    sessionId: string;
    assignments: Array<{ id: string; state: string; updatedAt: string }>;
    decisions: Array<{ decisionId: string; assignmentId: string; state: string }>;
    status: {
      activeMode: string;
      currentObjective: string;
      activeAssignmentIds: string[];
      activeHost: string;
      activeAdapter: string;
      lastDurableOutputAt: string;
      resumeReady: boolean;
    };
  };
  const decisionId = firstSnapshot.decisions[0]!.decisionId;
  const resolutionTimestamp = new Date().toISOString();
  const existingEvents = (await readFile(join(runtimeDir, "runtime", "events.ndjson"), "utf8"))
    .split("\n")
    .filter(Boolean);
  existingEvents.push(
    JSON.stringify({
      eventId: "decision-resolved-after-recovery",
      sessionId: firstSnapshot.sessionId,
      timestamp: resolutionTimestamp,
      type: "decision.resolved",
      payload: {
        decisionId,
        resolvedAt: resolutionTimestamp,
        resolutionSummary: "Operator chose to continue after recovery."
      }
    }),
    JSON.stringify({
      eventId: "assignment-progressed-after-recovery",
      sessionId: firstSnapshot.sessionId,
      timestamp: resolutionTimestamp,
      type: "assignment.updated",
      payload: {
        assignmentId,
        patch: {
          state: "in_progress",
          updatedAt: resolutionTimestamp
        }
      }
    }),
    JSON.stringify({
      eventId: "status-progressed-after-recovery",
      sessionId: firstSnapshot.sessionId,
      timestamp: resolutionTimestamp,
      type: "status.updated",
      payload: {
        status: {
          ...firstSnapshot.status,
          currentObjective: "Continue after the recovered decision was resolved.",
          lastDurableOutputAt: resolutionTimestamp
        }
      }
    })
  );
  await writeFile(join(runtimeDir, "runtime", "events.ndjson"), `${existingEvents.join("\n")}\n`, "utf8");
  await writeFile(
    join(runtimeDir, "runtime", "snapshot.json"),
    JSON.stringify(
      {
        ...firstSnapshot,
        assignments: firstSnapshot.assignments.map((assignment) =>
          assignment.id === assignmentId
            ? {
                ...assignment,
                state: "in_progress",
                updatedAt: resolutionTimestamp
              }
            : assignment
        ),
        decisions: firstSnapshot.decisions.map((decision) =>
          decision.decisionId === decisionId
            ? {
                ...decision,
                state: "resolved",
                resolvedAt: resolutionTimestamp,
                resolutionSummary: "Operator chose to continue after recovery."
              }
            : decision
        ),
        status: {
          ...firstSnapshot.status,
          currentObjective: "Continue after the recovered decision was resolved.",
          lastDurableOutputAt: resolutionTimestamp
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const secondStatus = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  const secondSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    decisions: Array<{ decisionId: string; assignmentId: string; state: string; resolvedAt?: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
    workflowProgress: { currentModuleId: string; currentModuleAttempt: number };
  };

  assert.doesNotMatch(secondStatus.stderr, /WARNING completed-run-reconciled/);
  assert.doesNotMatch(secondStatus.stderr, /WARNING stale-run-reconciled/);
  assert.match(secondStatus.stdout, /Active assignments: 1/);
  assert.match(secondStatus.stdout, /Open decisions: 0/);
  assert.match(secondStatus.stdout, new RegExp(`Objective: Start plan assignment ${assignmentId}:`));
  assert.equal(secondSnapshot.assignments[0]?.state, "queued");
  assert.equal(secondSnapshot.decisions.length, 1);
  assert.equal(secondSnapshot.decisions[0]?.decisionId, decisionId);
  assert.equal(secondSnapshot.decisions[0]?.state, "resolved");
  assert.equal(secondSnapshot.decisions[0]?.resolvedAt, resolutionTimestamp);
  assert.deepEqual(secondSnapshot.status.activeAssignmentIds, [assignmentId]);
  assert.match(secondSnapshot.status.currentObjective, new RegExp(`Start plan assignment ${assignmentId}:`));
  assert.equal(secondSnapshot.workflowProgress.currentModuleId, "plan");
  assert.equal(secondSnapshot.workflowProgress.currentModuleAttempt, 2);
  assert.equal(await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "decision.created"), 1);
  await assert.rejects(
    readFile(join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`), "utf8"),
    /ENOENT/
  );
});

test("ctx status falls back to the recovered blocked decision when later suffix replay is unusable", async () => {
  const { projectRoot, cliPath, runtimeDir, assignmentId, completedAt } = await createCompletedDecisionRecoverySetup();
  const initialSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    sessionId: string;
    status: {
      activeMode: string;
      currentObjective: string;
      activeAssignmentIds: string[];
      activeHost: string;
      activeAdapter: string;
      lastDurableOutputAt: string;
      resumeReady: boolean;
    };
  };
  const completedRecord = JSON.parse(
    await readFile(join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.json`), "utf8")
  ) as {
    terminalOutcome: {
      kind: "decision";
      decision: {
        decisionId: string;
        requesterId: string;
        blockerSummary: string;
        options: Array<{ id: string; label: string; summary: string }>;
        recommendedOption: string;
        state: "open";
        createdAt: string;
      };
    };
  };
  const resolutionTimestamp = new Date(Date.now() - 100_000).toISOString();
  const existingEvents = (await readFile(join(runtimeDir, "runtime", "events.ndjson"), "utf8"))
    .split("\n")
    .filter(Boolean);
  existingEvents.push(
    JSON.stringify({
      eventId: "snapshot-fallback-decision-created",
      sessionId: initialSnapshot.sessionId,
      timestamp: completedAt,
      type: "decision.created",
      payload: {
        decision: {
          ...completedRecord.terminalOutcome.decision,
          assignmentId
        }
      }
    }),
    JSON.stringify({
      eventId: "snapshot-fallback-assignment-blocked",
      sessionId: initialSnapshot.sessionId,
      timestamp: completedAt,
      type: "assignment.updated",
      payload: {
        assignmentId,
        patch: {
          state: "blocked",
          updatedAt: completedAt
        }
      }
    }),
    JSON.stringify({
      eventId: "snapshot-fallback-status-blocked",
      sessionId: initialSnapshot.sessionId,
      timestamp: completedAt,
      type: "status.updated",
      payload: {
        status: {
          ...initialSnapshot.status,
          currentObjective: "Resolve the recovered decision before continuing.",
          lastDurableOutputAt: completedAt
        }
      }
    }),
    JSON.stringify({
      eventId: "snapshot-fallback-decision-resolved",
      sessionId: initialSnapshot.sessionId,
      timestamp: resolutionTimestamp,
      type: "decision.resolved",
      payload: {
        decisionId: completedRecord.terminalOutcome.decision.decisionId,
        resolvedAt: resolutionTimestamp,
        resolutionSummary: "Operator chose to continue after snapshot fallback recovery."
      }
    }),
    JSON.stringify({
      eventId: "snapshot-fallback-assignment-in-progress",
      sessionId: initialSnapshot.sessionId,
      timestamp: resolutionTimestamp,
      type: "assignment.updated",
      payload: {
        assignmentId,
        patch: {
          state: "in_progress",
          updatedAt: resolutionTimestamp
        }
      }
    }),
    JSON.stringify({
      eventId: "snapshot-fallback-status-progressed",
      sessionId: initialSnapshot.sessionId,
      timestamp: resolutionTimestamp,
      type: "status.updated",
      payload: {
        status: {
          ...initialSnapshot.status,
          currentObjective: "Continue after snapshot fallback recovery.",
          lastDurableOutputAt: resolutionTimestamp
        }
      }
    }),
    JSON.stringify({
      eventId: "snapshot-fallback-invalid-suffix",
      sessionId: initialSnapshot.sessionId,
      timestamp: new Date(Date.now() - 90_000).toISOString(),
      type: "assignment.updated",
      payload: {
        assignmentId: "missing-snapshot-fallback-assignment",
        patch: {
          state: "queued",
          updatedAt: new Date(Date.now() - 90_000).toISOString()
        }
      }
    })
  );
  await writeFile(join(runtimeDir, "runtime", "events.ndjson"), `${existingEvents.join("\n")}\n`, "utf8");

  const status = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  const repairedSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    decisions: Array<{ decisionId: string; assignmentId: string; state: string; resolvedAt?: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
  };

  assert.match(status.stderr, /WARNING completed-run-reconciled/);
  assert.match(status.stdout, /Active assignments: 1/);
  assert.match(status.stdout, /Open decisions: 1/);
  assert.match(status.stdout, new RegExp(`- ${assignmentId} blocked `));
  assert.equal(repairedSnapshot.assignments[0]?.state, "blocked");
  assert.equal(repairedSnapshot.decisions.length, 1);
  assert.equal(repairedSnapshot.decisions[0]?.assignmentId, assignmentId);
  assert.equal(repairedSnapshot.decisions[0]?.decisionId, completedRecord.terminalOutcome.decision.decisionId);
  assert.equal(repairedSnapshot.decisions[0]?.state, "open");
  assert.equal(repairedSnapshot.decisions[0]?.resolvedAt, undefined);
  assert.deepEqual(repairedSnapshot.status.activeAssignmentIds, [assignmentId]);
  assert.equal(
    repairedSnapshot.status.currentObjective,
    "Resolve decision decision-cli-completed-status: Need operator confirmation before proceeding."
  );
  assert.equal(await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "decision.created"), 2);
});

test("ctx resume repairs snapshot-fallback completed decisions when the snapshot boundary is unusable", async () => {
  const { projectRoot, cliPath, runtimeDir, assignmentId, completedAt } =
    await createCompletedDecisionRecoverySetup({
      includeLeftoverLease: true
    });

  await appendHistoricalRecoveredCompletedDecisionSequence(runtimeDir, assignmentId, completedAt);
  await corruptSnapshotBoundary(runtimeDir);

  const resume = await execFileAsync(process.execPath, [cliPath, "resume"], {
    cwd: projectRoot
  });
  const repairedSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    decisions: Array<{ decisionId: string; assignmentId: string; state: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
  };

  assert.match(resume.stderr, /WARNING completed-run-reconciled/);
  assert.match(resume.stderr, /WARNING event-log-salvaged .*Fell back to .*snapshot\.json/);
  assert.match(resume.stdout, /Recovery brief generated/);
  assert.match(resume.stdout, /Resolve decision/);
  assert.equal(repairedSnapshot.assignments[0]?.id, assignmentId);
  assert.equal(repairedSnapshot.assignments[0]?.state, "blocked");
  assert.equal(repairedSnapshot.decisions.length, 1);
  assert.equal(repairedSnapshot.decisions[0]?.decisionId, "decision-cli-completed-status");
  assert.equal(repairedSnapshot.decisions[0]?.assignmentId, assignmentId);
  assert.equal(repairedSnapshot.decisions[0]?.state, "open");
  await assert.rejects(
    readFile(join(runtimeDir, "adapters", "codex", "runs", `${assignmentId}.lease.json`), "utf8"),
    /ENOENT/
  );
});

test("ctx resume recovers a completed host decision before generating a brief", async () => {
  const { projectRoot, cliPath, runtimeDir, assignmentId, completedAt } = await createCompletedDecisionRecoverySetup();

  const resume = await execFileAsync(process.execPath, [cliPath, "resume"], {
    cwd: projectRoot
  });
  const repairedSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    decisions: Array<{ decisionId: string; assignmentId: string; state: string }>;
  };

  assert.match(resume.stderr, /WARNING completed-run-reconciled/);
  assert.doesNotMatch(resume.stderr, /WARNING stale-run-reconciled/);
  assert.match(resume.stdout, /Recovery brief generated/);
  assert.match(resume.stdout, /Resolve decision/);
  assert.equal(repairedSnapshot.assignments[0]?.id, assignmentId);
  assert.equal(repairedSnapshot.assignments[0]?.state, "blocked");
  assert.equal(repairedSnapshot.decisions.length, 1);
  assert.deepEqual(repairedSnapshot.decisions[0], {
    decisionId: "decision-cli-completed-status",
    assignmentId,
    requesterId: "codex",
    blockerSummary: "Need operator confirmation before proceeding.",
    options: [
      { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
      { id: "skip", label: "Skip", summary: "Skip the blocked work." }
    ],
    recommendedOption: "wait",
    state: "open",
    createdAt: completedAt
  });

  const firstRecoveryEventCount = await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "decision.created");
  const firstQueuedTransitionCount = await countQueuedAssignmentUpdatedEvents(runtimeDir, assignmentId);

  const secondResume = await execFileAsync(process.execPath, [cliPath, "resume"], {
    cwd: projectRoot
  });
  const secondSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    decisions: Array<{ decisionId: string; assignmentId: string; state: string }>;
  };

  assert.doesNotMatch(secondResume.stderr, /WARNING completed-run-reconciled/);
  assert.doesNotMatch(secondResume.stderr, /WARNING stale-run-reconciled/);
  assert.match(secondResume.stdout, /Recovery brief generated/);
  assert.match(secondResume.stdout, /Resolve decision/);
  assert.equal(secondSnapshot.assignments[0]?.id, assignmentId);
  assert.equal(secondSnapshot.assignments[0]?.state, "blocked");
  assert.equal(secondSnapshot.decisions.length, 1);
  assert.deepEqual(secondSnapshot.decisions[0], {
    decisionId: "decision-cli-completed-status",
    assignmentId,
    requesterId: "codex",
    blockerSummary: "Need operator confirmation before proceeding.",
    options: [
      { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
      { id: "skip", label: "Skip", summary: "Skip the blocked work." }
    ],
    recommendedOption: "wait",
    state: "open",
    createdAt: completedAt
  });
  const secondRecoveryEventCount = await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "decision.created");
  const secondQueuedTransitionCount = await countQueuedAssignmentUpdatedEvents(runtimeDir, assignmentId);
  assert.equal(firstRecoveryEventCount, 1);
  assert.equal(secondRecoveryEventCount, firstRecoveryEventCount);
  assert.equal(firstQueuedTransitionCount, 0);
  assert.equal(secondQueuedTransitionCount, firstQueuedTransitionCount);
});

test("ctx run surfaces a recovered completed host decision before later rerun errors", async () => {
  const { projectRoot, cliPath, runtimeDir, assignmentId, completedAt } = await createCompletedDecisionRecoverySetup();

  const firstRun = await runCliCommand(cliPath, "run", {
    cwd: projectRoot
  });
  assert.equal(firstRun.exitCode, 0);
  assert.doesNotMatch(firstRun.stdout, /Executed assignment/);
  assert.match(firstRun.stdout, /Decision: Need operator confirmation before proceeding\./);
  assert.match(firstRun.stdout, /Recommended option: wait/);
  assert.match(firstRun.stderr, /WARNING completed-run-reconciled/);
  assert.doesNotMatch(firstRun.stderr, /WARNING stale-run-reconciled/);

  const firstRecoveryEventCount = await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "decision.created");
  const firstQueuedTransitionCount = await countQueuedAssignmentUpdatedEvents(runtimeDir, assignmentId);

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "run"], {
      cwd: projectRoot
    }),
    (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Workflow assignment .* is not runnable for module plan/);
      assert.match(error.message, /Resolve decision decision-cli-completed-status:/);
      assert.doesNotMatch(error.stderr ?? "", /WARNING completed-run-reconciled/);
      assert.doesNotMatch(error.stderr ?? "", /WARNING stale-run-reconciled/);
      return true;
    }
  );

  const secondRecoveryEventCount = await countRecoveredOutcomeEvents(runtimeDir, assignmentId, "decision.created");
  const secondQueuedTransitionCount = await countQueuedAssignmentUpdatedEvents(runtimeDir, assignmentId);
  assert.equal(firstRecoveryEventCount, 1);
  assert.equal(secondRecoveryEventCount, firstRecoveryEventCount);
  assert.equal(firstQueuedTransitionCount, 0);
  assert.equal(secondQueuedTransitionCount, firstQueuedTransitionCount);

  const repairedSnapshot = JSON.parse(
    await readFile(join(runtimeDir, "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    decisions: Array<{ decisionId: string; assignmentId: string; state: string }>;
    status: { activeAssignmentIds: string[] };
  };
  assert.equal(repairedSnapshot.assignments[0]?.state, "blocked");
  assert.deepEqual(repairedSnapshot.status.activeAssignmentIds, [assignmentId]);
  assert.equal(repairedSnapshot.decisions.length, 1);
  assert.deepEqual(repairedSnapshot.decisions[0], {
    decisionId: "decision-cli-completed-status",
    assignmentId,
    requesterId: "codex",
    blockerSummary: "Need operator confirmation before proceeding.",
    options: [
      { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
      { id: "skip", label: "Skip", summary: "Skip the blocked work." }
    ],
    recommendedOption: "wait",
    state: "open",
    createdAt: completedAt
  });
});

test("ctx status, resume, and doctor salvage malformed logs without rewriting them", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-malformed-events-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const eventsPath = join(projectRoot, ".coortex", "runtime", "events.ndjson");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const originalEvents = await readFile(eventsPath, "utf8");
  const corruptedEvents = `${originalEvents.split("\n").filter(Boolean)[0]}\n{"broken":\n${originalEvents
    .split("\n")
    .filter(Boolean)
    .slice(1)
    .join("\n")}\n`;
  await writeFile(eventsPath, corruptedEvents, "utf8");

  const status = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  assert.match(status.stdout, /Active assignments: 1/);
  assert.match(status.stderr, /WARNING event-log-salvaged .*skipped malformed line/);
  assert.equal(await readFile(eventsPath, "utf8"), corruptedEvents);

  const resume = await execFileAsync(process.execPath, [cliPath, "resume"], {
    cwd: projectRoot
  });
  assert.match(resume.stdout, /Recovery brief generated/);
  assert.match(resume.stderr, /WARNING event-log-salvaged .*skipped malformed line/);
  assert.equal(await readFile(eventsPath, "utf8"), corruptedEvents);

  const doctor = await execFileAsync(process.execPath, [cliPath, "doctor"], {
    cwd: projectRoot
  });
  assert.match(doctor.stdout, /OK snapshot/);
  assert.match(doctor.stderr, /WARNING event-log-salvaged .*skipped malformed line/);
  assert.equal(await readFile(eventsPath, "utf8"), corruptedEvents);
});

test("ctx run surfaces telemetry write failures as structured diagnostics", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-telemetry-diagnostic-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const fixturePath = join(projectRoot, "codex-exec-fixture.json");

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        exitCode: 0,
        stdoutLines: [{ type: "thread.started", thread_id: "thread-cli-telemetry" }],
        lastMessage: {
          outcomeType: "result",
          resultStatus: "completed",
          resultSummary: "Telemetry diagnostic path completed.",
          changedFiles: ["README.md"],
          blockerSummary: "",
          decisionOptions: [],
          recommendedOption: ""
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const env = {
    ...process.env,
    COORTEX_CODEX_EXEC_FIXTURE: fixturePath
  };

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot,
    env
  });
  await rm(join(projectRoot, ".coortex", "runtime", "telemetry.ndjson"));
  await mkdir(join(projectRoot, ".coortex", "runtime", "telemetry.ndjson"), { recursive: true });

  const run = await execFileAsync(process.execPath, [cliPath, "run"], {
    cwd: projectRoot,
    env
  });

  assert.match(run.stdout, /Executed assignment/);
  assert.match(run.stderr, /WARNING telemetry-write-failed Telemetry append failed for host.run.started/);
  assert.match(run.stderr, /WARNING telemetry-write-failed Telemetry append failed for host.run.completed/);
});

test("ctx run exits non-zero when it persists a failed result", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-failed-run-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const fixturePath = join(projectRoot, "codex-exec-fixture.json");

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        exitCode: 2,
        stdoutLines: [{ type: "thread.started", thread_id: "thread-cli-failed" }],
        lastMessage: {
          outcomeType: "result",
          resultStatus: "failed",
          resultSummary: "Codex execution failed before finishing the assignment.",
          changedFiles: [],
          blockerSummary: "",
          decisionOptions: [],
          recommendedOption: ""
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const env = {
    ...process.env,
    COORTEX_CODEX_EXEC_FIXTURE: fixturePath
  };

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot,
    env
  });
  const snapshotBeforeRun = JSON.parse(
    await readFile(join(projectRoot, ".coortex", "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string }>;
  };
  const assignmentId = snapshotBeforeRun.assignments[0]!.id;

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "run"], {
      cwd: projectRoot,
      env
    }),
    (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout ?? "", /Result \(failed\): Codex run failed with exit code 2\./);
      return true;
    }
  );

  const snapshot = JSON.parse(
    await readFile(join(projectRoot, ".coortex", "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    results: Array<{ resultId: string; assignmentId: string; status: string }>;
    status: { activeAssignmentIds: string[]; currentObjective: string };
    workflowProgress: { currentModuleId: string; currentModuleAttempt: number };
  };
  const runRecord = JSON.parse(
    await readFile(
      join(projectRoot, ".coortex", "adapters", "codex", "runs", `${assignmentId}.json`),
      "utf8"
    )
  ) as {
    assignmentId: string;
    resultStatus: string;
    terminalOutcome?: { kind: string; result?: { status: string } };
  };

  assert.equal(snapshot.results.length, 1);
  assert.equal(snapshot.results[0]?.assignmentId, assignmentId);
  assert.equal(snapshot.results[0]?.status, "failed");
  assert.deepEqual(snapshot.status.activeAssignmentIds, [assignmentId]);
  assert.equal(snapshot.assignments[0]?.state, "queued");
  assert.match(snapshot.status.currentObjective, new RegExp(`Start plan assignment ${assignmentId}:`));
  assert.equal(snapshot.workflowProgress.currentModuleId, "plan");
  assert.equal(snapshot.workflowProgress.currentModuleAttempt, 2);
  assert.equal(runRecord.assignmentId, assignmentId);
  assert.equal(runRecord.resultStatus, "failed");
  assert.equal(runRecord.terminalOutcome?.kind, "result");
  assert.equal(runRecord.terminalOutcome?.result?.status, "failed");
});

test("ctx init reports codex config conflicts by path without echoing file contents", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-conflict-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const codexDir = join(projectRoot, ".codex");
  const configPath = join(codexDir, "config.toml");

  await mkdir(codexDir, { recursive: true });
  await writeFile(configPath, 'model_instructions_file = "user-value"\n', "utf8");

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "init"], {
      cwd: projectRoot
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(error.message, /user-value/);
      return true;
    }
  );
});

test("ctx init replaces an existing Coortex-managed block while preserving surrounding TOML", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-managed-replace-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const codexDir = join(projectRoot, ".codex");
  const configPath = join(codexDir, "config.toml");

  await mkdir(codexDir, { recursive: true });
  await writeFile(
    configPath,
    [
      'model = "gpt-5"',
      "",
      "# BEGIN COORTEX CODEX PROFILE",
      "# Coortex Codex reference adapter",
      'model_instructions_file = "/tmp/old-kernel.md"',
      "# END COORTEX CODEX PROFILE",
      "",
      "[tui]",
      'status = "enabled"'
    ].join("\n"),
    "utf8"
  );

  const init = await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });
  assert.match(init.stdout, /Initialized Coortex runtime/);

  const codexConfig = await readFile(configPath, "utf8");
  assert.match(codexConfig, /^model = "gpt-5"$/m);
  assert.match(codexConfig, /^\[tui\]$/m);
  assert.match(codexConfig, /^status = "enabled"$/m);
  assert.match(
    codexConfig,
    /model_instructions_file = ".*\.coortex\/adapters\/codex\/kernel\.md"/
  );
  assert.doesNotMatch(codexConfig, /old-kernel\.md/);
  assert.equal((codexConfig.match(/# BEGIN COORTEX CODEX PROFILE/g) ?? []).length, 1);
  assert.equal((codexConfig.match(/# END COORTEX CODEX PROFILE/g) ?? []).length, 1);
});

test("ctx run refuses to rerun a blocked assignment with an unresolved decision", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-decision-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const fixturePath = join(projectRoot, "codex-decision-fixture.json");

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        exitCode: 0,
        stdoutLines: [{ type: "thread.started", thread_id: "thread-decision-1" }],
        lastMessage: {
          outcomeType: "decision",
          resultStatus: "",
          resultSummary: "",
          changedFiles: [],
          blockerSummary: "Need operator guidance before proceeding.",
          decisionOptions: [
            { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
            { id: "skip", label: "Skip", summary: "Skip the blocked work." }
          ],
          recommendedOption: "wait"
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const env = {
    ...process.env,
    COORTEX_CODEX_EXEC_FIXTURE: fixturePath
  };

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot,
    env
  });
  const snapshotBeforeRun = JSON.parse(
    await readFile(join(projectRoot, ".coortex", "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string }>;
  };
  const assignmentId = snapshotBeforeRun.assignments[0]!.id;

  const firstRun = await runCliCommand(cliPath, "run", {
    cwd: projectRoot,
    env
  });
  assert.equal(firstRun.exitCode, 0);
  assert.match(firstRun.stdout, /Decision: Need operator guidance before proceeding\./);

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "run"], {
      cwd: projectRoot,
      env
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Workflow assignment .* is not runnable for module plan/);
      assert.match(error.message, /Resolve decision .*: Need operator guidance before proceeding\./);
      return true;
    }
  );

  const snapshot = JSON.parse(
    await readFile(join(projectRoot, ".coortex", "runtime", "snapshot.json"), "utf8")
  ) as {
    assignments: Array<{ id: string; state: string }>;
    decisions: Array<{ assignmentId: string; blockerSummary: string; state: string }>;
    status: { activeAssignmentIds: string[] };
  };
  assert.equal(snapshot.assignments[0]?.state, "blocked");
  assert.deepEqual(snapshot.status.activeAssignmentIds, [assignmentId]);
  assert.equal(snapshot.decisions.length, 1);
  assert.equal(snapshot.decisions[0]?.assignmentId, assignmentId);
  assert.equal(snapshot.decisions[0]?.state, "open");
});

test("ctx commands honor the current bypass env var after init", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-bypass-toggle-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot,
    env: liveCodexEnv
  });

  const doctorWithoutEnv = await execFileAsync(process.execPath, [cliPath, "doctor"], {
    cwd: projectRoot
  });
  assert.match(doctorWithoutEnv.stdout, /OK codex-danger-mode disabled/);

  const doctorWithEnv = await execFileAsync(process.execPath, [cliPath, "doctor"], {
    cwd: projectRoot,
    env: liveCodexEnv
  });
  assert.match(doctorWithEnv.stdout, /OK codex-danger-mode enabled/);
});

const liveCodexSmoke = process.env.COORTEX_LIVE_CODEX_SMOKE === "1" ? test : test.skip;
const liveCodexRestricted =
  process.env.COORTEX_LIVE_CODEX_RESTRICTED === "1" ? test : test.skip;

liveCodexSmoke("ctx run completes a live Codex smoke path", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-live-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const gitignorePath = join(projectRoot, ".gitignore");

  await writeFile(gitignorePath, ".coortex/\n.codex/\n", "utf8");
  await execFileAsync("git", ["init", "-b", "main"], {
    cwd: projectRoot
  });

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot,
    env: liveCodexEnv
  });

  const run = await execFileAsync(process.execPath, [cliPath, "run"], {
    cwd: projectRoot,
    env: liveCodexEnv
  });
  assert.match(run.stdout, /Executed assignment/);

  const inspect = await execFileAsync(process.execPath, [cliPath, "inspect"], {
    cwd: projectRoot,
    env: liveCodexEnv
  });
  assert.match(inspect.stdout, /"state": "completed"/);
});

liveCodexRestricted("ctx run reports truthful persisted state without bypass mode", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-live-restricted-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const gitignorePath = join(projectRoot, ".gitignore");

  await writeFile(gitignorePath, ".coortex/\n.codex/\n", "utf8");
  await execFileAsync("git", ["init", "-b", "main"], {
    cwd: projectRoot
  });

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const run = await execFileAsync(process.execPath, [cliPath, "run"], {
    cwd: projectRoot
  });
  assert.match(run.stdout, /Executed assignment/);

  const status = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  const inspect = await execFileAsync(process.execPath, [cliPath, "inspect"], {
    cwd: projectRoot
  });

  const snapshot = JSON.parse(
    await readFile(join(projectRoot, ".coortex", "runtime", "snapshot.json"), "utf8")
  ) as {
    results: Array<{ status: string }>;
    decisions: Array<{ state: string }>;
    status: { activeAssignmentIds: string[] };
  };

  if (/\"outcomeKind\": \"decision\"/.test(inspect.stdout)) {
    assert.match(run.stdout, /Decision:/);
    assert.equal(snapshot.decisions.length, 1);
    assert.equal(snapshot.decisions[0]?.state, "open");
    assert.equal(snapshot.status.activeAssignmentIds.length, 1);
    assert.match(status.stdout, /Open decisions: 1/);
    return;
  }

  assert.match(run.stdout, /Result \((completed|failed|partial)\):/);
  assert.equal(snapshot.results.length, 1);
  assert.match(status.stdout, /Results: 1/);
});
