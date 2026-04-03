import type { RuntimeEvent } from "../core/events.js";
import type {
  Assignment,
  DecisionPacket,
  ResultPacket,
  RuntimeProjection,
  RuntimeSnapshot,
  RuntimeStatus
} from "../core/types.js";

const EMPTY_STATUS: RuntimeStatus = {
  activeMode: "idle",
  currentObjective: "No active objective.",
  activeAssignmentIds: [],
  activeHost: "unknown",
  activeAdapter: "unknown",
  lastDurableOutputAt: "",
  resumeReady: false
};

export function createEmptyProjection(
  sessionId: string,
  rootPath: string,
  adapter: string
): RuntimeProjection {
  return {
    sessionId,
    rootPath,
    adapter,
    status: { ...EMPTY_STATUS, activeAdapter: adapter },
    assignments: new Map(),
    results: new Map(),
    decisions: new Map()
  };
}

export function applyRuntimeEvent(
  projection: RuntimeProjection,
  event: RuntimeEvent
): RuntimeProjection {
  projection.lastEventId = event.eventId;

  switch (event.type) {
    case "assignment.created":
      projection.assignments.set(event.payload.assignment.id, event.payload.assignment);
      break;
    case "assignment.updated": {
      const current = projection.assignments.get(event.payload.assignmentId);
      if (!current) {
        throw new Error(`Cannot update missing assignment ${event.payload.assignmentId}`);
      }
      projection.assignments.set(event.payload.assignmentId, {
        ...current,
        ...event.payload.patch
      });
      break;
    }
    case "result.submitted":
      projection.results.set(event.payload.result.resultId, event.payload.result);
      break;
    case "decision.created":
      projection.decisions.set(event.payload.decision.decisionId, event.payload.decision);
      break;
    case "decision.resolved": {
      const current = projection.decisions.get(event.payload.decisionId);
      if (!current) {
        throw new Error(`Cannot resolve missing decision ${event.payload.decisionId}`);
      }
      projection.decisions.set(event.payload.decisionId, {
        ...current,
        state: "resolved",
        resolvedAt: event.payload.resolvedAt,
        resolutionSummary: event.payload.resolutionSummary
      });
      break;
    }
    case "status.updated":
      projection.status = event.payload.status;
      break;
  }

  return projection;
}

export function projectRuntimeState(
  sessionId: string,
  rootPath: string,
  adapter: string,
  events: RuntimeEvent[]
): RuntimeProjection {
  const projection = createEmptyProjection(sessionId, rootPath, adapter);
  for (const event of events) {
    applyRuntimeEvent(projection, event);
  }
  return projection;
}

export function toSnapshot(projection: RuntimeProjection): RuntimeSnapshot {
  const snapshot: RuntimeSnapshot = {
    version: 1,
    sessionId: projection.sessionId,
    rootPath: projection.rootPath,
    adapter: projection.adapter,
    status: projection.status,
    assignments: sortByTimestamp([...projection.assignments.values()]),
    results: sortByTimestamp([...projection.results.values()]),
    decisions: sortByTimestamp([...projection.decisions.values()])
  };
  if (projection.lastEventId) {
    snapshot.lastEventId = projection.lastEventId;
  }
  return snapshot;
}

export function fromSnapshot(snapshot: RuntimeSnapshot): RuntimeProjection {
  const projection: RuntimeProjection = {
    sessionId: snapshot.sessionId,
    rootPath: snapshot.rootPath,
    adapter: snapshot.adapter,
    status: snapshot.status,
    assignments: new Map(snapshot.assignments.map((assignment) => [assignment.id, assignment])),
    results: new Map(snapshot.results.map((result) => [result.resultId, result])),
    decisions: new Map(snapshot.decisions.map((decision) => [decision.decisionId, decision]))
  };
  if (snapshot.lastEventId) {
    projection.lastEventId = snapshot.lastEventId;
  }
  return projection;
}

function sortByTimestamp<T extends Assignment | ResultPacket | DecisionPacket>(values: T[]): T[] {
  return [...values].sort((left, right) => {
    const leftValue =
      "updatedAt" in left
        ? left.updatedAt
        : "resolvedAt" in left && left.resolvedAt
          ? left.resolvedAt
          : left.createdAt;
    const rightValue =
      "updatedAt" in right
        ? right.updatedAt
        : "resolvedAt" in right && right.resolvedAt
          ? right.resolvedAt
          : right.createdAt;
    return leftValue.localeCompare(rightValue);
  });
}
