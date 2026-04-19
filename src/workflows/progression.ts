import { randomUUID } from "node:crypto";

import type { RuntimeEvent } from "../core/events.js";
import type {
  Assignment,
  RuntimeProjection,
  RuntimeStatus,
  WorkflowProgressRecord
} from "../core/types.js";
import { nowIso } from "../utils/time.js";
import { DEFAULT_WORKFLOW_ID, DEFAULT_WORKFLOW_MODULE_IDS, getWorkflowModule } from "./registry.js";
import {
  loadClaimedArtifact,
  workflowArtifactPath,
  toProjectRelativeArtifactPath,
  fromProjectRelativeArtifactPath
} from "./progression-artifacts.js";
import {
  buildWorkflowAssignment,
  DEFAULT_WORKFLOW_WRITE_SCOPE
} from "./progression-assignments.js";
import {
  selectWorkflowProgressionLane,
  type WorkflowStaleRunFact
} from "./progression-rules.js";
import {
  buildBlockedDecisionEvents,
  buildCompleteWorkflowEvents,
  buildGatePersistenceEvents,
  buildModuleTransitionEvents,
  buildSameModuleRerunEvents
} from "./progression-transitions.js";
import type {
  WorkflowArtifactStore,
  WorkflowProgressionResult
} from "./types.js";
export {
  workflowArtifactPath,
  toProjectRelativeArtifactPath,
  fromProjectRelativeArtifactPath,
  DEFAULT_WORKFLOW_WRITE_SCOPE
};
export type { WorkflowStaleRunFact };

export interface WorkflowBootstrapOptions {
  sessionId: string;
  adapterId: string;
  host: string;
  objective?: string;
  workflowId?: string;
  assignmentId?: string;
  timestamp?: string;
  inheritedWriteScope?: string[];
}

export interface WorkflowProgressionOptions {
  timestamp?: string;
  staleRunFacts?: WorkflowStaleRunFact[];
}

export function buildWorkflowBootstrap(options: WorkflowBootstrapOptions): {
  initialAssignmentId: string;
  events: RuntimeEvent[];
} {
  const timestamp = options.timestamp ?? nowIso();
  const workflowId = options.workflowId ?? DEFAULT_WORKFLOW_ID;
  const assignmentId = options.assignmentId ?? randomUUID();
  const module = getWorkflowModule("plan");
  const assignment = buildWorkflowAssignment({
    sessionId: options.sessionId,
    adapterId: options.adapterId,
    assignmentId,
    workflowId,
    workflowCycle: 1,
    moduleAttempt: 1,
    moduleId: "plan",
    inheritedWriteScope: options.inheritedWriteScope ?? DEFAULT_WORKFLOW_WRITE_SCOPE,
    timestamp
  });

  return {
    initialAssignmentId: assignmentId,
    events: [
      {
        eventId: randomUUID(),
        sessionId: options.sessionId,
        timestamp,
        type: "workflow.initialized",
        payload: {
          workflowId,
          orderedModuleIds: [...DEFAULT_WORKFLOW_MODULE_IDS],
          currentModuleId: module.id,
          workflowCycle: 1,
          currentModuleAttempt: 1,
          currentAssignmentId: assignmentId,
          initializedAt: timestamp
        }
      },
      {
        eventId: randomUUID(),
        sessionId: options.sessionId,
        timestamp,
        type: "assignment.created",
        payload: { assignment }
      },
      {
        eventId: randomUUID(),
        sessionId: options.sessionId,
        timestamp,
        type: "status.updated",
        payload: {
          status: createBootstrapStatus(options.host, options.adapterId, assignment, timestamp)
        }
      }
    ]
  };
}

export async function evaluateWorkflowProgression(
  projection: RuntimeProjection,
  store: WorkflowArtifactStore,
  options: WorkflowProgressionOptions = {}
): Promise<WorkflowProgressionResult> {
  const progress = projection.workflowProgress;
  if (!progress) {
    return { events: [] };
  }
  const timestamp = options.timestamp ?? nowIso();
  const currentAssignment = getCurrentAssignment(projection, progress);
  if (!currentAssignment) {
    return { events: [] };
  }

  const currentModule = progress.modules[progress.currentModuleId];
  if (!currentModule) {
    return { events: [] };
  }

  const lane = selectWorkflowProgressionLane(
    projection,
    progress,
    currentAssignment,
    options.staleRunFacts
  );
  switch (lane.kind) {
    case "none":
      return { events: [] };
    case "blocked_decision":
      return {
        events: buildBlockedDecisionEvents(
          projection,
          progress,
          currentModule,
          currentAssignment,
          lane.decision,
          timestamp
        )
      };
    case "rerun_stale":
      void lane.staleFact;
      return {
        events: buildSameModuleRerunEvents(
          projection,
          progress,
          currentAssignment,
          timestamp,
          currentModule.gateOutcome === "blocked" ? undefined : currentModule.gateOutcome
        )
      };
    case "rerun_resolved_decision":
      void lane.decision;
      return {
        events: buildSameModuleRerunEvents(projection, progress, currentAssignment, timestamp)
      };
    case "evaluate_gate":
      break;
  }

  const claimedArtifact = await loadClaimedArtifact(
    store,
    progress,
    currentAssignment.id,
    lane.result
  );
  const moduleDefinition = getWorkflowModule(progress.currentModuleId);
  const gateEvaluation = moduleDefinition.evaluateGate({
    projection,
    progress,
    currentModule,
    assignment: currentAssignment,
    result: lane.result,
    artifact: claimedArtifact,
    currentCycleStartAt: lane.currentCycleStartAt
  });
  const events: RuntimeEvent[] = buildGatePersistenceEvents(
    projection,
    progress,
    currentModule,
    currentAssignment,
    gateEvaluation,
    claimedArtifact,
    lane.result,
    timestamp
  );

  switch (gateEvaluation.transition.type) {
    case "rerun_same_module":
      events.push(
        ...buildSameModuleRerunEvents(
          projection,
          progress,
          currentAssignment,
          timestamp,
          gateEvaluation.gateOutcome
        )
      );
      break;
    case "advance":
    case "rewind":
      events.push(
        ...buildModuleTransitionEvents(
          projection,
          progress,
          currentAssignment,
          lane.result.status === "failed" ? "failed" : "completed",
          gateEvaluation.transition.type,
          gateEvaluation.transition.toModuleId,
          gateEvaluation.transition.workflowCycle,
          timestamp
        )
      );
      break;
    case "complete":
      events.push(
        ...buildCompleteWorkflowEvents(
          projection,
          progress,
          currentAssignment,
          lane.result.status === "failed" ? "failed" : "completed",
          timestamp
        )
      );
      break;
  }

  return { events };
}
function createBootstrapStatus(
  host: string,
  adapterId: string,
  assignment: Assignment,
  timestamp: string
): RuntimeStatus {
  return {
    activeMode: "solo",
    currentObjective: `Start plan assignment ${assignment.id}: ${assignment.objective}`,
    activeAssignmentIds: [assignment.id],
    activeHost: host,
    activeAdapter: adapterId,
    lastDurableOutputAt: timestamp,
    resumeReady: true
  };
}

function getCurrentAssignment(
  projection: RuntimeProjection,
  progress: WorkflowProgressRecord
): Assignment | undefined {
  return progress.currentAssignmentId
    ? projection.assignments.get(progress.currentAssignmentId)
    : undefined;
}
