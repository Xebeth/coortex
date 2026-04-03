import type { Assignment, DecisionPacket, ResultPacket, RuntimeStatus } from "./types.js";

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
  | EventEnvelope<"status.updated", { status: RuntimeStatus }>;
