import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
