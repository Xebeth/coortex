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

export interface CodexResumeInput {
  cwd: string;
  sessionId: string;
  prompt?: string;
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
  startResume?(input: CodexResumeInput): Promise<RunningExec>;
  runResume?(input: CodexResumeInput): Promise<CodexExecResult>;
}

export interface CodexCommandRunnerOptions {
  dangerouslyBypassApprovalsAndSandbox?: boolean;
}

interface JsonlCommandOptions {
  cwd: string;
  args: string[];
  outputPath: string;
  timeoutLabel: "exec" | "resume";
  fixturePath?: string;
  initialHostRunId?: string;
  captureHostRunId?: (event: Record<string, unknown>) => string | undefined;
  onEvent?: (event: Record<string, unknown>) => Promise<void> | void;
}

export class DefaultCodexCommandRunner implements CodexCommandRunner {
  constructor(private readonly options: CodexCommandRunnerOptions = {}) {}

  async startExec(input: CodexExecInput): Promise<RunningExec> {
    const options: JsonlCommandOptions = {
      cwd: input.cwd,
      args: [
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
      ],
      outputPath: input.outputPath,
      timeoutLabel: "exec",
      captureHostRunId: readStartedThreadId,
      ...(input.onEvent ? { onEvent: input.onEvent } : {})
    };
    const fixturePath = process.env.COORTEX_CODEX_EXEC_FIXTURE;
    if (fixturePath) {
      options.fixturePath = fixturePath;
    }
    return this.startJsonlCommand(options);
  }

  async runExec(input: CodexExecInput): Promise<CodexExecResult> {
    return (await this.startExec(input)).result;
  }

  async startResume(input: CodexResumeInput): Promise<RunningExec> {
    const options: JsonlCommandOptions = {
      cwd: input.cwd,
      args: [
        "exec",
        "resume",
        "--json",
        input.sessionId,
        ...(this.shouldDangerouslyBypass(input)
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : ["--sandbox", "workspace-write"]),
        "-o",
        input.outputPath,
        ...(input.prompt && input.prompt.length > 0 ? [input.prompt] : [])
      ],
      outputPath: input.outputPath,
      timeoutLabel: "resume",
      initialHostRunId: input.sessionId,
      captureHostRunId: readThreadEventId,
      ...(input.onEvent ? { onEvent: input.onEvent } : {})
    };
    const fixturePath = process.env.COORTEX_CODEX_RESUME_FIXTURE;
    if (fixturePath) {
      options.fixturePath = fixturePath;
    }
    return this.startJsonlCommand(options);
  }

  async runResume(input: CodexResumeInput): Promise<CodexExecResult> {
    return (await this.startResume(input)).result;
  }

  describeExecutionMode(): string {
    return this.options.dangerouslyBypassApprovalsAndSandbox === true
      ? "dangerously bypass approvals and sandbox"
      : "sandbox workspace-write";
  }

  private shouldDangerouslyBypass(
    input: Pick<CodexExecInput, "dangerouslyBypassApprovalsAndSandbox">
      | Pick<CodexResumeInput, "dangerouslyBypassApprovalsAndSandbox">
  ): boolean {
    return (
      input.dangerouslyBypassApprovalsAndSandbox ??
      this.options.dangerouslyBypassApprovalsAndSandbox ??
      false
    );
  }

  private async startJsonlCommand(options: JsonlCommandOptions): Promise<RunningExec> {
    if (options.fixturePath) {
      const fixtureOptions: Parameters<typeof startFixture>[1] = {
        outputPath: options.outputPath
      };
      if (options.initialHostRunId) {
        fixtureOptions.initialHostRunId = options.initialHostRunId;
      }
      if (options.captureHostRunId) {
        fixtureOptions.captureHostRunId = options.captureHostRunId;
      }
      if (options.onEvent) {
        fixtureOptions.onEvent = options.onEvent;
      }
      return startFixture(options.fixturePath, fixtureOptions);
    }

    await mkdir(dirname(options.outputPath), { recursive: true });

    const child = spawn("codex", options.args, {
      cwd: options.cwd,
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
      ...(options.initialHostRunId ? { hostRunId: options.initialHostRunId } : {}),
      ...(typeof child.pid === "number" ? { pid: child.pid } : {}),
      result: new Promise<CodexExecResult>((resolve, reject) => {
        const handleEvent = async (event: Record<string, unknown>) => {
          const hostRunId = options.captureHostRunId?.(event);
          if (hostRunId) {
            running.hostRunId = hostRunId;
          }
          await options.onEvent?.(event);
        };

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          stdoutBuffer += chunk;
          eventDrain = eventDrain.then(async () => {
            stdoutBuffer = await emitJsonEvents(stdoutBuffer, handleEvent);
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
              stdoutBuffer = await emitFinalJsonEvent(stdoutBuffer, handleEvent);
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
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error(
                `Timed out waiting for codex ${options.timeoutLabel} ${child.pid ?? "unknown"} to exit.`
              )
            );
          }, timeoutMs);
        });
        try {
          await Promise.race([running.result.then(() => undefined), timeoutPromise]);
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
        await assertTreeGone(child.pid, timeoutMs);
        return { code: exitCode };
      }
    };

    return running;
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
  options: {
    outputPath?: string;
    initialHostRunId?: string;
    captureHostRunId?: (event: Record<string, unknown>) => string | undefined;
    onEvent?: (event: Record<string, unknown>) => Promise<void> | void;
  }
): Promise<RunningExec> {
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as FixturePayload;
  let running!: RunningExec;
  const result = Promise.resolve().then(async () => {
    const handleEvent = async (event: Record<string, unknown>) => {
      const hostRunId = options.captureHostRunId?.(event);
      if (hostRunId) {
        running.hostRunId = hostRunId;
      }
      await options.onEvent?.(event);
    };
    for (const line of raw.stdoutLines ?? []) {
      if (line && typeof line === "object" && !Array.isArray(line)) {
        await handleEvent(line as Record<string, unknown>);
      }
    }
    if (raw.lastMessage !== undefined && options.outputPath) {
      await mkdir(dirname(options.outputPath), { recursive: true });
      await writeFile(options.outputPath, JSON.stringify(raw.lastMessage, null, 2), "utf8");
    }
    return {
      exitCode: raw.exitCode ?? 0,
      stdout: `${(raw.stdoutLines ?? []).map((line) => JSON.stringify(line)).join("\n")}${
        (raw.stdoutLines ?? []).length > 0 ? "\n" : ""
      }`,
      stderr: raw.stderr ?? ""
    };
  });
  running = {
    ...(options.initialHostRunId ? { hostRunId: options.initialHostRunId } : {}),
    result,
    terminate: async () => undefined,
    waitForExit: async () => {
      const result = await running.result;
      return { code: result.exitCode };
    }
  };
  return running;
}

function readStartedThreadId(event: Record<string, unknown>): string | undefined {
  return event.type === "thread.started" ? readThreadEventId(event) : undefined;
}

function readThreadEventId(event: Record<string, unknown>): string | undefined {
  return typeof event.thread_id === "string" && event.thread_id.length > 0
    ? event.thread_id
    : undefined;
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
