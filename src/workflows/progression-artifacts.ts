import { createHash } from "node:crypto";

import type {
  ResultPacket,
  WorkflowArtifactReference,
  WorkflowModuleProgressRecord,
  WorkflowProgressRecord
} from "../core/types.js";
import type {
  WorkflowArtifactDocument,
  WorkflowArtifactStore,
  WorkflowClaimedArtifact
} from "./types.js";

export function workflowArtifactPath(
  workflowId: string,
  workflowCycle: number,
  moduleId: string,
  assignmentId: string,
  moduleAttempt: number
): string {
  return `runtime/workflows/${workflowId}/cycles/${workflowCycle}/${moduleId}/${assignmentId}/attempt-${moduleAttempt}.json`;
}

export function toProjectRelativeArtifactPath(storeRelativePath: string): string {
  return `.coortex/${storeRelativePath}`;
}

export function fromProjectRelativeArtifactPath(projectRelativePath: string): string {
  return projectRelativePath.replace(/^\.coortex\//, "");
}

export async function loadClaimedArtifact(
  store: WorkflowArtifactStore,
  progress: WorkflowProgressRecord,
  assignmentId: string,
  result: ResultPacket
): Promise<WorkflowClaimedArtifact | undefined> {
  const path = workflowArtifactPath(
    progress.workflowId,
    progress.workflowCycle,
    progress.currentModuleId,
    assignmentId,
    progress.currentModuleAttempt
  );
  const artifact = await store.readJsonArtifact<WorkflowArtifactDocument>(path, "workflow artifact");
  if (!artifact || !isValidWorkflowArtifact(artifact, progress, assignmentId)) {
    return undefined;
  }
  const digest = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
  return {
    reference: {
      path,
      format: "json",
      digest,
      sourceResultId: result.resultId
    },
    document: artifact
  };
}

export function hasClaimedArtifact(
  currentModule: WorkflowModuleProgressRecord,
  reference: WorkflowArtifactReference,
  sourceResultId: string
): boolean {
  return currentModule.artifactReferences.some(
    (artifact) =>
      artifact.path === reference.path &&
      artifact.format === reference.format &&
      artifact.digest === reference.digest &&
      (artifact.sourceResultId ?? sourceResultId) === sourceResultId
  );
}

function isValidWorkflowArtifact(
  artifact: WorkflowArtifactDocument,
  progress: WorkflowProgressRecord,
  assignmentId: string
): boolean {
  return (
    artifact.workflowId === progress.workflowId &&
    artifact.workflowCycle === progress.workflowCycle &&
    artifact.moduleId === progress.currentModuleId &&
    artifact.moduleAttempt === progress.currentModuleAttempt &&
    artifact.assignmentId === assignmentId &&
    typeof artifact.createdAt === "string" &&
    Boolean(artifact.payload) &&
    typeof artifact.payload === "object" &&
    !Array.isArray(artifact.payload)
  );
}
