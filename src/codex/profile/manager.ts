import { join } from "node:path";

import type { RuntimeStore } from "../../persistence/store.js";
import { readJsonFile, writeJsonAtomic } from "../../persistence/files.js";
import type { DoctorCheck } from "../../core/host.js";
import type { CodexProfileConfig } from "./types.js";

export class CodexProfileManager {
  constructor(private readonly store: RuntimeStore) {}

  profilePath(): string {
    return join(this.store.adaptersDir, "codex", "profile.json");
  }

  buildProfileConfig(kernelPath: string): CodexProfileConfig {
    return {
      name: "coortex-codex",
      host: "codex",
      modelInstructionsFile: kernelPath,
      notes:
        "Coortex-managed Codex profile configuration for the reference Milestone 1 adapter."
    };
  }

  async writeProfile(kernelPath: string): Promise<CodexProfileConfig> {
    const profile = this.buildProfileConfig(kernelPath);
    await writeJsonAtomic(this.profilePath(), profile);
    return profile;
  }

  async loadProfile(): Promise<CodexProfileConfig | undefined> {
    const value = await readJsonFile<unknown>(this.profilePath(), "codex profile");
    if (!value) {
      return undefined;
    }
    return validateCodexProfileConfig(value);
  }

  async doctor(): Promise<DoctorCheck> {
    const profile = await this.loadProfile();
    return {
      label: "codex-profile",
      ok: !!profile && profile.host === "codex" && profile.name.length > 0,
      detail: this.profilePath()
    };
  }
}

function validateCodexProfileConfig(value: unknown): CodexProfileConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid codex profile: expected an object.");
  }
  const record = value as Record<string, unknown>;
  const name = readString(record, "name");
  const host = readString(record, "host");
  const modelInstructionsFile = readString(record, "modelInstructionsFile");
  const notes = readString(record, "notes");

  if (host !== "codex") {
    throw new Error("Invalid codex profile: host must equal 'codex'.");
  }

  return {
    name,
    host: "codex",
    modelInstructionsFile,
    notes
  };
}

function readString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Invalid codex profile: ${key} must be a non-empty string.`);
  }
  return field;
}
