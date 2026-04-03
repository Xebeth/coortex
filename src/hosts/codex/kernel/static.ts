import { dirname } from "node:path";
import { writeFile } from "node:fs/promises";

import type { CodexKernelDefinition } from "./types.js";
import { ensureDir } from "../../../persistence/files.js";

export function buildCodexKernel(): CodexKernelDefinition {
  return {
    title: "Coortex Codex Kernel",
    body: [
      "# Coortex Codex Kernel",
      "",
      "Consult Coortex runtime state before acting.",
      "Stay within the runtime-provided write scope.",
      "Use the recovery brief when resuming interrupted work.",
      "Keep outputs structured, concise, and durable."
    ].join("\n")
  };
}

export async function writeCodexKernel(path: string): Promise<CodexKernelDefinition> {
  const kernel = buildCodexKernel();
  await ensureDir(dirname(path));
  await writeFile(path, `${kernel.body}\n`, "utf8");
  return kernel;
}
