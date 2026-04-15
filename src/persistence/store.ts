import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { validateRuntimeConfig } from "../config/schema.js";
import type { RuntimeConfig } from "../config/types.js";
import type { RuntimeEvent } from "../core/events.js";
import type { RuntimeProjection, RuntimeSnapshot } from "../core/types.js";
import type { TelemetryEvent } from "../telemetry/types.js";
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
import {
  applyRuntimeEvent,
  fromSnapshot,
  projectRuntimeState,
  toSnapshot
} from "../projections/runtime-projection.js";

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
    const lines = await readLines(this.eventsPath);
    return lines.map((line, index) =>
      parseJson<RuntimeEvent>(line, `runtime event ${index + 1} from ${this.eventsPath}`)
    );
  }

  async loadReplayableEvents(): Promise<{
    events: RuntimeEvent[];
    warning?: string;
    malformedLines: number[];
  }> {
    const lines = await readLines(this.eventsPath);
    const events: RuntimeEvent[] = [];
    const warnings: string[] = [];
    const malformedLines: number[] = [];

    for (const [index, line] of lines.entries()) {
      try {
        events.push(parseJson<RuntimeEvent>(line, `runtime event ${index + 1} from ${this.eventsPath}`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        malformedLines.push(index + 1);
        warnings.push(`Event replay skipped malformed line ${index + 1} in ${this.eventsPath}. ${message}`);
      }
    }

    return warnings.length > 0
      ? {
          events,
          warning: warnings.join(" "),
          malformedLines
        }
      : { events, malformedLines };
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

  async loadProjectionWithRecovery(): Promise<{
    projection: RuntimeProjection;
    warning?: string;
    snapshotFallback: boolean;
  }> {
    const snapshot = await this.loadSnapshot();
    const { events, warning } = await this.loadReplayableEvents();
    const fallbackToSnapshot = (reason: string) => ({
      projection: fromSnapshot(snapshot!),
      warning: [warning, reason].filter(Boolean).join(" ").trim(),
      snapshotFallback: true as const
    });
    const replayAfterSnapshot = () => {
      try {
        return {
          replayed: replayEventsAfterSnapshot(snapshot!, events)
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          fallback: fallbackToSnapshot(
            `Event replay after ${this.snapshotPath} could not rebuild runtime state; fell back to ${this.snapshotPath}. ${detail}`
          )
        };
      }
    };
    if (warning && snapshot) {
      const replayAttempt = replayAfterSnapshot();
      if (replayAttempt.fallback) {
        return replayAttempt.fallback;
      }
      if (replayAttempt.replayed) {
        return {
          projection: replayAttempt.replayed,
          warning: `${warning} Rebuilt runtime state from ${this.snapshotPath} plus replayable events after ${snapshot.lastEventId ?? "the snapshot boundary"}.`,
          snapshotFallback: false
        };
      }
      return fallbackToSnapshot(
        `Fell back to ${this.snapshotPath} to avoid rewriting rolled-back salvaged state.`
      );
    }
    if (events.length > 0) {
      if (snapshot) {
        const replayAttempt = replayAfterSnapshot();
        if (replayAttempt.fallback) {
          return replayAttempt.fallback;
        }
        if (replayAttempt.replayed) {
          return warning
            ? { projection: replayAttempt.replayed, warning, snapshotFallback: false }
            : { projection: replayAttempt.replayed, snapshotFallback: false };
        }
        if (snapshot.lastEventId) {
          return fallbackToSnapshot(
            `${this.eventsPath} no longer contains snapshot boundary ${snapshot.lastEventId}. Fell back to ${this.snapshotPath} to avoid replacing newer durable state.`
          );
        }
      }
      if (events[0]?.type !== "runtime.initialized") {
        const message = `${this.eventsPath} no longer starts at runtime.initialized.`;
        if (snapshot) {
          return fallbackToSnapshot(
            `Event replay could not rebuild runtime state because ${message} Fell back to ${this.snapshotPath} to avoid replacing newer durable state.`
          );
        }
        throw new Error(
          `Event replay could not rebuild runtime state from replayable events because ${message}`
        );
      }
      const config = await this.loadConfig();
      if (!config) {
        throw new Error(`Coortex runtime is not initialized at ${this.rootDir}`);
      }
      try {
        const projection = projectRuntimeState(config.sessionId, config.rootPath, config.adapter, events);
        return warning ? { projection, warning, snapshotFallback: false } : { projection, snapshotFallback: false };
      } catch (error) {
        if (!snapshot) {
          throw error;
        }
        const detail = error instanceof Error ? error.message : String(error);
        const fallbackWarning = `${warning ?? ""} Event replay could not rebuild runtime state; fell back to ${this.snapshotPath}. ${detail}`.trim();
        return {
          projection: fromSnapshot(snapshot),
          warning: fallbackWarning,
          snapshotFallback: true
        };
      }
    }
    if (snapshot) {
      const snapshotWarning =
        warning ??
        `No replayable runtime events were available from ${this.eventsPath}. Fell back to ${this.snapshotPath}.`;
      return {
        projection: fromSnapshot(snapshot),
        warning: snapshotWarning,
        snapshotFallback: true
      };
    }
    throw new Error(`No persisted runtime state found at ${this.rootDir}`);
  }

  async loadProjection(): Promise<RuntimeProjection> {
    const { projection } = await this.loadProjectionWithRecovery();
    return projection;
  }

  async hasEvents(): Promise<boolean> {
    const lines = await readLines(this.eventsPath);
    return lines.length > 0;
  }

  async repairEventLog(): Promise<string | undefined> {
    return this.withEventsLock(() => this.repairEventLogLocked());
  }

  async syncSnapshotFromEventsWithRecovery(): Promise<{
    projection: RuntimeProjection;
    warning?: string;
  }> {
    return this.withEventsLock(async () => {
      const repairWarning = await this.repairEventLogLocked();
      const recovered = await this.loadProjectionWithRecovery();
      const projection = recovered.projection;
      await this.writeSnapshot(toSnapshot(projection));
      const warning = [repairWarning, recovered.warning].filter(Boolean).join(" ").trim();
      return warning ? { projection, warning } : { projection };
    });
  }

  async syncSnapshotFromEvents(): Promise<RuntimeProjection> {
    const { projection } = await this.syncSnapshotFromEventsWithRecovery();
    return projection;
  }

  private async withEventsLock<T>(action: () => Promise<T>): Promise<T> {
    return withPathLock(this.eventsPath, action);
  }

  private async repairEventLogLocked(): Promise<string | undefined> {
    const { events, warning } = await this.loadReplayableEvents();
    if (!warning) {
      return undefined;
    }
    if (await this.loadSnapshot()) {
      return undefined;
    }
    if (events.length === 0) {
      return undefined;
    }
    if (events[0]?.type !== "runtime.initialized") {
      return undefined;
    }
    const config = await this.loadConfig();
    if (!config) {
      throw new Error(`Coortex runtime is not initialized at ${this.rootDir}`);
    }
    try {
      projectRuntimeState(config.sessionId, config.rootPath, config.adapter, events);
    } catch {
      return undefined;
    }
    const content = events.map((event) => JSON.stringify(event)).join("\n");
    await writeTextAtomic(this.eventsPath, content.length > 0 ? `${content}\n` : "");
    return `${warning} Rewrote ${this.eventsPath} with ${events.length} replayable event(s).`;
  }

  async readJsonArtifact<T>(relativePath: string, label: string): Promise<T | undefined> {
    return readJsonFile<T>(join(this.rootDir, relativePath), label);
  }

  async readTextArtifact(relativePath: string, _label: string): Promise<string | undefined> {
    return readTextFile(join(this.rootDir, relativePath));
  }

  async claimTextArtifact(relativePath: string, content: string): Promise<string> {
    const fullPath = join(this.rootDir, relativePath);
    await writeTextExclusive(fullPath, content);
    return fullPath;
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
}

export { toPrettyJson };

function replayEventsAfterSnapshot(
  snapshot: RuntimeSnapshot,
  events: RuntimeEvent[]
): RuntimeProjection | undefined {
  if (!snapshot.lastEventId) {
    return undefined;
  }
  const snapshotIndex = events.findIndex((event) => event.eventId === snapshot.lastEventId);
  if (snapshotIndex === -1) {
    return undefined;
  }
  const projection = fromSnapshot(snapshot);
  for (const event of events.slice(snapshotIndex + 1)) {
    applyRuntimeEvent(projection, event);
  }
  return projection;
}

function isMissingError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
