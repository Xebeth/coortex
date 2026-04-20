import type { HostAdapter, TaskEnvelope } from "../adapters/contract.js";
import { buildRecoveryBrief } from "../recovery/brief.js";
import { RuntimeStore } from "../persistence/store.js";
import { deriveWorkflowSummary } from "../workflows/index.js";
import { projectionForRunnableAssignment } from "./run-operations.js";

type LoadedProjection = Awaited<ReturnType<RuntimeStore["loadProjection"]>>;

export async function buildWorkflowAwareEnvelope(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: LoadedProjection,
  brief: ReturnType<typeof buildRecoveryBrief>
): Promise<TaskEnvelope> {
  return adapter.buildResumeEnvelope(store, projection, brief, {
    workflow: deriveWorkflowSummary(projection)
  });
}

export async function buildAndPersistWorkflowEnvelope(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: LoadedProjection,
  brief: ReturnType<typeof buildRecoveryBrief>
): Promise<TaskEnvelope> {
  const envelope = await buildWorkflowAwareEnvelope(store, adapter, projection, brief);
  await persistWorkflowEnvelope(store, envelope);
  return envelope;
}

export async function refreshPersistedWorkflowEnvelope(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: LoadedProjection,
  activeAssignmentId?: string
): Promise<TaskEnvelope | undefined> {
  const envelopeProjection = selectEnvelopeRefreshProjection(projection, activeAssignmentId);
  if (!envelopeProjection) {
    return undefined;
  }
  const brief = buildRecoveryBrief(envelopeProjection);
  if (brief.activeAssignments.length === 0 && !envelopeProjection.workflowProgress) {
    return undefined;
  }
  return buildAndPersistWorkflowEnvelope(store, adapter, envelopeProjection, brief);
}

export function buildEnvelopeTelemetryMetadata(envelope: TaskEnvelope): {
  envelopeChars: number;
  trimApplied: boolean;
  trimmedFields: number;
} {
  return {
    envelopeChars: envelope.estimatedChars,
    trimApplied: envelope.trimApplied,
    trimmedFields: envelope.trimmedFields.length
  };
}

export async function buildRecoveredExecutionEnvelope(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: LoadedProjection,
  assignmentId: string
): Promise<TaskEnvelope> {
  const envelopeProjection = projection.workflowProgress
    ? projection
    : projection.status.activeAssignmentIds.includes(assignmentId)
      ? projection
      : projectionForRunnableAssignment(projection, assignmentId);
  const brief = buildRecoveryBrief(envelopeProjection);
  const envelope = await buildWorkflowAwareEnvelope(store, adapter, envelopeProjection, brief);
  const recoveredEnvelope = {
    ...envelope,
    metadata: {
      ...envelope.metadata,
      recoveredOutcome: true
    }
  };
  await persistWorkflowEnvelope(store, recoveredEnvelope);
  return recoveredEnvelope;
}

async function persistWorkflowEnvelope(
  store: RuntimeStore,
  envelope: TaskEnvelope
): Promise<void> {
  await store.writeJsonArtifact("runtime/last-resume-envelope.json", envelope);
}

function selectEnvelopeRefreshProjection(
  projection: LoadedProjection,
  activeAssignmentId?: string
): LoadedProjection | undefined {
  if (projection.workflowProgress) {
    return projection;
  }
  if (!activeAssignmentId) {
    return projection.status.activeAssignmentIds.length === 0 ? undefined : projection;
  }
  if (!projection.status.activeAssignmentIds.includes(activeAssignmentId)) {
    return undefined;
  }
  return projectionForRunnableAssignment(projection, activeAssignmentId);
}
