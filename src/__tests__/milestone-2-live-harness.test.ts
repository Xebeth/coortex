import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
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

liveHarness(
  "milestone-2 live harness: automates the manual checklist against a real Codex install",
  { timeout: 10 * 60 * 1_000 },
  async (t) => {
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

    await t.test("fresh initialization and doctor", async () => {
      const projectRoot = await createLiveFixture("init");

      const init = await runCli(projectRoot, ["init"]);
      const doctor = await runCli(projectRoot, ["doctor"]);
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

    await t.test("happy path real run persists result, status, inspect, and telemetry", async () => {
      const projectRoot = await createLiveFixture("happy");
      await runCli(projectRoot, ["init"]);
      const assignmentId = await retargetActiveAssignment(projectRoot, {
        objective:
          "Append the exact line `Live harness happy path complete.` under the `## Harness Notes` heading in README.md. Do not change any other file.",
        writeScope: ["README.md"],
        requiredOutputs: ["README.md updated", "durable result summary"]
      });

      const run = await runCli(projectRoot, ["run"]);
      const status = await runCli(projectRoot, ["status"]);
      const inspect = await inspectRun(projectRoot, assignmentId);
      await delay(1_000);
      const snapshot = await readSnapshot(projectRoot);
      const telemetry = await readTelemetry(projectRoot);
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

    await t.test("blocked decision path persists an open decision and blocked status", async () => {
      const projectRoot = await createLiveFixture("blocked");
      await runCli(projectRoot, ["init"]);
      const assignmentId = await retargetActiveAssignment(projectRoot, {
        objective:
          "Update package.json to version 9.9.9. You must only change package.json, but the current write scope does not include it. Do not pick an alternative file. If you cannot proceed safely, return a decision requesting expanded scope.",
        writeScope: ["README.md"],
        requiredOutputs: ["decision if blocked"]
      });

      const run = await runCli(projectRoot, ["run"]);
      const status = await runCli(projectRoot, ["status"]);
      const inspect = await inspectRun(projectRoot, assignmentId);
      await delay(1_000);
      const snapshot = await readSnapshot(projectRoot);

      assert.match(stdout(run), /Decision:/);
      assert.equal(snapshot.decisions.length, 1);
      assert.equal(snapshot.decisions[0]?.state, "open");
      assert.equal(snapshot.assignments[0]?.state, "blocked");
      assert.match(stdout(status), /Open decisions: 1/);
      assert.match(stdout(status), new RegExp(`- ${assignmentId} blocked `));
      assert.equal(inspect?.state, "completed");
      assert.equal(inspect?.outcomeKind, "decision");
    });

    await t.test("trimming boundary stays bounded and preserves the full artifact", async () => {
      const projectRoot = await createLiveFixture("trim");
      await runCli(projectRoot, ["init"]);
      const assignmentId = await retargetActiveAssignment(projectRoot, {
        objective:
          "Append the exact line `Live harness trimming follow-up complete.` under the `## Harness Notes` heading in README.md. Do not change any other file.",
        writeScope: ["README.md"],
        requiredOutputs: ["README.md updated", "durable result summary"]
      });
      const largeSummary = "trim-me ".repeat(600).trim();
      await appendPartialResult(projectRoot, assignmentId, largeSummary);

      await runCli(projectRoot, ["resume"]);
      const envelope = await readJsonArtifact<{
        trimApplied: boolean;
        estimatedChars: number;
        recentResults: Array<{ trimmed?: boolean; reference?: string }>;
      }>(projectRoot, "runtime/last-resume-envelope.json");
      const telemetry = await readTelemetry(projectRoot);
      const artifactPath = join(
        projectRoot,
        ".coortex",
        "artifacts",
        "results",
        `${findLatestResultId(await readSnapshot(projectRoot))}.txt`
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

    await t.test("resume path preserves a running host handle after interruption", async () => {
      const projectRoot = await createLiveFixture("resume", { withInterruptScript: true });
      await runCli(projectRoot, ["init"]);
      const assignmentId = await retargetActiveAssignment(projectRoot, {
        objective:
          "Run `node scripts/live-harness-interrupt.mjs`, confirm the README.md marker exists, then return a completed result only after the script finishes. Do not skip the script or the delay.",
        writeScope: ["README.md", "scripts/"],
        requiredOutputs: ["README.md updated", "durable result summary"]
      });

      const runProcess = spawn(process.execPath, [cliPath, "run"], {
        cwd: projectRoot,
        detached: process.platform !== "win32",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
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

      const runningRecord = await waitForInterruptionPoint(projectRoot, assignmentId, 45_000);
      assert.equal(runningRecord.state, "running");
      assert.ok(runningRecord.hostRunId);

      await terminateProcessTree(runProcess);
      const exit = await waitForExit(runProcess);
      const inspect = await inspectRun(projectRoot, assignmentId);
      const status = await runCli(projectRoot, ["status"]);
      const resume = await runCli(projectRoot, ["resume"]);
      await delay(1_000);
      const snapshot = await readSnapshot(projectRoot);
      const resumedEnvelope = await readJsonArtifact<{
        metadata: { activeAssignmentId?: string };
        recoveryBrief: {
          activeAssignments: Array<{ id: string; state: string }>;
          nextRequiredAction: string;
        };
      }>(projectRoot, "runtime/last-resume-envelope.json");

      assert.ok(exit.signal === "SIGTERM" || exit.code === 1 || exit.code === 143 || exit.code === null);
      assert.equal(snapshot.results.length, 0);
      assert.deepEqual(snapshot.status.activeAssignmentIds, [assignmentId]);
      assert.match(stdout(status), /Active assignments: 1/);
      assert.equal(inspect?.state, "running");
      assert.equal(inspect?.hostRunId, runningRecord.hostRunId);
      assert.match(stdout(resume), /Recovery brief generated/);
      assert.equal(resumedEnvelope.metadata.activeAssignmentId, assignmentId);
      assert.equal(resumedEnvelope.recoveryBrief.activeAssignments[0]?.id, assignmentId);
      assert.match(resumedEnvelope.recoveryBrief.nextRequiredAction, /Continue assignment/);
      const readme = await readFile(join(projectRoot, "README.md"), "utf8");
      assert.match(readme, /Live harness interruption marker\./);
      t.diagnostic(`interrupted run stdout=${JSON.stringify(runStdout.trim())}`);
      if (runStderr.trim().length > 0) {
        t.diagnostic(`interrupted run stderr=${JSON.stringify(runStderr.trim())}`);
      }
    });

    await t.test("repeatability stays structurally consistent across equivalent live runs", async () => {
      const [first, second] = await Promise.all([
        createLiveFixture("repeat-a"),
        createLiveFixture("repeat-b")
      ]);
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
    });

    await t.test("real-host telemetry stays honest about usage fields", async () => {
      const projectRoot = await createLiveFixture("telemetry");
      await runCli(projectRoot, ["init"]);
      await retargetActiveAssignment(projectRoot, {
        objective:
          "Append the exact line `Live harness telemetry complete.` under the `## Harness Notes` heading in README.md. Do not change any other file.",
        writeScope: ["README.md"],
        requiredOutputs: ["README.md updated", "durable result summary"]
      });

      await runCli(projectRoot, ["run"]);
      const event = [...(await readTelemetry(projectRoot))]
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
  }
);

async function createLiveFixture(
  label: string,
  options: { withInterruptScript?: boolean } = {}
): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), `coortex-live-${label}-`));
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
  return projectRoot;
}

async function runCli(projectRoot: string, args: string[]) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    env: process.env
  });
}

async function retargetActiveAssignment(
  projectRoot: string,
  patch: Pick<Assignment, "objective" | "writeScope" | "requiredOutputs">
): Promise<string> {
  const store = RuntimeStore.forProject(projectRoot);
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
  projectRoot: string,
  assignmentId: string,
  summary: string
): Promise<void> {
  const store = RuntimeStore.forProject(projectRoot);
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

async function inspectRun(projectRoot: string, assignmentId: string) {
  const inspect = await runCli(projectRoot, ["inspect", assignmentId]);
  return JSON.parse(stdout(inspect)) as {
    assignmentId: string;
    state: string;
    hostRunId?: string;
    outcomeKind?: string;
  };
}

async function readSnapshot(projectRoot: string): Promise<RuntimeSnapshot> {
  return readJsonArtifact(projectRoot, "runtime/snapshot.json");
}

async function readTelemetry(projectRoot: string): Promise<TelemetryEvent[]> {
  const store = RuntimeStore.forProject(projectRoot);
  return store.loadTelemetry();
}

async function readJsonArtifact<T>(projectRoot: string, relativePath: string): Promise<T> {
  return JSON.parse(await readFile(join(projectRoot, ".coortex", relativePath), "utf8")) as T;
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

async function waitForInterruptionPoint(
  projectRoot: string,
  assignmentId: string,
  timeoutMs: number
): Promise<{ state: string; hostRunId?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const record = await readJsonArtifact<{
        state: string;
        hostRunId?: string;
      }>(projectRoot, `adapters/codex/runs/${assignmentId}.json`);
      const readme = await readFile(join(projectRoot, "README.md"), "utf8");
      if (
        record.state === "running" &&
        typeof record.hostRunId === "string" &&
        /Live harness interruption marker\./.test(readme)
      ) {
        return record;
      }
    } catch {
      // keep polling until the handle and on-disk marker are durably visible
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for interruption point for ${assignmentId}.`);
}

async function terminateProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) {
    return;
  }
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    } catch {
      child.kill("SIGTERM");
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
      summary: result.summary,
      changedFiles: [...result.changedFiles]
    })),
    decisions: snapshot.decisions.map((decision) => ({
      blockerSummary: decision.blockerSummary,
      recommendedOption: decision.recommendedOption,
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
