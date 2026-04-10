import type { HostExecutionOutcome, HostTelemetryCapture } from "./contract.js";
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
  setActiveRun: (run: HostRunHandle<TExecution> | undefined) => void;
  setActiveExecutionSettled: (settled: Promise<void> | undefined) => void;
}

export async function executeHostRunSession<TExecution extends { exitCode: number }>(
  input: ExecuteHostRunSessionInput<TExecution>
): Promise<HostExecutionOutcome> {
  let runningRecord = input.runRecord;
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
      leaseExpiresAt: new Date(Date.parse(heartbeatAt) + input.leaseMs).toISOString()
    };
    if (runClosed || runningRecord.state !== "running" || phase !== runPhase) {
      return;
    }
    runningRecord = nextRecord;
    await input.runStore.write(runningRecord);
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
          if (getNativeRunId(runningRecord) === nativeRunId) {
            return;
          }
          runningRecord = withRunNativeId(runningRecord, nativeRunId);
          try {
            await input.runStore.write(runningRecord);
          } catch (error) {
            recordMetadataWarning(error, "thread-start handling");
          }
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
      runClosed = true;
      runPhase += 1;
    } catch (error) {
      runClosed = true;
      runPhase += 1;
      if (running) {
        await stopHostRun(running);
      }
      const completedAt = nowIso();
      const outcome = input.buildFailedOutcome(
        input.assignmentId,
        completedAt,
        input.summarizeExecutionFailure(error)
      );
      const runRecord = buildCompletedRunRecord(
        outcome,
        input.assignmentId,
        input.startedAt,
        completedAt,
        getNativeRunId(runningRecord)
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
      input.setActiveRun(undefined);
    }

    const completedAt = nowIso();
    const completed = await input.deriveCompleted(execution, getNativeRunId(runningRecord));
    const runRecord = buildCompletedRunRecord(
      completed.outcome,
      input.assignmentId,
      input.startedAt,
      completedAt,
      completed.nativeRunId
    );
    const warning = collectWarnings(await input.runStore.persistWarning(runRecord));

    return {
      ...completed.outcome,
      run: runRecord,
      ...(warning ? { warning } : {}),
      telemetry: {
        eventType: "host.run.completed",
        taskId: input.taskId,
        assignmentId: input.assignmentId,
        metadata: {
          nativeRunId: completed.nativeRunId ?? "",
          exitCode: execution.exitCode,
          outcomeKind: completed.outcome.outcome.kind
        },
        ...(completed.usage ? { usage: completed.usage } : {})
      }
    };
  })();

  const settled = runPromise.then(() => undefined, () => undefined);
  input.setActiveExecutionSettled(settled);
  try {
    return await runPromise;
  } finally {
    input.setActiveExecutionSettled(undefined);
  }
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
