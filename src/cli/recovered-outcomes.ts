import type {
  HostAdapter,
  HostExecutionOutcome,
  TaskEnvelope
} from "../adapters/contract.js";
import type {
  Assignment,
  DecisionPacket,
  HostRunRecord,
  ResultPacket
} from "../core/types.js";
import { RuntimeStore } from "../persistence/store.js";
import type { CommandDiagnostic } from "./types.js";
import { diagnosticsFromWarning } from "./diagnostics.js";
import { loadWorkflowAwareProjectionWithDiagnostics } from "./runtime-state.js";
import { buildRecoveredExecutionEnvelope } from "./workflow-envelope.js";

type LoadedProjection = Awaited<ReturnType<RuntimeStore["loadProjection"]>>;

export async function synthesizeRecoveredExecutionFromReconciliation(
  store: RuntimeStore,
  adapter: HostAdapter,
  projectionBeforeReconciliation: LoadedProjection,
  projectionAfterReconciliation: LoadedProjection
): Promise<{
  assignment: Assignment;
  envelope: TaskEnvelope;
  execution: HostExecutionOutcome;
} | undefined> {
  const recoveredDecision = findRecoveredDecisionCandidate(
    projectionBeforeReconciliation,
    projectionAfterReconciliation
  );
  if (recoveredDecision) {
    const envelope = await buildRecoveredExecutionEnvelope(
      store,
      adapter,
      projectionAfterReconciliation,
      recoveredDecision.assignment.id
    );
    return {
      assignment: recoveredDecision.assignment,
      envelope,
      execution: synthesizeRecoveredDecisionExecution(
        recoveredDecision.assignment,
        recoveredDecision.decision
      )
    };
  }

  if (projectionAfterReconciliation.status.activeAssignmentIds.length > 0) {
    return undefined;
  }

  const recoveredResult = findRecoveredResultCandidate(
    projectionBeforeReconciliation,
    projectionAfterReconciliation
  );
  if (!recoveredResult) {
    return undefined;
  }
  const envelope = await buildRecoveredExecutionEnvelope(
    store,
    adapter,
    projectionAfterReconciliation,
    recoveredResult.assignment.id
  );

  return {
    assignment: recoveredResult.assignment,
    envelope,
    execution: synthesizeRecoveredResultExecution(
      recoveredResult.assignment,
      recoveredResult.result
    )
  };
}

export function synthesizeRecoveredExecution(
  record: Awaited<ReturnType<HostAdapter["inspectRun"]>>
): HostExecutionOutcome | undefined {
  if (!record || !isRecoverableCompletedRunRecord(record) || !record.terminalOutcome) {
    return undefined;
  }
  if (record.terminalOutcome.kind === "decision") {
    return {
      outcome: {
        kind: "decision",
        capture: {
          assignmentId: record.assignmentId,
          requesterId: record.terminalOutcome.decision.requesterId,
          blockerSummary: record.terminalOutcome.decision.blockerSummary,
          options: record.terminalOutcome.decision.options.map((option) => ({ ...option })),
          recommendedOption: record.terminalOutcome.decision.recommendedOption,
          state: record.terminalOutcome.decision.state,
          createdAt: record.terminalOutcome.decision.createdAt,
          ...(record.terminalOutcome.decision.decisionId
            ? { decisionId: record.terminalOutcome.decision.decisionId }
            : {})
        }
      },
      run: record
    };
  }
  return {
    outcome: {
      kind: "result",
      capture: {
        assignmentId: record.assignmentId,
        producerId: record.terminalOutcome.result.producerId,
        status: record.terminalOutcome.result.status,
        summary: record.terminalOutcome.result.summary,
        changedFiles: [...record.terminalOutcome.result.changedFiles],
        createdAt: record.terminalOutcome.result.createdAt,
        ...(record.terminalOutcome.result.resultId
          ? { resultId: record.terminalOutcome.result.resultId }
          : {})
      }
    },
    run: record
  };
}

export async function recoverPersistedExecutionFromDurableRun(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId: string,
  error: unknown
): Promise<{
  projection: LoadedProjection;
  execution: HostExecutionOutcome;
  diagnostics: CommandDiagnostic[];
} | undefined> {
  const execution = synthesizeRecoveredExecution(
    await adapter.inspectRun(store, assignmentId)
  );
  if (!execution) {
    return undefined;
  }
  const recovered = await loadWorkflowAwareProjectionWithDiagnostics(store, adapter);
  return {
    projection: recovered.projection,
    execution,
    diagnostics: [
      ...diagnosticsFromWarning(
        `Runtime event persistence was interrupted after the host run completed durably. Recovered from durable host run metadata. ${
          error instanceof Error ? error.message : String(error)
        }`,
        "host-run-persist-failed"
      ),
      ...recovered.diagnostics
    ]
  };
}

function synthesizeRecoveredDecisionExecution(
  assignment: Assignment,
  decision: DecisionPacket
): HostExecutionOutcome {
  return {
    outcome: {
      kind: "decision",
      capture: {
        assignmentId: assignment.id,
        requesterId: decision.requesterId,
        blockerSummary: decision.blockerSummary,
        options: decision.options.map((option) => ({ ...option })),
        recommendedOption: decision.recommendedOption,
        state: decision.state,
        createdAt: decision.createdAt,
        decisionId: decision.decisionId
      }
    },
    run: {
      assignmentId: assignment.id,
      state: "completed",
      startedAt: decision.createdAt,
      completedAt: decision.createdAt,
      outcomeKind: "decision",
      summary: decision.blockerSummary,
      terminalOutcome: {
        kind: "decision",
        decision: {
          decisionId: decision.decisionId,
          requesterId: decision.requesterId,
          blockerSummary: decision.blockerSummary,
          options: decision.options.map((option) => ({ ...option })),
          recommendedOption: decision.recommendedOption,
          state: decision.state,
          createdAt: decision.createdAt
        }
      }
    }
  };
}

function synthesizeRecoveredResultExecution(
  assignment: Assignment,
  result: ResultPacket
): HostExecutionOutcome {
  return {
    outcome: {
      kind: "result",
      capture: {
        assignmentId: assignment.id,
        producerId: result.producerId,
        status: result.status,
        summary: result.summary,
        changedFiles: [...result.changedFiles],
        createdAt: result.createdAt,
        resultId: result.resultId
      }
    },
    run: {
      assignmentId: assignment.id,
      state: "completed",
      startedAt: result.createdAt,
      completedAt: result.createdAt,
      outcomeKind: "result",
      resultStatus: result.status,
      summary: result.summary,
      terminalOutcome: {
        kind: "result",
        result: {
          resultId: result.resultId,
          producerId: result.producerId,
          status: result.status,
          summary: result.summary,
          changedFiles: [...result.changedFiles],
          createdAt: result.createdAt
        }
      }
    }
  };
}

function isRecoverableCompletedRunRecord(record: { state: string; terminalOutcome?: unknown }): boolean {
  return record.state === "completed" && Boolean(record.terminalOutcome);
}

function findRecoveredDecisionCandidate(
  projectionBeforeReconciliation: LoadedProjection,
  projectionAfterReconciliation: LoadedProjection
): {
  assignment: Assignment;
  decision: DecisionPacket;
} | undefined {
  for (const assignmentId of projectionAfterReconciliation.status.activeAssignmentIds) {
    const assignment = projectionAfterReconciliation.assignments.get(assignmentId);
    if (!assignment || assignment.state !== "blocked") {
      continue;
    }
    const decision = findLatestOpenDecision(projectionAfterReconciliation, assignment.id);
    if (!decision) {
      continue;
    }
    const beforeAssignment = projectionBeforeReconciliation.assignments.get(assignment.id);
    if (
      beforeAssignment?.state !== assignment.state ||
      projectionBeforeReconciliation.status.activeAssignmentIds.includes(assignment.id) !==
        projectionAfterReconciliation.status.activeAssignmentIds.includes(assignment.id) ||
      !hasMatchingDecision(projectionBeforeReconciliation, decision)
    ) {
      return { assignment, decision };
    }
  }

  return undefined;
}

function findRecoveredResultCandidate(
  projectionBeforeReconciliation: LoadedProjection,
  projectionAfterReconciliation: LoadedProjection
): {
  assignment: Assignment;
  result: ResultPacket;
} | undefined {
  let candidate:
    | {
        assignment: Assignment;
        result: ResultPacket;
      }
    | undefined;

  for (const assignment of projectionAfterReconciliation.assignments.values()) {
    if (assignment.state !== "completed" && assignment.state !== "failed") {
      continue;
    }
    const result = findLatestTerminalResult(projectionAfterReconciliation, assignment.id);
    if (!result) {
      continue;
    }
    const beforeAssignment = projectionBeforeReconciliation.assignments.get(assignment.id);
    if (
      beforeAssignment?.state === assignment.state &&
      projectionBeforeReconciliation.status.activeAssignmentIds.includes(assignment.id) ===
        projectionAfterReconciliation.status.activeAssignmentIds.includes(assignment.id) &&
      hasMatchingResult(projectionBeforeReconciliation, result)
    ) {
      continue;
    }
    if (!candidate || candidate.result.createdAt < result.createdAt) {
      candidate = { assignment, result };
    }
  }

  return candidate;
}

function findLatestOpenDecision(
  projection: LoadedProjection,
  assignmentId: string
): DecisionPacket | undefined {
  return [...projection.decisions.values()]
    .filter((decision) => decision.assignmentId === assignmentId && decision.state === "open")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
}

function findLatestTerminalResult(
  projection: LoadedProjection,
  assignmentId: string
): ResultPacket | undefined {
  return [...projection.results.values()]
    .filter(
      (result) =>
        result.assignmentId === assignmentId &&
        (result.status === "completed" || result.status === "failed")
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
}

function hasMatchingDecision(
  projection: LoadedProjection,
  decision: DecisionPacket
): boolean {
  return [...projection.decisions.values()].some((candidate) =>
    candidate.assignmentId === decision.assignmentId &&
    (
      candidate.decisionId === decision.decisionId ||
      (
        candidate.blockerSummary === decision.blockerSummary &&
        candidate.recommendedOption === decision.recommendedOption &&
        candidate.createdAt === decision.createdAt
      )
    )
  );
}

function hasMatchingResult(
  projection: LoadedProjection,
  result: ResultPacket
): boolean {
  return [...projection.results.values()].some((candidate) =>
    candidate.assignmentId === result.assignmentId &&
    (
      candidate.resultId === result.resultId ||
      (
        candidate.status === result.status &&
        candidate.summary === result.summary &&
        candidate.createdAt === result.createdAt
      )
    )
  );
}
