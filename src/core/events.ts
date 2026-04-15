import type {
  Assignment,
  AssignmentClaim,
  DecisionPacket,
  ResultPacket,
  RuntimeAttachment,
  RuntimeStatus
} from "./types.js";

export interface EventEnvelope<Type extends string, Payload> {
  eventId: string;
  sessionId: string;
  timestamp: string;
  type: Type;
  payload: Payload;
}

export type RuntimeEvent =
  | EventEnvelope<
      "runtime.initialized",
      { rootPath: string; adapter: string; host: string; initializedAt: string }
    >
  | EventEnvelope<"host.setup.completed", { adapter: string; host: string; completedAt: string }>
  | EventEnvelope<
      "runtime.activated",
      { kind: "launch" | "resume"; attachmentId: string; assignmentId: string }
    >
  | EventEnvelope<"assignment.created", { assignment: Assignment }>
  | EventEnvelope<"assignment.updated", { assignmentId: string; patch: Partial<Assignment> }>
  | EventEnvelope<"result.submitted", { result: ResultPacket }>
  | EventEnvelope<"decision.created", { decision: DecisionPacket }>
  | EventEnvelope<
      "decision.resolved",
      { decisionId: string; resolvedAt: string; resolutionSummary: string }
    >
  | EventEnvelope<"attachment.created", { attachment: RuntimeAttachment }>
  | EventEnvelope<"attachment.updated", { attachmentId: string; patch: Partial<RuntimeAttachment> }>
  | EventEnvelope<"claim.created", { claim: AssignmentClaim }>
  | EventEnvelope<"claim.updated", { claimId: string; patch: Partial<AssignmentClaim> }>
  | EventEnvelope<"status.updated", { status: RuntimeStatus }>;
