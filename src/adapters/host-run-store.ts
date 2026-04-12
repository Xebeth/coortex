import { createHash } from "node:crypto";
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

export class HostRunStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: RuntimeArtifactStore,
    private readonly adapterId: string,
    private readonly artifacts: HostRunArtifactPaths
  ) {}

  async inspect(assignmentId?: string): Promise<HostRunRecord | undefined> {
    if (assignmentId) {
      const runRecord = await this.store.readJsonArtifact<HostRunRecord>(
        this.artifacts.runRecordPath(assignmentId),
        `${this.adapterId} run record`
      );
      const leaseRecord = await this.readLeaseRecord(assignmentId);
      return normalizeInspectedRun(selectAuthoritativeRunRecord(runRecord, leaseRecord));
    }
    const lastRun = await this.readLastRunPointer();
    if (!lastRun?.assignmentId) {
      return undefined;
    }
    return this.inspect(lastRun.assignmentId);
  }

  async claim(record: HostRunRecord): Promise<void> {
    const leasePath = this.artifacts.runLeasePath(record.assignmentId);
    try {
      await this.store.claimTextArtifact(leasePath, `${toPrettyJson(record)}\n`);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new Error(`Assignment ${record.assignmentId} already has an active host run lease.`);
      }
      throw error;
    }

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
    for (const assignmentId of await this.listInspectableAssignmentIds()) {
      const record = await this.inspect(assignmentId);
      if (record?.assignmentId === assignmentId) {
        records.push(record);
      }
    }
    return records;
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

  private async readLeaseRecord(assignmentId: string): Promise<HostRunRecord | undefined> {
    const relativePath = this.artifacts.runLeasePath(assignmentId);
    try {
      const leaseRecord = await this.store.readJsonArtifact<HostRunRecord>(
        relativePath,
        `${this.adapterId} run lease`
      );
      if (leaseRecord === undefined) {
        return undefined;
      }
      return isValidLeaseRecord(leaseRecord, assignmentId)
        ? leaseRecord
        : createMalformedLeaseRecord(assignmentId, JSON.stringify(leaseRecord));
    } catch {
      const content = await this.store.readTextArtifact(relativePath, `${this.adapterId} run lease`);
      if (content === undefined) {
        return undefined;
      }
      try {
        const leaseRecord = parseJson<HostRunRecord>(content, `${this.adapterId} run lease`);
        return isValidLeaseRecord(leaseRecord, assignmentId)
          ? leaseRecord
          : createMalformedLeaseRecord(assignmentId, content);
      } catch {
        return createMalformedLeaseRecord(assignmentId, content);
      }
    }
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
