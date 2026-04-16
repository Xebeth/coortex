import { randomUUID } from "node:crypto";

import type {
  HostExecutionOutcome,
  HostSessionIdentity,
  HostSessionResumeResult,
  HostTelemetryCapture
} from "./contract.js";
import { getNativeRunId } from "../core/run-state.js";
import type { HostRunRecord } from "../core/types.js";
import { nowIso } from "../utils/time.js";
import { buildCompletedRunRecord, withRunNativeId } from "./host-run-records.js";
import { HostRunStore } from "./host-run-store.js";

export interface HostRunHandle<TExecution> {
  result: Promise<TExecution>;
  terminate(signal?: "graceful" | "force"): Promise<void>;
  waitForExit(timeoutMs?: number): Promise<{ code: number | null }>;
}

export interface HostRunSessionResult<TExecution extends { exitCode: number }> {
  outcome: Pick<HostExecutionOutcome, "outcome">;
  nativeRunId?: string;
  usage?: HostTelemetryCapture["usage"];
  execution: TExecution;
}

export interface ExecuteHostRunSessionInput<TExecution extends { exitCode: number }> {
  assignmentId: string;
  startedAt: string;
  taskId: string;
  runStore: HostRunStore;
  runRecord: HostRunRecord;
  leaseMs: number;
  heartbeatMs: number;
  startRun: (handlers: {
    onNativeRunId: (nativeRunId: string) => Promise<void>;
  }) => Promise<HostRunHandle<TExecution>>;
  summarizeExecutionFailure: (error: unknown) => string;
  buildFailedOutcome: (
    assignmentId: string,
    completedAt: string,
    summary: string
  ) => Pick<HostExecutionOutcome, "outcome">;
  deriveCompleted: (
    execution: TExecution,
    nativeRunId: string | undefined
  ) => Promise<Omit<HostRunSessionResult<TExecution>, "execution">>;
  onSessionIdentity?: (identity: HostSessionIdentity) => Promise<void>;
  setActiveRun: (run: HostRunHandle<TExecution> | undefined) => void;
  setActiveExecutionSettled: (settled: Promise<void> | undefined) => void;
}

export interface ExecuteHostResumeSessionInput<TExecution extends { exitCode: number }> {
  assignmentId: string;
  startedAt: string;
  taskId: string;
  requestedSessionId: string;
  runStore: HostRunStore;
  runRecord: HostRunRecord;
  leaseMs: number;
  heartbeatMs: number;
  startRun: () => Promise<HostRunHandle<TExecution>>;
  deriveCompleted: (execution: TExecution) => Promise<{
    outcome: Pick<HostExecutionOutcome, "outcome">;
    usage?: HostTelemetryCapture["usage"];
  }>;
  getObservedSessionId: () => string | undefined;
  getVerifiedSessionId: () => string | undefined;
  summarizeExecutionFailure: (error: unknown) => string;
  summarizeVerificationFailure: (
    requestedSessionId: string,
    observedSessionId: string | undefined,
    execution: TExecution
  ) => string | undefined;
  setActiveRun: (run: HostRunHandle<TExecution> | undefined) => void;
  setActiveExecutionSettled: (settled: Promise<void> | undefined) => void;
}

interface RunningRecordMutationResult {
  applied: boolean;
  changed: boolean;
}

interface RunningRecordController {
  current(): HostRunRecord;
  phase(): number;
  close(): void;
  waitForWrites(): Promise<void>;
  update(
    phase: number,
    mutate: (record: HostRunRecord) => HostRunRecord
  ): Promise<RunningRecordMutationResult>;
}

export async function executeHostRunSession<TExecution extends { exitCode: number }>(
  input: ExecuteHostRunSessionInput<TExecution>
): Promise<HostExecutionOutcome> {
  const runningRecord = createRunningRecordController(input.runStore, input.runRecord);
  let heartbeatTimer: NodeJS.Timeout | undefined;
  const metadataWarnings: string[] = [];
  let metadataFailureReject!: (error: Error) => void;
  const metadataFailure = new Promise<never>((_, reject) => {
    metadataFailureReject = reject;
  });
  let metadataFailureRaised = false;

  const refreshLease = async () => {
    const phase = runningRecord.phase();
    const heartbeatAt = nowIso();
    await runningRecord.update(phase, (current) => ({
      ...current,
      heartbeatAt,
      leaseExpiresAt: new Date(Date.parse(heartbeatAt) + input.leaseMs).toISOString()
    }));
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
    let execution: TExecution;
    let running: HostRunHandle<TExecution> | undefined;
    try {
      running = await input.startRun({
        onNativeRunId: async (nativeRunId) => {
          const phase = runningRecord.phase();
          try {
            const updated = await runningRecord.update(phase, (current) =>
              getNativeRunId(current) === nativeRunId ? current : withRunNativeId(current, nativeRunId)
            );
            if (!updated.changed) {
              return;
            }
          } catch (error) {
            recordMetadataWarning(error, "thread-start handling");
            return;
          }
          await input.onSessionIdentity?.({ nativeSessionId: nativeRunId });
        }
      });
      input.setActiveRun(running);
      await refreshLease();
      heartbeatTimer = setInterval(() => {
        void refreshLease().catch((error) => {
          failRunOnMetadataError(error, "heartbeat refresh");
        });
      }, input.heartbeatMs);
      execution = await Promise.race([running.result, metadataFailure]);
      runningRecord.close();
    } catch (error) {
      runningRecord.close();
      if (running) {
        await stopHostRun(running);
      }
      await runningRecord.waitForWrites();
      const completedAt = nowIso();
      const outcome = ensureStableOutcomeIds(input.buildFailedOutcome(
        input.assignmentId,
        completedAt,
        input.summarizeExecutionFailure(error)
      ));
      const runRecord = buildCompletedRunRecord(
        outcome,
        input.assignmentId,
        input.startedAt,
        completedAt,
        getNativeRunId(runningRecord.current())
      );
      const warning = collectWarnings(await input.runStore.persistWarning(runRecord));
      return {
        ...outcome,
        run: runRecord,
        ...(warning ? { warning } : {}),
        telemetry: {
          eventType: "host.run.completed",
          taskId: input.taskId,
          assignmentId: input.assignmentId,
          metadata: {
            nativeRunId: getNativeRunId(runningRecord.current()) ?? "",
            exitCode: -1,
            outcomeKind: outcome.outcome.kind
          }
        }
      };
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      input.setActiveRun(undefined);
    }

    try {
      await runningRecord.waitForWrites();
      const completedAt = nowIso();
      const completed = await input.deriveCompleted(execution, getNativeRunId(runningRecord.current()));
      const outcome = ensureStableOutcomeIds(completed.outcome);
      const runRecord = buildCompletedRunRecord(
        outcome,
        input.assignmentId,
        input.startedAt,
        completedAt,
        completed.nativeRunId
      );
      const warning = collectWarnings(await input.runStore.persistWarning(runRecord));

      return {
        ...outcome,
        run: runRecord,
        ...(warning ? { warning } : {}),
        telemetry: {
          eventType: "host.run.completed",
          taskId: input.taskId,
          assignmentId: input.assignmentId,
          metadata: {
            nativeRunId: completed.nativeRunId ?? "",
            exitCode: execution.exitCode,
            outcomeKind: outcome.outcome.kind
          },
          ...(completed.usage ? { usage: completed.usage } : {})
        }
      };
    } catch (error) {
      const completedAt = nowIso();
      const outcome = ensureStableOutcomeIds(input.buildFailedOutcome(
        input.assignmentId,
        completedAt,
        input.summarizeExecutionFailure(error)
      ));
      const runRecord = buildCompletedRunRecord(
        outcome,
        input.assignmentId,
        input.startedAt,
        completedAt,
        getNativeRunId(runningRecord.current())
      );
      const warning = collectWarnings(await input.runStore.persistWarning(runRecord));
      return {
        ...outcome,
        run: runRecord,
        ...(warning ? { warning } : {}),
        telemetry: {
          eventType: "host.run.completed",
          taskId: input.taskId,
          assignmentId: input.assignmentId,
          metadata: {
            nativeRunId: getNativeRunId(runningRecord.current()) ?? "",
            exitCode: execution.exitCode,
            outcomeKind: outcome.outcome.kind
          }
        }
      };
    }
  })();

  const settled = runPromise.then(() => undefined, () => undefined);
  input.setActiveExecutionSettled(settled);
  try {
    return await runPromise;
  } finally {
    input.setActiveExecutionSettled(undefined);
  }
}

export async function executeHostResumeSession<TExecution extends { exitCode: number }>(
  input: ExecuteHostResumeSessionInput<TExecution>
): Promise<HostSessionResumeResult> {
  const runningRecord = createRunningRecordController(input.runStore, input.runRecord);
  let heartbeatTimer: NodeJS.Timeout | undefined;
  const metadataWarnings: string[] = [];
  let metadataFailureReject!: (error: Error) => void;
  const metadataFailure = new Promise<never>((_, reject) => {
    metadataFailureReject = reject;
  });
  let metadataFailureRaised = false;

  const refreshLease = async () => {
    const phase = runningRecord.phase();
    const heartbeatAt = nowIso();
    await runningRecord.update(phase, (current) => ({
      ...current,
      heartbeatAt,
      leaseExpiresAt: new Date(Date.parse(heartbeatAt) + input.leaseMs).toISOString()
    }));
  };

  const collectWarnings = (...warnings: Array<string | undefined>) => {
    const all = [...metadataWarnings, ...warnings.filter((value): value is string => !!value)];
    return all.length > 0 ? all.join(" ") : undefined;
  };

  const buildFailedResumeResult = (inputResult: {
    stoppedAt: string;
    exitCode: number;
    warning: string | undefined;
    observedSessionId: string | undefined;
    verifiedSessionId: string | undefined;
  }): HostSessionResumeResult => ({
    reclaimed: false,
    reclaimState: inputResult.verifiedSessionId ? "verified_then_failed" : "unverified_failed",
    requestedSessionId: input.requestedSessionId,
    ...(inputResult.observedSessionId ? { observedSessionId: inputResult.observedSessionId } : {}),
    ...(inputResult.verifiedSessionId
      ? { verifiedSessionId: inputResult.verifiedSessionId }
      : {}),
    sessionVerified: inputResult.verifiedSessionId === input.requestedSessionId,
    exitCode: inputResult.exitCode,
    stoppedAt: inputResult.stoppedAt,
    ...(inputResult.warning ? { warning: inputResult.warning } : {})
  });

  const failRunOnMetadataError = (error: unknown, context: string) => {
    if (metadataFailureRaised) {
      return;
    }
    metadataFailureRaised = true;
    const message = error instanceof Error ? error.message : String(error);
    metadataFailureReject(new Error(`Host run metadata persistence failed during ${context}. ${message}`));
  };

  const runPromise = (async (): Promise<HostSessionResumeResult> => {
    let execution: TExecution;
    let running: HostRunHandle<TExecution> | undefined;
    try {
      running = await input.startRun();
      input.setActiveRun(running);
      await refreshLease();
      heartbeatTimer = setInterval(() => {
        void refreshLease().catch((error) => {
          failRunOnMetadataError(error, "heartbeat refresh");
        });
      }, input.heartbeatMs);
      execution = await Promise.race([running.result, metadataFailure]);
      runningRecord.close();
    } catch (error) {
      runningRecord.close();
      if (running) {
        await stopHostRun(running);
      }
      await runningRecord.waitForWrites();
      const stoppedAt = nowIso();
      const warning = collectWarnings(input.summarizeExecutionFailure(error));
      const observedSessionId = input.getObservedSessionId();
      const verifiedSessionId = input.getVerifiedSessionId();
      return buildFailedResumeResult({
        stoppedAt,
        exitCode: -1,
        warning,
        observedSessionId,
        verifiedSessionId
      });
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      input.setActiveRun(undefined);
    }

    try {
      await runningRecord.waitForWrites();
      const stoppedAt = nowIso();
      const completed = await input.deriveCompleted(execution);
      const observedSessionId = input.getObservedSessionId();
      const verifiedSessionId = input.getVerifiedSessionId();
      const sessionVerified = verifiedSessionId === input.requestedSessionId;
      const telemetry = {
        eventType: "host.resume.completed",
        taskId: input.taskId,
        assignmentId: input.assignmentId,
        metadata: {
          requestedSessionId: input.requestedSessionId,
          observedSessionId: observedSessionId ?? "",
          verifiedSessionId: verifiedSessionId ?? "",
          sessionVerified,
          exitCode: execution.exitCode,
          reclaimed: sessionVerified,
          reclaimState: sessionVerified ? "reclaimed" : "unverified_failed",
          outcomeKind: completed.outcome.outcome.kind,
          resultStatus:
            completed.outcome.outcome.kind === "result"
              ? completed.outcome.outcome.capture.status
              : ""
        },
        ...(completed.usage ? { usage: completed.usage } : {})
      } satisfies HostTelemetryCapture;

      if (!sessionVerified) {
        const warning = collectWarnings(
          input.summarizeVerificationFailure(
            input.requestedSessionId,
            observedSessionId,
            execution
          )
        );
        return {
          reclaimed: false,
          reclaimState: "unverified_failed",
          requestedSessionId: input.requestedSessionId,
          ...(observedSessionId ? { observedSessionId } : {}),
          ...(verifiedSessionId ? { verifiedSessionId } : {}),
          sessionVerified,
          exitCode: execution.exitCode,
          stoppedAt,
          telemetry,
          ...(warning ? { warning } : {})
        };
      }

      const outcome = ensureStableOutcomeIds(completed.outcome);
      const runRecord = buildCompletedRunRecord(
        outcome,
        input.assignmentId,
        input.startedAt,
        stoppedAt,
        input.requestedSessionId
      );
      const warning = collectWarnings(await input.runStore.persistWarning(runRecord));
      return {
        reclaimed: true,
        reclaimState: "reclaimed",
        requestedSessionId: input.requestedSessionId,
        ...(observedSessionId ? { observedSessionId } : {}),
        verifiedSessionId: input.requestedSessionId,
        sessionVerified,
        exitCode: execution.exitCode,
        stoppedAt,
        outcome: outcome.outcome,
        run: runRecord,
        telemetry,
        ...(warning ? { warning } : {})
      };
    } catch (error) {
      const stoppedAt = nowIso();
      const warning = collectWarnings(input.summarizeExecutionFailure(error));
      const observedSessionId = input.getObservedSessionId();
      const verifiedSessionId = input.getVerifiedSessionId();
      return buildFailedResumeResult({
        stoppedAt,
        exitCode: -1,
        warning,
        observedSessionId,
        verifiedSessionId
      });
    }
  })();

  const settled = runPromise.then(() => undefined, () => undefined);
  input.setActiveExecutionSettled(settled);
  try {
    return await runPromise;
  } finally {
    input.setActiveExecutionSettled(undefined);
  }
}

function createRunningRecordController(
  runStore: HostRunStore,
  initialRecord: HostRunRecord
): RunningRecordController {
  let currentRecord = initialRecord;
  let closed = false;
  let currentPhase = 0;
  let writeQueue: Promise<void> = Promise.resolve();

  const canMutate = (phase: number) =>
    !closed && currentRecord.state === "running" && phase === currentPhase;

  return {
    current: () => currentRecord,
    phase: () => currentPhase,
    close: () => {
      closed = true;
      currentPhase += 1;
    },
    waitForWrites: async () => {
      await writeQueue;
    },
    update: async (phase, mutate) => {
      const updatePromise = writeQueue.catch(() => undefined).then(async () => {
        if (!canMutate(phase)) {
          return { applied: false, changed: false };
        }
        const nextRecord = mutate(currentRecord);
        if (nextRecord === currentRecord) {
          return { applied: true, changed: false };
        }
        if (nextRecord.state !== "running") {
          throw new Error("Running record controller can only persist running-state updates.");
        }
        await runStore.write(nextRecord);
        currentRecord = nextRecord;
        return { applied: true, changed: true };
      });
      writeQueue = updatePromise.then(() => undefined, () => undefined);
      return updatePromise;
    }
  };
}

function ensureStableOutcomeIds(
  outcome: Pick<HostExecutionOutcome, "outcome">
): Pick<HostExecutionOutcome, "outcome"> {
  if (outcome.outcome.kind === "decision") {
    return {
      outcome: {
        kind: "decision",
        capture: {
          ...outcome.outcome.capture,
          decisionId: outcome.outcome.capture.decisionId ?? randomUUID()
        }
      }
    };
  }
  return {
    outcome: {
      kind: "result",
      capture: {
        ...outcome.outcome.capture,
        resultId: outcome.outcome.capture.resultId ?? randomUUID()
      }
    }
  };
}

async function stopHostRun<TExecution>(running: HostRunHandle<TExecution>): Promise<void> {
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

async function waitForRunningExit<TExecution>(
  running: HostRunHandle<TExecution>,
  timeoutMs: number
): Promise<boolean> {
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
