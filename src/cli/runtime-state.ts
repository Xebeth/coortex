import { RuntimeStore } from "../persistence/store.js";

import type { CommandDiagnostic } from "./types.js";

type DiagnosticsBearingError = Error & {
  diagnostics?: CommandDiagnostic[];
};

type ProjectionRecoveryWarningBearingError = Error & {
  projectionRecoveryWarning?: string;
};

export async function loadOperatorProjection(store: RuntimeStore) {
  return (await loadOperatorProjectionWithDiagnostics(store)).projection;
}

export async function loadOperatorProjectionWithDiagnostics(store: RuntimeStore): Promise<{
  projection: Awaited<ReturnType<RuntimeStore["loadProjection"]>>;
  diagnostics: CommandDiagnostic[];
  snapshotFallback: boolean;
}> {
  try {
    const { projection, warning, snapshotFallback } = await store.loadProjectionWithRecovery();
    return {
      projection,
      diagnostics: diagnosticsFromWarning(warning, "event-log-salvaged"),
      snapshotFallback
    };
  } catch (error) {
    const diagnostics = diagnosticsFromWarning(
      (error as ProjectionRecoveryWarningBearingError).projectionRecoveryWarning,
      "event-log-salvaged"
    );
    if (diagnostics.length === 0) {
      throw error;
    }
    throw attachDiagnostics(error, diagnostics);
  }
}

export function diagnosticsFromWarning(
  warning: string | undefined,
  code: CommandDiagnostic["code"]
): CommandDiagnostic[] {
  return warning ? [{ level: "warning", code, message: warning }] : [];
}

function attachDiagnostics(error: unknown, diagnostics: CommandDiagnostic[]): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const existingDiagnostics = (normalized as DiagnosticsBearingError).diagnostics ?? [];
  (normalized as DiagnosticsBearingError).diagnostics = [
    ...diagnostics,
    ...existingDiagnostics.filter(
      (existingDiagnostic) =>
        !diagnostics.some(
          (diagnostic) =>
            diagnostic.level === existingDiagnostic.level &&
            diagnostic.code === existingDiagnostic.code &&
            diagnostic.message === existingDiagnostic.message
        )
    )
  ];
  return normalized;
}
