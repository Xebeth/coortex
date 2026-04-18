import type { RuntimeConfig } from "../config/types.js";
import type { RuntimeEvent } from "../core/events.js";
import type { RuntimeProjection, RuntimeSnapshot } from "../core/types.js";
import { parseJson } from "../utils/json.js";
import {
  applyRuntimeEventsToProjection,
  fromSnapshot,
  projectRuntimeState,
  toSnapshot
} from "../projections/runtime-projection.js";
import { isRuntimeAuthorityIntegrityError } from "../projections/attachment-claim-queries.js";

export interface ReplayableRuntimeEvents {
  events: RuntimeEvent[];
  warning?: string;
  malformedLines: number[];
}

export interface ProjectionRecoveryResult {
  projection: RuntimeProjection;
  warning?: string;
  snapshotFallback: boolean;
}

export interface ProjectionSyncResult {
  projection: RuntimeProjection;
  warning?: string;
}

export interface ProjectionRecoveryStore {
  readonly rootDir: string;
  readonly eventsPath: string;
  readonly snapshotPath: string;
  loadConfig(): Promise<RuntimeConfig | undefined>;
  loadSnapshot(): Promise<RuntimeSnapshot | undefined>;
  writeSnapshot(snapshot: RuntimeSnapshot): Promise<void>;
  loadEventLines(): Promise<string[]>;
  rewriteEventLog(events: RuntimeEvent[]): Promise<void>;
  withEventsLock<T>(action: () => Promise<T>): Promise<T>;
  withSnapshotLock<T>(action: () => Promise<T>): Promise<T>;
}

export class ProjectionRecoveryService {
  constructor(private readonly store: ProjectionRecoveryStore) {}

  async loadReplayableEvents(): Promise<ReplayableRuntimeEvents> {
    const lines = await this.store.loadEventLines();
    const events: RuntimeEvent[] = [];
    const warnings: string[] = [];
    const malformedLines: number[] = [];

    for (const [index, line] of lines.entries()) {
      try {
        events.push(this.parseRuntimeEvent(line, index));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        malformedLines.push(index + 1);
        warnings.push(
          `Event replay skipped malformed line ${index + 1} in ${this.store.eventsPath}. ${message}`
        );
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

  async rebuildProjection(): Promise<RuntimeProjection> {
    const config = await this.loadRuntimeConfig();
    const events = await this.loadStrictEvents();
    return projectRuntimeState(config.sessionId, config.rootPath, config.adapter, events);
  }

  async loadProjectionWithRecovery(): Promise<ProjectionRecoveryResult> {
    const snapshot = await this.store.loadSnapshot();
    const { events, warning } = await this.loadReplayableEvents();
    const fallbackToSnapshot = (reason: string): ProjectionRecoveryResult => ({
      projection: fromSnapshot(snapshot!),
      warning: [warning, reason].filter(Boolean).join(" ").trim(),
      snapshotFallback: true
    });
    const replayAfterSnapshot = () => {
      try {
        return {
          replayed: replayEventsAfterSnapshot(snapshot!, events)
        };
      } catch (error) {
        if (isRuntimeAuthorityIntegrityError(error)) {
          throw error;
        }
        const detail = error instanceof Error ? error.message : String(error);
        return {
          fallback: fallbackToSnapshot(
            `Event replay after ${this.store.snapshotPath} could not rebuild runtime state; fell back to ${this.store.snapshotPath}. ${detail}`
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
          warning: `${warning} Rebuilt runtime state from ${this.store.snapshotPath} plus replayable events after ${snapshot.lastEventId ?? "the snapshot boundary"}.`,
          snapshotFallback: false
        };
      }
      return fallbackToSnapshot(
        `Fell back to ${this.store.snapshotPath} to avoid rewriting rolled-back salvaged state.`
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
            `${this.store.eventsPath} no longer contains snapshot boundary ${snapshot.lastEventId}. Fell back to ${this.store.snapshotPath} to avoid replacing newer durable state.`
          );
        }
      }

      if (events[0]?.type !== "runtime.initialized") {
        const message = `${this.store.eventsPath} no longer starts at runtime.initialized.`;
        if (snapshot) {
          return fallbackToSnapshot(
            `Event replay could not rebuild runtime state because ${message} Fell back to ${this.store.snapshotPath} to avoid replacing newer durable state.`
          );
        }
        throw new Error(
          `Event replay could not rebuild runtime state from replayable events because ${message}`
        );
      }

      const config = await this.loadRuntimeConfig();
      try {
        const projection = projectRuntimeState(config.sessionId, config.rootPath, config.adapter, events);
        return warning ? { projection, warning, snapshotFallback: false } : { projection, snapshotFallback: false };
      } catch (error) {
        if (isRuntimeAuthorityIntegrityError(error)) {
          throw error;
        }
        if (!snapshot) {
          throw error;
        }
        const detail = error instanceof Error ? error.message : String(error);
        const fallbackWarning = `${warning ?? ""} Event replay could not rebuild runtime state; fell back to ${this.store.snapshotPath}. ${detail}`.trim();
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
        `No replayable runtime events were available from ${this.store.eventsPath}. Fell back to ${this.store.snapshotPath}.`;
      return {
        projection: fromSnapshot(snapshot),
        warning: snapshotWarning,
        snapshotFallback: true
      };
    }

    throw new Error(`No persisted runtime state found at ${this.store.rootDir}`);
  }

  async loadProjection(): Promise<RuntimeProjection> {
    const { projection } = await this.loadProjectionWithRecovery();
    return projection;
  }

  async repairEventLog(): Promise<string | undefined> {
    return this.store.withEventsLock(() => this.repairEventLogLocked());
  }

  async syncSnapshotFromEventsWithRecovery(): Promise<ProjectionSyncResult> {
    const initialSnapshotFingerprint = snapshotFingerprint(await this.store.loadSnapshot());
    return this.store.withEventsLock(async () => {
      return this.store.withSnapshotLock(async () => {
        const repairWarning = await this.repairEventLogLocked();
        const recovered = await this.loadProjectionWithRecovery();
        const latestSnapshot = await this.store.loadSnapshot();
        if (
          latestSnapshot &&
          snapshotFingerprint(latestSnapshot) !== initialSnapshotFingerprint
        ) {
          const warning = [repairWarning, recovered.warning].filter(Boolean).join(" ").trim();
          return warning
            ? { projection: fromSnapshot(latestSnapshot), warning }
            : { projection: fromSnapshot(latestSnapshot) };
        }
        await this.store.writeSnapshot(toSnapshot(recovered.projection));
        const warning = [repairWarning, recovered.warning].filter(Boolean).join(" ").trim();
        return warning ? { projection: recovered.projection, warning } : { projection: recovered.projection };
      });
    });
  }

  async syncSnapshotFromEvents(): Promise<RuntimeProjection> {
    const { projection } = await this.syncSnapshotFromEventsWithRecovery();
    return projection;
  }

  private async repairEventLogLocked(): Promise<string | undefined> {
    const { events, warning } = await this.loadReplayableEvents();
    if (!warning) {
      return undefined;
    }
    if (await this.store.loadSnapshot()) {
      return undefined;
    }
    if (events.length === 0) {
      return undefined;
    }
    if (events[0]?.type !== "runtime.initialized") {
      return undefined;
    }

    const config = await this.loadRuntimeConfig();
    try {
      projectRuntimeState(config.sessionId, config.rootPath, config.adapter, events);
    } catch {
      return undefined;
    }

    await this.store.rewriteEventLog(events);
    return `${warning} Rewrote ${this.store.eventsPath} with ${events.length} replayable event(s).`;
  }

  private async loadRuntimeConfig(): Promise<RuntimeConfig> {
    const config = await this.store.loadConfig();
    if (!config) {
      throw new Error(`Coortex runtime is not initialized at ${this.store.rootDir}`);
    }
    return config;
  }

  private async loadStrictEvents(): Promise<RuntimeEvent[]> {
    const lines = await this.store.loadEventLines();
    return lines.map((line, index) => this.parseRuntimeEvent(line, index));
  }

  private parseRuntimeEvent(line: string, index: number): RuntimeEvent {
    return parseJson<RuntimeEvent>(line, `runtime event ${index + 1} from ${this.store.eventsPath}`);
  }
}

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
  return applyRuntimeEventsToProjection(fromSnapshot(snapshot), events.slice(snapshotIndex + 1));
}

function snapshotFingerprint(snapshot: RuntimeSnapshot | undefined): string {
  return snapshot ? JSON.stringify(snapshot) : "<missing>";
}
