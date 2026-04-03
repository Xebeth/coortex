import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface CodexExecInput {
  cwd: string;
  prompt: string;
  outputSchemaPath: string;
  outputPath: string;
  onEvent?: (event: Record<string, unknown>) => Promise<void> | void;
}

export interface CodexExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CodexCommandRunner {
  runExec(input: CodexExecInput): Promise<CodexExecResult>;
}

export class DefaultCodexCommandRunner implements CodexCommandRunner {
  async runExec(input: CodexExecInput): Promise<CodexExecResult> {
    const fixturePath = process.env.COORTEX_CODEX_EXEC_FIXTURE;
    if (fixturePath) {
      return runFixture(fixturePath, input.outputPath, input.onEvent);
    }

    await mkdir(dirname(input.outputPath), { recursive: true });

    return new Promise((resolve, reject) => {
      const child = spawn(
        "codex",
        [
          "exec",
          "--json",
          "--sandbox",
          "workspace-write",
          "-C",
          input.cwd,
          "--output-schema",
          input.outputSchemaPath,
          "-o",
          input.outputPath,
          input.prompt
        ],
        {
          cwd: input.cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"]
        }
      );

      let stdout = "";
      let stderr = "";
      let stdoutBuffer = "";
      let eventDrain = Promise.resolve();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        stdoutBuffer += chunk;
        eventDrain = eventDrain.then(async () => {
          stdoutBuffer = await emitJsonEvents(stdoutBuffer, input.onEvent);
        });
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        void eventDrain
          .then(async () => {
            stdoutBuffer = await emitFinalJsonEvent(stdoutBuffer, input.onEvent);
            resolve({
              exitCode: code ?? 1,
              stdout,
              stderr
            });
          })
          .catch(reject);
      });
    });
  }
}

interface FixturePayload {
  exitCode?: number;
  stdoutLines?: unknown[];
  stderr?: string;
  lastMessage?: unknown;
}

async function runFixture(
  fixturePath: string,
  outputPath: string,
  onEvent?: (event: Record<string, unknown>) => Promise<void> | void
): Promise<CodexExecResult> {
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as FixturePayload;
  for (const line of raw.stdoutLines ?? []) {
    if (line && typeof line === "object" && !Array.isArray(line)) {
      await onEvent?.(line as Record<string, unknown>);
    }
  }
  if (raw.lastMessage !== undefined) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(raw.lastMessage, null, 2), "utf8");
  }
  return {
    exitCode: raw.exitCode ?? 0,
    stdout: `${(raw.stdoutLines ?? []).map((line) => JSON.stringify(line)).join("\n")}${
      (raw.stdoutLines ?? []).length > 0 ? "\n" : ""
    }`,
    stderr: raw.stderr ?? ""
  };
}

async function emitJsonEvents(
  buffer: string,
  onEvent?: (event: Record<string, unknown>) => Promise<void> | void
): Promise<string> {
  if (!onEvent) {
    return buffer;
  }
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      await onEvent(event);
    } catch {
      continue;
    }
  }
  return remainder;
}

async function emitFinalJsonEvent(
  buffer: string,
  onEvent?: (event: Record<string, unknown>) => Promise<void> | void
): Promise<string> {
  const trimmed = buffer.trim();
  if (!onEvent || trimmed.length === 0) {
    return "";
  }
  try {
    await onEvent(JSON.parse(trimmed) as Record<string, unknown>);
  } catch {
    // ignore malformed trailing output in the same way as normal JSONL lines
  }
  return "";
}
