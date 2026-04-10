import { RuntimeStore } from "../persistence/store.js";

import type { CommandDiagnostic } from "./types.js";

export async function loadOperatorProjection(store: RuntimeStore) {
  return (await loadOperatorProjectionWithDiagnostics(store)).projection;
}

export async function loadOperatorProjectionWithDiagnostics(store: RuntimeStore): Promise<{
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>;
  diagnostics: CommandDiagnostic[];
}> {
  const { projection, warning } = await store.loadProjectionWithRecovery();
  return {
    projection,
    diagnostics: diagnosticsFromWarning(warning, "event-log-salvaged")
  };
}

export function diagnosticsFromWarning(
  warning: string | undefined,
  code: CommandDiagnostic["code"]
): CommandDiagnostic[] {
  return warning ? [{ level: "warning", code, message: warning }] : [];
}
