import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeArtifactStore } from "./contract.js";
import type { HostRunRecord } from "../core/types.js";
import { nowIso } from "../utils/time.js";
import { parseJson } from "../utils/json.js";
import { selectAuthoritativeRunRecord } from "../core/run-state.js";

export class HostRunStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: RuntimeArtifactStore,
    private readonly adapterId: string
  ) {}

  async inspect(assignmentId?: string): Promise<HostRunRecord | undefined> {
    if (assignmentId) {
      const runRecord = await this.store.readJsonArtifact<HostRunRecord>(
        this.runRecordRelativePath(assignmentId),
        `${this.adapterId} run record`
      );
      const leaseRecord = await this.readLeaseRecord(assignmentId);
      return selectAuthoritativeRunRecord(runRecord, leaseRecord);
    }
    return this.store.readJsonArtifact<HostRunRecord>(
      this.lastRunRelativePath(),
      `${this.adapterId} run record`
    );
  }

  async claim(record: HostRunRecord): Promise<void> {
    const leasePath = this.runLeaseAbsolutePath(record.assignmentId);
    await mkdir(this.runsDir(), { recursive: true });
    const tempLeasePath = `${leasePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempLeasePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      await link(tempLeasePath, leasePath);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new Error(`Assignment ${record.assignmentId} already has an active host run lease.`);
      }
      throw error;
    } finally {
      await rm(tempLeasePath, { force: true }).catch(() => undefined);
    }

    try {
      await this.store.writeJsonArtifact(this.runRecordRelativePath(record.assignmentId), record);
      await this.store.writeJsonArtifact(this.lastRunRelativePath(), record);
    } catch (error) {
      await rm(leasePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async release(assignmentId: string): Promise<void> {
    await this.store.deleteArtifact(this.runLeaseRelativePath(assignmentId));
    await this.store.deleteArtifact(this.runRecordRelativePath(assignmentId));
    const lastRun = await this.store.readJsonArtifact<HostRunRecord>(
      this.lastRunRelativePath(),
      `${this.adapterId} run record`
    );
    if (lastRun?.assignmentId === assignmentId && lastRun.state === "running") {
      await this.store.deleteArtifact(this.lastRunRelativePath());
    }
  }

  async write(record: HostRunRecord): Promise<void> {
    const writePromise = this.writeQueue.catch(() => undefined).then(async () => {
      if (record.state === "running") {
        await this.store.writeJsonArtifact(this.runLeaseRelativePath(record.assignmentId), record);
      } else {
        await rm(this.runLeaseAbsolutePath(record.assignmentId), { force: true });
      }
      await this.store.writeJsonArtifact(this.runRecordRelativePath(record.assignmentId), record);
      await this.store.writeJsonArtifact(this.lastRunRelativePath(), record);
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
        await rm(this.runLeaseAbsolutePath(record.assignmentId), { force: true }).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : String(error);
      return `Host run outcome was preserved, but the final run record could not be persisted. ${message}`;
    }
  }

  private async readLeaseRecord(assignmentId: string): Promise<HostRunRecord | undefined> {
    const relativePath = this.runLeaseRelativePath(assignmentId);
    try {
      return await this.store.readJsonArtifact<HostRunRecord>(relativePath, `${this.adapterId} run lease`);
    } catch {
      const content = await this.readLeaseContentOrUndefined(this.runLeaseAbsolutePath(assignmentId));
      if (content === undefined) {
        return undefined;
      }
      try {
        return parseJson<HostRunRecord>(content, `${this.adapterId} run lease`);
      } catch {
        await this.store.deleteArtifact(relativePath);
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

  private async readLeaseContentOrUndefined(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private runsDir(): string {
    return join(this.store.adaptersDir, this.adapterId, "runs");
  }

  private runRecordRelativePath(assignmentId: string): string {
    return `adapters/${this.adapterId}/runs/${assignmentId}.json`;
  }

  private runLeaseRelativePath(assignmentId: string): string {
    return `adapters/${this.adapterId}/runs/${assignmentId}.lease.json`;
  }

  private runLeaseAbsolutePath(assignmentId: string): string {
    return join(this.runsDir(), `${assignmentId}.lease.json`);
  }

  private lastRunRelativePath(): string {
    return `adapters/${this.adapterId}/last-run.json`;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
