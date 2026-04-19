export type AssignmentState = "queued" | "in_progress" | "blocked" | "completed" | "failed";
export type WorkflowModuleState = "queued" | "in_progress" | "blocked" | "completed";
export type WorkflowGateOutcome =
  | "ready_for_review"
  | "approved"
  | "needs_iteration"
  | "rejected"
  | "verified"
  | "failed"
  | "blocked";
export type WorkflowChecklistStatus = "complete" | "incomplete";
export type WorkflowTransitionType = "advance" | "rewind" | "rerun_same_module" | "complete";

export interface WorkflowArtifactReference {
  path: string;
  format: "json" | "text";
  digest?: string;
  sourceResultId?: string;
}

export interface WorkflowModuleProgressRecord {
  moduleId: string;
  workflowCycle: number;
  moduleAttempt: number;
  assignmentId: string | null;
  moduleState: WorkflowModuleState;
  gateOutcome?: WorkflowGateOutcome;
  sourceResultIds: string[];
  sourceDecisionIds: string[];
  evidenceSummary?: string;
  checklistStatus?: WorkflowChecklistStatus;
  artifactReferences: WorkflowArtifactReference[];
  enteredAt: string;
  evaluatedAt?: string;
}

export interface WorkflowLastGateRecord {
  moduleId: string;
  workflowCycle: number;
  moduleAttempt: number;
  assignmentId: string;
  gateOutcome: WorkflowGateOutcome;
  sourceResultIds: string[];
  sourceDecisionIds: string[];
  evidenceSummary?: string;
  checklistStatus?: WorkflowChecklistStatus;
  artifactReferences: WorkflowArtifactReference[];
  evaluatedAt: string;
}

export interface WorkflowTransitionRecord {
  fromModuleId: string;
  toModuleId: string;
  workflowCycle: number;
  moduleAttempt: number;
  transition: WorkflowTransitionType;
  previousAssignmentId: string | null;
  nextAssignmentId: string | null;
  appliedAt: string;
}

export interface WorkflowProgressRecord {
  workflowId: string;
  orderedModuleIds: string[];
  currentModuleId: string;
  workflowCycle: number;
  currentAssignmentId: string | null;
  currentModuleAttempt: number;
  modules: Record<string, WorkflowModuleProgressRecord>;
  lastGate?: WorkflowLastGateRecord;
  lastTransition?: WorkflowTransitionRecord;
}

export interface WorkflowSummary {
  id: string;
  currentModuleId: string;
  currentModuleState: WorkflowModuleState;
  workflowCycle: number;
  currentAssignmentId: string | null;
  outputArtifact: string | null;
  readArtifacts: string[];
  rerunEligible: boolean;
  blockerReason: string | null;
  lastGateOutcome: WorkflowGateOutcome | null;
  lastDurableAdvancement: string | null;
}

export interface WorkflowRunAttemptIdentity {
  workflowId: string;
  workflowCycle: number;
  moduleId: string;
  moduleAttempt: number;
}

export interface Assignment {
  id: string;
  parentTaskId: string;
  workflow: string;
  ownerType: string;
  ownerId: string;
  workflowAttempt?: WorkflowRunAttemptIdentity;
  objective: string;
  writeScope: string[];
  requiredOutputs: string[];
  state: AssignmentState;
  createdAt: string;
  updatedAt: string;
}

export interface ResultPacket {
  resultId: string;
  assignmentId: string;
  producerId: string;
  status: "partial" | "completed" | "failed";
  summary: string;
  changedFiles: string[];
  createdAt: string;
}

export interface DecisionOption {
  id: string;
  label: string;
  summary: string;
}

export interface DecisionPacket {
  decisionId: string;
  assignmentId: string;
  requesterId: string;
  blockerSummary: string;
  options: DecisionOption[];
  recommendedOption: string;
  state: "open" | "resolved";
  createdAt: string;
  resolvedAt?: string;
  resolutionSummary?: string;
}

export interface RuntimeStatus {
  activeMode: string;
  currentObjective: string;
  activeAssignmentIds: string[];
  activeHost: string;
  activeAdapter: string;
  lastDurableOutputAt: string;
  resumeReady: boolean;
}

export interface RecoveryBrief {
  activeObjective: string;
  activeAssignments: Array<{
    id: string;
    objective: string;
    state: AssignmentState;
    writeScope: string[];
    requiredOutputs: string[];
  }>;
  lastDurableResults: Array<{
    resultId: string;
    assignmentId: string;
    status: ResultPacket["status"];
    summary: string;
    changedFiles: string[];
    createdAt: string;
    trimmed?: boolean;
    reference?: string;
  }>;
  unresolvedDecisions: Array<{
    decisionId: string;
    assignmentId: string;
    blockerSummary: string;
    recommendedOption: string;
    trimmed?: boolean;
    reference?: string;
  }>;
  nextRequiredAction: string;
  generatedAt: string;
}

export interface HostRunRecord {
  assignmentId: string;
  state: "running" | "completed";
  workflowAttempt?: WorkflowRunAttemptIdentity;
  startedAt: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  staleAt?: string;
  staleReasonCode?:
    | "missing_lease_expiry"
    | "missing_lease_artifact"
    | "invalid_lease_expiry"
    | "expired_lease"
    | "malformed_lease_artifact";
  staleReason?: string;
  completedAt?: string;
  outcomeKind?: "result" | "decision";
  resultStatus?: ResultPacket["status"];
  summary?: string;
  terminalOutcome?:
    | {
        kind: "result";
        result: {
          resultId?: string;
          producerId: string;
          status: ResultPacket["status"];
          summary: string;
          changedFiles: string[];
          createdAt: string;
        };
      }
    | {
        kind: "decision";
        decision: {
          decisionId?: string;
          requesterId: string;
          blockerSummary: string;
          options: DecisionOption[];
          recommendedOption: string;
          state: DecisionPacket["state"];
          createdAt: string;
        };
      };
  adapterData?: Record<string, unknown>;
}

export interface RuntimeSnapshot {
  version: 1;
  sessionId: string;
  rootPath: string;
  adapter: string;
  status: RuntimeStatus;
  assignments: Assignment[];
  results: ResultPacket[];
  decisions: DecisionPacket[];
  workflowProgress?: WorkflowProgressRecord;
  lastEventId?: string;
}

export interface RuntimeProjection {
  sessionId: string;
  rootPath: string;
  adapter: string;
  status: RuntimeStatus;
  assignments: Map<string, Assignment>;
  results: Map<string, ResultPacket>;
  decisions: Map<string, DecisionPacket>;
  workflowProgress?: WorkflowProgressRecord;
  lastEventId?: string;
}
