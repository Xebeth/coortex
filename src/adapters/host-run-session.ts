import { randomUUID } from "node:crypto";

import type {
  HostExecutionOutcome,
  HostSessionIdentity,
  HostSessionResumeResult,
  HostTelemetryCapture
} from "./contract.js";
import type { HostRunRecord } from "../core/types.js";
import { nowIso } from "../utils/time.js";
import { buildCompletedRunRecord } from "./host-run-records.js";
import { HostRunStore } from "./host-run-store.js";
import {
  HostRunSessionCoordinator,
  type HostRunHandle,
  type HostRunSessionTracking
} from "./host-run-session-coordinator.js";

export type { HostRunHandle, HostRunSessionTracking } from "./host-run-session-coordinator.js";

export interface HostRunSessionResult<TExecution extends { exitCode: number }> {
  outcome: Pick<HostExecutionOutcome, "outcome">;
  nativeRunId?: string;
  usage?: HostTelemetryCapture["usage"];
  execution: TExecution;
}

export interface ExecuteHostRunSessionInput<TExecution extends { exitCode: number }>
  extends HostRunSessionTracking<TExecution> {
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
}

export interface ExecuteHostResumeSessionInput<TExecution extends { exitCode: number }>
  extends HostRunSessionTracking<TExecution> {
  assignmentId: string;
  startedAt: string;
  taskId: string;
  requestedSessionId: string;
  runStore: HostRunStore;
  runRecord: HostRunRecord;
  leaseMs: number;
  heartbeatMs: number;
  startRun: (handlers: {
    onSessionIdentity: (identity: HostSessionIdentity) => Promise<void>;
  }) => Promise<HostRunHandle<TExecution>>;
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
  onSessionIdentity?: (identity: HostSessionIdentity) => Promise<void>;
}

export async function executeHostRunSession<TExecution extends { exitCode: number }>(
  input: ExecuteHostRunSessionInput<TExecution>
): Promise<HostExecutionOutcome> {
  const coordinator = new HostRunSessionCoordinator<TExecution>({
    runStore: input.runStore,
    runRecord: input.runRecord,
    leaseMs: input.leaseMs,
    heartbeatMs: input.heartbeatMs,
    setActiveRun: input.setActiveRun,
    setActiveExecutionSettled: input.setActiveExecutionSettled
  });

  return coordinator.execute({
    startRun: () =>
      input.startRun({
        onNativeRunId: async (nativeRunId) => {
          coordinator.queueStartupTask(async () => {
            const persisted = await coordinator.persistNativeRunId(nativeRunId);
            if (!persisted) {
              return;
            }
            await input.onSessionIdentity?.({ nativeSessionId: nativeRunId });
          }, "session identity handling");
        }
      }),
    onRuntimeFailure: async (error) =>
      buildFailedRunOutcome(input, coordinator, error, -1),
    onExecutionCompleted: async (execution) => {
      const completedAt = nowIso();
      const completed = await input.deriveCompleted(execution, coordinator.nativeRunId());
      const outcome = ensureStableOutcomeIds(completed.outcome);
      const nativeRunId = completed.nativeRunId ?? coordinator.nativeRunId();
      const runRecord = buildCompletedRunRecord(
        outcome,
        input.assignmentId,
        input.startedAt,
        completedAt,
        nativeRunId,
        input.runRecord.runInstanceId
      );
      const warning = coordinator.collectWarnings(await input.runStore.persistWarning(runRecord));

      return {
        ...outcome,
        run: runRecord,
        ...(warning ? { warning } : {}),
        telemetry: {
          eventType: "host.run.completed",
          taskId: input.taskId,
          assignmentId: input.assignmentId,
          metadata: {
            nativeRunId: nativeRunId ?? "",
            exitCode: execution.exitCode,
            outcomeKind: outcome.outcome.kind
          },
          ...(completed.usage ? { usage: completed.usage } : {})
        }
      };
    },
    onPostExitFailure: async (error, execution) =>
      buildFailedRunOutcome(input, coordinator, error, execution.exitCode)
  });
}

export async function executeHostResumeSession<TExecution extends { exitCode: number }>(
  input: ExecuteHostResumeSessionInput<TExecution>
): Promise<HostSessionResumeResult> {
  const coordinator = new HostRunSessionCoordinator<TExecution>({
    runStore: input.runStore,
    runRecord: input.runRecord,
    leaseMs: input.leaseMs,
    heartbeatMs: input.heartbeatMs,
    setActiveRun: input.setActiveRun,
    setActiveExecutionSettled: input.setActiveExecutionSettled
  });

  return coordinator.execute({
    startRun: () =>
      input.startRun({
        onSessionIdentity: async (identity) => {
          coordinator.queueStartupTask(async () => {
            await input.onSessionIdentity?.(identity);
          }, "session identity handling");
        }
      }),
    onRuntimeFailure: async (error) =>
      buildFailedResumeResult(input, coordinator, nowIso(), -1, input.summarizeExecutionFailure(error)),
    onExecutionCompleted: async (execution) => {
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
        const warning = coordinator.collectWarnings(
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
        input.requestedSessionId,
        input.runRecord.runInstanceId
      );
      const warning = coordinator.collectWarnings(await input.runStore.persistWarning(runRecord));
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
    },
    onPostExitFailure: async (error, execution) =>
      buildFailedResumeResult(
        input,
        coordinator,
        nowIso(),
        execution.exitCode,
        input.summarizeExecutionFailure(error)
      )
  });
}

async function buildFailedRunOutcome<TExecution extends { exitCode: number }>(
  input: ExecuteHostRunSessionInput<TExecution>,
  coordinator: HostRunSessionCoordinator<TExecution>,
  error: unknown,
  exitCode: number
): Promise<HostExecutionOutcome> {
  const completedAt = nowIso();
  const outcome = ensureStableOutcomeIds(
    input.buildFailedOutcome(
      input.assignmentId,
      completedAt,
      input.summarizeExecutionFailure(error)
    )
  );
  const nativeRunId = coordinator.nativeRunId();
  const runRecord = buildCompletedRunRecord(
    outcome,
    input.assignmentId,
    input.startedAt,
    completedAt,
    nativeRunId,
    input.runRecord.runInstanceId
  );
  const warning = coordinator.collectWarnings(await input.runStore.persistWarning(runRecord));
  return {
    ...outcome,
    run: runRecord,
    ...(warning ? { warning } : {}),
    telemetry: {
      eventType: "host.run.completed",
      taskId: input.taskId,
      assignmentId: input.assignmentId,
      metadata: {
        nativeRunId: nativeRunId ?? "",
        exitCode,
        outcomeKind: outcome.outcome.kind
      }
    }
  };
}

function buildFailedResumeResult<TExecution extends { exitCode: number }>(
  input: ExecuteHostResumeSessionInput<TExecution>,
  coordinator: HostRunSessionCoordinator<TExecution>,
  stoppedAt: string,
  exitCode: number,
  warningDetail: string | undefined
): HostSessionResumeResult {
  const observedSessionId = input.getObservedSessionId();
  const verifiedSessionId = input.getVerifiedSessionId();
  const warning = coordinator.collectWarnings(warningDetail);
  return {
    reclaimed: false,
    reclaimState: verifiedSessionId ? "verified_then_failed" : "unverified_failed",
    requestedSessionId: input.requestedSessionId,
    ...(observedSessionId ? { observedSessionId } : {}),
    ...(verifiedSessionId ? { verifiedSessionId } : {}),
    sessionVerified: verifiedSessionId === input.requestedSessionId,
    exitCode,
    stoppedAt,
    ...(warning ? { warning } : {})
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
