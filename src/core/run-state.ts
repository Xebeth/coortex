import type { HostRunRecord } from "./types.js";

export const COORTEX_RECLAIM_LEASE_KEY = "coortexReclaimLease";
export const COORTEX_MINTED_RUN_INSTANCE_ID_KEY = "coortexMintedRunInstanceId";

export function getNativeRunId(record: HostRunRecord | undefined): string | undefined {
  const nativeRunId = record?.adapterData?.nativeRunId;
  return typeof nativeRunId === "string" && nativeRunId.length > 0 ? nativeRunId : undefined;
}

export function getRunInstanceId(record: HostRunRecord | undefined): string | undefined {
  return typeof record?.runInstanceId === "string" && record.runInstanceId.length > 0
    ? record.runInstanceId
    : undefined;
}

export function isCoortexReclaimLease(record: HostRunRecord | undefined): boolean {
  return record?.adapterData?.[COORTEX_RECLAIM_LEASE_KEY] === true;
}

export function hasMalformedLeaseBlocker(record: HostRunRecord | undefined): boolean {
  return record?.staleReasonCode === "malformed_lease_artifact";
}

export function applyMalformedLeaseBlocker(record: HostRunRecord): HostRunRecord {
  return {
    ...record,
    staleReasonCode: "malformed_lease_artifact",
    staleReason: "malformed lease file"
  };
}

export function selectAuthoritativeRunRecord(
  runRecord: HostRunRecord | undefined,
  leaseRecord: HostRunRecord | undefined,
  options?: {
    malformedLeaseArtifact?: boolean;
  }
): HostRunRecord | undefined {
  if (isTerminalCompletedRunRecord(runRecord)) {
    return runRecord;
  }
  if (options?.malformedLeaseArtifact) {
    return runRecord ? applyMalformedLeaseBlocker(runRecord) : undefined;
  }
  if (leaseRecord?.state === "running") {
    return leaseRecord;
  }
  if (runRecord?.state === "completed") {
    return runRecord;
  }
  if (runRecord?.state === "running" && !leaseRecord) {
    return {
      ...runRecord,
      state: "completed",
      staleReasonCode: "missing_lease_artifact",
      staleReason: "Run record remained in running state without an active lease artifact."
    };
  }
  if (runRecord) {
    return runRecord;
  }
  return leaseRecord;
}

function isTerminalCompletedRunRecord(
  record: HostRunRecord | undefined
): record is HostRunRecord & { state: "completed"; terminalOutcome: NonNullable<HostRunRecord["terminalOutcome"]> } {
  return record?.state === "completed" && Boolean(record.terminalOutcome);
}

export function isRunLeaseExpired(record: HostRunRecord): boolean {
  if (record.state !== "running") {
    return false;
  }
  if (!record.leaseExpiresAt) {
    return true;
  }
  const leaseExpiry = Date.parse(record.leaseExpiresAt);
  if (Number.isNaN(leaseExpiry)) {
    return true;
  }
  return leaseExpiry <= Date.now();
}

export function describeStaleRunReasonCode(
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

export function describeStaleRunReason(record: HostRunRecord): string {
  if (!record.leaseExpiresAt) {
    return "Run record remained in running state without a lease expiry.";
  }
  if (!Number.isNaN(Date.parse(record.leaseExpiresAt))) {
    return `Run lease expired at ${record.leaseExpiresAt}.`;
  }
  return `Run record has an invalid lease expiry: ${record.leaseExpiresAt}.`;
}
