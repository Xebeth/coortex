import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("ctx init, status, resume, run, inspect, and doctor work against persisted runtime state", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const fixturePath = join(projectRoot, "codex-exec-fixture.json");

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        exitCode: 0,
        stdoutLines: [
          { type: "thread.started", thread_id: "thread-cli-1" },
          {
            type: "turn.completed",
            usage: {
              input_tokens: 44,
              cached_input_tokens: 10,
              output_tokens: 12
            }
          }
        ],
        lastMessage: {
          outcomeType: "result",
          resultStatus: "completed",
          resultSummary: "Completed the Milestone 2 execution slice.",
          changedFiles: ["src/cli/ctx.ts"],
          blockerSummary: "",
          decisionOptions: [],
          recommendedOption: ""
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const env = {
    ...process.env,
    COORTEX_CODEX_EXEC_FIXTURE: fixturePath
  };

  const init = await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot,
    env
  });
  assert.match(init.stdout, /Initialized Coortex runtime/);

  const status = await execFileAsync(process.execPath, [cliPath, "status"], {
    cwd: projectRoot,
    env
  });
  assert.match(status.stdout, /Active assignments: 1/);
  assert.match(status.stdout, /Results: 0/);

  const resume = await execFileAsync(process.execPath, [cliPath, "resume"], {
    cwd: projectRoot,
    env
  });
  assert.match(resume.stdout, /Recovery brief generated/);

  const run = await execFileAsync(process.execPath, [cliPath, "run"], {
    cwd: projectRoot,
    env
  });
  assert.match(run.stdout, /Executed assignment/);
  assert.match(run.stdout, /Host run: thread-cli-1/);
  assert.match(run.stdout, /Result \(completed\): Completed the Milestone 2 execution slice\./);

  const inspect = await execFileAsync(process.execPath, [cliPath, "inspect"], {
    cwd: projectRoot,
    env
  });
  assert.match(inspect.stdout, /"hostRunId": "thread-cli-1"/);
  assert.match(inspect.stdout, /"outcomeKind": "result"/);

  const doctor = await execFileAsync(process.execPath, [cliPath, "doctor"], {
    cwd: projectRoot,
    env
  });
  assert.match(doctor.stdout, /OK codex-profile/);
  assert.match(doctor.stdout, /OK codex-exec-schema/);

  const codexConfig = await readFile(join(projectRoot, ".codex", "config.toml"), "utf8");
  assert.match(codexConfig, /model_instructions_file = "/);

  const envelope = await readFile(
    join(projectRoot, ".coortex", "runtime", "last-resume-envelope.json"),
    "utf8"
  );
  assert.match(envelope, /"adapter": "codex"/);

  const snapshot = JSON.parse(
    await readFile(join(projectRoot, ".coortex", "runtime", "snapshot.json"), "utf8")
  ) as {
    results: Array<{ status: string; summary: string }>;
    status: { activeAssignmentIds: string[] };
  };
  assert.equal(snapshot.results.length, 1);
  assert.equal(snapshot.results[0]?.status, "completed");
  assert.equal(snapshot.status.activeAssignmentIds.length, 0);

  const telemetry = await readFile(join(projectRoot, ".coortex", "runtime", "telemetry.ndjson"), "utf8");
  assert.match(telemetry, /"eventType":"host.run.started"/);
  assert.match(telemetry, /"eventType":"host.run.completed"/);
  assert.match(telemetry, /"inputTokens":44/);
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

test("ctx run refuses to rerun a blocked assignment with an unresolved decision", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-decision-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const fixturePath = join(projectRoot, "codex-decision-fixture.json");

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        exitCode: 0,
        stdoutLines: [{ type: "thread.started", thread_id: "thread-decision-1" }],
        lastMessage: {
          outcomeType: "decision",
          resultStatus: "",
          resultSummary: "",
          changedFiles: [],
          blockerSummary: "Need operator guidance before proceeding.",
          decisionOptions: [
            { id: "wait", label: "Wait", summary: "Pause until guidance arrives." },
            { id: "skip", label: "Skip", summary: "Skip the blocked work." }
          ],
          recommendedOption: "wait"
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const env = {
    ...process.env,
    COORTEX_CODEX_EXEC_FIXTURE: fixturePath
  };

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot,
    env
  });

  const firstRun = await execFileAsync(process.execPath, [cliPath, "run"], {
    cwd: projectRoot,
    env
  });
  assert.match(firstRun.stdout, /Decision: Need operator guidance before proceeding\./);

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "run"], {
      cwd: projectRoot,
      env
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /is blocked and cannot be run/);
      return true;
    }
  );

  const snapshot = JSON.parse(
    await readFile(join(projectRoot, ".coortex", "runtime", "snapshot.json"), "utf8")
  ) as {
    decisions: Array<{ blockerSummary: string }>;
  };
  assert.equal(snapshot.decisions.length, 1);
});

const liveCodexSmoke = process.env.COORTEX_LIVE_CODEX_SMOKE === "1" ? test : test.skip;

liveCodexSmoke("ctx run completes a live Codex smoke path", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-cli-live-"));
  const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
  const gitignorePath = join(projectRoot, ".gitignore");

  await writeFile(gitignorePath, ".coortex/\n.codex/\n", "utf8");
  await execFileAsync("git", ["init", "-b", "main"], {
    cwd: projectRoot
  });

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: projectRoot
  });

  const run = await execFileAsync(process.execPath, [cliPath, "run"], {
    cwd: projectRoot
  });
  assert.match(run.stdout, /Executed assignment/);

  const inspect = await execFileAsync(process.execPath, [cliPath, "inspect"], {
    cwd: projectRoot
  });
  assert.match(inspect.stdout, /"state": "completed"/);
});
