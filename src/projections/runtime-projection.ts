import type { RuntimeEvent } from "../core/events.js";
import type {
  Assignment,
  DecisionPacket,
  ResultPacket,
  RuntimeProjection,
  RuntimeSnapshot,
  RuntimeStatus,
  WorkflowArtifactReference,
  WorkflowLastGateRecord,
  WorkflowModuleProgressRecord,
  WorkflowProgressRecord,
  WorkflowTransitionRecord
} from "../core/types.js";
import { deriveActiveWorkflowModuleState } from "../core/workflow-module-state.js";

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
      syncWorkflowModuleState(projection, event.payload.assignment.id);
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
      syncWorkflowModuleState(projection, event.payload.assignmentId);
      break;
    }
    case "result.submitted":
      projection.results.set(event.payload.result.resultId, event.payload.result);
      break;
    case "decision.created":
      projection.decisions.set(event.payload.decision.decisionId, event.payload.decision);
      syncWorkflowModuleState(projection, event.payload.decision.assignmentId);
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
      syncWorkflowModuleState(projection, current.assignmentId);
      break;
    }
    case "workflow.initialized": {
      projection.workflowProgress = {
        workflowId: event.payload.workflowId,
        orderedModuleIds: [...event.payload.orderedModuleIds],
        currentModuleId: event.payload.currentModuleId,
        workflowCycle: event.payload.workflowCycle,
        currentAssignmentId: event.payload.currentAssignmentId,
        currentModuleAttempt: event.payload.currentModuleAttempt,
        modules: {
          [event.payload.currentModuleId]: {
            moduleId: event.payload.currentModuleId,
            workflowCycle: event.payload.workflowCycle,
            moduleAttempt: event.payload.currentModuleAttempt,
            assignmentId: event.payload.currentAssignmentId,
            moduleState: "queued",
            sourceResultIds: [],
            sourceDecisionIds: [],
            artifactReferences: [],
            enteredAt: event.payload.initializedAt
          }
        }
      };
      break;
    }
    case "workflow.artifact.claimed": {
      const progress = requireWorkflowProgress(projection);
      const module = ensureWorkflowModule(
        progress,
        event.payload.moduleId,
        event.payload.workflowCycle,
        event.payload.moduleAttempt,
        event.payload.assignmentId,
        event.payload.claimedAt
      );
      const reference: WorkflowArtifactReference = {
        path: event.payload.artifactPath,
        format: event.payload.artifactFormat,
        digest: event.payload.artifactDigest,
        sourceResultId: event.payload.sourceResultId
      };
      module.artifactReferences = dedupeArtifactReferences([
        ...module.artifactReferences,
        reference
      ]);
      break;
    }
    case "workflow.gate.recorded": {
      const progress = requireWorkflowProgress(projection);
      const module = ensureWorkflowModule(
        progress,
        event.payload.moduleId,
        event.payload.workflowCycle,
        event.payload.moduleAttempt,
        event.payload.assignmentId,
        event.payload.evaluatedAt
      );
      module.moduleState = event.payload.moduleState;
      module.gateOutcome = event.payload.gateOutcome;
      module.sourceResultIds = [...event.payload.sourceResultIds];
      module.sourceDecisionIds = [...event.payload.sourceDecisionIds];
      if (event.payload.evidenceSummary) {
        module.evidenceSummary = event.payload.evidenceSummary;
      } else {
        delete module.evidenceSummary;
      }
      if (event.payload.checklistStatus) {
        module.checklistStatus = event.payload.checklistStatus;
      } else {
        delete module.checklistStatus;
      }
      module.artifactReferences = event.payload.artifactReferences.map((reference) => ({
        ...reference
      }));
      module.evaluatedAt = event.payload.evaluatedAt;
      progress.lastGate = {
        moduleId: event.payload.moduleId,
        workflowCycle: event.payload.workflowCycle,
        moduleAttempt: event.payload.moduleAttempt,
        assignmentId: event.payload.assignmentId,
        gateOutcome: event.payload.gateOutcome,
        sourceResultIds: [...event.payload.sourceResultIds],
        sourceDecisionIds: [...event.payload.sourceDecisionIds],
        artifactReferences: event.payload.artifactReferences.map((reference) => ({ ...reference })),
        evaluatedAt: event.payload.evaluatedAt,
        ...(event.payload.evidenceSummary ? { evidenceSummary: event.payload.evidenceSummary } : {}),
        ...(event.payload.checklistStatus
          ? { checklistStatus: event.payload.checklistStatus }
          : {})
      };
      break;
    }
    case "workflow.transition.applied": {
      const progress = requireWorkflowProgress(projection);
      const previousModule = progress.modules[event.payload.fromModuleId];
      if (previousModule) {
        previousModule.moduleState = "completed";
      }
      progress.currentModuleId = event.payload.toModuleId;
      progress.workflowCycle = event.payload.workflowCycle;
      progress.currentAssignmentId = event.payload.nextAssignmentId;
      progress.currentModuleAttempt = event.payload.moduleAttempt;
      progress.lastTransition = {
        fromModuleId: event.payload.fromModuleId,
        toModuleId: event.payload.toModuleId,
        workflowCycle: event.payload.workflowCycle,
        moduleAttempt: event.payload.moduleAttempt,
        transition: event.payload.transition,
        previousAssignmentId: event.payload.previousAssignmentId,
        nextAssignmentId: event.payload.nextAssignmentId,
        appliedAt: event.payload.appliedAt
      };
      if (event.payload.transition === "complete") {
        const completedModule = ensureWorkflowModule(
          progress,
          event.payload.toModuleId,
          event.payload.workflowCycle,
          event.payload.moduleAttempt,
          event.payload.previousAssignmentId,
          event.payload.appliedAt
        );
        completedModule.assignmentId = event.payload.previousAssignmentId;
        completedModule.moduleState = "completed";
        completedModule.workflowCycle = event.payload.workflowCycle;
        completedModule.moduleAttempt = event.payload.moduleAttempt;
        break;
      }
      const nextModule = ensureWorkflowModule(
        progress,
        event.payload.toModuleId,
        event.payload.workflowCycle,
        event.payload.moduleAttempt,
        event.payload.nextAssignmentId,
        event.payload.appliedAt
      );
      const previousGate = event.payload.transition === "rerun_same_module"
        ? progress.lastGate
        : undefined;
      nextModule.assignmentId = event.payload.nextAssignmentId;
      nextModule.workflowCycle = event.payload.workflowCycle;
      nextModule.moduleAttempt = event.payload.moduleAttempt;
      nextModule.moduleState = "queued";
      nextModule.sourceResultIds = [];
      nextModule.sourceDecisionIds = [];
      nextModule.artifactReferences = [];
      nextModule.enteredAt = event.payload.appliedAt;
      delete nextModule.evaluatedAt;
      delete nextModule.checklistStatus;
      delete nextModule.evidenceSummary;
      if (event.payload.transition === "rerun_same_module" && previousGate?.gateOutcome) {
        nextModule.gateOutcome = previousGate.gateOutcome;
      } else {
        delete nextModule.gateOutcome;
      }
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

function requireWorkflowProgress(projection: RuntimeProjection): WorkflowProgressRecord {
  if (!projection.workflowProgress) {
    throw new Error("Cannot apply workflow event without initialized workflow progress.");
  }
  return projection.workflowProgress;
}

function ensureWorkflowModule(
  progress: WorkflowProgressRecord,
  moduleId: string,
  workflowCycle: number,
  moduleAttempt: number,
  assignmentId: string | null,
  enteredAt: string
): WorkflowModuleProgressRecord {
  const current = progress.modules[moduleId];
  if (current) {
    return current;
  }
  const created: WorkflowModuleProgressRecord = {
    moduleId,
    workflowCycle,
    moduleAttempt,
    assignmentId,
    moduleState: "queued",
    sourceResultIds: [],
    sourceDecisionIds: [],
    artifactReferences: [],
    enteredAt
  };
  progress.modules[moduleId] = created;
  return created;
}

function syncWorkflowModuleState(projection: RuntimeProjection, assignmentId: string): void {
  const progress = projection.workflowProgress;
  if (!progress || progress.currentAssignmentId !== assignmentId) {
    return;
  }
  const module = progress.modules[progress.currentModuleId];
  if (!module) {
    return;
  }
  const assignment = projection.assignments.get(assignmentId);
  if (!assignment) {
    return;
  }
  const openDecision = [...projection.decisions.values()].some(
    (decision) => decision.assignmentId === assignmentId && decision.state === "open"
  );
  module.assignmentId = assignmentId;
  module.workflowCycle = progress.workflowCycle;
  module.moduleAttempt = progress.currentModuleAttempt;
  module.moduleState = deriveActiveWorkflowModuleState(
    assignment.state,
    openDecision,
    progress.lastTransition,
    module
  );
}

function cloneWorkflowProgress(progress: WorkflowProgressRecord): WorkflowProgressRecord {
  return {
    workflowId: progress.workflowId,
    orderedModuleIds: [...progress.orderedModuleIds],
    currentModuleId: progress.currentModuleId,
    workflowCycle: progress.workflowCycle,
    currentAssignmentId: progress.currentAssignmentId,
    currentModuleAttempt: progress.currentModuleAttempt,
    modules: Object.fromEntries(
      Object.entries(progress.modules).map(([moduleId, module]) => [moduleId, cloneWorkflowModule(module)])
    ),
    ...(progress.lastGate ? { lastGate: cloneLastGate(progress.lastGate) } : {}),
    ...(progress.lastTransition ? { lastTransition: cloneTransition(progress.lastTransition) } : {})
  };
}

function cloneWorkflowModule(module: WorkflowModuleProgressRecord): WorkflowModuleProgressRecord {
  return {
    moduleId: module.moduleId,
    workflowCycle: module.workflowCycle,
    moduleAttempt: module.moduleAttempt,
    assignmentId: module.assignmentId,
    moduleState: module.moduleState,
    ...(module.gateOutcome ? { gateOutcome: module.gateOutcome } : {}),
    sourceResultIds: [...module.sourceResultIds],
    sourceDecisionIds: [...module.sourceDecisionIds],
    ...(module.evidenceSummary ? { evidenceSummary: module.evidenceSummary } : {}),
    ...(module.checklistStatus ? { checklistStatus: module.checklistStatus } : {}),
    artifactReferences: module.artifactReferences.map((reference) => ({ ...reference })),
    enteredAt: module.enteredAt,
    ...(module.evaluatedAt ? { evaluatedAt: module.evaluatedAt } : {})
  };
}

function cloneLastGate(lastGate: WorkflowLastGateRecord): WorkflowLastGateRecord {
  return {
    moduleId: lastGate.moduleId,
    workflowCycle: lastGate.workflowCycle,
    moduleAttempt: lastGate.moduleAttempt,
    assignmentId: lastGate.assignmentId,
    gateOutcome: lastGate.gateOutcome,
    sourceResultIds: [...lastGate.sourceResultIds],
    sourceDecisionIds: [...lastGate.sourceDecisionIds],
    ...(lastGate.evidenceSummary ? { evidenceSummary: lastGate.evidenceSummary } : {}),
    ...(lastGate.checklistStatus ? { checklistStatus: lastGate.checklistStatus } : {}),
    artifactReferences: lastGate.artifactReferences.map((reference) => ({ ...reference })),
    evaluatedAt: lastGate.evaluatedAt
  };
}

function cloneTransition(lastTransition: WorkflowTransitionRecord): WorkflowTransitionRecord {
  return {
    fromModuleId: lastTransition.fromModuleId,
    toModuleId: lastTransition.toModuleId,
    workflowCycle: lastTransition.workflowCycle,
    moduleAttempt: lastTransition.moduleAttempt,
    transition: lastTransition.transition,
    previousAssignmentId: lastTransition.previousAssignmentId,
    nextAssignmentId: lastTransition.nextAssignmentId,
    appliedAt: lastTransition.appliedAt
  };
}

function dedupeArtifactReferences(
  references: WorkflowArtifactReference[]
): WorkflowArtifactReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.path}:${reference.format}:${reference.digest ?? ""}:${reference.sourceResultId ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
