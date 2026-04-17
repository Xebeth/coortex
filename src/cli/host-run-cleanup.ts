import type { HostAdapter } from "../adapters/contract.js";
import type { HostRunRecord } from "../core/types.js";
import { RuntimeStore } from "../persistence/store.js";
import { nowIso } from "../utils/time.js";

export async function cleanupHostRunArtifactsWithLeaseVerification(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId: string,
  options?: {
    reconcileRecord?: HostRunRecord;
    inspectedRecord?: HostRunRecord;
    staleAt?: string;
    staleReasonCode?: HostRunRecord["staleReasonCode"];
    staleReason?: string;
    failureLabel?: string;
  }
): Promise<Error | undefined> {
  let cleanupError: Error | undefined;
  try {
    if (options?.reconcileRecord) {
      await adapter.reconcileStaleRun(store, options.reconcileRecord);
    } else {
      const inspected = options?.inspectedRecord ?? await adapter.inspectRun(store, assignmentId);
      if (inspected?.state === "running") {
        await adapter.reconcileStaleRun(store, {
          ...inspected,
          state: "completed",
          staleAt: options?.staleAt ?? nowIso(),
          ...(options?.staleReasonCode ? { staleReasonCode: options.staleReasonCode } : {}),
          ...(options?.staleReason ? { staleReason: options.staleReason } : {})
        });
      } else if (await adapter.hasRunLease(store, assignmentId)) {
        await adapter.releaseRunLease(store, assignmentId);
      }
    }
  } catch (error) {
    cleanupError = error instanceof Error ? error : new Error(String(error));
  }

  if (await adapter.hasRunLease(store, assignmentId)) {
    throw new Error(
      `Host run ${options?.failureLabel ?? "cleanup"} failed to clear the active lease for assignment ${assignmentId}. ${
        cleanupError?.message ?? "The lease artifact remained on disk."
      }`
    );
  }

  return cleanupError;
}

export async function reconcileStaleRunWithLeaseVerification(
  store: RuntimeStore,
  adapter: HostAdapter,
  record: HostRunRecord
): Promise<Error | undefined> {
  return cleanupHostRunArtifactsWithLeaseVerification(
    store,
    adapter,
    record.assignmentId,
    {
      reconcileRecord: record,
      failureLabel: "reconciliation"
    }
  );
}
