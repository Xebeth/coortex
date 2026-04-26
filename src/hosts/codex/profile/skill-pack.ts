import { existsSync, readFileSync } from "node:fs";
import { access, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DoctorCheck, RuntimeArtifactStore } from "../../../adapters/contract.js";
import type { CodexSkillPackInstallation } from "./types.js";

const MANAGED_SKILLS = [
  "coortex-deslop",
  "coortex-fixer-lane",
  "coortex-review",
  "coortex-review-lane",
  "fixer-orchestrator",
  "implementation-coordinator",
  "review-baseline",
  "review-fixer",
  "review-orchestrator",
  "seam-walkback-review"
] as const;

export class CodexSkillPackManager {
  constructor(private readonly store: RuntimeArtifactStore) {}

  skillsRoot(): string {
    return join(dirname(this.store.rootDir), ".codex", "skills");
  }

  managedSkills(): readonly string[] {
    return MANAGED_SKILLS;
  }

  async install(): Promise<CodexSkillPackInstallation> {
    const sourceRoot = resolveSkillPackSourceRoot();
    const skillsRoot = this.skillsRoot();

    await mkdir(skillsRoot, { recursive: true });
    for (const skillName of MANAGED_SKILLS) {
      const sourceDir = join(sourceRoot, skillName);
      await access(join(sourceDir, "SKILL.md"));

      const targetDir = join(skillsRoot, skillName);
      await rm(targetDir, { recursive: true, force: true });
      await cp(sourceDir, targetDir, { recursive: true });
    }

    await this.store.writeJsonArtifact("adapters/codex/skill-pack.json", {
      host: "codex",
      managedSkills: [...MANAGED_SKILLS],
      sourceRoot,
      skillsRoot
    });

    return {
      skillsRoot,
      managedSkills: [...MANAGED_SKILLS]
    };
  }

  async doctor(): Promise<DoctorCheck> {
    const skillsRoot = this.skillsRoot();
    const checks = await Promise.all(
      MANAGED_SKILLS.map(async (skillName) =>
        fileExists(join(skillsRoot, skillName, "SKILL.md"))
      )
    );

    return {
      label: "codex-skill-pack",
      ok: checks.every(Boolean),
      detail: skillsRoot
    };
  }
}

function resolveSkillPackSourceRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const packageJsonPath = join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        name?: string;
      };
      if (packageJson.name === "coortex") {
        return join(current, "src", "hosts", "codex", "profile", "skill-pack");
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error("Unable to locate the Coortex package root for the Codex skill pack.");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
