import type { RecoveryBrief, RuntimeProjection } from "./types.js";
import type { RuntimeStore } from "../persistence/store.js";

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

export interface HostAdapter {
  readonly id: string;
  readonly host: string;

  getCapabilities(): AdapterCapabilities;
  initialize(store: RuntimeStore, projection: RuntimeProjection): Promise<void>;
  doctor(store: RuntimeStore): Promise<DoctorCheck[]>;
  buildResumeEnvelope(projection: RuntimeProjection, brief: RecoveryBrief): TaskEnvelope;
}
