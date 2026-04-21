import { getNativeRunId } from "../core/run-state.js";
import type { HostRunRecord } from "../core/types.js";
import { nowIso } from "../utils/time.js";
import { withRunNativeId } from "./host-run-records.js";
import { HostRunStore } from "./host-run-store.js";

export interface HostRunHandle<TExecution> {
  result: Promise<TExecution>;
  terminate(signal?: "graceful" | "force"): Promise<void>;
  waitForExit(timeoutMs?: number): Promise<{ code: number | null }>;
}

export interface HostRunSessionTracking<TExecution> {
  setActiveRun: (run: HostRunHandle<TExecution> | undefined) => void;
  setActiveExecutionSettled: (settled: Promise<void> | undefined) => void;
}

export interface HostRunSessionCoordinatorOptions<TExecution extends { exitCode: number }>
  extends HostRunSessionTracking<TExecution> {
  runStore: HostRunStore;
  runRecord: HostRunRecord;
  leaseMs: number;
  heartbeatMs: number;
}

export interface HostRunSessionExecutionInput<
  TExecution extends { exitCode: number },
  TResult
> {
  startRun: () => Promise<HostRunHandle<TExecution>>;
  onRuntimeFailure: (error: unknown) => Promise<TResult>;
  onExecutionCompleted: (execution: TExecution) => Promise<TResult>;
  onPostExitFailure: (error: unknown, execution: TExecution) => Promise<TResult>;
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

export class HostRunSessionCoordinator<TExecution extends { exitCode: number }> {
  private readonly runningRecord: RunningRecordController;
  private readonly metadataWarnings: string[] = [];
  private readonly metadataFailure: Promise<never>;
  private readonly handledSessionIdentityIds = new Set<string>();
  private startupTaskQueue: Promise<void> = Promise.resolve();
  private metadataFailureReject!: (error: Error) => void;
  private metadataFailureRaised = false;

  constructor(private readonly options: HostRunSessionCoordinatorOptions<TExecution>) {
    this.runningRecord = createRunningRecordController(options.runStore, options.runRecord);
    this.metadataFailure = new Promise<never>((_, reject) => {
      this.metadataFailureReject = reject;
    });
    void this.metadataFailure.catch(() => undefined);
  }

  currentRunRecord(): HostRunRecord {
    return this.runningRecord.current();
  }

  nativeRunId(): string | undefined {
    return getNativeRunId(this.runningRecord.current());
  }

  collectWarnings(...warnings: Array<string | undefined>): string | undefined {
    const all = [...this.metadataWarnings, ...warnings.filter((value): value is string => !!value)];
    return all.length > 0 ? all.join(" ") : undefined;
  }

  async persistNativeRunId(nativeRunId: string, context = "thread-start handling"): Promise<boolean> {
    const phase = this.runningRecord.phase();
    try {
      const updated = await this.runningRecord.update(phase, (current) =>
        getNativeRunId(current) === nativeRunId ? current : withRunNativeId(current, nativeRunId)
      );
      return updated.changed;
    } catch (error) {
      this.recordMetadataWarning(error, context);
      return false;
    }
  }

  async ensureNativeRunId(nativeRunId: string, context = "thread-start handling"): Promise<boolean> {
    const phase = this.runningRecord.phase();
    try {
      const updated = await this.runningRecord.update(phase, (current) =>
        getNativeRunId(current) === nativeRunId ? current : withRunNativeId(current, nativeRunId)
      );
      return updated.applied;
    } catch (error) {
      this.recordMetadataWarning(error, context);
      return false;
    }
  }

  noteSessionIdentityHandled(nativeSessionId: string): boolean {
    if (this.handledSessionIdentityIds.has(nativeSessionId)) {
      return false;
    }
    this.handledSessionIdentityIds.add(nativeSessionId);
    return true;
  }

  queueStartupTask(task: () => Promise<void>, context: string): void {
    const taskPromise = this.startupTaskQueue.catch(() => undefined).then(async () => {
      if (this.metadataFailureRaised) {
        return;
      }
      await task();
    });
    this.startupTaskQueue = taskPromise.catch((error) => {
      this.failRunOnStartupError(error, context);
    });
  }

  async waitForStartupTasks(): Promise<void> {
    let pending = this.startupTaskQueue;
    while (true) {
      await pending;
      if (pending === this.startupTaskQueue) {
        return;
      }
      pending = this.startupTaskQueue;
    }
  }

  async execute<TResult>(
    input: HostRunSessionExecutionInput<TExecution, TResult>
  ): Promise<TResult> {
    const runPromise = (async (): Promise<TResult> => {
      let heartbeatTimer: NodeJS.Timeout | undefined;
      let execution!: TExecution;
      let running: HostRunHandle<TExecution> | undefined;

      try {
        running = await input.startRun();
        this.options.setActiveRun(running);
        await this.waitForStartupTasks();
        await this.refreshLease();
        heartbeatTimer = setInterval(() => {
          void this.refreshLease().catch((error) => {
            this.failRunOnMetadataError(error, "heartbeat refresh");
          });
        }, this.options.heartbeatMs);
        execution = await Promise.race([running.result, this.metadataFailure]);
        this.runningRecord.close();
      } catch (error) {
        await this.waitForStartupTasks();
        this.runningRecord.close();
        if (running) {
          await stopHostRun(running);
        }
        await this.runningRecord.waitForWrites();
        return input.onRuntimeFailure(error);
      } finally {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        this.options.setActiveRun(undefined);
      }

      try {
        await this.waitForStartupTasks();
        await this.runningRecord.waitForWrites();
        return await input.onExecutionCompleted(execution);
      } catch (error) {
        return input.onPostExitFailure(error, execution);
      }
    })();

    const settled = runPromise.then(() => undefined, () => undefined);
    this.options.setActiveExecutionSettled(settled);
    try {
      return await runPromise;
    } finally {
      this.options.setActiveExecutionSettled(undefined);
    }
  }

  private async refreshLease(): Promise<void> {
    const phase = this.runningRecord.phase();
    const heartbeatAt = nowIso();
    await this.runningRecord.update(phase, (current) => ({
      ...current,
      heartbeatAt,
      leaseExpiresAt: new Date(Date.parse(heartbeatAt) + this.options.leaseMs).toISOString()
    }));
  }

  private recordMetadataWarning(error: unknown, context: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.metadataWarnings.push(`Host run metadata persistence failed during ${context}. ${message}`);
  }

  private failRunOnMetadataError(error: unknown, context: string): void {
    if (this.metadataFailureRaised) {
      return;
    }
    this.metadataFailureRaised = true;
    const message = error instanceof Error ? error.message : String(error);
    this.metadataFailureReject(
      new Error(`Host run metadata persistence failed during ${context}. ${message}`)
    );
  }

  private failRunOnStartupError(error: unknown, context: string): void {
    if (this.metadataFailureRaised) {
      return;
    }
    this.metadataFailureRaised = true;
    const message = error instanceof Error ? error.message : String(error);
    this.metadataFailureReject(
      new Error(`Host run startup handling failed during ${context}. ${message}`)
    );
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
