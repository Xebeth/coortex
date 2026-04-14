import type {
  WorkflowArtifactReference,
  WorkflowLastGateRecord,
  WorkflowModuleProgressRecord,
  WorkflowProgressRecord,
  WorkflowTransitionRecord
} from "../core/types.js";

export function requireWorkflowProgress(
  progress: WorkflowProgressRecord | undefined
): WorkflowProgressRecord {
  if (!progress) {
    throw new Error("Cannot apply workflow event without initialized workflow progress.");
  }
  return progress;
}

export function ensureWorkflowModule(
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

export function cloneWorkflowProgress(progress: WorkflowProgressRecord): WorkflowProgressRecord {
  return {
    workflowId: progress.workflowId,
    orderedModuleIds: [...progress.orderedModuleIds],
    currentModuleId: progress.currentModuleId,
    workflowCycle: progress.workflowCycle,
    currentAssignmentId: progress.currentAssignmentId,
    currentModuleAttempt: progress.currentModuleAttempt,
    modules: Object.fromEntries(
      Object.entries(progress.modules).map(([moduleId, module]) => [
        moduleId,
        cloneWorkflowModule(module)
      ])
    ),
    ...(progress.lastGate ? { lastGate: cloneLastGate(progress.lastGate) } : {}),
    ...(progress.lastTransition ? { lastTransition: cloneTransition(progress.lastTransition) } : {})
  };
}

export function dedupeArtifactReferences(
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
