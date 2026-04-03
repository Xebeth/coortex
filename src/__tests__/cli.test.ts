import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
