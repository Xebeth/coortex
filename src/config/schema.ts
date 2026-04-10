import type { RuntimeConfig } from "./types.js";

export function validateRuntimeConfig(value: unknown): RuntimeConfig {
  const record = asRecord(value, "runtime config");

  if (record.version !== 1) {
    throw new Error("Runtime config must use schema version 1.");
  }

  const codexDangerouslyBypassApprovalsAndSandbox = readBoolean(
    record,
    "codexDangerouslyBypassApprovalsAndSandbox",
    "runtime config"
  );

  return {
    version: 1,
    sessionId: readString(record, "sessionId", "runtime config"),
    adapter: readString(record, "adapter", "runtime config"),
    host: readString(record, "host", "runtime config"),
    rootPath: readString(record, "rootPath", "runtime config"),
    createdAt: readString(record, "createdAt", "runtime config"),
    ...(codexDangerouslyBypassApprovalsAndSandbox === undefined
      ? {}
      : { codexDangerouslyBypassApprovalsAndSandbox })
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function readString(
  value: Record<string, unknown>,
  key: string,
  label: string
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Invalid ${label}: ${key} must be a non-empty string.`);
  }
  return field;
}

function readBoolean(
  value: Record<string, unknown>,
  key: string,
  label: string
): boolean | undefined {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }
  if (typeof field !== "boolean") {
    throw new Error(`Invalid ${label}: ${key} must be a boolean when provided.`);
  }
  return field;
}
