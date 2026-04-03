import type { RecoveryBrief, RuntimeProjection } from "../core/types.js";
import type { TaskEnvelope, TrimmedField } from "./types.js";

export interface EnvelopeOptions {
  host: string;
  adapter: string;
  maxChars?: number;
  resultSummaryLimit?: number;
}

export function buildTaskEnvelope(
  projection: RuntimeProjection,
  brief: RecoveryBrief,
  options: EnvelopeOptions
): TaskEnvelope {
  const activeAssignment =
    [...projection.assignments.values()].find((assignment) =>
      projection.status.activeAssignmentIds.includes(assignment.id)
    ) ?? [...projection.assignments.values()][0];

  if (!activeAssignment) {
    throw new Error("Cannot build envelope without an assignment.");
  }

  const trimmedFields: TrimmedField[] = [];
  const recentResults = brief.lastDurableResults.map((result) => {
    const trimmed = trimText(result.summary, options.resultSummaryLimit ?? 400, `result:${result.resultId}`);
    if (trimmed.trimmed) {
      trimmedFields.push({
        label: `result:${result.resultId}`,
        originalChars: trimmed.originalChars,
        keptChars: trimmed.value.length,
        reference: trimmed.reference
      });
    }
    const entry: TaskEnvelope["recentResults"][number] = {
      resultId: result.resultId,
      summary: trimmed.value,
      trimmed: trimmed.trimmed
    };
    if (trimmed.trimmed) {
      entry.reference = trimmed.reference;
    }
    return entry;
  });

  const envelope: TaskEnvelope = {
    host: options.host,
    adapter: options.adapter,
    objective: activeAssignment.objective,
    writeScope: activeAssignment.writeScope,
    requiredOutputs: activeAssignment.requiredOutputs,
    recoveryBrief: brief,
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

  envelope.estimatedChars = JSON.stringify(envelope).length;

  const maxChars = options.maxChars ?? 4_000;
  if (envelope.estimatedChars > maxChars) {
    const compactBrief = {
      ...brief,
      lastDurableResults: [],
      unresolvedDecisions: brief.unresolvedDecisions.slice(0, 1)
    };
    envelope.recoveryBrief = compactBrief;
    envelope.metadata = {
      ...envelope.metadata,
      compacted: true,
      compactionReason: `Envelope exceeded ${maxChars} characters.`
    };
    envelope.estimatedChars = JSON.stringify(envelope).length;
  }

  return envelope;
}

function trimText(value: string, limit: number, reference: string) {
  if (value.length <= limit) {
    return {
      value,
      trimmed: false,
      originalChars: value.length,
      reference
    };
  }
  const excerpt = `${value.slice(0, Math.max(0, limit - 19))}...[trimmed]`;
  return {
    value: excerpt,
    trimmed: true,
    originalChars: value.length,
    reference
  };
}
