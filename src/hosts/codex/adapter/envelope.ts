import type {
  RecoveryBrief,
  RuntimeProjection,
  WorkflowSummary
} from "../../../core/types.js";
import type {
  RuntimeArtifactStore,
  TaskEnvelope,
  TrimmedField
} from "../../../adapters/contract.js";

export interface EnvelopeOptions {
  host: string;
  adapter: string;
  maxChars?: number;
  resultSummaryLimit?: number;
  artifactDir?: string;
  workflow?: WorkflowSummary | null;
}

interface TrimmedEnvelopeEntry<T> {
  entry: T;
  trimmedField: TrimmedField | undefined;
}

export async function buildTaskEnvelope(
  store: RuntimeArtifactStore,
  projection: RuntimeProjection,
  brief: RecoveryBrief,
  options: EnvelopeOptions
): Promise<TaskEnvelope> {
  const activeAssignment = options.workflow
    ? options.workflow.currentAssignmentId
      ? projection.assignments.get(options.workflow.currentAssignmentId)
      : undefined
    : projection.status.activeAssignmentIds
        .map((assignmentId) => projection.assignments.get(assignmentId))
        .find((assignment): assignment is NonNullable<typeof assignment> => Boolean(assignment));
  const workflowOnlyEnvelope =
    !activeAssignment && options.workflow?.currentAssignmentId === null
      ? {
          objective: brief.activeObjective,
          writeScope: options.workflow.outputArtifact ? [options.workflow.outputArtifact] : [],
          requiredOutputs: [] as string[],
          activeAssignmentId: null as string | null
        }
      : undefined;

  if (!activeAssignment && !workflowOnlyEnvelope) {
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
      return {
        entry,
        trimmedField: toTrimmedField(`result:${result.resultId}`, trimmed)
      };
    })
  );
  trimmedFields.push(...collectTrimmedFields(compactResults));

  const compactDecisions = await Promise.all(
    brief.unresolvedDecisions.map(async (decision) => {
      const trimmed = await trimTextToArtifact(
        store,
        `artifacts/decisions/${decision.decisionId}.txt`,
        decision.blockerSummary,
        300,
        `.coortex/artifacts/decisions/${decision.decisionId}.txt`
      );
      const entry: RecoveryBrief["unresolvedDecisions"][number] = {
        ...decision,
        blockerSummary: trimmed.value,
        trimmed: trimmed.trimmed
      };
      if (trimmed.trimmed) {
        entry.reference = trimmed.reference;
      }
      return {
        entry,
        trimmedField: toTrimmedField(`decision:${decision.decisionId}`, trimmed)
      };
    })
  );
  trimmedFields.push(...collectTrimmedFields(compactDecisions));

  const compactResultEntries = compactResults.map(({ entry }) => entry);
  const compactDecisionEntries = compactDecisions.map(({ entry }) => entry);

  const recentResults = compactResultEntries.map((result) => {
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

  const compactedWorkflow = options.workflow
    ? await compactWorkflowSummary(store, options.workflow, trimmedFields)
    : undefined;
  const nextRequiredAction = compactedWorkflow?.originalBlockerReason === brief.nextRequiredAction
    ? (compactedWorkflow.workflow.blockerReason ?? brief.nextRequiredAction)
    : brief.nextRequiredAction;

  let envelope: TaskEnvelope = {
    host: options.host,
    adapter: options.adapter,
    objective: activeAssignment?.objective ?? workflowOnlyEnvelope!.objective,
    writeScope: [
      ...(activeAssignment?.writeScope ?? workflowOnlyEnvelope!.writeScope),
      ...(activeAssignment && compactedWorkflow?.workflow.outputArtifact
        ? [compactedWorkflow.workflow.outputArtifact]
        : [])
    ],
    requiredOutputs: activeAssignment?.requiredOutputs ?? workflowOnlyEnvelope!.requiredOutputs,
    recoveryBrief: {
      ...brief,
      nextRequiredAction,
      lastDurableResults: compactResultEntries,
      unresolvedDecisions: compactDecisionEntries
    },
    ...(compactedWorkflow ? { workflow: compactedWorkflow.workflow } : {}),
    recentResults,
    metadata: {
      activeMode: projection.status.activeMode,
      activeAssignmentId: activeAssignment?.id ?? workflowOnlyEnvelope!.activeAssignmentId,
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

async function compactWorkflowSummary(
  store: RuntimeArtifactStore,
  workflow: WorkflowSummary,
  trimmedFields: TrimmedField[]
): Promise<{
  workflow: WorkflowSummary;
  originalBlockerReason: string | null;
}> {
  const compacted: WorkflowSummary = {
    ...workflow,
    readArtifacts: [...workflow.readArtifacts]
  };
  const originalBlockerReason = workflow.blockerReason;

  await trimWorkflowSummaryTextField(
    store,
    workflow,
    compacted,
    "blockerReason",
    "workflow:blockerReason",
    "blocker-reason",
    trimmedFields
  );

  await trimWorkflowSummaryTextField(
    store,
    workflow,
    compacted,
    "lastDurableAdvancement",
    "workflow:lastDurableAdvancement",
    "last-durable-advancement",
    trimmedFields
  );

  return {
    workflow: compacted,
    originalBlockerReason
  };
}

async function trimWorkflowSummaryTextField(
  store: RuntimeArtifactStore,
  workflow: WorkflowSummary,
  compacted: WorkflowSummary,
  key: "blockerReason" | "lastDurableAdvancement",
  label: string,
  suffix: "blocker-reason" | "last-durable-advancement",
  trimmedFields: TrimmedField[]
): Promise<void> {
  const value = workflow[key];
  if (!value) {
    return;
  }
  const trimmed = await trimTextToArtifact(
    store,
    workflowTextArtifactPath(workflow, suffix),
    value,
    300,
    workflowTextReference(workflow, suffix)
  );
  if (!trimmed.trimmed) {
    return;
  }
  compacted[key] = trimmed.value;
  trimmedFields.push({
    label,
    originalChars: trimmed.originalChars,
    keptChars: trimmed.value.length,
    reference: trimmed.reference
  });
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

function toTrimmedField(
  label: string,
  trimmed: Awaited<ReturnType<typeof trimTextToArtifact>>
): TrimmedField | undefined {
  if (!trimmed.trimmed) {
    return undefined;
  }
  return {
    label,
    originalChars: trimmed.originalChars,
    keptChars: trimmed.value.length,
    reference: trimmed.reference
  };
}

function collectTrimmedFields<T>(entries: TrimmedEnvelopeEntry<T>[]): TrimmedField[] {
  return entries.flatMap((entry) => (entry.trimmedField ? [entry.trimmedField] : []));
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
    estimatedChars: JSON.stringify({
      ...envelope,
      estimatedChars: 0
    }).length
  };
}

function workflowTextArtifactPath(
  workflow: WorkflowSummary,
  suffix: "blocker-reason" | "last-durable-advancement"
): string {
  return `artifacts/workflows/${workflow.id}/cycle-${workflow.workflowCycle}/${workflow.currentModuleId}/${suffix}.txt`;
}

function workflowTextReference(
  workflow: WorkflowSummary,
  suffix: "blocker-reason" | "last-durable-advancement"
): string {
  return `.coortex/${workflowTextArtifactPath(workflow, suffix)}`;
}
