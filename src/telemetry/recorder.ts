import type { RuntimeStore } from "../persistence/store.js";
import type { TelemetryEvent } from "./types.js";
import { nowIso } from "../utils/time.js";

export interface RecordTelemetryInput {
  store: RuntimeStore;
  eventType: string;
  taskId: string;
  assignmentId?: string;
  host: string;
  adapter: string;
  metadata: Record<string, unknown>;
}

export async function recordTelemetry(input: RecordTelemetryInput): Promise<TelemetryEvent> {
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
  await input.store.appendTelemetry(event);
  return event;
}
