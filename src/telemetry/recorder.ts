import type { TelemetryEvent } from "./types.js";
import { nowIso } from "../utils/time.js";

export interface TelemetrySink {
  appendTelemetry(event: TelemetryEvent): Promise<void>;
}

export interface TelemetryRecordResult {
  event: TelemetryEvent;
  warning?: string;
}

export interface RecordTelemetryInput {
  store: TelemetrySink;
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
  store: TelemetrySink,
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
  store: TelemetrySink,
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
