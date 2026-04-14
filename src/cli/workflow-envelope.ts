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

  return {
    ...envelope,
    metadata: {
      ...envelope.metadata,
      recoveredOutcome: true
    }
  };
}
