import { access, link, mkdir, open, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  AdapterCapabilities,
  DoctorCheck,
  HostAdapter,
  HostDecisionCapture,
  HostExecutionOutcome,
  HostResultCapture,
  HostTelemetryCapture,
  RuntimeArtifactStore,
  TaskEnvelope
} from "../../../adapters/contract.js";
import type {
  DecisionPacket,
  HostRunRecord,
  RecoveryBrief,
  ResultPacket,
  RuntimeProjection
} from "../../../core/types.js";
import { getNativeRunId, selectAuthoritativeRunRecord } from "../../../core/run-state.js";
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
  codexExecutionOutputSchema
} from "./prompt.js";
import {
  buildRunRecord,
  createRunningRecord,
  parseExecJsonl,
  readLeaseRecord,
  withNativeRunId
} from "./run-records.js";
import {
  buildFailedOutcome,
  deriveExecutionOutcome,
  fileExists,
  readPositiveIntEnv,
  stopRunningExec,
  summarizeExecutionError
} from "./execution.js";

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

  async initialize(store: RuntimeArtifactStore, _projection: RuntimeProjection): Promise<void> {
    const paths = this.paths(store);
    await writeCodexKernel(paths.kernelPath);

    const profileManager = new CodexProfileManager(store);
    await profileManager.install(paths.kernelPath);
    await store.writeJsonArtifact(`adapters/${this.id}/capabilities.json`, this.getCapabilities());
    await store.writeJsonArtifact(`adapters/${this.id}/exec-output-schema.json`, codexExecutionOutputSchema());
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
      const runRecord = buildRunRecord(
        outcome,
        assignmentId,
        startedAt,
        completedAt,
        getNativeRunId(runningRecord)
      );
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
            nativeRunId: getNativeRunId(runningRecord) ?? "",
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
            if (hostRunId && getNativeRunId(runningRecord) !== hostRunId) {
              runningRecord = withNativeRunId(runningRecord, hostRunId);
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
          getNativeRunId(runningRecord)
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
              nativeRunId: getNativeRunId(runningRecord) ?? "",
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
      const nativeRunId = getNativeRunId(runningRecord) ?? transcript.threadId;

      const outcome = await deriveExecutionOutcome(
        assignmentId,
        completedAt,
        execution,
        outputPath,
        transcript.errorMessage
      );

      const runRecord = buildRunRecord(outcome, assignmentId, startedAt, completedAt, nativeRunId);
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
            nativeRunId: nativeRunId ?? "",
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
      const runRecord = await store.readJsonArtifact<HostRunRecord>(
        `adapters/${this.id}/runs/${assignmentId}.json`,
        "codex run record"
      );
      const leaseRecord = await this.readLeaseRecord(store, assignmentId);
      return selectAuthoritativeRunRecord(runRecord, leaseRecord);
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
    return readLeaseRecord(
      store,
      `adapters/${this.id}/runs/${assignmentId}.lease.json`,
      this.runLeasePath(store, assignmentId),
      assignmentId
    );
  }
}

function readEnvelopeAssignmentId(envelope: TaskEnvelope): string {
  const assignmentId = envelope.metadata.activeAssignmentId;
  if (typeof assignmentId !== "string" || assignmentId.length === 0) {
    throw new Error("Codex envelope is missing metadata.activeAssignmentId.");
  }
  return assignmentId;
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
}
