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
  lastStaleRunInstanceId?: string | undefined;
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
  lastStaleRunInstanceId?: string | undefined;
}

export type AttachmentState =
  | "provisional"
  | "attached"
  | "detached_resumable"
  | "released"
  | "orphaned";

export type RuntimeAuthorityProvenance =
  | {
      kind: "launch";
      source: "ctx.run";
    }
  | {
      kind: "resume";
      source: "ctx.resume";
    }
  | {
      kind: "recovery";
      source: "recovery.reconcile";
    };

export interface RuntimeAttachment {
  id: string;
  adapter: string;
  host: string;
  state: AttachmentState;
  createdAt: string;
  updatedAt: string;
  provenance: RuntimeAuthorityProvenance;
  nativeSessionId?: string;
  attachedAt?: string;
  detachedAt?: string;
  releasedAt?: string;
  releasedReason?: string;
  orphanedAt?: string;
  orphanedReason?: string;
  adapterMetadata?: Record<string, unknown>;
}

export function hasStoredNativeSessionId(
  attachment: Pick<RuntimeAttachment, "nativeSessionId">
): boolean {
  return (
    typeof attachment.nativeSessionId === "string" &&
    attachment.nativeSessionId.length > 0
  );
}

export function isWrappedResumeCapableAttachment(
  attachment: Pick<RuntimeAttachment, "state" | "nativeSessionId">
): boolean {
  return (
    (attachment.state === "attached" || attachment.state === "detached_resumable") &&
    hasStoredNativeSessionId(attachment)
  );
}

export type AssignmentClaimState = "active" | "released" | "orphaned";

export interface AssignmentClaim {
  id: string;
  assignmentId: string;
  attachmentId: string;
  state: AssignmentClaimState;
  createdAt: string;
  updatedAt: string;
  provenance: RuntimeAuthorityProvenance;
  releasedAt?: string;
  releasedReason?: string;
  orphanedAt?: string;
  orphanedReason?: string;
}

export interface RuntimeProvenance {
  initializedAt?: string;
  hostSetupAt?: string;
  lastActivation?: {
    kind: "launch" | "resume";
    attachmentId: string;
    assignmentId: string;
    at: string;
  };
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
  startedAt: string;
  runInstanceId?: string;
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
          resolvedAt?: string;
          resolutionSummary?: string;
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
  attachments?: RuntimeAttachment[];
  claims?: AssignmentClaim[];
  provenance?: RuntimeProvenance;
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
  attachments: Map<string, RuntimeAttachment>;
  claims: Map<string, AssignmentClaim>;
  provenance: RuntimeProvenance;
  lastEventId?: string;
}
