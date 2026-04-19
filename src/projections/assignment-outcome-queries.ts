import type { DecisionPacket, ResultPacket, RuntimeProjection } from "../core/types.js";

interface AssignmentDecisionQueryOptions {
  state?: DecisionPacket["state"];
  createdAtOnOrAfter?: string;
}

interface AssignmentResultQueryOptions {
  statuses?: ResultPacket["status"][];
  createdAtOnOrAfter?: string;
}

export function listAssignmentDecisions(
  projection: RuntimeProjection,
  assignmentId: string,
  options: AssignmentDecisionQueryOptions = {}
): DecisionPacket[] {
  return [...projection.decisions.values()]
    .filter((decision) => decision.assignmentId === assignmentId)
    .filter((decision) => options.state === undefined || decision.state === options.state)
    .filter(
      (decision) =>
        options.createdAtOnOrAfter === undefined ||
        decision.createdAt >= options.createdAtOnOrAfter
    )
    .sort(compareByCreatedAt);
}

export function findLatestAssignmentDecision(
  projection: RuntimeProjection,
  assignmentId: string,
  options: AssignmentDecisionQueryOptions = {}
): DecisionPacket | undefined {
  return listAssignmentDecisions(projection, assignmentId, options).at(-1);
}

export function findLatestOpenAssignmentDecision(
  projection: RuntimeProjection,
  assignmentId: string,
  options: Omit<AssignmentDecisionQueryOptions, "state"> = {}
): DecisionPacket | undefined {
  return findLatestAssignmentDecision(projection, assignmentId, {
    ...options,
    state: "open"
  });
}

export function listAssignmentResults(
  projection: RuntimeProjection,
  assignmentId: string,
  options: AssignmentResultQueryOptions = {}
): ResultPacket[] {
  return [...projection.results.values()]
    .filter((result) => result.assignmentId === assignmentId)
    .filter(
      (result) => options.statuses === undefined || options.statuses.includes(result.status)
    )
    .filter(
      (result) =>
        options.createdAtOnOrAfter === undefined ||
        result.createdAt >= options.createdAtOnOrAfter
    )
    .sort(compareByCreatedAt);
}

export function findLatestTerminalAssignmentResult(
  projection: RuntimeProjection,
  assignmentId: string,
  options: Omit<AssignmentResultQueryOptions, "statuses"> = {}
): ResultPacket | undefined {
  return listAssignmentResults(projection, assignmentId, {
    ...options,
    statuses: ["completed", "failed"]
  }).at(-1);
}

export function listOpenDecisions(projection: RuntimeProjection): DecisionPacket[] {
  return [...projection.decisions.values()]
    .filter((decision) => decision.state === "open")
    .sort(compareByCreatedAt);
}

export function listRecentResults(
  projection: RuntimeProjection,
  limit = 3
): ResultPacket[] {
  return [...projection.results.values()]
    .sort(compareByCreatedAtDescending)
    .slice(0, limit);
}

function compareByCreatedAt<T extends { createdAt: string }>(left: T, right: T): number {
  return left.createdAt.localeCompare(right.createdAt);
}

function compareByCreatedAtDescending<T extends { createdAt: string }>(left: T, right: T): number {
  return right.createdAt.localeCompare(left.createdAt);
}
