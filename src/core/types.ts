export type AssignmentState = "queued" | "in_progress" | "blocked" | "completed" | "failed";

export interface Assignment {
  id: string;
  parentTaskId: string;
  workflow: string;
  ownerType: string;
  ownerId: string;
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

export interface RuntimeSnapshot {
  version: 1;
  sessionId: string;
  rootPath: string;
  adapter: string;
  status: RuntimeStatus;
  assignments: Assignment[];
  results: ResultPacket[];
  decisions: DecisionPacket[];
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
  lastEventId?: string;
}
