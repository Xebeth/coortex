import type { RuntimeEvent } from "../core/events.js";
import type { RuntimeProjection } from "../core/types.js";
import { applyRuntimeEventsToProjection as applyRuntimeEventsToProjectionShared } from "../projections/runtime-projection.js";
import { RuntimeStore } from "../persistence/store.js";

export interface ProjectionWriteOptions {
  snapshotFallback?: boolean;
}

export function applyRuntimeEventsToProjection(
  projection: RuntimeProjection,
  events: RuntimeEvent[]
): RuntimeProjection {
  return applyRuntimeEventsToProjectionShared(projection, events);
}

export async function persistProjectionEvents(
  store: RuntimeStore,
  projection: RuntimeProjection,
  events: RuntimeEvent[],
  options?: ProjectionWriteOptions
): Promise<{
  projection: RuntimeProjection;
  warning?: string;
}> {
  if (!options?.snapshotFallback) {
    await store.appendEvents(events);
    return store.syncSnapshotFromEventsWithRecovery();
  }

  return {
    projection: await store.mutateSnapshotProjection((latestProjection) =>
      applyRuntimeEventsToProjection(latestProjection, events)
    )
  };
}
