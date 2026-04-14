import type { RuntimeEvent } from "../core/events.js";
import type { RuntimeProjection } from "../core/types.js";
import { applyRuntimeEvent, createEmptyProjection } from "./runtime-event-apply.js";
import { fromSnapshot, toSnapshot } from "./runtime-snapshot.js";

export { applyRuntimeEvent, createEmptyProjection, fromSnapshot, toSnapshot };

export function projectRuntimeState(
  sessionId: string,
  rootPath: string,
  adapter: string,
  events: RuntimeEvent[]
): RuntimeProjection {
  const projection = createEmptyProjection(sessionId, rootPath, adapter);
  for (const event of events) {
    applyRuntimeEvent(projection, event);
  }
  return projection;
}
