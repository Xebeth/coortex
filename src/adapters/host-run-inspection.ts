import { createHash } from "node:crypto";

import type { HostRunArtifactInspection } from "./host-run-lease-repository.js";
import type { HostRunRecord } from "../core/types.js";
import {
  describeStaleRunReason,
  describeStaleRunReasonCode,
  isRunLeaseExpired,
  selectAuthoritativeRunRecord
} from "../core/run-state.js";

export interface MaterializeInspectableRunRecordOptions {
  includeMalformedLeaseRecord?: boolean;
}

export function materializeInspectableRunRecord(
  inspection: HostRunArtifactInspection | undefined,
  options?: MaterializeInspectableRunRecordOptions
): HostRunRecord | undefined {
  if (!inspection) {
    return undefined;
  }
  const runRecord =
    inspection.runRecord?.assignmentId === inspection.assignmentId
      ? inspection.runRecord
      : undefined;
  const leaseRecord =
    inspection.lease.state === "valid" &&
      inspection.lease.record.assignmentId === inspection.assignmentId
      ? inspection.lease.record
      : undefined;
  const authoritative = selectAuthoritativeRunRecord(
    runRecord,
    leaseRecord
  );
  if (authoritative) {
    return normalizeInspectableRunRecord(authoritative);
  }
  if (options?.includeMalformedLeaseRecord !== false && inspection.lease.state === "malformed") {
    return createMalformedLeaseRecord(inspection.assignmentId, inspection.lease.raw);
  }
  return undefined;
}

export function materializeInspectableRunRecords(
  inspections: readonly HostRunArtifactInspection[],
  options?: MaterializeInspectableRunRecordOptions
): HostRunRecord[] {
  const records: HostRunRecord[] = [];
  for (const inspection of inspections) {
    const record = materializeInspectableRunRecord(inspection, options);
    if (record?.assignmentId === inspection.assignmentId) {
      records.push(record);
    }
  }
  return records;
}

function createMalformedLeaseRecord(assignmentId: string, leaseIdentity: string): HostRunRecord {
  return {
    assignmentId,
    state: "running",
    startedAt: malformedLeaseStartedAt(leaseIdentity),
    staleReasonCode: "malformed_lease_artifact",
    staleReason: "malformed lease file"
  };
}

function malformedLeaseStartedAt(leaseIdentity: string): string {
  const hash = createHash("sha256").update(leaseIdentity).digest("hex");
  const offsetMs = Number.parseInt(hash.slice(0, 12), 16) % MALFORMED_LEASE_IDENTITY_WINDOW_MS;
  return new Date(MALFORMED_LEASE_IDENTITY_BASE_MS + offsetMs).toISOString();
}

const MALFORMED_LEASE_IDENTITY_BASE_MS = Date.UTC(1970, 0, 1);
const MALFORMED_LEASE_IDENTITY_WINDOW_MS = 20 * 365 * 24 * 60 * 60 * 1000;

function normalizeInspectableRunRecord(record: HostRunRecord | undefined): HostRunRecord | undefined {
  if (!record || record.state !== "running") {
    return record;
  }
  if (record.staleReasonCode === "malformed_lease_artifact") {
    return record;
  }
  if (!isRunLeaseExpired(record)) {
    return record;
  }
  return {
    ...record,
    state: "completed",
    staleReasonCode: record.staleReasonCode ?? describeStaleRunReasonCode(record),
    staleReason: record.staleReason ?? describeStaleRunReason(record)
  };
}
