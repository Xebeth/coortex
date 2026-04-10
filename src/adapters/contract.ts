import type { RecoveryBrief, RuntimeProjection } from "../core/types.js";
import type { DecisionPacket, ResultPacket } from "../core/types.js";
import type { TelemetryEvent } from "../telemetry/types.js";

export interface RuntimeArtifactStore {
  readonly rootDir: string;
  readonly runtimeDir: string;
  readonly adaptersDir: string;
  readJsonArtifact<T>(relativePath: string, label: string): Promise<T | undefined>;
  writeJsonArtifact(relativePath: string, value: unknown): Promise<string>;
  writeTextArtifact(relativePath: string, content: string): Promise<string>;
}

export interface AdapterCapabilities {
  supportsProfiles: boolean;
  supportsHooks: boolean;
  supportsResume: boolean;
  supportsFork: boolean;
  supportsExactUsage: boolean;
  supportsCompactionHooks: boolean;
  supportsMcp: boolean;
  supportsPlugins: boolean;
  supportsPermissionsModel: boolean;
}

export interface TrimmedField {
  label: string;
  originalChars: number;
  keptChars: number;
  reference: string;
}

export interface TaskEnvelope {
  host: string;
  adapter: string;
  objective: string;
  writeScope: string[];
  requiredOutputs: string[];
  recoveryBrief: RecoveryBrief;
  recentResults: Array<{
    resultId: string;
    summary: string;
    trimmed: boolean;
    reference?: string;
  }>;
  metadata: Record<string, unknown>;
  estimatedChars: number;
  trimApplied: boolean;
  trimmedFields: TrimmedField[];
}

export interface DoctorCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface HostResultCapture {
  assignmentId: string;
  producerId: string;
  status: ResultPacket["status"];
  summary: string;
  changedFiles: string[];
  createdAt?: string;
  resultId?: string;
}

export interface HostDecisionCapture {
  assignmentId: string;
  requesterId: string;
  blockerSummary: string;
  options: DecisionPacket["options"];
  recommendedOption: string;
  state?: DecisionPacket["state"];
  createdAt?: string;
  decisionId?: string;
}

export interface HostTelemetryCapture {
  eventType: string;
  taskId: string;
  assignmentId?: string;
  metadata: Record<string, unknown>;
  usage?: Pick<
    TelemetryEvent,
    "inputTokens" | "outputTokens" | "totalTokens" | "cachedTokens" | "reasoningTokens"
  >;
}

export interface HostRunRecord {
  assignmentId: string;
  state: "running" | "completed";
  hostRunId?: string;
  startedAt: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  staleAt?: string;
  staleReason?: string;
  completedAt?: string;
  outcomeKind?: "result" | "decision";
  resultStatus?: ResultPacket["status"];
  summary?: string;
}

export interface HostExecutionOutcome {
  outcome:
    | { kind: "result"; capture: HostResultCapture }
    | { kind: "decision"; capture: HostDecisionCapture };
  run: HostRunRecord;
  telemetry?: HostTelemetryCapture;
}

export interface HostAdapter {
  readonly id: string;
  readonly host: string;

  getCapabilities(): AdapterCapabilities;
  initialize(store: RuntimeArtifactStore, projection: RuntimeProjection): Promise<void>;
  doctor(store: RuntimeArtifactStore): Promise<DoctorCheck[]>;
  buildResumeEnvelope(
    store: RuntimeArtifactStore,
    projection: RuntimeProjection,
    brief: RecoveryBrief
  ): Promise<TaskEnvelope>;
  executeAssignment(
    store: RuntimeArtifactStore,
    projection: RuntimeProjection,
    envelope: TaskEnvelope
  ): Promise<HostExecutionOutcome>;
  cancelActiveRun?(signal?: "graceful" | "force"): Promise<void>;
  inspectRun(store: RuntimeArtifactStore, assignmentId?: string): Promise<HostRunRecord | undefined>;
  normalizeResult(capture: HostResultCapture): ResultPacket;
  normalizeDecision(capture: HostDecisionCapture): DecisionPacket;
  normalizeTelemetry(capture: HostTelemetryCapture): Omit<TelemetryEvent, "timestamp">;
}
