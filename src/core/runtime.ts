import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import type { Assignment, RuntimeStatus } from "./types.js";
import type { RuntimeEvent } from "./events.js";
import { nowIso } from "../utils/time.js";

export interface BootstrapOptions {
  rootPath: string;
  sessionId?: string;
  adapter: string;
  host: string;
  workflow?: string;
  objective?: string;
}

export interface BootstrapRuntime {
  sessionId: string;
  events: RuntimeEvent[];
  initialAssignmentId: string;
}

export function createBootstrapRuntime(options: BootstrapOptions): BootstrapRuntime {
  const timestamp = nowIso();
  const sessionId = options.sessionId ?? randomUUID();
  const assignmentId = randomUUID();
  const repoName = basename(options.rootPath);
  const objective =
    options.objective ?? `Coordinate work for ${repoName} through the Coortex runtime.`;

  const assignment: Assignment = {
    id: assignmentId,
    parentTaskId: sessionId,
    workflow: options.workflow ?? "milestone-1",
    ownerType: "runtime",
    ownerId: `${options.adapter}:bootstrap`,
    objective,
    writeScope: ["src/", "docs/", "README.md"],
    requiredOutputs: ["code changes", "tests", "brief summary"],
    state: "in_progress",
    createdAt: timestamp,
    updatedAt: timestamp
  };

  const status: RuntimeStatus = {
    activeMode: "solo",
    currentObjective: objective,
    activeAssignmentIds: [assignmentId],
    activeHost: options.host,
    activeAdapter: options.adapter,
    lastDurableOutputAt: timestamp,
    resumeReady: true
  };

  return {
    sessionId,
    initialAssignmentId: assignmentId,
    events: [
      {
        eventId: randomUUID(),
        sessionId,
        timestamp,
        type: "assignment.created",
        payload: { assignment }
      },
      {
        eventId: randomUUID(),
        sessionId,
        timestamp,
        type: "status.updated",
        payload: { status }
      }
    ]
  };
}
