import { randomUUID } from "node:crypto";

import type { RuntimeEvent } from "../core/events.js";
import type { HostRunRecord, RuntimeProjection } from "../core/types.js";
import {
  COORTEX_MINTED_RUN_INSTANCE_ID_KEY,
  getNativeRunId,
  getRunInstanceId
} from "../core/run-state.js";
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
    runInstanceId: string;
    nativeRunId: string;
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
  const nativeRunId = getNativeRunId(record);
  return {
    level: "warning",
    code: "active-run-present",
    message: `Assignment ${assignmentId} still has an active host run lease${
      nativeRunId ? ` (${nativeRunId})` : ""
    }.`
  };
}

export function buildStaleRunReconciliation(
  projection: RuntimeProjection,
  assignmentId: string,
  record: HostRunRecord,
  timestamp = nowIso()
): StaleRunReconciliation {
  const staleReasonCode = record.staleReasonCode ?? describeStaleRunReasonCode(record);
  const staleReason = record.staleReason ?? describeStaleRunReason(record);
  const existingRunInstanceId = getRunInstanceId(record);
  const runInstanceId = existingRunInstanceId ?? randomUUID();
  const staleRecord: HostRunRecord = {
    ...record,
    state: "completed",
    runInstanceId,
    staleAt: timestamp,
    staleReasonCode,
    staleReason,
    ...(!existingRunInstanceId
      ? {
          adapterData: {
            ...(record.adapterData ?? {}),
            [COORTEX_MINTED_RUN_INSTANCE_ID_KEY]: true
          }
        }
      : {})
  };
  const nativeRunId = getNativeRunId(record);
  const assignment = projection.assignments.get(assignmentId);
  const objective = assignment?.objective ?? projection.status.currentObjective;
  const retryObjective = objective.startsWith("Retry assignment ")
    ? objective
    : `Retry assignment ${assignmentId}: ${objective}`;
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
          lastStaleRunInstanceId: runInstanceId,
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
          currentObjective: retryObjective,
          lastDurableOutputAt: timestamp,
          resumeReady: true,
          lastStaleRunInstanceId: runInstanceId
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
        nativeRunId ? ` (${nativeRunId})` : ""
      }.`
    },
    telemetryMetadata: {
      runInstanceId: runInstanceId ?? "",
      nativeRunId: nativeRunId ?? "",
      leaseExpiresAt: record.leaseExpiresAt ?? "",
      heartbeatAt: record.heartbeatAt ?? "",
      staleAt: timestamp
    }
  };
}

function describeStaleRunReasonCode(
  record: HostRunRecord
): NonNullable<HostRunRecord["staleReasonCode"]> {
  if (!record.leaseExpiresAt) {
    return "missing_lease_expiry";
  }
  if (!Number.isNaN(Date.parse(record.leaseExpiresAt))) {
    return "expired_lease";
  }
  return "invalid_lease_expiry";
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
