import { dirname } from "node:path";

import type { RuntimeArtifactStore } from "./contract.js";
import type { HostRunRecord } from "../core/types.js";
import { parseJson, toPrettyJson } from "../utils/json.js";

export interface HostRunArtifactPaths {
  runRecordPath(assignmentId: string): string;
  runLeasePath(assignmentId: string): string;
  lastRunPath(): string;
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

export type VersionedHostRunLeaseInspection =
  | {
      state: "missing";
      version: string | null;
    }
  | {
      state: "valid";
      version: string | null;
      record: HostRunRecord;
    }
  | {
      state: "malformed";
      version: string | null;
      raw: string;
    };

export interface HostRunArtifactInspection {
  assignmentId: string;
  runRecord?: HostRunRecord;
  lease: HostRunLeaseInspection;
}

export type HostRunPointerInspection =
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

export class HostRunLeaseRepository {
  constructor(
    private readonly store: RuntimeArtifactStore,
    private readonly adapterId: string,
    readonly artifacts: HostRunArtifactPaths
  ) {}

  async inspect(assignmentId?: string): Promise<HostRunArtifactInspection | undefined> {
    if (assignmentId) {
      return this.inspectForAssignment(assignmentId);
    }
    const lastRun = await this.readLastRunPointer();
    if (lastRun.state !== "valid") {
      return undefined;
    }
    return this.inspectForAssignment(lastRun.record.assignmentId);
  }

  async inspectAll(): Promise<HostRunArtifactInspection[]> {
    const inspections = await Promise.all(
      (await this.listInspectableAssignmentIds()).map((assignmentId) =>
        this.inspectForAssignment(assignmentId)
      )
    );
    return inspections.filter((inspection) => inspection !== undefined);
  }

  async readLease(assignmentId: string): Promise<VersionedHostRunLeaseInspection> {
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

  async hasLease(assignmentId: string): Promise<boolean> {
    return (
      (await this.store.readTextArtifact(
        this.artifacts.runLeasePath(assignmentId),
        `${this.adapterId} run lease`
      )) !== undefined
    );
  }

  async claimLease(record: HostRunRecord): Promise<boolean> {
    try {
      await this.store.claimTextArtifact(
        this.artifacts.runLeasePath(record.assignmentId),
        `${toPrettyJson(record)}\n`
      );
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) {
        return false;
      }
      throw error;
    }
  }

  async swapLease(
    assignmentId: string,
    expectedVersion: string | null,
    nextRecord: HostRunRecord
  ): Promise<{ ok: boolean; version: string | null }> {
    return this.store.writeTextArtifactCas(
      this.artifacts.runLeasePath(assignmentId),
      expectedVersion,
      `${toPrettyJson(nextRecord)}\n`
    );
  }

  async deleteLease(assignmentId: string): Promise<void> {
    await this.store.deleteArtifact(this.artifacts.runLeasePath(assignmentId));
  }

  async deleteLeaseVersioned(
    assignmentId: string,
    expectedVersion: string | null
  ): Promise<{ ok: boolean; version: string | null }> {
    return this.store.deleteTextArtifactCas(
      this.artifacts.runLeasePath(assignmentId),
      expectedVersion
    );
  }

  async readRunRecord(assignmentId: string): Promise<HostRunRecord | undefined> {
    const record = await this.store.readJsonArtifact<HostRunRecord>(
      this.artifacts.runRecordPath(assignmentId),
      `${this.adapterId} run record`
    );
    return isValidHostRunRecordFact(record) && record.assignmentId === assignmentId
      ? record
      : undefined;
  }

  async writeRunRecord(record: HostRunRecord): Promise<void> {
    await this.store.writeJsonArtifact(this.artifacts.runRecordPath(record.assignmentId), record);
  }

  async deleteRunRecord(assignmentId: string): Promise<void> {
    await this.store.deleteArtifact(this.artifacts.runRecordPath(assignmentId));
  }

  async readLastRunPointer(): Promise<HostRunPointerInspection> {
    const relativePath = this.artifacts.lastRunPath();
    const label = `${this.adapterId} run record`;
    const content = await this.store.readTextArtifact(relativePath, label);
    if (content === undefined) {
      return { state: "missing" };
    }
    try {
      const record = parseJson<HostRunRecord>(content, label);
      return isValidHostRunRecordFact(record)
        ? { state: "valid", record }
        : { state: "malformed", raw: content };
    } catch {
      return {
        state: "malformed",
        raw: content
      };
    }
  }

  async writeLastRunPointer(record: HostRunRecord): Promise<void> {
    await this.store.writeJsonArtifact(this.artifacts.lastRunPath(), record);
  }

  async deleteLastRunPointer(): Promise<void> {
    await this.store.deleteArtifact(this.artifacts.lastRunPath());
  }

  private async inspectForAssignment(
    assignmentId: string
  ): Promise<HostRunArtifactInspection | undefined> {
    const runRecord = await this.readRunRecord(assignmentId);
    const lease = stripLeaseVersion(await this.readLease(assignmentId));
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
    if (lastRun.state === "valid") {
      assignmentIds.add(lastRun.record.assignmentId);
    }
    return [...assignmentIds].sort((left, right) => left.localeCompare(right));
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

function isValidHostRunRecordFact(record: unknown): record is HostRunRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return false;
  }
  const pointerRecord = record as Partial<HostRunRecord>;
  return (
    typeof pointerRecord.assignmentId === "string" &&
    pointerRecord.assignmentId.length > 0 &&
    (pointerRecord.state === "running" || pointerRecord.state === "completed") &&
    typeof pointerRecord.startedAt === "string" &&
    pointerRecord.startedAt.length > 0
  );
}

function stripLeaseVersion(lease: VersionedHostRunLeaseInspection): HostRunLeaseInspection {
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

function createAssignmentArtifactPattern(
  relativePath: string
):
  | {
      directory: string;
      prefix: string;
      suffix: string;
    }
  | undefined {
  const normalizedPath = normalizeArtifactPath(relativePath);
  const markerIndex = normalizedPath.indexOf(ASSIGNMENT_ID_TOKEN);
  if (markerIndex === -1) {
    return undefined;
  }
  const prefix = normalizedPath.slice(0, markerIndex);
  const lastSeparatorIndex = prefix.lastIndexOf("/");
  return {
    directory: lastSeparatorIndex === -1 ? "" : prefix.slice(0, lastSeparatorIndex),
    prefix,
    suffix: normalizedPath.slice(markerIndex + ASSIGNMENT_ID_TOKEN.length)
  };
}

function matchAssignmentId(
  relativePath: string,
  pattern: {
    prefix: string;
    suffix: string;
  }
): string | undefined {
  const normalizedPath = normalizeArtifactPath(relativePath);
  if (!normalizedPath.startsWith(pattern.prefix) || !normalizedPath.endsWith(pattern.suffix)) {
    return undefined;
  }
  return normalizedPath.slice(
    pattern.prefix.length,
    normalizedPath.length - pattern.suffix.length
  );
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

function normalizeArtifactPath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/");
}
