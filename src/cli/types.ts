export interface CommandDiagnostic {
  level: "warning";
  code:
    | "event-log-salvaged"
    | "event-log-repaired"
    | "telemetry-write-failed"
    | "host-run-persist-failed"
    | "active-run-present"
    | "stale-run-reconciled";
  message: string;
}
