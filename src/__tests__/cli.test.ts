import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("ctx init, status, resume, and doctor work against persisted runtime state", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  const init = await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });
  assert.match(init.stdout, /Initialized Coortex runtime/);

  const status = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  assert.match(status.stdout, /Active assignments: 1/);

  const resume = await execFileAsync(process.execPath, [cliPath, "resume"], {
    cwd: projectRoot
  });
  assert.match(resume.stdout, /Recovery brief generated/);

  const doctor = await execFileAsync(process.execPath, [cliPath, "doctor"], {
    cwd: projectRoot
  });
  assert.match(doctor.stdout, /OK codex-profile/);

  const codexConfig = await readFile(join(projectRoot, ".codex", "config.toml"), "utf8");
  assert.match(codexConfig, /model_instructions_file = "/);

  const envelope = await readFile(
    join(projectRoot, ".coortex", "runtime", "last-resume-envelope.json"),
    "utf8"
  );
  assert.match(envelope, /"adapter": "codex"/);
});

test("ctx status and resume recover from snapshot when the event log is missing", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-snapshot-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  await rm(join(projectRoot, ".coortex", "runtime", "events.ndjson"));

  const status = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot
  });
  assert.match(status.stdout, /Active assignments: 1/);
  assert.doesNotMatch(status.stdout, /No active objective/);

  const resume = await execFileAsync(process.execPath, [cliPath, "resume"], {
    cwd: projectRoot
  });
  assert.match(resume.stdout, /Recovery brief generated/);
});

test("ctx init reports codex config conflicts by path without echoing file contents", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-conflict-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const codexDir = join(projectRoot, ".codex");
  const configPath = join(codexDir, "config.toml");

  await mkdir(codexDir, { recursive: true });
  await writeFile(configPath, 'model_instructions_file = "user-value"\n', "utf8");

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "init"], {
      cwd: projectRoot
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(error.message, /user-value/);
      return true;
    }
  );
});

test("ctx init replaces an existing Coortex-managed block while preserving surrounding TOML", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-managed-replace-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const codexDir = join(projectRoot, ".codex");
  const configPath = join(codexDir, "config.toml");

  await mkdir(codexDir, { recursive: true });
  await writeFile(
    configPath,
    [
      'model = "gpt-5"',
      "",
      "# BEGIN COORTEX CODEX PROFILE",
      "# Coortex Codex reference adapter",
      'model_instructions_file = "/tmp/old-kernel.md"',
      "# END COORTEX CODEX PROFILE",
      "",
      "[tui]",
      'status = "enabled"'
    ].join("\n"),
    "utf8"
  );

  const init = await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });
  assert.match(init.stdout, /Initialized Coortex runtime/);

  const codexConfig = await readFile(configPath, "utf8");
  assert.match(codexConfig, /^model = "gpt-5"$/m);
  assert.match(codexConfig, /^\[tui\]$/m);
  assert.match(codexConfig, /^status = "enabled"$/m);
  assert.match(
    codexConfig,
    /model_instructions_file = ".*\.coortex\/adapters\/codex\/kernel\.md"/
  );
  assert.doesNotMatch(codexConfig, /old-kernel\.md/);
  assert.equal((codexConfig.match(/# BEGIN COORTEX CODEX PROFILE/g) ?? []).length, 1);
  assert.equal((codexConfig.match(/# END COORTEX CODEX PROFILE/g) ?? []).length, 1);
});
