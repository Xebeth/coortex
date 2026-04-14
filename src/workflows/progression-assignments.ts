import { randomUUID } from "node:crypto";

import type {
  Assignment,
  RuntimeProjection,
  WorkflowProgressRecord
} from "../core/types.js";
import { getWorkflowModule } from "./registry.js";

export const DEFAULT_WORKFLOW_WRITE_SCOPE = ["src/", "docs/", "README.md"];

export function buildWorkflowAssignment(options: {
  sessionId: string;
  adapterId: string;
  assignmentId: string;
  workflowId: string;
  workflowCycle: number;
  moduleAttempt: number;
  moduleId: string;
  inheritedWriteScope: string[];
  timestamp: string;
}): Assignment {
  const template = buildWorkflowAssignmentTemplate(options);
  return {
    id: options.assignmentId,
    ...template,
    createdAt: options.timestamp,
    updatedAt: options.timestamp
  };
}

export function resolveModuleTransitionAssignment(
  projection: RuntimeProjection,
  progress: WorkflowProgressRecord,
  currentAssignment: Assignment,
  nextModuleId: string,
  workflowCycle: number,
  transitionBoundaryAt: string,
  timestamp: string
): {
  assignment: Assignment;
  reused: boolean;
} {
  const assignmentTemplate = buildWorkflowAssignmentTemplate({
    sessionId: projection.sessionId,
    adapterId: projection.status.activeAdapter,
    workflowId: progress.workflowId,
    workflowCycle,
    moduleAttempt: 1,
    moduleId: nextModuleId,
    inheritedWriteScope: [...currentAssignment.writeScope]
  });
  const existingAssignment = findExistingImpliedTransitionAssignment(
    projection,
    currentAssignment,
    transitionBoundaryAt,
    assignmentTemplate
  );
  if (existingAssignment) {
    return {
      assignment: existingAssignment,
      reused: true
    };
  }
  return {
    assignment: {
      id: randomUUID(),
      ...assignmentTemplate,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    reused: false
  };
}

function buildWorkflowAssignmentTemplate(options: {
  sessionId: string;
  adapterId: string;
  workflowId: string;
  workflowCycle: number;
  moduleAttempt: number;
  moduleId: string;
  inheritedWriteScope: string[];
}): Omit<Assignment, "id" | "createdAt" | "updatedAt"> {
  const module = getWorkflowModule(options.moduleId);
  const template = module.createAssignment({
    sessionId: options.sessionId,
    workflowId: options.workflowId,
    adapterId: options.adapterId,
    assignmentId: "",
    workflowCycle: options.workflowCycle,
    moduleAttempt: options.moduleAttempt,
    inheritedWriteScope: options.inheritedWriteScope
  });
  return {
    parentTaskId: options.sessionId,
    workflow: template.workflow,
    ownerType: template.ownerType,
    ownerId: template.ownerId,
    objective: template.objective,
    writeScope: [...template.writeScope],
    requiredOutputs: [...template.requiredOutputs],
    state: template.state
  };
}

function findExistingImpliedTransitionAssignment(
  projection: RuntimeProjection,
  currentAssignment: Assignment,
  transitionBoundaryAt: string,
  expectedAssignment: Omit<Assignment, "id" | "createdAt" | "updatedAt">
): Assignment | undefined {
  const lowerBound = [currentAssignment.createdAt, currentAssignment.updatedAt, transitionBoundaryAt]
    .sort()
    .at(-1) ?? transitionBoundaryAt;
  return [...projection.assignments.values()]
    .filter((candidate) =>
      candidate.id !== currentAssignment.id &&
      candidate.createdAt >= lowerBound &&
      isEquivalentImpliedTransitionAssignment(candidate, expectedAssignment)
    )
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    )[0];
}

function isEquivalentImpliedTransitionAssignment(
  candidate: Assignment,
  expectedAssignment: Omit<Assignment, "id" | "createdAt" | "updatedAt">
): boolean {
  if (
    candidate.parentTaskId !== expectedAssignment.parentTaskId ||
    candidate.workflow !== expectedAssignment.workflow ||
    candidate.ownerType !== expectedAssignment.ownerType ||
    candidate.ownerId !== expectedAssignment.ownerId ||
    candidate.objective !== expectedAssignment.objective
  ) {
    return false;
  }
  return (
    arrayShallowEqual(candidate.writeScope, expectedAssignment.writeScope) &&
    arrayShallowEqual(candidate.requiredOutputs, expectedAssignment.requiredOutputs)
  );
}

function arrayShallowEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
