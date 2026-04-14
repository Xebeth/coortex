import type { RuntimeEvent } from "../core/events.js";
import type { RuntimeProjection, RuntimeStatus } from "../core/types.js";
import {
  applyWorkflowEvent,
  syncWorkflowModuleState,
  type WorkflowRuntimeEvent
} from "./workflow-event-apply.js";

const EMPTY_STATUS: RuntimeStatus = {
  activeMode: "idle",
  currentObjective: "No active objective.",
  activeAssignmentIds: [],
  activeHost: "unknown",
  activeAdapter: "unknown",
  lastDurableOutputAt: "",
  resumeReady: false
};

export function createEmptyProjection(
  sessionId: string,
  rootPath: string,
  adapter: string
): RuntimeProjection {
  return {
    sessionId,
    rootPath,
    adapter,
    status: { ...EMPTY_STATUS, activeAdapter: adapter },
    assignments: new Map(),
    results: new Map(),
    decisions: new Map()
  };
}

export function applyRuntimeEvent(
  projection: RuntimeProjection,
  event: RuntimeEvent
): RuntimeProjection {
  projection.lastEventId = event.eventId;

  switch (event.type) {
    case "assignment.created":
      projection.assignments.set(event.payload.assignment.id, event.payload.assignment);
      syncWorkflowModuleState(projection, event.payload.assignment.id);
      break;
    case "assignment.updated": {
      const current = projection.assignments.get(event.payload.assignmentId);
      if (!current) {
        throw new Error(`Cannot update missing assignment ${event.payload.assignmentId}`);
      }
      projection.assignments.set(event.payload.assignmentId, {
        ...current,
        ...event.payload.patch
      });
      syncWorkflowModuleState(projection, event.payload.assignmentId);
      break;
    }
    case "result.submitted":
      projection.results.set(event.payload.result.resultId, event.payload.result);
      break;
    case "decision.created":
      projection.decisions.set(event.payload.decision.decisionId, event.payload.decision);
      syncWorkflowModuleState(projection, event.payload.decision.assignmentId);
      break;
    case "decision.resolved": {
      const current = projection.decisions.get(event.payload.decisionId);
      if (!current) {
        throw new Error(`Cannot resolve missing decision ${event.payload.decisionId}`);
      }
      projection.decisions.set(event.payload.decisionId, {
        ...current,
        state: "resolved",
        resolvedAt: event.payload.resolvedAt,
        resolutionSummary: event.payload.resolutionSummary
      });
      syncWorkflowModuleState(projection, current.assignmentId);
      break;
    }
    case "workflow.initialized":
    case "workflow.artifact.claimed":
    case "workflow.gate.recorded":
    case "workflow.transition.applied":
      applyWorkflowEvent(projection, event as WorkflowRuntimeEvent);
      break;
    case "status.updated":
      projection.status = event.payload.status;
      break;
  }

  return projection;
}
