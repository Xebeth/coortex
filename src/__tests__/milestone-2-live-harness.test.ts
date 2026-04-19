import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeEvent } from "../core/events.js";
import type { Assignment, RuntimeSnapshot } from "../core/types.js";
import type { TelemetryEvent } from "../telemetry/types.js";
import { RuntimeStore } from "../persistence/store.js";
import { loadOperatorProjection } from "../cli/commands.js";
import { nowIso } from "../utils/time.js";

const execFileAsync = promisify(execFile);
const liveHarness = process.env.COORTEX_LIVE_CODEX_HARNESS === "1" ? test : test.skip;
const cliPath = resolve(process.cwd(), "dist/cli/ctx.js");
const liveFixturePrefix = "coortex-live-";

interface LiveFixture {
  label: string;
  projectRoot: string;
  codexHomeRoot: string;
  env: NodeJS.ProcessEnv;
  trackedProcessPids: Set<number>;
}

interface LiveFixtureOptions {
  withInterruptScript?: boolean;
  failSetupAt?: "after-user-state" | "after-git-init";
}

interface LiveHarnessCleanupState {
  liveTmpDirs: string[];
  trackedHarnessProcessPids: number[];
}

const activeHarnessProcessPids = new Set<number>();
const liveHarnessCliTimeoutMs = 90_000;
const liveHarnessProcessCleanupTimeoutMs = 30_000;

liveHarness(
  "milestone-2 live harness: automates the manual checklist against a real Codex install",
  { timeout: 10 * 60 * 1_000 },
  async (t) => {
    const operatorCodexConfigPath = join(process.env.HOME ?? homedir(), ".codex", "config.toml");
    const operatorCodexConfigBefore = await readTextIfPresent(operatorCodexConfigPath);
    const cleanupStateBefore = await snapshotLiveHarnessCleanupState();

    const commit = String(
      (await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: process.cwd()
      })).stdout
    ).trim();
    const codexVersionResult = await execFileAsync("codex", ["--version"]);
    const codexVersion = [String(codexVersionResult.stdout), String(codexVersionResult.stderr)]
      .find((value) => value.trim().length > 0)
      ?.trim();

    t.diagnostic(`commit=${commit}`);
    t.diagnostic(`environment=${process.platform} node ${process.version}`);
    t.diagnostic(`host=${codexVersion ?? "codex --version returned no output"}`);
    t.after(async () => {
      const operatorCodexConfigAfter = await readTextIfPresent(operatorCodexConfigPath);
      const cleanupStateAfter = await snapshotLiveHarnessCleanupState();
      assert.equal(
        operatorCodexConfigAfter ?? null,
        operatorCodexConfigBefore ?? null,
        "live harness must not mutate the operator-global Codex config"
      );
      assert.deepEqual(
        diffNewLiveTmpDirs(cleanupStateBefore.liveTmpDirs, cleanupStateAfter.liveTmpDirs),
        [],
        "live harness must not leave new coortex-live-* fixture dirs under the OS temp root behind"
      );
      assert.deepEqual(
        diffNewActiveHarnessProcessPids(
          cleanupStateBefore.trackedHarnessProcessPids,
          cleanupStateAfter.trackedHarnessProcessPids
        ),
        [],
        "live harness must not leave new tracked live-harness/Codex processes or descendants behind"
      );
    });

    await t.test("fresh initialization and doctor", async (t) => {
      await withLiveFixture("init", async (fixture) => {
        const { projectRoot } = fixture;

        const init = await runCli(fixture, ["init"]);
        const doctor = await runCli(fixture, ["doctor"]);
        const store = RuntimeStore.forProject(projectRoot);
        const snapshot = await store.loadSnapshot();

        assert.match(stdout(init), /Initialized Coortex runtime/);
        assert.match(stdout(doctor), /OK config/);
        assert.match(stdout(doctor), /OK codex-kernel/);
        assert.match(stdout(doctor), /OK codex-exec-schema/);
        assert.ok(snapshot);
        await assertPathExists(join(projectRoot, ".coortex", "adapters", "codex", "kernel.md"));
        await assertPathExists(join(projectRoot, ".coortex", "adapters", "codex", "profile.json"));
        await assertPathExists(join(projectRoot, ".codex", "config.toml"));
      });
    });

    await t.test("happy path real run persists result, status, inspect, and telemetry", async (t) => {
      await withLiveFixture("happy", async (fixture) => {
        const { projectRoot } = fixture;
        await runCli(fixture, ["init"]);
        const assignmentId = await retargetActiveAssignment(fixture, {
          objective:
            "Append the exact line `Live harness happy path complete.` under the `## Harness Notes` heading in README.md. Do not change any other file.",
          writeScope: ["README.md"],
          requiredOutputs: ["README.md updated", "durable result summary"]
        });

        const run = await runCli(fixture, ["run"]);
        const status = await runCli(fixture, ["status"]);
        const inspect = await inspectRun(fixture, assignmentId);
        await delay(1_000);
        const snapshot = await readSnapshot(fixture);
        const telemetry = await readTelemetry(fixture);
        const readme = await readFile(join(projectRoot, "README.md"), "utf8");

        assert.match(stdout(run), /Executed assignment/);
        assert.match(stdout(run), /Result \(completed\):/);
        assert.match(readme, /Live harness happy path complete\./);
        assert.equal(snapshot.results.length, 1);
        assert.equal(snapshot.results[0]?.status, "completed");
        assert.deepEqual(snapshot.status.activeAssignmentIds, []);
        assert.match(stdout(status), /Active assignments: 0/);
        assert.equal(inspect?.state, "completed");
        assert.equal(inspect?.assignmentId, assignmentId);
        assertHasTelemetryEvent(telemetry, "host.run.started");
        assertHasTelemetryEvent(telemetry, "host.run.completed");
      });
    });

    await t.test("blocked decision path persists an open decision and blocked status", async (t) => {
      await withLiveFixture("blocked", async (fixture) => {
        await runCli(fixture, ["init"]);
        const assignmentId = await retargetActiveAssignment(fixture, {
          objective:
            "Update package.json to version 9.9.9. You must only change package.json, but the current write scope does not include it. Do not pick an alternative file. If you cannot proceed safely, return a decision requesting expanded scope.",
          writeScope: ["README.md"],
          requiredOutputs: ["decision if blocked"]
        });

        const run = await runCli(fixture, ["run"]);
        const status = await runCli(fixture, ["status"]);
        const inspect = await inspectRun(fixture, assignmentId);
        await delay(1_000);
        const snapshot = await readSnapshot(fixture);

        assert.match(stdout(run), /Decision:/);
        assert.equal(snapshot.decisions.length, 1);
        assert.equal(snapshot.decisions[0]?.state, "open");
        assert.equal(snapshot.assignments[0]?.state, "blocked");
        assert.match(stdout(status), /Open decisions: 1/);
        assert.match(stdout(status), new RegExp(`- ${assignmentId} blocked `));
        assert.equal(inspect?.state, "completed");
        assert.equal(inspect?.outcomeKind, "decision");
      });
    });

    await t.test("trimming boundary stays bounded and preserves the full artifact", async (t) => {
      await withLiveFixture("trim", async (fixture) => {
        const { projectRoot } = fixture;
        await runCli(fixture, ["init"]);
        const assignmentId = await retargetActiveAssignment(fixture, {
          objective:
            "Append the exact line `Live harness trimming follow-up complete.` under the `## Harness Notes` heading in README.md. Do not change any other file.",
          writeScope: ["README.md"],
          requiredOutputs: ["README.md updated", "durable result summary"]
        });
        const largeSummary = "trim-me ".repeat(600).trim();
        await appendPartialResult(fixture, assignmentId, largeSummary);

        await runCli(fixture, ["resume"]);
        const envelope = await readJsonArtifact<{
          trimApplied: boolean;
          estimatedChars: number;
          recentResults: Array<{ trimmed?: boolean; reference?: string }>;
        }>(fixture, "runtime/last-resume-envelope.json");
        const telemetry = await readTelemetry(fixture);
        const artifactPath = join(
          projectRoot,
          ".coortex",
          "artifacts",
          "results",
          `${findLatestResultId(await readSnapshot(fixture))}.txt`
        );
        const artifact = await readFile(artifactPath, "utf8");

        assert.equal(envelope.trimApplied, true);
        assert.ok(envelope.estimatedChars <= 4_000);
        assert.equal(envelope.recentResults[0]?.trimmed, true);
        assert.match(envelope.recentResults[0]?.reference ?? "", /\.coortex\/artifacts\/results\//);
        assert.equal(artifact.trim(), largeSummary);
        const resumeTelemetry = findLastByEventType(telemetry, "resume.requested");
        assert.equal(resumeTelemetry?.metadata.trimApplied, true);
        const trimmedFields = Number((resumeTelemetry?.metadata.trimmedFields as number | undefined) ?? 0);
        assert.ok(trimmedFields >= 1);
      });
    });

    await t.test("fixture setup failure cleans partial fixture state", async () => {
      const liveTmpDirsBeforeSetupFailure = await listLiveTmpDirs();
      await assert.rejects(
        createLiveFixture("setup-fail", {
          failSetupAt: "after-git-init"
        }),
        /Injected live fixture setup failure/
      );
      const liveTmpDirsAfterSetupFailure = await listLiveTmpDirs();
      assert.deepEqual(
        diffNewLiveTmpDirs(liveTmpDirsBeforeSetupFailure, liveTmpDirsAfterSetupFailure),
        [],
        "setup failure must not leak a partial fixture repo or isolated Codex home"
      );
    });

    await t.test("resume path preserves a running host handle after interruption", async (t) => {
      await withLiveFixture("resume", async (fixture) => {
        const { projectRoot } = fixture;
        await runCli(fixture, ["init"]);
        const assignmentId = await retargetActiveAssignment(fixture, {
          objective:
            "Run `node scripts/live-harness-interrupt.mjs`, confirm the README.md marker exists, then return a completed result only after the script finishes. Do not skip the script or the delay.",
          writeScope: ["README.md", "scripts/"],
          requiredOutputs: ["README.md updated", "durable result summary"]
        });

        const runProcess = spawn(process.execPath, [cliPath, "run"], {
          cwd: projectRoot,
          detached: process.platform !== "win32",
          env: fixtureEnv(fixture, {
            COORTEX_INTERRUPT_SLEEP_SECONDS: "30"
          }),
          stdio: ["ignore", "pipe", "pipe"]
        });
        const trackedRunPid = trackFixtureProcess(fixture, runProcess.pid);
        const runExitPromise = waitForExit(runProcess);
        runProcess.stdout.setEncoding("utf8");
        runProcess.stderr.setEncoding("utf8");
        let runStdout = "";
        let runStderr = "";
        runProcess.stdout.on("data", (chunk: string) => {
          runStdout += chunk;
        });
        runProcess.stderr.on("data", (chunk: string) => {
          runStderr += chunk;
        });

        try {
          const runningRecord = await waitForRunningHandle(fixture, assignmentId, 90_000);
          assert.equal(runningRecord.state, "running");
          const capturedDescendantPids = await listDescendantPids(runProcess.pid);

          await terminateChildProcessTree(runProcess, "SIGKILL");
          await terminateCapturedProcessTrees(capturedDescendantPids, "SIGKILL");
          const exit = await runExitPromise;
          await waitForCapturedProcessTreesToExit(capturedDescendantPids, 30_000);
          const inspect = await inspectRun(fixture, assignmentId);
          const status = await runCli(fixture, ["status"]);
          const resume = await runCli(fixture, ["resume"]);
          await delay(1_000);
          const snapshot = await readSnapshot(fixture);
          const telemetry = await readTelemetry(fixture);
          const completedResumeTelemetry = findLastByEventType(telemetry, "host.resume.completed");

          assert.ok(exit.signal === "SIGKILL" || exit.code === 137);
          assert.equal(snapshot.results.length, 0);
          assert.deepEqual(snapshot.status.activeAssignmentIds, [assignmentId]);
          assert.match(stdout(status), /Active assignments: 1/);
          assert.equal(inspect?.state, "running");
          assert.ok(inspect?.nativeRunId);
          if (runningRecord.nativeRunId) {
            assert.equal(inspect.nativeRunId, runningRecord.nativeRunId);
          }
          assertHasTelemetryEvent(telemetry, "host.resume.started");
          if (/Reclaimed attachment /.test(stdout(resume))) {
            assert.equal(completedResumeTelemetry?.metadata.reclaimed, true);
            assert.equal(completedResumeTelemetry?.metadata.reclaimState, "reclaimed");
            assert.doesNotMatch(stdout(resume), /Recovery brief generated/);
            assert.match(stdout(resume), new RegExp(`assignment ${assignmentId}`));
            assert.match(stdout(resume), /Host session:/);
          } else {
            const resumedEnvelope = await readJsonArtifact<{
              metadata: { activeAssignmentId?: string };
              recoveryBrief: {
                activeAssignments: Array<{ id: string; state: string }>;
                nextRequiredAction: string;
              };
            }>(fixture, "runtime/last-resume-envelope.json");
            assert.equal(completedResumeTelemetry?.metadata.reclaimed, false);
            assert.equal(completedResumeTelemetry?.metadata.reclaimState, "unverified_failed");
            assert.match(stdout(resume), /Recovery brief generated/);
            assert.equal(resumedEnvelope.metadata.activeAssignmentId, assignmentId);
            assert.equal(resumedEnvelope.recoveryBrief.activeAssignments[0]?.id, assignmentId);
            assert.equal(resumedEnvelope.recoveryBrief.activeAssignments[0]?.state, "queued");
            assert.match(resumedEnvelope.recoveryBrief.nextRequiredAction, /Start assignment/);
          }
        } finally {
          if (runProcess.exitCode === null && runProcess.signalCode === null) {
            await terminateChildProcessTree(runProcess, "SIGTERM").catch(() => undefined);
          }
          await waitForTrackedChildExit(
            runProcess,
            runExitPromise,
            liveHarnessProcessCleanupTimeoutMs,
            fixture,
            trackedRunPid
          ).catch(() => undefined);
        }
        t.diagnostic(`interrupted run stdout=${JSON.stringify(runStdout.trim())}`);
        if (runStderr.trim().length > 0) {
          t.diagnostic(`interrupted run stderr=${JSON.stringify(runStderr.trim())}`);
        }
      }, {
        withInterruptScript: true
      });
    });

    await t.test("repeatability stays structurally consistent across equivalent live runs", async (t) => {
      await withLiveFixtures(
        [
          { label: "repeat-a" },
          { label: "repeat-b" }
        ],
        async ([firstFixture, secondFixture]) => {
          const first = requireFixture(firstFixture, "repeat-a");
          const second = requireFixture(secondFixture, "repeat-b");
          await Promise.all([runCli(first, ["init"]), runCli(second, ["init"])]);
          await Promise.all([
            retargetActiveAssignment(first, {
              objective:
                "Append the exact line `Live harness repeatability complete.` under the `## Harness Notes` heading in README.md. Do not change any other file.",
              writeScope: ["README.md"],
              requiredOutputs: ["README.md updated", "durable result summary"]
            }),
            retargetActiveAssignment(second, {
              objective:
                "Append the exact line `Live harness repeatability complete.` under the `## Harness Notes` heading in README.md. Do not change any other file.",
              writeScope: ["README.md"],
              requiredOutputs: ["README.md updated", "durable result summary"]
            })
          ]);

          await Promise.all([runCli(first, ["run"]), runCli(second, ["run"])]);
          const [firstSnapshot, secondSnapshot] = await Promise.all([
            readSnapshot(first),
            readSnapshot(second)
          ]);
          const [firstTelemetry, secondTelemetry] = await Promise.all([
            readTelemetry(first),
            readTelemetry(second)
          ]);

          assert.deepEqual(
            normalizeRepeatability(firstSnapshot, firstTelemetry),
            normalizeRepeatability(secondSnapshot, secondTelemetry)
          );
        }
      );
    });

    await t.test("repeatability cleanup removes earlier fixtures if later creation fails", async () => {
      const liveTmpDirsBeforeFailure = await listLiveTmpDirs();
      await assert.rejects(
        withLiveFixtures(
          [
            { label: "repeat-clean-a" },
            {
              label: "repeat-clean-b",
              options: {
                failSetupAt: "after-git-init"
              }
            }
          ],
          async () => {
            assert.fail("fixture callback must not run after setup failure");
          }
        ),
        /Injected live fixture setup failure/
      );
      const liveTmpDirsAfterFailure = await listLiveTmpDirs();
      assert.deepEqual(
        diffNewLiveTmpDirs(liveTmpDirsBeforeFailure, liveTmpDirsAfterFailure),
        [],
        "later fixture setup failure must still clean earlier fixtures"
      );
    });

    await t.test("real-host telemetry stays honest about usage fields", async (t) => {
      await withLiveFixture("telemetry", async (fixture) => {
        await runCli(fixture, ["init"]);
        await retargetActiveAssignment(fixture, {
          objective:
            "Append the exact line `Live harness telemetry complete.` under the `## Harness Notes` heading in README.md. Do not change any other file.",
          writeScope: ["README.md"],
          requiredOutputs: ["README.md updated", "durable result summary"]
        });

        await runCli(fixture, ["run"]);
        const event = [...(await readTelemetry(fixture))]
          .reverse()
          .find((entry) => entry.eventType === "host.run.completed");

        assert.ok(event);
        if (typeof event.inputTokens === "number") {
          assert.ok(event.inputTokens >= 0);
        }
        if (typeof event.outputTokens === "number") {
          assert.ok(event.outputTokens >= 0);
        }
        if (typeof event.totalTokens === "number") {
          assert.ok(event.totalTokens >= 0);
        }
        if (typeof event.cachedTokens === "number") {
          assert.ok(event.cachedTokens >= 0);
        }
        if (typeof event.reasoningTokens === "number") {
          assert.ok(event.reasoningTokens >= 0);
        }
        if (typeof event.inputTokens === "number" && typeof event.outputTokens === "number" && typeof event.totalTokens === "number") {
          assert.equal(event.totalTokens, event.inputTokens + event.outputTokens);
        }
        assert.equal(typeof event.metadata.exitCode, "number");
        assert.equal(event.metadata.outcomeKind, "result");
        t.diagnostic(
          `telemetry usage fields=${JSON.stringify({
            inputTokens: event.inputTokens ?? null,
            outputTokens: event.outputTokens ?? null,
            totalTokens: event.totalTokens ?? null,
            cachedTokens: event.cachedTokens ?? null,
            reasoningTokens: event.reasoningTokens ?? null
          })}`
        );
      });
    });

    await t.test("real-host run salvages malformed logs without discarding later valid events", async (t) => {
      await withLiveFixture("malformed-log", async (fixture) => {
        const { projectRoot } = fixture;
        await runCli(fixture, ["init"]);
        const assignmentId = await retargetActiveAssignment(fixture, {
          objective:
            "Append the exact line `Live harness malformed log complete.` under the `## Harness Notes` heading in README.md. Do not change any other file.",
          writeScope: ["README.md"],
          requiredOutputs: ["README.md updated", "durable result summary"]
        });

        await appendPartialResult(
          fixture,
          assignmentId,
          "Live harness valid progress before repair."
        );
        const store = RuntimeStore.forProject(projectRoot);
        await writeFile(store.eventsPath, `${await readFile(store.eventsPath, "utf8")}{"broken":\n`, "utf8");

        const run = await runCli(fixture, ["run"]);
        const projection = await loadOperatorProjection(store);
        const readme = await readFile(join(projectRoot, "README.md"), "utf8");
        const events = (await readFile(store.eventsPath, "utf8")).split("\n").filter(Boolean);

        assert.match(stdout(run), /Executed assignment/);
        assert.equal(projection.results.size, 2);
        assert.match(await readFile(store.eventsPath, "utf8"), /\{"broken":/);
        assert.match(readme, /Live harness malformed log complete\./);
        assert.ok(events.length >= 5);
      });
    });
  }
);

async function createLiveFixture(
  label: string,
  options: LiveFixtureOptions = {}
): Promise<LiveFixture> {
  let projectRoot: string | undefined;
  try {
    projectRoot = await mkdtemp(join(tmpdir(), `${liveFixturePrefix}${label}-`));
    const codexHomeRoot = join(projectRoot, ".coortex-live-home");
    await createIsolatedCodexUserState(codexHomeRoot);
    if (options.failSetupAt === "after-user-state") {
      throw new Error(`Injected live fixture setup failure after isolated user state for ${label}.`);
    }
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await mkdir(join(projectRoot, "test"), { recursive: true });
    await mkdir(join(projectRoot, "docs"), { recursive: true });
    if (options.withInterruptScript) {
      await mkdir(join(projectRoot, "scripts"), { recursive: true });
    }

    await writeFile(join(projectRoot, ".gitignore"), ".coortex/\n.codex/\n", "utf8");
    await writeFile(
      join(projectRoot, "README.md"),
      "# Live Harness Fixture\n\n## Harness Notes\n\n- Initial note.\n",
      "utf8"
    );
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "coortex-live-fixture", version: "0.0.1", type: "module" }, null, 2) +
        "\n",
      "utf8"
    );
    await writeFile(
      join(projectRoot, "src", "app.ts"),
      "export function marker(): string {\n  return 'fixture';\n}\n",
      "utf8"
    );
    await writeFile(
      join(projectRoot, "test", "app.test.ts"),
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { marker } from '../src/app.js';\n\ntest('marker', () => {\n  assert.equal(marker(), 'fixture');\n});\n",
      "utf8"
    );

    for (let index = 0; index < 24; index += 1) {
      await writeFile(
        join(projectRoot, "docs", `noise-${index.toString().padStart(2, "0")}.md`),
        `# Noise ${index}\n\n${"alpha beta gamma delta\n".repeat(12)}`,
        "utf8"
      );
    }

    if (options.withInterruptScript) {
      await writeFile(
        join(projectRoot, "scripts", "live-harness-interrupt.mjs"),
        [
          "import { appendFileSync } from 'node:fs';",
          "const sleepMs = Number(process.env.COORTEX_INTERRUPT_SLEEP_SECONDS ?? '20') * 1000;",
          "appendFileSync('README.md', '\\n- Live harness interruption marker.\\n');",
          "await new Promise((resolve) => setTimeout(resolve, sleepMs));"
        ].join("\n"),
        "utf8"
      );
    }

    await execFileAsync("git", ["init", "-b", "main"], { cwd: projectRoot });
    if (options.failSetupAt === "after-git-init") {
      throw new Error(`Injected live fixture setup failure after git init for ${label}.`);
    }
    return {
      label,
      projectRoot,
      codexHomeRoot,
      trackedProcessPids: new Set<number>(),
      env: fixtureEnv(
        {
          label,
          projectRoot,
          codexHomeRoot,
          env: {},
          trackedProcessPids: new Set<number>()
        } as LiveFixture
      )
    };
  } catch (error) {
    if (projectRoot) {
      await rm(projectRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

async function cleanupLiveFixture(fixture: LiveFixture): Promise<void> {
  await terminateTrackedFixtureProcesses(
    fixture,
    liveHarnessProcessCleanupTimeoutMs
  );
  await removeFixtureTree(fixture.projectRoot);
  await assertPathMissing(fixture.projectRoot);
  await assertPathMissing(fixture.codexHomeRoot);
}

async function withLiveFixture<T>(
  label: string,
  run: (fixture: LiveFixture) => Promise<T>,
  options: LiveFixtureOptions = {}
): Promise<T> {
  return withLiveFixtures([{ label, options }], async ([fixture]) =>
    run(requireFixture(fixture, label))
  );
}

async function withLiveFixtures<T>(
  specs: Array<{ label: string; options?: LiveFixtureOptions }>,
  run: (fixtures: LiveFixture[]) => Promise<T>
): Promise<T> {
  const cleanupBaseline = await snapshotLiveHarnessCleanupState();
  const fixtures: LiveFixture[] = [];
  let result!: T;
  let primaryError: unknown;
  try {
    for (const spec of specs) {
      fixtures.push(await createLiveFixture(spec.label, spec.options));
    }
    result = await run(fixtures);
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = (
      await Promise.allSettled(fixtures.map((fixture) => cleanupLiveFixture(fixture)))
    )
      .filter(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      )
      .map((result) => result.reason);
    let deltaError: unknown;
    try {
      await assertNoNewLiveHarnessCleanupDelta(
        cleanupBaseline,
        `live fixture cleanup after [${specs.map((spec) => spec.label).join(", ")}]`
      );
    } catch (error) {
      deltaError = error;
    }
    const secondaryErrors = [...cleanupErrors, ...(deltaError ? [deltaError] : [])];
    if (primaryError && secondaryErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...secondaryErrors],
        "Live fixture execution and cleanup both failed."
      );
    }
    if (primaryError) {
      throw primaryError;
    }
    if (secondaryErrors.length === 1) {
      throw secondaryErrors[0];
    }
    if (secondaryErrors.length > 1) {
      throw new AggregateError(secondaryErrors, "Live fixture cleanup failed.");
    }
  }
  return result;
}

function requireFixture(fixture: LiveFixture | undefined, label: string): LiveFixture {
  if (!fixture) {
    throw new Error(`Missing live fixture ${label}.`);
  }
  return fixture;
}

async function runCli(fixture: LiveFixture, args: string[]) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: fixture.projectRoot,
    detached: process.platform !== "win32",
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const trackedPid = trackFixtureProcess(fixture, child.pid);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdoutBuffer = "";
  let stderrBuffer = "";
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer += chunk;
  });
  const exitPromise = waitForExit(child);
  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exit = await waitForTrackedChildExit(
      child,
      exitPromise,
      liveHarnessCliTimeoutMs,
      fixture,
      trackedPid
    );
  } catch (error) {
    await terminateTrackedFixtureProcesses(
      fixture,
      liveHarnessProcessCleanupTimeoutMs
    ).catch(() => undefined);
    throw error;
  }
  if (exit.code !== 0) {
    throw Object.assign(
      new Error(`ctx ${args.join(" ")} exited with code ${exit.code ?? 1}`),
      {
        code: exit.code,
        signal: exit.signal,
        stdout: stdoutBuffer,
        stderr: stderrBuffer
      }
    );
  }
  return {
    stdout: stdoutBuffer,
    stderr: stderrBuffer
  };
}

async function retargetActiveAssignment(
  fixture: LiveFixture,
  patch: Pick<Assignment, "objective" | "writeScope" | "requiredOutputs">
): Promise<string> {
  const store = RuntimeStore.forProject(fixture.projectRoot);
  const projection = await loadOperatorProjection(store);
  const assignmentId = projection.status.activeAssignmentIds[0];
  if (!assignmentId) {
    throw new Error("Expected an active assignment to retarget.");
  }
  const timestamp = nowIso();
  const status = {
    ...projection.status,
    currentObjective: patch.objective,
    lastDurableOutputAt: timestamp,
    resumeReady: true
  };
  const events: RuntimeEvent[] = [
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "assignment.updated",
      payload: {
        assignmentId,
        patch: {
          objective: patch.objective,
          writeScope: [...patch.writeScope],
          requiredOutputs: [...patch.requiredOutputs],
          updatedAt: timestamp
        }
      }
    },
    {
      eventId: randomUUID(),
      sessionId: projection.sessionId,
      timestamp,
      type: "status.updated",
      payload: { status }
    }
  ];
  for (const event of events) {
    await store.appendEvent(event);
  }
  await store.syncSnapshotFromEvents();
  return assignmentId;
}

async function appendPartialResult(
  fixture: LiveFixture,
  assignmentId: string,
  summary: string
): Promise<void> {
  const store = RuntimeStore.forProject(fixture.projectRoot);
  const projection = await loadOperatorProjection(store);
  const timestamp = nowIso();
  await store.appendEvent({
    eventId: randomUUID(),
    sessionId: projection.sessionId,
    timestamp,
    type: "result.submitted",
    payload: {
      result: {
        resultId: `live-harness-result-${randomUUID()}`,
        assignmentId,
        producerId: "codex",
        status: "partial",
        summary,
        changedFiles: ["README.md"],
        createdAt: timestamp
      }
    }
  });
  await store.syncSnapshotFromEvents();
}

async function inspectRun(fixture: LiveFixture, assignmentId: string) {
  const inspect = await runCli(fixture, ["inspect", assignmentId]);
  const inspection = JSON.parse(stdout(inspect)) as {
    hostRun: {
      assignmentId: string;
      state: string;
      outcomeKind?: string;
      adapterData?: {
        nativeRunId?: string;
      };
    };
  };
  const record = inspection.hostRun;
  return {
    assignmentId: record.assignmentId,
    state: record.state,
    outcomeKind: record.outcomeKind,
    nativeRunId: record.adapterData?.nativeRunId
  };
}

async function readSnapshot(fixture: LiveFixture): Promise<RuntimeSnapshot> {
  return readJsonArtifact(fixture, "runtime/snapshot.json");
}

async function readTelemetry(fixture: LiveFixture): Promise<TelemetryEvent[]> {
  const store = RuntimeStore.forProject(fixture.projectRoot);
  return store.loadTelemetry();
}

async function readJsonArtifact<T>(fixture: LiveFixture, relativePath: string): Promise<T> {
  return JSON.parse(
    await readFile(join(fixture.projectRoot, ".coortex", relativePath), "utf8")
  ) as T;
}

async function assertPathExists(path: string): Promise<void> {
  await access(path, constants.F_OK);
}

function assertHasTelemetryEvent(events: TelemetryEvent[], eventType: string): void {
  assert.ok(events.some((event) => event.eventType === eventType), `Missing telemetry ${eventType}`);
}

function findLatestResultId(snapshot: RuntimeSnapshot): string {
  const result = snapshot.results.at(-1);
  if (!result) {
    throw new Error("Expected a persisted result in the snapshot.");
  }
  return result.resultId;
}

async function waitForRunningHandle(
  fixture: LiveFixture,
  assignmentId: string,
  timeoutMs: number
): Promise<{ state: string; nativeRunId?: string }> {
  const deadline = Date.now() + timeoutMs;
  const store = RuntimeStore.forProject(fixture.projectRoot);
  let lastObservedInspect:
    | (ReturnType<typeof inspectRun> extends Promise<infer T> ? T : never)
    | undefined;
  let lastObservedNativeRunId: string | undefined;
  while (Date.now() < deadline) {
    try {
      const record = await inspectRun(fixture, assignmentId);
      lastObservedInspect = record;
      const projection = await loadOperatorProjection(store);
      lastObservedNativeRunId = [...projection.attachments.values()]
        .find(
          (attachment) =>
            attachment.provenance.kind === "launch" &&
            attachment.provenance.source === "ctx.run" &&
            attachment.state === "attached"
        )?.nativeSessionId;
      if (
        record?.state === "running" &&
        typeof lastObservedNativeRunId === "string"
      ) {
        return {
          state: record.state,
          nativeRunId: lastObservedNativeRunId
        };
      }
    } catch {
      // keep polling until the running handle is durably visible
    }
    await delay(500);
  }
  throw new Error(
    `Timed out waiting for running handle for ${assignmentId}. nativeRunIdObserved=${lastObservedNativeRunId ?? "none"} lastInspect=${JSON.stringify(lastObservedInspect)}`
  );
}

function waitForExit(
  child: ReturnType<typeof spawn>
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function terminateChildProcessTree(
  child: ReturnType<typeof spawn>,
  signal: "SIGTERM" | "SIGKILL"
): Promise<void> {
  if (!child.pid) {
    return;
  }
  if (process.platform === "win32") {
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    try {
      await spawnAndWait("taskkill", args);
    } catch {
      child.kill(signal);
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
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

function trackHarnessProcess(pid: number | undefined): number | undefined {
  if (typeof pid === "number") {
    activeHarnessProcessPids.add(pid);
    return pid;
  }
  return undefined;
}

function trackFixtureProcess(
  fixture: LiveFixture,
  pid: number | undefined
): number | undefined {
  const trackedPid = trackHarnessProcess(pid);
  if (typeof trackedPid === "number") {
    fixture.trackedProcessPids.add(trackedPid);
  }
  return trackedPid;
}

function untrackFixtureProcess(
  fixture: LiveFixture,
  trackedPid: number | undefined
): void {
  if (typeof trackedPid === "number") {
    fixture.trackedProcessPids.delete(trackedPid);
    activeHarnessProcessPids.delete(trackedPid);
  }
}

function listActiveHarnessProcessPids(): number[] {
  return [...activeHarnessProcessPids].sort((left, right) => left - right);
}

async function listTrackedHarnessProcessPids(): Promise<number[]> {
  const tracked = new Set<number>(listActiveHarnessProcessPids());
  for (const pid of activeHarnessProcessPids) {
    for (const descendant of await listDescendantPids(pid)) {
      tracked.add(descendant);
    }
  }
  return [...tracked].sort((left, right) => left - right);
}

function diffNewActiveHarnessProcessPids(before: number[], after: number[]): number[] {
  const beforeSet = new Set(before);
  return after.filter((pid) => !beforeSet.has(pid));
}

async function waitForTrackedChildExit(
  child: ReturnType<typeof spawn>,
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  timeoutMs: number,
  fixture: LiveFixture,
  trackedPid = child.pid
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let exit:
    | {
        code: number | null;
        signal: NodeJS.Signals | null;
      }
    | undefined;
  try {
    exit = await waitForExitWithTimeout(exitPromise, timeoutMs, child.pid);
    await assertProcessTreeGone(child.pid, timeoutMs);
    untrackFixtureProcess(fixture, trackedPid);
    return exit;
  } catch (error) {
    if (
      exit &&
      typeof trackedPid === "number" &&
      !(await isProcessTreeAlive(trackedPid))
    ) {
      untrackFixtureProcess(fixture, trackedPid);
    }
    throw error;
  }
}

async function terminateTrackedFixtureProcesses(
  fixture: LiveFixture,
  timeoutMs: number
): Promise<void> {
  for (const pid of [...fixture.trackedProcessPids]) {
    if (!(await isProcessTreeAlive(pid))) {
      untrackFixtureProcess(fixture, pid);
      continue;
    }
    await terminateProcessTreeByPid(pid, "SIGTERM").catch(() => undefined);
  }
  await delay(250);
  for (const pid of [...fixture.trackedProcessPids]) {
    if (!(await isProcessTreeAlive(pid))) {
      untrackFixtureProcess(fixture, pid);
      continue;
    }
    await terminateProcessTreeByPid(pid, "SIGKILL").catch(() => undefined);
    await assertProcessTreeGone(pid, timeoutMs);
    untrackFixtureProcess(fixture, pid);
  }
}

async function terminateProcessTreeByPid(
  pid: number,
  signal: "SIGTERM" | "SIGKILL"
): Promise<void> {
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    await spawnAndWait("taskkill", args);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (isMissingProcessError(error)) {
      return;
    }
    process.kill(pid, signal);
  }
}

async function removeFixtureTree(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableRemoveError(error) || attempt === 9) {
        throw error;
      }
      await delay(250);
    }
  }
}

async function listDescendantPids(rootPid: number | undefined): Promise<number[]> {
  if (!rootPid) {
    return [];
  }
  if (process.platform === "win32") {
    return listWindowsDescendantPids(rootPid);
  }
  return listPosixDescendantPids(rootPid);
}

async function listPosixDescendantPids(rootPid: number): Promise<number[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid="]);
  const childMap = new Map<number, number[]>();
  for (const line of String(stdout).split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const children = childMap.get(parentPid) ?? [];
    children.push(pid);
    childMap.set(parentPid, children);
  }
  const descendants: number[] = [];
  const pending = [...(childMap.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || descendants.includes(current)) {
      continue;
    }
    descendants.push(current);
    pending.push(...(childMap.get(current) ?? []));
  }
  return descendants;
}

async function listWindowsDescendantPids(rootPid: number): Promise<number[]> {
  const command = [
    "-NoProfile",
    "-Command",
    [
      "$rootPid = [int]$args[0]",
      "$procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)",
      "$pending = [System.Collections.Generic.Queue[int]]::new()",
      "$desc = [System.Collections.Generic.List[int]]::new()",
      "foreach ($proc in $procs) {",
      "  if ($proc.ParentProcessId -eq $rootPid) {",
      "    $pending.Enqueue([int]$proc.ProcessId)",
      "  }",
      "}",
      "while ($pending.Count -gt 0) {",
      "  $current = $pending.Dequeue()",
      "  if ($desc.Contains($current)) { continue }",
      "  $desc.Add($current)",
      "  foreach ($proc in $procs) {",
      "    if ($proc.ParentProcessId -eq $current) {",
      "      $pending.Enqueue([int]$proc.ProcessId)",
      "    }",
      "  }",
      "}",
      "$desc | ForEach-Object { Write-Output $_ }"
    ].join("; "),
    String(rootPid)
  ];
  const { stdout } = await execFileAsync("powershell", command);
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map((line) => Number(line));
}

async function terminateCapturedProcessTrees(
  pids: number[],
  signal: "SIGTERM" | "SIGKILL"
): Promise<void> {
  for (const pid of [...new Set(pids)]) {
    if (process.platform === "win32") {
      const args = ["/PID", String(pid), "/T"];
      if (signal === "SIGKILL") {
        args.push("/F");
      }
      try {
        await spawnAndWait("taskkill", args);
      } catch {
        continue;
      }
      continue;
    }
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (isMissingProcessError(error)) {
        continue;
      }
      try {
        process.kill(pid, signal);
      } catch (innerError) {
        if (isMissingProcessError(innerError)) {
          continue;
        }
        throw innerError;
      }
    }
  }
}

async function waitForCapturedProcessTreesToExit(
  pids: number[],
  timeoutMs: number
): Promise<void> {
  await Promise.all(
    [...new Set(pids)].map((pid) => assertProcessTreeGone(pid, timeoutMs))
  );
}

async function waitForExitWithTimeout(
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  timeoutMs: number,
  pid: number | undefined
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Timed out waiting for live harness CLI ${pid ?? "unknown"} to exit.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([exitPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function assertProcessTreeGone(pid: number | undefined, timeoutMs: number): Promise<void> {
  if (!pid) {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isProcessTreeAlive(pid))) {
      return;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for live harness process tree ${pid} to terminate.`);
}

async function isProcessTreeAlive(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    return isWindowsProcessTreeAlive(pid);
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

async function isWindowsProcessTreeAlive(pid: number): Promise<boolean> {
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

function isRetryableRemoveError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    ["ENOTEMPTY", "EBUSY", "EPERM"].includes(
      String((error as NodeJS.ErrnoException).code)
    )
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function fixtureEnv(
  fixture: Pick<LiveFixture, "codexHomeRoot" | "env">,
  extraEnv: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const home = join(fixture.codexHomeRoot, "home");
  const xdgConfigHome = join(fixture.codexHomeRoot, "xdg-config");
  const xdgCacheHome = join(fixture.codexHomeRoot, "xdg-cache");
  const xdgStateHome = join(fixture.codexHomeRoot, "xdg-state");
  const tmpPath = join(fixture.codexHomeRoot, "tmp");
  return {
    ...process.env,
    ...fixture.env,
    HOME: home,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_CACHE_HOME: xdgCacheHome,
    XDG_STATE_HOME: xdgStateHome,
    TMPDIR: tmpPath,
    TMP: tmpPath,
    TEMP: tmpPath,
    USERPROFILE: home,
    COORTEX_CODEX_DANGEROUS_BYPASS: "1",
    ...extraEnv
  };
}

async function createIsolatedCodexUserState(codexHomeRoot: string): Promise<void> {
  const isolatedCodexDir = join(codexHomeRoot, "home", ".codex");
  await Promise.all([
    mkdir(isolatedCodexDir, { recursive: true }),
    mkdir(join(codexHomeRoot, "xdg-config"), { recursive: true }),
    mkdir(join(codexHomeRoot, "xdg-cache"), { recursive: true }),
    mkdir(join(codexHomeRoot, "xdg-state"), { recursive: true }),
    mkdir(join(codexHomeRoot, "tmp"), { recursive: true })
  ]);
  const realCodexDir = join(process.env.HOME ?? homedir(), ".codex");
  await copyIfPresent(join(realCodexDir, "auth.json"), join(isolatedCodexDir, "auth.json"));
  await copyIfPresent(
    join(realCodexDir, "installation_id"),
    join(isolatedCodexDir, "installation_id")
  );
}

async function listLiveTmpDirs(): Promise<string[]> {
  try {
    return (await readdir(tmpdir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(liveFixturePrefix))
      .map((entry) => join(tmpdir(), entry.name))
      .sort();
  } catch {
    return [];
  }
}

function diffNewLiveTmpDirs(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before);
  return after.filter((path) => !beforeSet.has(path));
}

async function snapshotLiveHarnessCleanupState(): Promise<LiveHarnessCleanupState> {
  return {
    liveTmpDirs: await listLiveTmpDirs(),
    trackedHarnessProcessPids: await listTrackedHarnessProcessPids()
  };
}

async function assertNoNewLiveHarnessCleanupDelta(
  before: LiveHarnessCleanupState,
  context: string
): Promise<void> {
  const after = await snapshotLiveHarnessCleanupState();
  assert.deepEqual(
    diffNewLiveTmpDirs(before.liveTmpDirs, after.liveTmpDirs),
    [],
    `${context} must not leave new coortex-live-* directories under the OS temp root behind`
  );
  assert.deepEqual(
    diffNewActiveHarnessProcessPids(
      before.trackedHarnessProcessPids,
      after.trackedHarnessProcessPids
    ),
    [],
    `${context} must not leave new tracked live-harness/Codex processes or descendants behind`
  );
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    await access(path, constants.F_OK);
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
  try {
    await access(source, constants.F_OK);
    await copyFile(source, destination);
  } catch {
    // optional Codex user-state seed
  }
}

async function assertPathMissing(path: string): Promise<void> {
  await assert.rejects(access(path, constants.F_OK), /ENOENT/);
}

function normalizeRepeatability(snapshot: RuntimeSnapshot, telemetry: TelemetryEvent[]) {
  const completedTelemetry = findLastByEventType(telemetry, "host.run.completed");
  return {
    status: {
      currentObjective: snapshot.status.currentObjective,
      activeAssignments: snapshot.status.activeAssignmentIds.length,
      resumeReady: snapshot.status.resumeReady,
      activeHost: snapshot.status.activeHost,
      activeAdapter: snapshot.status.activeAdapter
    },
    assignments: snapshot.assignments.map((assignment) => ({
      objective: assignment.objective,
      state: assignment.state,
      writeScope: [...assignment.writeScope],
      requiredOutputs: [...assignment.requiredOutputs]
    })),
    results: snapshot.results.map((result) => ({
      producerId: result.producerId,
      status: result.status,
      changedFiles: [...result.changedFiles]
    })),
    decisions: snapshot.decisions.map((decision) => ({
      state: decision.state
    })),
    telemetry: completedTelemetry
      ? {
          eventType: completedTelemetry.eventType,
          host: completedTelemetry.host,
          adapter: completedTelemetry.adapter,
          hasInputTokens: typeof completedTelemetry.inputTokens === "number",
          hasOutputTokens: typeof completedTelemetry.outputTokens === "number",
          hasTotalTokens: typeof completedTelemetry.totalTokens === "number",
          metadataKeys: Object.keys(completedTelemetry.metadata).sort()
        }
      : undefined
  };
}

function findLastByEventType(events: TelemetryEvent[], eventType: string): TelemetryEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.eventType === eventType) {
      return event;
    }
  }
  return undefined;
}

function stdout(result: { stdout: string | Buffer }): string {
  return String(result.stdout);
}
