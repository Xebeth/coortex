import type {
  Assignment,
  DecisionPacket,
  ResultPacket,
  RuntimeProjection,
  RuntimeSnapshot
} from "../core/types.js";
import { cloneWorkflowProgress } from "./workflow-projection-helpers.js";

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
  if (projection.workflowProgress) {
    snapshot.workflowProgress = cloneWorkflowProgress(projection.workflowProgress);
  }
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
  if (snapshot.workflowProgress) {
    projection.workflowProgress = cloneWorkflowProgress(snapshot.workflowProgress);
  }
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
