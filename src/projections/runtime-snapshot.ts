import type {
  Assignment,
  DecisionPacket,
  ResultPacket,
  RuntimeProjection,
  RuntimeSnapshot,
  RuntimeStatus
} from "../core/types.js";
import { cloneWorkflowProgress } from "./workflow-projection-helpers.js";

export function toSnapshot(projection: RuntimeProjection): RuntimeSnapshot {
  const snapshot: RuntimeSnapshot = {
    version: 1,
    sessionId: projection.sessionId,
    rootPath: projection.rootPath,
    adapter: projection.adapter,
    status: cloneStatus(projection.status),
    assignments: sortByTimestamp([...projection.assignments.values()]).map(cloneAssignment),
    results: sortByTimestamp([...projection.results.values()]).map(cloneResult),
    decisions: sortByTimestamp([...projection.decisions.values()]).map(cloneDecision)
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
    status: cloneStatus(snapshot.status),
    assignments: new Map(
      snapshot.assignments.map((assignment) => [assignment.id, cloneAssignment(assignment)])
    ),
    results: new Map(
      snapshot.results.map((result) => [result.resultId, cloneResult(result)])
    ),
    decisions: new Map(
      snapshot.decisions.map((decision) => [decision.decisionId, cloneDecision(decision)])
    )
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

function cloneStatus(status: RuntimeStatus): RuntimeStatus {
  return {
    ...status,
    activeAssignmentIds: [...status.activeAssignmentIds]
  };
}

function cloneAssignment(assignment: Assignment): Assignment {
  return {
    ...assignment,
    ...(assignment.workflowAttempt ? { workflowAttempt: { ...assignment.workflowAttempt } } : {}),
    writeScope: [...assignment.writeScope],
    requiredOutputs: [...assignment.requiredOutputs]
  };
}

function cloneResult(result: ResultPacket): ResultPacket {
  return {
    ...result,
    changedFiles: [...result.changedFiles]
  };
}

function cloneDecision(decision: DecisionPacket): DecisionPacket {
  return {
    ...decision,
    options: decision.options.map((option) => ({ ...option }))
  };
}
