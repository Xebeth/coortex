import type { RuntimeArtifactStore } from "./contract.js";
import type { HostRunRecord } from "../core/types.js";
import { nowIso } from "../utils/time.js";
import { parseJson, toPrettyJson } from "../utils/json.js";
import { selectAuthoritativeRunRecord } from "../core/run-state.js";

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
      return selectAuthoritativeRunRecord(runRecord, leaseRecord);
    }
    const lastRun = await this.store.readJsonArtifact<HostRunRecord>(
      this.artifacts.lastRunPath(),
      `${this.adapterId} run record`
    );
    if (!lastRun?.assignmentId) {
      return lastRun;
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
      await this.release(record.assignmentId).catch(() => undefined);
      throw error;
    }
  }

  async release(assignmentId: string): Promise<void> {
    await this.store.deleteArtifact(this.artifacts.runLeasePath(assignmentId));
    await this.store.deleteArtifact(this.artifacts.runRecordPath(assignmentId));
    const lastRun = await this.store.readJsonArtifact<HostRunRecord>(
      this.artifacts.lastRunPath(),
      `${this.adapterId} run record`
    );
    if (lastRun?.assignmentId === assignmentId && lastRun.state === "running") {
      await this.store.deleteArtifact(this.artifacts.lastRunPath());
    }
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
        await this.store.deleteArtifact(this.artifacts.runLeasePath(record.assignmentId)).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : String(error);
      return `Host run outcome was preserved, but the final run record could not be persisted. ${message}`;
    }
  }

  private async readLeaseRecord(assignmentId: string): Promise<HostRunRecord | undefined> {
    const relativePath = this.artifacts.runLeasePath(assignmentId);
    try {
      return await this.store.readJsonArtifact<HostRunRecord>(relativePath, `${this.adapterId} run lease`);
    } catch {
      const content = await this.store.readTextArtifact(relativePath, `${this.adapterId} run lease`);
      if (content === undefined) {
        return undefined;
      }
      try {
        return parseJson<HostRunRecord>(content, `${this.adapterId} run lease`);
      } catch {
        return {
          assignmentId,
          state: "running",
          startedAt: nowIso(),
          staleReasonCode: "malformed_lease_artifact",
          staleReason: "malformed lease file"
        };
      }
    }
  }
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
}
