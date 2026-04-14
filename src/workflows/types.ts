import type {
  Assignment,
  ResultPacket,
  RuntimeProjection,
  WorkflowArtifactReference,
  WorkflowChecklistStatus,
  WorkflowGateOutcome,
  WorkflowModuleProgressRecord,
  WorkflowProgressRecord,
  WorkflowSummary,
  WorkflowTransitionType
} from "../core/types.js";

export interface WorkflowArtifactStore {
  readJsonArtifact<T>(relativePath: string, label: string): Promise<T | undefined>;
}

export interface WorkflowArtifactDocument {
  workflowId: string;
  workflowCycle: number;
  moduleId: string;
  moduleAttempt: number;
  assignmentId: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface WorkflowAssignmentContext {
  sessionId: string;
  workflowId: string;
  adapterId: string;
  assignmentId: string;
  workflowCycle: number;
  moduleAttempt: number;
  inheritedWriteScope: string[];
}

export interface WorkflowClaimedArtifact {
  reference: WorkflowArtifactReference;
  document: WorkflowArtifactDocument;
}

export interface WorkflowEvaluationContext {
  projection: RuntimeProjection;
  progress: WorkflowProgressRecord;
  currentModule: WorkflowModuleProgressRecord;
  assignment: Assignment;
  result: ResultPacket;
  artifact: WorkflowClaimedArtifact | undefined;
  currentCycleStartAt: string;
}

export interface WorkflowTransitionIntent {
  type: WorkflowTransitionType;
  toModuleId: string;
  workflowCycle: number;
}

export interface WorkflowGateEvaluation {
  gateOutcome: WorkflowGateOutcome;
  checklistStatus?: WorkflowChecklistStatus;
  evidenceSummary?: string;
  sourceResultIds: string[];
  sourceDecisionIds: string[];
  artifactReferences: WorkflowArtifactReference[];
  transition: WorkflowTransitionIntent;
}

export interface WorkflowModuleDefinition {
  readonly id: string;
  createAssignment(context: WorkflowAssignmentContext): Pick<
    Assignment,
    "workflow" | "ownerType" | "ownerId" | "objective" | "writeScope" | "requiredOutputs" | "state"
  >;
  getReadArtifacts(progress: WorkflowProgressRecord): string[];
  evaluateGate(context: WorkflowEvaluationContext): WorkflowGateEvaluation;
}

export interface WorkflowProgressionResult {
  events: import("../core/events.js").RuntimeEvent[];
}

export interface WorkflowInspectPayload {
  workflow: WorkflowSummary | null;
  assignment: Pick<Assignment, "id" | "state" | "workflow" | "objective"> | null;
  run: unknown;
}
