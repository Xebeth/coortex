import { basename, dirname } from "node:path";

import type { RuntimeArtifactStore } from "./contract.js";
import type { HostRunRecord } from "../core/types.js";
import { parseJson, toPrettyJson } from "../utils/json.js";
import {
  describeStaleRunReason,
  describeStaleRunReasonCode,
  isRunLeaseExpired,
  selectAuthoritativeRunRecord
} from "../core/run-state.js";

export interface HostRunArtifactPaths {
  runRecordPath(assignmentId: string): string;
  runLeasePath(assignmentId: string): string;
  lastRunPath(): string;
}

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

export type HostRunLeaseInspection =
  | {
      state: "missing";
    }
  | {
      state: "valid";
      record: HostRunRecord;
    }
  | {
      state: "malformed";
      raw: string;
    };

export interface HostRunArtifactInspection {
  assignmentId: string;
  runRecord?: HostRunRecord;
  lease: HostRunLeaseInspection;
}

type LeaseArtifactRead =
  | (HostRunLeaseInspection & {
      version: string | null;
    });

export class HostRunStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: RuntimeArtifactStore,
    private readonly adapterId: string,
    private readonly artifacts: HostRunArtifactPaths
  ) {}

  async inspect(assignmentId?: string): Promise<HostRunRecord | undefined> {
    const inspection = await this.inspectArtifacts(assignmentId);
    if (!inspection) {
      return undefined;
    }
    return normalizeInspectedRun(
      selectAuthoritativeRunRecord(
        inspection.runRecord,
        inspection.lease.state === "valid" ? inspection.lease.record : undefined
      )
    );
  }

  async inspectArtifacts(assignmentId?: string): Promise<HostRunArtifactInspection | undefined> {
    if (assignmentId) {
      return this.inspectArtifactsForAssignment(assignmentId);
    }
    const lastRun = await this.readLastRunPointer();
    if (!lastRun?.assignmentId) {
      return undefined;
    }
    return this.inspectArtifactsForAssignment(lastRun.assignmentId);
  }

  async claim(record: HostRunRecord): Promise<void> {
    await this.claimUnlocked(record);
  }

  async claimOrAdopt(
    record: HostRunRecord,
    canAdopt: (current: HostRunRecord) => boolean,
    buildAdoptedRecord: (current: HostRunRecord) => HostRunRecord
  ): Promise<HostRunRecord> {
    const leasePath = this.artifacts.runLeasePath(record.assignmentId);
    const currentLease = await this.readLeaseArtifact(record.assignmentId);
    if (currentLease.state === "missing") {
      const claimedLease = await this.store.writeTextArtifactCas(
        leasePath,
        currentLease.version,
        `${toPrettyJson(record)}\n`
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
    const adoptedRecord = buildAdoptedRecord(currentLease.record);
    const adoptedLeaseText = `${toPrettyJson(adoptedRecord)}\n`;
    const swapped = await this.store.writeTextArtifactCas(
      leasePath,
      currentLease.version,
      adoptedLeaseText
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
    await this.store.deleteArtifact(this.artifacts.runLeasePath(assignmentId));
    await this.store.deleteArtifact(this.artifacts.runRecordPath(assignmentId));
    const lastRun = await this.readLastRunPointer();
    if (lastRun?.assignmentId === assignmentId && lastRun.state === "running") {
      await this.store.deleteArtifact(this.artifacts.lastRunPath());
    }
  }

  async hasLease(assignmentId: string): Promise<boolean> {
    return (
      (await this.store.readTextArtifact(
        this.artifacts.runLeasePath(assignmentId),
        `${this.adapterId} run lease`
      )) !== undefined
    );
  }

  async write(record: HostRunRecord): Promise<void> {
    const writePromise = this.writeQueue.catch(() => undefined).then(async () => {
      if (record.state === "running") {
        await this.store.writeJsonArtifact(this.artifacts.runLeasePath(record.assignmentId), record);
      } else {
        await this.store.deleteArtifact(this.artifacts.runLeasePath(record.assignmentId));
      }
      await this.store.writeJsonArtifact(this.artifacts.runRecordPath(record.assignmentId), record);
      await this.store.writeJsonArtifact(this.artifacts.lastRunPath(), record);
    });
    this.writeQueue = writePromise.catch(() => undefined);
    await writePromise;
  }

  async persistWarning(record: HostRunRecord): Promise<string | undefined> {
    try {
      await this.write(record);
      return undefined;
    } catch (error) {
      if (record.state !== "running") {
        const cleanupError = await this.tryDeleteArtifact(
          this.artifacts.runLeasePath(record.assignmentId),
          `${this.adapterId} run lease`
        );
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
      const record = normalizeInspectedRun(
        selectAuthoritativeRunRecord(
          inspection.runRecord,
          inspection.lease.state === "valid" ? inspection.lease.record : undefined
        )
      );
      if (record?.assignmentId === inspection.assignmentId) {
        records.push(record);
      }
    }
    return records;
  }

  async inspectAllArtifacts(): Promise<HostRunArtifactInspection[]> {
    const inspections = await Promise.all(
      (await this.listInspectableAssignmentIds()).map((assignmentId) =>
        this.inspectArtifactsForAssignment(assignmentId)
      )
    );
    return inspections.filter((inspection) => inspection !== undefined);
  }

  private async cleanupClaimFailure(assignmentId: string): Promise<Error | undefined> {
    const cleanupErrors: string[] = [];
    const leaseError = await this.tryDeleteArtifact(
      this.artifacts.runLeasePath(assignmentId),
      `${this.adapterId} run lease`
    );
    if (leaseError) {
      cleanupErrors.push(leaseError.message);
    }
    const recordError = await this.tryDeleteArtifact(
      this.artifacts.runRecordPath(assignmentId),
      `${this.adapterId} run record`
    );
    if (recordError) {
      cleanupErrors.push(recordError.message);
    }
    const lastRun = await this.readLastRunPointer();
    if (lastRun?.assignmentId === assignmentId && lastRun.state === "running") {
      const lastRunError = await this.tryDeleteArtifact(
        this.artifacts.lastRunPath(),
        `${this.adapterId} run record`
      );
      if (lastRunError) {
        cleanupErrors.push(lastRunError.message);
      }
    }
    if (cleanupErrors.length === 0) {
      return undefined;
    }
    return new Error(cleanupErrors.join(" "));
  }

  private async tryDeleteArtifact(relativePath: string, label: string): Promise<Error | undefined> {
    try {
      await this.store.deleteArtifact(relativePath);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Error(`${label} cleanup failed: ${message}`);
    }
  }

  private async readLeaseArtifact(assignmentId: string): Promise<LeaseArtifactRead> {
    const relativePath = this.artifacts.runLeasePath(assignmentId);
    const lease = await this.store.readVersionedTextArtifact(
      relativePath,
      `${this.adapterId} run lease`
    );
    if (lease.content === undefined) {
      return { state: "missing", version: lease.version };
    }
    try {
      const leaseRecord = parseJson<HostRunRecord>(lease.content, `${this.adapterId} run lease`);
      if (isValidLeaseRecord(leaseRecord, assignmentId)) {
        return {
          state: "valid",
          version: lease.version,
          record: leaseRecord
        };
      }
      return {
        state: "malformed",
        version: lease.version,
        raw: lease.content
      };
    } catch {
      return {
        state: "malformed",
        version: lease.version,
        raw: lease.content
      };
    }
  }

  private async inspectArtifactsForAssignment(
    assignmentId: string
  ): Promise<HostRunArtifactInspection | undefined> {
    const runRecord = await this.store.readJsonArtifact<HostRunRecord>(
      this.artifacts.runRecordPath(assignmentId),
      `${this.adapterId} run record`
    );
    const lease = stripLeaseVersion(await this.readLeaseArtifact(assignmentId));
    if (!runRecord && lease.state === "missing") {
      return undefined;
    }
    return {
      assignmentId,
      ...(runRecord ? { runRecord } : {}),
      lease
    };
  }

  private async listInspectableAssignmentIds(): Promise<string[]> {
    const assignmentIds = new Set<string>();
    const runRecordPattern = createAssignmentArtifactPattern(
      this.artifacts.runRecordPath(ASSIGNMENT_ID_TOKEN)
    );
    const leasePattern = createAssignmentArtifactPattern(
      this.artifacts.runLeasePath(ASSIGNMENT_ID_TOKEN)
    );

    if (runRecordPattern) {
      for (const relativePath of await listArtifacts(this.store, runRecordPattern.directory)) {
        if (leasePattern && matchAssignmentId(relativePath, leasePattern)) {
          continue;
        }
        const assignmentId = matchAssignmentId(relativePath, runRecordPattern);
        if (assignmentId) {
          assignmentIds.add(assignmentId);
        }
      }
    }

    if (leasePattern) {
      for (const relativePath of await listArtifacts(this.store, leasePattern.directory)) {
        const assignmentId = matchAssignmentId(relativePath, leasePattern);
        if (assignmentId) {
          assignmentIds.add(assignmentId);
        }
      }
    }
    const lastRun = await this.readLastRunPointer();
    if (lastRun?.assignmentId) {
      assignmentIds.add(lastRun.assignmentId);
    }
    return [...assignmentIds].sort((left, right) => left.localeCompare(right));
  }

  private async readLastRunPointer(): Promise<HostRunRecord | undefined> {
    const relativePath = this.artifacts.lastRunPath();
    try {
      return await this.store.readJsonArtifact<HostRunRecord>(
        relativePath,
        `${this.adapterId} run record`
      );
    } catch {
      const content = await this.store.readTextArtifact(relativePath, `${this.adapterId} run record`);
      if (content === undefined) {
        return undefined;
      }
      try {
        return parseJson<HostRunRecord>(content, `${this.adapterId} run record`);
      } catch {
        return undefined;
      }
    }
  }

  private async claimUnlocked(record: HostRunRecord): Promise<void> {
    const leasePath = this.artifacts.runLeasePath(record.assignmentId);
    try {
      await this.store.claimTextArtifact(leasePath, `${toPrettyJson(record)}\n`);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new ActiveHostRunLeaseError(record.assignmentId);
      }
      throw error;
    }

    await this.persistClaimMetadata(record);
  }

  private async persistClaimMetadata(record: HostRunRecord): Promise<void> {
    try {
      await this.store.writeJsonArtifact(this.artifacts.runRecordPath(record.assignmentId), record);
      await this.store.writeJsonArtifact(this.artifacts.lastRunPath(), record);
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
    const runRecordPath = this.artifacts.runRecordPath(adoptedRecord.assignmentId);
    const previousRunRecord = await this.store.readJsonArtifact<HostRunRecord>(
      runRecordPath,
      `${this.adapterId} run record`
    );
    const previousLastRun = await this.readLastRunPointer();
    try {
      await this.store.writeJsonArtifact(runRecordPath, adoptedRecord);
      await this.store.writeJsonArtifact(this.artifacts.lastRunPath(), adoptedRecord);
    } catch (error) {
      const rollbackErrors: string[] = [];
      const rollbackLease = await this.store.writeTextArtifactCas(
        this.artifacts.runLeasePath(adoptedRecord.assignmentId),
        rollback.previousLeaseVersion,
        `${toPrettyJson(rollback.previousLeaseRecord)}\n`
      );
      if (!rollbackLease.ok) {
        rollbackErrors.push("lease rollback failed after adopt metadata persistence error.");
      }
      try {
        if (previousRunRecord) {
          await this.store.writeJsonArtifact(runRecordPath, previousRunRecord);
        } else {
          await this.store.deleteArtifact(runRecordPath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(
          `run record rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
      }
      try {
        if (previousLastRun) {
          await this.store.writeJsonArtifact(this.artifacts.lastRunPath(), previousLastRun);
        } else {
          await this.store.deleteArtifact(this.artifacts.lastRunPath());
        }
      } catch (rollbackError) {
        rollbackErrors.push(
          `last-run rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
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
}

function isValidLeaseRecord(record: unknown, assignmentId: string): record is HostRunRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return false;
  }
  const leaseRecord = record as Partial<HostRunRecord>;
  return (
    leaseRecord.assignmentId === assignmentId &&
    leaseRecord.state === "running" &&
    typeof leaseRecord.startedAt === "string" &&
    leaseRecord.startedAt.length > 0
  );
}

function normalizeInspectedRun(record: HostRunRecord | undefined): HostRunRecord | undefined {
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

function stripLeaseVersion(lease: LeaseArtifactRead): HostRunLeaseInspection {
  switch (lease.state) {
    case "missing":
      return { state: "missing" };
    case "valid":
      return { state: "valid", record: lease.record };
    case "malformed":
      return { state: "malformed", raw: lease.raw };
  }
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
}

const ASSIGNMENT_ID_TOKEN = "__coortex_assignment_id__";

function createAssignmentArtifactPattern(relativePath: string):
  | {
      directory: string;
      prefix: string;
      suffix: string;
    }
  | undefined {
  const fileName = basename(relativePath);
  const markerIndex = fileName.indexOf(ASSIGNMENT_ID_TOKEN);
  if (markerIndex === -1) {
    return undefined;
  }
  return {
    directory: dirname(relativePath),
    prefix: fileName.slice(0, markerIndex),
    suffix: fileName.slice(markerIndex + ASSIGNMENT_ID_TOKEN.length)
  };
}

function matchAssignmentId(
  relativePath: string,
  pattern: {
    prefix: string;
    suffix: string;
  }
): string | undefined {
  const fileName = basename(relativePath);
  if (!fileName.startsWith(pattern.prefix) || !fileName.endsWith(pattern.suffix)) {
    return undefined;
  }
  return fileName.slice(pattern.prefix.length, fileName.length - pattern.suffix.length);
}

async function listArtifacts(store: RuntimeArtifactStore, relativeDir: string): Promise<string[]> {
  if (!hasArtifactListing(store)) {
    return [];
  }
  return store.listArtifacts(relativeDir);
}

function hasArtifactListing(
  store: RuntimeArtifactStore
): store is RuntimeArtifactStore & { listArtifacts(relativeDir: string): Promise<string[]> } {
  return "listArtifacts" in store && typeof store.listArtifacts === "function";
}
