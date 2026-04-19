import type { HostAdapter, HostTelemetryCapture } from "../adapters/contract.js";
import { RuntimeStore } from "../persistence/store.js";
import { recordNormalizedTelemetry } from "../telemetry/recorder.js";

import type { CommandDiagnostic } from "./types.js";

export function diagnosticsFromWarning(
  warning: string | undefined,
  code: CommandDiagnostic["code"]
): CommandDiagnostic[] {
  return warning ? [{ level: "warning", code, message: warning }] : [];
}

export async function recordTelemetryWarningDiagnostics(
  store: RuntimeStore,
  adapter: HostAdapter,
  capture: HostTelemetryCapture
): Promise<CommandDiagnostic[]> {
  const telemetry = await recordNormalizedTelemetry(
    store,
    adapter.normalizeTelemetry(capture)
  );
  return diagnosticsFromWarning(telemetry.warning, "telemetry-write-failed");
}

export function hostRunPersistDiagnostics(
  assignmentId: string,
  cleanupError: Error
): CommandDiagnostic[] {
  return diagnosticsFromWarning(
    `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
    "host-run-persist-failed"
  );
}

export async function syncProjectionWithDiagnostics(
  store: RuntimeStore
): Promise<{
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>;
  diagnostics: CommandDiagnostic[];
}> {
  const synced = await store.syncSnapshotFromEventsWithRecovery();
  return {
    projection: synced.projection,
    diagnostics: diagnosticsFromWarning(synced.warning, "event-log-repaired")
  };
}
