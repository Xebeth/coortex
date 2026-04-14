export interface CommandDiagnostic {
  level: "warning";
  code:
    | "event-log-salvaged"
    | "event-log-repaired"
    | "telemetry-write-failed"
    | "host-run-persist-failed"
    | "active-run-present"
    | "hidden-run-cleaned"
    | "stale-run-reconciled"
    | "completed-run-reconciled";
  message: string;
}
