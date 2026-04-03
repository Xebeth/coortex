import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { validateRuntimeConfig } from "../config/schema.js";
import type { RuntimeConfig } from "../config/types.js";
import type { RuntimeEvent } from "../core/events.js";
import type { RuntimeProjection, RuntimeSnapshot } from "../core/types.js";
import type { TelemetryEvent } from "../telemetry/types.js";
import { appendLine, ensureDir, readJsonFile, readLines, writeJsonAtomic } from "./files.js";
import { parseJson, toPrettyJson } from "../utils/json.js";
import { fromSnapshot, projectRuntimeState, toSnapshot } from "../projections/runtime-projection.js";

export class RuntimeStore {
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
    await appendLine(this.eventsPath, JSON.stringify(event));
  }

  async loadEvents(): Promise<RuntimeEvent[]> {
    const lines = await readLines(this.eventsPath);
    return lines.map((line, index) =>
      parseJson<RuntimeEvent>(line, `runtime event ${index + 1} from ${this.eventsPath}`)
    );
  }

  async writeSnapshot(snapshot: RuntimeSnapshot): Promise<void> {
    await writeJsonAtomic(this.snapshotPath, snapshot);
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
    const config = await this.loadConfig();
    if (!config) {
      throw new Error(`Coortex runtime is not initialized at ${this.rootDir}`);
    }
    const events = await this.loadEvents();
    return projectRuntimeState(config.sessionId, config.rootPath, config.adapter, events);
  }

  async loadProjection(): Promise<RuntimeProjection> {
    const events = await this.loadEvents();
    if (events.length > 0) {
      const config = await this.loadConfig();
      if (!config) {
        throw new Error(`Coortex runtime is not initialized at ${this.rootDir}`);
      }
      return projectRuntimeState(config.sessionId, config.rootPath, config.adapter, events);
    }
    const snapshot = await this.loadSnapshot();
    if (snapshot) {
      return fromSnapshot(snapshot);
    }
    throw new Error(`No persisted runtime state found at ${this.rootDir}`);
  }

  async syncSnapshotFromEvents(): Promise<RuntimeProjection> {
    const projection = await this.rebuildProjection();
    await this.writeSnapshot(toSnapshot(projection));
    return projection;
  }

  async writeTextArtifact(relativePath: string, content: string): Promise<string> {
    const fullPath = join(this.rootDir, relativePath);
    await ensureDir(dirname(fullPath));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(fullPath, content, "utf8");
    return fullPath;
  }
}

export { toPrettyJson };
