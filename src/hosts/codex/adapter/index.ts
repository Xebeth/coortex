import { access, open, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  AdapterCapabilities,
  DoctorCheck,
  HostAdapter,
  HostDecisionCapture,
  HostExecutionOutcome,
  HostResultCapture,
  HostSessionLifecycle,
  HostSessionResumeResult,
  HostTelemetryCapture,
  RuntimeArtifactStore,
  TaskEnvelope
} from "../../../adapters/contract.js";
import {
  buildCompletedRunRecord,
  createRunningRunRecord,
  withRunNativeId
} from "../../../adapters/host-run-records.js";
import { materializeInspectableRunRecord } from "../../../adapters/host-run-inspection.js";
import { HostRunStore, type HostRunArtifactPaths } from "../../../adapters/host-run-store.js";
import {
  executeHostResumeSession,
  executeHostRunSession,
  type HostRunHandle,
  type HostRunSessionTracking
} from "../../../adapters/host-run-session.js";
import type {
  DecisionPacket,
  HostRunRecord,
  RecoveryBrief,
  ResultPacket,
  RuntimeProjection
} from "../../../core/types.js";
import {
  COORTEX_RECLAIM_LEASE_KEY,
  getNativeRunId,
  isCoortexReclaimLease,
  isRunLeaseExpired
} from "../../../core/run-state.js";
import { nowIso } from "../../../utils/time.js";
import { buildTaskEnvelope } from "./envelope.js";
import type { CodexPaths } from "./types.js";
import { writeCodexKernel } from "../kernel/static.js";
import { CodexProfileManager } from "../profile/manager.js";
import {
  DefaultCodexCommandRunner,
  type CodexCommandRunner,
  type CodexExecResult,
  type CodexResumeInput,
  type RunningExec
} from "./cli.js";
import {
  buildCodexExecutionPrompt,
  codexExecutionOutputSchema
} from "./prompt.js";
import {
  parseExecJsonl,
} from "./run-records.js";
import {
  buildFailedOutcome,
  deriveExecutionOutcome,
  fileExists,
  readPositiveIntEnv,
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
  private readonly runner: CodexCommandRunner;
  private readonly options: CodexAdapterOptions;

  constructor(runner?: CodexCommandRunner, options: CodexAdapterOptions = {}) {
    this.options = options;
    this.runner = runner ?? new DefaultCodexCommandRunner(options);
  }

  getCapabilities(): AdapterCapabilities {
    const supportsNativeSessionResume =
      typeof this.runner.runResume === "function" || typeof this.runner.startResume === "function";
    return {
      supportsProfiles: true,
      supportsHooks: false,
      supportsRecoveryEnvelope: true,
      supportsSessionIdentity: true,
      supportsNativeSessionResume,
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

  private runArtifacts(): HostRunArtifactPaths {
    return {
      runRecordPath: (assignmentId) => `adapters/${this.id}/runs/${assignmentId}.json`,
      runLeasePath: (assignmentId) => `adapters/${this.id}/runs/${assignmentId}.lease.json`,
      lastRunPath: () => `adapters/${this.id}/last-run.json`
    };
  }

  private runStore(store: RuntimeArtifactStore): HostRunStore {
    return new HostRunStore(store, this.id, this.runArtifacts());
  }

  private hostSessionTracking<TExecution extends { exitCode: number }>(): HostRunSessionTracking<TExecution> {
    return {
      setActiveRun: (run) => {
        this.activeRun = run as RunningExec | undefined;
      },
      setActiveExecutionSettled: (settled) => {
        this.activeExecutionSettled = settled;
      }
    };
  }

  private async startResumeHandle(
    input: CodexResumeInput
  ): Promise<HostRunHandle<CodexExecResult>> {
    if (this.runner.startResume) {
      return this.runner.startResume(input);
    }
    const resumeExecution = this.runner.runResume!(input);
    return {
      result: resumeExecution,
      terminate: async () => undefined,
      waitForExit: async () => {
        const execution = await resumeExecution;
        return { code: execution.exitCode };
      }
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
    claimedRun?: HostRunRecord,
    lifecycle?: HostSessionLifecycle
  ): Promise<HostExecutionOutcome> {
    const assignmentId = readEnvelopeAssignmentId(envelope);
    const startedAt = claimedRun?.startedAt ?? nowIso();
    const paths = this.paths(store);
    const executionId = randomUUID();
    const outputPath = join(paths.runsDir, `${assignmentId}-${executionId}-last-message.json`);
    const prompt = buildCodexExecutionPrompt(envelope);
    const leaseMs = readPositiveIntEnv("COORTEX_RUN_LEASE_MS", DEFAULT_RUN_LEASE_MS);
    const heartbeatMs = readPositiveIntEnv("COORTEX_RUN_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS);
    const runStore = this.runStore(store);
    let runningRecord = claimedRun ?? createRunningRunRecord(assignmentId, startedAt, leaseMs);
    let schemaPath: string;
    try {
      schemaPath = await store.writeJsonArtifact(
        `adapters/${this.id}/exec-output-schema.json`,
        codexExecutionOutputSchema()
      );
      if (!claimedRun) {
        await runStore.claim(runningRecord);
      }
    } catch (error) {
      const completedAt = nowIso();
      const outcome = buildFailedOutcome(
        assignmentId,
        completedAt,
        `Codex run failed before launch: ${error instanceof Error ? error.message : String(error)}`
      );
      const runRecord = buildCompletedRunRecord(
        outcome,
        assignmentId,
        startedAt,
        completedAt,
        getNativeRunId(runningRecord)
      );
      const warning = await runStore.persistWarning(runRecord);
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
    return executeHostRunSession<CodexExecResult>({
      assignmentId,
      startedAt,
      taskId: projection.sessionId,
      runStore,
      runRecord: runningRecord,
      leaseMs,
      heartbeatMs,
      startRun: ({ onNativeRunId }) =>
        this.runner.startExec({
          cwd: projection.rootPath,
          prompt,
          outputSchemaPath: schemaPath,
          outputPath,
          onEvent: async (event) => {
            const hostRunId =
              event.type === "thread.started" && typeof event.thread_id === "string"
                ? event.thread_id
                : undefined;
            if (hostRunId) {
              await onNativeRunId(hostRunId);
            }
          }
        }),
      summarizeExecutionFailure: summarizeExecutionError,
      buildFailedOutcome,
      deriveCompleted: async (execution, persistedNativeRunId) => {
        const completedAt = nowIso();
        const completed = await deriveCodexExecutionCompletion(
          assignmentId,
          completedAt,
          execution,
          outputPath
        );
        return {
          outcome: completed.outcome,
          ...(persistedNativeRunId ? { nativeRunId: persistedNativeRunId } : {}),
          ...(completed.usage ? { usage: completed.usage } : {})
        };
      },
      ...(lifecycle?.onSessionIdentity
        ? { onSessionIdentity: lifecycle.onSessionIdentity }
        : {}),
      ...this.hostSessionTracking<CodexExecResult>()
    });
  }

  async resumeSession(
    store: RuntimeArtifactStore,
    projection: RuntimeProjection,
    envelope: TaskEnvelope,
    attachment: import("../../../core/types.js").RuntimeAttachment,
    lifecycle?: HostSessionLifecycle
  ): Promise<HostSessionResumeResult> {
    if (!attachment.nativeSessionId) {
      throw new Error(`Attachment ${attachment.id} is missing a stored native Codex session id.`);
    }
    if (!this.runner.runResume && !this.runner.startResume) {
      throw new Error("The configured Codex runner does not support wrapped session resume.");
    }

    const requestedSessionId = attachment.nativeSessionId;
    const assignmentId = readEnvelopeAssignmentId(envelope);
    const leaseMs = readPositiveIntEnv("COORTEX_RUN_LEASE_MS", DEFAULT_RUN_LEASE_MS);
    const heartbeatMs = readPositiveIntEnv("COORTEX_RUN_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS);
    const runStore = this.runStore(store);
    const startedAt = nowIso();
    const requestedReclaimRecord = {
      ...createRunningRunRecord(assignmentId, startedAt, leaseMs, requestedSessionId),
      adapterData: {
        nativeRunId: requestedSessionId,
        [COORTEX_RECLAIM_LEASE_KEY]: true
      }
    } satisfies HostRunRecord;
    let runningRecord = await runStore.claimOrAdopt(
      requestedReclaimRecord,
      (current) =>
        current.state === "running" &&
        !isRunLeaseExpired(current) &&
        getNativeRunId(current) === requestedSessionId &&
        !isCoortexReclaimLease(current),
      (current) => {
        const adoptedAt = nowIso();
        return {
          ...withRunNativeId(current, requestedSessionId),
          heartbeatAt: adoptedAt,
          leaseExpiresAt: new Date(Date.parse(adoptedAt) + leaseMs).toISOString(),
          adapterData: {
            ...(current.adapterData ?? {}),
            nativeRunId: requestedSessionId,
            [COORTEX_RECLAIM_LEASE_KEY]: true
          }
        };
      }
    );

    const paths = this.paths(store);
    const executionId = randomUUID();
    const outputPath = join(paths.runsDir, `${assignmentId}-${executionId}-resume-last-message.json`);
    let observedSessionId: string | undefined;
    let verifiedSessionId: string | undefined;
    return executeHostResumeSession<CodexExecResult>({
      assignmentId,
      startedAt: runningRecord.startedAt,
      taskId: projection.sessionId,
      requestedSessionId,
      runStore,
      runRecord: runningRecord,
      leaseMs,
      heartbeatMs,
      startRun: async ({ onSessionIdentity }) =>
        this.startResumeHandle({
          cwd: projection.rootPath,
          sessionId: requestedSessionId,
          prompt: buildCodexExecutionPrompt(envelope),
          outputPath,
          onEvent: async (event: Record<string, unknown>) => {
            const sessionId = readResumeSessionId(event);
            if (!sessionId) {
              return;
            }
            if (!observedSessionId) {
              observedSessionId = sessionId;
            }
            if (sessionId === requestedSessionId && verifiedSessionId !== requestedSessionId) {
              verifiedSessionId = sessionId;
              await onSessionIdentity({
                nativeSessionId: sessionId,
                metadata: {
                  resumeEventType:
                    typeof event.type === "string" && event.type.length > 0 ? event.type : "thread.event"
                }
              });
            }
          },
          ...(this.options.dangerouslyBypassApprovalsAndSandbox !== undefined
            ? {
                dangerouslyBypassApprovalsAndSandbox:
                  this.options.dangerouslyBypassApprovalsAndSandbox
              }
            : {})
        }),
      deriveCompleted: async (execution) => {
        const completed = await deriveCodexExecutionCompletion(
          assignmentId,
          nowIso(),
          execution,
          outputPath
        );
        return {
          outcome: completed.outcome,
          ...(completed.usage ? { usage: completed.usage } : {})
        };
      },
      getObservedSessionId: () => observedSessionId,
      getVerifiedSessionId: () => verifiedSessionId,
      summarizeExecutionFailure: summarizeExecutionError,
      summarizeVerificationFailure: summarizeResumeVerificationFailure,
      ...(lifecycle?.onSessionIdentity
        ? { onSessionIdentity: lifecycle.onSessionIdentity }
        : {}),
      ...this.hostSessionTracking<CodexExecResult>()
    });
  }

  async claimRunLease(
    store: RuntimeArtifactStore,
    _projection: RuntimeProjection,
    assignmentId: string
  ): Promise<HostRunRecord> {
    const leaseMs = readPositiveIntEnv("COORTEX_RUN_LEASE_MS", DEFAULT_RUN_LEASE_MS);
    const startedAt = nowIso();
    const runningRecord = createRunningRunRecord(assignmentId, startedAt, leaseMs);
    await this.runStore(store).claim(runningRecord);
    return runningRecord;
  }

  async hasRunLease(store: RuntimeArtifactStore, assignmentId: string): Promise<boolean> {
    return this.runStore(store).hasLease(assignmentId);
  }

  async clearRunLease(store: RuntimeArtifactStore, assignmentId: string): Promise<void> {
    await this.runStore(store).clearLease(assignmentId);
  }

  async releaseRunLease(store: RuntimeArtifactStore, assignmentId: string): Promise<void> {
    await this.runStore(store).release(assignmentId);
  }

  async reconcileStaleRun(store: RuntimeArtifactStore, record: HostRunRecord): Promise<void> {
    await this.runStore(store).write(record);
  }

  async inspectRun(
    store: RuntimeArtifactStore,
    assignmentId?: string
  ): Promise<HostRunRecord | undefined> {
    return materializeInspectableRunRecord(
      await this.runStore(store).inspectArtifacts(assignmentId),
      { includeMalformedLeaseRecord: true }
    );
  }

  async inspectRuns(store: RuntimeArtifactStore): Promise<HostRunRecord[]> {
    return (await this.runStore(store).inspectAllArtifacts())
      .map((inspection) =>
        materializeInspectableRunRecord(inspection, { includeMalformedLeaseRecord: true })
      )
      .filter((record) => record !== undefined);
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
}

function readEnvelopeAssignmentId(envelope: TaskEnvelope): string {
  const assignmentId = envelope.metadata.activeAssignmentId;
  if (typeof assignmentId !== "string" || assignmentId.length === 0) {
    throw new Error("Codex envelope is missing metadata.activeAssignmentId.");
  }
  return assignmentId;
}

async function deriveCodexExecutionCompletion(
  assignmentId: string,
  completedAt: string,
  execution: CodexExecResult,
  outputPath: string
): Promise<{
  outcome: Pick<HostExecutionOutcome, "outcome">;
  nativeRunId?: string;
  usage?: HostTelemetryCapture["usage"];
}> {
  const transcript = parseExecJsonl(execution.stdout);
  const outcome = await deriveExecutionOutcome(
    assignmentId,
    completedAt,
    execution,
    outputPath,
    transcript.errorMessage,
    transcript.lastAgentMessage
  );
  return {
    outcome,
    ...(transcript.threadId ? { nativeRunId: transcript.threadId } : {}),
    ...(transcript.usage ? { usage: transcript.usage } : {})
  };
}

function summarizeResumeVerificationFailure(
  requestedSessionId: string,
  observedSessionId: string | undefined,
  execution?: { exitCode: number; stdout: string; stderr: string }
): string {
  if (!observedSessionId) {
    const detail = execution ? execution.stderr.trim() || execution.stdout.trim() : "";
    return detail.length > 0
      ? `Codex resume did not confirm the requested session ${requestedSessionId}. ${detail}`
      : `Codex resume exited successfully but did not confirm the requested session ${requestedSessionId}.`;
  }
  return `Codex resume resumed session ${observedSessionId} instead of requested session ${requestedSessionId}.`;
}

function readResumeSessionId(event: Record<string, unknown>): string | undefined {
  if (typeof event.thread_id !== "string" || event.thread_id.length === 0) {
    return undefined;
  }
  if (typeof event.type !== "string" || !event.type.startsWith("thread.")) {
    return undefined;
  }
  return event.thread_id;
}
