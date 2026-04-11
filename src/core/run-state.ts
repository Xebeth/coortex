import type { HostRunRecord } from "./types.js";

export function getNativeRunId(record: HostRunRecord | undefined): string | undefined {
  const nativeRunId = record?.adapterData?.nativeRunId;
  return typeof nativeRunId === "string" && nativeRunId.length > 0 ? nativeRunId : undefined;
}

export function selectAuthoritativeRunRecord(
  runRecord: HostRunRecord | undefined,
  leaseRecord: HostRunRecord | undefined
): HostRunRecord | undefined {
  if (runRecord?.state === "completed") {
    return runRecord;
  }
  if (leaseRecord?.state === "running") {
    return leaseRecord;
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

export function describeStaleRunReason(record: HostRunRecord): string {
  if (!record.leaseExpiresAt) {
    return "Run record remained in running state without a lease expiry.";
  }
  if (!Number.isNaN(Date.parse(record.leaseExpiresAt))) {
    return `Run lease expired at ${record.leaseExpiresAt}.`;
  }
  return `Run record has an invalid lease expiry: ${record.leaseExpiresAt}.`;
}
