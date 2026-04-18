import { execFile } from "node:child_process";
import { appendFile, link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { parseJson, toPrettyJson } from "../utils/json.js";

const execFileAsync = promisify(execFile);
const UNVERIFIED_LOCK_GRACE_MS = 250;

type LockOwner = {
  pid: number;
  acquiredAt: string;
  processIdentity?: string;
};

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readJsonFile<T>(path: string, label: string): Promise<T | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return parseJson<T>(content, label);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, toPrettyJson(value));
}

export async function writeTextAtomic(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
}

export async function writeTextExclusive(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(tempPath, content, "utf8");
    await link(tempPath, path);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function withPathLock<T>(
  path: string,
  action: () => Promise<T>,
  options?: {
    retryMs?: number;
    timeoutMs?: number;
  }
): Promise<T> {
  const retryMs = options?.retryMs ?? 10;
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const lockPath = `${path}.lock`;
  const ownerPath = join(lockPath, "owner.json");
  const deadline = Date.now() + timeoutMs;
  const currentProcessIdentity = await readProcessIdentity(process.pid);

  await ensureDir(dirname(lockPath));
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(
        ownerPath,
        JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          ...(currentProcessIdentity ? { processIdentity: currentProcessIdentity } : {})
        }),
        "utf8"
      );
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      if (await reapStaleLock(lockPath, ownerPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring file lock ${lockPath}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }

  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function appendText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await appendFile(path, content, "utf8");
}

export async function appendLine(path: string, line: string): Promise<void> {
  await appendText(path, `${line}\n`);
}

export async function readLines(path: string): Promise<string[]> {
  try {
    const content = await readFile(path, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
}

async function reapStaleLock(lockPath: string, ownerPath: string): Promise<boolean> {
  const owner = await readLockOwner(ownerPath);
  if (owner) {
    const lockHolderState = await classifyLockHolder(owner);
    if (lockHolderState === "live") {
      return false;
    }
    if (lockHolderState === "stale") {
      await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
      return true;
    }
  }

  return reapUnverifiedLock(lockPath);
}

async function reapUnverifiedLock(lockPath: string): Promise<boolean> {
  const metadata = await stat(lockPath).catch((error) => {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  });
  if (!metadata) {
    return true;
  }
  if (Date.now() - metadata.mtimeMs < UNVERIFIED_LOCK_GRACE_MS) {
    return false;
  }
  await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

async function readLockOwner(
  ownerPath: string
): Promise<LockOwner | undefined> {
  try {
    const raw = await readFile(ownerPath, "utf8");
    const owner = parseJson<LockOwner>(raw, `lock owner ${ownerPath}`);
    return typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0
      ? {
          pid: owner.pid,
          acquiredAt: typeof owner.acquiredAt === "string" ? owner.acquiredAt : "",
          ...(typeof owner.processIdentity === "string" && owner.processIdentity.length > 0
            ? { processIdentity: owner.processIdentity }
            : {})
        }
      : undefined;
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    return undefined;
  }
}

async function classifyLockHolder(owner: LockOwner): Promise<"live" | "stale" | "unverified"> {
  const processIdentity = await readProcessIdentity(owner.pid);
  if (!processIdentity) {
    return "stale";
  }
  if (!owner.processIdentity) {
    return "unverified";
  }
  return processIdentity === owner.processIdentity ? "live" : "stale";
}

async function readProcessIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    const linuxIdentity = await readLinuxProcessIdentity(pid);
    if (linuxIdentity) {
      return linuxIdentity;
    }
  }
  return readPsProcessIdentity(pid);
}

async function readLinuxProcessIdentity(pid: number): Promise<string | undefined> {
  try {
    const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
    const startTimeTicks = parseLinuxProcessStartTime(statLine);
    return startTimeTicks ? `linux:${pid}:${startTimeTicks}` : undefined;
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    return undefined;
  }
}

function parseLinuxProcessStartTime(statLine: string): string | undefined {
  const commandEnd = statLine.lastIndexOf(")");
  if (commandEnd === -1) {
    return undefined;
  }
  const fields = statLine
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  return fields[19];
}

async function readPsProcessIdentity(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const startedAt = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    return startedAt ? `ps:${pid}:${startedAt}` : undefined;
  } catch {
    return undefined;
  }
}
