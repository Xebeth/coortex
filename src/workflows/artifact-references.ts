import type { WorkflowArtifactReference } from "../core/types.js";
import { fromProjectRelativeArtifactPath } from "./progression.js";
import type { WorkflowClaimedArtifact } from "./types.js";

export function getExplicitRuntimeArtifactReferences(
  artifact: WorkflowClaimedArtifact | undefined
): WorkflowArtifactReference[] {
  const value = artifact?.document.payload.runtimeArtifactReferences;
  if (!Array.isArray(value)) {
    return [];
  }

  const references: WorkflowArtifactReference[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalizedPath = normalizeRuntimeArtifactPath(entry);
    if (!normalizedPath) {
      continue;
    }
    const format = normalizedPath.endsWith(".json") ? "json" : "text";
    const key = `${normalizedPath}:${format}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    references.push({
      path: normalizedPath,
      format
    });
  }

  return references;
}

function normalizeRuntimeArtifactPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith(".coortex/")) {
    return fromProjectRelativeArtifactPath(trimmed);
  }
  return undefined;
}
