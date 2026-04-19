import type {
  Assignment,
  DecisionPacket,
  ResultPacket,
  RuntimeProjection,
  WorkflowProgressRecord
} from "../core/types.js";

export interface WorkflowStaleRunFact {
  assignmentId: string;
  staleAt: string;
}

export type WorkflowPreGateLane =
  | {
      kind: "none";
    }
  | {
      kind: "blocked_decision";
      decision: DecisionPacket;
    }
  | {
      kind: "rerun_stale";
      staleFact: WorkflowStaleRunFact;
    }
  | {
      kind: "rerun_resolved_decision";
      decision: DecisionPacket;
    }
  | {
      kind: "evaluate_gate";
      result: ResultPacket;
      currentCycleStartAt: string;
    };

export function selectWorkflowProgressionLane(
  projection: RuntimeProjection,
  progress: WorkflowProgressRecord,
  currentAssignment: Assignment,
  staleRunFacts?: WorkflowStaleRunFact[]
): WorkflowPreGateLane {
  const attemptStartedAt = currentAttemptStartedAt(progress);
  const attemptLowerBound = currentAttemptLowerBound(progress);
  const openDecision = findLatestDecision(projection, currentAssignment.id, attemptLowerBound, "open");
  if (openDecision) {
    return {
      kind: "blocked_decision",
      decision: openDecision
    };
  }

  const staleFact = findApplicableStaleRunFact(
    progress,
    currentAssignment.id,
    attemptStartedAt,
    staleRunFacts
  );
  if (staleFact) {
    return {
      kind: "rerun_stale",
      staleFact
    };
  }

  const resolvedDecision = findLatestDecision(
    projection,
    currentAssignment.id,
    attemptLowerBound,
    "resolved"
  );
  if (
    resolvedDecision &&
    (currentAssignment.state === "blocked" || progress.lastGate?.gateOutcome === "blocked")
  ) {
    return {
      kind: "rerun_resolved_decision",
      decision: resolvedDecision
    };
  }

  const result = findLatestTerminalResult(projection, currentAssignment.id, attemptLowerBound);
  if (!result) {
    return { kind: "none" };
  }

  return {
    kind: "evaluate_gate",
    result,
    currentCycleStartAt: currentCycleStartedAt(progress)
  };
}

function findApplicableStaleRunFact(
  progress: WorkflowProgressRecord,
  assignmentId: string,
  attemptStartedAt: string,
  staleRunFacts: WorkflowStaleRunFact[] | undefined
): WorkflowStaleRunFact | undefined {
  return staleRunFacts?.find((fact) => {
    if (fact.assignmentId !== assignmentId || fact.staleAt < attemptStartedAt) {
      return false;
    }
    return !hasConsumedStaleRunFact(progress, assignmentId, fact.staleAt);
  });
}

function hasConsumedStaleRunFact(
  progress: WorkflowProgressRecord,
  assignmentId: string,
  staleAt: string
): boolean {
  const lastTransition = progress.lastTransition;
  if (!lastTransition) {
    return false;
  }
  return (
    lastTransition.transition === "rerun_same_module" &&
    lastTransition.toModuleId === progress.currentModuleId &&
    lastTransition.workflowCycle === progress.workflowCycle &&
    lastTransition.moduleAttempt === progress.currentModuleAttempt &&
    lastTransition.previousAssignmentId === assignmentId &&
    lastTransition.nextAssignmentId === assignmentId &&
    lastTransition.appliedAt >= staleAt
  );
}

function currentAttemptStartedAt(progress: WorkflowProgressRecord): string {
  return progress.modules[progress.currentModuleId]?.enteredAt
    ?? progress.lastTransition?.appliedAt
    ?? "";
}

function currentAttemptLowerBound(progress: WorkflowProgressRecord): string {
  return progress.currentModuleAttempt > 1 ? currentAttemptStartedAt(progress) : "";
}

function currentCycleStartedAt(progress: WorkflowProgressRecord): string {
  const entries = Object.values(progress.modules)
    .filter((module) => module.workflowCycle === progress.workflowCycle)
    .map((module) => module.enteredAt)
    .filter((value) => value.length > 0)
    .sort((left, right) => left.localeCompare(right));
  return entries[0] ?? currentAttemptStartedAt(progress);
}

function findLatestTerminalResult(
  projection: RuntimeProjection,
  assignmentId: string,
  attemptLowerBound: string
): ResultPacket | undefined {
  return findLatestAssignmentRecord(
    projection.results.values(),
    assignmentId,
    attemptLowerBound,
    (result) => result.createdAt,
    (result) => result.status === "completed" || result.status === "failed"
  );
}

function findLatestDecision(
  projection: RuntimeProjection,
  assignmentId: string,
  attemptLowerBound: string,
  state: DecisionPacket["state"]
): DecisionPacket | undefined {
  return findLatestAssignmentRecord(
    projection.decisions.values(),
    assignmentId,
    attemptLowerBound,
    (decision) => state === "resolved" ? decision.resolvedAt ?? decision.createdAt : decision.createdAt,
    (decision) => decision.state === state
  );
}

function findLatestAssignmentRecord<T extends { assignmentId: string }>(
  records: Iterable<T>,
  assignmentId: string,
  attemptLowerBound: string,
  timestampOf: (record: T) => string,
  predicate: (record: T) => boolean
): T | undefined {
  return [...records]
    .filter(
      (record) =>
        record.assignmentId === assignmentId &&
        timestampOf(record) >= attemptLowerBound &&
        predicate(record)
    )
    .sort((left, right) => timestampOf(left).localeCompare(timestampOf(right)))
    .at(-1);
}
