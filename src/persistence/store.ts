import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { validateRuntimeConfig } from "../config/schema.js";
import type { RuntimeConfig } from "../config/types.js";
import type { RuntimeEvent } from "../core/events.js";
import type { RuntimeProjection, RuntimeSnapshot } from "../core/types.js";
import type { TelemetryEvent } from "../telemetry/types.js";
import type { VersionedTextArtifact } from "../adapters/contract.js";
import {
  appendLine,
  appendText,
  ensureDir,
  readJsonFile,
  readLines,
  readTextFile,
  withPathLock,
  writeJsonAtomic,
  writeTextAtomic,
  writeTextExclusive
} from "./files.js";
import { parseJson, toPrettyJson } from "../utils/json.js";
import { createEmptyProjection, fromSnapshot, toSnapshot } from "../projections/runtime-projection.js";
import {
  ProjectionRecoveryService,
  type ProjectionRecoveryResult,
  type ProjectionRecoveryStore,
  type ProjectionSyncResult,
  type ReplayableRuntimeEvents
} from "./projection-recovery.js";

export class RuntimeStore implements ProjectionRecoveryStore {
  readonly rootDir: string;
  readonly runtimeDir: string;
  readonly adaptersDir: string;
  readonly configPath: string;
  readonly eventsPath: string;
  readonly snapshotPath: string;
  readonly telemetryPath: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.runtimeDir = join(rootDir, "runtime");
    this.adaptersDir = join(rootDir, "adapters");
    this.configPath = join(rootDir, "config.json");
    this.eventsPath = join(this.runtimeDir, "events.ndjson");
    this.snapshotPath = join(this.runtimeDir, "snapshot.json");
    this.telemetryPath = join(this.runtimeDir, "telemetry.ndjson");
  }

  static forProject(projectRoot: string): RuntimeStore {
    return new RuntimeStore(join(projectRoot, ".coortex"));
  }

  async initialize(config: RuntimeConfig): Promise<void> {
    await ensureDir(this.rootDir);
    await ensureDir(this.runtimeDir);
    await ensureDir(this.adaptersDir);
    await writeJsonAtomic(this.configPath, config);
    await mkdir(this.runtimeDir, { recursive: true });
  }

  async loadConfig(): Promise<RuntimeConfig | undefined> {
    const config = await readJsonFile<unknown>(this.configPath, "runtime config");
    return config ? validateRuntimeConfig(config) : undefined;
  }

  async appendEvent(event: RuntimeEvent): Promise<void> {
    await this.withEventsLock(() => appendLine(this.eventsPath, JSON.stringify(event)));
  }

  async appendEvents(events: RuntimeEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const content = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    await this.withEventsLock(() => appendText(this.eventsPath, content));
  }

  async loadEvents(): Promise<RuntimeEvent[]> {
    const lines = await this.loadEventLines();
    return lines.map((line, index) =>
      parseJson<RuntimeEvent>(line, `runtime event ${index + 1} from ${this.eventsPath}`)
    );
  }

  async loadEventLines(): Promise<string[]> {
    return readLines(this.eventsPath);
  }

  async rewriteEventLog(events: RuntimeEvent[]): Promise<void> {
    const content = events.map((event) => JSON.stringify(event)).join("\n");
    await writeTextAtomic(this.eventsPath, content.length > 0 ? `${content}\n` : "");
  }

  async writeSnapshot(snapshot: RuntimeSnapshot): Promise<void> {
    await writeJsonAtomic(this.snapshotPath, snapshot);
  }

  async mutateSnapshotProjection(
    mutate: (projection: RuntimeProjection) => RuntimeProjection | Promise<RuntimeProjection>
  ): Promise<RuntimeProjection> {
    return withPathLock(this.snapshotPath, async () => {
      const snapshot = await this.loadSnapshot();
      const baseProjection = snapshot
        ? fromSnapshot(snapshot)
        : await this.createEmptyProjectionFromConfig();
      const nextProjection = await mutate(fromSnapshot(toSnapshot(baseProjection)));
      await this.writeSnapshot(toSnapshot(nextProjection));
      return nextProjection;
    });
  }

  async loadSnapshot(): Promise<RuntimeSnapshot | undefined> {
    return readJsonFile<RuntimeSnapshot>(this.snapshotPath, "runtime snapshot");
  }

  async appendTelemetry(event: TelemetryEvent): Promise<void> {
    await appendLine(this.telemetryPath, JSON.stringify(event));
  }

  async loadTelemetry(): Promise<TelemetryEvent[]> {
    const lines = await readLines(this.telemetryPath);
    return lines.map((line, index) =>
      parseJson<TelemetryEvent>(line, `telemetry event ${index + 1} from ${this.telemetryPath}`)
    );
  }

  async rebuildProjection(): Promise<RuntimeProjection> {
    return this.projectionRecovery().rebuildProjection();
  }

  async loadProjectionWithRecovery(): Promise<ProjectionRecoveryResult> {
    return this.projectionRecovery().loadProjectionWithRecovery();
  }

  async loadProjection(): Promise<RuntimeProjection> {
    return this.projectionRecovery().loadProjection();
  }

  async hasEvents(): Promise<boolean> {
    const lines = await readLines(this.eventsPath);
    return lines.length > 0;
  }

  async loadReplayableEvents(): Promise<ReplayableRuntimeEvents> {
    return this.projectionRecovery().loadReplayableEvents();
  }

  async repairEventLog(): Promise<string | undefined> {
    return this.projectionRecovery().repairEventLog();
  }

  async syncSnapshotFromEventsWithRecovery(): Promise<ProjectionSyncResult> {
    return this.projectionRecovery().syncSnapshotFromEventsWithRecovery();
  }

  async syncSnapshotFromEvents(): Promise<RuntimeProjection> {
    return this.projectionRecovery().syncSnapshotFromEvents();
  }

  async withEventsLock<T>(action: () => Promise<T>): Promise<T> {
    return withPathLock(this.eventsPath, action);
  }

  async readJsonArtifact<T>(relativePath: string, label: string): Promise<T | undefined> {
    return readJsonFile<T>(join(this.rootDir, relativePath), label);
  }

  async readTextArtifact(relativePath: string, _label: string): Promise<string | undefined> {
    return readTextFile(join(this.rootDir, relativePath));
  }

  async readVersionedTextArtifact(
    relativePath: string,
    _label: string
  ): Promise<VersionedTextArtifact> {
    const fullPath = join(this.rootDir, relativePath);
    return withPathLock(fullPath, async () => readVersionedTextFile(fullPath));
  }

  async claimTextArtifact(relativePath: string, content: string): Promise<string> {
    const fullPath = join(this.rootDir, relativePath);
    await writeTextExclusive(fullPath, content);
    return fullPath;
  }

  async writeTextArtifactCas(
    relativePath: string,
    expectedVersion: string | null,
    nextContent: string
  ): Promise<{ ok: boolean; version: string | null }> {
    const fullPath = join(this.rootDir, relativePath);
    return withPathLock(fullPath, async () => {
      const current = await readVersionedTextFile(fullPath);
      if (current.version !== expectedVersion) {
        return { ok: false, version: current.version };
      }
      await writeTextAtomic(fullPath, nextContent);
      const written = await readVersionedTextFile(fullPath);
      return { ok: true, version: written.version };
    });
  }

  async writeJsonArtifact(relativePath: string, value: unknown): Promise<string> {
    const fullPath = join(this.rootDir, relativePath);
    await writeJsonAtomic(fullPath, value);
    return fullPath;
  }

  async writeTextArtifact(relativePath: string, content: string): Promise<string> {
    const fullPath = join(this.rootDir, relativePath);
    await ensureDir(dirname(fullPath));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(fullPath, content, "utf8");
    return fullPath;
  }

  async listArtifacts(relativeDir: string): Promise<string[]> {
    try {
      const entries = await readdir(join(this.rootDir, relativeDir), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => join(relativeDir, entry.name))
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (isMissingError(error)) {
        return [];
      }
      throw error;
    }
  }

  async deleteArtifact(relativePath: string): Promise<void> {
    await rm(join(this.rootDir, relativePath), { force: true });
  }

  private async createEmptyProjectionFromConfig(): Promise<RuntimeProjection> {
    const config = await this.loadConfig();
    if (!config) {
      throw new Error(`Coortex runtime is not initialized at ${this.rootDir}`);
    }
    return createEmptyProjection(config.sessionId, config.rootPath, config.adapter);
  }

  private projectionRecovery(): ProjectionRecoveryService {
    return new ProjectionRecoveryService(this);
  }
}

export { toPrettyJson };

async function readVersionedTextFile(path: string): Promise<VersionedTextArtifact> {
  const content = await readTextFile(path);
  if (content === undefined) {
    return { version: null };
  }
  const metadata = await stat(path);
  return {
    content,
    version: [
      metadata.dev,
      metadata.ino,
      metadata.size,
      metadata.mtimeMs,
      metadata.ctimeMs
    ].join(":")
  };
}

function isMissingError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
