import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, toPrettyJson(value));
}

export async function writeTextAtomic(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
}

export async function appendLine(path: string, line: string): Promise<void> {
  await ensureDir(dirname(path));
  await appendFile(path, `${line}\n`, "utf8");
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
