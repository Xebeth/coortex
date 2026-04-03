export interface TelemetryEvent {
  timestamp: string;
  eventType: string;
  taskId: string;
  assignmentId?: string;
  host: string;
  adapter: string;
  metadata: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}
