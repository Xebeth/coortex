import { access, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  AdapterCapabilities,
  DoctorCheck,
  HostAdapter,
  HostDecisionCapture,
  HostExecutionOutcome,
  HostResultCapture,
  HostRunRecord,
  HostTelemetryCapture,
  RuntimeArtifactStore,
  TaskEnvelope
} from "../../../adapters/contract.js";
import type {
  DecisionPacket,
  RecoveryBrief,
  ResultPacket,
  RuntimeProjection
} from "../../../core/types.js";
import { nowIso } from "../../../utils/time.js";
import { buildTaskEnvelope } from "./envelope.js";
import type { CodexPaths } from "./types.js";
import { writeCodexKernel } from "../kernel/static.js";
import { CodexProfileManager } from "../profile/manager.js";
import {
  DefaultCodexCommandRunner,
  type CodexCommandRunner,
  type RunningExec
} from "./cli.js";
import {
  buildCodexExecutionPrompt,
  codexExecutionOutputSchema,
  validateCodexStructuredOutcome,
  type CodexStructuredOutcome
} from "./prompt.js";

type CodexExecutionWithoutArtifacts = Pick<HostExecutionOutcome, "outcome">;

export interface CodexAdapterOptions {
  dangerouslyBypassApprovalsAndSandbox?: boolean;
}

export class CodexAdapter implements HostAdapter {
  readonly id = "codex";
  readonly host = "codex";
  private activeRun: RunningExec | undefined;
  private readonly runner: CodexCommandRunner;
  private readonly options: CodexAdapterOptions;

  constructor(runner?: CodexCommandRunner, options: CodexAdapterOptions = {}) {
    this.options = options;
    this.runner = runner ?? new DefaultCodexCommandRunner(options);
  }

  getCapabilities(): AdapterCapabilities {
    return {
      supportsProfiles: true,
      supportsHooks: false,
      supportsResume: true,
      supportsFork: false,
      supportsExactUsage: false,
      supportsCompactionHooks: false,
      supportsMcp: false,
      supportsPlugins: false,
      supportsPermissionsModel: false
    };
  }

  paths(store: RuntimeArtifactStore): CodexPaths {
    const rootDir = join(store.adaptersDir, this.id);
    return {
      rootDir,
      kernelPath: join(rootDir, "kernel.md"),
      profilePath: join(rootDir, "profile.json"),
      capabilitiesPath: join(rootDir, "capabilities.json"),
      runsDir: join(rootDir, "runs"),
      lastRunPath: join(rootDir, "last-run.json"),
      outputSchemaPath: join(rootDir, "exec-output-schema.json")
    };
  }

  async initialize(store: RuntimeArtifactStore, projection: RuntimeProjection): Promise<void> {
    const paths = this.paths(store);
    await writeCodexKernel(paths.kernelPath);

    const profileManager = new CodexProfileManager(store);
    await profileManager.install(paths.kernelPath);
    await store.writeJsonArtifact(`adapters/${this.id}/capabilities.json`, this.getCapabilities());
    await store.writeJsonArtifact(`adapters/${this.id}/exec-output-schema.json`, codexExecutionOutputSchema());

    const brief: RecoveryBrief = {
      activeObjective: projection.status.currentObjective,
      activeAssignments: [],
      lastDurableResults: [],
      unresolvedDecisions: [],
      nextRequiredAction: "Initialize through ctx resume when needed.",
      generatedAt: projection.status.lastDurableOutputAt
    };
    await store.writeJsonArtifact(
      "runtime/last-resume-envelope.json",
      await this.buildResumeEnvelope(store, projection, brief)
    );
  }

  async doctor(store: RuntimeArtifactStore): Promise<DoctorCheck[]> {
    const paths = this.paths(store);
    const profileManager = new CodexProfileManager(store);

    return [
      {
        label: "codex-kernel",
        ok: await fileExists(paths.kernelPath),
        detail: paths.kernelPath
      },
      {
        label: "codex-exec-schema",
        ok: await fileExists(paths.outputSchemaPath),
        detail: paths.outputSchemaPath
      },
      {
        label: "codex-danger-mode",
        ok: true,
        detail: this.options.dangerouslyBypassApprovalsAndSandbox === true ? "enabled" : "disabled"
      },
      await profileManager.doctor()
    ];
  }

  buildResumeEnvelope(
    store: RuntimeArtifactStore,
    projection: RuntimeProjection,
    brief: RecoveryBrief
  ): Promise<TaskEnvelope> {
    return buildTaskEnvelope(store, projection, brief, {
      host: this.host,
      adapter: this.id,
      maxChars: 4_000,
      resultSummaryLimit: 400,
      artifactDir: "artifacts/results"
    });
  }

  async executeAssignment(
    store: RuntimeArtifactStore,
    projection: RuntimeProjection,
    envelope: TaskEnvelope
  ): Promise<HostExecutionOutcome> {
    const assignmentId = readEnvelopeAssignmentId(envelope);
    const startedAt = nowIso();
    const paths = this.paths(store);
    const executionId = randomUUID();
    const schemaPath = await store.writeJsonArtifact(
      `adapters/${this.id}/exec-output-schema.json`,
      codexExecutionOutputSchema()
    );
    const outputPath = join(paths.runsDir, `${assignmentId}-${executionId}-last-message.json`);
    const prompt = buildCodexExecutionPrompt(envelope);
    let runningRecord = createRunningRecord(assignmentId, startedAt);
    await this.writeRunRecord(store, runningRecord);

    let execution;
    try {
      const running = await this.runner.startExec({
        cwd: projection.rootPath,
        prompt,
        outputSchemaPath: schemaPath,
        outputPath,
        onEvent: async (event) => {
          const hostRunId =
            event.type === "thread.started" && typeof event.thread_id === "string"
              ? event.thread_id
              : undefined;
          if (hostRunId && runningRecord.hostRunId !== hostRunId) {
            runningRecord = {
              ...runningRecord,
              hostRunId
            };
            await this.writeRunRecord(store, runningRecord);
          }
        }
      });
      this.activeRun = running;
      execution = await running.result;
    } catch (error) {
      const completedAt = nowIso();
      const outcome = buildFailedOutcome(
        assignmentId,
        completedAt,
        summarizeExecutionError(error)
      );
      const runRecord = buildRunRecord(
        outcome,
        assignmentId,
        startedAt,
        completedAt,
        runningRecord.hostRunId
      );
      await this.writeRunRecord(store, runRecord);
      return {
        ...outcome,
        run: runRecord,
        telemetry: {
          eventType: "host.run.completed",
          taskId: projection.sessionId,
          assignmentId,
          metadata: {
            hostRunId: runningRecord.hostRunId ?? "",
            exitCode: -1,
            outcomeKind: outcome.outcome.kind
          }
        }
      };
    } finally {
      this.activeRun = undefined;
    }

    const completedAt = nowIso();
    const transcript = parseExecJsonl(execution.stdout);
    const hostRunId = runningRecord.hostRunId ?? transcript.threadId;

    const outcome = await deriveExecutionOutcome(
      assignmentId,
      completedAt,
      execution,
      outputPath,
      transcript.errorMessage
    );

    const runRecord = buildRunRecord(outcome, assignmentId, startedAt, completedAt, hostRunId);
    await this.writeRunRecord(store, runRecord);

    return {
      ...outcome,
      run: runRecord,
      telemetry: {
        eventType: "host.run.completed",
        taskId: projection.sessionId,
        assignmentId,
        metadata: {
          hostRunId: hostRunId ?? "",
          exitCode: execution.exitCode,
          outcomeKind: outcome.outcome.kind
        },
        ...(transcript.usage ? { usage: transcript.usage } : {})
      }
    };
  }

  async inspectRun(
    store: RuntimeArtifactStore,
    assignmentId?: string
  ): Promise<HostRunRecord | undefined> {
    const path = assignmentId
      ? `adapters/${this.id}/runs/${assignmentId}.json`
      : `adapters/${this.id}/last-run.json`;
    return store.readJsonArtifact<HostRunRecord>(path, "codex run record");
  }

  normalizeResult(capture: HostResultCapture): ResultPacket {
    return {
      resultId: capture.resultId ?? randomUUID(),
      assignmentId: capture.assignmentId,
      producerId: capture.producerId,
      status: capture.status,
      summary: capture.summary,
      changedFiles: [...capture.changedFiles],
      createdAt: capture.createdAt ?? nowIso()
    };
  }

  normalizeDecision(capture: HostDecisionCapture): DecisionPacket {
    return {
      decisionId: capture.decisionId ?? randomUUID(),
      assignmentId: capture.assignmentId,
      requesterId: capture.requesterId,
      blockerSummary: capture.blockerSummary,
      options: capture.options.map((option) => ({ ...option })),
      recommendedOption: capture.recommendedOption,
      state: capture.state ?? "open",
      createdAt: capture.createdAt ?? nowIso()
    };
  }

  normalizeTelemetry(capture: HostTelemetryCapture): Omit<
    import("../../../telemetry/types.js").TelemetryEvent,
    "timestamp"
  > {
    return {
      eventType: capture.eventType,
      taskId: capture.taskId,
      host: this.host,
      adapter: this.id,
      metadata: { ...capture.metadata },
      ...(capture.assignmentId ? { assignmentId: capture.assignmentId } : {}),
      ...capture.usage
    };
  }

  async cancelActiveRun(signal: "graceful" | "force" = "graceful"): Promise<void> {
    await this.activeRun?.terminate(signal);
    if (this.activeRun) {
      await this.activeRun.waitForExit(5_000);
    }
  }

  private async writeRunRecord(store: RuntimeArtifactStore, record: HostRunRecord): Promise<void> {
    await store.writeJsonArtifact(`adapters/${this.id}/runs/${record.assignmentId}.json`, record);
    await store.writeJsonArtifact(`adapters/${this.id}/last-run.json`, record);
  }
}

function readEnvelopeAssignmentId(envelope: TaskEnvelope): string {
  const assignmentId = envelope.metadata.activeAssignmentId;
  if (typeof assignmentId !== "string" || assignmentId.length === 0) {
    throw new Error("Codex envelope is missing metadata.activeAssignmentId.");
  }
  return assignmentId;
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
        status: outcome.resultStatus === "" ? "partial" : outcome.resultStatus,
        summary: preferNonEmpty(outcome.resultSummary, "Codex run completed without a summary."),
        changedFiles: uniqueChangedFiles(outcome.changedFiles),
        createdAt: completedAt
      }
    }
  };
}

function buildFailedOutcome(
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

function buildRunRecord(
  outcome: CodexExecutionWithoutArtifacts,
  assignmentId: string,
  startedAt: string,
  completedAt: string,
  threadId?: string
): HostRunRecord {
  if (outcome.outcome.kind === "decision") {
    return {
      assignmentId,
      state: "completed",
      ...(threadId ? { hostRunId: threadId } : {}),
      startedAt,
      completedAt,
      outcomeKind: "decision",
      summary: outcome.outcome.capture.blockerSummary
    };
  }

  return {
    assignmentId,
    state: "completed",
    ...(threadId ? { hostRunId: threadId } : {}),
    startedAt,
    completedAt,
    outcomeKind: "result",
    resultStatus: outcome.outcome.capture.status,
    summary: outcome.outcome.capture.summary
  };
}

async function readStructuredOutcome(path: string): Promise<CodexStructuredOutcome | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return validateCodexStructuredOutcome(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function parseExecJsonl(stdout: string): {
  threadId?: string;
  errorMessage?: string;
  usage?: HostTelemetryCapture["usage"];
} {
  let threadId: string | undefined;
  let errorMessage: string | undefined;
  let usage: HostTelemetryCapture["usage"];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        threadId = event.thread_id;
      }
      if (event.type === "error" && typeof event.message === "string") {
        errorMessage = event.message;
      }
      if (
        event.type === "turn.completed" &&
        event.usage &&
        typeof event.usage === "object" &&
        !Array.isArray(event.usage)
      ) {
        const value = event.usage as Record<string, unknown>;
        usage = {
          ...(typeof value.input_tokens === "number" ? { inputTokens: value.input_tokens } : {}),
          ...(typeof value.output_tokens === "number"
            ? { outputTokens: value.output_tokens }
            : {}),
          ...(typeof value.cached_input_tokens === "number"
            ? { cachedTokens: value.cached_input_tokens }
            : {}),
          ...(typeof value.reasoning_tokens === "number"
            ? { reasoningTokens: value.reasoning_tokens }
            : {}),
          ...(typeof value.input_tokens === "number" && typeof value.output_tokens === "number"
            ? { totalTokens: value.input_tokens + value.output_tokens }
            : {})
        };
      }
    } catch {
      continue;
    }
  }

  return {
    ...(threadId ? { threadId } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(usage ? { usage } : {})
  };
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

function preferNonEmpty(value: string, fallback: string): string {
  return value.trim().length > 0 ? value : fallback;
}

function uniqueChangedFiles(files: string[]): string[] {
  return [...new Set(files.filter((file) => file.trim().length > 0))];
}

function createRunningRecord(
  assignmentId: string,
  startedAt: string,
  hostRunId?: string
): HostRunRecord {
  return {
    assignmentId,
    state: "running",
    ...(hostRunId ? { hostRunId } : {}),
    startedAt
  };
}

async function deriveExecutionOutcome(
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

async function loadValidatedStructuredOutcome(path: string): Promise<CodexStructuredOutcome> {
  const raw = await readFile(path, "utf8");
  return validateCodexStructuredOutcome(JSON.parse(raw));
}

function summarizeStructuredOutputFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Codex run returned invalid structured output: ${detail}`;
}

function summarizeExecutionError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Codex run failed before completion: ${detail}`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
