import { createHash, randomUUID } from "node:crypto";

import type { RuntimeEvent } from "../core/events.js";
import type {
  Assignment,
  DecisionPacket,
  ResultPacket,
  RuntimeProjection,
  RuntimeStatus,
  WorkflowArtifactReference,
  WorkflowModuleProgressRecord,
  WorkflowProgressRecord,
  WorkflowTransitionType
} from "../core/types.js";
import { derivePreTransitionWorkflowModuleState } from "../core/workflow-module-state.js";
import { nowIso } from "../utils/time.js";
import { DEFAULT_WORKFLOW_ID, DEFAULT_WORKFLOW_MODULE_IDS, getWorkflowModule } from "./registry.js";
import type {
  WorkflowArtifactDocument,
  WorkflowArtifactStore,
  WorkflowClaimedArtifact,
  WorkflowProgressionResult
} from "./types.js";

export const DEFAULT_WORKFLOW_WRITE_SCOPE = ["src/", "docs/", "README.md"];

export interface WorkflowBootstrapOptions {
  sessionId: string;
  adapterId: string;
  host: string;
  objective?: string;
  workflowId?: string;
  assignmentId?: string;
  timestamp?: string;
  inheritedWriteScope?: string[];
}

export interface WorkflowStaleRunFact {
  assignmentId: string;
  staleAt: string;
}

export interface WorkflowProgressionOptions {
  timestamp?: string;
  staleRunFacts?: WorkflowStaleRunFact[];
}

export function buildWorkflowBootstrap(options: WorkflowBootstrapOptions): {
  initialAssignmentId: string;
  events: RuntimeEvent[];
} {
  const timestamp = options.timestamp ?? nowIso();
  const workflowId = options.workflowId ?? DEFAULT_WORKFLOW_ID;
  const assignmentId = options.assignmentId ?? randomUUID();
  const module = getWorkflowModule("plan");
  const assignment = buildWorkflowAssignment({
    sessionId: options.sessionId,
    adapterId: options.adapterId,
    assignmentId,
    workflowId,
    workflowCycle: 1,
    moduleAttempt: 1,
    moduleId: "plan",
    inheritedWriteScope: options.inheritedWriteScope ?? DEFAULT_WORKFLOW_WRITE_SCOPE,
    timestamp
  });

  return {
    initialAssignmentId: assignmentId,
    events: [
      {
        eventId: randomUUID(),
        sessionId: options.sessionId,
        timestamp,
        type: "workflow.initialized",
        payload: {
          workflowId,
          orderedModuleIds: [...DEFAULT_WORKFLOW_MODULE_IDS],
          currentModuleId: module.id,
          workflowCycle: 1,
          currentModuleAttempt: 1,
          currentAssignmentId: assignmentId,
          initializedAt: timestamp
        }
      },
      {
        eventId: randomUUID(),
        sessionId: options.sessionId,
        timestamp,
        type: "assignment.created",
        payload: { assignment }
      },
      {
        eventId: randomUUID(),
        sessionId: options.sessionId,
        timestamp,
        type: "status.updated",
        payload: {
          status: createBootstrapStatus(options.host, options.adapterId, assignment, timestamp)
        }
      }
    ]
  };
}

export async function evaluateWorkflowProgression(
  projection: RuntimeProjection,
  store: WorkflowArtifactStore,
  options: WorkflowProgressionOptions = {}
): Promise<WorkflowProgressionResult> {
  const progress = projection.workflowProgress;
  if (!progress) {
    return { events: [] };
  }
  const timestamp = options.timestamp ?? nowIso();
  const currentAssignment = getCurrentAssignment(projection, progress);
  if (!currentAssignment) {
    return { events: [] };
  }

  const currentModule = progress.modules[progress.currentModuleId];
  if (!currentModule) {
    return { events: [] };
  }

  const attemptStartedAt = currentAttemptStartedAt(progress);
  const attemptLowerBound = currentAttemptLowerBound(progress);
  const openDecision = findLatestDecision(projection, currentAssignment.id, attemptLowerBound, "open");
  if (openDecision) {
    return {
      events: buildBlockedDecisionEvents(
        projection,
        progress,
        currentModule,
        currentAssignment,
        openDecision,
        timestamp
      )
    };
  }

  const staleFact = findApplicableStaleRunFact(
    progress,
    currentAssignment.id,
    attemptStartedAt,
    options.staleRunFacts
  );
  if (staleFact) {
    return {
      events: buildSameModuleRerunEvents(
        projection,
        progress,
        currentAssignment,
        timestamp,
        currentModule.gateOutcome === "blocked" ? undefined : currentModule.gateOutcome
      )
    };
  }

  const resolvedDecision = findLatestDecision(
    projection,
    currentAssignment.id,
    attemptLowerBound,
    "resolved"
  );
  if (
    resolvedDecision &&
    (currentAssignment.state === "blocked" || progress.lastGate?.gateOutcome === "blocked")
  ) {
    return {
      events: buildSameModuleRerunEvents(projection, progress, currentAssignment, timestamp)
    };
  }

  const result = findLatestTerminalResult(projection, currentAssignment.id, attemptLowerBound);
  if (!result) {
    return { events: [] };
  }

  const claimedArtifact = await loadClaimedArtifact(
    store,
    progress,
    currentAssignment.id,
    result
  );
  const moduleDefinition = getWorkflowModule(progress.currentModuleId);
  const gateEvaluation = moduleDefinition.evaluateGate({
    projection,
    progress,
    currentModule,
    assignment: currentAssignment,
    result,
    artifact: claimedArtifact,
    currentCycleStartAt: currentCycleStartedAt(progress)
  });
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

  switch (gateEvaluation.transition.type) {
    case "rerun_same_module":
      events.push(
        ...buildSameModuleRerunEvents(
          projection,
          progress,
          currentAssignment,
          timestamp,
          gateEvaluation.gateOutcome
        )
      );
      break;
    case "advance":
    case "rewind":
      events.push(
        ...buildModuleTransitionEvents(
          projection,
          progress,
          currentAssignment,
          result.status === "failed" ? "failed" : "completed",
          gateEvaluation.transition.type,
          gateEvaluation.transition.toModuleId,
          gateEvaluation.transition.workflowCycle,
          timestamp
        )
      );
      break;
    case "complete":
      events.push(
        ...buildCompleteWorkflowEvents(
          projection,
          progress,
          currentAssignment,
          result.status === "failed" ? "failed" : "completed",
          timestamp
        )
      );
      break;
  }

  return { events };
}

export function workflowArtifactPath(
  workflowId: string,
  workflowCycle: number,
  moduleId: string,
  assignmentId: string,
  moduleAttempt: number
): string {
  return `runtime/workflows/${workflowId}/cycles/${workflowCycle}/${moduleId}/${assignmentId}/attempt-${moduleAttempt}.json`;
}

export function toProjectRelativeArtifactPath(storeRelativePath: string): string {
  return `.coortex/${storeRelativePath}`;
}

export function fromProjectRelativeArtifactPath(projectRelativePath: string): string {
  return projectRelativePath.replace(/^\.coortex\//, "");
}

function buildBlockedDecisionEvents(
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

function buildSameModuleRerunEvents(
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

function findApplicableStaleRunFact(
  progress: WorkflowProgressRecord,
  assignmentId: string,
  attemptStartedAt: string,
  staleRunFacts: WorkflowProgressionOptions["staleRunFacts"]
): WorkflowStaleRunFact | undefined {
  return staleRunFacts?.find((fact) => {
    if (fact.assignmentId !== assignmentId || fact.staleAt < attemptStartedAt) {
      return false;
    }
    return !hasConsumedStaleRunFact(progress, assignmentId, fact.staleAt);
  });
}

function hasConsumedStaleRunFact(
  progress: WorkflowProgressRecord,
  assignmentId: string,
  staleAt: string
): boolean {
  const lastTransition = progress.lastTransition;
  if (!lastTransition) {
    return false;
  }
  return (
    lastTransition.transition === "rerun_same_module" &&
    lastTransition.toModuleId === progress.currentModuleId &&
    lastTransition.workflowCycle === progress.workflowCycle &&
    lastTransition.moduleAttempt === progress.currentModuleAttempt &&
    lastTransition.previousAssignmentId === assignmentId &&
    lastTransition.nextAssignmentId === assignmentId &&
    lastTransition.appliedAt >= staleAt
  );
}

function buildModuleTransitionEvents(
  projection: RuntimeProjection,
  progress: WorkflowProgressRecord,
  currentAssignment: Assignment,
  completedState: "completed" | "failed",
  transitionType: Extract<WorkflowTransitionType, "advance" | "rewind">,
  nextModuleId: string,
  workflowCycle: number,
  timestamp: string
): RuntimeEvent[] {
  const nextAssignmentId = randomUUID();
  const assignment = buildWorkflowAssignment({
    sessionId: projection.sessionId,
    adapterId: projection.status.activeAdapter,
    assignmentId: nextAssignmentId,
    workflowId: progress.workflowId,
    workflowCycle,
    moduleAttempt: 1,
    moduleId: nextModuleId,
    inheritedWriteScope: [...currentAssignment.writeScope],
    timestamp
  });

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
      type: "assignment.created",
      payload: { assignment }
    },
    {
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
        nextAssignmentId,
        appliedAt: timestamp
      }
    }
  ];
}

function buildCompleteWorkflowEvents(
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

function buildWorkflowAssignment(options: {
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
  const module = getWorkflowModule(options.moduleId);
  const template = module.createAssignment({
    sessionId: options.sessionId,
    workflowId: options.workflowId,
    adapterId: options.adapterId,
    assignmentId: options.assignmentId,
    workflowCycle: options.workflowCycle,
    moduleAttempt: options.moduleAttempt,
    inheritedWriteScope: options.inheritedWriteScope
  });
  return {
    id: options.assignmentId,
    parentTaskId: options.sessionId,
    workflow: template.workflow,
    ownerType: template.ownerType,
    ownerId: template.ownerId,
    objective: template.objective,
    writeScope: [...template.writeScope],
    requiredOutputs: [...template.requiredOutputs],
    state: template.state,
    createdAt: options.timestamp,
    updatedAt: options.timestamp
  };
}

function createBootstrapStatus(
  host: string,
  adapterId: string,
  assignment: Assignment,
  timestamp: string
): RuntimeStatus {
  return {
    activeMode: "solo",
    currentObjective: `Start plan assignment ${assignment.id}: ${assignment.objective}`,
    activeAssignmentIds: [assignment.id],
    activeHost: host,
    activeAdapter: adapterId,
    lastDurableOutputAt: timestamp,
    resumeReady: true
  };
}

async function loadClaimedArtifact(
  store: WorkflowArtifactStore,
  progress: WorkflowProgressRecord,
  assignmentId: string,
  result: ResultPacket
): Promise<WorkflowClaimedArtifact | undefined> {
  const path = workflowArtifactPath(
    progress.workflowId,
    progress.workflowCycle,
    progress.currentModuleId,
    assignmentId,
    progress.currentModuleAttempt
  );
  const artifact = await store.readJsonArtifact<WorkflowArtifactDocument>(path, "workflow artifact");
  if (!artifact || !isValidWorkflowArtifact(artifact, progress, assignmentId)) {
    return undefined;
  }
  const digest = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
  return {
    reference: {
      path,
      format: "json",
      digest,
      sourceResultId: result.resultId
    },
    document: artifact
  };
}

function isValidWorkflowArtifact(
  artifact: WorkflowArtifactDocument,
  progress: WorkflowProgressRecord,
  assignmentId: string
): boolean {
  return (
    artifact.workflowId === progress.workflowId &&
    artifact.workflowCycle === progress.workflowCycle &&
    artifact.moduleId === progress.currentModuleId &&
    artifact.moduleAttempt === progress.currentModuleAttempt &&
    artifact.assignmentId === assignmentId &&
    typeof artifact.createdAt === "string" &&
    Boolean(artifact.payload) &&
    typeof artifact.payload === "object" &&
    !Array.isArray(artifact.payload)
  );
}

function hasClaimedArtifact(
  currentModule: WorkflowModuleProgressRecord,
  reference: WorkflowArtifactReference,
  sourceResultId: string
): boolean {
  return currentModule.artifactReferences.some(
    (artifact) =>
      artifact.path === reference.path &&
      artifact.format === reference.format &&
      artifact.digest === reference.digest &&
      (artifact.sourceResultId ?? sourceResultId) === sourceResultId
  );
}

function hasEquivalentGate(
  progress: WorkflowProgressRecord,
  assignmentId: string,
  evaluation: {
    gateOutcome: string;
    sourceResultIds: string[];
    sourceDecisionIds: string[];
    evidenceSummary?: string;
    checklistStatus?: string;
    artifactReferences: WorkflowArtifactReference[];
  }
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

function getCurrentAssignment(
  projection: RuntimeProjection,
  progress: WorkflowProgressRecord
): Assignment | undefined {
  return progress.currentAssignmentId
    ? projection.assignments.get(progress.currentAssignmentId)
    : undefined;
}

function currentAttemptStartedAt(progress: WorkflowProgressRecord): string {
  return progress.modules[progress.currentModuleId]?.enteredAt
    ?? progress.lastTransition?.appliedAt
    ?? "";
}

function currentAttemptLowerBound(progress: WorkflowProgressRecord): string {
  return progress.currentModuleAttempt > 1 ? currentAttemptStartedAt(progress) : "";
}

function currentCycleStartedAt(progress: WorkflowProgressRecord): string {
  const entries = Object.values(progress.modules)
    .filter((module) => module.workflowCycle === progress.workflowCycle)
    .map((module) => module.enteredAt)
    .filter((value) => value.length > 0)
    .sort((left, right) => left.localeCompare(right));
  return entries[0] ?? currentAttemptStartedAt(progress);
}

function findLatestTerminalResult(
  projection: RuntimeProjection,
  assignmentId: string,
  attemptLowerBound: string
): ResultPacket | undefined {
  return [...projection.results.values()]
    .filter(
      (result) =>
        result.assignmentId === assignmentId &&
        result.createdAt >= attemptLowerBound &&
        (result.status === "completed" || result.status === "failed")
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
}

function findLatestDecision(
  projection: RuntimeProjection,
  assignmentId: string,
  attemptLowerBound: string,
  state: DecisionPacket["state"]
): DecisionPacket | undefined {
  return [...projection.decisions.values()]
    .filter(
      (decision) =>
        decision.assignmentId === assignmentId &&
        decision.createdAt >= attemptLowerBound &&
        decision.state === state
    )
    .sort((left, right) => {
      const leftTime = state === "resolved" ? left.resolvedAt ?? left.createdAt : left.createdAt;
      const rightTime = state === "resolved" ? right.resolvedAt ?? right.createdAt : right.createdAt;
      return leftTime.localeCompare(rightTime);
    })
    .at(-1);
}
