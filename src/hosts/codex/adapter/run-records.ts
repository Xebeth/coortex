import type { HostRunArtifactInspection } from "../../../adapters/host-run-store.js";
import { materializeInspectableRunRecord as materializeInspectableHostRunRecord } from "../../../adapters/host-run-inspection.js";
import type { HostRunRecord } from "../../../core/types.js";
import { nowIso } from "../../../utils/time.js";
import { parseJson } from "../../../utils/json.js";
import type { RuntimeArtifactStore } from "../../../adapters/contract.js";

export function buildRunRecord(
  outcome: Pick<import("../../../adapters/contract.js").HostExecutionOutcome, "outcome">,
  assignmentId: string,
  startedAt: string,
  completedAt: string,
  nativeRunId?: string
): HostRunRecord {
  if (outcome.outcome.kind === "decision") {
    return {
      assignmentId,
      state: "completed",
      startedAt,
      completedAt,
      outcomeKind: "decision",
      summary: outcome.outcome.capture.blockerSummary,
      ...(nativeRunId ? { adapterData: { nativeRunId } } : {})
    };
  }

  return {
    assignmentId,
    state: "completed",
    startedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus: outcome.outcome.capture.status,
    summary: outcome.outcome.capture.summary,
    ...(nativeRunId ? { adapterData: { nativeRunId } } : {})
  };
}

export function createRunningRecord(
  assignmentId: string,
  startedAt: string,
  leaseMs: number,
  nativeRunId?: string
): HostRunRecord {
  return {
    assignmentId,
    state: "running",
    startedAt,
    heartbeatAt: startedAt,
    leaseExpiresAt: new Date(Date.parse(startedAt) + leaseMs).toISOString(),
    ...(nativeRunId ? { adapterData: { nativeRunId } } : {})
  };
}

export function withNativeRunId(record: HostRunRecord, nativeRunId: string): HostRunRecord {
  return {
    ...record,
    adapterData: {
      ...(record.adapterData ?? {}),
      nativeRunId
    }
  };
}

export function parseExecJsonl(stdout: string): {
  threadId?: string;
  errorMessage?: string;
  usage?: import("../../../adapters/contract.js").HostTelemetryCapture["usage"];
  lastAgentMessage?: string;
} {
  let threadId: string | undefined;
  let errorMessage: string | undefined;
  let usage: import("../../../adapters/contract.js").HostTelemetryCapture["usage"];
  let lastAgentMessage: string | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        threadId = event.thread_id;
      }
      if (event.type === "error" && typeof event.message === "string") {
        errorMessage = event.message;
      }
      if (
        event.type === "turn.completed" &&
        event.usage &&
        typeof event.usage === "object" &&
        !Array.isArray(event.usage)
      ) {
        const value = event.usage as Record<string, unknown>;
        usage = {
          ...(typeof value.input_tokens === "number" ? { inputTokens: value.input_tokens } : {}),
          ...(typeof value.output_tokens === "number"
            ? { outputTokens: value.output_tokens }
            : {}),
          ...(typeof value.cached_input_tokens === "number"
            ? { cachedTokens: value.cached_input_tokens }
            : {}),
          ...(typeof value.reasoning_tokens === "number"
            ? { reasoningTokens: value.reasoning_tokens }
            : {}),
          ...(typeof value.input_tokens === "number" && typeof value.output_tokens === "number"
            ? { totalTokens: value.input_tokens + value.output_tokens }
            : {})
        };
      }
      if (
        event.type === "item.completed" &&
        event.item &&
        typeof event.item === "object" &&
        !Array.isArray(event.item)
      ) {
        const item = event.item as Record<string, unknown>;
        if (item.type === "agent_message" && typeof item.text === "string" && item.text.length > 0) {
          lastAgentMessage = item.text;
        }
      }
    } catch {
      continue;
    }
  }

  return {
    ...(threadId ? { threadId } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(usage ? { usage } : {}),
    ...(lastAgentMessage ? { lastAgentMessage } : {})
  };
}

export async function readLeaseRecord(
  store: RuntimeArtifactStore,
  relativePath: string,
  absolutePath: string,
  assignmentId: string
): Promise<HostRunRecord | undefined> {
  try {
    return await store.readJsonArtifact<HostRunRecord>(relativePath, "codex run lease");
  } catch {
    const content = await readLeaseContentOrUndefined(absolutePath);
    if (content === undefined) {
      return undefined;
    }
    try {
      return parseJson<HostRunRecord>(content, "codex run lease");
    } catch {
      await store.deleteArtifact(relativePath);
      return {
        assignmentId,
        state: "running",
        startedAt: nowIso(),
        staleReasonCode: "malformed_lease_artifact",
        staleReason: "malformed lease file"
      };
    }
  }
}

export function materializeInspectableRunRecord(
  inspection: HostRunArtifactInspection | undefined
): HostRunRecord | undefined {
  return materializeInspectableHostRunRecord(inspection, {
    includeMalformedLeaseRecord: true
  });
}

async function readLeaseContentOrUndefined(path: string): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
