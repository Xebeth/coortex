import type {
  HostExecutionOutcome,
  HostSessionIdentity,
  HostSessionResumeResult,
  HostTelemetryCapture
} from "./contract.js";
import type { HostRunRecord } from "../core/types.js";
import { nowIso } from "../utils/time.js";
import {
  buildCompletedRunRecord,
  ensureStableHostExecutionOutcomeIds
} from "./host-run-records.js";
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

interface ResumeSessionProof {
  observedSessionId?: string;
  verifiedSessionId?: string;
  sessionVerified: boolean;
}

interface HostRunSessionCoordinatorInput<TExecution extends { exitCode: number }>
  extends HostRunSessionTracking<TExecution> {
  runStore: HostRunStore;
  runRecord: HostRunRecord;
  leaseMs: number;
  heartbeatMs: number;
}

function queueSessionIdentityHandling<TExecution extends { exitCode: number }>(
  coordinator: HostRunSessionCoordinator<TExecution>,
  onSessionIdentity: ((identity: HostSessionIdentity) => Promise<void>) | undefined,
  identity: HostSessionIdentity,
  options?: {
    persistNativeRunId?: boolean;
  }
): void {
  coordinator.queueStartupTask(async () => {
    if (options?.persistNativeRunId) {
      const persisted = await coordinator.persistNativeRunId(identity.nativeSessionId);
      if (!persisted) {
        return;
      }
    }
    await onSessionIdentity?.(identity);
  }, "session identity handling");
}

export async function executeHostRunSession<TExecution extends { exitCode: number }>(
  input: ExecuteHostRunSessionInput<TExecution>
): Promise<HostExecutionOutcome> {
  const coordinator = createHostRunSessionCoordinator(input);

  return coordinator.execute({
    startRun: () =>
      input.startRun({
        onNativeRunId: async (nativeRunId) => {
          queueSessionIdentityHandling(
            coordinator,
            input.onSessionIdentity,
            { nativeSessionId: nativeRunId },
            { persistNativeRunId: true }
          );
        }
      }),
    onRuntimeFailure: async (error) =>
      buildFailedRunOutcome(input, coordinator, error, -1),
    onExecutionCompleted: async (execution) => {
      const completedAt = nowIso();
      const completed = await input.deriveCompleted(execution, coordinator.nativeRunId());
      const nativeRunId = completed.nativeRunId ?? coordinator.nativeRunId();
      const completionOptions: {
        nativeRunId?: string;
        usage?: HostTelemetryCapture["usage"];
      } = {};
      if (nativeRunId) {
        completionOptions.nativeRunId = nativeRunId;
      }
      if (completed.usage) {
        completionOptions.usage = completed.usage;
      }
      return buildCompletedRunExecution(
        input,
        coordinator,
        completedAt,
        execution.exitCode,
        completed.outcome,
        completionOptions
      );
    },
    onPostExitFailure: async (error, execution) =>
      buildFailedRunOutcome(input, coordinator, error, execution.exitCode)
  });
}

export async function executeHostResumeSession<TExecution extends { exitCode: number }>(
  input: ExecuteHostResumeSessionInput<TExecution>
): Promise<HostSessionResumeResult> {
  const coordinator = createHostRunSessionCoordinator(input);

  return coordinator.execute({
    startRun: () =>
      input.startRun({
        onSessionIdentity: async (identity) => {
          queueSessionIdentityHandling(coordinator, input.onSessionIdentity, identity);
        }
      }),
    onRuntimeFailure: async (error) =>
      buildFailedResumeResult(input, coordinator, nowIso(), -1, input.summarizeExecutionFailure(error)),
    onExecutionCompleted: async (execution) => {
      const stoppedAt = nowIso();
      const completed = await input.deriveCompleted(execution);
      const sessionProof = readResumeSessionProof(input);
      const telemetry = {
        eventType: "host.resume.completed",
        taskId: input.taskId,
        assignmentId: input.assignmentId,
        metadata: {
          requestedSessionId: input.requestedSessionId,
          observedSessionId: sessionProof.observedSessionId ?? "",
          verifiedSessionId: sessionProof.verifiedSessionId ?? "",
          sessionVerified: sessionProof.sessionVerified,
          exitCode: execution.exitCode,
          reclaimed: sessionProof.sessionVerified,
          reclaimState: sessionProof.sessionVerified ? "reclaimed" : "unverified_failed",
          outcomeKind: completed.outcome.outcome.kind,
          resultStatus:
            completed.outcome.outcome.kind === "result"
              ? completed.outcome.outcome.capture.status
              : ""
        },
        ...(completed.usage ? { usage: completed.usage } : {})
      } satisfies HostTelemetryCapture;

      if (!sessionProof.sessionVerified) {
        const unreclaimedOptions: {
          telemetry?: HostTelemetryCapture;
          warningDetail?: string;
        } = {
          telemetry
        };
        const warningDetail = input.summarizeVerificationFailure(
          input.requestedSessionId,
          sessionProof.observedSessionId,
          execution
        );
        if (warningDetail) {
          unreclaimedOptions.warningDetail = warningDetail;
        }
        return buildUnreclaimedResumeResult(
          input,
          coordinator,
          stoppedAt,
          execution.exitCode,
          "unverified_failed",
          sessionProof,
          unreclaimedOptions
        );
      }

      const outcome = ensureStableHostExecutionOutcomeIds(
        completed.outcome,
        stoppedAt
      );
      const runRecord = buildCompletedRunRecord(
        outcome,
        input.assignmentId,
        input.startedAt,
        stoppedAt,
        input.requestedSessionId,
        input.runRecord.runInstanceId
      );
      const warning = coordinator.collectWarnings(await input.runStore.persistWarning(runRecord));
      return buildReclaimedResumeResult(
        input,
        coordinator,
        stoppedAt,
        execution.exitCode,
        sessionProof,
        outcome,
        runRecord,
        {
          telemetry,
          ...(warning ? { warningDetail: warning } : {})
        }
      );
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

async function buildCompletedRunExecution<TExecution extends { exitCode: number }>(
  input: ExecuteHostRunSessionInput<TExecution>,
  coordinator: HostRunSessionCoordinator<TExecution>,
  completedAt: string,
  exitCode: number,
  rawOutcome: Pick<HostExecutionOutcome, "outcome">,
  options?: {
    nativeRunId?: string;
    usage?: HostTelemetryCapture["usage"];
  }
): Promise<HostExecutionOutcome> {
  const outcome = ensureStableHostExecutionOutcomeIds(rawOutcome, completedAt);
  const runRecord = buildCompletedRunRecord(
    outcome,
    input.assignmentId,
    input.startedAt,
    completedAt,
    options?.nativeRunId,
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
        nativeRunId: options?.nativeRunId ?? "",
        exitCode,
        outcomeKind: outcome.outcome.kind
      },
      ...(options?.usage ? { usage: options.usage } : {})
    }
  };
}

async function buildFailedRunOutcome<TExecution extends { exitCode: number }>(
  input: ExecuteHostRunSessionInput<TExecution>,
  coordinator: HostRunSessionCoordinator<TExecution>,
  error: unknown,
  exitCode: number
): Promise<HostExecutionOutcome> {
  const completedAt = nowIso();
  const failureOptions: {
    nativeRunId?: string;
  } = {};
  const nativeRunId = coordinator.nativeRunId();
  if (nativeRunId) {
    failureOptions.nativeRunId = nativeRunId;
  }
  return buildCompletedRunExecution(
    input,
    coordinator,
    completedAt,
    exitCode,
    input.buildFailedOutcome(
      input.assignmentId,
      completedAt,
      input.summarizeExecutionFailure(error)
    ),
    failureOptions
  );
}

function buildFailedResumeResult<TExecution extends { exitCode: number }>(
  input: ExecuteHostResumeSessionInput<TExecution>,
  coordinator: HostRunSessionCoordinator<TExecution>,
  stoppedAt: string,
  exitCode: number,
  warningDetail: string | undefined
): HostSessionResumeResult {
  const failureOptions: {
    warningDetail?: string;
  } = {};
  if (warningDetail) {
    failureOptions.warningDetail = warningDetail;
  }
  const sessionProof = readResumeSessionProof(input);
  return buildUnreclaimedResumeResult(
    input,
    coordinator,
    stoppedAt,
    exitCode,
    sessionProof.sessionVerified ? "verified_then_failed" : "unverified_failed",
    sessionProof,
    failureOptions
  );
}

function buildReclaimedResumeResult<TExecution extends { exitCode: number }>(
  input: ExecuteHostResumeSessionInput<TExecution>,
  coordinator: HostRunSessionCoordinator<TExecution>,
  stoppedAt: string,
  exitCode: number,
  sessionProof: ResumeSessionProof,
  outcome: Pick<HostExecutionOutcome, "outcome">,
  runRecord: HostRunRecord,
  options?: {
    telemetry?: HostTelemetryCapture;
    warningDetail?: string;
  }
): HostSessionResumeResult {
  return {
    reclaimed: true,
    reclaimState: "reclaimed",
    ...buildResumeResultFields(
      input,
      coordinator,
      sessionProof,
      exitCode,
      stoppedAt,
      options
    ),
    verifiedSessionId: sessionProof.verifiedSessionId ?? input.requestedSessionId,
    outcome: outcome.outcome,
    run: runRecord
  };
}

function readResumeSessionProof<TExecution extends { exitCode: number }>(
  input: ExecuteHostResumeSessionInput<TExecution>
): ResumeSessionProof {
  const observedSessionId = input.getObservedSessionId();
  const verifiedSessionId = input.getVerifiedSessionId();
  return {
    ...(observedSessionId ? { observedSessionId } : {}),
    ...(verifiedSessionId ? { verifiedSessionId } : {}),
    sessionVerified: verifiedSessionId === input.requestedSessionId
  };
}

function createHostRunSessionCoordinator<TExecution extends { exitCode: number }>(
  input: HostRunSessionCoordinatorInput<TExecution>
): HostRunSessionCoordinator<TExecution> {
  return new HostRunSessionCoordinator<TExecution>({
    runStore: input.runStore,
    runRecord: input.runRecord,
    leaseMs: input.leaseMs,
    heartbeatMs: input.heartbeatMs,
    setActiveRun: input.setActiveRun,
    setActiveExecutionSettled: input.setActiveExecutionSettled
  });
}

function buildUnreclaimedResumeResult<TExecution extends { exitCode: number }>(
  input: ExecuteHostResumeSessionInput<TExecution>,
  coordinator: HostRunSessionCoordinator<TExecution>,
  stoppedAt: string,
  exitCode: number,
  reclaimState: "unverified_failed" | "verified_then_failed",
  sessionProof: {
    observedSessionId?: string;
    verifiedSessionId?: string;
    sessionVerified: boolean;
  },
  options?: {
    telemetry?: HostTelemetryCapture;
    warningDetail?: string;
  }
): HostSessionResumeResult {
  return {
    reclaimed: false,
    reclaimState,
    ...buildResumeResultFields(
      input,
      coordinator,
      sessionProof,
      exitCode,
      stoppedAt,
      options
    )
  };
}

function buildResumeResultFields<TExecution extends { exitCode: number }>(
  input: ExecuteHostResumeSessionInput<TExecution>,
  coordinator: HostRunSessionCoordinator<TExecution>,
  sessionProof: ResumeSessionProof,
  exitCode: number,
  stoppedAt: string,
  options?: {
    telemetry?: HostTelemetryCapture;
    warningDetail?: string;
  }
) {
  const warning = coordinator.collectWarnings(options?.warningDetail);
  return {
    requestedSessionId: input.requestedSessionId,
    ...(sessionProof.observedSessionId
      ? { observedSessionId: sessionProof.observedSessionId }
      : {}),
    ...(sessionProof.verifiedSessionId
      ? { verifiedSessionId: sessionProof.verifiedSessionId }
      : {}),
    sessionVerified: sessionProof.sessionVerified,
    exitCode,
    stoppedAt,
    ...(options?.telemetry ? { telemetry: options.telemetry } : {}),
    ...(warning ? { warning } : {})
  };
}
