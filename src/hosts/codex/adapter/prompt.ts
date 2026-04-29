import type { TaskEnvelope } from "../../../adapters/contract.js";

const codexStructuredOutcomeFields = [
  "outcomeType",
  "resultStatus",
  "resultSummary",
  "changedFiles",
  "blockerSummary",
  "decisionOptions",
  "recommendedOption"
] as const;

const codexDecisionOptionFields = ["id", "label", "summary"] as const;

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
  return renderCodexExecutionPrompt(envelope);
}

export function measureCodexExecutionPromptChars(envelope: TaskEnvelope): number {
  let estimatedChars = envelope.estimatedChars;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nextEstimate = renderCodexExecutionPrompt({
      ...envelope,
      estimatedChars
    }).length;
    if (nextEstimate === estimatedChars) {
      return nextEstimate;
    }
    estimatedChars = nextEstimate;
  }
  return renderCodexExecutionPrompt({
    ...envelope,
    estimatedChars
  }).length;
}

function renderCodexExecutionPrompt(envelope: TaskEnvelope): string {
  const schema = codexExecutionOutputSchema();
  return [
    "You are executing a Coortex assignment through the Codex host adapter.",
    "Treat the bounded envelope below as the runtime-owned source of truth.",
    "Stay within the provided write scope.",
    "If you can make progress safely, do the work and return a result outcome.",
    "If you are blocked on missing information, an irreversible choice, or an external dependency, return a decision outcome.",
    "Always return structured data that matches the provided schema.",
    "Your final message must be a JSON object and nothing else.",
    "Use concise durable summaries.",
    "",
    "Structured output schema:",
    JSON.stringify(schema),
    "",
    "Bounded envelope:",
    JSON.stringify(envelope)
  ].join("\n");
}

export function codexExecutionOutputSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: [...codexStructuredOutcomeFields],
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
          required: [...codexDecisionOptionFields],
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
  assertOnlyKnownFields(record, "Codex structured output", codexStructuredOutcomeFields);
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
    assertOnlyKnownFields(record, `Codex decision option ${index}`, codexDecisionOptionFields);
    return {
      id: readString(record, "id"),
      label: readString(record, "label"),
      summary: readString(record, "summary")
    };
  });
}

function assertOnlyKnownFields(
  record: Record<string, unknown>,
  context: string,
  allowedFields: readonly string[]
): void {
  const unknownFields = Object.keys(record).filter((key) => !allowedFields.includes(key));
  if (unknownFields.length > 0) {
    throw new Error(`${context} must not include unknown fields: ${unknownFields.join(", ")}.`);
  }
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
