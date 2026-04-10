import { randomUUID } from "node:crypto";

import type { RuntimeEvent } from "../core/events.js";
import type { HostRunRecord, RuntimeProjection } from "../core/types.js";
import { nowIso } from "../utils/time.js";

export interface RecoveryDiagnostic {
  level: "warning";
  code: "active-run-present" | "stale-run-reconciled";
  message: string;
}

export interface StaleRunReconciliation {
  staleRecord: HostRunRecord;
  events: RuntimeEvent[];
  diagnostic: RecoveryDiagnostic;
  telemetryMetadata: {
    hostRunId: string;
    leaseExpiresAt: string;
    heartbeatAt: string;
    staleAt: string;
  };
}

export function selectRunnableProjection(
  projection: RuntimeProjection,
  assignmentId: string
): RuntimeProjection {
  return {
    ...projection,
    status: {
      ...projection.status,
      currentObjective:
        projection.assignments.get(assignmentId)?.objective ?? projection.status.currentObjective,
      activeAssignmentIds: [assignmentId]
    },
    decisions: new Map(
      [...projection.decisions.entries()].filter(([, decision]) => decision.assignmentId === assignmentId)
    )
  };
}

export function createActiveRunDiagnostic(
  assignmentId: string,
  record: HostRunRecord
): RecoveryDiagnostic {
  return {
    level: "warning",
    code: "active-run-present",
    message: `Assignment ${assignmentId} still has an active host run lease${
      record.hostRunId ? ` (${record.hostRunId})` : ""
    }.`
  };
}

export function buildStaleRunReconciliation(
  projection: RuntimeProjection,
  assignmentId: string,
  record: HostRunRecord,
  timestamp = nowIso()
): StaleRunReconciliation {
  const staleRecord: HostRunRecord = {
    ...record,
    state: "completed",
    staleAt: timestamp,
    staleReason: describeStaleRunReason(record)
  };
  const assignment = projection.assignments.get(assignmentId);
  const objective = assignment?.objective ?? projection.status.currentObjective;
  const events: RuntimeEvent[] = [
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "assignment.updated",
      payload: {
        assignmentId,
        patch: {
          state: "queued",
          updatedAt: timestamp
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "status.updated",
      payload: {
        status: {
          ...projection.status,
          currentObjective: `Retry assignment ${assignmentId}: ${objective}`,
          lastDurableOutputAt: timestamp,
          resumeReady: true
        }
      }
    }
  ];

  return {
    staleRecord,
    events,
    diagnostic: {
      level: "warning",
      code: "stale-run-reconciled",
      message: `Requeued stale host run for assignment ${assignmentId}${
        record.hostRunId ? ` (${record.hostRunId})` : ""
      }.`
    },
    telemetryMetadata: {
      hostRunId: record.hostRunId ?? "",
      leaseExpiresAt: record.leaseExpiresAt ?? "",
      heartbeatAt: record.heartbeatAt ?? "",
      staleAt: timestamp
    }
  };
}

function describeStaleRunReason(record: HostRunRecord): string {
  if (!record.leaseExpiresAt) {
    return "Run record remained in running state without a lease expiry.";
  }
  if (!Number.isNaN(Date.parse(record.leaseExpiresAt))) {
    return `Run lease expired at ${record.leaseExpiresAt}.`;
  }
  return `Run record has an invalid lease expiry: ${record.leaseExpiresAt}.`;
}
