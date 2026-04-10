import { access } from "node:fs/promises";

import type { HostExecutionOutcome, HostTelemetryCapture } from "../../../adapters/contract.js";
import type { ResultPacket } from "../../../core/types.js";
import type { RunningExec } from "./cli.js";
import { validateCodexStructuredOutcome, type CodexStructuredOutcome } from "./prompt.js";

type CodexExecutionWithoutArtifacts = Pick<HostExecutionOutcome, "outcome">;

export async function deriveExecutionOutcome(
  assignmentId: string,
  completedAt: string,
  execution: { exitCode: number; stderr: string },
  outputPath: string,
  errorMessage?: string
): Promise<CodexExecutionWithoutArtifacts> {
  if (execution.exitCode !== 0) {
    return buildFailedOutcome(
      assignmentId,
      completedAt,
      summarizeCodexFailure(execution, errorMessage)
    );
  }

  try {
    const lastMessage = await loadValidatedStructuredOutcome(outputPath);
    return normalizeStructuredOutcome(assignmentId, completedAt, lastMessage);
  } catch (error) {
    return buildFailedOutcome(
      assignmentId,
      completedAt,
      summarizeStructuredOutputFailure(error)
    );
  }
}

export function buildFailedOutcome(
  assignmentId: string,
  completedAt: string,
  summary: string
): CodexExecutionWithoutArtifacts {
  return {
    outcome: {
      kind: "result",
      capture: {
        assignmentId,
        producerId: "codex",
        status: "failed",
        summary,
        changedFiles: [],
        createdAt: completedAt
      }
    }
  };
}

export function summarizeExecutionError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Codex run failed before completion: ${detail}`;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function stopRunningExec(running: RunningExec): Promise<void> {
  const settledResult = running.result.catch(() => undefined);
  try {
    await running.terminate("graceful");
  } catch {
    // Ignore and continue to exit wait/force escalation.
  }

  const gracefulExit = await waitForRunningExit(running, 5_000);
  if (gracefulExit) {
    return;
  }

  try {
    await running.terminate("force");
  } catch {
    await settledResult;
    return;
  }
  await waitForRunningExit(running, 5_000).catch(() => undefined);
  await settledResult;
}

export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function normalizeStructuredOutcome(
  assignmentId: string,
  completedAt: string,
  outcome: CodexStructuredOutcome
): CodexExecutionWithoutArtifacts {
  if (outcome.outcomeType === "decision") {
    const options = outcome.decisionOptions.filter(
      (option) => option.id.length > 0 && option.label.length > 0 && option.summary.length > 0
    );
    if (options.length === 0) {
      return buildFailedOutcome(
        assignmentId,
        completedAt,
        "Codex returned a decision outcome without any decision options."
      );
    }
    const recommended =
      options.find((option) => option.id === outcome.recommendedOption)?.id ?? options[0]!.id;
    return {
      outcome: {
        kind: "decision",
        capture: {
          assignmentId,
          requesterId: "codex",
          blockerSummary: preferNonEmpty(outcome.blockerSummary, outcome.resultSummary),
          options,
          recommendedOption: recommended,
          createdAt: completedAt
        }
      }
    };
  }

  return {
    outcome: {
      kind: "result",
      capture: {
        assignmentId,
        producerId: "codex",
        status: outcome.resultStatus === "" ? ("partial" as ResultPacket["status"]) : outcome.resultStatus,
        summary: preferNonEmpty(outcome.resultSummary, "Codex run completed without a summary."),
        changedFiles: uniqueChangedFiles(outcome.changedFiles),
        createdAt: completedAt
      }
    }
  };
}

async function loadValidatedStructuredOutcome(path: string): Promise<CodexStructuredOutcome> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(path, "utf8");
  return validateCodexStructuredOutcome(JSON.parse(raw));
}

function summarizeCodexFailure(
  execution: { exitCode: number; stderr: string },
  errorMessage?: string
): string {
  const detail = [errorMessage, execution.stderr.trim()].find(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  return detail
    ? `Codex run failed (exit ${execution.exitCode}): ${detail}`
    : `Codex run failed with exit code ${execution.exitCode}.`;
}

function summarizeStructuredOutputFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Codex run returned invalid structured output: ${detail}`;
}

function preferNonEmpty(value: string, fallback: string): string {
  return value.trim().length > 0 ? value : fallback;
}

function uniqueChangedFiles(files: string[]): string[] {
  return [...new Set(files.filter((file) => file.trim().length > 0))];
}

async function waitForRunningExit(running: RunningExec, timeoutMs: number): Promise<boolean> {
  try {
    await Promise.race([
      running.waitForExit(timeoutMs),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      })
    ]);
    return true;
  } catch {
    return false;
  }
}
