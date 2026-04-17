import { randomUUID } from "node:crypto";

import type { HostAdapter } from "../adapters/contract.js";
import { isRunLeaseExpired } from "../core/run-state.js";
import type { RuntimeEvent } from "../core/events.js";
import type {
  DecisionPacket,
  HostRunRecord,
  RuntimeProjection
} from "../core/types.js";
import { applyRuntimeEvent, fromSnapshot, toSnapshot } from "../projections/runtime-projection.js";
import { ProjectionRecoveryService } from "../persistence/projection-recovery.js";
import { RuntimeStore } from "../persistence/store.js";
import { buildStaleRunReconciliation, createActiveRunDiagnostic } from "../recovery/host-runs.js";
import { recordNormalizedTelemetry } from "../telemetry/recorder.js";
import { nowIso } from "../utils/time.js";
import { AttachmentLifecycleService } from "./attachment-lifecycle.js";
import {
  getActiveClaimForAssignment,
  listProvisionalAttachmentClaims
} from "../projections/attachment-claim-queries.js";
import {
  cleanupHostRunArtifactsWithLeaseVerification,
  reconcileStaleRunWithLeaseVerification
} from "./host-run-cleanup.js";
import type { CommandDiagnostic } from "./types.js";
import { loadOperatorProjectionWithDiagnostics } from "./runtime-state.js";

type ProjectionWriteOptions = {
  snapshotFallback?: boolean;
};

export interface RunReconciliationDiagnostic {
  level: "warning";
  code:
    | "event-log-repaired"
    | "telemetry-write-failed"
    | "host-run-persist-failed"
    | "active-run-present"
    | "stale-run-reconciled"
    | "completed-run-reconciled"
    | "provisional-attachment-promoted"
    | "provisional-attachment-cleared";
  message: string;
}

export interface RunReconciliationResult {
  projection: RuntimeProjection;
  diagnostics: RunReconciliationDiagnostic[];
  activeLeases: string[];
}

export interface RunReconciliationOptions {
  snapshotFallback?: boolean;
}

interface RunReconciliationContext {
  store: RuntimeStore;
  adapter: HostAdapter;
  projectionRecovery: ProjectionRecoveryService;
}

interface CompletedRunReconciliationResult {
  projection: RuntimeProjection;
  changed: boolean;
  handled: boolean;
  replayableHydrated: boolean;
}

interface RecoveryProjectionOptions {
  snapshotFallback: boolean;
  replayableEvents: RuntimeEvent[] | undefined;
  snapshotBoundaryEventId: string | undefined;
}

export class RunReconciliationService {
  private readonly projectionRecovery: ProjectionRecoveryService;

  constructor(
    private readonly store: RuntimeStore,
    private readonly adapter: HostAdapter
  ) {
    this.projectionRecovery = new ProjectionRecoveryService(store);
  }

  async reconcileActiveRuns(
    projection: RuntimeProjection,
    options?: RunReconciliationOptions
  ): Promise<RunReconciliationResult> {
    return reconcileActiveRunsInContext(
      {
        store: this.store,
        adapter: this.adapter,
        projectionRecovery: this.projectionRecovery
      },
      projection,
      options
    );
  }
}

function listHiddenActiveLeaseAssignments(
  projection: RuntimeProjection,
  activeLeases: string[]
): string[] {
  return activeLeases.filter((assignmentId) => !projection.assignments.has(assignmentId));
}

export async function reconcileActiveRuns(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: RuntimeProjection,
  options?: RunReconciliationOptions
): Promise<RunReconciliationResult> {
  return new RunReconciliationService(store, adapter).reconcileActiveRuns(projection, options);
}

export async function loadReconciledProjectionWithDiagnostics(
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<{
  projection: RuntimeProjection;
  diagnostics: CommandDiagnostic[];
  activeLeases: string[];
  hiddenActiveLeases: string[];
  snapshotFallback: boolean;
}> {
  const loaded = await loadOperatorProjectionWithDiagnostics(store);
  const reconciled = await reconcileActiveRuns(store, adapter, loaded.projection, {
    snapshotFallback: loaded.snapshotFallback
  });
  const hiddenActiveLeases = listHiddenActiveLeaseAssignments(
    reconciled.projection,
    reconciled.activeLeases
  );
  return {
    projection: reconciled.projection,
    diagnostics: [...loaded.diagnostics, ...reconciled.diagnostics],
    activeLeases: reconciled.activeLeases,
    hiddenActiveLeases,
    snapshotFallback: loaded.snapshotFallback
  };
}

async function reconcileActiveRunsInContext(
  context: RunReconciliationContext,
  projection: RuntimeProjection,
  options?: RunReconciliationOptions
): Promise<RunReconciliationResult> {
  const diagnostics: RunReconciliationDiagnostic[] = [];
  const snapshotFallback = options?.snapshotFallback ?? false;
  const snapshotBoundaryEventId = snapshotFallback ? (await context.store.loadSnapshot())?.lastEventId : undefined;
  const replayableEvents = snapshotFallback
    ? (await context.projectionRecovery.loadReplayableEvents()).events
    : undefined;
  let effectiveProjection = fromSnapshot(toSnapshot(projection));
  let changed = false;
  let snapshotFallbackReplayHydrated = false;
  let queuedTransitions: Map<string, string[]> | undefined;
  let staleStatusTransitions: Map<string, string[]> | undefined;
  let handledCompletedRun = false;
  const runtimeKnownAssignmentIds = [...projection.assignments.keys()];
  const enumeratedRecords = await context.adapter.inspectRuns(context.store);
  const enumeratedRecordByAssignmentId = new Map(
    enumeratedRecords.map((record) => [record.assignmentId, record] as const)
  );
  const assignmentIdsToInspect = [
    ...new Set([...runtimeKnownAssignmentIds, ...enumeratedRecordByAssignmentId.keys()])
  ];

  const hydrateSnapshotFallbackReplayableSuffix = () => {
    if (!snapshotFallback || snapshotFallbackReplayHydrated) {
      return;
    }
    snapshotFallbackReplayHydrated = true;
    const replayableHydration = hydrateProjectionFromReplayableEvents(
      effectiveProjection,
      replayableEvents,
      snapshotBoundaryEventId
    );
    if (replayableHydration.hydrated) {
      effectiveProjection = replayableHydration.projection;
      changed = true;
    }
  };

  for (const assignmentId of assignmentIdsToInspect) {
    const record = enumeratedRecordByAssignmentId.get(assignmentId)
      ?? await context.adapter.inspectRun(context.store, assignmentId);
    if (!record) {
      continue;
    }

    if (snapshotFallback && isStaleRunReconciliationCandidate(record)) {
      hydrateSnapshotFallbackReplayableSuffix();
    }

    if (
      snapshotFallback &&
      !effectiveProjection.assignments.has(assignmentId) &&
      isStaleRunReconciliationCandidate(record)
    ) {
      const replayableHydration = hydrateMissingAssignmentFromReplayableEvents(
        effectiveProjection,
        assignmentId,
        replayableEvents,
        snapshotBoundaryEventId
      );
      if (replayableHydration.hydrated) {
        effectiveProjection = replayableHydration.projection;
        changed = true;
      }
    }

    const durableRuntimeCompletedRecord = isDegradedRunRecord(record)
      ? buildCompletedRunRecordFromRuntimeOutcome(effectiveProjection, record)
      : undefined;
    if (durableRuntimeCompletedRecord) {
      handledCompletedRun = true;
      const completedRecovery = await reconcileCompletedRunRecord(
        context,
        effectiveProjection,
        durableRuntimeCompletedRecord,
        diagnostics,
        {
          cleanupRecord: record,
          replayableEvents,
          snapshotBoundaryEventId,
          snapshotFallback
        }
      );
      effectiveProjection = completedRecovery.projection;
      changed ||= completedRecovery.changed;
      snapshotFallbackReplayHydrated ||= completedRecovery.replayableHydrated;
      continue;
    }

    if (record.state === "completed") {
      const completedRecovery = await reconcileCompletedRunRecord(
        context,
        effectiveProjection,
        record,
        diagnostics,
        {
          cleanupRecord: undefined,
          replayableEvents,
          snapshotBoundaryEventId,
          snapshotFallback
        }
      );
      if (completedRecovery.handled) {
        handledCompletedRun = true;
        effectiveProjection = completedRecovery.projection;
        changed ||= completedRecovery.changed;
        snapshotFallbackReplayHydrated ||= completedRecovery.replayableHydrated;
        continue;
      }

      if (record.staleReasonCode && !record.terminalOutcome) {
        if (!effectiveProjection.assignments.has(assignmentId)) {
          await reconcileOutOfProjectionStaleRun(
            context,
            effectiveProjection,
            assignmentId,
            record,
            diagnostics
          );
          continue;
        }

        queuedTransitions ??= await loadQueuedTransitions(context.projectionRecovery, replayableEvents);
        staleStatusTransitions ??= await loadStaleRecoveryStatusTransitions(
          context.projectionRecovery,
          replayableEvents
        );
        const staleRecoveryState = getStaleRunRecoveryState(
          assignmentId,
          record,
          queuedTransitions,
          staleStatusTransitions
        );
        const reconciliation = buildStaleRunReconciliation(effectiveProjection, assignmentId, record);
        const expectedStatus =
          reconciliation.events[1]?.type === "status.updated"
            ? reconciliation.events[1].payload.status
            : effectiveProjection.status;
        if (
          isStaleRunAlreadyReconciled(
            effectiveProjection,
            assignmentId,
            staleRecoveryState,
            expectedStatus,
            snapshotFallback
          )
        ) {
          changed = true;
          const syncedProjection = await syncProjectionSnapshot(context, {
            snapshotFallback,
            replayableEvents,
            snapshotBoundaryEventId
          });
          effectiveProjection = syncedProjection.projection;
          diagnostics.push(...warningDiagnostics(syncedProjection.warning, "event-log-repaired"));
          const cleanupError = await reconcileStaleRunWithLeaseVerification(
            context.store,
            context.adapter,
            record
          );
          if (cleanupError) {
            diagnostics.push(
              ...warningDiagnostics(
                `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
                "host-run-persist-failed"
              )
            );
          }
          continue;
        }

        const pendingEvents = selectPendingStaleRecoveryEvents(
          reconciliation.events,
          staleRecoveryState
        );
        const authorityRepairEvents = AttachmentLifecycleService.buildStaleAuthorityRepairEvents(
          effectiveProjection,
          assignmentId,
          reconciliation.events[0]?.timestamp ?? nowIso()
        );
        const recoveryEvents = [...pendingEvents, ...authorityRepairEvents];
        if (recoveryEvents.length === 0) {
          changed = true;
          if (snapshotFallback) {
            effectiveProjection = await mutateSnapshotFallbackProjection(
              context.store,
              replayableEvents,
              snapshotBoundaryEventId,
              (latestProjection) => applyRuntimeEventsToProjection(latestProjection, reconciliation.events)
            );
          } else {
            const syncResult = await context.projectionRecovery.syncSnapshotFromEventsWithRecovery();
            effectiveProjection = syncResult.projection;
            diagnostics.push(...warningDiagnostics(syncResult.warning, "event-log-repaired"));
          }
          diagnostics.push(reconciliation.diagnostic);
          const cleanupError = await reconcileStaleRunWithLeaseVerification(
            context.store,
            context.adapter,
            reconciliation.staleRecord
          );
          if (cleanupError) {
            diagnostics.push(
              ...warningDiagnostics(
                `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
                "host-run-persist-failed"
              )
            );
          }
          continue;
        }

        changed = true;
        if (!staleRecoveryState.queuedTransitionTimestamp) {
          queuedTransitions.set(assignmentId, [
            ...(queuedTransitions.get(assignmentId) ?? []),
            reconciliation.events[0]!.timestamp
          ]);
        }
        if (!staleRecoveryState.statusTransitionTimestamp) {
          staleStatusTransitions.set(assignmentId, [
            ...(staleStatusTransitions.get(assignmentId) ?? []),
            reconciliation.events[1]!.timestamp
          ]);
        }
        effectiveProjection = await applyRecoveryProjectionEvents(
          context,
          effectiveProjection,
          recoveryEvents,
          diagnostics,
          {
            snapshotFallback,
            replayableEvents,
            snapshotBoundaryEventId
          }
        );
        diagnostics.push(reconciliation.diagnostic);

        const telemetry = await recordNormalizedTelemetry(
          context.store,
          context.adapter.normalizeTelemetry({
            eventType: "host.run.stale_reconciled",
            taskId: projection.sessionId,
            assignmentId,
            metadata: reconciliation.telemetryMetadata
          })
        );
        diagnostics.push(...warningDiagnostics(telemetry.warning, "telemetry-write-failed"));
        const cleanupError = await reconcileStaleRunWithLeaseVerification(
          context.store,
          context.adapter,
          reconciliation.staleRecord
        );
        if (cleanupError) {
          diagnostics.push(
            ...warningDiagnostics(
              `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
              "host-run-persist-failed"
            )
          );
        }
        continue;
      }

      continue;
    }

    if (!effectiveProjection.assignments.has(assignmentId)) {
      if (!isRunLeaseExpired(record)) {
      } else if (snapshotFallback && isStaleRunReconciliationCandidate(record)) {
        await reconcileOutOfProjectionStaleRun(
          context,
          effectiveProjection,
          assignmentId,
          record,
          diagnostics
        );
      }
      continue;
    }

    if (!isRunLeaseExpired(record)) {
      continue;
    }

    queuedTransitions ??= await loadQueuedTransitions(context.projectionRecovery, replayableEvents);
    staleStatusTransitions ??= await loadStaleRecoveryStatusTransitions(
      context.projectionRecovery,
      replayableEvents
    );
    const staleRecoveryState = getStaleRunRecoveryState(
      assignmentId,
      record,
      queuedTransitions,
      staleStatusTransitions
    );
    const reconciliation = buildStaleRunReconciliation(effectiveProjection, assignmentId, record);
    const expectedStatus =
      reconciliation.events[1]?.type === "status.updated"
        ? reconciliation.events[1].payload.status
        : effectiveProjection.status;
    if (
      isStaleRunAlreadyReconciled(
        effectiveProjection,
        assignmentId,
        staleRecoveryState,
        expectedStatus,
        snapshotFallback
      )
    ) {
      changed = true;
      const syncedProjection = await syncProjectionSnapshot(context, {
        snapshotFallback,
        replayableEvents,
        snapshotBoundaryEventId
      });
      effectiveProjection = syncedProjection.projection;
      diagnostics.push(...warningDiagnostics(syncedProjection.warning, "event-log-repaired"));
      const cleanupError = await reconcileStaleRunWithLeaseVerification(
        context.store,
        context.adapter,
        reconciliation.staleRecord
      );
      if (cleanupError) {
        diagnostics.push(
          ...warningDiagnostics(
            `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
            "host-run-persist-failed"
          )
        );
      }
      continue;
    }

    const pendingEvents = selectPendingStaleRecoveryEvents(reconciliation.events, staleRecoveryState);
    const authorityRepairEvents = AttachmentLifecycleService.buildStaleAuthorityRepairEvents(
      effectiveProjection,
      assignmentId,
      reconciliation.events[0]?.timestamp ?? nowIso()
    );
    const recoveryEvents = [...pendingEvents, ...authorityRepairEvents];
    if (recoveryEvents.length === 0) {
      changed = true;
      effectiveProjection = await applyRecoveryProjectionEvents(
        context,
        effectiveProjection,
        snapshotFallback ? reconciliation.events : [],
        diagnostics,
        {
          snapshotFallback,
          replayableEvents,
          snapshotBoundaryEventId
        }
      );
      diagnostics.push(reconciliation.diagnostic);

      const telemetry = await recordNormalizedTelemetry(
        context.store,
        context.adapter.normalizeTelemetry({
          eventType: "host.run.stale_reconciled",
          taskId: projection.sessionId,
          assignmentId,
          metadata: reconciliation.telemetryMetadata
        })
      );
      diagnostics.push(...warningDiagnostics(telemetry.warning, "telemetry-write-failed"));
      const cleanupError = await reconcileStaleRunWithLeaseVerification(
        context.store,
        context.adapter,
        reconciliation.staleRecord
      );
      if (cleanupError) {
        diagnostics.push(
          ...warningDiagnostics(
            `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
            "host-run-persist-failed"
          )
        );
      }
      continue;
    }

    changed = true;
    if (!staleRecoveryState.queuedTransitionTimestamp) {
      queuedTransitions.set(assignmentId, [
        ...(queuedTransitions.get(assignmentId) ?? []),
        reconciliation.events[0]!.timestamp
      ]);
    }
    if (!staleRecoveryState.statusTransitionTimestamp) {
      staleStatusTransitions.set(assignmentId, [
        ...(staleStatusTransitions.get(assignmentId) ?? []),
        reconciliation.events[1]!.timestamp
      ]);
    }
    effectiveProjection = await applyRecoveryProjectionEvents(
      context,
      effectiveProjection,
      recoveryEvents,
      diagnostics,
      {
        snapshotFallback,
        replayableEvents,
        snapshotBoundaryEventId
      }
    );
    diagnostics.push(reconciliation.diagnostic);

    const telemetry = await recordNormalizedTelemetry(
      context.store,
      context.adapter.normalizeTelemetry({
        eventType: "host.run.stale_reconciled",
        taskId: projection.sessionId,
        assignmentId,
        metadata: reconciliation.telemetryMetadata
      })
    );
    diagnostics.push(...warningDiagnostics(telemetry.warning, "telemetry-write-failed"));
    const cleanupError = await reconcileStaleRunWithLeaseVerification(
      context.store,
      context.adapter,
      reconciliation.staleRecord
    );
    if (cleanupError) {
      diagnostics.push(
        ...warningDiagnostics(
          `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
          "host-run-persist-failed"
        )
      );
    }
  }

  const record = await context.adapter.inspectRun(context.store);
  if (
    !handledCompletedRun &&
    record?.state === "completed" &&
    record.terminalOutcome &&
    !assignmentIdsToInspect.includes(record.assignmentId)
  ) {
    const completedRecovery = await reconcileCompletedRunRecord(
      context,
      effectiveProjection,
      record,
      diagnostics,
      {
        cleanupRecord: undefined,
        replayableEvents,
        snapshotBoundaryEventId,
        snapshotFallback
      }
    );
    effectiveProjection = completedRecovery.projection;
    changed ||= completedRecovery.changed;
    snapshotFallbackReplayHydrated ||= completedRecovery.replayableHydrated;
  }

  const reconciledRecordsBeforeProvisional = await context.adapter.inspectRuns(context.store);
  const provisionalReconciliation = await reconcileProvisionalAttachmentClaims(
    context,
    effectiveProjection,
    diagnostics,
    new Map(reconciledRecordsBeforeProvisional.map((record) => [record.assignmentId, record] as const)),
    { snapshotFallback }
  );
  effectiveProjection = provisionalReconciliation.projection;
  changed ||= provisionalReconciliation.changed;
  const finalLeaseRecords = await context.adapter.inspectRuns(context.store);
  const finalActiveLeases = listLiveLeaseAssignments(finalLeaseRecords);

  return {
    projection: changed ? effectiveProjection : projection,
    diagnostics: [
      ...diagnostics,
      ...finalLeaseRecords
        .filter((record) => record.state === "running" && !isRunLeaseExpired(record))
        .map((record) => createActiveRunDiagnostic(record.assignmentId, record))
    ],
    activeLeases: finalActiveLeases
  };
}

async function reconcileProvisionalAttachmentClaims(
  context: RunReconciliationContext,
  projection: RuntimeProjection,
  diagnostics: RunReconciliationDiagnostic[],
  recordByAssignmentId: Map<string, HostRunRecord>,
  options?: ProjectionWriteOptions
): Promise<{
  projection: RuntimeProjection;
  changed: boolean;
}> {
  let effectiveProjection = projection;
  let changed = false;

  for (const { attachment, claim } of listProvisionalAttachmentClaims(effectiveProjection)) {
    const assignment = effectiveProjection.assignments.get(claim.assignmentId);
    const record =
      recordByAssignmentId.get(claim.assignmentId)
      ?? await context.adapter.inspectRun(context.store, claim.assignmentId);
    const liveNativeSessionId =
      typeof record?.adapterData?.nativeRunId === "string" && record.adapterData.nativeRunId.length > 0
        ? record.adapterData.nativeRunId
        : undefined;
    const hasLiveLease = !!record && record.state === "running" && !isRunLeaseExpired(record);

    if (hasLiveLease && liveNativeSessionId) {
      effectiveProjection = await AttachmentLifecycleService.promoteProvisionalAttachment(
        context.store,
        effectiveProjection,
        attachment.id,
        claim.id,
        liveNativeSessionId,
        record?.adapterData,
        options
      );
      diagnostics.push({
        level: "warning",
        code: "provisional-attachment-promoted",
        message: `Promoted provisional attachment ${attachment.id} for assignment ${claim.assignmentId} into resumable attachment truth.`
      });
      changed = true;
      continue;
    }

    const startedHostRun = !!record;
    const shouldRequeue = assignment?.state === "in_progress";
    const cleanupReason = hasLiveLease
      ? "Wrapped launch left only unverifiable provisional session state."
      : "Wrapped launch ended before native session identity could be finalized.";
    effectiveProjection = startedHostRun || shouldRequeue
      ? await AttachmentLifecycleService.orphanAttachmentClaim(
          context.store,
          effectiveProjection,
          attachment.id,
          claim.id,
          {
            attachment: cleanupReason,
            claim: cleanupReason
          },
          options
        )
      : await AttachmentLifecycleService.releaseAttachmentClaim(
          context.store,
          effectiveProjection,
          attachment.id,
          claim.id,
          {
            attachment: "Wrapped launch did not establish a durable host session.",
            claim: "Wrapped launch did not establish a durable host session."
          },
          options
        );
    const cleanupError = await cleanupHostRunArtifactsWithLeaseVerification(
      context.store,
      context.adapter,
      claim.assignmentId,
      {
        staleAt: nowIso(),
        staleReason: cleanupReason,
        ...(record ? { inspectedRecord: record } : {})
      }
    );
    if (cleanupError) {
      diagnostics.push(
        ...warningDiagnostics(
          `Host run cleanup artifacts could not be updated for assignment ${claim.assignmentId}. ${cleanupError.message}`,
          "host-run-persist-failed"
        )
      );
    }
    if (shouldRequeue && assignment) {
      effectiveProjection = await AttachmentLifecycleService.requeueAssignmentForRetry(
        context.store,
        effectiveProjection,
        claim.assignmentId,
        assignment.objective,
        options
      );
    }
    diagnostics.push({
      level: "warning",
      code: "provisional-attachment-cleared",
      message: `Cleared provisional attachment ${attachment.id} for assignment ${claim.assignmentId} because launch did not finalize into resumable attachment truth.`
    });
    changed = true;
  }

  return {
    projection: effectiveProjection,
    changed
  };
}

async function reconcileCompletedRunRecord(
  context: RunReconciliationContext,
  projection: RuntimeProjection,
  record: HostRunRecord,
  diagnostics: RunReconciliationDiagnostic[],
  options: {
    cleanupRecord: HostRunRecord | undefined;
    replayableEvents: RuntimeEvent[] | undefined;
    snapshotBoundaryEventId: string | undefined;
    snapshotFallback: boolean;
  }
): Promise<CompletedRunReconciliationResult> {
  let effectiveProjection = projection;
  let changed = false;
  const replayableHydration = hydrateProjectionFromReplayableEvents(
    effectiveProjection,
    options.replayableEvents,
    options.snapshotBoundaryEventId
  );
  if (replayableHydration.hydrated) {
    effectiveProjection = replayableHydration.projection;
    changed = true;
  }
  if (options.snapshotFallback && !effectiveProjection.assignments.has(record.assignmentId)) {
    const missingAssignmentHydration = hydrateMissingAssignmentFromReplayableEvents(
      effectiveProjection,
      record.assignmentId,
      options.replayableEvents,
      options.snapshotBoundaryEventId
    );
    if (missingAssignmentHydration.hydrated) {
      effectiveProjection = missingAssignmentHydration.projection;
      changed = true;
    }
  }
  if (options.snapshotFallback && !effectiveProjection.assignments.has(record.assignmentId)) {
    return {
      projection: effectiveProjection,
      changed,
      handled: false,
      replayableHydrated: replayableHydration.hydrated
    };
  }

  const completedReplayableEvents =
    options.replayableEvents ??
    (options.snapshotFallback ? undefined : (await context.projectionRecovery.loadReplayableEvents()).events);
  const completedRecoveryProofEvents = options.snapshotFallback
    ? selectReplayableSuffixEvents(
        completedReplayableEvents,
        options.snapshotBoundaryEventId ?? ""
      )
    : completedReplayableEvents;
  const completedRecovery = buildCompletedRunReconciliation(
    effectiveProjection,
    record,
    completedRecoveryProofEvents
  );
  if (!completedRecovery) {
    return {
      projection: effectiveProjection,
      changed,
      handled: false,
      replayableHydrated: replayableHydration.hydrated
    };
  }

  const completedAuthorityEvents = AttachmentLifecycleService.buildCompletedAuthorityRepairEvents(
    effectiveProjection,
    record,
    completedRecovery.allEvents[0]?.timestamp ?? nowIso()
  );
  const completedEvents = [...completedRecovery.events, ...completedAuthorityEvents];

  if (completedEvents.length > 0) {
    changed = true;
    effectiveProjection = await applyRecoveryProjectionEvents(
      context,
      effectiveProjection,
      completedEvents,
      diagnostics,
      {
        snapshotFallback: options.snapshotFallback,
        replayableEvents: options.replayableEvents,
        snapshotBoundaryEventId: options.snapshotBoundaryEventId
      }
    );
    diagnostics.push(completedRecovery.diagnostic);
  } else if (options.snapshotFallback) {
    changed = true;
    effectiveProjection = await applyRecoveryProjectionEvents(
      context,
      effectiveProjection,
      [],
      diagnostics,
      {
        snapshotFallback: true,
        replayableEvents: options.replayableEvents,
        snapshotBoundaryEventId: options.snapshotBoundaryEventId
      }
    );
    diagnostics.push(completedRecovery.diagnostic);
  } else {
    changed = true;
    effectiveProjection = await applyRecoveryProjectionEvents(
      context,
      effectiveProjection,
      [],
      diagnostics,
      {
        snapshotFallback: false,
        replayableEvents: options.replayableEvents,
        snapshotBoundaryEventId: options.snapshotBoundaryEventId
      }
    );
  }

  const cleanupError = await reconcileStaleRunWithLeaseVerification(
    context.store,
    context.adapter,
    selectCompletedRunCleanupRecord(record, options.cleanupRecord)
  );
  if (cleanupError) {
    diagnostics.push(
      ...warningDiagnostics(
        `Host run reconciliation artifacts could not be updated for assignment ${record.assignmentId}. ${cleanupError.message}`,
        "host-run-persist-failed"
      )
    );
  }

  return {
    projection: effectiveProjection,
    changed,
    handled: true,
    replayableHydrated: replayableHydration.hydrated
  };
}

function selectCompletedRunCleanupRecord(
  record: HostRunRecord,
  cleanupRecord: HostRunRecord | undefined
): HostRunRecord {
  if (!cleanupRecord || cleanupRecord.state !== "running") {
    return cleanupRecord ?? record;
  }

  return {
    ...record,
    ...(
      cleanupRecord.adapterData ?? record.adapterData
        ? { adapterData: cleanupRecord.adapterData ?? record.adapterData }
        : {}
    ),
    ...(cleanupRecord.staleAt ?? record.staleAt ? { staleAt: cleanupRecord.staleAt ?? record.staleAt } : {}),
    ...(
      cleanupRecord.staleReasonCode ?? record.staleReasonCode
        ? { staleReasonCode: cleanupRecord.staleReasonCode ?? record.staleReasonCode }
        : {}
    ),
    ...(
      cleanupRecord.staleReason ?? record.staleReason
        ? { staleReason: cleanupRecord.staleReason ?? record.staleReason }
        : {}
    )
  };
}

function isStaleRunAlreadyReconciled(
  projection: RuntimeProjection,
  assignmentId: string,
  recoveryState: StaleRunRecoveryState,
  expectedStatus: RuntimeProjection["status"],
  snapshotFallback: boolean
): boolean {
  const assignment = projection.assignments.get(assignmentId);
  return (
    assignment?.state === "queued" &&
    !getActiveClaimForAssignment(projection, assignmentId) &&
    (
      (snapshotFallback && hasEquivalentRuntimeStatus(projection.status, expectedStatus)) ||
      (
        Boolean(recoveryState.queuedTransitionTimestamp) &&
        Boolean(recoveryState.statusTransitionTimestamp)
      )
    )
  );
}

function isDegradedRunRecord(record: HostRunRecord): boolean {
  return (record.state === "completed" && Boolean(record.staleReasonCode) && !record.terminalOutcome) ||
    isRunLeaseExpired(record);
}

function isStaleRunReconciliationCandidate(record: HostRunRecord): boolean {
  return (record.state === "completed" && Boolean(record.staleReasonCode) && !record.terminalOutcome) ||
    isRunLeaseExpired(record);
}

function buildCompletedRunRecordFromRuntimeOutcome(
  projection: RuntimeProjection,
  record: HostRunRecord
): HostRunRecord | undefined {
  const assignmentId = record.assignmentId;
  const startedAt = record.startedAt;
  const decision = [...projection.decisions.values()]
    .filter((candidate) => candidate.assignmentId === assignmentId)
    .filter((candidate) => candidate.createdAt >= startedAt)
    .at(-1);
  const result = [...projection.results.values()]
    .filter(
      (candidate) =>
        candidate.assignmentId === assignmentId &&
        candidate.createdAt >= startedAt &&
        (candidate.status === "completed" || candidate.status === "failed")
    )
    .at(-1);

  if (!decision && !result) {
    return undefined;
  }

  if (result && (!decision || result.createdAt >= decision.createdAt)) {
    return {
      assignmentId,
      state: "completed",
      startedAt,
      completedAt: result.createdAt,
      outcomeKind: "result",
      resultStatus: result.status,
      summary: result.summary,
      terminalOutcome: {
        kind: "result",
        result: {
          resultId: result.resultId,
          producerId: result.producerId,
          status: result.status,
          summary: result.summary,
          changedFiles: [...result.changedFiles],
          createdAt: result.createdAt
        }
      }
    };
  }

  return {
    assignmentId,
    state: "completed",
    startedAt,
    completedAt: decision!.createdAt,
    outcomeKind: "decision",
    summary: decision!.blockerSummary,
    terminalOutcome: {
      kind: "decision",
      decision: {
        decisionId: decision!.decisionId,
        requesterId: decision!.requesterId,
        blockerSummary: decision!.blockerSummary,
        options: decision!.options.map((option) => ({ ...option })),
        recommendedOption: decision!.recommendedOption,
        state: decision!.state,
        createdAt: decision!.createdAt
      }
    }
  };
}

async function loadQueuedTransitions(
  projectionRecovery: ProjectionRecoveryService,
  replayableEvents?: RuntimeEvent[]
): Promise<Map<string, string[]>> {
  const queuedTransitions = new Map<string, string[]>();
  const { events } = replayableEvents ? { events: replayableEvents } : await projectionRecovery.loadReplayableEvents();
  for (const event of events) {
    if (event.type === "assignment.updated" && event.payload.patch.state === "queued") {
      queuedTransitions.set(event.payload.assignmentId, [
        ...(queuedTransitions.get(event.payload.assignmentId) ?? []),
        event.timestamp
      ]);
    }
  }
  return queuedTransitions;
}

async function loadStaleRecoveryStatusTransitions(
  projectionRecovery: ProjectionRecoveryService,
  replayableEvents?: RuntimeEvent[]
): Promise<Map<string, string[]>> {
  const statusTransitions = new Map<string, string[]>();
  const { events } = replayableEvents ? { events: replayableEvents } : await projectionRecovery.loadReplayableEvents();
  for (const event of events) {
    if (event.type !== "status.updated") {
      continue;
    }
    const match = /^Retry assignment ([^:]+): /.exec(event.payload.status.currentObjective);
    if (!match) {
      continue;
    }
    const assignmentId = match[1]!;
    if (!event.payload.status.activeAssignmentIds.includes(assignmentId)) {
      continue;
    }
    statusTransitions.set(assignmentId, [...(statusTransitions.get(assignmentId) ?? []), event.timestamp]);
  }
  return statusTransitions;
}

interface StaleRunRecoveryState {
  queuedTransitionTimestamp: string | undefined;
  statusTransitionTimestamp: string | undefined;
}

function getStaleRunRecoveryState(
  assignmentId: string,
  record: HostRunRecord,
  queuedTransitions: Map<string, string[]>,
  staleStatusTransitions: Map<string, string[]>
): StaleRunRecoveryState {
  const startedAt = Date.parse(record.startedAt);
  if (!Number.isFinite(startedAt)) {
    return {
      queuedTransitionTimestamp: undefined,
      statusTransitionTimestamp: undefined
    };
  }

  const queuedTransitionTimestamp = (queuedTransitions.get(assignmentId) ?? []).find(
    (timestamp) => Date.parse(timestamp) >= startedAt
  );
  const statusTransitionTimestamp = (staleStatusTransitions.get(assignmentId) ?? []).find(
    (timestamp) => Date.parse(timestamp) >= startedAt
  );

  return {
    queuedTransitionTimestamp,
    statusTransitionTimestamp
  };
}

async function reconcileOutOfProjectionStaleRun(
  context: RunReconciliationContext,
  projection: RuntimeProjection,
  assignmentId: string,
  record: HostRunRecord,
  diagnostics: RunReconciliationDiagnostic[]
): Promise<void> {
  const reconciliation = buildStaleRunReconciliation(projection, assignmentId, record);
  diagnostics.push({
    level: "warning",
    code: "stale-run-reconciled",
    message: `Cleared stale host run artifacts for assignment ${assignmentId} after snapshot fallback could not safely hydrate the assignment into runtime state.`
  });

  const telemetry = await recordNormalizedTelemetry(
    context.store,
    context.adapter.normalizeTelemetry({
      eventType: "host.run.stale_reconciled",
      taskId: projection.sessionId,
      assignmentId,
      metadata: reconciliation.telemetryMetadata
    })
  );
  diagnostics.push(...warningDiagnostics(telemetry.warning, "telemetry-write-failed"));

  const cleanupError = await reconcileStaleRunWithLeaseVerification(
    context.store,
    context.adapter,
    reconciliation.staleRecord
  );
  if (cleanupError) {
    diagnostics.push(
      ...warningDiagnostics(
        `Host run reconciliation artifacts could not be updated for assignment ${assignmentId}. ${cleanupError.message}`,
        "host-run-persist-failed"
      )
    );
  }
}

function selectPendingStaleRecoveryEvents(
  events: RuntimeEvent[],
  recoveryState: StaleRunRecoveryState
): RuntimeEvent[] {
  const pendingEvents: RuntimeEvent[] = [];
  const [assignmentEvent, statusEvent] = events;

  if (!recoveryState.queuedTransitionTimestamp) {
    pendingEvents.push(assignmentEvent!);
  }
  if (!recoveryState.statusTransitionTimestamp) {
    pendingEvents.push(statusEvent!);
  }

  return pendingEvents;
}

function buildCompletedRunReconciliation(
  projection: RuntimeProjection,
  record: HostRunRecord,
  replayableEvents?: RuntimeEvent[]
): { events: RuntimeEvent[]; allEvents: RuntimeEvent[]; diagnostic: RunReconciliationDiagnostic } | undefined {
  if (record.state !== "completed" || !record.terminalOutcome) {
    return undefined;
  }
  const timestamp = nowIso();
  const expectedStatus = nextRuntimeStatusFromRecord(projection, record, timestamp);
  const events = buildRecoveredOutcomeEvents(projection, record, timestamp);
  const pendingEvents = selectPendingCompletedRecoveryEvents(
    projection,
    record,
    events,
    expectedStatus,
    replayableEvents
  );
  const assignmentId = record.assignmentId;
  return {
    events: pendingEvents,
    allEvents: events,
    diagnostic: {
      level: "warning",
      code: "completed-run-reconciled",
      message: `Recovered completed host outcome for assignment ${assignmentId} after runtime event persistence was interrupted.`
    }
  };
}

function selectPendingCompletedRecoveryEvents(
  projection: RuntimeProjection,
  record: HostRunRecord,
  events: RuntimeEvent[],
  expectedStatus: RuntimeProjection["status"],
  replayableEvents?: RuntimeEvent[]
): RuntimeEvent[] {
  const [outcomeEvent, assignmentEvent, statusEvent] = events;
  const pendingEvents: RuntimeEvent[] = [];
  const recoveredOutcomeEventIndex = replayableEvents
    ? findRecoveredCompletedOutcomeEventIndexFromEvents(replayableEvents, record)
    : undefined;
  const outcomeRecoveredInProjection = hasRecoveredCompletedOutcomeEvent(projection, record);
  const outcomeAlreadyAbsorbed =
    outcomeRecoveredInProjection || recoveredOutcomeEventIndex !== undefined;
  const canUseReplayableConvergenceProof =
    replayableEvents !== undefined && recoveredOutcomeEventIndex !== undefined;
  const recoveredDecision =
    findRecoveredCompletedDecision(projection, record) ??
    (canUseReplayableConvergenceProof
      ? findRecoveredCompletedDecisionEvent(replayableEvents, record)
      : undefined);
  const recoveredDecisionState = recoveredDecision?.state;

  if (!outcomeAlreadyAbsorbed) {
    return [...events];
  }

  if (record.terminalOutcome?.kind === "decision") {
    if (!hasRecoveredCompletedAssignmentState(projection, record, recoveredDecisionState)) {
      pendingEvents.push(assignmentEvent!);
    }
    if (!hasRecoveredCompletedStatus(projection, record, expectedStatus)) {
      pendingEvents.push(statusEvent!);
    }
    return pendingEvents;
  }

  if (!hasRecoveredCompletedAssignmentState(projection, record)) {
    pendingEvents.push(assignmentEvent!);
  }
  if (!hasRecoveredCompletedStatus(projection, record, expectedStatus)) {
    pendingEvents.push(statusEvent!);
  }

  return pendingEvents;
}

function hasRecoveredCompletedOutcomeEvent(
  projection: RuntimeProjection,
  record: HostRunRecord
): boolean {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome) {
    return false;
  }
  if (terminalOutcome.kind === "decision") {
    return findRecoveredCompletedDecision(projection, record) !== undefined;
  }
  return [...projection.results.values()].some((result) => {
    if (record.terminalOutcome?.kind !== "result") {
      return false;
    }
    return (
      result.assignmentId === record.assignmentId &&
      (record.terminalOutcome.result.resultId
        ? result.resultId === record.terminalOutcome.result.resultId
        : result.status === record.terminalOutcome.result.status &&
          result.summary === record.terminalOutcome.result.summary &&
          result.createdAt === record.terminalOutcome.result.createdAt)
    );
  });
}

function findRecoveredCompletedDecisionEvent(
  events: RuntimeEvent[],
  record: HostRunRecord
): DecisionPacket | undefined {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome || terminalOutcome.kind !== "decision") {
    return undefined;
  }
  return events
    .filter((event): event is Extract<RuntimeEvent, { type: "decision.created" }> => event.type === "decision.created")
    .find((event) => {
      if (event.payload.decision.assignmentId !== record.assignmentId) {
        return false;
      }
      return terminalOutcome.decision.decisionId
        ? event.payload.decision.decisionId === terminalOutcome.decision.decisionId
        : event.payload.decision.blockerSummary === terminalOutcome.decision.blockerSummary &&
            event.payload.decision.recommendedOption === terminalOutcome.decision.recommendedOption &&
            event.payload.decision.createdAt === terminalOutcome.decision.createdAt;
    })?.payload.decision;
}

function findRecoveredCompletedOutcomeEventIndexFromEvents(
  events: RuntimeEvent[],
  record: HostRunRecord
): number | undefined {
  if (!record.terminalOutcome) {
    return undefined;
  }
  if (record.terminalOutcome.kind === "decision") {
    const decisionIndex = events.findIndex((event): event is Extract<RuntimeEvent, { type: "decision.created" }> => {
      if (event.type !== "decision.created") {
        return false;
      }
      if (event.payload.decision.assignmentId !== record.assignmentId) {
        return false;
      }
      return record.terminalOutcome?.kind === "decision" &&
        (record.terminalOutcome.decision.decisionId
          ? event.payload.decision.decisionId === record.terminalOutcome.decision.decisionId
          : event.payload.decision.blockerSummary === record.terminalOutcome.decision.blockerSummary &&
              event.payload.decision.recommendedOption === record.terminalOutcome.decision.recommendedOption &&
              event.payload.decision.createdAt === record.terminalOutcome.decision.createdAt);
    });
    return decisionIndex === -1 ? undefined : decisionIndex;
  }
  const resultIndex = events.findIndex((event): event is Extract<RuntimeEvent, { type: "result.submitted" }> => {
    if (event.type !== "result.submitted") {
      return false;
    }
    if (event.payload.result.assignmentId !== record.assignmentId) {
      return false;
    }
    return record.terminalOutcome?.kind === "result" &&
      (record.terminalOutcome.result.resultId
        ? event.payload.result.resultId === record.terminalOutcome.result.resultId
        : event.payload.result.status === record.terminalOutcome.result.status &&
            event.payload.result.summary === record.terminalOutcome.result.summary &&
            event.payload.result.createdAt === record.terminalOutcome.result.createdAt);
  });
  return resultIndex === -1 ? undefined : resultIndex;
}

function findRecoveredCompletedDecision(
  projection: RuntimeProjection,
  record: HostRunRecord
) {
  const terminalOutcome = record.terminalOutcome;
  if (!terminalOutcome || terminalOutcome.kind !== "decision") {
    return undefined;
  }
  return [...projection.decisions.values()].find((decision) => {
    if (decision.assignmentId !== record.assignmentId) {
      return false;
    }
    return terminalOutcome.decision.decisionId
      ? decision.decisionId === terminalOutcome.decision.decisionId
      : decision.blockerSummary === terminalOutcome.decision.blockerSummary &&
          decision.recommendedOption === terminalOutcome.decision.recommendedOption &&
          decision.createdAt === terminalOutcome.decision.createdAt;
  });
}

function hasRecoveredCompletedAssignmentState(
  projection: RuntimeProjection,
  record: HostRunRecord,
  recoveredDecisionState?: "open" | "resolved"
): boolean {
  const assignment = projection.assignments.get(record.assignmentId);
  const expectedAssignmentState = nextAssignmentStateFromRecord(record, recoveredDecisionState);
  return assignment?.state === expectedAssignmentState;
}

function hasRecoveredCompletedStatus(
  projection: RuntimeProjection,
  record: HostRunRecord,
  expectedStatus: RuntimeProjection["status"]
): boolean {
  if (
    !hasEquivalentCompletedRecoveryStatus(
      projection.status,
      expectedStatus,
      record.terminalOutcome?.kind === "decision"
    )
  ) {
    return false;
  }
  return !(
    record.terminalOutcome?.kind === "result" &&
    projection.status.activeAssignmentIds.includes(record.assignmentId)
  );
}

function hasEquivalentCompletedRecoveryStatus(
  actualStatus: RuntimeProjection["status"],
  expectedStatus: RuntimeProjection["status"],
  compareCurrentObjective: boolean
): boolean {
  return (!compareCurrentObjective || actualStatus.currentObjective === expectedStatus.currentObjective) &&
    actualStatus.activeMode === expectedStatus.activeMode &&
    actualStatus.resumeReady === expectedStatus.resumeReady &&
    actualStatus.activeAssignmentIds.length === expectedStatus.activeAssignmentIds.length &&
    actualStatus.activeAssignmentIds.every((id, index) => id === expectedStatus.activeAssignmentIds[index]);
}

function hydrateProjectionFromReplayableEvents(
  projection: RuntimeProjection,
  replayableEvents?: RuntimeEvent[],
  snapshotBoundaryEventId?: string
): {
  projection: RuntimeProjection;
  hydrated: boolean;
} {
  const hydrationEvents = snapshotBoundaryEventId
    ? selectReplayableSuffixEvents(replayableEvents, snapshotBoundaryEventId)
    : replayableEvents;
  if (!hydrationEvents || hydrationEvents.length === 0) {
    return {
      projection,
      hydrated: false
    };
  }

  const hydratedProjection = fromSnapshot(toSnapshot(projection));
  let hydrated = false;
  for (const event of hydrationEvents) {
    try {
      applyRuntimeEvent(hydratedProjection, event);
      hydrated = true;
    } catch {
      continue;
    }
  }
  return {
    projection: hydrated ? hydratedProjection : projection,
    hydrated
  };
}

function listLiveLeaseAssignments(records: HostRunRecord[]): string[] {
  return records
    .filter((record) => record.state === "running" && !isRunLeaseExpired(record))
    .map((record) => record.assignmentId);
}

function hasEquivalentRuntimeStatus(
  actualStatus: RuntimeProjection["status"],
  expectedStatus: RuntimeProjection["status"]
): boolean {
  return actualStatus.currentObjective === expectedStatus.currentObjective &&
    actualStatus.activeMode === expectedStatus.activeMode &&
    actualStatus.resumeReady === expectedStatus.resumeReady &&
    actualStatus.activeAssignmentIds.length === expectedStatus.activeAssignmentIds.length &&
    actualStatus.activeAssignmentIds.every((id, index) => id === expectedStatus.activeAssignmentIds[index]);
}

function selectReplayableSuffixEvents(
  replayableEvents: RuntimeEvent[] | undefined,
  snapshotBoundaryEventId: string
): RuntimeEvent[] | undefined {
  if (!replayableEvents || replayableEvents.length === 0) {
    return undefined;
  }
  const boundaryIndex = replayableEvents.findIndex((event) => event.eventId === snapshotBoundaryEventId);
  if (boundaryIndex === -1) {
    return undefined;
  }
  return replayableEvents.slice(boundaryIndex + 1);
}

function hydrateMissingAssignmentFromReplayableEvents(
  projection: RuntimeProjection,
  assignmentId: string,
  replayableEvents?: RuntimeEvent[],
  snapshotBoundaryEventId?: string
): {
  projection: RuntimeProjection;
  hydrated: boolean;
} {
  if (!replayableEvents || replayableEvents.length === 0) {
    return {
      projection,
      hydrated: false
    };
  }

  const assignmentEventFromSuffix = snapshotBoundaryEventId
    ? selectReplayableSuffixEvents(replayableEvents, snapshotBoundaryEventId)?.find(
        (event): event is Extract<RuntimeEvent, { type: "assignment.created" }> =>
          event.type === "assignment.created" && event.payload.assignment.id === assignmentId
      )
    : undefined;
  const assignmentEvent = assignmentEventFromSuffix;
  if (!assignmentEvent) {
    return {
      projection,
      hydrated: false
    };
  }

  const hydratedProjection = fromSnapshot(toSnapshot(projection));
  applyRuntimeEvent(hydratedProjection, assignmentEvent);
  return {
    projection: hydratedProjection,
    hydrated: true
  };
}

function buildRecoveredOutcomeEvents(
  projection: RuntimeProjection,
  record: HostRunRecord,
  timestamp: string
): RuntimeEvent[] {
  if (!record.terminalOutcome) {
    throw new Error(`Completed host run for assignment ${record.assignmentId} is missing terminal outcome data.`);
  }
  const status = nextRuntimeStatusFromRecord(projection, record, timestamp);
  const events: RuntimeEvent[] = [];

  if (record.terminalOutcome.kind === "decision") {
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "decision.created",
      payload: {
        decision: {
          decisionId: record.terminalOutcome.decision.decisionId ?? randomUUID(),
          assignmentId: record.assignmentId,
          requesterId: record.terminalOutcome.decision.requesterId,
          blockerSummary: record.terminalOutcome.decision.blockerSummary,
          options: record.terminalOutcome.decision.options.map((option) => ({ ...option })),
          recommendedOption: record.terminalOutcome.decision.recommendedOption,
          state: record.terminalOutcome.decision.state,
          createdAt: record.terminalOutcome.decision.createdAt
        }
      }
    });
  } else {
    events.push({
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "result.submitted",
      payload: {
        result: {
          resultId: record.terminalOutcome.result.resultId ?? randomUUID(),
          assignmentId: record.assignmentId,
          producerId: record.terminalOutcome.result.producerId,
          status: record.terminalOutcome.result.status,
          summary: record.terminalOutcome.result.summary,
          changedFiles: [...record.terminalOutcome.result.changedFiles],
          createdAt: record.terminalOutcome.result.createdAt
        }
      }
    });
  }

  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "assignment.updated",
    payload: {
      assignmentId: record.assignmentId,
      patch: {
        state: nextAssignmentStateFromRecord(record),
        updatedAt: timestamp
      }
    }
  });
  events.push({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "status.updated",
    payload: { status: nextRuntimeStatusFromRecord(projection, record, timestamp) }
  });

  return events;
}

function nextAssignmentStateFromRecord(record: HostRunRecord, recoveredDecisionState?: "open" | "resolved") {
  if (!record.terminalOutcome) {
    return "failed" as const;
  }
  if (record.terminalOutcome.kind === "decision") {
    return recoveredDecisionState === "resolved" ? "in_progress" : ("blocked" as const);
  }
  switch (record.terminalOutcome.result.status) {
    case "completed":
      return "completed" as const;
    case "failed":
      return "failed" as const;
    default:
      return "in_progress" as const;
  }
}

function nextRuntimeStatusFromRecord(
  projection: RuntimeProjection,
  record: HostRunRecord,
  timestamp: string
) {
  const terminal =
    record.terminalOutcome?.kind === "result" &&
    (record.terminalOutcome.result.status === "completed" ||
      record.terminalOutcome.result.status === "failed");
  const activeAssignmentIds = terminal
    ? projection.status.activeAssignmentIds.filter((id) => id !== record.assignmentId)
    : projection.status.activeAssignmentIds;

  return {
    ...projection.status,
    activeMode: activeAssignmentIds.length === 0 ? "idle" : projection.status.activeMode,
    currentObjective:
      activeAssignmentIds.length === 0
        ? record.terminalOutcome?.kind === "result" &&
          record.terminalOutcome.result.status === "failed"
          ? `Review failed assignment ${record.assignmentId}.`
          : "Await the next assignment."
        : record.terminalOutcome?.kind === "decision"
          ? nextDecisionCurrentObjective(
              projection,
              record.assignmentId,
              record.terminalOutcome.decision.blockerSummary
            )
          : projection.status.currentObjective,
    activeAssignmentIds,
    lastDurableOutputAt: timestamp,
    resumeReady: true
  };
}

function nextDecisionCurrentObjective(
  projection: RuntimeProjection,
  assignmentId: string,
  blockerSummary: string
): string {
  const latestDecision = [...projection.decisions.values()]
    .filter((decision) => decision.assignmentId === assignmentId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
  if (!latestDecision) {
    return blockerSummary.trim().length > 0 ? blockerSummary : projection.status.currentObjective;
  }
  if (latestDecision.state === "resolved") {
    return projection.status.currentObjective;
  }
  if (!statusObjectiveTracksAssignment(projection, assignmentId)) {
    return projection.status.currentObjective;
  }
  return blockerSummary.trim().length > 0 ? blockerSummary : projection.status.currentObjective;
}

function statusObjectiveTracksAssignment(
  projection: RuntimeProjection,
  assignmentId: string
): boolean {
  const assignmentObjective = projection.assignments.get(assignmentId)?.objective;
  if (assignmentObjective && projection.status.currentObjective === assignmentObjective) {
    return true;
  }
  return projection.status.currentObjective.startsWith(`Retry assignment ${assignmentId}:`);
}

async function mutateSnapshotFallbackProjection(
  store: RuntimeStore,
  replayableEvents: RuntimeEvent[] | undefined,
  snapshotBoundaryEventId: string | undefined,
  mutate: (projection: RuntimeProjection) => RuntimeProjection | Promise<RuntimeProjection>
): Promise<RuntimeProjection> {
  return store.mutateSnapshotProjection(async (latestProjection) => {
    const hydrated = hydrateProjectionFromReplayableEvents(
      latestProjection,
      replayableEvents,
      snapshotBoundaryEventId
    );
    return mutate(hydrated.projection);
  });
}

async function syncProjectionSnapshot(
  context: RunReconciliationContext,
  options: RecoveryProjectionOptions
): Promise<{
  projection: RuntimeProjection;
  warning?: string;
}> {
  if (options.snapshotFallback) {
    return {
      projection: await mutateSnapshotFallbackProjection(
        context.store,
        options.replayableEvents,
        options.snapshotBoundaryEventId,
        (latestProjection) => latestProjection
      )
    };
  }
  return context.projectionRecovery.syncSnapshotFromEventsWithRecovery();
}

async function applyRecoveryProjectionEvents(
  context: RunReconciliationContext,
  projection: RuntimeProjection,
  events: RuntimeEvent[],
  diagnostics: RunReconciliationDiagnostic[],
  options: RecoveryProjectionOptions
): Promise<RuntimeProjection> {
  if (events.length === 0) {
    const syncResult = await syncProjectionSnapshot(context, options);
    diagnostics.push(...warningDiagnostics(syncResult.warning, "event-log-repaired"));
    return syncResult.projection;
  }
  const persisted = await persistProjectionEvents(
    context,
    projection,
    events,
    {
      snapshotFallback: options.snapshotFallback
    },
    options
  );
  diagnostics.push(...warningDiagnostics(persisted.warning, "event-log-repaired"));
  return persisted.projection;
}

async function persistProjectionEvents(
  context: RunReconciliationContext,
  projection: RuntimeProjection,
  events: RuntimeEvent[],
  options: ProjectionWriteOptions | undefined,
  recoveryOptions: RecoveryProjectionOptions
): Promise<{
  projection: RuntimeProjection;
  warning?: string;
}> {
  if (!options?.snapshotFallback) {
    await context.store.appendEvents(events);
    return context.projectionRecovery.syncSnapshotFromEventsWithRecovery();
  }

  return {
    projection: await mutateSnapshotFallbackProjection(
      context.store,
      recoveryOptions.replayableEvents,
      recoveryOptions.snapshotBoundaryEventId,
      (latestProjection) => applyRuntimeEventsToProjection(latestProjection, events)
    )
  };
}

function applyRuntimeEventsToProjection(
  projection: RuntimeProjection,
  events: RuntimeEvent[]
): RuntimeProjection {
  const nextProjection = fromSnapshot(toSnapshot(projection));
  for (const event of events) {
    applyRuntimeEvent(nextProjection, event);
  }
  return nextProjection;
}

function warningDiagnostics(
  warning: string | undefined,
  code: RunReconciliationDiagnostic["code"]
): RunReconciliationDiagnostic[] {
  return warning
    ? [{
        level: "warning",
        code,
        message: warning
      }]
    : [];
}
