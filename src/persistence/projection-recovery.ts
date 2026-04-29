import type { RuntimeConfig } from "../config/types.js";
import type { RuntimeEvent } from "../core/events.js";
import { isRunLeaseExpired } from "../core/run-state.js";
import type { HostRunRecord, RuntimeProjection, RuntimeSnapshot } from "../core/types.js";
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

export interface ProjectionPersistenceHandle {
  persistEvents(events: RuntimeEvent[]): Promise<ProjectionSyncResult>;
  syncProjection(): Promise<ProjectionSyncResult>;
  hydrateProjection(projection: RuntimeProjection): ProjectionHydrationResult;
  hydrateMissingAssignment(
    projection: RuntimeProjection,
    assignmentId: string
  ): ProjectionHydrationResult;
  loadCompletedRecoveryProofEvents(): Promise<RuntimeEvent[] | undefined>;
  reportsCompletedRecoveryWithoutEvents(): boolean;
  shouldEmitAlreadyReconciledStaleRunSuccess(cleanupSource: HostRunRecord): boolean;
}

export interface ProjectionRecoveryResult {
  projection: RuntimeProjection;
  warning?: string;
  persistence: ProjectionPersistenceHandle;
}

export interface ProjectionSyncResult {
  projection: RuntimeProjection;
  warning?: string;
}

export interface ProjectionHydrationResult {
  projection: RuntimeProjection;
  hydrated: boolean;
}

export interface ProjectionRecoveryStore {
  readonly rootDir: string;
  readonly eventsPath: string;
  readonly snapshotPath: string;
  loadConfig(): Promise<RuntimeConfig | undefined>;
  loadSnapshot(): Promise<RuntimeSnapshot | undefined>;
  writeSnapshot(snapshot: RuntimeSnapshot): Promise<void>;
  writeProjectionSnapshot(
    projection: RuntimeProjection,
    options?: {
      boundaryEventId?: string | undefined;
    }
  ): Promise<RuntimeProjection>;
  loadEventLines(): Promise<string[]>;
  appendEvents(events: RuntimeEvent[]): Promise<void>;
  rewriteEventLog(events: RuntimeEvent[]): Promise<void>;
  withEventsLock<T>(action: () => Promise<T>): Promise<T>;
  withSnapshotLock<T>(action: () => Promise<T>): Promise<T>;
}

type ProjectionRecoveryWarningBearingError = Error & {
  projectionRecoveryWarning?: string;
};

type ProjectionWriteStrategy = "event-log" | "snapshot-fallback";

type ProjectionRecoveryState = {
  projection: RuntimeProjection;
  warning?: string;
  strategy: ProjectionWriteStrategy;
};

type ProjectionRecoveryArtifacts = {
  snapshot: RuntimeSnapshot | undefined;
  replayableEvents: ReplayableRuntimeEvents;
  recovered: ProjectionRecoveryState;
};

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
    const { snapshot, replayableEvents, recovered } = await this.loadProjectionRecoveryArtifacts();
    const persistence = this.buildProjectionPersistenceHandle(
      recovered.strategy,
      replayableEvents.events,
      snapshot?.lastEventId
    );
    return recovered.warning
      ? {
          projection: recovered.projection,
          warning: recovered.warning,
          persistence
        }
      : {
          projection: recovered.projection,
          persistence
        };
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
        const { recovered } = await this.loadProjectionRecoveryArtifacts();
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

  hydrateProjectionFromReplayableEvents(
    projection: RuntimeProjection,
    replayableEvents?: RuntimeEvent[],
    snapshotBoundaryEventId?: string
  ): ProjectionHydrationResult {
    const hydrationEvents = snapshotBoundaryEventId
      ? selectReplayableSuffixEvents(replayableEvents, snapshotBoundaryEventId)
      : replayableEvents;
    if (!hydrationEvents || hydrationEvents.length === 0) {
      return {
        projection,
        hydrated: false
      };
    }

    try {
      return {
        projection: applyRuntimeEventsToProjection(projection, hydrationEvents),
        hydrated: true
      };
    } catch (error) {
      if (isRuntimeAuthorityIntegrityError(error)) {
        throw error;
      }
      return {
        projection,
        hydrated: false
      };
    }
  }

  hydrateMissingAssignmentFromReplayableEvents(
    projection: RuntimeProjection,
    assignmentId: string,
    replayableEvents?: RuntimeEvent[],
    snapshotBoundaryEventId?: string
  ): ProjectionHydrationResult {
    if (!replayableEvents || replayableEvents.length === 0) {
      return {
        projection,
        hydrated: false
      };
    }

    const suffixEvents = snapshotBoundaryEventId
      ? selectReplayableSuffixEvents(replayableEvents, snapshotBoundaryEventId)
      : undefined;
    if (
      !suffixEvents ||
      !suffixEvents.some(
        (event): event is Extract<RuntimeEvent, { type: "assignment.created" }> =>
          event.type === "assignment.created" && event.payload.assignment.id === assignmentId
      )
    ) {
      return {
        projection,
        hydrated: false
      };
    }

    try {
      return {
        projection: applyRuntimeEventsToProjection(projection, suffixEvents),
        hydrated: true
      };
    } catch (error) {
      if (isRuntimeAuthorityIntegrityError(error)) {
        throw error;
      }
      return {
        projection,
        hydrated: false
      };
    }
  }

  async syncProjectionSnapshot(): Promise<ProjectionSyncResult> {
    const persistence = await this.createProjectionPersistenceHandle();
    return persistence.syncProjection();
  }

  async applyRecoveryProjectionEvents(
    events: RuntimeEvent[]
  ): Promise<ProjectionSyncResult> {
    const persistence = await this.createProjectionPersistenceHandle();
    return persistence.persistEvents(events);
  }

  async createProjectionPersistenceHandle(): Promise<ProjectionPersistenceHandle> {
    const { snapshot, replayableEvents, recovered } = await this.loadProjectionRecoveryArtifacts();
    return this.buildProjectionPersistenceHandle(
      recovered.strategy,
      replayableEvents.events,
      snapshot?.lastEventId
    );
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

  private async loadProjectionRecoveryArtifacts(): Promise<ProjectionRecoveryArtifacts> {
    const snapshot = await this.store.loadSnapshot();
    const replayableEvents = await this.loadReplayableEvents();
    return {
      snapshot,
      replayableEvents,
      recovered: await this.loadProjectionRecoveryState(snapshot, replayableEvents)
    };
  }

  private async loadProjectionRecoveryState(
    snapshot: RuntimeSnapshot | undefined,
    replayableEvents: ReplayableRuntimeEvents
  ): Promise<ProjectionRecoveryState> {
    const { events, warning } = replayableEvents;
    const fallbackToSnapshot = (reason: string): ProjectionRecoveryState => {
      const recoveryWarning = [warning, reason].filter(Boolean).join(" ").trim();
      try {
        return {
          projection: fromSnapshot(snapshot!),
          warning: recoveryWarning,
          strategy: "snapshot-fallback"
        };
      } catch (error) {
        throw attachProjectionRecoveryWarning(error, recoveryWarning);
      }
    };
    const replayAfterSnapshot = () => {
      try {
        return {
          replayed: replayEventsAfterSnapshot(snapshot!, events)
        };
      } catch (error) {
        if (isRuntimeAuthorityIntegrityError(error)) {
          throw attachProjectionRecoveryWarning(error, warning);
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
          strategy: "event-log"
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
            ? { projection: replayAttempt.replayed, warning, strategy: "event-log" }
            : { projection: replayAttempt.replayed, strategy: "event-log" };
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
        const projection = projectRuntimeState(
          config.sessionId,
          config.rootPath,
          config.adapter,
          events
        );
        return warning
          ? { projection, warning, strategy: "event-log" }
          : { projection, strategy: "event-log" };
      } catch (error) {
        if (isRuntimeAuthorityIntegrityError(error)) {
          throw attachProjectionRecoveryWarning(error, warning);
        }
        if (!snapshot) {
          throw error;
        }
        const detail = error instanceof Error ? error.message : String(error);
        const fallbackWarning = `${warning ?? ""} Event replay could not rebuild runtime state; fell back to ${this.store.snapshotPath}. ${detail}`.trim();
        return {
          projection: fromSnapshot(snapshot),
          warning: fallbackWarning,
          strategy: "snapshot-fallback"
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
        strategy: "snapshot-fallback"
      };
    }

    throw new Error(`No persisted runtime state found at ${this.store.rootDir}`);
  }

  private buildProjectionPersistenceHandle(
    strategy: ProjectionWriteStrategy,
    replayableEvents: RuntimeEvent[],
    snapshotBoundaryEventId: string | undefined
  ): ProjectionPersistenceHandle {
    return {
      persistEvents: async (events) => {
        if (events.length === 0) {
          return strategy === "snapshot-fallback"
            ? this.mutateSnapshotFallbackProjection((latestProjection) => latestProjection)
            : this.syncSnapshotFromEventsWithRecovery();
        }
        if (strategy === "event-log") {
          await this.store.appendEvents(events);
          return this.syncSnapshotFromEventsWithRecovery();
        }
        return this.mutateSnapshotFallbackProjection((latestProjection) =>
          applyRuntimeEventsToProjection(latestProjection, events)
        );
      },
      syncProjection: async () =>
        strategy === "snapshot-fallback"
          ? this.mutateSnapshotFallbackProjection((latestProjection) => latestProjection)
          : this.syncSnapshotFromEventsWithRecovery(),
      hydrateProjection: (projection) =>
        strategy === "snapshot-fallback"
          ? this.hydrateProjectionFromReplayableEvents(
              projection,
              replayableEvents,
              snapshotBoundaryEventId
            )
          : {
              projection,
              hydrated: false
            },
      hydrateMissingAssignment: (projection, assignmentId) =>
        strategy === "snapshot-fallback"
          ? this.hydrateMissingAssignmentFromReplayableEvents(
              projection,
              assignmentId,
              replayableEvents,
              snapshotBoundaryEventId
            )
          : {
              projection,
              hydrated: false
            },
      loadCompletedRecoveryProofEvents: async () => {
        if (strategy !== "snapshot-fallback") {
          return replayableEvents;
        }
        const latestSnapshot = await this.store.loadSnapshot();
        if (!latestSnapshot) {
          return undefined;
        }
        const suffixEvents = selectReplayableSuffixEvents(
          replayableEvents,
          snapshotBoundaryEventId ?? ""
        );
        if (!suffixEvents || suffixEvents.length === 0) {
          return suffixEvents;
        }
        const hydrated = this.hydrateProjectionFromReplayableEvents(
          fromSnapshot(latestSnapshot),
          replayableEvents,
          latestSnapshot.lastEventId
        );
        return hydrated.hydrated ? suffixEvents : undefined;
      },
      reportsCompletedRecoveryWithoutEvents: () => strategy === "snapshot-fallback",
      shouldEmitAlreadyReconciledStaleRunSuccess: (cleanupSource) =>
        strategy === "event-log" && isStaleRunCleanupRecord(cleanupSource)
    };
  }

  private async mutateSnapshotFallbackProjection(
    mutate: (projection: RuntimeProjection) => RuntimeProjection | Promise<RuntimeProjection>
  ): Promise<ProjectionSyncResult> {
    return this.store.withEventsLock(async () =>
      this.store.withSnapshotLock(async () => {
        const latestSnapshot = await this.store.loadSnapshot();
        if (!latestSnapshot) {
          throw new Error("Snapshot-fallback reconciliation requires a durable snapshot.");
        }
        const { events: replayableEvents, warning } = await this.loadReplayableEvents();
        const hydrated = this.hydrateProjectionFromReplayableEvents(
          fromSnapshot(latestSnapshot),
          replayableEvents,
          latestSnapshot.lastEventId
        );
        const nextProjection = await mutate(hydrated.projection);
        const projection = await this.store.writeProjectionSnapshot(nextProjection, {
          boundaryEventId: latestSnapshot.lastEventId
        });
        return warning ? { projection, warning } : { projection };
      })
    );
  }
}

function attachProjectionRecoveryWarning(error: unknown, warning: string | undefined): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (!warning) {
    return normalized;
  }
  const existingWarning = (normalized as ProjectionRecoveryWarningBearingError).projectionRecoveryWarning;
  (normalized as ProjectionRecoveryWarningBearingError).projectionRecoveryWarning = [
    warning,
    existingWarning
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
  return normalized;
}

export function selectReplayableSuffixEvents(
  replayableEvents: RuntimeEvent[] | undefined,
  snapshotBoundaryEventId: string
): RuntimeEvent[] | undefined {
  if (!replayableEvents || replayableEvents.length === 0) {
    return undefined;
  }
  const boundaryIndex = replayableEvents.findIndex((event) => event.eventId === snapshotBoundaryEventId);
  if (boundaryIndex === -1) {
    return undefined;
  }
  return replayableEvents.slice(boundaryIndex + 1);
}

function replayEventsAfterSnapshot(
  snapshot: RuntimeSnapshot,
  events: RuntimeEvent[]
): RuntimeProjection | undefined {
  const suffixEvents = snapshot.lastEventId
    ? selectReplayableSuffixEvents(events, snapshot.lastEventId)
    : undefined;
  if (!suffixEvents) {
    return undefined;
  }
  return applyRuntimeEventsToProjection(fromSnapshot(snapshot), suffixEvents);
}

function snapshotFingerprint(snapshot: RuntimeSnapshot | undefined): string {
  return snapshot ? JSON.stringify(snapshot) : "<missing>";
}

function isStaleRunCleanupRecord(record: HostRunRecord): boolean {
  return (
    (
      record.state === "running" &&
      record.staleReasonCode !== "malformed_lease_artifact" &&
      isRunLeaseExpired(record)
    ) ||
    (record.state === "completed" && Boolean(record.staleReasonCode) && !record.terminalOutcome)
  );
}
