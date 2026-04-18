import type { RuntimeEvent } from "../core/events.js";
import type {
  Assignment,
  AssignmentClaim,
  DecisionPacket,
  ResultPacket,
  RuntimeAttachment,
  RuntimeProvenance,
  RuntimeProjection,
  RuntimeSnapshot,
  RuntimeStatus
} from "../core/types.js";
import { assertAttachmentClaimGraphIntegrity } from "./attachment-claim-queries.js";

const EMPTY_STATUS: RuntimeStatus = {
  activeMode: "idle",
  currentObjective: "No active objective.",
  activeAssignmentIds: [],
  activeHost: "unknown",
  activeAdapter: "unknown",
  lastDurableOutputAt: "",
  resumeReady: false
};

const EMPTY_PROVENANCE: RuntimeProvenance = {};

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
    decisions: new Map(),
    attachments: new Map(),
    claims: new Map(),
    provenance: { ...EMPTY_PROVENANCE }
  };
}

export function applyRuntimeEvent(
  projection: RuntimeProjection,
  event: RuntimeEvent
): RuntimeProjection {
  projection.lastEventId = event.eventId;

  switch (event.type) {
    case "runtime.initialized":
      projection.provenance = {
        ...projection.provenance,
        initializedAt: event.payload.initializedAt
      };
      break;
    case "host.setup.completed":
      projection.provenance = {
        ...projection.provenance,
        hostSetupAt: event.payload.completedAt
      };
      break;
    case "runtime.activated":
      projection.provenance = {
        ...projection.provenance,
        lastActivation: {
          kind: event.payload.kind,
          attachmentId: event.payload.attachmentId,
          assignmentId: event.payload.assignmentId,
          at: event.timestamp
        }
      };
      break;
    case "assignment.created":
      projection.assignments.set(event.payload.assignment.id, event.payload.assignment);
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
      break;
    }
    case "result.submitted":
      projection.results.set(event.payload.result.resultId, event.payload.result);
      break;
    case "decision.created":
      projection.decisions.set(event.payload.decision.decisionId, event.payload.decision);
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
      break;
    }
    case "attachment.created":
      projection.attachments.set(event.payload.attachment.id, event.payload.attachment);
      break;
    case "attachment.updated": {
      const current = projection.attachments.get(event.payload.attachmentId);
      if (!current) {
        throw new Error(`Cannot update missing attachment ${event.payload.attachmentId}`);
      }
      projection.attachments.set(event.payload.attachmentId, {
        ...current,
        ...event.payload.patch
      });
      break;
    }
    case "claim.created":
      projection.claims.set(event.payload.claim.id, event.payload.claim);
      break;
    case "claim.updated": {
      const current = projection.claims.get(event.payload.claimId);
      if (!current) {
        throw new Error(`Cannot update missing claim ${event.payload.claimId}`);
      }
      projection.claims.set(event.payload.claimId, {
        ...current,
        ...event.payload.patch
      });
      break;
    }
    case "status.updated":
      projection.status = event.payload.status;
      break;
  }

  return projection;
}

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
  assertAttachmentClaimGraphIntegrity(projection);
  return projection;
}

export function applyRuntimeEventsToProjection(
  projection: RuntimeProjection,
  events: RuntimeEvent[]
): RuntimeProjection {
  const nextProjection = fromSnapshot(toSnapshot(projection));
  for (const event of events) {
    applyRuntimeEvent(nextProjection, event);
  }
  assertAttachmentClaimGraphIntegrity(nextProjection);
  return nextProjection;
}

export function toSnapshot(projection: RuntimeProjection): RuntimeSnapshot {
  const snapshot: RuntimeSnapshot = {
    version: 1,
    sessionId: projection.sessionId,
    rootPath: projection.rootPath,
    adapter: projection.adapter,
    status: projection.status,
    assignments: sortByTimestamp([...projection.assignments.values()]),
    results: sortByTimestamp([...projection.results.values()]),
    decisions: sortByTimestamp([...projection.decisions.values()]),
    attachments: sortByTimestamp([...projection.attachments.values()]),
    claims: sortByTimestamp([...projection.claims.values()]),
    provenance: { ...projection.provenance }
  };
  if (projection.lastEventId) {
    snapshot.lastEventId = projection.lastEventId;
  }
  return snapshot;
}

export function fromSnapshot(snapshot: RuntimeSnapshot): RuntimeProjection {
  const projection: RuntimeProjection = {
    sessionId: snapshot.sessionId,
    rootPath: snapshot.rootPath,
    adapter: snapshot.adapter,
    status: snapshot.status,
    assignments: new Map(snapshot.assignments.map((assignment) => [assignment.id, assignment])),
    results: new Map(snapshot.results.map((result) => [result.resultId, result])),
    decisions: new Map(snapshot.decisions.map((decision) => [decision.decisionId, decision])),
    attachments: new Map((snapshot.attachments ?? []).map((attachment) => [attachment.id, attachment])),
    claims: new Map((snapshot.claims ?? []).map((claim) => [claim.id, claim])),
    provenance: { ...(snapshot.provenance ?? EMPTY_PROVENANCE) }
  };
  if (snapshot.lastEventId) {
    projection.lastEventId = snapshot.lastEventId;
  }
  assertAttachmentClaimGraphIntegrity(projection);
  return projection;
}

function sortByTimestamp<
  T extends Assignment | ResultPacket | DecisionPacket | RuntimeAttachment | AssignmentClaim
>(values: T[]): T[] {
  return [...values].sort((left, right) => {
    const leftValue =
      "updatedAt" in left
        ? left.updatedAt
        : "resolvedAt" in left && left.resolvedAt
          ? left.resolvedAt
          : left.createdAt;
    const rightValue =
      "updatedAt" in right
        ? right.updatedAt
        : "resolvedAt" in right && right.resolvedAt
          ? right.resolvedAt
          : right.createdAt;
    return leftValue.localeCompare(rightValue);
  });
}
