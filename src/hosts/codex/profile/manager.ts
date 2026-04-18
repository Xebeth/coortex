import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { DoctorCheck, RuntimeArtifactStore } from "../../../adapters/contract.js";
import type { CodexConfigInstallation, CodexProfileConfig } from "./types.js";

const MANAGED_BLOCK_START = "# BEGIN COORTEX CODEX PROFILE";
const MANAGED_BLOCK_END = "# END COORTEX CODEX PROFILE";
const MANAGED_AGENTS_BLOCK_START = "# BEGIN COORTEX CODEX AGENTS";
const MANAGED_AGENTS_BLOCK_END = "# END COORTEX CODEX AGENTS";
const REQUIRED_AGENT_THREADS = 12;

export class CodexProfileManager {
  constructor(private readonly store: RuntimeArtifactStore) {}

  manifestPath(): string {
    return join(this.store.adaptersDir, "codex", "profile.json");
  }

  configPath(): string {
    return join(dirname(this.store.rootDir), ".codex", "config.toml");
  }

  globalConfigPath(): string {
    return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  }

  buildProfileConfig(kernelPath: string): CodexProfileConfig {
    return {
      name: "coortex-codex",
      host: "codex",
      modelInstructionsFile: kernelPath,
      notes:
        "Coortex-managed Codex profile manifest. The real Codex integration is installed into project-local .codex/config.toml."
    };
  }

  async writeProfile(kernelPath: string): Promise<CodexProfileConfig> {
    const profile = this.buildProfileConfig(kernelPath);
    await this.store.writeJsonArtifact("adapters/codex/profile.json", profile);
    return profile;
  }

  async install(kernelPath: string): Promise<CodexConfigInstallation> {
    const configPath = this.configPath();
    const block = renderManagedProfileBlock(kernelPath);
    const existing = await readTextIfPresent(configPath);
    const profileNext = mergeManagedProfileBlock(configPath, existing, block);
    const globalConfig =
      this.globalConfigPath() === configPath
        ? undefined
        : await readTextIfPresent(this.globalConfigPath());
    const next = syncManagedAgentsBlock(profileNext, globalConfig);

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, next, "utf8");
    await this.writeProfile(kernelPath);

    return {
      configPath,
      modelInstructionsFile: kernelPath
    };
  }

  async loadProfile(): Promise<CodexProfileConfig | undefined> {
    const value = await this.store.readJsonArtifact<unknown>("adapters/codex/profile.json", "codex profile");
    if (!value) {
      return undefined;
    }
    return validateCodexProfileConfig(value);
  }

  async doctor(): Promise<DoctorCheck> {
    const profile = await this.loadProfile();
    const config = await readTextIfPresent(this.configPath());
    const configInstalled =
      typeof config === "string" &&
      config.includes(MANAGED_BLOCK_START) &&
      config.includes(
        `model_instructions_file = "${escapeTomlBasicString(profile?.modelInstructionsFile ?? "")}"`
      );
    return {
      label: "codex-profile",
      ok: !!profile && profile.host === "codex" && profile.name.length > 0 && configInstalled,
      detail: this.configPath()
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

function renderManagedProfileBlock(kernelPath: string): string {
  return [
    MANAGED_BLOCK_START,
    "# Coortex Codex reference adapter",
    `model_instructions_file = "${escapeTomlBasicString(kernelPath)}"`,
    MANAGED_BLOCK_END
  ].join("\n");
}

function renderManagedAgentsBlock(): string {
  return [
    MANAGED_AGENTS_BLOCK_START,
    "# Coortex review lanes may exceed the Codex default worker limit",
    "[agents]",
    `max_threads = ${REQUIRED_AGENT_THREADS}`,
    MANAGED_AGENTS_BLOCK_END
  ].join("\n");
}

function mergeManagedProfileBlock(configPath: string, existing: string | undefined, block: string): string {
  if (!existing || existing.trim().length === 0) {
    return `${block}\n`;
  }
  if (existing.includes(MANAGED_BLOCK_START) && existing.includes(MANAGED_BLOCK_END)) {
    return `${existing.replace(
      new RegExp(`${escapeRegExp(MANAGED_BLOCK_START)}[\\s\\S]*?${escapeRegExp(MANAGED_BLOCK_END)}`),
      block
    )}\n`;
  }
  if (hasTopLevelTomlKey(existing, "model_instructions_file")) {
    throw new Error(
      `Cannot install Coortex Codex profile into ${configPath}: unmanaged model_instructions_file already exists.`
    );
  }
  return `${existing.trimEnd()}\n\n${block}\n`;
}

function syncManagedAgentsBlock(existing: string, globalConfig: string | undefined): string {
  const withoutManagedBlock = removeManagedAgentsBlock(existing).trimEnd();
  const localAgentsConfig = readAgentsConfigSummary(withoutManagedBlock);
  const globalAgentsConfig = readAgentsConfigSummary(globalConfig);

  if (localAgentsConfig.hasConfig) {
    return `${withoutManagedBlock}\n`;
  }
  if ((globalAgentsConfig.maxThreads ?? 0) >= REQUIRED_AGENT_THREADS) {
    return `${withoutManagedBlock}\n`;
  }

  const block = renderManagedAgentsBlock();
  return withoutManagedBlock.length === 0
    ? `${block}\n`
    : `${withoutManagedBlock}\n\n${block}\n`;
}

function removeManagedAgentsBlock(value: string): string {
  if (!value.includes(MANAGED_AGENTS_BLOCK_START) || !value.includes(MANAGED_AGENTS_BLOCK_END)) {
    return value;
  }
  return value.replace(
    new RegExp(
      `(?:\\n\\n)?${escapeRegExp(MANAGED_AGENTS_BLOCK_START)}[\\s\\S]*?${escapeRegExp(MANAGED_AGENTS_BLOCK_END)}(?:\\n)?`,
      "g"
    ),
    ""
  );
}

function hasTopLevelTomlKey(value: string, key: string): boolean {
  const lines = value.split("\n");
  let inMultiline = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!inMultiline && line.includes('"""')) {
      const count = line.split('"""').length - 1;
      if (count % 2 === 1) {
        inMultiline = true;
      }
    } else if (inMultiline && line.includes('"""')) {
      const count = line.split('"""').length - 1;
      if (count % 2 === 1) {
        inMultiline = false;
      }
      continue;
    }
    if (inMultiline || line.length === 0 || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[")) {
      continue;
    }
    if (new RegExp(`^${escapeRegExp(key)}\\s*=`).test(line)) {
      return true;
    }
  }
  return false;
}

function readAgentsConfigSummary(value: string | undefined): { hasConfig: boolean; maxThreads?: number } {
  if (!value) {
    return { hasConfig: false };
  }

  const lines = value.split("\n");
  let currentTable: string | undefined;
  let hasConfig = false;
  let maxThreads: number | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const tableMatch = /^\[(.+)\]$/.exec(line);
    if (tableMatch) {
      currentTable = tableMatch[1]!.trim();
      if (currentTable === "agents") {
        hasConfig = true;
      }
      continue;
    }

    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) {
      continue;
    }

    const lhs = assignment[1]!;
    const rhs = assignment[2]!;

    if (currentTable === "agents") {
      hasConfig = true;
      if (lhs === "max_threads") {
        maxThreads = readIntegerLiteral(rhs) ?? maxThreads;
      }
      continue;
    }

    if (!currentTable && lhs === "agents") {
      hasConfig = true;
      maxThreads = readInlineTableMaxThreads(rhs) ?? maxThreads;
      continue;
    }
    if (!currentTable && lhs.startsWith("agents.")) {
      hasConfig = true;
      if (lhs === "agents.max_threads") {
        maxThreads = readIntegerLiteral(rhs) ?? maxThreads;
      }
      continue;
    }
  }

  return maxThreads === undefined ? { hasConfig } : { hasConfig, maxThreads };
}

function readIntegerLiteral(value: string): number | undefined {
  const match = /^(\d+)(?:\s+#.*)?$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  return Number.parseInt(match[1]!, 10);
}

function readInlineTableMaxThreads(value: string): number | undefined {
  const match = /\bmax_threads\s*=\s*(\d+)/.exec(value);
  if (!match) {
    return undefined;
  }
  return Number.parseInt(match[1]!, 10);
}

function escapeTomlBasicString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    await access(path);
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}
