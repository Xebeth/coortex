import type { TaskEnvelope } from "../../../adapters/contract.js";

export interface CodexStructuredOutcome {
  outcomeType: "result" | "decision";
  resultStatus: "partial" | "completed" | "failed" | "";
  resultSummary: string;
  changedFiles: string[];
  blockerSummary: string;
  decisionOptions: Array<{
    id: string;
    label: string;
    summary: string;
  }>;
  recommendedOption: string;
}

export function buildCodexExecutionPrompt(envelope: TaskEnvelope): string {
  const workflowLines = envelope.workflow
    ? [
        `Workflow module: ${envelope.workflow.currentModuleId}.`,
        envelope.workflow.outputArtifact
          ? `Write the workflow artifact to ${envelope.workflow.outputArtifact}. This path is writable because it is mirrored into writeScope.`
          : "No writable workflow artifact target is active.",
        envelope.workflow.readArtifacts.length > 0
          ? `Use workflow.readArtifacts as read-only inputs: ${envelope.workflow.readArtifacts.join(", ")}.`
          : "There are no read-only workflow artifacts for this assignment."
      ]
    : [];
  return [
    "You are executing a Coortex assignment through the Codex host adapter.",
    "Treat the bounded envelope below as the runtime-owned source of truth.",
    "Stay within the provided write scope.",
    ...workflowLines,
    "If you can make progress safely, do the work and return a result outcome.",
    "If you are blocked on missing information, an irreversible choice, or an external dependency, return a decision outcome.",
    "Always return structured data that matches the provided schema.",
    "Use concise durable summaries.",
    "",
    "Bounded envelope:",
    JSON.stringify(envelope, null, 2)
  ].join("\n");
}

export function codexExecutionOutputSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: [
      "outcomeType",
      "resultStatus",
      "resultSummary",
      "changedFiles",
      "blockerSummary",
      "decisionOptions",
      "recommendedOption"
    ],
    properties: {
      outcomeType: {
        type: "string",
        enum: ["result", "decision"]
      },
      resultStatus: {
        type: "string",
        enum: ["partial", "completed", "failed", ""]
      },
      resultSummary: {
        type: "string"
      },
      changedFiles: {
        type: "array",
        items: {
          type: "string"
        }
      },
      blockerSummary: {
        type: "string"
      },
      decisionOptions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "label", "summary"],
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            summary: { type: "string" }
          }
        }
      },
      recommendedOption: {
        type: "string"
      }
    }
  };
}

export function validateCodexStructuredOutcome(value: unknown): CodexStructuredOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex structured output must be an object.");
  }

  const record = value as Record<string, unknown>;
  const outcomeType = readEnum(record, "outcomeType", ["result", "decision"]);
  const resultStatus = readEnum(record, "resultStatus", ["partial", "completed", "failed", ""]);
  const resultSummary = readString(record, "resultSummary");
  const changedFiles = readStringArray(record, "changedFiles");
  const blockerSummary = readString(record, "blockerSummary");
  const decisionOptions = readDecisionOptions(record.decisionOptions);
  const recommendedOption = readString(record, "recommendedOption");

  return {
    outcomeType,
    resultStatus,
    resultSummary,
    changedFiles,
    blockerSummary,
    decisionOptions,
    recommendedOption
  };
}

function readDecisionOptions(value: unknown): CodexStructuredOutcome["decisionOptions"] {
  if (!Array.isArray(value)) {
    throw new Error("Codex structured output field decisionOptions must be an array.");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Codex decision option ${index} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    return {
      id: readString(record, "id"),
      label: readString(record, "label"),
      summary: readString(record, "summary")
    };
  });
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Codex structured output field ${key} must be an array of strings.`);
  }
  return [...value];
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Codex structured output field ${key} must be a string.`);
  }
  return value;
}

function readEnum<const T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T {
  const value = readString(record, key);
  if (!allowed.includes(value as T)) {
    throw new Error(
      `Codex structured output field ${key} must be one of: ${allowed.join(", ")}.`
    );
  }
  return value as T;
}
