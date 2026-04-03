import { access } from "node:fs/promises";
import { join } from "node:path";

import type {
  AdapterCapabilities,
  DoctorCheck,
  HostAdapter,
  TaskEnvelope
} from "../../core/host.js";
import type { RecoveryBrief, RuntimeProjection } from "../../core/types.js";
import type { RuntimeStore } from "../../persistence/store.js";
import { ensureDir, writeJsonAtomic } from "../../persistence/files.js";
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

  paths(store: RuntimeStore): CodexPaths {
    const rootDir = join(store.adaptersDir, this.id);
    return {
      rootDir,
      kernelPath: join(rootDir, "kernel.md"),
      profilePath: join(rootDir, "profile.json"),
      capabilitiesPath: join(rootDir, "capabilities.json")
    };
  }

  async initialize(store: RuntimeStore, projection: RuntimeProjection): Promise<void> {
    const paths = this.paths(store);
    await ensureDir(paths.rootDir);
    await writeCodexKernel(paths.kernelPath);

    const profileManager = new CodexProfileManager(store);
    await profileManager.writeProfile(paths.kernelPath);
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
    await writeJsonAtomic(envelopePath, this.buildResumeEnvelope(projection, brief));
  }

  async doctor(store: RuntimeStore): Promise<DoctorCheck[]> {
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

  buildResumeEnvelope(projection: RuntimeProjection, brief: RecoveryBrief): TaskEnvelope {
    return buildTaskEnvelope(projection, brief, {
      host: this.host,
      adapter: this.id,
      maxChars: 4_000,
      resultSummaryLimit: 400
    });
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
