import { RuntimeStore } from "../persistence/store.js";

import type { CommandDiagnostic } from "./types.js";

export async function loadOperatorProjection(store: RuntimeStore) {
  return (await loadOperatorProjectionWithDiagnostics(store)).projection;
}

export async function loadOperatorProjectionWithDiagnostics(store: RuntimeStore): Promise<{
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>;
  diagnostics: CommandDiagnostic[];
  snapshotFallback: boolean;
}> {
  const { projection, warning, snapshotFallback } = await store.loadProjectionWithRecovery();
  return {
    projection,
    diagnostics: diagnosticsFromWarning(warning, "event-log-salvaged"),
    snapshotFallback
  };
}

export function diagnosticsFromWarning(
  warning: string | undefined,
  code: CommandDiagnostic["code"]
): CommandDiagnostic[] {
  return warning ? [{ level: "warning", code, message: warning }] : [];
}
