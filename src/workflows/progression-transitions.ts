import { randomUUID } from "node:crypto";

import type { RuntimeEvent } from "../core/events.js";
import type {
  Assignment,
  DecisionPacket,
  ResultPacket,
  RuntimeProjection,
  WorkflowArtifactReference,
  WorkflowModuleProgressRecord,
  WorkflowProgressRecord,
  WorkflowTransitionType
} from "../core/types.js";
import { derivePreTransitionWorkflowModuleState } from "../core/workflow-module-state.js";
import { resolveModuleTransitionAssignment } from "./progression-assignments.js";
import { hasClaimedArtifact } from "./progression-artifacts.js";
import type {
  WorkflowClaimedArtifact,
  WorkflowGateEvaluation
} from "./types.js";

export function buildBlockedDecisionEvents(
  projection: RuntimeProjection,
  progress: WorkflowProgressRecord,
  currentModule: WorkflowModuleProgressRecord,
  currentAssignment: Assignment,
  decision: DecisionPacket,
  timestamp: string
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  if (currentAssignment.state !== "blocked") {
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "assignment.updated",
      payload: {
        assignmentId: currentAssignment.id,
        patch: {
          state: "blocked",
          updatedAt: timestamp
        }
      }
    });
  }
  if (
    progress.lastGate?.moduleId !== progress.currentModuleId ||
    progress.lastGate.workflowCycle !== progress.workflowCycle ||
    progress.lastGate.moduleAttempt !== progress.currentModuleAttempt ||
    progress.lastGate.assignmentId !== currentAssignment.id ||
    progress.lastGate.gateOutcome !== "blocked" ||
    !progress.lastGate.sourceDecisionIds.includes(decision.decisionId)
  ) {
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "workflow.gate.recorded",
      payload: {
        workflowId: progress.workflowId,
        workflowCycle: progress.workflowCycle,
        moduleId: progress.currentModuleId,
        moduleAttempt: progress.currentModuleAttempt,
        assignmentId: currentAssignment.id,
        moduleState: "blocked",
        gateOutcome: "blocked",
        sourceResultIds: [],
        sourceDecisionIds: [decision.decisionId],
        artifactReferences: currentModule.artifactReferences.map((reference) => ({ ...reference })),
        evidenceSummary: decision.blockerSummary,
        evaluatedAt: timestamp
      }
    });
  }
  return events;
}

export function buildGatePersistenceEvents(
  projection: RuntimeProjection,
  progress: WorkflowProgressRecord,
  currentModule: WorkflowModuleProgressRecord,
  currentAssignment: Assignment,
  gateEvaluation: WorkflowGateEvaluation,
  claimedArtifact: WorkflowClaimedArtifact | undefined,
  result: ResultPacket,
  timestamp: string
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];

  if (claimedArtifact && !hasClaimedArtifact(currentModule, claimedArtifact.reference, result.resultId)) {
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "workflow.artifact.claimed",
      payload: {
        workflowId: progress.workflowId,
        workflowCycle: progress.workflowCycle,
        moduleId: progress.currentModuleId,
        moduleAttempt: progress.currentModuleAttempt,
        assignmentId: currentAssignment.id,
        artifactPath: claimedArtifact.reference.path,
        artifactFormat: "json",
        artifactDigest: claimedArtifact.reference.digest ?? "",
        sourceResultId: result.resultId,
        claimedAt: timestamp
      }
    });
  }

  if (!hasEquivalentGate(progress, currentAssignment.id, gateEvaluation)) {
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "workflow.gate.recorded",
      payload: {
        workflowId: progress.workflowId,
        workflowCycle: progress.workflowCycle,
        moduleId: progress.currentModuleId,
        moduleAttempt: progress.currentModuleAttempt,
        assignmentId: currentAssignment.id,
        moduleState: derivePreTransitionWorkflowModuleState(
          currentAssignment.state,
          currentModule.moduleState
        ),
        gateOutcome: gateEvaluation.gateOutcome,
        ...(gateEvaluation.checklistStatus
          ? { checklistStatus: gateEvaluation.checklistStatus }
          : {}),
        ...(gateEvaluation.evidenceSummary
          ? { evidenceSummary: gateEvaluation.evidenceSummary }
          : {}),
        sourceResultIds: [...gateEvaluation.sourceResultIds],
        sourceDecisionIds: [...gateEvaluation.sourceDecisionIds],
        artifactReferences: gateEvaluation.artifactReferences.map((reference) => ({ ...reference })),
        evaluatedAt: timestamp
      }
    });
  }

  return events;
}

export function buildSameModuleRerunEvents(
  projection: RuntimeProjection,
  progress: WorkflowProgressRecord,
  currentAssignment: Assignment,
  timestamp: string,
  previousGateOutcome?: string
): RuntimeEvent[] {
  const nextAttempt = progress.currentModuleAttempt + 1;
  const events: RuntimeEvent[] = [];
  if (currentAssignment.state !== "queued") {
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "assignment.updated",
      payload: {
        assignmentId: currentAssignment.id,
        patch: {
          state: "queued",
          updatedAt: timestamp
        }
      }
    });
  }
  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "workflow.transition.applied",
    payload: {
      workflowId: progress.workflowId,
      fromModuleId: progress.currentModuleId,
      toModuleId: progress.currentModuleId,
      workflowCycle: progress.workflowCycle,
      moduleAttempt: nextAttempt,
      transition: "rerun_same_module",
      previousAssignmentId: currentAssignment.id,
      nextAssignmentId: currentAssignment.id,
      appliedAt: timestamp
    }
  });
  void previousGateOutcome;
  return events;
}

export function buildModuleTransitionEvents(
  projection: RuntimeProjection,
  progress: WorkflowProgressRecord,
  currentAssignment: Assignment,
  completedState: "completed" | "failed",
  transitionType: Extract<WorkflowTransitionType, "advance" | "rewind">,
  nextModuleId: string,
  workflowCycle: number,
  timestamp: string
): RuntimeEvent[] {
  const nextAssignmentResolution = resolveModuleTransitionAssignment(
    projection,
    progress,
    currentAssignment,
    nextModuleId,
    workflowCycle,
    timestamp
  );
  const events: RuntimeEvent[] = [];
  if (currentAssignment.state !== completedState) {
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "assignment.updated",
      payload: {
        assignmentId: currentAssignment.id,
        patch: {
          state: completedState,
          updatedAt: timestamp
        }
      }
    });
  }
  if (!nextAssignmentResolution.reused) {
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "assignment.created",
      payload: { assignment: nextAssignmentResolution.assignment }
    });
  }
  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "workflow.transition.applied",
    payload: {
      workflowId: progress.workflowId,
      fromModuleId: progress.currentModuleId,
      toModuleId: nextModuleId,
      workflowCycle,
      moduleAttempt: 1,
      transition: transitionType,
      previousAssignmentId: currentAssignment.id,
      nextAssignmentId: nextAssignmentResolution.assignment.id,
      appliedAt: timestamp
    }
  });
  return events;
}

export function buildCompleteWorkflowEvents(
  projection: RuntimeProjection,
  progress: WorkflowProgressRecord,
  currentAssignment: Assignment,
  completedState: "completed" | "failed",
  timestamp: string
): RuntimeEvent[] {
  return [
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "assignment.updated",
      payload: {
        assignmentId: currentAssignment.id,
        patch: {
          state: completedState,
          updatedAt: timestamp
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "workflow.transition.applied",
      payload: {
        workflowId: progress.workflowId,
        fromModuleId: progress.currentModuleId,
        toModuleId: progress.currentModuleId,
        workflowCycle: progress.workflowCycle,
        moduleAttempt: progress.currentModuleAttempt,
        transition: "complete",
        previousAssignmentId: currentAssignment.id,
        nextAssignmentId: null,
        appliedAt: timestamp
      }
    }
  ];
}

function hasEquivalentGate(
  progress: WorkflowProgressRecord,
  assignmentId: string,
  evaluation: WorkflowGateEvaluation
): boolean {
  const lastGate = progress.lastGate;
  return Boolean(
    lastGate &&
      lastGate.moduleId === progress.currentModuleId &&
      lastGate.workflowCycle === progress.workflowCycle &&
      lastGate.moduleAttempt === progress.currentModuleAttempt &&
      lastGate.assignmentId === assignmentId &&
      lastGate.gateOutcome === evaluation.gateOutcome &&
      sameValues(lastGate.sourceResultIds, evaluation.sourceResultIds) &&
      sameValues(lastGate.sourceDecisionIds, evaluation.sourceDecisionIds) &&
      (lastGate.evidenceSummary ?? "") === (evaluation.evidenceSummary ?? "") &&
      (lastGate.checklistStatus ?? "") === (evaluation.checklistStatus ?? "") &&
      sameArtifactReferences(lastGate.artifactReferences, evaluation.artifactReferences)
  );
}

function sameArtifactReferences(
  left: WorkflowArtifactReference[],
  right: WorkflowArtifactReference[]
): boolean {
  return sameValues(
    left.map((reference) => `${reference.path}:${reference.format}:${reference.digest ?? ""}:${reference.sourceResultId ?? ""}`),
    right.map((reference) => `${reference.path}:${reference.format}:${reference.digest ?? ""}:${reference.sourceResultId ?? ""}`)
  );
}

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
