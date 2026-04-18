import type { RecoveryBrief, RuntimeProjection } from "../../../core/types.js";
import type {
  RuntimeArtifactStore,
  TaskEnvelope,
  TrimmedField
} from "../../../adapters/contract.js";
import { measureCodexExecutionPromptChars } from "./prompt.js";

export interface EnvelopeOptions {
  host: string;
  adapter: string;
  maxChars?: number;
  resultSummaryLimit?: number;
  artifactDir?: string;
}

export async function buildTaskEnvelope(
  store: RuntimeArtifactStore,
  projection: RuntimeProjection,
  brief: RecoveryBrief,
  options: EnvelopeOptions
): Promise<TaskEnvelope> {
  const activeAssignment = projection.status.activeAssignmentIds
    .map((assignmentId) => projection.assignments.get(assignmentId))
    .find((assignment): assignment is NonNullable<typeof assignment> => Boolean(assignment));

  if (!activeAssignment) {
    throw new Error("Cannot build envelope without an active assignment.");
  }

  const trimmedFields: TrimmedField[] = [];
  const compactResults = await Promise.all(
    brief.lastDurableResults.map(async (result) => {
      const trimmed = await trimTextToArtifact(
        store,
        `${options.artifactDir ?? "artifacts/results"}/${result.resultId}.txt`,
        result.summary,
        options.resultSummaryLimit ?? 400,
        `.coortex/${options.artifactDir ?? "artifacts/results"}/${result.resultId}.txt`
      );
      if (trimmed.trimmed) {
        trimmedFields.push({
          label: `result:${result.resultId}`,
          originalChars: trimmed.originalChars,
          keptChars: trimmed.value.length,
          reference: trimmed.reference
        });
      }
      const entry: RecoveryBrief["lastDurableResults"][number] = {
        resultId: result.resultId,
        assignmentId: result.assignmentId,
        status: result.status,
        summary: trimmed.value,
        changedFiles: result.changedFiles.slice(0, 5),
        createdAt: result.createdAt,
        trimmed: trimmed.trimmed
      };
      if (trimmed.trimmed) {
        entry.reference = trimmed.reference;
      }
      return entry;
    })
  );
  const compactDecisions = await Promise.all(
    brief.unresolvedDecisions.map(async (decision) => {
      const trimmed = await trimTextToArtifact(
        store,
        `artifacts/decisions/${decision.decisionId}.txt`,
        decision.blockerSummary,
        300,
        `.coortex/artifacts/decisions/${decision.decisionId}.txt`
      );
      if (trimmed.trimmed) {
        trimmedFields.push({
          label: `decision:${decision.decisionId}`,
          originalChars: trimmed.originalChars,
          keptChars: trimmed.value.length,
          reference: trimmed.reference
        });
      }
      const entry: RecoveryBrief["unresolvedDecisions"][number] = {
        ...decision,
        blockerSummary: trimmed.value,
        trimmed: trimmed.trimmed
      };
      if (trimmed.trimmed) {
        entry.reference = trimmed.reference;
      }
      return entry;
    })
  );

  const recentResults = compactResults.map((result) => {
    const entry: TaskEnvelope["recentResults"][number] = {
      resultId: result.resultId,
      summary: result.summary,
      trimmed: !!result.trimmed
    };
    if (result.reference) {
      entry.reference = result.reference;
    }
    return entry;
  });

  let envelope: TaskEnvelope = {
    host: options.host,
    adapter: options.adapter,
    objective: activeAssignment.objective,
    writeScope: activeAssignment.writeScope,
    requiredOutputs: activeAssignment.requiredOutputs,
    recoveryBrief: {
      ...brief,
      lastDurableResults: compactResults,
      unresolvedDecisions: compactDecisions
    },
    recentResults,
    metadata: {
      activeMode: projection.status.activeMode,
      activeAssignmentId: activeAssignment.id,
      unresolvedDecisionCount: brief.unresolvedDecisions.length
    },
    estimatedChars: 0,
    trimApplied: trimmedFields.length > 0,
    trimmedFields
  };

  const maxChars = options.maxChars ?? 4_000;
  envelope = compactEnvelope(envelope, maxChars);

  if (envelope.estimatedChars > maxChars) {
    throw new Error(`Cannot build bounded envelope within ${maxChars} characters.`);
  }

  return envelope;
}

async function trimTextToArtifact(
  store: RuntimeArtifactStore,
  artifactPath: string,
  value: string,
  limit: number,
  reference: string
) {
  if (value.length <= limit) {
    return {
      value,
      trimmed: false,
      originalChars: value.length,
      reference
    };
  }
  await store.writeTextArtifact(artifactPath, `${value}\n`);
  return {
    value: `${value.slice(0, Math.max(0, limit - 19))}...[trimmed]`,
    trimmed: true,
    originalChars: value.length,
    reference
  };
}

function compactEnvelope(envelope: TaskEnvelope, maxChars: number): TaskEnvelope {
  const stages = [
    (current: TaskEnvelope): TaskEnvelope => ({
      ...current,
      estimatedChars: 0,
      metadata: {
        ...current.metadata,
        compacted: true,
        compactionReason: `Envelope exceeded ${maxChars} characters.`
      },
      recoveryBrief: {
        ...current.recoveryBrief,
        lastDurableResults: current.recoveryBrief.lastDurableResults.slice(0, 2),
        unresolvedDecisions: current.recoveryBrief.unresolvedDecisions.slice(0, 1)
      },
      recentResults: current.recentResults.slice(0, 2)
    }),
    (current: TaskEnvelope): TaskEnvelope => ({
      ...current,
      estimatedChars: 0,
      recoveryBrief: {
        ...current.recoveryBrief,
        activeAssignments: current.recoveryBrief.activeAssignments.map((assignment) => ({
          ...assignment,
          writeScope: assignment.writeScope.slice(0, 3),
          requiredOutputs: assignment.requiredOutputs.slice(0, 3)
        })),
        lastDurableResults: [],
        unresolvedDecisions: current.recoveryBrief.unresolvedDecisions.slice(0, 1)
      }
    }),
    (current: TaskEnvelope): TaskEnvelope => ({
      ...current,
      estimatedChars: 0,
      recentResults: [],
      recoveryBrief: {
        ...current.recoveryBrief,
        unresolvedDecisions: current.recoveryBrief.unresolvedDecisions.slice(0, 1)
      }
    })
  ];

  let current = withEstimatedChars(envelope);
  if (current.estimatedChars <= maxChars) {
    return current;
  }
  for (const stage of stages) {
    current = withEstimatedChars(stage(current));
    if (current.estimatedChars <= maxChars) {
      return current;
    }
  }
  return current;
}

function withEstimatedChars(envelope: TaskEnvelope): TaskEnvelope {
  return {
    ...envelope,
    estimatedChars: measureCodexExecutionPromptChars({
      ...envelope,
      estimatedChars: 0
    })
  };
}
