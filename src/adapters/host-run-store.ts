import { randomUUID } from "node:crypto";

import type { RuntimeArtifactStore } from "./contract.js";
import { materializeInspectableRunRecord } from "./host-run-inspection.js";
import {
  HostRunLeaseRepository,
  type HostRunArtifactInspection,
  type HostRunArtifactPaths
} from "./host-run-lease-repository.js";
import type { HostRunRecord } from "../core/types.js";

export type { HostRunArtifactInspection, HostRunArtifactPaths, HostRunLeaseInspection } from "./host-run-lease-repository.js";

export class ActiveHostRunLeaseError extends Error {
  constructor(readonly assignmentId: string) {
    super(`Assignment ${assignmentId} already has an active host run lease.`);
  }
}

export class MalformedHostRunLeaseArtifactError extends ActiveHostRunLeaseError {
  constructor(
    readonly assignmentId: string,
    readonly relativePath: string
  ) {
    super(assignmentId);
    this.message = `Assignment ${assignmentId} has a malformed host run lease artifact at ${relativePath}.`;
  }
}

export function isActiveHostRunLeaseError(error: unknown): error is ActiveHostRunLeaseError {
  return error instanceof ActiveHostRunLeaseError;
}

class HostRunOwnershipFenceError extends Error {
  constructor(
    readonly assignmentId: string,
    readonly operation: string
  ) {
    super(`Assignment ${assignmentId} lost host run ownership during ${operation}.`);
  }
}

function isHostRunOwnershipFenceError(error: unknown): error is HostRunOwnershipFenceError {
  return error instanceof HostRunOwnershipFenceError;
}

export class HostRunStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly repository: HostRunLeaseRepository;

  constructor(
    store: RuntimeArtifactStore,
    private readonly adapterId: string,
    artifacts: HostRunArtifactPaths
  ) {
    this.repository = new HostRunLeaseRepository(store, adapterId, artifacts);
  }

  async inspect(assignmentId?: string): Promise<HostRunRecord | undefined> {
    return materializeInspectableRunRecord(await this.inspectArtifacts(assignmentId));
  }

  async inspectArtifacts(assignmentId?: string): Promise<HostRunArtifactInspection | undefined> {
    return this.repository.inspect(assignmentId);
  }

  async claim(record: HostRunRecord): Promise<void> {
    await this.claimUnlocked(record);
  }

  async claimOrAdopt(
    record: HostRunRecord,
    canAdopt: (current: HostRunRecord) => boolean,
    buildAdoptedRecord: (current: HostRunRecord) => HostRunRecord
  ): Promise<HostRunRecord> {
    const leasePath = this.repository.artifacts.runLeasePath(record.assignmentId);
    const currentLease = await this.repository.readLease(record.assignmentId);
    if (currentLease.state === "missing") {
      const claimedLease = await this.repository.swapLease(
        record.assignmentId,
        currentLease.version,
        record
      );
      if (!claimedLease.ok) {
        throw new ActiveHostRunLeaseError(record.assignmentId);
      }
      await this.persistClaimMetadata(record);
      return record;
    }
    if (currentLease.state === "malformed") {
      throw new MalformedHostRunLeaseArtifactError(record.assignmentId, leasePath);
    }
    if (!canAdopt(currentLease.record)) {
      throw new ActiveHostRunLeaseError(record.assignmentId);
    }

    const adoptedRecord = withAdoptedOwnershipFence(
      currentLease.record,
      buildAdoptedRecord(currentLease.record),
      record
    );
    const swapped = await this.repository.swapLease(
      record.assignmentId,
      currentLease.version,
      adoptedRecord
    );
    if (!swapped.ok) {
      throw new ActiveHostRunLeaseError(record.assignmentId);
    }

    await this.persistAdoptMetadata(adoptedRecord, {
      previousLeaseVersion: swapped.version,
      previousLeaseRecord: currentLease.record
    });
    return adoptedRecord;
  }

  async release(assignmentId: string): Promise<void> {
    await this.repository.deleteLease(assignmentId);
    await this.repository.deleteRunRecord(assignmentId);
    const lastRun = await this.repository.readLastRunPointer();
    if (shouldDeleteRunningLastRunPointer(lastRun, assignmentId)) {
      await this.repository.deleteLastRunPointer();
    }
  }

  async clearLease(assignmentId: string): Promise<void> {
    await this.repository.deleteLease(assignmentId);
    const lastRun = await this.repository.readLastRunPointer();
    if (shouldDeleteRunningLastRunPointer(lastRun, assignmentId)) {
      await this.repository.deleteLastRunPointer();
    }
  }

  async hasLease(assignmentId: string): Promise<boolean> {
    return this.repository.hasLease(assignmentId);
  }

  async write(record: HostRunRecord): Promise<void> {
    const writePromise = this.writeQueue.catch(() => undefined).then(async () => {
      await this.persistLeaseState(record);
      await this.repository.writeRunRecord(record);
      await this.repository.writeLastRunPointer(record);
    });
    this.writeQueue = writePromise.catch(() => undefined);
    await writePromise;
  }

  async persistWarning(record: HostRunRecord): Promise<string | undefined> {
    const ownerFence = getRunOwnerFence(record);
    try {
      await this.write(record);
      return undefined;
    } catch (error) {
      if (record.state !== "running" && !ownerFence && !isHostRunOwnershipFenceError(error)) {
        const cleanupError = await this.tryDeleteLease(record.assignmentId);
        if (cleanupError) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Host run outcome was preserved, but active lease cleanup failed after final run record persistence degraded for assignment ${record.assignmentId}. ${message} ${cleanupError.message}`
          );
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      return `Host run outcome was preserved, but the final run record could not be persisted. ${message}`;
    }
  }

  async inspectAll(): Promise<HostRunRecord[]> {
    const records: HostRunRecord[] = [];
    for (const inspection of await this.inspectAllArtifacts()) {
      const record = materializeInspectableRunRecord(inspection);
      if (record?.assignmentId === inspection.assignmentId) {
        records.push(record);
      }
    }
    return records;
  }

  async inspectAllArtifacts(): Promise<HostRunArtifactInspection[]> {
    return this.repository.inspectAll();
  }

  private async cleanupClaimFailure(assignmentId: string): Promise<Error | undefined> {
    const cleanupErrors: string[] = [];
    const leaseError = await this.tryDeleteLease(assignmentId);
    if (leaseError) {
      cleanupErrors.push(leaseError.message);
    }
    const recordError = await this.tryDeleteRunRecord(assignmentId);
    if (recordError) {
      cleanupErrors.push(recordError.message);
    }

    const lastRun = await this.repository.readLastRunPointer();
    if (shouldDeleteRunningLastRunPointer(lastRun, assignmentId)) {
      const lastRunError = await this.tryDeleteLastRunPointer();
      if (lastRunError) {
        cleanupErrors.push(lastRunError.message);
      }
    }

    if (cleanupErrors.length === 0) {
      return undefined;
    }
    return new Error(cleanupErrors.join(" "));
  }

  private async tryDeleteLease(assignmentId: string): Promise<Error | undefined> {
    try {
      await this.repository.deleteLease(assignmentId);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Error(`${this.adapterId} run lease cleanup failed: ${message}`);
    }
  }

  private async tryDeleteRunRecord(assignmentId: string): Promise<Error | undefined> {
    try {
      await this.repository.deleteRunRecord(assignmentId);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Error(`${this.adapterId} run record cleanup failed: ${message}`);
    }
  }

  private async tryDeleteLastRunPointer(): Promise<Error | undefined> {
    try {
      await this.repository.deleteLastRunPointer();
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Error(`${this.adapterId} run record cleanup failed: ${message}`);
    }
  }

  private async claimUnlocked(record: HostRunRecord): Promise<void> {
    const claimed = await this.repository.claimLease(record);
    if (!claimed) {
      throw new ActiveHostRunLeaseError(record.assignmentId);
    }

    await this.persistClaimMetadata(record);
  }

  private async persistClaimMetadata(record: HostRunRecord): Promise<void> {
    try {
      await this.repository.writeRunRecord(record);
      await this.repository.writeLastRunPointer(record);
    } catch (error) {
      const cleanupError = await this.cleanupClaimFailure(record.assignmentId);
      if (cleanupError) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Host run claim metadata persistence failed and rollback cleanup also failed for assignment ${record.assignmentId}. ${message} ${cleanupError.message}`
        );
      }
      throw error;
    }
  }

  private async persistAdoptMetadata(
    adoptedRecord: HostRunRecord,
    rollback: {
      previousLeaseVersion: string | null;
      previousLeaseRecord: HostRunRecord;
    }
  ): Promise<void> {
    const previousRunRecord = await this.repository.readRunRecord(adoptedRecord.assignmentId);
    const previousLastRun = await this.repository.readLastRunPointer();
    try {
      await this.repository.writeRunRecord(adoptedRecord);
      await this.repository.writeLastRunPointer(adoptedRecord);
    } catch (error) {
      const rollbackErrors: string[] = [];
      const rollbackLease = await this.repository.swapLease(
        adoptedRecord.assignmentId,
        rollback.previousLeaseVersion,
        rollback.previousLeaseRecord
      );
      if (!rollbackLease.ok) {
        rollbackErrors.push(
          "lease rollback stopped because a newer adopted ownership boundary is already durable."
        );
      }

      if (rollbackLease.ok) {
        try {
          if (previousRunRecord) {
            await this.repository.writeRunRecord(previousRunRecord);
          } else {
            await this.repository.deleteRunRecord(adoptedRecord.assignmentId);
          }
        } catch (rollbackError) {
          rollbackErrors.push(
            `run record rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }

        try {
          if (previousLastRun.state === "valid") {
            await this.repository.writeLastRunPointer(previousLastRun.record);
          } else {
            await this.repository.deleteLastRunPointer();
          }
        } catch (rollbackError) {
          rollbackErrors.push(
            `last-run rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }
      }

      const message = error instanceof Error ? error.message : String(error);
      if (rollbackErrors.length > 0) {
        throw new Error(
          `Host run adopt metadata persistence failed and rollback also failed for assignment ${adoptedRecord.assignmentId}. ${message} ${rollbackErrors.join(" ")}`
        );
      }
      throw error;
    }
  }

  private async persistLeaseState(record: HostRunRecord): Promise<void> {
    const ownerFence = getRunOwnerFence(record);
    if (!ownerFence) {
      if (record.state === "running") {
        await this.repository.writeLease(record);
      } else {
        await this.repository.deleteLease(record.assignmentId);
      }
      return;
    }

    if (record.state === "running") {
      const currentLease = await this.repository.readLease(record.assignmentId);
      if (currentLease.state !== "valid") {
        throw new HostRunOwnershipFenceError(record.assignmentId, "running lease refresh");
      }
      ensureMatchingRunOwnerFence(record.assignmentId, "running lease refresh", ownerFence, currentLease.record);
      const swapped = await this.repository.swapLease(record.assignmentId, currentLease.version, record);
      if (!swapped.ok) {
        throw new HostRunOwnershipFenceError(record.assignmentId, "running lease refresh");
      }
      return;
    }

    const currentLease = await this.repository.readLease(record.assignmentId);
    if (currentLease.state === "valid") {
      ensureMatchingRunOwnerFence(record.assignmentId, "completed lease finalization", ownerFence, currentLease.record);
      const refreshed = await this.repository.swapLease(
        record.assignmentId,
        currentLease.version,
        currentLease.record
      );
      if (!refreshed.ok) {
        throw new HostRunOwnershipFenceError(record.assignmentId, "completed lease finalization");
      }
      const deleted = await this.repository.deleteLeaseVersioned(
        record.assignmentId,
        refreshed.version
      );
      if (!deleted.ok) {
        throw new HostRunOwnershipFenceError(record.assignmentId, "completed lease finalization");
      }
    } else if (currentLease.state === "malformed") {
      throw new HostRunOwnershipFenceError(record.assignmentId, "completed lease finalization");
    }

    const currentRunRecord = await this.repository.readRunRecord(record.assignmentId);
    ensureMatchingRunOwnerFence(record.assignmentId, "completed run persistence", ownerFence, currentRunRecord);

    const lastRun = await this.repository.readLastRunPointer();
    if (lastRun.state === "valid" && lastRun.record.assignmentId === record.assignmentId) {
      ensureMatchingRunOwnerFence(record.assignmentId, "completed last-run persistence", ownerFence, lastRun.record);
    }

  }
}

function withAdoptedOwnershipFence(
  currentRecord: HostRunRecord,
  adoptedRecord: HostRunRecord,
  requestedRecord: HostRunRecord
): HostRunRecord {
  const requestedFence = getRunOwnerFence(requestedRecord);
  const currentFence = getRunOwnerFence(currentRecord);
  const adoptedFence = getRunOwnerFence(adoptedRecord);
  const nextFence =
    requestedFence && requestedFence !== currentFence
      ? requestedFence
      : adoptedFence && adoptedFence !== currentFence
        ? adoptedFence
        : randomUUID();
  return {
    ...adoptedRecord,
    runInstanceId: nextFence
  };
}

function getRunOwnerFence(
  record: Pick<HostRunRecord, "runInstanceId" | "state" | "staleReasonCode"> | undefined
): string | undefined {
  return typeof record?.runInstanceId === "string" &&
    record.runInstanceId.length > 0 &&
    (
      record.state === "running" ||
      (record.state === "completed" && !record.staleReasonCode)
    )
    ? record.runInstanceId
    : undefined;
}

function ensureMatchingRunOwnerFence(
  assignmentId: string,
  operation: string,
  expectedFence: string,
  record: Pick<HostRunRecord, "runInstanceId" | "state" | "staleReasonCode"> | undefined
): void {
  const actualFence = getRunOwnerFence(record);
  if (actualFence && actualFence !== expectedFence) {
    throw new HostRunOwnershipFenceError(assignmentId, operation);
  }
}

function shouldDeleteRunningLastRunPointer(
  pointer: Awaited<ReturnType<HostRunLeaseRepository["readLastRunPointer"]>>,
  assignmentId: string
): boolean {
  return (
    pointer.state === "valid" &&
    pointer.record.assignmentId === assignmentId &&
    pointer.record.state === "running"
  );
}
