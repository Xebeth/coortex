import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { DefaultCodexCommandRunner } from "../hosts/codex/adapter/cli.js";

test("default codex runner flushes a final non-newline JSONL event on close", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coortex-codex-runner-"));
  const binDir = join(workspace, "bin");
  const outputPath = join(workspace, "out", "last-message.json");
  const eventLogPath = join(workspace, "event-log.txt");
  await mkdir(binDir, { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });

  await writeCodexFixture(binDir, [
      "const fs = require('fs');",
      "const args = process.argv.slice(2);",
      "const outIndex = args.indexOf('-o');",
      "if (outIndex >= 0) {",
      "  fs.mkdirSync(require('path').dirname(args[outIndex + 1]), { recursive: true });",
      "  fs.writeFileSync(args[outIndex + 1], JSON.stringify({ok:true}), 'utf8');",
      "}",
      "process.stdout.write('{\"type\":\"thread.started\",\"thread_id\":\"thread-no-newline\"}');"
    ]);

  const runner = new DefaultCodexCommandRunner();
  const originalPath = process.env.PATH;
  process.env.PATH = prependFixturePath(binDir, originalPath);
  try {
    const events: Array<Record<string, unknown>> = [];
    const result = await runner.runExec({
      cwd: workspace,
      prompt: "test",
      outputSchemaPath: join(workspace, "schema.json"),
      outputPath,
      onEvent: async (event) => {
        events.push(event);
        await writeFile(eventLogPath, JSON.stringify(events), "utf8");
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      type: "thread.started",
      thread_id: "thread-no-newline"
    });
  } finally {
    process.env.PATH = originalPath;
  }
});

test("default codex runner exposes lifecycle control for a running exec", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coortex-codex-runner-live-"));
  const binDir = join(workspace, "bin");
  const outputPath = join(workspace, "out", "last-message.json");
  await mkdir(binDir, { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });

  await writeCodexFixture(binDir, [
      "const fs = require('fs');",
      "const path = require('path');",
      "const args = process.argv.slice(2);",
      "const outIndex = args.indexOf('-o');",
      "if (outIndex >= 0) {",
      "  fs.mkdirSync(path.dirname(args[outIndex + 1]), { recursive: true });",
      "  fs.writeFileSync(args[outIndex + 1], JSON.stringify({ ok: true }), 'utf8');",
      "}",
      "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-running' }) + '\\n');",
      "setInterval(() => {}, 1000);"
    ]);

  const runner = new DefaultCodexCommandRunner();
  const originalPath = process.env.PATH;
  process.env.PATH = prependFixturePath(binDir, originalPath);
  try {
    const running = await runner.startExec({
      cwd: workspace,
      prompt: "test",
      outputSchemaPath: join(workspace, "schema.json"),
      outputPath
    });

    assert.ok(typeof running.pid === "number");
    await waitFor(() => running.hostRunId === "thread-running", 2_000);
    await running.terminate("graceful");
    const exit = await running.waitForExit(5_000);
    const result = await running.result;

    assert.notEqual(exit.code, 0);
    assert.notEqual(result.exitCode, 0);
    assert.equal(running.hostRunId, "thread-running");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("default codex runner clears the wait timeout after exit", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coortex-codex-runner-wait-timeout-"));
  const binDir = join(workspace, "bin");
  const outputPath = join(workspace, "out", "last-message.json");
  await mkdir(binDir, { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });

  await writeCodexFixture(binDir, [
    "const fs = require('fs');",
    "const path = require('path');",
    "const args = process.argv.slice(2);",
    "const outIndex = args.indexOf('-o');",
    "if (outIndex >= 0) {",
    "  fs.mkdirSync(path.dirname(args[outIndex + 1]), { recursive: true });",
    "  fs.writeFileSync(args[outIndex + 1], JSON.stringify({ ok: true }), 'utf8');",
    "}",
    "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-timeout-clear' }) + '\\n');",
    "process.exit(0);"
  ]);

  const runner = new DefaultCodexCommandRunner();
  const originalPath = process.env.PATH;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Set<object>();
  process.env.PATH = prependFixturePath(binDir, originalPath);
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => {
    const handle = originalSetTimeout(callback as (...args: unknown[]) => void, delay, ...args);
    timers.add(handle as object);
    return handle;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
    if (handle) {
      timers.delete(handle as object);
    }
    return originalClearTimeout(handle);
  }) as typeof globalThis.clearTimeout;
  try {
    const running = await runner.startExec({
      cwd: workspace,
      prompt: "test",
      outputSchemaPath: join(workspace, "schema.json"),
      outputPath
    });

    const exit = await running.waitForExit(5_000);

    assert.equal(exit.code, 0);
    assert.equal(timers.size, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    process.env.PATH = originalPath;
  }
});

test("default codex runner uses workspace-write sandbox by default", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coortex-codex-runner-args-default-"));
  const binDir = join(workspace, "bin");
  const outputPath = join(workspace, "out", "last-message.json");
  const argsPath = join(workspace, "args.json");
  await mkdir(binDir, { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });

  await writeCodexFixture(binDir, [
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)), 'utf8');`,
      "process.exit(0);"
    ]);

  const runner = new DefaultCodexCommandRunner();
  const originalPath = process.env.PATH;
  process.env.PATH = prependFixturePath(binDir, originalPath);
  try {
    await runner.runExec({
      cwd: workspace,
      prompt: "test",
      outputSchemaPath: join(workspace, "schema.json"),
      outputPath
    });

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    assert.ok(args.includes("--sandbox"));
    assert.ok(args.includes("workspace-write"));
    assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  } finally {
    process.env.PATH = originalPath;
  }
});

test("default codex runner uses dangerous bypass when enabled", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coortex-codex-runner-args-danger-"));
  const binDir = join(workspace, "bin");
  const outputPath = join(workspace, "out", "last-message.json");
  const argsPath = join(workspace, "args.json");
  await mkdir(binDir, { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });

  await writeCodexFixture(binDir, [
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)), 'utf8');`,
      "process.exit(0);"
    ]);

  const runner = new DefaultCodexCommandRunner({
    dangerouslyBypassApprovalsAndSandbox: true
  });
  const originalPath = process.env.PATH;
  process.env.PATH = prependFixturePath(binDir, originalPath);
  try {
    await runner.runExec({
      cwd: workspace,
      prompt: "test",
      outputSchemaPath: join(workspace, "schema.json"),
      outputPath
    });

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(!args.includes("--sandbox"));
    assert.ok(!args.includes("workspace-write"));
  } finally {
    process.env.PATH = originalPath;
  }
});

test("default codex runner uses exec resume with structured last-message output by default", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coortex-codex-runner-resume-default-"));
  const binDir = join(workspace, "bin");
  const outputPath = join(workspace, "out", "resume-last-message.json");
  const argsPath = join(workspace, "args.json");
  await mkdir(binDir, { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });

  await writeCodexFixture(binDir, [
    "const fs = require('fs');",
    "const path = require('path');",
    "const args = process.argv.slice(2);",
    `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args), 'utf8');`,
    "const outIndex = args.indexOf('-o');",
    "if (outIndex >= 0) {",
    "  fs.mkdirSync(path.dirname(args[outIndex + 1]), { recursive: true });",
    "  fs.writeFileSync(args[outIndex + 1], JSON.stringify({ ok: true }), 'utf8');",
    "}",
    "process.exit(0);"
  ]);

  const runner = new DefaultCodexCommandRunner();
  const originalPath = process.env.PATH;
  process.env.PATH = prependFixturePath(binDir, originalPath);
  try {
    await runner.runResume({
      cwd: workspace,
      sessionId: "thread-resume-default",
      prompt: "resume prompt",
      outputPath
    });

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    assert.deepEqual(args.slice(0, 4), ["exec", "resume", "--json", "thread-resume-default"]);
    assert.ok(args.includes("--full-auto"));
    assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(args.includes("-o"));
    assert.ok(args.includes(outputPath));
    assert.equal(args.at(-1), "resume prompt");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("default codex runner uses dangerous bypass for exec resume when enabled", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coortex-codex-runner-resume-danger-"));
  const binDir = join(workspace, "bin");
  const outputPath = join(workspace, "out", "resume-last-message.json");
  const argsPath = join(workspace, "args.json");
  await mkdir(binDir, { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });

  await writeCodexFixture(binDir, [
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)), 'utf8');`,
    "process.exit(0);"
  ]);

  const runner = new DefaultCodexCommandRunner({
    dangerouslyBypassApprovalsAndSandbox: true
  });
  const originalPath = process.env.PATH;
  process.env.PATH = prependFixturePath(binDir, originalPath);
  try {
    await runner.runResume({
      cwd: workspace,
      sessionId: "thread-resume-danger",
      outputPath
    });

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    assert.deepEqual(args.slice(0, 4), ["exec", "resume", "--json", "thread-resume-danger"]);
    assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(!args.includes("--full-auto"));
  } finally {
    process.env.PATH = originalPath;
  }
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error("Timed out waiting for runner state.");
}

function codexFixtureName(): string {
  return process.platform === "win32" ? "codex.cmd" : "codex";
}

async function writeCodexFixture(binDir: string, lines: string[]): Promise<void> {
  const codexScript = join(binDir, codexFixtureName());
  if (process.platform === "win32") {
    await writeFile(codexScript, ["@echo off", "node \"%~dp0\\fixture.js\" %*"].join("\r\n"), "utf8");
    await writeFile(join(binDir, "fixture.js"), lines.join("\n"), "utf8");
    return;
  }
  await writeFile(codexScript, ["#!/usr/bin/env node", ...lines].join("\n"), "utf8");
  await chmod(codexScript, 0o755);
}

function prependFixturePath(dir: string, originalPath: string | undefined): string {
  return [dir, originalPath].filter((value): value is string => typeof value === "string").join(delimiter);
}
