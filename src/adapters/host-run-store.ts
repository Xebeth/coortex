import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { RuntimeArtifactStore } from "./contract.js";
import {
  materializeInspectableRunRecord,
  materializeInspectableRunRecords
} from "./host-run-inspection.js";
import {
  HostRunLeaseRepository,
  type HostRunArtifactInspection,
  type HostRunArtifactPaths
} from "./host-run-lease-repository.js";
import type { HostRunRecord } from "../core/types.js";
import { COORTEX_MINTED_RUN_INSTANCE_ID_KEY } from "../core/run-state.js";

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

  async release(assignmentId: string, proof?: HostRunRecord): Promise<void> {
    await this.cleanupLeaseArtifacts(assignmentId, {
      ...(proof ? { proof } : {}),
      deleteRunRecord: true
    });
  }

  async clearLease(assignmentId: string, proof?: HostRunRecord): Promise<void> {
    await this.cleanupLeaseArtifacts(assignmentId, {
      ...(proof ? { proof } : {})
    });
  }

  async hasLease(assignmentId: string): Promise<boolean> {
    return this.repository.hasLease(assignmentId);
  }

  private async cleanupLeaseArtifacts(
    assignmentId: string,
    options?: {
      proof?: HostRunRecord;
      deleteRunRecord?: boolean;
    }
  ): Promise<void> {
    const proofFence = getRunOwnerFence(options?.proof);
    const leaseError = await this.tryDeleteLease(assignmentId, proofFence);
    if (leaseError) {
      throw leaseError;
    }
    if (options?.deleteRunRecord) {
      const recordError = await this.tryDeleteRunRecord(assignmentId, proofFence);
      if (recordError) {
        throw recordError;
      }
    }
    const lastRunCleanupError = await this.tryDeleteRunningLastRunPointerIfOwnedBy(
      assignmentId,
      proofFence
    );
    if (lastRunCleanupError) {
      throw lastRunCleanupError;
    }
  }

  async write(record: HostRunRecord): Promise<void> {
    const writePromise = this.writeQueue.catch(() => undefined).then(async () => {
      await this.persistLeaseState(record);
      if (record.state === "running") {
        await this.repository.writeRunRecord(record);
        await this.repository.writeLastRunPointer(record);
      }
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
      if (
        record.state !== "running" &&
        !ownerFence &&
        !hasMintedStaleRunInstanceId(record) &&
        !isHostRunOwnershipFenceError(error)
      ) {
        const cleanupError = await this.tryDeleteLease(record.assignmentId, ownerFence);
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
    return materializeInspectableRunRecords(await this.inspectAllArtifacts());
  }

  async inspectAllArtifacts(): Promise<HostRunArtifactInspection[]> {
    return this.repository.inspectAll();
  }

  private async cleanupClaimFailure(
    assignmentId: string,
    proof?: HostRunRecord
  ): Promise<Error | undefined> {
    const cleanupErrors: string[] = [];
    try {
      await this.ensureLiveOwnerFenceForCleanup(
        assignmentId,
        "claim rollback cleanup",
        getRunOwnerFence(proof)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Error(message);
    }
    const proofFence = getRunOwnerFence(proof);
    const leaseError = await this.tryDeleteLease(assignmentId, proofFence);
    if (leaseError) {
      cleanupErrors.push(leaseError.message);
    }
    const recordError = await this.tryDeleteRunRecord(assignmentId, proofFence);
    if (recordError) {
      cleanupErrors.push(recordError.message);
    }

    const lastRunError = await this.tryDeleteRunningLastRunPointerIfOwnedBy(
      assignmentId,
      proofFence
    );
    if (lastRunError) {
      cleanupErrors.push(lastRunError.message);
    }

    if (cleanupErrors.length === 0) {
      return undefined;
    }
    return new Error(cleanupErrors.join(" "));
  }

  private async tryDeleteLease(
    assignmentId: string,
    proofFence?: string
  ): Promise<Error | undefined> {
    const lease = await this.repository.readLease(assignmentId);
    if (lease.state === "missing") {
      return undefined;
    }

    const fenceError = await this.ensureCleanupMayTouchLiveArtifact(
      assignmentId,
      "run lease cleanup",
      proofFence
    );
    if (fenceError) {
      return fenceError;
    }

    if (lease.state === "valid" || lease.state === "malformed") {
      return this.tryCleanupArtifact(async () => {
        const deleted = await this.repository.deleteLeaseVersioned(assignmentId, lease.version);
        if (!deleted.ok) {
          throw new HostRunOwnershipFenceError(assignmentId, "run lease cleanup");
        }
      }, "run lease cleanup");
    }

    return this.tryCleanupArtifact(
      () => this.repository.deleteLease(assignmentId),
      "run lease cleanup"
    );
  }

  private async tryDeleteRunRecord(
    assignmentId: string,
    proofFence?: string
  ): Promise<Error | undefined> {
    const fenceError = await this.ensureCleanupMayTouchLiveArtifact(
      assignmentId,
      "run record cleanup",
      proofFence
    );
    if (fenceError) {
      return fenceError;
    }
    return this.tryCleanupArtifact(
      () => this.repository.deleteRunRecord(assignmentId),
      "run record cleanup"
    );
  }

  private async tryDeleteLastRunPointer(): Promise<Error | undefined> {
    return this.tryCleanupArtifact(
      () => this.repository.deleteLastRunPointer(),
      "last-run pointer cleanup"
    );
  }

  private async ensureCleanupMayTouchLiveArtifact(
    assignmentId: string,
    operation: string,
    proofFence?: string
  ): Promise<Error | undefined> {
    try {
      await this.ensureLiveOwnerFenceForCleanup(assignmentId, operation, proofFence);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  private async tryCleanupArtifact(
    cleanup: () => Promise<void>,
    context: string
  ): Promise<Error | undefined> {
    try {
      await cleanup();
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Error(`${this.adapterId} ${context} failed: ${message}`);
    }
  }

  private async tryDeleteRunningLastRunPointerIfOwnedBy(
    assignmentId: string,
    proofFence?: string
  ): Promise<Error | undefined> {
    const lastRun = await this.repository.readLastRunPointer();
    if (
      lastRun.state !== "valid" ||
      lastRun.record.assignmentId !== assignmentId ||
      lastRun.record.state !== "running"
    ) {
      return undefined;
    }
    const liveFence = getRunOwnerFence(lastRun.record);
    if (liveFence && liveFence !== proofFence) {
      return new HostRunOwnershipFenceError(assignmentId, "last-run pointer cleanup");
    }
    return this.tryDeleteLastRunPointer();
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
      const cleanupError = await this.cleanupClaimFailure(record.assignmentId, record);
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
        const currentLiveFence = await this.getCurrentLiveOwnerFence(record.assignmentId);
        if (currentLiveFence) {
          throw new HostRunOwnershipFenceError(record.assignmentId, "running lease refresh");
        }
        const currentLease = await this.repository.readLease(record.assignmentId);
        if (currentLease.state === "valid" && getRunOwnerFence(currentLease.record)) {
          throw new HostRunOwnershipFenceError(record.assignmentId, "running lease refresh");
        }
        const written = await this.repository.swapLease(
          record.assignmentId,
          currentLease.version,
          record
        );
        if (!written.ok) {
          throw new HostRunOwnershipFenceError(record.assignmentId, "running lease refresh");
        }
        return;
      }
      const leaseError = await this.tryDeleteLease(record.assignmentId);
      if (leaseError) {
        throw leaseError;
      }
      await this.persistCompletedMetadata(record);
      return;
    }

    const currentLiveFence = await this.getCurrentLiveOwnerFence(record.assignmentId);
    if (currentLiveFence && currentLiveFence !== ownerFence) {
      throw new HostRunOwnershipFenceError(
        record.assignmentId,
        record.state === "running" ? "running lease refresh" : "completed lease finalization"
      );
    }

    if (record.state === "running") {
      const currentLease = await this.repository.readLease(record.assignmentId);
      if (currentLease.state !== "valid") {
        throw new HostRunOwnershipFenceError(record.assignmentId, "running lease refresh");
      }
      ensureMatchingRunOwnerFence(
        record.assignmentId,
        "running lease refresh",
        ownerFence,
        currentLease.record
      );
      const swapped = await this.repository.swapLease(record.assignmentId, currentLease.version, record);
      if (!swapped.ok) {
        throw new HostRunOwnershipFenceError(record.assignmentId, "running lease refresh");
      }
      return;
    }

    const leaseError = await this.tryDeleteLease(record.assignmentId, ownerFence);
    if (leaseError) {
      throw leaseError;
    }

    await this.persistCompletedMetadata(record);
  }

  private async ensureLiveOwnerFenceForCleanup(
    assignmentId: string,
    operation: string,
    proofFence?: string
  ): Promise<void> {
    const liveFence = await this.getCurrentLiveOwnerFence(assignmentId);
    if (liveFence && liveFence !== proofFence) {
      throw new HostRunOwnershipFenceError(assignmentId, operation);
    }
  }

  private async getCurrentLiveOwnerFence(assignmentId: string): Promise<string | undefined> {
    const lease = await this.repository.readLease(assignmentId);
    if (lease.state === "valid" && lease.record.state === "running") {
      const leaseFence = getRunOwnerFence(lease.record);
      if (leaseFence) {
        return leaseFence;
      }
    }

    const runRecord = await this.repository.readRunRecord(assignmentId);
    if (runRecord?.state === "running") {
      const runFence = getRunOwnerFence(runRecord);
      if (runFence) {
        return runFence;
      }
    }

    const lastRun = await this.repository.readLastRunPointer();
    if (
      lastRun.state === "valid" &&
      lastRun.record.assignmentId === assignmentId &&
      lastRun.record.state === "running"
    ) {
      const lastRunFence = getRunOwnerFence(lastRun.record);
      if (lastRunFence) {
        return lastRunFence;
      }
    }

    return undefined;
  }

  private async ensureCompletedMetadataBoundaries(record: HostRunRecord): Promise<void> {
    const currentRunRecord = await this.repository.readRunRecord(record.assignmentId);
    ensureTerminalWriteBoundary(
      record.assignmentId,
      "completed run persistence",
      record,
      currentRunRecord
    );

    const lastRun = await this.repository.readLastRunPointer();
    if (lastRun.state === "valid" && lastRun.record.assignmentId === record.assignmentId) {
      ensureTerminalWriteBoundary(
        record.assignmentId,
        "completed last-run persistence",
        record,
        lastRun.record
      );
    }
  }

  private async persistCompletedMetadata(record: HostRunRecord): Promise<void> {
    const previousRunRecord = await this.repository.readRunRecord(record.assignmentId);
    const previousLastRun = await this.repository.readLastRunPointer();
    let wroteRunRecord = false;
    let wroteLastRun = false;

    try {
      await this.ensureCompletedMetadataPublicationMayProceed(
        record,
        "completed run-record publication"
      );
      await this.repository.writeRunRecord(record);
      wroteRunRecord = true;

      await this.ensureCompletedMetadataPublicationMayProceed(
        record,
        "completed last-run publication"
      );
      await this.repository.writeLastRunPointer(record);
      wroteLastRun = true;

      await this.ensureCompletedMetadataPublicationMayProceed(
        record,
        "completed publication verification"
      );
    } catch (error) {
      const rollbackErrors = await this.restoreCompletedMetadata(record, {
        previousRunRecord,
        previousLastRun,
        wroteRunRecord,
        wroteLastRun
      });
      if (rollbackErrors.length > 0) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Host run terminal metadata persistence failed and rollback also failed for assignment ${record.assignmentId}. ${message} ${rollbackErrors.join(" ")}`
        );
      }
      throw error;
    }
  }

  private async ensureCompletedMetadataPublicationMayProceed(
    record: HostRunRecord,
    operation: string
  ): Promise<void> {
    const liveFence = await this.getCurrentLiveOwnerFence(record.assignmentId);
    const proofFence = getRunOwnerFence(record);
    if (liveFence && liveFence !== proofFence) {
      throw new HostRunOwnershipFenceError(record.assignmentId, operation);
    }
    await this.ensureCompletedMetadataBoundaries(record);
  }

  private async restoreCompletedMetadata(
    record: HostRunRecord,
    options: {
      previousRunRecord: HostRunRecord | undefined;
      previousLastRun:
        | { state: "missing" }
      | { state: "valid"; record: HostRunRecord }
      | { state: "malformed"; raw: string };
      wroteRunRecord: boolean;
      wroteLastRun: boolean;
    }
  ): Promise<string[]> {
    const rollbackErrors: string[] = [];

    if (options.wroteRunRecord) {
      const currentRunRecord = await this.repository.readRunRecord(record.assignmentId);
      if (isDeepStrictEqual(currentRunRecord, record)) {
        try {
          if (options.previousRunRecord) {
            await this.repository.writeRunRecord(options.previousRunRecord);
          } else {
            await this.repository.deleteRunRecord(record.assignmentId);
          }
        } catch (rollbackError) {
          rollbackErrors.push(
            `run record rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }
      }
    }

    if (options.wroteLastRun) {
      const currentLastRun = await this.repository.readLastRunPointer();
      if (currentLastRun.state === "valid" && isDeepStrictEqual(currentLastRun.record, record)) {
        try {
          if (options.previousLastRun.state === "valid") {
            await this.repository.writeLastRunPointer(options.previousLastRun.record);
          } else {
            await this.repository.deleteLastRunPointer();
          }
        } catch (rollbackError) {
          rollbackErrors.push(
            `last-run rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }
      }
    }

    return rollbackErrors;
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

function hasMintedStaleRunInstanceId(
  record: Pick<HostRunRecord, "adapterData"> | undefined
): boolean {
  return record?.adapterData?.[COORTEX_MINTED_RUN_INSTANCE_ID_KEY] === true;
}

function ensureUnfencedTerminalWriteDoesNotCrossNewerBoundary(
  assignmentId: string,
  operation: string,
  expectedRecord: Pick<HostRunRecord, "runInstanceId" | "adapterData">,
  currentRecord: Pick<HostRunRecord, "runInstanceId" | "adapterData"> | undefined
): void {
  if (!currentRecord) {
    return;
  }
  const currentFence = getRunOwnerFence(currentRecord);
  if (currentFence || currentRecord.adapterData?.coortexReclaimLease === true) {
    throw new HostRunOwnershipFenceError(assignmentId, operation);
  }
}

function ensureTerminalWriteBoundary(
  assignmentId: string,
  operation: string,
  expectedRecord: Pick<HostRunRecord, "runInstanceId" | "adapterData">,
  currentRecord: Pick<HostRunRecord, "runInstanceId" | "adapterData"> | undefined
): void {
  const expectedFence = getRunOwnerFence(expectedRecord);
  if (expectedFence) {
    ensureMatchingRunOwnerFence(assignmentId, operation, expectedFence, currentRecord);
    return;
  }
  ensureUnfencedTerminalWriteDoesNotCrossNewerBoundary(
    assignmentId,
    operation,
    expectedRecord,
    currentRecord
  );
}

function getRunOwnerFence(
  record: Pick<HostRunRecord, "runInstanceId" | "adapterData"> | undefined
): string | undefined {
  if (hasMintedStaleRunInstanceId(record)) {
    return undefined;
  }
  return typeof record?.runInstanceId === "string" && record.runInstanceId.length > 0
    ? record.runInstanceId
    : undefined;
}

function ensureMatchingRunOwnerFence(
  assignmentId: string,
  operation: string,
  expectedFence: string,
  record: Pick<HostRunRecord, "runInstanceId" | "adapterData"> | undefined
): void {
  const actualFence = getRunOwnerFence(record);
  if (actualFence && actualFence !== expectedFence) {
    throw new HostRunOwnershipFenceError(assignmentId, operation);
  }
}
