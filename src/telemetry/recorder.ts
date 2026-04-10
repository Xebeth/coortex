import type { RuntimeStore } from "../persistence/store.js";
import type { TelemetryEvent } from "./types.js";
import { nowIso } from "../utils/time.js";

export interface TelemetryRecordResult {
  event: TelemetryEvent;
  warning?: string;
}

export interface RecordTelemetryInput {
  store: RuntimeStore;
  eventType: string;
  taskId: string;
  assignmentId?: string;
  host: string;
  adapter: string;
  metadata: Record<string, unknown>;
}

export async function recordTelemetry(input: RecordTelemetryInput): Promise<TelemetryRecordResult> {
  const event: TelemetryEvent = {
    timestamp: nowIso(),
    eventType: input.eventType,
    taskId: input.taskId,
    host: input.host,
    adapter: input.adapter,
    metadata: input.metadata
  };
  if (input.assignmentId) {
    event.assignmentId = input.assignmentId;
  }
  const warning = await appendTelemetryBestEffort(input.store, event);
  return warning ? { event, warning } : { event };
}

export async function recordNormalizedTelemetry(
  store: RuntimeStore,
  event: Omit<TelemetryEvent, "timestamp">
): Promise<TelemetryRecordResult> {
  const normalized: TelemetryEvent = {
    timestamp: nowIso(),
    ...event
  };
  const warning = await appendTelemetryBestEffort(store, normalized);
  return warning ? { event: normalized, warning } : { event: normalized };
}

async function appendTelemetryBestEffort(
  store: RuntimeStore,
  event: TelemetryEvent
): Promise<string | undefined> {
  try {
    await store.appendTelemetry(event);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Telemetry append failed for ${event.eventType}: ${message}`;
  }
}
