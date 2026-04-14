import type {
  Assignment,
  DecisionPacket,
  ResultPacket,
  RuntimeStatus,
  WorkflowArtifactReference,
  WorkflowChecklistStatus,
  WorkflowGateOutcome,
  WorkflowModuleState,
  WorkflowTransitionType
} from "./types.js";

export interface EventEnvelope<Type extends string, Payload> {
  eventId: string;
  sessionId: string;
  timestamp: string;
  type: Type;
  payload: Payload;
}

export type RuntimeEvent =
  | EventEnvelope<"assignment.created", { assignment: Assignment }>
  | EventEnvelope<"assignment.updated", { assignmentId: string; patch: Partial<Assignment> }>
  | EventEnvelope<"result.submitted", { result: ResultPacket }>
  | EventEnvelope<"decision.created", { decision: DecisionPacket }>
  | EventEnvelope<
      "decision.resolved",
      { decisionId: string; resolvedAt: string; resolutionSummary: string }
    >
  | EventEnvelope<
      "workflow.initialized",
      {
        workflowId: string;
        orderedModuleIds: string[];
        currentModuleId: string;
        workflowCycle: number;
        currentModuleAttempt: number;
        currentAssignmentId: string;
        initializedAt: string;
      }
    >
  | EventEnvelope<
      "workflow.artifact.claimed",
      {
        workflowId: string;
        workflowCycle: number;
        moduleId: string;
        moduleAttempt: number;
        assignmentId: string;
        artifactPath: string;
        artifactFormat: "json";
        artifactDigest: string;
        sourceResultId: string;
        claimedAt: string;
      }
    >
  | EventEnvelope<
      "workflow.gate.recorded",
      {
        workflowId: string;
        workflowCycle: number;
        moduleId: string;
        moduleAttempt: number;
        assignmentId: string;
        moduleState: WorkflowModuleState;
        gateOutcome: WorkflowGateOutcome;
        checklistStatus?: WorkflowChecklistStatus;
        evidenceSummary?: string;
        sourceResultIds: string[];
        sourceDecisionIds: string[];
        artifactReferences: WorkflowArtifactReference[];
        evaluatedAt: string;
      }
    >
  | EventEnvelope<
      "workflow.transition.applied",
      {
        workflowId: string;
        fromModuleId: string;
        toModuleId: string;
        workflowCycle: number;
        moduleAttempt: number;
        transition: WorkflowTransitionType;
        previousAssignmentId: string | null;
        nextAssignmentId: string | null;
        appliedAt: string;
      }
    >
  | EventEnvelope<"status.updated", { status: RuntimeStatus }>;
