import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  AdapterCapabilities,
  DoctorCheck,
  HostAdapter,
  HostDecisionCapture,
  HostResultCapture,
  HostTelemetryCapture,
  RuntimeArtifactStore,
  TaskEnvelope
} from "../../../adapters/contract.js";
import type { DecisionPacket, RecoveryBrief, ResultPacket, RuntimeProjection } from "../../../core/types.js";
import { ensureDir, writeJsonAtomic } from "../../../persistence/files.js";
import { nowIso } from "../../../utils/time.js";
import { buildTaskEnvelope } from "./envelope.js";
import type { CodexPaths } from "./types.js";
import { writeCodexKernel } from "../kernel/static.js";
import { CodexProfileManager } from "../profile/manager.js";

export class CodexAdapter implements HostAdapter {
  readonly id = "codex";
  readonly host = "codex";

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
      capabilitiesPath: join(rootDir, "capabilities.json")
    };
  }

  async initialize(store: RuntimeArtifactStore, projection: RuntimeProjection): Promise<void> {
    const paths = this.paths(store);
    await ensureDir(paths.rootDir);
    await writeCodexKernel(paths.kernelPath);

    const profileManager = new CodexProfileManager(store);
    await profileManager.install(paths.kernelPath);
    await writeJsonAtomic(paths.capabilitiesPath, this.getCapabilities());

    const envelopePath = join(store.runtimeDir, "last-resume-envelope.json");
    const brief: RecoveryBrief = {
      activeObjective: projection.status.currentObjective,
      activeAssignments: [],
      lastDurableResults: [],
      unresolvedDecisions: [],
      nextRequiredAction: "Initialize through ctx resume when needed.",
      generatedAt: projection.status.lastDurableOutputAt
    };
    await writeJsonAtomic(envelopePath, await this.buildResumeEnvelope(store, projection, brief));
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
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
