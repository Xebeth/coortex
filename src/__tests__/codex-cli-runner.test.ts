import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DefaultCodexCommandRunner } from "../hosts/codex/adapter/cli.js";

test("default codex runner flushes a final non-newline JSONL event on close", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coortex-codex-runner-"));
  const binDir = join(workspace, "bin");
  const outputPath = join(workspace, "out", "last-message.json");
  const eventLogPath = join(workspace, "event-log.txt");
  await mkdir(binDir, { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });

  const codexScript = join(binDir, "codex");
  await writeFile(
    codexScript,
    [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "const args = process.argv.slice(2);",
      "const outIndex = args.indexOf('-o');",
      "if (outIndex >= 0) {",
      "  fs.mkdirSync(require('path').dirname(args[outIndex + 1]), { recursive: true });",
      "  fs.writeFileSync(args[outIndex + 1], JSON.stringify({ok:true}), 'utf8');",
      "}",
      "process.stdout.write('{\"type\":\"thread.started\",\"thread_id\":\"thread-no-newline\"}');"
    ].join("\n"),
    "utf8"
  );
  await chmod(codexScript, 0o755);

  const runner = new DefaultCodexCommandRunner();
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
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

  const codexScript = join(binDir, "codex");
  await writeFile(
    codexScript,
    [
      "#!/usr/bin/env node",
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
    ].join("\n"),
    "utf8"
  );
  await chmod(codexScript, 0o755);

  const runner = new DefaultCodexCommandRunner();
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
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

test("default codex runner uses workspace-write sandbox by default", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coortex-codex-runner-args-default-"));
  const binDir = join(workspace, "bin");
  const outputPath = join(workspace, "out", "last-message.json");
  const argsPath = join(workspace, "args.json");
  await mkdir(binDir, { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });

  const codexScript = join(binDir, "codex");
  await writeFile(
    codexScript,
    [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)), 'utf8');`,
      "process.exit(0);"
    ].join("\n"),
    "utf8"
  );
  await chmod(codexScript, 0o755);

  const runner = new DefaultCodexCommandRunner();
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
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

  const codexScript = join(binDir, "codex");
  await writeFile(
    codexScript,
    [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)), 'utf8');`,
      "process.exit(0);"
    ].join("\n"),
    "utf8"
  );
  await chmod(codexScript, 0o755);

  const runner = new DefaultCodexCommandRunner({
    dangerouslyBypassApprovalsAndSandbox: true
  });
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
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
