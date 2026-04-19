import { execFile } from "node:child_process";
import { appendFile, link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { parseJson, toPrettyJson } from "../utils/json.js";

const execFileAsync = promisify(execFile);
type LockOwner = {
  pid: number;
  acquiredAt: string;
  processIdentity?: string;
};
type LockOwnerState =
  | { state: "valid"; owner: LockOwner }
  | { state: "missing" }
  | { state: "malformed" }
  | { state: "unreadable" };

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
  const acquiredOwner: LockOwner = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    ...(currentProcessIdentity ? { processIdentity: currentProcessIdentity } : {})
  };

  await ensureDir(dirname(lockPath));
  while (true) {
    if (await claimPathLock(lockPath, acquiredOwner)) {
      break;
    }
    if (await reapStaleLock(lockPath, ownerPath)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out acquiring file lock ${lockPath}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }

  try {
    return await action();
  } finally {
    await releaseOwnedLock(lockPath, ownerPath, acquiredOwner);
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
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  );
}

async function reapStaleLock(lockPath: string, ownerPath: string): Promise<boolean> {
  const ownerState = await readLockOwner(ownerPath);
  if (ownerState.state === "missing" || ownerState.state === "malformed") {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }
  if (ownerState.state === "unreadable") {
    return false;
  }

  const lockHolderState = await classifyLockHolder(ownerState.owner);
  if (lockHolderState !== "stale") {
    return false;
  }

  await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

async function readLockOwner(
  ownerPath: string
): Promise<LockOwnerState> {
  let raw: string;
  try {
    raw = await readFile(ownerPath, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return { state: "missing" };
    }
    return { state: "unreadable" };
  }
  try {
    const owner = parseJson<LockOwner>(raw, `lock owner ${ownerPath}`);
    return typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0
      ? {
          state: "valid",
          owner: {
            pid: owner.pid,
            acquiredAt: typeof owner.acquiredAt === "string" ? owner.acquiredAt : "",
            ...(typeof owner.processIdentity === "string" && owner.processIdentity.length > 0
              ? { processIdentity: owner.processIdentity }
              : {})
          }
        }
      : { state: "malformed" };
  } catch {
    return { state: "malformed" };
  }
}

async function claimPathLock(lockPath: string, owner: LockOwner): Promise<boolean> {
  const tempLockPath = `${lockPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const tempOwnerPath = join(tempLockPath, "owner.json");
  try {
    await mkdir(tempLockPath);
    await writeFile(tempOwnerPath, JSON.stringify(owner), "utf8");
    await rename(tempLockPath, lockPath);
    return true;
  } catch (error) {
    await rm(tempLockPath, { recursive: true, force: true }).catch(() => undefined);
    if (isAlreadyExists(error)) {
      return false;
    }
    throw error;
  }
}

async function releaseOwnedLock(
  lockPath: string,
  ownerPath: string,
  expectedOwner: LockOwner
): Promise<void> {
  const currentOwner = await readLockOwner(ownerPath);
  if (currentOwner.state === "unreadable") {
    return;
  }
  if (currentOwner.state !== "valid") {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  if (!matchesLockOwner(currentOwner.owner, expectedOwner)) {
    return;
  }
  await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
}

function matchesLockOwner(actual: LockOwner, expected: LockOwner): boolean {
  return actual.pid === expected.pid &&
    actual.acquiredAt === expected.acquiredAt &&
    actual.processIdentity === expected.processIdentity;
}

async function classifyLockHolder(owner: LockOwner): Promise<"live" | "stale" | "unverified"> {
  const processIdentity = await readProcessIdentity(owner.pid);
  if (!processIdentity) {
    return "unverified";
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
