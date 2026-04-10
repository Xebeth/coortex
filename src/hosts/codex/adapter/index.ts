import { access, link, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
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
import { parseJson } from "../../../utils/json.js";

type CodexExecutionWithoutArtifacts = Pick<HostExecutionOutcome, "outcome">;

export interface CodexAdapterOptions {
  dangerouslyBypassApprovalsAndSandbox?: boolean;
}

const DEFAULT_RUN_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 5_000;

export class CodexAdapter implements HostAdapter {
  readonly id = "codex";
  readonly host = "codex";
  private activeRun: RunningExec | undefined;
  private activeExecutionSettled: Promise<void> | undefined;
  private runRecordWriteQueue: Promise<void> = Promise.resolve();
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
    envelope: TaskEnvelope,
    claimedRun?: HostRunRecord
  ): Promise<HostExecutionOutcome> {
    const assignmentId = readEnvelopeAssignmentId(envelope);
    const startedAt = claimedRun?.startedAt ?? nowIso();
    const paths = this.paths(store);
    const executionId = randomUUID();
    const outputPath = join(paths.runsDir, `${assignmentId}-${executionId}-last-message.json`);
    const prompt = buildCodexExecutionPrompt(envelope);
    const leaseMs = readPositiveIntEnv("COORTEX_RUN_LEASE_MS", DEFAULT_RUN_LEASE_MS);
    const heartbeatMs = readPositiveIntEnv("COORTEX_RUN_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS);
    let runningRecord = claimedRun ?? createRunningRecord(assignmentId, startedAt, leaseMs);
    let schemaPath: string;
    try {
      schemaPath = await store.writeJsonArtifact(
        `adapters/${this.id}/exec-output-schema.json`,
        codexExecutionOutputSchema()
      );
      if (!claimedRun) {
        await this.claimRunRecord(store, runningRecord);
      }
    } catch (error) {
      const completedAt = nowIso();
      const outcome = buildFailedOutcome(
        assignmentId,
        completedAt,
        `Codex run failed before launch: ${error instanceof Error ? error.message : String(error)}`
      );
      const runRecord = buildRunRecord(outcome, assignmentId, startedAt, completedAt, runningRecord.hostRunId);
      const warning = await this.persistRunRecordWarning(store, runRecord);
      return {
        ...outcome,
        run: runRecord,
        ...(warning ? { warning } : {}),
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
    }
    let heartbeatTimer: NodeJS.Timeout | undefined;
    const metadataWarnings: string[] = [];
    let metadataFailureReject!: (error: Error) => void;
    const metadataFailure = new Promise<never>((_, reject) => {
      metadataFailureReject = reject;
    });
    let metadataFailureRaised = false;
    let runClosed = false;
    let runPhase = 0;
    const refreshLease = async () => {
      if (runClosed || runningRecord.state !== "running") {
        return;
      }
      const phase = runPhase;
      const heartbeatAt = nowIso();
      const nextRecord: HostRunRecord = {
        ...runningRecord,
        heartbeatAt,
        leaseExpiresAt: new Date(Date.parse(heartbeatAt) + leaseMs).toISOString()
      };
      if (runClosed || runningRecord.state !== "running" || phase !== runPhase) {
        return;
      }
      runningRecord = nextRecord;
      await this.writeRunRecord(store, runningRecord);
    };
    const recordMetadataWarning = (error: unknown, context: string) => {
      const message = error instanceof Error ? error.message : String(error);
      metadataWarnings.push(`Host run metadata persistence failed during ${context}. ${message}`);
    };
    const failRunOnMetadataError = (error: unknown, context: string) => {
      if (metadataFailureRaised) {
        return;
      }
      metadataFailureRaised = true;
      const message = error instanceof Error ? error.message : String(error);
      metadataFailureReject(new Error(`Host run metadata persistence failed during ${context}. ${message}`));
    };
    const collectWarnings = (...warnings: Array<string | undefined>) => {
      const all = [...metadataWarnings, ...warnings.filter((value): value is string => !!value)];
      return all.length > 0 ? all.join(" ") : undefined;
    };

    const runPromise = (async (): Promise<HostExecutionOutcome> => {
      let execution;
      let running: RunningExec | undefined;
      try {
        running = await this.runner.startExec({
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
              try {
                await this.writeRunRecord(store, runningRecord);
              } catch (error) {
                recordMetadataWarning(error, "thread-start handling");
              }
            }
          }
        });
        this.activeRun = running;
        await refreshLease();
        heartbeatTimer = setInterval(() => {
          void refreshLease().catch((error) => {
            failRunOnMetadataError(error, "heartbeat refresh");
          });
        }, heartbeatMs);
        execution = await Promise.race([running.result, metadataFailure]);
        runClosed = true;
        runPhase += 1;
      } catch (error) {
        runClosed = true;
        runPhase += 1;
        if (running) {
          await stopRunningExec(running);
        }
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
        const warning = collectWarnings(await this.persistRunRecordWarning(store, runRecord));
        return {
          ...outcome,
          run: runRecord,
          ...(warning ? { warning } : {}),
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
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
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
      const warning = collectWarnings(await this.persistRunRecordWarning(store, runRecord));

      return {
        ...outcome,
        run: runRecord,
        ...(warning ? { warning } : {}),
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
    })();
    const settled = runPromise.then(() => undefined, () => undefined);
    this.activeExecutionSettled = settled;
    try {
      return await runPromise;
    } finally {
      if (this.activeExecutionSettled === settled) {
        this.activeExecutionSettled = undefined;
      }
    }
  }

  async claimRunLease(
    store: RuntimeArtifactStore,
    _projection: RuntimeProjection,
    assignmentId: string
  ): Promise<HostRunRecord> {
    const leaseMs = readPositiveIntEnv("COORTEX_RUN_LEASE_MS", DEFAULT_RUN_LEASE_MS);
    const startedAt = nowIso();
    const runningRecord = createRunningRecord(assignmentId, startedAt, leaseMs);
    await this.claimRunRecord(store, runningRecord);
    return runningRecord;
  }

  async releaseRunLease(store: RuntimeArtifactStore, assignmentId: string): Promise<void> {
    await store.deleteArtifact(`adapters/${this.id}/runs/${assignmentId}.lease.json`);
    await store.deleteArtifact(`adapters/${this.id}/runs/${assignmentId}.json`);
    const lastRun = await store.readJsonArtifact<HostRunRecord>(
      `adapters/${this.id}/last-run.json`,
      "codex run record"
    );
    if (lastRun?.assignmentId === assignmentId && lastRun.state === "running") {
      await store.deleteArtifact(`adapters/${this.id}/last-run.json`);
    }
  }

  async inspectRun(
    store: RuntimeArtifactStore,
    assignmentId?: string
  ): Promise<HostRunRecord | undefined> {
    if (assignmentId) {
      const leaseRecord = await this.readLeaseRecord(store, assignmentId);
      const runRecord = await store.readJsonArtifact<HostRunRecord>(
        `adapters/${this.id}/runs/${assignmentId}.json`,
        "codex run record"
      );
      if (leaseRecord?.state === "running") {
        return leaseRecord;
      }
      if (runRecord) {
        return runRecord;
      }
      return leaseRecord;
    }
    return store.readJsonArtifact<HostRunRecord>(`adapters/${this.id}/last-run.json`, "codex run record");
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
    await this.activeExecutionSettled;
  }

  private async writeRunRecord(store: RuntimeArtifactStore, record: HostRunRecord): Promise<void> {
    const writePromise = this.runRecordWriteQueue.catch(() => undefined).then(async () => {
      if (record.state === "running") {
        await store.writeJsonArtifact(`adapters/${this.id}/runs/${record.assignmentId}.lease.json`, record);
      } else {
        await rm(this.runLeasePath(store, record.assignmentId), { force: true });
      }
      await store.writeJsonArtifact(`adapters/${this.id}/runs/${record.assignmentId}.json`, record);
      await store.writeJsonArtifact(`adapters/${this.id}/last-run.json`, record);
    });
    this.runRecordWriteQueue = writePromise.catch(() => undefined);
    await writePromise;
  }

  private async persistRunRecordWarning(
    store: RuntimeArtifactStore,
    record: HostRunRecord
  ): Promise<string | undefined> {
    try {
      await this.writeRunRecord(store, record);
      return undefined;
    } catch (error) {
      if (record.state !== "running") {
        await rm(this.runLeasePath(store, record.assignmentId), { force: true }).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : String(error);
      return `Host run outcome was preserved, but the final run record could not be persisted. ${message}`;
    }
  }

  private async claimRunRecord(store: RuntimeArtifactStore, record: HostRunRecord): Promise<void> {
    const leasePath = this.runLeasePath(store, record.assignmentId);
    await mkdir(this.paths(store).runsDir, { recursive: true });
    const tempLeasePath = `${leasePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempLeasePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      await link(tempLeasePath, leasePath);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new Error(`Assignment ${record.assignmentId} already has an active host run lease.`);
      }
      throw error;
    } finally {
      await rm(tempLeasePath, { force: true }).catch(() => undefined);
    }
    try {
      await store.writeJsonArtifact(`adapters/${this.id}/runs/${record.assignmentId}.json`, record);
      await store.writeJsonArtifact(`adapters/${this.id}/last-run.json`, record);
    } catch (error) {
      await rm(leasePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private runLeasePath(store: RuntimeArtifactStore, assignmentId: string): string {
    return join(this.paths(store).runsDir, `${assignmentId}.lease.json`);
  }

  private async readLeaseRecord(
    store: RuntimeArtifactStore,
    assignmentId: string
  ): Promise<HostRunRecord | undefined> {
    const relativePath = `adapters/${this.id}/runs/${assignmentId}.lease.json`;
    try {
      return await store.readJsonArtifact<HostRunRecord>(relativePath, "codex run lease");
    } catch {
      const content = await this.readLeaseContentOrUndefined(this.runLeasePath(store, assignmentId));
      if (content === undefined) {
        return undefined;
      }
      try {
        return parseJson<HostRunRecord>(content, "codex run lease");
      } catch {
        await store.deleteArtifact(relativePath);
        return {
          assignmentId,
          state: "running",
          startedAt: nowIso()
        };
      }
    }
  }

  private async readLeaseContentOrUndefined(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
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
  leaseMs: number,
  hostRunId?: string
): HostRunRecord {
  return {
    assignmentId,
    state: "running",
    ...(hostRunId ? { hostRunId } : {}),
    startedAt,
    heartbeatAt: startedAt,
    leaseExpiresAt: new Date(Date.parse(startedAt) + leaseMs).toISOString()
  };
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
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

async function stopRunningExec(running: RunningExec): Promise<void> {
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
