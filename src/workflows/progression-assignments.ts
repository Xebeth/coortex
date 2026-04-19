import { randomUUID } from "node:crypto";

import type {
  Assignment,
  RuntimeProjection,
  WorkflowProgressRecord,
  WorkflowRunAttemptIdentity
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
    progress,
    currentAssignment.id,
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
    workflowAttempt: {
      workflowId: options.workflowId,
      workflowCycle: options.workflowCycle,
      moduleId: options.moduleId,
      moduleAttempt: options.moduleAttempt
    },
    objective: template.objective,
    writeScope: [...template.writeScope],
    requiredOutputs: [...template.requiredOutputs],
    state: template.state
  };
}

function findExistingImpliedTransitionAssignment(
  projection: RuntimeProjection,
  progress: WorkflowProgressRecord,
  currentAssignmentId: string,
  expectedAssignment: Omit<Assignment, "id" | "createdAt" | "updatedAt">
): Assignment | undefined {
  return [...projection.assignments.values()]
    .filter((candidate) =>
      candidate.id !== currentAssignmentId &&
      isEquivalentImpliedTransitionAssignment(candidate, expectedAssignment, progress)
    )
    .sort(
      (left, right) =>
        compareTransitionAssignmentIdentity(
          resolveWorkflowAttemptIdentity(left, progress),
          resolveWorkflowAttemptIdentity(right, progress),
          expectedAssignment.workflowAttempt
        ) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
    )[0];
}

function isEquivalentImpliedTransitionAssignment(
  candidate: Assignment,
  expectedAssignment: Omit<Assignment, "id" | "createdAt" | "updatedAt">,
  progress: WorkflowProgressRecord
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
  const expectedAttempt = expectedAssignment.workflowAttempt;
  const candidateAttempt = resolveWorkflowAttemptIdentity(candidate, progress);
  if (expectedAttempt && candidateAttempt && !workflowAttemptsMatch(candidateAttempt, expectedAttempt)) {
    return false;
  }
  return (
    arrayShallowEqual(candidate.writeScope, expectedAssignment.writeScope) &&
    arrayShallowEqual(candidate.requiredOutputs, expectedAssignment.requiredOutputs)
  );
}

function compareTransitionAssignmentIdentity(
  left: WorkflowRunAttemptIdentity | undefined,
  right: WorkflowRunAttemptIdentity | undefined,
  expected: WorkflowRunAttemptIdentity | undefined
): number {
  return compareIdentitySpecificity(left, expected) - compareIdentitySpecificity(right, expected);
}

function compareIdentitySpecificity(
  candidate: WorkflowRunAttemptIdentity | undefined,
  expected: WorkflowRunAttemptIdentity | undefined
): number {
  if (!expected) {
    return 0;
  }
  return candidate && workflowAttemptsMatch(candidate, expected) ? 0 : 1;
}

function resolveWorkflowAttemptIdentity(
  candidate: Assignment,
  progress: WorkflowProgressRecord
): WorkflowRunAttemptIdentity | undefined {
  return candidate.workflowAttempt ?? inferWorkflowAttemptFromProgress(progress, candidate.id);
}

function inferWorkflowAttemptFromProgress(
  progress: WorkflowProgressRecord,
  assignmentId: string
): WorkflowRunAttemptIdentity | undefined {
  for (const module of Object.values(progress.modules)) {
    if (module.assignmentId === assignmentId) {
      return {
        workflowId: progress.workflowId,
        workflowCycle: module.workflowCycle,
        moduleId: module.moduleId,
        moduleAttempt: module.moduleAttempt
      };
    }
  }
  if (progress.lastGate?.assignmentId === assignmentId) {
    return {
      workflowId: progress.workflowId,
      workflowCycle: progress.lastGate.workflowCycle,
      moduleId: progress.lastGate.moduleId,
      moduleAttempt: progress.lastGate.moduleAttempt
    };
  }
  if (progress.lastTransition?.nextAssignmentId === assignmentId) {
    return {
      workflowId: progress.workflowId,
      workflowCycle: progress.lastTransition.workflowCycle,
      moduleId: progress.lastTransition.toModuleId,
      moduleAttempt: progress.lastTransition.moduleAttempt
    };
  }
  return undefined;
}

function workflowAttemptsMatch(
  left: WorkflowRunAttemptIdentity,
  right: WorkflowRunAttemptIdentity
): boolean {
  return (
    left.workflowId === right.workflowId &&
    left.workflowCycle === right.workflowCycle &&
    left.moduleId === right.moduleId &&
    left.moduleAttempt === right.moduleAttempt
  );
}

function arrayShallowEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
