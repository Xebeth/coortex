import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface CodexExecInput {
  cwd: string;
  prompt: string;
  outputSchemaPath: string;
  outputPath: string;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  onEvent?: (event: Record<string, unknown>) => Promise<void> | void;
}

export interface CodexExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunningExec {
  pid?: number;
  hostRunId?: string;
  result: Promise<CodexExecResult>;
  terminate(signal?: "graceful" | "force"): Promise<void>;
  waitForExit(timeoutMs?: number): Promise<{ code: number | null }>;
}

export interface CodexCommandRunner {
  startExec(input: CodexExecInput): Promise<RunningExec>;
  runExec(input: CodexExecInput): Promise<CodexExecResult>;
}

export interface CodexCommandRunnerOptions {
  dangerouslyBypassApprovalsAndSandbox?: boolean;
}

export class DefaultCodexCommandRunner implements CodexCommandRunner {
  constructor(private readonly options: CodexCommandRunnerOptions = {}) {}

  async startExec(input: CodexExecInput): Promise<RunningExec> {
    const fixturePath = process.env.COORTEX_CODEX_EXEC_FIXTURE;
    if (fixturePath) {
      return startFixture(fixturePath, input.outputPath, input.onEvent);
    }

    await mkdir(dirname(input.outputPath), { recursive: true });

    const args = [
      "exec",
      "--json",
      ...(this.shouldDangerouslyBypass(input)
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : ["--sandbox", "workspace-write"]),
      "-C",
      input.cwd,
      "--output-schema",
      input.outputSchemaPath,
      "-o",
      input.outputPath,
      input.prompt
    ];

    const child = spawn("codex", args, {
        cwd: input.cwd,
        detached: process.platform !== "win32",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let eventDrain = Promise.resolve();
    let exitCode: number | null = null;
    let exited = false;

    const running: RunningExec = {
      ...(typeof child.pid === "number" ? { pid: child.pid } : {}),
      result: new Promise<CodexExecResult>((resolve, reject) => {
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          stdoutBuffer += chunk;
          eventDrain = eventDrain.then(async () => {
            stdoutBuffer = await emitJsonEvents(stdoutBuffer, async (event) => {
              if (
                event.type === "thread.started" &&
                typeof event.thread_id === "string" &&
                event.thread_id.length > 0
              ) {
                running.hostRunId = event.thread_id;
              }
              await input.onEvent?.(event);
            });
          });
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => {
          exitCode = code ?? 1;
          exited = true;
          void eventDrain
            .then(async () => {
              stdoutBuffer = await emitFinalJsonEvent(stdoutBuffer, async (event) => {
                if (
                  event.type === "thread.started" &&
                  typeof event.thread_id === "string" &&
                  event.thread_id.length > 0
                ) {
                  running.hostRunId = event.thread_id;
                }
                await input.onEvent?.(event);
              });
              resolve({
                exitCode: exitCode ?? 1,
                stdout,
                stderr
              });
            })
            .catch(reject);
        });
      }),
      terminate: async (signal = "graceful") => {
        if (!child.pid || exited) {
          return;
        }
        if (process.platform === "win32") {
          const args = ["/PID", String(child.pid), "/T"];
          if (signal === "force") {
            args.push("/F");
          }
          try {
            await spawnAndWait("taskkill", args);
          } catch {
            if (signal === "force") {
              child.kill("SIGKILL");
            } else {
              child.kill("SIGTERM");
            }
          }
          return;
        }
        try {
          process.kill(-child.pid, signal === "force" ? "SIGKILL" : "SIGTERM");
        } catch {
          child.kill(signal === "force" ? "SIGKILL" : "SIGTERM");
        }
      },
      waitForExit: async (timeoutMs = 30_000) => {
        await Promise.race([
          running.result.then(() => undefined),
          delay(timeoutMs).then(() => {
            throw new Error(`Timed out waiting for codex exec ${child.pid ?? "unknown"} to exit.`);
          })
        ]);
        await assertTreeGone(child.pid, timeoutMs);
        return { code: exitCode };
      }
    };

    return running;
  }

  async runExec(input: CodexExecInput): Promise<CodexExecResult> {
    return (await this.startExec(input)).result;
  }

  describeExecutionMode(): string {
    return this.options.dangerouslyBypassApprovalsAndSandbox === true
      ? "dangerously bypass approvals and sandbox"
      : "sandbox workspace-write";
  }

  private shouldDangerouslyBypass(input: CodexExecInput): boolean {
    return (
      input.dangerouslyBypassApprovalsAndSandbox ??
      this.options.dangerouslyBypassApprovalsAndSandbox ??
      false
    );
  }
}

interface FixturePayload {
  exitCode?: number;
  stdoutLines?: unknown[];
  stderr?: string;
  lastMessage?: unknown;
}

async function startFixture(
  fixturePath: string,
  outputPath: string,
  onEvent?: (event: Record<string, unknown>) => Promise<void> | void
): Promise<RunningExec> {
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as FixturePayload;
  let running!: RunningExec;
  running = {
    result: (async () => {
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
    })(),
    terminate: async () => undefined,
    waitForExit: async () => {
      const result = await running.result;
      return { code: result.exitCode };
    }
  };
  return running;
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

async function spawnAndWait(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "ignore"]
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? 1}.`));
    });
  });
}

async function assertTreeGone(pid: number | undefined, timeoutMs: number): Promise<void> {
  if (!pid) {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isTreeAlive(pid))) {
      return;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for codex exec ${pid} to terminate.`);
}

async function isTreeAlive(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    return isWindowsTreeAlive(pid);
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (innerError) {
        if (isMissingProcessError(innerError)) {
          return false;
        }
        throw innerError;
      }
    }
    throw error;
  }
}

async function isWindowsTreeAlive(pid: number): Promise<boolean> {
  const command = [
    "-NoProfile",
    "-Command",
    [
      "$rootPid = [int]$args[0]",
      "$procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)",
      "$pending = [System.Collections.Generic.Queue[int]]::new()",
      "$seen = [System.Collections.Generic.HashSet[int]]::new()",
      "$pending.Enqueue($rootPid)",
      "$alive = $false",
      "while ($pending.Count -gt 0) {",
      "  $current = $pending.Dequeue()",
      "  if (-not $seen.Add($current)) { continue }",
      "  if ($procs | Where-Object { $_.ProcessId -eq $current }) { $alive = $true }",
      "  foreach ($proc in $procs) {",
      "    if ($proc.ParentProcessId -eq $current) {",
      "      $pending.Enqueue([int]$proc.ProcessId)",
      "    }",
      "  }",
      "}",
      "if ($alive) { exit 0 }",
      "exit 1"
    ].join("; "),
    String(pid)
  ];

  try {
    await spawnAndWait("powershell", command);
    return true;
  } catch {
    return false;
  }
}

function isMissingProcessError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
