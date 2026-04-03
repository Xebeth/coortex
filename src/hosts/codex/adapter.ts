import { dirname, join } from "node:path";

import { buildTaskEnvelope } from "../../adapters/envelope.js";
import type { AdapterCapabilities, DoctorCheck, HostAdapter, TaskEnvelope } from "../../adapters/types.js";
import type { RecoveryBrief, RuntimeProjection } from "../../core/types.js";
import type { RuntimeStore } from "../../persistence/store.js";
import { ensureDir, readJsonFile, writeJsonAtomic } from "../../persistence/files.js";

interface CodexProfile {
  name: string;
  host: "codex";
  modelInstructionsFile: string;
  notes: string;
}

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

  async initialize(store: RuntimeStore, projection: RuntimeProjection): Promise<void> {
    const adapterDir = join(store.adaptersDir, this.id);
    await ensureDir(adapterDir);

    const kernelPath = join(adapterDir, "kernel.md");
    const profilePath = join(adapterDir, "profile.json");
    const kernel = [
      "# Coortex Codex Kernel",
      "",
      "Consult Coortex runtime state before acting.",
      "Stay within the runtime-provided write scope.",
      "Use the recovery brief when resuming interrupted work.",
      "Keep outputs structured, concise, and durable."
    ].join("\n");

    const profile: CodexProfile = {
      name: "coortex-codex",
      host: "codex",
      modelInstructionsFile: kernelPath,
      notes:
        "Reference artifact for the Coortex Codex adapter. Copy into host configuration as needed."
    };

    await writeJsonAtomic(profilePath, profile);
    await writeKernel(kernelPath, kernel);

    const capabilitiesPath = join(adapterDir, "capabilities.json");
    await writeJsonAtomic(capabilitiesPath, this.getCapabilities());

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
    const adapterDir = join(store.adaptersDir, this.id);
    const kernelPath = join(adapterDir, "kernel.md");
    const profilePath = join(adapterDir, "profile.json");
    const profile = await readJsonFile<CodexProfile>(profilePath, "codex profile");

    return [
      {
        label: "codex-kernel",
        ok: await fileExists(kernelPath),
        detail: kernelPath
      },
      {
        label: "codex-profile",
        ok: !!profile && profile.host === "codex",
        detail: profilePath
      }
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

async function writeKernel(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, `${content}\n`, "utf8");
}

async function fileExists(path: string): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
