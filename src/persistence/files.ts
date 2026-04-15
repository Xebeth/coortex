import { appendFile, link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { parseJson, toPrettyJson } from "../utils/json.js";

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
    staleMs?: number;
    timeoutMs?: number;
  }
): Promise<T> {
  const retryMs = options?.retryMs ?? 10;
  const staleMs = options?.staleMs ?? 30_000;
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + timeoutMs;

  await ensureDir(dirname(lockPath));
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      if (await isStaleLock(lockPath, staleMs)) {
        await rm(lockPath, { recursive: true, force: true });
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

async function isStaleLock(path: string, staleMs: number): Promise<boolean> {
  try {
    const lockStats = await stat(path);
    return Date.now() - lockStats.mtimeMs > staleMs;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}
