import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const returnReviewStateScript = resolve(
  process.cwd(),
  "src/hosts/codex/profile/skill-pack/review-orchestrator/scripts/return_review_state.py"
);
const fixResultStateScript = resolve(
  process.cwd(),
  "src/hosts/codex/profile/skill-pack/fixer-orchestrator/scripts/fix_result_state.py"
);
const seamWalkbackStateScript = resolve(
  process.cwd(),
  "src/hosts/codex/profile/skill-pack/seam-walkback-review/scripts/walkback_state.py"
);
const coortexReviewStateScript = resolve(
  process.cwd(),
  "src/hosts/codex/profile/skill-pack/coortex-review/scripts/review_state.py"
);
const aiSlopCleanerStateScript = resolve(
  process.cwd(),
  "src/hosts/codex/profile/skill-pack/coortex-deslop/scripts/deslop_state.py"
);
const implementationCoordinatorStateScript = resolve(
  process.cwd(),
  "src/hosts/codex/profile/skill-pack/implementation-coordinator/scripts/implementation_state.py"
);

function parseJsonOutput(raw: string | undefined): unknown {
  if (raw == null || raw.trim() === "") {
    return {};
  }
  return JSON.parse(raw);
}

async function runPythonJson(
  scriptPath: string,
  args: string[]
): Promise<{ exitCode: number; json: unknown; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("python", [scriptPath, ...args]);
    return {
      exitCode: 0,
      json: parseJsonOutput(result.stdout),
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      json: parseJsonOutput(failure.stdout),
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? ""
    };
  }
}

function validReviewHandoff(familyId: string | string[] = "F-OP-001"): Record<string, unknown> {
  const familyIds = Array.isArray(familyId) ? familyId : [familyId];
  return {
    review_handoff: {
      review_target: { mode: "branch", scope_summary: "test" },
      families: familyIds.map((id) => ({
        family_id: id,
        severity: "MEDIUM",
        title: "Example family",
        highest_confidence_root_cause: "example root cause",
        source_surfaces: ["runtime-recovery"],
        manifestations: ["src/example.ts:10"],
        immediate_implications: ["example immediate implication"],
        broader_implications: ["example broader implication"],
        sibling_bugs: "none found",
        sibling_search_scope: ["example sibling path"],
        closure_status: "family-still-open",
        open_reason_kind: "family-local-gap-remaining",
        thin_areas: "none",
        review_hints: {
          likely_owning_seam: "src/example.ts",
          secondary_seams: "none",
          candidate_write_set: ["src/example.ts"],
          candidate_test_set: ["src/__tests__/example.test.ts"],
          candidate_doc_set: "none",
          parallelizable: false
        },
        closure_gate: {
          remediation_item: "repair the example root cause",
          closure_checklist: ["root cause is repaired"],
          required_sibling_tests: ["sibling path remains covered"],
          doc_closure: "none",
          reviewer_stop_conditions: ["reject symptom-only repair"]
        },
        next_step: {
          kind: "follow-up-fix",
          action: "repair the example root cause",
          required_environment: "none",
          expected_evidence: ["updated implementation and tests"],
          reevaluate_when: ["the fixer slice returns"]
        }
      }))
    }
  };
}

function validReturnReviewLane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lane_id: "return-F-COV-001",
    target: "F-COV-001",
    scope_summary: "returned family",
    claimed_closure_status: "family-closed",
    closure_claim_verdict: "confirmed",
    closure_gate_checked: [
      {
        gate_item: "root cause repaired",
        item_verdict: "satisfied",
        evidence: ["src/runtime.ts:12"]
      }
    ],
    evidence: ["src/runtime.ts:12"],
    new_findings: "none found",
    material_evidence_actions: ["read returned diff"],
    rationale_summary: "closure gate evidence matched the returned diff",
    skipped_areas: "none",
    skip_reasons: "none",
    stop_reason: "family-local return review completed",
    coverage_confidence: "high",
    thin_areas: "none",
    omission_entries: [],
    ...overrides
  };
}


async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

test("seam walkback helper inventories branch state and classifies pivots selectively", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-seam-walkback-"));

  await runGit(tempDir, ["init", "-b", "main"]);
  await runGit(tempDir, ["config", "user.name", "Coortex Tests"]);
  await runGit(tempDir, ["config", "user.email", "coortex-tests@example.com"]);
  await writeFile(join(tempDir, "base.txt"), "base\n", "utf8");
  await runGit(tempDir, ["add", "base.txt"]);
  await runGit(tempDir, ["commit", "-m", "feat: seed repo"]);
  await runGit(tempDir, ["checkout", "-b", "feature/seams"]);
  await writeFile(join(tempDir, "pivot.txt"), "pivot\n", "utf8");
  await runGit(tempDir, ["add", "pivot.txt"]);
  await runGit(tempDir, ["commit", "-m", "refactor: extract seam"]);
  await writeFile(join(tempDir, "fix.txt"), "fix\n", "utf8");
  await runGit(tempDir, ["add", "fix.txt"]);
  await runGit(tempDir, ["commit", "-m", "fix: local patch"]);
  await writeFile(join(tempDir, "dirty.txt"), "dirty\n", "utf8");

  const inventory = await runPythonJson(seamWalkbackStateScript, [
    "inventory",
    "--project-root",
    tempDir,
    "--base-ref",
    "main",
    "--max-commits",
    "5",
    "--include-files"
  ]);

  assert.equal(inventory.exitCode, 0);
  const json = inventory.json as {
    branch: string;
    merge_base: string;
    dirty_files: string[];
    commit_count: number;
    ahead_behind: { base_only_count: number; head_only_count: number };
    commits: Array<{ subject: string; likely_pivot: boolean; files: string[] }>;
  };
  assert.equal(json.branch, "feature/seams");
  assert.equal(json.commit_count, 2);
  assert.equal(json.ahead_behind.base_only_count, 0);
  assert.equal(json.ahead_behind.head_only_count, 2);
  assert.match(json.merge_base, /^[0-9a-f]{40}$/);
  assert.deepEqual(json.dirty_files, ["?? dirty.txt"]);
  assert.equal(json.commits[0]?.subject, "fix: local patch");
  assert.equal(json.commits[0]?.likely_pivot, false);
  assert.equal(json.commits[1]?.subject, "refactor: extract seam");
  assert.equal(json.commits[1]?.likely_pivot, true);
  assert.deepEqual(json.commits[1]?.files, ["pivot.txt"]);
});

test("seam walkback helper reports the changed files for one commit", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-seam-walkback-"));

  await runGit(tempDir, ["init", "-b", "main"]);
  await runGit(tempDir, ["config", "user.name", "Coortex Tests"]);
  await runGit(tempDir, ["config", "user.email", "coortex-tests@example.com"]);
  await writeFile(join(tempDir, "base.txt"), "base\n", "utf8");
  await runGit(tempDir, ["add", "base.txt"]);
  await runGit(tempDir, ["commit", "-m", "feat: seed repo"]);
  await writeFile(join(tempDir, "one.txt"), "one\n", "utf8");
  await writeFile(join(tempDir, "two.txt"), "two\n", "utf8");
  await runGit(tempDir, ["add", "one.txt", "two.txt"]);
  await runGit(tempDir, ["commit", "-m", "refactor: move pieces"]);
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tempDir })).stdout.trim();

  const result = await runPythonJson(seamWalkbackStateScript, [
    "commit-files",
    commit,
    "--project-root",
    tempDir
  ]);

  assert.equal(result.exitCode, 0);
  const json = result.json as { commit: string; files: string[]; file_count: number };
  assert.equal(json.commit, commit);
  assert.equal(json.file_count, 2);
  assert.deepEqual(json.files, ["one.txt", "two.txt"]);
});


test("seam walkback helper initializes and appends validated trace records", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-seam-walkback-trace-"));
  const traceRoot = join(".coortex", "review-trace");

  const init = await runPythonJson(seamWalkbackStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--run-id",
    "seam-walkback-review-test"
  ]);

  assert.equal(init.exitCode, 0);
  const initJson = init.json as { coordinator_file: string; trace_dir: string; run_id: string };
  assert.equal(initJson.run_id, "seam-walkback-review-test");
  assert.equal(initJson.trace_dir, join(tempDir, ".coortex", "review-trace", "seam-walkback-review-test"));
  const started = await readFile(initJson.coordinator_file, "utf8");
  assert.match(started, /"phase": "trace_started"/);

  const recordPath = join(tempDir, "archaeology.json");
  await writeFile(
    recordPath,
    JSON.stringify(
      {
        run_id: "seam-walkback-review-test",
        timestamp_utc: "2026-04-19T19:00:00Z",
        skill: "seam-walkback-review",
        phase: "archaeology_cluster",
        worktree_root: tempDir,
        cluster_id: "cluster-b",
        scope_summary: "Inspect seam extraction commits for CLI ownership drift.",
        pivot_commits: ["abc123", "def456"],
      },
      null,
      2,
    ),
    "utf8",
  );

  const append = await runPythonJson(seamWalkbackStateScript, [
    "append-trace",
    "--trace-file",
    initJson.coordinator_file,
    "--record-file",
    recordPath,
  ]);

  assert.equal(append.exitCode, 0);
  const traceLines = (await readFile(initJson.coordinator_file, "utf8")).trim().split("\n");
  assert.equal(traceLines.length, 2);
  assert.match(traceLines[1] ?? "", /"phase": "archaeology_cluster"/);

  const invalid = await runPythonJson(seamWalkbackStateScript, [
    "append-trace",
    "--trace-file",
    initJson.coordinator_file,
    "--record-json",
    JSON.stringify({
      run_id: "seam-walkback-review-test",
      timestamp_utc: "2026-04-19T19:01:00Z",
      skill: "seam-walkback-review",
      phase: "repair_step",
      worktree_root: tempDir,
      owning_seam: "src/cli/commands.ts",
    }),
  ]);

  assert.equal(invalid.exitCode, 1);
  const invalidJson = invalid.json as { appended: boolean; errors: string[] };
  assert.equal(invalidJson.appended, false);
  assert.match(invalidJson.errors[0] ?? "", /write_set/);
});


test("seam walkback helper blocks concurrent campaigns and clears after terminal trace", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-seam-walkback-campaign-"));
  const traceRoot = join(".coortex", "review-trace");

  const init = await runPythonJson(seamWalkbackStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--run-id",
    "seam-walkback-review-campaign",
    "--owner-host-session-id",
    "codex-thread-seam",
    "--owner-started-from-cwd",
    tempDir
  ]);

  assert.equal(init.exitCode, 0);
  const initJson = init.json as {
    active_campaign_file: string;
    coordinator_file: string;
    resumed: boolean;
    trace_dir: string;
  };
  assert.equal(initJson.resumed, false);
  const activeCampaign = JSON.parse(await readFile(initJson.active_campaign_file, "utf8")) as {
    campaign_id: string;
    campaign_type: string;
    owner_host_session_id: string;
    owner_started_from_cwd: string;
    state: string;
    started_at_utc: string;
    worktree_root: string;
  };
  assert.equal(activeCampaign.campaign_id, "seam-walkback-review-campaign");
  assert.equal(activeCampaign.campaign_type, "seam-walkback-review");
  assert.equal(activeCampaign.owner_host_session_id, "codex-thread-seam");
  assert.equal(activeCampaign.owner_started_from_cwd, tempDir);
  assert.equal(activeCampaign.state, "active");
  assert.equal(activeCampaign.worktree_root, tempDir);
  assert.equal(typeof activeCampaign.started_at_utc, "string");

  const packet = await runPythonJson(seamWalkbackStateScript, [
    "packet-path",
    "--trace-dir",
    initJson.trace_dir
  ]);
  assert.equal(packet.exitCode, 0);
  assert.deepEqual(packet.json, {
    packet_path: join(initJson.trace_dir, "seam-walk-packet.json")
  });

  const concurrent = await runPythonJson(seamWalkbackStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--run-id",
    "seam-walkback-review-competing"
  ]);
  assert.equal(concurrent.exitCode, 2);
  const concurrentJson = concurrent.json as { reason: string; status: string };
  assert.equal(concurrentJson.status, "error");
  assert.equal(concurrentJson.reason, "concurrent-seam-walk");

  const terminalRecord = join(tempDir, "final-walkback.json");
  await writeFile(
    terminalRecord,
    JSON.stringify(
      {
        run_id: "seam-walkback-review-campaign",
        timestamp_utc: "2026-04-20T12:05:00Z",
        skill: "seam-walkback-review",
        phase: "final_walkback",
        worktree_root: tempDir,
        outcome_summary: "No actionable commit groups remained after archaeology.",
        terminal_state: "blocked"
      },
      null,
      2
    ),
    "utf8"
  );

  const terminalAppend = await runPythonJson(seamWalkbackStateScript, [
    "append-trace",
    "--trace-file",
    initJson.coordinator_file,
    "--record-file",
    terminalRecord
  ]);
  assert.equal(terminalAppend.exitCode, 0);
  const terminalJson = terminalAppend.json as { active_campaign_cleared: boolean; status: string };
  assert.equal(terminalJson.status, "ok");
  assert.equal(terminalJson.active_campaign_cleared, true);

  const fresh = await runPythonJson(seamWalkbackStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--run-id",
    "seam-walkback-review-next"
  ]);
  assert.equal(fresh.exitCode, 0);
});

test("seam walkback helper still classifies fix-shaped pivots without inline file lists", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-seam-walkback-"));

  await runGit(tempDir, ["init", "-b", "main"]);
  await runGit(tempDir, ["config", "user.name", "Coortex Tests"]);
  await runGit(tempDir, ["config", "user.email", "coortex-tests@example.com"]);
  await writeFile(join(tempDir, "base.txt"), "base\n", "utf8");
  await runGit(tempDir, ["add", "base.txt"]);
  await runGit(tempDir, ["commit", "-m", "feat: seed repo"]);
  await runGit(tempDir, ["checkout", "-b", "feature/seams"]);
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
    await writeFile(join(tempDir, name), `${name}\n`, "utf8");
  }
  await runGit(tempDir, ["add", "a.txt", "b.txt", "c.txt", "d.txt"]);
  await runGit(tempDir, ["commit", "-m", "fix: align seam ownership"]);

  const inventory = await runPythonJson(seamWalkbackStateScript, [
    "inventory",
    "--project-root",
    tempDir,
    "--base-ref",
    "main",
    "--max-commits",
    "5"
  ]);

  assert.equal(inventory.exitCode, 0);
  const json = inventory.json as {
    commits: Array<{
      subject: string;
      likely_pivot: boolean;
      file_count: number;
      files: string[];
      pivot_reasons: string[];
    }>;
  };
  assert.equal(json.commits[0]?.subject, "fix: align seam ownership");
  assert.equal(json.commits[0]?.file_count, 4);
  assert.deepEqual(json.commits[0]?.files, []);
  assert.equal(json.commits[0]?.likely_pivot, true);
  assert.deepEqual(json.commits[0]?.pivot_reasons, ["keyword:align", "type:fix-with-move"]);
});


test("coortex deslop helper resolves bounded scope from file lists and explicit paths", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-deslop-"));
  await mkdir(join(tempDir, "src", "cli"), { recursive: true });
  await mkdir(join(tempDir, "src", "tests"), { recursive: true });
  await writeFile(join(tempDir, "src", "cli", "commands.ts"), "export {};\n", "utf8");
  await writeFile(join(tempDir, "src", "tests", "cli.test.ts"), "export {};\n", "utf8");
  const changedFilesPath = join(tempDir, "changed-files.txt");
  await writeFile(
    changedFilesPath,
    [
      "# changed files",
      "src/cli/commands.ts",
      "",
      "src/tests/cli.test.ts",
      "src/cli/commands.ts"
    ].join("\n"),
    "utf8"
  );

  const result = await runPythonJson(aiSlopCleanerStateScript, [
    "resolve-scope",
    "--project-root",
    tempDir,
    "--changed-files-path",
    changedFilesPath,
    "--path",
    join(tempDir, "src", "cli", "commands.ts")
  ]);

  assert.equal(result.exitCode, 0);
  const json = result.json as { scope_files: string[]; file_count: number };
  assert.equal(json.file_count, 2);
  assert.deepEqual(json.scope_files, ["src/cli/commands.ts", "src/tests/cli.test.ts"]);
});

test("coortex deslop helper runs verification gates and records artifacts", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-deslop-"));
  const artifactDir = join(tempDir, "artifacts");

  const result = await runPythonJson(aiSlopCleanerStateScript, [
    "run-gates",
    "--project-root",
    tempDir,
    "--artifact-dir",
    artifactDir,
    "--gate",
    `pass::python -c "print('ok')"`,
    "--gate",
    `fail::python -c "import sys; sys.exit(3)"`
  ]);

  assert.equal(result.exitCode, 1);
  const json = result.json as {
    all_passed: boolean;
    artifact_dir: string;
    gates: Array<{ label: string; ok: boolean; exit_code: number; log_path: string | null }>;
  };
  assert.equal(json.all_passed, false);
  assert.equal(json.gates[0]?.label, "pass");
  assert.equal(json.gates[0]?.ok, true);
  assert.equal(json.gates[1]?.label, "fail");
  assert.equal(json.gates[1]?.ok, false);
  assert.equal(json.gates[1]?.exit_code, 3);
  assert.equal(json.artifact_dir, artifactDir);
  const passLog = await readFile(json.gates[0]!.log_path!, "utf8");
  const failLog = await readFile(json.gates[1]!.log_path!, "utf8");
  assert.match(passLog, /\$ python -c/);
  assert.match(passLog, /\[stdout\][\s\S]*ok/);
  assert.match(failLog, /\[stderr\]/);
});

test("coortex deslop helper supports expected exit codes for search-style gates", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-deslop-"));
  const artifactDir = join(tempDir, "artifacts");

  const result = await runPythonJson(aiSlopCleanerStateScript, [
    "run-gates",
    "--project-root",
    tempDir,
    "--artifact-dir",
    artifactDir,
    "--gate",
    `absence-check[expect=1]::python -c "import sys; sys.exit(1)"`,
    "--gate",
    `zero-or-two[expect=0,2]::python -c "import sys; sys.exit(2)"`
  ]);

  assert.equal(result.exitCode, 0);
  const json = result.json as {
    all_passed: boolean;
    gates: Array<{ label: string; ok: boolean; expected_exit_codes: number[]; exit_code: number }>;
  };
  assert.equal(json.all_passed, true);
  assert.deepEqual(json.gates[0]?.expected_exit_codes, [1]);
  assert.equal(json.gates[0]?.exit_code, 1);
  assert.equal(json.gates[0]?.ok, true);
  assert.deepEqual(json.gates[1]?.expected_exit_codes, [0, 2]);
  assert.equal(json.gates[1]?.exit_code, 2);
  assert.equal(json.gates[1]?.ok, true);
});

test("coortex deslop helper rejects malformed expect specs", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-deslop-"));

  const result = await runPythonJson(aiSlopCleanerStateScript, [
    "run-gates",
    "--project-root",
    tempDir,
    "--gate",
    `bad[expect=oops]::python -c "print('x')"`
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Invalid expect code/);
});

test("implementation coordinator helper emits current-work artifact paths", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-implementation-"));

  const result = await runPythonJson(implementationCoordinatorStateScript, [
    "paths",
    "--project-root",
    tempDir,
    "--run-id",
    "implementation-trace-helper"
  ]);

  assert.equal(result.exitCode, 0);
  const json = result.json as {
    run_id: string;
    project_root: string;
    trace_dir: string;
    packet_path: string;
    spec_review_path: string;
    implementation_handoff_path: string;
    return_review_path: string;
    closeout_path: string;
    gate_dir: string;
  };
  assert.equal(json.run_id, "implementation-trace-helper");
  assert.equal(json.project_root, tempDir);
  assert.equal(json.trace_dir, join(".coortex", "current-work", "implementation-trace-helper"));
  assert.equal(json.packet_path, join(json.trace_dir, "packet.json"));
  assert.equal(json.spec_review_path, join(json.trace_dir, "spec-review-output.json"));
  assert.equal(json.implementation_handoff_path, join(json.trace_dir, "implementation-handoff.json"));
  assert.equal(json.return_review_path, join(json.trace_dir, "return-review-output.json"));
  assert.equal(json.closeout_path, join(json.trace_dir, "closeout.json"));
  assert.equal(json.gate_dir, join(json.trace_dir, "gates"));
});

test("implementation coordinator helper validates handoff coverage against packet rows", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-implementation-"));
  const packetPath = join(tempDir, "packet.json");
  const handoffPath = join(tempDir, "implementation-handoff.json");

  await writeFile(
    packetPath,
    JSON.stringify(
      {
        mini_surface_review_packet: {
          packet_id: "current-work-helper-test",
          coverage_matrix: {
            rows: [
              { row_id: "canonical-paths" },
              { row_id: "handoff-validation" }
            ]
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    handoffPath,
    JSON.stringify(
      {
        implementation_handoff: {
          packet_path: packetPath,
          slice_id: "current-work-helper-test",
          status: "implemented",
          changed_files: [
            "src/hosts/codex/profile/skill-pack/implementation-coordinator/scripts/implementation_state.py"
          ],
          owning_seam: "implementation-coordinator current-work helper",
          scope_evidence: {
            inside_packet_scope: true,
            out_of_scope_changes: []
          },
          coverage_row_evidence: [
            { row_id: "canonical-paths", evidence: "paths command tested", gaps: "none" },
            { row_id: "handoff-validation", evidence: "valid and invalid handoffs tested", gaps: "none" }
          ],
          verification: {
            build_or_typecheck: "npm run build",
            local_quality_gates: "git diff --check",
            targeted_tests: "node --test dist/__tests__/review-workflow-state.test.js",
            broader_tests_if_required: "not required"
          },
          self_deslop: "complete",
          self_review: "complete",
          deferred_threads: "none",
          residual_risks: "none"
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const valid = await runPythonJson(implementationCoordinatorStateScript, [
    "validate-handoff",
    "--packet-file",
    packetPath,
    "--handoff-file",
    handoffPath
  ]);

  assert.equal(valid.exitCode, 0);
  const validJson = valid.json as { valid: boolean; coverage_row_ids: string[] };
  assert.equal(validJson.valid, true);
  assert.deepEqual(validJson.coverage_row_ids, ["canonical-paths", "handoff-validation"]);

  const invalidPath = join(tempDir, "invalid-handoff.json");
  await writeFile(
    invalidPath,
    JSON.stringify(
      {
        implementation_handoff: {
          packet_path: packetPath,
          slice_id: "current-work-helper-test",
          status: "implemented",
          changed_files: ["src/example.ts"],
          owning_seam: "implementation-coordinator current-work helper",
          scope_evidence: {
            inside_packet_scope: true,
            out_of_scope_changes: []
          },
          coverage_row_evidence: [
            { row_id: "canonical-paths", evidence: "paths command tested", gaps: "none" },
            { row_id: "unknown-row", evidence: "unexpected evidence", gaps: "none" }
          ],
          verification: {
            build_or_typecheck: "npm run build",
            local_quality_gates: "git diff --check",
            targeted_tests: "node --test dist/__tests__/review-workflow-state.test.js",
            broader_tests_if_required: "not required"
          },
          self_deslop: "complete",
          self_review: "complete",
          deferred_threads: "none",
          residual_risks: "none"
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const invalid = await runPythonJson(implementationCoordinatorStateScript, [
    "validate-handoff",
    "--packet-file",
    packetPath,
    "--handoff-file",
    invalidPath
  ]);
  assert.equal(invalid.exitCode, 1);
  const invalidJson = invalid.json as { valid: boolean; errors: string[] };
  assert.equal(invalidJson.valid, false);
  assert.match(invalidJson.errors.join("\n"), /missing coverage row evidence: handoff-validation/);
  assert.match(invalidJson.errors.join("\n"), /unknown coverage row evidence: unknown-row/);
});

test("implementation coordinator helper validates and writes closeouts", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-implementation-"));
  const closeoutPath = join(tempDir, "closeout-input.json");

  await writeFile(
    closeoutPath,
    JSON.stringify(
      {
        closeout_report: {
          produced_artifacts: ["packet.json", "implementation-handoff.json"],
          explicit_claims: ["Implementation helper validates current-work artifacts."],
          evidence: ["node --test dist/__tests__/review-workflow-state.test.js"],
          continuation_rounds: [],
          first_ready_point: "after return-review approval",
          commit_or_install_disposition: "not requested",
          residual_risks: []
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const valid = await runPythonJson(implementationCoordinatorStateScript, [
    "validate-closeout",
    "--closeout-file",
    closeoutPath
  ]);

  assert.equal(valid.exitCode, 0);
  assert.deepEqual(valid.json, { errors: [], valid: true });

  const written = await runPythonJson(implementationCoordinatorStateScript, [
    "write-closeout",
    "--project-root",
    tempDir,
    "--run-id",
    "implementation-trace-helper",
    "--input",
    closeoutPath
  ]);

  assert.equal(written.exitCode, 0);
  const writtenJson = written.json as { path: string; valid: boolean; written: boolean };
  assert.equal(writtenJson.valid, true);
  assert.equal(writtenJson.written, true);
  assert.equal(writtenJson.path, join(".coortex", "current-work", "implementation-trace-helper", "closeout.json"));
  const persisted = JSON.parse(await readFile(join(tempDir, writtenJson.path), "utf8")) as {
    closeout_report: { explicit_claims: string[] };
  };
  assert.deepEqual(persisted.closeout_report.explicit_claims, [
    "Implementation helper validates current-work artifacts."
  ]);

  const invalidPath = join(tempDir, "invalid-closeout.json");
  await writeFile(
    invalidPath,
    JSON.stringify(
      {
        closeout_report: {
          produced_artifacts: [],
          explicit_claims: ["Incomplete closeout."],
          evidence: [],
          continuation_rounds: [],
          first_ready_point: "",
          commit_or_install_disposition: "not requested",
          residual_risks: []
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const invalid = await runPythonJson(implementationCoordinatorStateScript, [
    "validate-closeout",
    "--closeout-file",
    invalidPath
  ]);
  assert.equal(invalid.exitCode, 1);
  const invalidJson = invalid.json as { valid: boolean; errors: string[] };
  assert.equal(invalidJson.valid, false);
  assert.match(invalidJson.errors.join("\n"), /produced_artifacts/);
  assert.match(invalidJson.errors.join("\n"), /evidence/);
  assert.match(invalidJson.errors.join("\n"), /first_ready_point/);
});

test("return review helper marks scope-excluded non-started families as dormant and excludes them from the refreshed handoff by default", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-workflow-state-"));
  const reviewHandoffPath = join(tempDir, "review-handoff.json");
  const reviewReturnHandoffPath = join(tempDir, "review-return-handoff.json");
  const classificationPath = join(tempDir, "classification.json");
  const carriedPath = join(tempDir, "carried.json");

  await writeFile(
    reviewHandoffPath,
    JSON.stringify(
      {
        review_handoff: {
          review_target: {
            mode: "return-review",
            scope_summary: "test"
          },
          families: [
            {
              family_id: "F05",
              severity: "HIGH",
              title: "Reclaim adoption still lacks durable owner fencing",
              manifestations: [
                "src/adapters/host-run-store.ts:56",
                "src/adapters/host-run-session-coordinator.ts:164"
              ],
              review_hints: {
                likely_owning_seam: "src/adapters/host-run-store.ts",
                candidate_write_set: [
                  "src/adapters/host-run-store.ts",
                  "src/adapters/host-run-session-coordinator.ts"
                ]
              }
            }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    reviewReturnHandoffPath,
    JSON.stringify(
      {
        review_return_handoff: {
          original_review_target: {
            mode: "return-review",
            scope_summary: "test"
          },
          families: [],
          deferred_families: [
            {
              family_id: "F05",
              status: "family-still-open",
              defer_reason_kind: "user-scope-excluded",
              touch_state: "not-started",
              reason: "Explicitly excluded from this corrective slice.",
              actionable_when: "User later re-includes this family.",
              blocking_family_ids: "none"
            }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const classify = await execFileAsync("python", [
    returnReviewStateScript,
    "classify-deferred",
    "--review-handoff",
    reviewHandoffPath,
    "--review-return-handoff",
    reviewReturnHandoffPath,
    "--changed-file",
    "src/cli/run-reconciliation.ts"
  ]);
  const classification = JSON.parse(classify.stdout) as {
    deferred_family_classification: Array<{
      family_id: string;
      classification: string;
      actionability: string;
    }>;
  };

  assert.deepEqual(classification.deferred_family_classification, [
    {
      family_id: "F05",
      defer_reason_kind: "user-scope-excluded",
      touch_state: "not-started",
      classification: "carry-forward-without-lane",
      classification_reason:
        "actual diff does not materially overlap the deferred family's likely paths and no handled blocker forces reevaluation",
      actionability: "dormant-open-family",
      actionability_reason:
        "family stayed open for visibility, but this slice explicitly excluded it and the current diff does not reactivate it",
      overlap_files: [],
      owning_seam_touched: false,
      blocking_family_ids_in_slice: []
    }
  ]);

  await writeFile(classificationPath, JSON.stringify(classification, null, 2), "utf8");

  const carried = await execFileAsync("python", [
    returnReviewStateScript,
    "build-carried-handoff",
    "--review-handoff",
    reviewHandoffPath,
    "--review-return-handoff",
    reviewReturnHandoffPath,
    "--classification-json",
    classificationPath,
    "--output",
    carriedPath,
    "--summary"
  ]);
  const carriedSummary = JSON.parse(carried.stdout) as {
    family_ids_carried_forward: string[];
    family_ids_excluded_as_dormant: string[];
  };
  const carriedHandoff = JSON.parse(await readFile(carriedPath, "utf8")) as {
    review_handoff: { families: Array<unknown> };
  };

  assert.deepEqual(carriedSummary.family_ids_carried_forward, []);
  assert.deepEqual(carriedSummary.family_ids_excluded_as_dormant, ["F05"]);
  assert.deepEqual(carriedHandoff.review_handoff.families, []);
});

test("build-carried-handoff normalizes broader cross-family defer context without leaking reviewer follow-up fields", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-workflow-state-"));
  const reviewHandoffPath = join(tempDir, "review-handoff.json");
  const reviewReturnHandoffPath = join(tempDir, "review-return-handoff.json");
  const classificationPath = join(tempDir, "classification.json");
  const carriedPath = join(tempDir, "carried.json");

  await writeFile(
    reviewHandoffPath,
    JSON.stringify(
      {
        review_handoff: {
          review_target: {
            mode: "return-review",
            scope_summary: "test"
          },
          families: [
            {
              family_id: "F11",
              severity: "HIGH",
              title: "Stale-run idempotence lacks durable run identity",
              highest_confidence_root_cause:
                "Reconciliation still keys stale attempts off projected state and timestamps.",
              source_surfaces: ["run-reconciliation"],
              manifestations: ["src/cli/run-reconciliation.ts:914"],
              immediate_implications: ["Later stale retries can collapse into earlier repairs."],
              broader_implications: ["Per-instance stale recovery diagnostics can be suppressed."],
              sibling_bugs: ["Telemetry still shares the same stale identity assumptions."],
              sibling_search_scope: ["src/cli/run-reconciliation.ts"],
              closure_status: "family-still-open",
              open_reason_kind: "family-local-gap-remaining",
              thin_areas: ["live stale retry reproducer not executed"],
              review_hints: {
                likely_owning_seam: "src/cli/run-reconciliation.ts",
                candidate_write_set: ["src/cli/run-reconciliation.ts"]
              },
              closure_gate: {
                remediation_item: "rekey stale idempotence on a durable run identity",
                closure_checklist: ["later stale retries remain distinguishable"],
                required_sibling_tests: ["snapshot fallback retains per-instance identity"],
                doc_closure: ["update recovery invariants when identity semantics change"],
                reviewer_stop_conditions: ["reject if timestamps remain authoritative"]
              },
              next_step: {
                kind: "follow-up-fix",
                action: "rekey stale idempotence on a durable run identity",
                required_environment: "none",
                expected_evidence: ["updated reconciliation code and coverage"],
                reevaluate_when: ["the next fixer slice starts for this family"]
              }
            }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    reviewReturnHandoffPath,
    JSON.stringify(
      {
        review_return_handoff: {
          original_review_target: {
            mode: "return-review",
            scope_summary: "test"
          },
          families: [
            {
              original_family_id: "F07",
              claimed_closure_status: "family-closed",
              open_reason_kind: null,
              touched_write_set: ["src/cli/run-reconciliation.ts"],
              touched_tests: ["src/__tests__/host-run-recovery-matrix.test.ts"],
              touched_docs: [],
              closure_gate_checked: [],
              emergent_threads_followed: [],
              emergent_threads_deferred: [],
              residual_risks: [],
              touched_build_gate: {
                command: "npm run build",
                scope: "touched package",
                status: "green",
                evidence: "ran before targeted tests"
              },
              local_quality_gates: [
                {
                  name: "static-analysis",
                  command: "repo-configured static analysis",
                  status: "green",
                  evidence: "local quality gate ran before targeted tests"
                }
              ],
              verification_run: ["broader_suite_status: green"]
            }
          ],
          deferred_families: [
            {
              family_id: "F11",
              status: "family-still-open",
              defer_reason_kind: "blocked-by-broader-contract-change",
              touch_state: "broader-cross-family-overlap",
              reason:
                "Still open because stale-run identity now points to a broader durability contract across recovery and telemetry.",
              actionable_when:
                "A later slice explicitly takes the durable stale-attempt identity contract.",
              reviewer_next_step: {
                kind: "follow-up-review",
                action:
                  "Verify whether stale-run retries remain distinguishable after the broader identity contract change.",
                required_environment: "none",
                expected_evidence: ["return review of stale retry coverage"],
                reevaluate_when: ["a later return-review slice targets stale-run identity"]
              },
              blocking_family_ids: ["F07"]
            }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    classificationPath,
    JSON.stringify(
      {
        deferred_family_classification: [
          {
            family_id: "F11",
            defer_reason_kind: "blocked-by-broader-contract-change",
            touch_state: "broader-cross-family-overlap",
            classification: "requires-broader-cross-family-review",
            classification_reason:
              "defer state indicates the remaining issue crosses a broader shared contract or seam",
            actionability: "actionable-for-next-fixer",
            actionability_reason:
              "family remains suitable for the next fixer handoff under the current defer classification",
            overlap_files: ["src/cli/run-reconciliation.ts"],
            owning_seam_touched: true,
            blocking_family_ids_in_slice: ["F07"]
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const carried = await runPythonJson(returnReviewStateScript, [
    "build-carried-handoff",
    "--review-handoff",
    reviewHandoffPath,
    "--review-return-handoff",
    reviewReturnHandoffPath,
    "--classification-json",
    classificationPath,
    "--include-classification",
    "requires-broader-cross-family-review",
    "--output",
    carriedPath,
    "--summary"
  ]);

  assert.equal(carried.exitCode, 0);
  const carriedSummary = carried.json as {
    family_ids_carried_forward: string[];
    family_ids_excluded_as_dormant: string[];
  };
  const carriedHandoff = JSON.parse(await readFile(carriedPath, "utf8")) as {
    review_handoff: {
      families: Array<Record<string, unknown>>;
      seam_summary: unknown;
    };
  };

  assert.deepEqual(carriedSummary.family_ids_carried_forward, ["F11"]);
  assert.deepEqual(carriedSummary.family_ids_excluded_as_dormant, []);
  assert.equal(carriedHandoff.review_handoff.families.length, 1);
  const family = carriedHandoff.review_handoff.families[0];
  assert.ok(family);
  assert.equal(family.family_id, "F11");
  assert.equal(family.closure_status, "family-still-open");
  assert.equal(family.open_reason_kind, "broader-cross-family-contract");
  assert.deepEqual(carriedHandoff.review_handoff.seam_summary, {
    hot_seams: [
      {
        seam: "src/cli/run-reconciliation.ts",
        family_ids: ["F11"],
        family_count: 1,
        highest_severity: "HIGH",
        source_surfaces: ["run-reconciliation"],
        secondary_seam_mentions: [],
        hot: true,
        hot_reason: "a high-severity family points at this likely owning seam"
      }
    ],
    all_seams: [
      {
        seam: "src/cli/run-reconciliation.ts",
        family_ids: ["F11"],
        family_count: 1,
        highest_severity: "HIGH",
        source_surfaces: ["run-reconciliation"],
        secondary_seam_mentions: [],
        hot: true,
        hot_reason: "a high-severity family points at this likely owning seam"
      }
    ],
    families_without_owning_seam: []
  });
  assert.deepEqual(family.carry_forward_context, {
    reason_kind: "blocked-by-broader-contract-change",
    touch_state: "broader-cross-family-overlap",
    reason:
      "Still open because stale-run identity now points to a broader durability contract across recovery and telemetry.",
    actionable_when:
      "A later slice explicitly takes the durable stale-attempt identity contract.",
    blocking_family_ids: ["F07"]
  });
  assert.deepEqual(family.next_step, {
    kind: "follow-up-fix",
    action: "rekey stale idempotence on a durable run identity",
    required_environment: "none",
    expected_evidence: ["updated reconciliation code and coverage"],
    reevaluate_when: ["the next fixer slice starts for this family"]
  });
  assert.ok(!("reviewer_next_step" in family));
});

test("summarize-seams aggregates families by likely owning seam and preserves adjacent seam hints", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-seam-summary-"));
  const reviewHandoffPath = join(tempDir, "review-handoff.json");

  await writeFile(
    reviewHandoffPath,
    JSON.stringify(
      {
        review_handoff: {
          review_target: {
            mode: "branch",
            scope_summary: "test"
          },
          families: [
            {
              family_id: "F01",
              severity: "HIGH",
              source_surfaces: ["cli-lifecycle-reconciliation"],
              review_hints: {
                likely_owning_seam: "src/cli/run-reconciliation.ts",
                secondary_seams: [
                  "src/recovery/brief.ts",
                  "src/cli/run-reconciliation.ts"
                ]
              }
            },
            {
              family_id: "F02",
              severity: "MEDIUM",
              source_surfaces: ["cli-operator-surfaces"],
              review_hints: {
                likely_owning_seam: "src/cli/run-reconciliation.ts"
              }
            },
            {
              family_id: "F03",
              severity: "LOW",
              source_surfaces: ["codex-reference-adapter"],
              review_hints: {
                likely_owning_seam: "src/hosts/codex/adapter/envelope.ts",
                secondary_seams: ["src/hosts/codex/adapter/prompt.ts"]
              }
            },
            {
              family_id: "F04",
              severity: "LOW",
              source_surfaces: ["runtime-authority"]
            }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const result = await runPythonJson(returnReviewStateScript, [
    "summarize-seams",
    "--review-handoff",
    reviewHandoffPath
  ]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.json, {
    seam_summary: {
      hot_seams: [
        {
          seam: "src/cli/run-reconciliation.ts",
          family_ids: ["F01", "F02"],
          family_count: 2,
          highest_severity: "HIGH",
          source_surfaces: ["cli-lifecycle-reconciliation", "cli-operator-surfaces"],
          secondary_seam_mentions: ["src/recovery/brief.ts"],
          hot: true,
          hot_reason: "multiple families converge on the same likely owning seam"
        }
      ],
      all_seams: [
        {
          seam: "src/cli/run-reconciliation.ts",
          family_ids: ["F01", "F02"],
          family_count: 2,
          highest_severity: "HIGH",
          source_surfaces: ["cli-lifecycle-reconciliation", "cli-operator-surfaces"],
          secondary_seam_mentions: ["src/recovery/brief.ts"],
          hot: true,
          hot_reason: "multiple families converge on the same likely owning seam"
        },
        {
          seam: "src/hosts/codex/adapter/envelope.ts",
          family_ids: ["F03"],
          family_count: 1,
          highest_severity: "LOW",
          source_surfaces: ["codex-reference-adapter"],
          secondary_seam_mentions: ["src/hosts/codex/adapter/prompt.ts"],
          hot: false,
          hot_reason: "none"
        }
      ],
      families_without_owning_seam: ["F04"]
    }
  });
});

test("full-review baseline helper prefers a working .coortex baseline over docs fallback", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-baseline-"));
  await mkdir(join(tempDir, ".coortex"), { recursive: true });
  await mkdir(join(tempDir, "docs"), { recursive: true });

  const workingBaseline = join(tempDir, ".coortex", "review-baseline.yaml");
  const docsBaseline = join(tempDir, "docs", "review-baseline.yaml");
  await writeFile(workingBaseline, "baseline_version: 1\n", "utf8");
  await writeFile(docsBaseline, "baseline_version: 1\n", "utf8");

  const result = await runPythonJson(returnReviewStateScript, [
    "resolve-full-review-baseline",
    "--project-root",
    tempDir
  ]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.json, {
    mode: "full-discovery-review",
    baseline_resolved: true,
    baseline_path: workingBaseline,
    resolution_source: "working-primary"
  });
});

test("full-review baseline helper falls back to docs baseline when no working baseline exists", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-baseline-"));
  await mkdir(join(tempDir, "docs"), { recursive: true });

  const docsBaseline = join(tempDir, "docs", "review-baseline.yaml");
  await writeFile(docsBaseline, "baseline_version: 1\n", "utf8");

  const result = await runPythonJson(returnReviewStateScript, [
    "resolve-full-review-baseline",
    "--project-root",
    tempDir
  ]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.json, {
    mode: "full-discovery-review",
    baseline_resolved: true,
    baseline_path: docsBaseline,
    resolution_source: "docs-primary"
  });
});

test("full-review baseline helper respects an explicit baseline path over automatic resolution", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-baseline-"));
  await mkdir(join(tempDir, ".coortex", "review-baselines"), { recursive: true });
  await mkdir(join(tempDir, "docs"), { recursive: true });

  const explicitBaseline = join(tempDir, ".coortex", "review-baselines", "branch.yaml");
  const docsBaseline = join(tempDir, "docs", "review-baseline.yaml");
  await writeFile(explicitBaseline, "baseline_version: 1\n", "utf8");
  await writeFile(docsBaseline, "baseline_version: 1\n", "utf8");

  const result = await runPythonJson(returnReviewStateScript, [
    "resolve-full-review-baseline",
    "--project-root",
    tempDir,
    "--explicit-path",
    ".coortex/review-baselines/branch.yaml"
  ]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.json, {
    mode: "full-discovery-review",
    baseline_resolved: true,
    baseline_path: explicitBaseline,
    resolution_source: "explicit-path"
  });
});

test("full-review baseline helper reports missing candidates when no baseline is present", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-baseline-"));

  const result = await runPythonJson(returnReviewStateScript, [
    "resolve-full-review-baseline",
    "--project-root",
    tempDir
  ]);

  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.json, {
    mode: "full-discovery-review",
    baseline_resolved: false,
    errors: [
      "no full-review baseline was found via explicit path, .coortex/review-baseline.yaml, docs/review-baseline.yaml, or doc/review-baseline.yaml"
    ],
    candidates_checked: [
      join(tempDir, ".coortex", "review-baseline.yaml"),
      join(tempDir, "docs", "review-baseline.yaml"),
      join(tempDir, "doc", "review-baseline.yaml")
    ]
  });
});

test("review baseline validator accepts a standalone variant with a primary pointer", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-baseline-"));
  await mkdir(join(tempDir, "docs", "review-baselines"), { recursive: true });
  await mkdir(join(tempDir, "src", "recovery"), { recursive: true });
  await mkdir(join(tempDir, "src", "__tests__"), { recursive: true });

  await writeFile(join(tempDir, "src", "recovery", "state.ts"), "export {};\n", "utf8");
  await writeFile(join(tempDir, "src", "__tests__", "recovery.test.ts"), "test.todo('x');\n", "utf8");
  await writeFile(join(tempDir, "docs", "runtime-state-model.md"), "# Runtime\n", "utf8");

  const primaryBaseline = join(tempDir, "docs", "review-baseline.yaml");
  const variantBaseline = join(tempDir, "docs", "review-baselines", "runtime-targeted.yaml");

  await writeFile(
    primaryBaseline,
    `baseline_version: 1
updated_at: "2026-04-26"
baseline_kind: "primary"
alternative_baselines:
  - id: "runtime-targeted"
    name: "Runtime Targeted"
    purpose: "Finer runtime/recovery review with fewer lenses"
    path: "docs/review-baselines/runtime-targeted.yaml"
    when_to_use:
      - "reviews limited to runtime/recovery seams"
surfaces:
  - id: "runtime-recovery"
    name: "Runtime Recovery"
    purpose: "Recovery correctness"
    primary_anchors:
      - "src/recovery/**"
    supporting_anchors:
      - "src/__tests__/recovery.test.ts"
    contract_docs:
      - "docs/runtime-state-model.md"
    configured_builtin_lenses:
      - lens_id: "goal-fidelity"
        priority: "high"
    configured_custom_lenses: []
`,
    "utf8"
  );

  await writeFile(
    variantBaseline,
    `baseline_version: 1
updated_at: "2026-04-26"
baseline_kind: "variant"
variant_strategy: "derived"
variant_id: "runtime-targeted"
variant_name: "Runtime Targeted"
variant_purpose: "Finer runtime/recovery review with fewer lenses"
variant_when_to_use:
  - "reviews limited to runtime/recovery seams"
derived_from: "docs/review-baseline.yaml"
surfaces:
  - id: "runtime-projection"
    name: "Runtime Projection"
    purpose: "Projection truth"
    primary_anchors:
      - "src/recovery/**"
    supporting_anchors:
      - "src/__tests__/recovery.test.ts"
    contract_docs:
      - "docs/runtime-state-model.md"
    review_focus_areas:
      - "provenance must track launch vs resume vs recovery correctly"
    configured_builtin_lenses:
      - lens_id: "goal-fidelity"
        priority: "high"
    configured_custom_lenses: []
`,
    "utf8"
  );

  const result = await runPythonJson(returnReviewStateScript, [
    "validate-review-baseline",
    "--project-root",
    tempDir,
    "--baseline",
    "docs/review-baselines/runtime-targeted.yaml",
    "--expect-kind",
    "variant",
    "--primary-baseline",
    "docs/review-baseline.yaml"
  ]);

  assert.equal(result.exitCode, 0);
  const json = result.json as {
    baseline_valid: boolean;
    baseline_kind: string;
    primary_pointer_valid: boolean;
    surface_ids: string[];
  };
  assert.equal(json.baseline_valid, true);
  assert.equal(json.baseline_kind, "variant");
  assert.equal(json.primary_pointer_valid, true);
  assert.deepEqual(json.surface_ids, ["runtime-projection"]);
});

test("review baseline validator rejects non-standalone or unregistered variants", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-baseline-"));
  await mkdir(join(tempDir, "docs", "review-baselines"), { recursive: true });
  await mkdir(join(tempDir, "src", "recovery"), { recursive: true });

  await writeFile(join(tempDir, "src", "recovery", "state.ts"), "export {};\n", "utf8");
  await writeFile(join(tempDir, "docs", "runtime-state-model.md"), "# Runtime\n", "utf8");

  await writeFile(
    join(tempDir, "docs", "review-baseline.yaml"),
    `baseline_version: 1
updated_at: "2026-04-26"
baseline_kind: "primary"
surfaces:
  - id: "runtime-recovery"
    name: "Runtime Recovery"
    purpose: "Recovery correctness"
    primary_anchors:
      - "src/recovery/**"
    supporting_anchors: []
    contract_docs:
      - "docs/runtime-state-model.md"
    configured_builtin_lenses:
      - lens_id: "goal-fidelity"
        priority: "high"
    configured_custom_lenses: []
`,
    "utf8"
  );

  await writeFile(
    join(tempDir, "docs", "review-baselines", "runtime-targeted.yaml"),
    `baseline_version: 1
updated_at: "2026-04-26"
baseline_kind: "variant"
variant_strategy: "derived"
variant_id: "runtime-targeted"
variant_name: "Runtime Targeted"
variant_purpose: "Finer runtime/recovery review with fewer lenses"
surfaces:
  - id: "runtime-projection"
    name: "Runtime Projection"
    purpose: "Projection truth"
    primary_anchors:
      - "src/recovery/**"
    supporting_anchors: []
    contract_docs:
      - "docs/runtime-state-model.md"
    configured_builtin_lenses:
      - lens_id: "goal-fidelity"
        priority: "high"
    configured_custom_lenses: []
`,
    "utf8"
  );

  const result = await runPythonJson(returnReviewStateScript, [
    "validate-review-baseline",
    "--project-root",
    tempDir,
    "--baseline",
    "docs/review-baselines/runtime-targeted.yaml",
    "--expect-kind",
    "variant",
    "--primary-baseline",
    "docs/review-baseline.yaml"
  ]);

  assert.equal(result.exitCode, 2);
  const json = result.json as { baseline_valid: boolean; errors: string[] };
  assert.equal(json.baseline_valid, false);
  assert.match(json.errors.join("\n"), /variant_when_to_use/);
  assert.match(json.errors.join("\n"), /derived_from/);
  assert.match(json.errors.join("\n"), /primary_baseline has no alternative_baselines entry/);

  await writeFile(
    join(tempDir, "docs", "review-baseline.yaml"),
    `baseline_version: 1
updated_at: "2026-04-26"
baseline_kind: "primary"
alternative_baselines:
  - id: "runtime-targeted"
    name: "Runtime Targeted"
    purpose: "Finer runtime/recovery review with fewer lenses"
    path: "docs/review-baselines/runtime-targeted.yaml"
    when_to_use:
      - "reviews limited to runtime/recovery seams"
surfaces:
  - id: "runtime-recovery"
    name: "Runtime Recovery"
    purpose: "Recovery correctness"
    primary_anchors:
      - "src/recovery/**"
    supporting_anchors: []
    contract_docs:
      - "docs/runtime-state-model.md"
    configured_builtin_lenses:
      - lens_id: "goal-fidelity"
        priority: "high"
    configured_custom_lenses: []
`,
    "utf8"
  );

  const primaryResult = await runPythonJson(returnReviewStateScript, [
    "validate-review-baseline",
    "--project-root",
    tempDir,
    "--baseline",
    "docs/review-baseline.yaml",
    "--expect-kind",
    "primary"
  ]);

  assert.equal(primaryResult.exitCode, 2);
  const primaryJson = primaryResult.json as { baseline_valid: boolean; errors: string[] };
  assert.equal(primaryJson.baseline_valid, false);
  assert.match(primaryJson.errors.join("\n"), /alternative_baselines\[0\]\.path .*variant_when_to_use/);
  assert.match(primaryJson.errors.join("\n"), /alternative_baselines\[0\]\.path .*derived_from/);
});

test("full-review narrowing helper resolves one inferred surface/path subset and normalizes run-local focus", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-narrowing-"));
  const baselinePath = join(tempDir, "baseline.json");

  await writeFile(
    baselinePath,
    JSON.stringify(
      {
        baseline_version: 1,
        updated_at: "2026-04-18",
        surfaces: [
          {
            id: "runtime-authority",
            name: "Runtime Authority",
            primary_anchors: ["src/core/**", "src/projections/**"],
            supporting_anchors: ["docs/runtime-state-model.md"],
            configured_builtin_lenses: [
              { lens_id: "goal-fidelity", priority: "high" },
              { lens_id: "context-history", priority: "medium" }
            ],
            configured_custom_lenses: []
          },
          {
            id: "cli-operator-surfaces",
            name: "CLI Operator Surfaces",
            primary_anchors: ["src/cli/**"],
            supporting_anchors: ["README.md"],
            configured_builtin_lenses: [{ lens_id: "quality", priority: "high" }],
            configured_custom_lenses: []
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const result = await runPythonJson(returnReviewStateScript, [
    "validate-full-review-narrowing",
    "--baseline-json",
    baselinePath,
    "--path-subset",
    "src/core/**",
    "--focus",
    "separation-of-concerns"
  ]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.json, {
    mode: "full-discovery-review",
    narrowing_valid: true,
    narrowing: {
      selected_surface_id: "runtime-authority",
      selected_surface_name: "Runtime Authority",
      path_subset: "src/core/**",
      requested_focus: ["soc"],
      configured_focus: [],
      run_local_focus: ["soc"],
      configured_builtin_lenses: ["goal-fidelity", "context-history"],
      configured_custom_lenses: [],
      path_subset_match_basis:
        "path_subset resolved uniquely inside the selected baseline surface anchors"
    }
  });
});

test("full-review narrowing helper allows built-in portability as run-local focus when the surface did not configure it", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-narrowing-"));
  const baselinePath = join(tempDir, "baseline.json");

  await writeFile(
    baselinePath,
    JSON.stringify(
      {
        baseline_version: 1,
        updated_at: "2026-04-19",
        surfaces: [
          {
            id: "runtime-authority",
            name: "Runtime Authority",
            primary_anchors: ["src/core/**"],
            supporting_anchors: ["docs/runtime-state-model.md"],
            configured_builtin_lenses: [
              { lens_id: "goal-fidelity", priority: "high" },
              { lens_id: "context-history", priority: "medium" }
            ],
            configured_custom_lenses: []
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const result = await runPythonJson(returnReviewStateScript, [
    "validate-full-review-narrowing",
    "--baseline-json",
    baselinePath,
    "--path-subset",
    "src/core/**",
    "--focus",
    "portability"
  ]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.json, {
    mode: "full-discovery-review",
    narrowing_valid: true,
    narrowing: {
      selected_surface_id: "runtime-authority",
      selected_surface_name: "Runtime Authority",
      path_subset: "src/core/**",
      requested_focus: ["portability"],
      configured_focus: [],
      run_local_focus: ["portability"],
      configured_builtin_lenses: ["goal-fidelity", "context-history"],
      configured_custom_lenses: [],
      path_subset_match_basis:
        "path_subset resolved uniquely inside the selected baseline surface anchors"
    }
  });
});

test("full-review narrowing helper recognizes built-in portability focus when the narrowed surface configures it", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-narrowing-"));
  const baselinePath = join(tempDir, "baseline.json");

  await writeFile(
    baselinePath,
    JSON.stringify(
      {
        baseline_version: 1,
        updated_at: "2026-04-18",
        surfaces: [
          {
            id: "runtime-authority",
            name: "Runtime Authority",
            primary_anchors: ["src/core/**"],
            supporting_anchors: ["docs/runtime-state-model.md"],
            configured_builtin_lenses: [
              { lens_id: "goal-fidelity", priority: "high" },
              { lens_id: "portability", priority: "high" }
            ],
            configured_custom_lenses: []
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const result = await runPythonJson(returnReviewStateScript, [
    "validate-full-review-narrowing",
    "--baseline-json",
    baselinePath,
    "--path-subset",
    "src/core/**",
    "--focus",
    "portability"
  ]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.json, {
    mode: "full-discovery-review",
    narrowing_valid: true,
    narrowing: {
      selected_surface_id: "runtime-authority",
      selected_surface_name: "Runtime Authority",
      path_subset: "src/core/**",
      requested_focus: ["portability"],
      configured_focus: ["portability"],
      run_local_focus: [],
      configured_builtin_lenses: ["goal-fidelity", "portability"],
      configured_custom_lenses: [],
      path_subset_match_basis:
        "path_subset resolved uniquely inside the selected baseline surface anchors"
    }
  });
});

test("full-review narrowing helper accepts a bare directory path subset inside one surface", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-narrowing-"));
  const baselinePath = join(tempDir, "baseline.json");

  await writeFile(
    baselinePath,
    JSON.stringify(
      {
        baseline_version: 1,
        updated_at: "2026-04-18",
        surfaces: [
          {
            id: "runtime-authority",
            name: "Runtime Authority",
            primary_anchors: ["src/core/**", "src/projections/**"],
            supporting_anchors: ["docs/runtime-state-model.md"],
            configured_builtin_lenses: [
              { lens_id: "goal-fidelity", priority: "high" },
              { lens_id: "context-history", priority: "medium" }
            ],
            configured_custom_lenses: []
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const result = await runPythonJson(returnReviewStateScript, [
    "validate-full-review-narrowing",
    "--baseline-json",
    baselinePath,
    "--path-subset",
    "src/core",
    "--focus",
    "soc"
  ]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.json, {
    mode: "full-discovery-review",
    narrowing_valid: true,
    narrowing: {
      selected_surface_id: "runtime-authority",
      selected_surface_name: "Runtime Authority",
      path_subset: "src/core",
      requested_focus: ["soc"],
      configured_focus: [],
      run_local_focus: ["soc"],
      configured_builtin_lenses: ["goal-fidelity", "context-history"],
      configured_custom_lenses: [],
      path_subset_match_basis:
        "path_subset resolved uniquely inside the selected baseline surface anchors"
    }
  });
});

test("full-review narrowing helper rejects incompatible surface/path combinations", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-narrowing-"));
  const baselinePath = join(tempDir, "baseline.json");

  await writeFile(
    baselinePath,
    JSON.stringify(
      {
        baseline_version: 1,
        updated_at: "2026-04-18",
        surfaces: [
          {
            id: "runtime-authority",
            name: "Runtime Authority",
            primary_anchors: ["src/core/**"],
            supporting_anchors: [],
            configured_builtin_lenses: [{ lens_id: "goal-fidelity", priority: "high" }],
            configured_custom_lenses: []
          },
          {
            id: "cli-operator-surfaces",
            name: "CLI Operator Surfaces",
            primary_anchors: ["src/cli/**"],
            supporting_anchors: [],
            configured_builtin_lenses: [{ lens_id: "quality", priority: "high" }],
            configured_custom_lenses: []
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const result = await runPythonJson(returnReviewStateScript, [
    "validate-full-review-narrowing",
    "--baseline-json",
    baselinePath,
    "--surface",
    "cli-operator-surfaces",
    "--path-subset",
    "src/core/**",
    "--focus",
    "soc"
  ]);

  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.json, {
    mode: "full-discovery-review",
    narrowing_valid: false,
    errors: [
      "path_subset 'src/core/**' does not fit inside the requested surface 'cli-operator-surfaces'"
    ]
  });
});

test("full-review narrowing helper rejects path subsets that overlap multiple surfaces", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-narrowing-"));
  const baselinePath = join(tempDir, "baseline.json");

  await writeFile(
    baselinePath,
    JSON.stringify(
      {
        baseline_version: 1,
        updated_at: "2026-04-18",
        surfaces: [
          {
            id: "runtime-authority",
            name: "Runtime Authority",
            primary_anchors: ["src/core/**"],
            supporting_anchors: [],
            configured_builtin_lenses: [{ lens_id: "goal-fidelity", priority: "high" }],
            configured_custom_lenses: []
          },
          {
            id: "shared-host-run-infra",
            name: "Shared Host Run Infra",
            primary_anchors: ["src/core/**"],
            supporting_anchors: [],
            configured_builtin_lenses: [{ lens_id: "quality", priority: "high" }],
            configured_custom_lenses: []
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const result = await runPythonJson(returnReviewStateScript, [
    "validate-full-review-narrowing",
    "--baseline-json",
    baselinePath,
    "--path-subset",
    "src/core/**"
  ]);

  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.json, {
    mode: "full-discovery-review",
    narrowing_valid: false,
    errors: [
      "path_subset 'src/core/**' overlaps multiple baseline surfaces and needs an explicit surface or baseline refresh"
    ]
  });
});

test("orchestrator packet mode validates discovery packets and respects the active seam-walk campaign", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-orchestrator-packet-"));
  const traceRoot = join(".coortex", "review-trace");

  await runGit(tempDir, ["init", "-b", "main"]);
  await runGit(tempDir, ["config", "user.name", "Coortex Tests"]);
  await runGit(tempDir, ["config", "user.email", "coortex-tests@example.com"]);
  await writeFile(join(tempDir, "base.txt"), "base\n", "utf8");
  await runGit(tempDir, ["add", "base.txt"]);
  await runGit(tempDir, ["commit", "-m", "feat: seed repo"]);
  const headSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tempDir })).stdout.trim();

  const seamInit = await runPythonJson(seamWalkbackStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--run-id",
    "seam-walkback-review-campaign"
  ]);
  assert.equal(seamInit.exitCode, 0);
  const seamInitJson = seamInit.json as { campaign_id?: string; run_id: string; trace_dir: string };

  const packetPath = join(seamInitJson.trace_dir, "seam-walk-packet.json");
  await writeFile(
    packetPath,
    JSON.stringify(
      {
        packet_type: "seam-walk-discovery",
        packet_version: 1,
        campaign: {
          campaign_id: seamInitJson.run_id,
          source_run_id: seamInitJson.run_id,
          worktree_root: tempDir,
          review_target: {
            mode: "branch",
            scope_summary: "branch delta against main"
          },
          base_ref: "main",
          merge_base: headSha,
          head_sha: headSha,
          baseline_path: ".coortex/review-baselines/m2-seams.yaml"
        },
        commit_groups: [
          {
            group_id: "G-001",
            label: "operator salvage diagnostics",
            scope_summary: "Read-only operator command warning handling",
            commit_shas: [headSha],
            files: ["src/cli/ctx.ts"],
            primary_seams: ["operator-command-surfaces"],
            review_grounded_signals: [
              {
                signal_id: "R-001",
                summary: "Status and inspect suppress salvage diagnostics after recovery warnings.",
                evidence: ["src/cli/ctx.ts:120-180"],
                candidate_family_ids: ["F-OP-001"]
              }
            ],
            deslop_advisory_signals: [
              {
                signal_id: "D-001",
                summary: "Operator surfaces still carry duplicated warning formatting glue.",
                evidence: ["src/cli/ctx.ts:140-176"],
                candidate_family_ids: ["F-OP-001"]
              }
            ],
            thin_areas: ["none"]
          }
        ],
        candidate_families: [
          {
            family_id: "F-OP-001",
            title: "Operator salvage diagnostics drift",
            candidate_root_cause: "Read-only operator surfaces diverged from the diagnostics-bearing recovery path.",
            source_group_ids: ["G-001"],
            review_grounded_signal_ids: ["R-001"],
            deslop_advisory_signal_ids: ["D-001"],
            likely_owning_seam: "operator-command-surfaces",
            secondary_seams: ["projection-recovery-warning-fidelity"],
            status: "candidate-open"
          }
        ],
        handoff: {
          mode: "exploration-only",
          requested_phases: ["prep", "coverage", "family-exploration", "synthesis"]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const validPacket = await runPythonJson(returnReviewStateScript, [
    "validate-discovery-packet",
    "--packet-file",
    packetPath,
    "--project-root",
    tempDir
  ]);
  assert.equal(validPacket.exitCode, 0);
  const validPacketJson = validPacket.json as {
    candidate_family_ids: string[];
    campaign_id: string;
    group_count: number;
    valid: boolean;
  };
  assert.equal(validPacketJson.valid, true);
  assert.equal(validPacketJson.campaign_id, seamInitJson.run_id);
  assert.equal(validPacketJson.group_count, 1);
  assert.deepEqual(validPacketJson.candidate_family_ids, ["F-OP-001"]);

  const blockedStandalone = await runPythonJson(returnReviewStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--mode",
    "full-review"
  ]);
  assert.equal(blockedStandalone.exitCode, 2);
  const blockedJson = blockedStandalone.json as { reason: string; status: string };
  assert.equal(blockedJson.status, "error");
  assert.equal(blockedJson.reason, "concurrent-review-campaign");

  const packetMode = await runPythonJson(returnReviewStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--mode",
    "packet-exploration",
    "--campaign-id",
    seamInitJson.run_id,
    "--run-id",
    "review-orchestrator-packet-20260420T120000Z"
  ]);
  assert.equal(packetMode.exitCode, 0);
  const packetModeJson = packetMode.json as { campaign_id: string; run_id: string };
  assert.equal(packetModeJson.campaign_id, seamInitJson.run_id);
  assert.equal(packetModeJson.run_id, "review-orchestrator-packet-20260420T120000Z");

  const prematureFinalWalkbackPath = join(tempDir, "premature-final-walkback.json");
  await writeFile(
    prematureFinalWalkbackPath,
    JSON.stringify(
      {
        run_id: seamInitJson.run_id,
        timestamp_utc: "2026-04-20T12:25:00Z",
        skill: "seam-walkback-review",
        phase: "final_walkback",
        worktree_root: tempDir,
        outcome_summary: "The packet is ready and the campaign completed cleanly.",
        terminal_state: "handoff-completed"
      },
      null,
      2
    ),
    "utf8"
  );
  const prematureFinalWalkback = await runPythonJson(seamWalkbackStateScript, [
    "append-trace",
    "--trace-file",
    join(tempDir, traceRoot, seamInitJson.run_id, "coordinator.jsonl"),
    "--record-file",
    prematureFinalWalkbackPath
  ]);
  assert.equal(prematureFinalWalkback.exitCode, 2);
  assert.deepEqual(prematureFinalWalkback.json, {
    active_campaign_cleared: false,
    appended: false,
    reason: "downstream-review-not-complete",
    status: "error",
    trace_file: join(tempDir, traceRoot, seamInitJson.run_id, "coordinator.jsonl")
  });

  const finalReviewPath = join(tempDir, "packet-final-review.json");
  const missingHandoffFinalReviewPath = join(tempDir, "packet-final-review-missing-handoff.json");
  await writeFile(
    missingHandoffFinalReviewPath,
    JSON.stringify(
      {
        run_id: packetModeJson.run_id,
        campaign_id: seamInitJson.run_id,
        timestamp_utc: "2026-04-20T12:28:00Z",
        skill: "review-orchestrator",
        mode: "packet-exploration",
        phase: "final_review",
        review_target: { mode: "branch", scope_summary: "test" },
        final_verdict: "REQUEST_CHANGES",
        actionable_family_ids: ["F-OP-001"],
        review_handoff_path: join(tempDir, traceRoot, packetModeJson.run_id, "review-handoff.json"),
        review_shape_trace_summary: { mode: "packet-exploration" },
        unexplored_area_ledger_summary: { areas: [] },
        boundedness_exceptions_summary: { exceptions: [] }
      },
      null,
      2
    ),
    "utf8"
  );
  const missingHandoffFinalReview = await runPythonJson(returnReviewStateScript, [
    "append-trace",
    "--trace-file",
    join(tempDir, traceRoot, packetModeJson.run_id, "coordinator.jsonl"),
    "--record-file",
    missingHandoffFinalReviewPath
  ]);
  assert.equal(missingHandoffFinalReview.exitCode, 2);
  assert.deepEqual(missingHandoffFinalReview.json, {
    appended: false,
    errors: ["trace record phase 'final_review' is actionable but no prior review_handoff_emitted record exists"],
    status: "error",
    trace_file: join(tempDir, traceRoot, packetModeJson.run_id, "coordinator.jsonl")
  });

  const handoffPathResult = await runPythonJson(returnReviewStateScript, [
    "handoff-path",
    "--trace-dir",
    join(tempDir, traceRoot, packetModeJson.run_id)
  ]);
  assert.equal(handoffPathResult.exitCode, 0);
  const handoffPathJson = handoffPathResult.json as { review_handoff_path: string };
  const handoffPath = handoffPathJson.review_handoff_path;
  assert.equal(handoffPath, join(tempDir, traceRoot, packetModeJson.run_id, "review-handoff.json"));

  const reviewHandoffSourcePath = join(tempDir, "packet-review-handoff-source.json");
  await writeFile(
    reviewHandoffSourcePath,
    JSON.stringify(validReviewHandoff("F-OP-001"), null, 2),
    "utf8"
  );
  const writeReviewHandoff = await runPythonJson(returnReviewStateScript, [
    "write-review-handoff",
    "--trace-dir",
    join(tempDir, traceRoot, packetModeJson.run_id),
    "--input-file",
    reviewHandoffSourcePath
  ]);
  assert.equal(writeReviewHandoff.exitCode, 0);
  assert.deepEqual(writeReviewHandoff.json, {
    family_ids: ["F-OP-001"],
    review_handoff_path: handoffPath
  });

  const mismatchedHandoffTraceRecordPath = join(tempDir, "packet-review-handoff-emitted-mismatch.json");
  await writeFile(
    mismatchedHandoffTraceRecordPath,
    JSON.stringify(
      {
        run_id: packetModeJson.run_id,
        campaign_id: seamInitJson.run_id,
        timestamp_utc: "2026-04-20T12:26:30Z",
        skill: "review-orchestrator",
        mode: "packet-exploration",
        phase: "review_handoff_emitted",
        review_target: { mode: "branch", scope_summary: "test" },
        path: handoffPath,
        family_ids: ["F-OTHER"],
        kind: "initial"
      },
      null,
      2
    ),
    "utf8"
  );
  const mismatchedHandoffTraceRecord = await runPythonJson(returnReviewStateScript, [
    "append-trace",
    "--trace-file",
    join(tempDir, traceRoot, packetModeJson.run_id, "coordinator.jsonl"),
    "--record-file",
    mismatchedHandoffTraceRecordPath
  ]);
  assert.equal(mismatchedHandoffTraceRecord.exitCode, 2);
  assert.deepEqual(mismatchedHandoffTraceRecord.json, {
    appended: false,
    errors: [
      "trace record phase 'review_handoff_emitted' family_ids must match the persisted review_handoff file"
    ],
    status: "error",
    trace_file: join(tempDir, traceRoot, packetModeJson.run_id, "coordinator.jsonl")
  });

  const handoffTraceRecordPath = join(tempDir, "packet-review-handoff-emitted.json");
  await writeFile(
    handoffTraceRecordPath,
    JSON.stringify(
      {
        run_id: packetModeJson.run_id,
        campaign_id: seamInitJson.run_id,
        timestamp_utc: "2026-04-20T12:27:00Z",
        skill: "review-orchestrator",
        mode: "packet-exploration",
        phase: "review_handoff_emitted",
        review_target: { mode: "branch", scope_summary: "test" },
        path: handoffPath,
        family_ids: ["F-OP-001"],
        kind: "initial"
      },
      null,
      2
    ),
    "utf8"
  );
  const handoffTraceRecord = await runPythonJson(returnReviewStateScript, [
    "append-trace",
    "--trace-file",
    join(tempDir, traceRoot, packetModeJson.run_id, "coordinator.jsonl"),
    "--record-file",
    handoffTraceRecordPath
  ]);
  assert.equal(handoffTraceRecord.exitCode, 0);

  await writeFile(handoffPath, JSON.stringify(validReviewHandoff("F-OTHER"), null, 2), "utf8");
  const mutatedFinalReviewPath = join(tempDir, "packet-final-review-mutated-handoff.json");
  await writeFile(
    mutatedFinalReviewPath,
    JSON.stringify(
      {
        run_id: packetModeJson.run_id,
        campaign_id: seamInitJson.run_id,
        timestamp_utc: "2026-04-20T12:27:30Z",
        skill: "review-orchestrator",
        mode: "packet-exploration",
        phase: "final_review",
        review_target: { mode: "branch", scope_summary: "test" },
        final_verdict: "REQUEST_CHANGES",
        actionable_family_ids: ["F-OP-001"],
        review_handoff_path: handoffPath,
        review_shape_trace_summary: { mode: "packet-exploration" },
        unexplored_area_ledger_summary: { areas: [] },
        boundedness_exceptions_summary: { exceptions: [] }
      },
      null,
      2
    ),
    "utf8"
  );
  const mutatedFinalReview = await runPythonJson(returnReviewStateScript, [
    "append-trace",
    "--trace-file",
    join(tempDir, traceRoot, packetModeJson.run_id, "coordinator.jsonl"),
    "--record-file",
    mutatedFinalReviewPath
  ]);
  assert.equal(mutatedFinalReview.exitCode, 2);
  assert.deepEqual(mutatedFinalReview.json, {
    appended: false,
    errors: [
      "trace record phase 'final_review' review_handoff_path family_ids must match actionable_family_ids"
    ],
    status: "error",
    trace_file: join(tempDir, traceRoot, packetModeJson.run_id, "coordinator.jsonl")
  });
  await writeFile(handoffPath, JSON.stringify(validReviewHandoff("F-OP-001"), null, 2), "utf8");

  await writeFile(
    finalReviewPath,
    JSON.stringify(
      {
        run_id: packetModeJson.run_id,
        campaign_id: seamInitJson.run_id,
        timestamp_utc: "2026-04-20T12:28:00Z",
        skill: "review-orchestrator",
        mode: "packet-exploration",
        phase: "final_review",
        review_target: { mode: "branch", scope_summary: "test" },
        final_verdict: "REQUEST_CHANGES",
        actionable_family_ids: ["F-OP-001"],
        review_handoff_path: handoffPath,
        review_shape_trace_summary: { mode: "packet-exploration" },
        unexplored_area_ledger_summary: { areas: [] },
        boundedness_exceptions_summary: { exceptions: [] }
      },
      null,
      2
    ),
    "utf8"
  );
  const finalReview = await runPythonJson(returnReviewStateScript, [
    "append-trace",
    "--trace-file",
    join(tempDir, traceRoot, packetModeJson.run_id, "coordinator.jsonl"),
    "--record-file",
    finalReviewPath
  ]);
  assert.equal(finalReview.exitCode, 0);

  const finalWalkbackPath = join(tempDir, "final-walkback.json");
  await writeFile(
    finalWalkbackPath,
    JSON.stringify(
      {
        run_id: seamInitJson.run_id,
        timestamp_utc: "2026-04-20T12:30:00Z",
        skill: "seam-walkback-review",
        phase: "final_walkback",
        worktree_root: tempDir,
        outcome_summary: "The discovery campaign emitted a packet and the coordinator accepted the handoff.",
        terminal_state: "handoff-completed"
      },
      null,
      2
    ),
    "utf8"
  );
  const completedWalkback = await runPythonJson(seamWalkbackStateScript, [
    "append-trace",
    "--trace-file",
    join(tempDir, traceRoot, seamInitJson.run_id, "coordinator.jsonl"),
    "--record-file",
    finalWalkbackPath
  ]);
  assert.equal(completedWalkback.exitCode, 0);
  assert.deepEqual(completedWalkback.json, {
    active_campaign_cleared: true,
    active_campaign_update: null,
    appended: true,
    status: "ok",
    trace_file: join(tempDir, traceRoot, seamInitJson.run_id, "coordinator.jsonl")
  });

  const standaloneAfterTerminal = await runPythonJson(returnReviewStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--mode",
    "full-review",
    "--run-id",
    "review-orchestrator-full-review-20260420T130000Z"
  ]);
  assert.equal(standaloneAfterTerminal.exitCode, 0);
});

test("seam walk handoff-completed requires downstream handoff artifact when no clean no-actionable outcome exists", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-seam-walk-handoff-artifact-"));
  const traceRoot = join(".coortex", "review-trace");

  const seamInit = await runPythonJson(seamWalkbackStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--run-id",
    "seam-walkback-review-20260423T090000Z"
  ]);
  assert.equal(seamInit.exitCode, 0);
  const seamInitJson = seamInit.json as { run_id: string };

  const packetMode = await runPythonJson(returnReviewStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--mode",
    "packet-exploration",
    "--campaign-id",
    seamInitJson.run_id,
    "--run-id",
    "review-orchestrator-packet-20260423T091000Z"
  ]);
  assert.equal(packetMode.exitCode, 0);
  const packetModeJson = packetMode.json as { run_id: string };

  const finalReviewPath = join(tempDir, "packet-final-review-blocked.json");
  await writeFile(
    finalReviewPath,
    JSON.stringify(
      {
        run_id: packetModeJson.run_id,
        campaign_id: seamInitJson.run_id,
        timestamp_utc: "2026-04-23T09:12:00Z",
        skill: "review-orchestrator",
        mode: "packet-exploration",
        phase: "final_review",
        review_target: { mode: "branch", scope_summary: "test" },
        final_verdict: "BLOCKED",
        review_shape_trace_summary: { mode: "packet-exploration" },
        unexplored_area_ledger_summary: { areas: [] },
        boundedness_exceptions_summary: { exceptions: [] }
      },
      null,
      2
    ),
    "utf8"
  );
  const finalReview = await runPythonJson(returnReviewStateScript, [
    "append-trace",
    "--trace-file",
    join(tempDir, traceRoot, packetModeJson.run_id, "coordinator.jsonl"),
    "--record-file",
    finalReviewPath
  ]);
  assert.equal(finalReview.exitCode, 0);

  const finalWalkbackPath = join(tempDir, "final-walkback-missing-review-handoff.json");
  await writeFile(
    finalWalkbackPath,
    JSON.stringify(
      {
        run_id: seamInitJson.run_id,
        timestamp_utc: "2026-04-23T09:13:00Z",
        skill: "seam-walkback-review",
        phase: "final_walkback",
        worktree_root: tempDir,
        outcome_summary: "The orchestrator finished, but no downstream handoff artifact was written.",
        terminal_state: "handoff-completed"
      },
      null,
      2
    ),
    "utf8"
  );
  const finalWalkback = await runPythonJson(seamWalkbackStateScript, [
    "append-trace",
    "--trace-file",
    join(tempDir, traceRoot, seamInitJson.run_id, "coordinator.jsonl"),
    "--record-file",
    finalWalkbackPath
  ]);
  assert.equal(finalWalkback.exitCode, 2);
  assert.deepEqual(finalWalkback.json, {
    active_campaign_cleared: false,
    appended: false,
    reason: "missing-review-handoff-artifact",
    status: "error",
    trace_file: join(tempDir, traceRoot, seamInitJson.run_id, "coordinator.jsonl")
  });
});

test("orchestrator targeted return review can run inside an active fixer campaign", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-orchestrator-fixer-"));
  const traceRoot = join(".coortex", "review-trace");

  const fixerInit = await runPythonJson(fixResultStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--run-id",
    "fixer-orchestrator-campaign"
  ]);
  assert.equal(fixerInit.exitCode, 0);
  const fixerInitJson = fixerInit.json as {
    coordinator_file: string;
    run_id: string;
  };

  const blockedStandalone = await runPythonJson(returnReviewStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--mode",
    "full-review"
  ]);
  assert.equal(blockedStandalone.exitCode, 2);
  const blockedStandaloneJson = blockedStandalone.json as { reason: string; status: string };
  assert.equal(blockedStandaloneJson.status, "error");
  assert.equal(blockedStandaloneJson.reason, "concurrent-review-campaign");

  const missingCampaign = await runPythonJson(returnReviewStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--mode",
    "targeted-return-review",
    "--run-id",
    "review-orchestrator-return-review-20260420T150000Z"
  ]);
  assert.equal(missingCampaign.exitCode, 2);
  const missingCampaignJson = missingCampaign.json as { reason: string; status: string };
  assert.equal(missingCampaignJson.status, "error");
  assert.equal(missingCampaignJson.reason, "missing-campaign-id");

  const targetedReturn = await runPythonJson(returnReviewStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--mode",
    "targeted-return-review",
    "--campaign-id",
    fixerInitJson.run_id,
    "--run-id",
    "review-orchestrator-return-review-20260420T150100Z"
  ]);
  assert.equal(targetedReturn.exitCode, 0);
  const targetedReturnJson = targetedReturn.json as { campaign_id: string; run_id: string };
  assert.equal(targetedReturnJson.campaign_id, fixerInitJson.run_id);
  assert.equal(targetedReturnJson.run_id, "review-orchestrator-return-review-20260420T150100Z");

  const finalFixPath = join(tempDir, "final-fix.json");
  await writeFile(
    finalFixPath,
    JSON.stringify(
      {
        run_id: fixerInitJson.run_id,
        timestamp_utc: "2026-04-20T15:10:00Z",
        skill: "fixer-orchestrator",
        mode: "native-intake",
        phase: "final_fix",
        review_target: { mode: "branch", scope_summary: "test" },
        family_ids_handled: ["F-001"],
        final_statuses: ["family-closed"]
      },
      null,
      2
    ),
    "utf8"
  );
  const finalFix = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    fixerInitJson.coordinator_file,
    "--record-file",
    finalFixPath
  ]);
  assert.equal(finalFix.exitCode, 0);
  const finalFixJson = finalFix.json as { active_campaign_cleared: boolean };
  assert.equal(finalFixJson.active_campaign_cleared, true);

  const standaloneAfterTerminal = await runPythonJson(returnReviewStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--mode",
    "full-review",
    "--run-id",
    "review-orchestrator-full-review-20260420T151000Z"
  ]);
  assert.equal(standaloneAfterTerminal.exitCode, 0);
});

test("orchestrator standalone init-trace records lock owner provenance", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-orchestrator-owner-"));
  const traceRoot = join(".coortex", "review-trace");

  const init = await runPythonJson(returnReviewStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--mode",
    "full-review",
    "--run-id",
    "review-orchestrator-full-review-20260422T090000Z",
    "--owner-host-session-id",
    "codex-thread-review",
    "--owner-started-from-cwd",
    tempDir
  ]);

  assert.equal(init.exitCode, 0);
  const initJson = init.json as {
    active_campaign_file: string;
    campaign_id: string;
  };
  assert.equal(initJson.campaign_id, "review-orchestrator-full-review-20260422T090000Z");
  const activeCampaign = JSON.parse(await readFile(initJson.active_campaign_file, "utf8")) as {
    campaign_id: string;
    campaign_type: string;
    owner_host_session_id: string;
    owner_started_from_cwd: string;
    state: string;
    worktree_root: string;
  };
  assert.equal(activeCampaign.campaign_id, "review-orchestrator-full-review-20260422T090000Z");
  assert.equal(activeCampaign.campaign_type, "review-orchestrator");
  assert.equal(activeCampaign.owner_host_session_id, "codex-thread-review");
  assert.equal(activeCampaign.owner_started_from_cwd, tempDir);
  assert.equal(activeCampaign.state, "active");
  assert.equal(activeCampaign.worktree_root, tempDir);
});

test("coortex review helper blocks standalone review while a fixer campaign is active and surfaces owner provenance", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-lock-"));
  const traceRoot = join(".coortex", "review-trace");

  const fixerInit = await runPythonJson(fixResultStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--run-id",
    "fixer-orchestrator-lock",
    "--owner-host-session-id",
    "codex-thread-fixer-lock",
    "--owner-started-from-cwd",
    tempDir
  ]);
  assert.equal(fixerInit.exitCode, 0);

  const blocked = await runPythonJson(coortexReviewStateScript, [
    "check-active-campaign",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot
  ]);

  assert.equal(blocked.exitCode, 2);
  const blockedJson = blocked.json as {
    standalone_review_allowed: boolean;
    reason: string;
    active_campaign: {
      campaign_type: string;
      owner_host_session_id: string;
      owner_started_from_cwd: string;
    };
  };
  assert.equal(blockedJson.standalone_review_allowed, false);
  assert.equal(blockedJson.reason, "active-top-level-review-campaign");
  assert.equal(blockedJson.active_campaign.campaign_type, "fixer-orchestrator");
  assert.equal(blockedJson.active_campaign.owner_host_session_id, "codex-thread-fixer-lock");
  assert.equal(blockedJson.active_campaign.owner_started_from_cwd, tempDir);
});

test("coortex review helper validates current-work packets mechanically", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-current-work-packet-"));
  const packetPath = join(tempDir, "packet.json");

  const packet = {
    mini_surface_review_packet: {
      packet_version: 1,
      packet_id: "current-work-runtime",
      status: "handoff",
      source: "current_implementation",
      intent: "Review runtime attachment lifecycle changes.",
      baseline_surface_refs: ["runtime-recovery"],
      surface: {
        id: "current-work-runtime-recovery",
        name: "Runtime recovery current work",
        purpose: "Bounded current implementation review.",
        primary_anchors: ["src/recovery/**"],
        supporting_anchors: ["src/__tests__/recovery.test.ts"],
        contract_docs: ["docs/runtime-state-model.md"],
        review_focus_areas: ["provenance must track launch vs resume correctly"]
      },
      review_boundary: {
        in_scope_paths: ["src/recovery/claim.ts"],
        expected_write_set: ["src/recovery/claim.ts"],
        out_of_scope: []
      },
      seams: [{ path: "src/recovery/claim.ts", role: "owner" }],
      invariants: ["claim authority and attachment authority mutate together"],
      coverage_matrix: {
        rows: [
          {
            row_id: "entry-main",
            category: "entry_path",
            paths: ["src/recovery/claim.ts"],
            expected_behavior: "main claim path preserves attachment authority",
            tests: ["recovery claim test"],
            status: "tested",
            notes: "covered by targeted regression"
          }
        ]
      },
      reviewer_focus: ["authority coupling"],
      known_uncertainties: []
    }
  };
  await writeFile(packetPath, JSON.stringify(packet, null, 2), "utf8");

  const valid = await runPythonJson(coortexReviewStateScript, [
    "validate-current-work-packet",
    "--packet-file",
    packetPath
  ]);
  assert.equal(valid.exitCode, 0);
  const validJson = valid.json as {
    valid: boolean;
    packet_id: string;
    row_count: number;
    row_ids: string[];
    surface_id: string;
  };
  assert.equal(validJson.valid, true);
  assert.equal(validJson.packet_id, "current-work-runtime");
  assert.equal(validJson.surface_id, "current-work-runtime-recovery");
  assert.equal(validJson.row_count, 1);
  assert.deepEqual(validJson.row_ids, ["entry-main"]);

  const invalid = await runPythonJson(coortexReviewStateScript, [
    "validate-current-work-packet",
    "--packet-json",
    JSON.stringify({
      mini_surface_review_packet: {
        ...packet.mini_surface_review_packet,
        baseline_surface_refs: ["runtime-recovery", "codex-adapter"],
        coverage_matrix: {
          rows: [
            {
              ...packet.mini_surface_review_packet.coverage_matrix.rows[0],
              status: "done"
            }
          ]
        }
      }
    })
  ]);
  assert.equal(invalid.exitCode, 2);
  const invalidJson = invalid.json as { valid: boolean; errors: string[] };
  assert.equal(invalidJson.valid, false);
  assert.match(invalidJson.errors.join("\n"), /cross_surface_reason/);
  assert.match(invalidJson.errors.join("\n"), /status must be one of/);
});

test("coortex review helper validates current-work reviewer output against packet rows", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-current-work-output-"));
  const packetPath = join(tempDir, "packet.json");
  const packet = {
    mini_surface_review_packet: {
      packet_version: 1,
      packet_id: "current-work-runtime",
      status: "handoff",
      source: "current_implementation",
      intent: "Review runtime lifecycle changes.",
      surface: {
        id: "current-work-runtime",
        name: "Runtime current work",
        purpose: "Bounded current implementation review.",
        primary_anchors: ["src/recovery/**"]
      },
      review_boundary: {
        in_scope_paths: ["src/recovery/claim.ts"],
        expected_write_set: ["src/recovery/claim.ts"],
        out_of_scope: []
      },
      seams: [{ path: "src/recovery/claim.ts", role: "owner" }],
      invariants: ["runtime truth stays durable"],
      coverage_matrix: {
        rows: [
          {
            row_id: "entry-main",
            category: "entry_path",
            paths: ["src/recovery/claim.ts"],
            expected_behavior: "main entry path works",
            tests: ["targeted test"],
            status: "tested",
            notes: "covered"
          },
          {
            row_id: "failure-cleanup",
            category: "failure_path",
            paths: ["src/recovery/claim.ts"],
            expected_behavior: "cleanup failure is surfaced truthfully",
            tests: [],
            status: "checked",
            notes: "manual inspection"
          }
        ]
      }
    }
  };
  await writeFile(packetPath, JSON.stringify(packet, null, 2), "utf8");

  const validOutput = {
    surface_checked: {
      packet_id: "current-work-runtime",
      review_boundary_respected: true,
      packet_rows_accounted_for: ["entry-main", "failure-cleanup"],
      sibling_scope_checked: ["src/recovery/cleanup.ts"],
      matrix_checked: {
        rows_checked: ["entry-main", "failure-cleanup"],
        rows_closed: ["entry-main", "failure-cleanup"],
        rows_open: [],
        rows_deferred: [],
        rows_uncertain: [],
        test_coverage_gaps: []
      },
      verdict: "approve"
    }
  };

  const valid = await runPythonJson(coortexReviewStateScript, [
    "validate-current-work-review-output",
    "--packet-file",
    packetPath,
    "--review-output-json",
    JSON.stringify(validOutput)
  ]);
  assert.equal(valid.exitCode, 0);
  const validJson = valid.json as { valid: boolean; output_kind: string; accounted_row_count: number };
  assert.equal(validJson.valid, true);
  assert.equal(validJson.output_kind, "surface_checked");
  assert.equal(validJson.accounted_row_count, 2);

  const invalid = await runPythonJson(coortexReviewStateScript, [
    "validate-current-work-review-output",
    "--packet-file",
    packetPath,
    "--review-output-json",
    JSON.stringify({
      surface_checked: {
        ...validOutput.surface_checked,
        packet_rows_accounted_for: ["entry-main"],
        matrix_checked: {
          ...validOutput.surface_checked.matrix_checked,
          rows_checked: ["entry-main", "unknown-row"],
          rows_closed: ["entry-main", "failure-cleanup"],
          rows_uncertain: ["failure-cleanup"]
        }
      }
    })
  ]);
  assert.equal(invalid.exitCode, 2);
  const invalidJson = invalid.json as { valid: boolean; errors: string[] };
  assert.equal(invalidJson.valid, false);
  assert.match(invalidJson.errors.join("\n"), /missing packet row ids/);
  assert.match(invalidJson.errors.join("\n"), /unknown row id 'unknown-row'/);
  assert.match(invalidJson.errors.join("\n"), /cannot appear in both rows_closed and rows_uncertain/);
  assert.match(invalidJson.errors.join("\n"), /verdict approve cannot leave rows_uncertain/);

  const checkedOnly = await runPythonJson(coortexReviewStateScript, [
    "validate-current-work-review-output",
    "--packet-file",
    packetPath,
    "--review-output-json",
    JSON.stringify({
      surface_checked: {
        ...validOutput.surface_checked,
        matrix_checked: {
          ...validOutput.surface_checked.matrix_checked,
          rows_checked: ["entry-main", "failure-cleanup"],
          rows_closed: ["entry-main"],
          rows_open: [],
          rows_deferred: [],
          rows_uncertain: []
        }
      }
    })
  ]);
  assert.equal(checkedOnly.exitCode, 2);
  const checkedOnlyJson = checkedOnly.json as { valid: boolean; errors: string[] };
  assert.equal(checkedOnlyJson.valid, false);
  assert.match(checkedOnlyJson.errors.join("\n"), /does not disposition accounted row ids.*failure-cleanup/);
});

test("orchestrator trace helper validates lane result records before appending", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-trace-"));
  const traceFile = join(tempDir, "coordinator.jsonl");

  const valid = await runPythonJson(returnReviewStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "review-orchestrator-full-review-20260418T120000Z",
      timestamp_utc: "2026-04-18T12:00:00Z",
      skill: "coortex-review-lane",
      mode: "full-review",
      phase: "lane_result",
      review_target: { mode: "branch", scope_summary: "test" },
      lane_id: "L1",
      lane_type: "coverage",
      target: "runtime-projection",
      scope_summary: "runtime projection surface",
      files_read: ["src/projections/runtime-projection.ts"],
      docs_read: ["docs/runtime-state-model.md"],
      searches_run: ["rg runtimeVersion src/projections/runtime-projection.ts"],
      diagnostics_run: ["tsc --noEmit src/projections/runtime-projection.ts"],
      commands_run: ["git diff -- src/projections/runtime-projection.ts"],
      candidate_family_decisions: ["F01 runtime-version compatibility"],
      sibling_search_paths_attempted: ["src/persistence/projection-recovery.ts"],
      skipped_areas: ["none"],
      thin_areas: ["legacy no-snapshot replay not reproduced"],
      stop_reason: "bounded surface reviewed",
      coverage_confidence: "high",
      omission_entries: []
    })
  ]);

  assert.equal(valid.exitCode, 0);
  assert.deepEqual(valid.json, {
    active_campaign_cleared: false,
    appended: true,
    status: "ok",
    trace_file: traceFile
  });

  const invalid = await runPythonJson(returnReviewStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "review-orchestrator-full-review-20260418T120000Z",
      timestamp_utc: "2026-04-18T12:01:00Z",
      skill: "coortex-review-lane",
      mode: "full-review",
      phase: "lane_result",
      review_target: { mode: "branch", scope_summary: "test" },
      lane_id: "L2",
      lane_type: "coverage",
      target: "runtime-projection",
      scope_summary: "runtime projection surface",
      files_read: "src/projections/runtime-projection.ts",
      docs_read: [],
      searches_run: [],
      diagnostics_run: [],
      commands_run: [],
      candidate_family_decisions: [],
      sibling_search_paths_attempted: [],
      skipped_areas: [],
      thin_areas: []
    })
  ]);

  assert.equal(invalid.exitCode, 2);
  const invalidJson = invalid.json as {
    appended: boolean;
    errors: string[];
    status: string;
  };
  assert.equal(invalidJson.appended, false);
  assert.equal(invalidJson.status, "error");
  assert.ok(
    invalidJson.errors.some((error) =>
      error.includes("field files_read must be a list")
    )
  );
  assert.ok(
    invalidJson.errors.some((error) =>
      error.includes("missing stop_reason")
    )
  );
  assert.ok(
    invalidJson.errors.some((error) =>
      error.includes("missing coverage_confidence")
    )
  );
  assert.ok(
    invalidJson.errors.some((error) =>
      error.includes("missing omission_entries")
    )
  );
});

test("orchestrator helper validates structured review handoffs before writing", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-handoff-validation-"));
  const validPath = join(tempDir, "handoff.json");
  await writeFile(validPath, JSON.stringify(validReviewHandoff("F-VAL-001"), null, 2), "utf8");

  const valid = await runPythonJson(returnReviewStateScript, [
    "validate-review-handoff",
    "--input-file",
    validPath
  ]);

  assert.equal(valid.exitCode, 0);
  assert.deepEqual(valid.json, {
    errors: [],
    family_count: 1,
    family_ids: ["F-VAL-001"],
    mode: "review-handoff-validation",
    valid: true
  });

  const invalid = await runPythonJson(returnReviewStateScript, [
    "validate-review-handoff",
    "--input-json",
    JSON.stringify({
      review_handoff: {
        review_target: { mode: "branch", scope_summary: "test" },
        families: [
          {
            family_id: "F-BAD-001",
            title: "Underspecified family"
          }
        ]
      }
    })
  ]);

  assert.equal(invalid.exitCode, 2);
  const invalidJson = invalid.json as { errors: string[]; valid: boolean };
  assert.equal(invalidJson.valid, false);
  assert.ok(
    invalidJson.errors.some((error) =>
      error.includes("families[0] severity must be one of")
    )
  );
  assert.ok(
    invalidJson.errors.some((error) =>
      error.includes("families[0] closure_gate must be a mapping")
    )
  );

  const invalidStatusHandoff = validReviewHandoff("F-BAD-STATUS") as {
    review_handoff: { families: Record<string, unknown>[] };
  };
  invalidStatusHandoff.review_handoff.families[0]!.closure_status = "looks-good";
  const invalidStatus = await runPythonJson(returnReviewStateScript, [
    "validate-review-handoff",
    "--input-json",
    JSON.stringify(invalidStatusHandoff)
  ]);

  assert.equal(invalidStatus.exitCode, 2);
  const invalidStatusJson = invalidStatus.json as { errors: string[]; valid: boolean };
  assert.equal(invalidStatusJson.valid, false);
  assert.ok(
    invalidStatusJson.errors.some((error) =>
      error.includes("families[0] closure_status must be one of")
    )
  );

  const invalidOpenReasonHandoff = validReviewHandoff("F-BAD-REASON") as {
    review_handoff: { families: Record<string, unknown>[] };
  };
  invalidOpenReasonHandoff.review_handoff.families[0]!.open_reason_kind = "mystery";
  const invalidOpenReason = await runPythonJson(returnReviewStateScript, [
    "validate-review-handoff",
    "--input-json",
    JSON.stringify(invalidOpenReasonHandoff)
  ]);

  assert.equal(invalidOpenReason.exitCode, 2);
  const invalidOpenReasonJson = invalidOpenReason.json as {
    errors: string[];
    valid: boolean;
  };
  assert.equal(invalidOpenReasonJson.valid, false);
  assert.ok(
    invalidOpenReasonJson.errors.some((error) =>
      error.includes("families[0] open_reason_kind must be one of")
    )
  );

  const invalidSeamSummaryHandoff = validReviewHandoff("F-BAD-SEAM") as {
    review_handoff: Record<string, unknown> & { families: Record<string, unknown>[] };
  };
  invalidSeamSummaryHandoff.review_handoff.seam_summary = {
    hot_seams: [
      {
        seam: "src/example.ts",
        family_ids: ["F-BAD-SEAM"],
        family_count: 99,
        highest_severity: "MEDIUM",
        hot: true,
        hot_reason: "same owning seam"
      }
    ],
    all_seams: [],
    families_without_owning_seam: []
  };
  const invalidSeamSummary = await runPythonJson(returnReviewStateScript, [
    "validate-review-handoff",
    "--input-json",
    JSON.stringify(invalidSeamSummaryHandoff)
  ]);

  assert.equal(invalidSeamSummary.exitCode, 2);
  const invalidSeamSummaryJson = invalidSeamSummary.json as {
    errors: string[];
    valid: boolean;
  };
  assert.equal(invalidSeamSummaryJson.valid, false);
  assert.ok(
    invalidSeamSummaryJson.errors.some((error) =>
      error.includes("seam_summary hot_seams[0] family_count must match family_ids length")
    )
  );
});

test("orchestrator trace family-id checks are order-insensitive", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-handoff-family-order-"));
  const traceDir = join(tempDir, ".coortex", "review-trace", "run-order");
  await mkdir(traceDir, { recursive: true });
  const traceFile = join(traceDir, "coordinator.jsonl");
  const handoffPath = join(traceDir, "review-handoff.json");
  await writeFile(
    handoffPath,
    JSON.stringify(validReviewHandoff(["F-ORDER-A", "F-ORDER-B"]), null, 2),
    "utf8"
  );

  const emitted = await runPythonJson(returnReviewStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "run-order",
      timestamp_utc: "2026-04-20T12:26:30Z",
      skill: "review-orchestrator",
      mode: "packet-exploration",
      phase: "review_handoff_emitted",
      review_target: { mode: "branch", scope_summary: "test" },
      path: handoffPath,
      family_ids: ["F-ORDER-B", "F-ORDER-A"],
      kind: "initial"
    })
  ]);
  assert.equal(emitted.exitCode, 0);

  const finalReview = await runPythonJson(returnReviewStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "run-order",
      timestamp_utc: "2026-04-20T12:27:30Z",
      skill: "review-orchestrator",
      mode: "packet-exploration",
      phase: "final_review",
      review_target: { mode: "branch", scope_summary: "test" },
      final_verdict: "REQUEST_CHANGES",
      actionable_family_ids: ["F-ORDER-A", "F-ORDER-B"],
      review_handoff_path: handoffPath,
      review_shape_trace_summary: { mode: "packet-exploration" },
      unexplored_area_ledger_summary: { areas: [] },
      boundedness_exceptions_summary: { exceptions: [] }
    })
  ]);
  assert.equal(finalReview.exitCode, 0);
});

test("write-review-handoff rejects underspecified family artifacts", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-handoff-write-"));
  const result = await runPythonJson(returnReviewStateScript, [
    "write-review-handoff",
    "--trace-dir",
    tempDir,
    "--input-json",
    JSON.stringify({
      review_handoff: {
        review_target: { mode: "branch", scope_summary: "test" },
        families: [{ family_id: "F-BAD-001", title: "Underspecified family" }]
      }
    })
  ]);

  assert.equal(result.exitCode, 2);
  const json = result.json as { errors: string[]; written: boolean; valid: boolean };
  assert.equal(json.valid, false);
  assert.equal(json.written, false);
  assert.ok(json.errors.some((error) => error.includes("review_hints must be a mapping")));
});

test("orchestrator helper validates structured coverage exploration and return lanes", async () => {
  const coverage = await runPythonJson(returnReviewStateScript, [
    "validate-lane-result",
    "--input-json",
    JSON.stringify({
      lane_id: "coverage-runtime-01",
      lane_type: "coverage-lane",
      target: "runtime",
      scope_summary: "runtime surface",
      material_evidence_actions: ["read src/runtime.ts"],
      rationale_summary: "candidate family follows from the runtime contract",
      skipped_areas: "none",
      skip_reasons: "none",
      stop_reason: "bounded surface completed",
      coverage_confidence: "high",
      thin_areas: "none",
      omission_entries: [],
      candidate_families: [
        {
          family_id: "F-COV-001",
          candidate_root_cause: "runtime truth split across two owners",
          manifestations: ["src/runtime.ts:10"],
          family_status: "local-family",
          likely_owning_seam: "src/runtime.ts",
          secondary_seams: "none"
        }
      ]
    })
  ]);
  assert.equal(coverage.exitCode, 0);

  const exploration = await runPythonJson(returnReviewStateScript, [
    "validate-lane-result",
    "--input-json",
    JSON.stringify({
      lane_id: "family-F-COV-001",
      lane_type: "family-exploration-lane",
      target: "F-COV-001",
      scope_summary: "runtime family",
      family_id: "F-COV-001",
      source_surfaces: ["runtime"],
      highest_confidence_root_cause: "runtime truth split across two owners",
      likely_owning_seam: "src/runtime.ts",
      secondary_seams: "none",
      manifestations_confirmed: ["src/runtime.ts:10"],
      manifestations_rejected: "none",
      side_paths_checked: ["src/runtime-resume.ts"],
      sibling_bugs_found: "none found",
      sibling_search_scope: ["resume path"],
      severity_rollup: "MEDIUM",
      closure_status: "family-still-open",
      material_evidence_actions: ["read src/runtime.ts"],
      rationale_summary: "root cause remained local to runtime truth ownership",
      skipped_areas: "none",
      skip_reasons: "none",
      stop_reason: "family seam checked",
      coverage_confidence: "medium",
      thin_areas: "none",
      omission_entries: []
    })
  ]);
  assert.equal(exploration.exitCode, 0);

  const returnReview = await runPythonJson(returnReviewStateScript, [
    "validate-lane-result",
    "--lane-type",
    "return-review",
    "--input-json",
    JSON.stringify(validReturnReviewLane())
  ]);
  assert.equal(returnReview.exitCode, 0);

  const invalidClaimStatus = await runPythonJson(returnReviewStateScript, [
    "validate-lane-result",
    "--lane-type",
    "return-review",
    "--input-json",
    JSON.stringify(
      validReturnReviewLane({
        scope_summary: "returned family with invalid claim status",
        claimed_closure_status: "looks-good"
      })
    )
  ]);
  assert.equal(invalidClaimStatus.exitCode, 2);
  const invalidClaimStatusJson = invalidClaimStatus.json as {
    errors: string[];
    valid: boolean;
  };
  assert.equal(invalidClaimStatusJson.valid, false);
  assert.ok(
    invalidClaimStatusJson.errors.some((error) =>
      error.includes("claimed_closure_status must be one of")
    )
  );

  const coordinatorOnlyVerdict = await runPythonJson(returnReviewStateScript, [
    "validate-lane-result",
    "--lane-type",
    "return-review",
    "--input-json",
    JSON.stringify(
      validReturnReviewLane({
        scope_summary: "returned family with coordinator-only verdict",
        closure_claim_verdict: "unverified",
        closure_gate_checked: [
          {
            gate_item: "root cause repaired",
            item_verdict: "inconclusive",
            evidence: ["src/runtime.ts:12"]
          }
        ],
        coverage_confidence: "low"
      })
    )
  ]);
  assert.equal(coordinatorOnlyVerdict.exitCode, 2);
  const coordinatorOnlyVerdictJson = coordinatorOnlyVerdict.json as {
    errors: string[];
    valid: boolean;
  };
  assert.equal(coordinatorOnlyVerdictJson.valid, false);
  assert.ok(
    coordinatorOnlyVerdictJson.errors.some((error) =>
      error.includes("closure_claim_verdict must be one of")
    )
  );

  const conflictingLaneType = await runPythonJson(returnReviewStateScript, [
    "validate-lane-result",
    "--lane-type",
    "return-review",
    "--input-json",
    JSON.stringify(
      validReturnReviewLane({
        lane_type: "coverage-lane",
        scope_summary: "returned family with conflicting metadata"
      })
    )
  ]);
  assert.equal(conflictingLaneType.exitCode, 2);
  const conflictingLaneTypeJson = conflictingLaneType.json as {
    errors: string[];
    valid: boolean;
  };
  assert.equal(conflictingLaneTypeJson.valid, false);
  assert.ok(
    conflictingLaneTypeJson.errors.some((error) =>
      error.includes("conflicts with --lane-type")
    )
  );

  const invalidEmbeddedLaneType = await runPythonJson(returnReviewStateScript, [
    "validate-lane-result",
    "--lane-type",
    "return-review",
    "--input-json",
    JSON.stringify(
      validReturnReviewLane({
        lane_type: "bogus-lane",
        scope_summary: "returned family with invalid metadata"
      })
    )
  ]);
  assert.equal(invalidEmbeddedLaneType.exitCode, 2);
  const invalidEmbeddedLaneTypeJson = invalidEmbeddedLaneType.json as {
    errors: string[];
    valid: boolean;
  };
  assert.equal(invalidEmbeddedLaneTypeJson.valid, false);
  assert.ok(
    invalidEmbeddedLaneTypeJson.errors.some((error) =>
      error.includes("bogus-lane") && error.includes("conflicts with --lane-type")
    )
  );

  const invalid = await runPythonJson(returnReviewStateScript, [
    "validate-lane-result",
    "--lane-type",
    "family-exploration",
    "--input-json",
    JSON.stringify({
      lane_id: "family-F-COV-002",
      target: "F-COV-002",
      scope_summary: "missing exploration fields",
      material_evidence_actions: [],
      rationale_summary: "",
      skipped_areas: [],
      skip_reasons: [],
      stop_reason: "",
      coverage_confidence: "maybe",
      thin_areas: [],
      omission_entries: []
    })
  ]);

  assert.equal(invalid.exitCode, 2);
  const invalidJson = invalid.json as { errors: string[]; valid: boolean };
  assert.equal(invalidJson.valid, false);
  assert.ok(
    invalidJson.errors.some((error) =>
      error.includes("highest_confidence_root_cause must be a non-empty string")
    )
  );
  assert.ok(
    invalidJson.errors.some((error) =>
      error.includes("material_evidence_actions must not be empty")
    )
  );
  assert.ok(
    invalidJson.errors.some((error) =>
      error.includes("coverage_confidence must be one of")
    )
  );
});

test("omission helper buckets ignore carry-thin and follow-up entries deterministically", async () => {
  const result = await runPythonJson(returnReviewStateScript, [
    "summarize-lane-omissions",
    "--lane-result-json",
    JSON.stringify({
      lane_id: "coverage-runtime-authority-01",
      lane_type: "coverage-lane",
      target: "runtime-authority",
      scope_summary: "runtime authority surface",
      omission_entries: [
        {
          omission_id: "O1",
          kind: "skipped-area",
          area: "src/core/retry-policy.ts",
          reason: "outside bounded coverage slice",
          disposition: "ignore"
        },
        {
          omission_id: "O2",
          kind: "thin-area",
          area: "src/core/replay.ts",
          reason: "adjacent replay branch not reproduced",
          disposition: "carry-thin"
        },
        {
          omission_id: "O3",
          kind: "thin-area",
          area: "src/core/lease-handshake.ts",
          reason: "ownership fence branch stayed materially relevant",
          disposition: "spawn-follow-up",
          suggested_lane_type: "coverage-lane",
          suggested_target: "src/core/lease-handshake.ts"
        }
      ]
    }),
    "--lane-result-json",
    JSON.stringify({
      lane_id: "return-review-F05-01",
      lane_type: "return-review-lane",
      target: "F05",
      scope_summary: "family-local return review",
      omission_entries: []
    })
  ]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.json, {
    mode: "review-omission-summary",
    omission_summary: {
      source_lane_ids: ["coverage-runtime-authority-01", "return-review-F05-01"],
      ignored: [
        {
          area: "src/core/retry-policy.ts",
          disposition: "ignore",
          kind: "skipped-area",
          omission_id: "O1",
          reason: "outside bounded coverage slice",
          scope_summary: "runtime authority surface",
          source_lane_id: "coverage-runtime-authority-01",
          source_lane_type: "coverage-lane",
          source_target: "runtime-authority"
        }
      ],
      carry_thin: [
        {
          area: "src/core/replay.ts",
          disposition: "carry-thin",
          kind: "thin-area",
          omission_id: "O2",
          reason: "adjacent replay branch not reproduced",
          scope_summary: "runtime authority surface",
          source_lane_id: "coverage-runtime-authority-01",
          source_lane_type: "coverage-lane",
          source_target: "runtime-authority"
        }
      ],
      spawn_follow_up: [
        {
          area: "src/core/lease-handshake.ts",
          disposition: "spawn-follow-up",
          kind: "thin-area",
          omission_id: "O3",
          reason: "ownership fence branch stayed materially relevant",
          scope_summary: "runtime authority surface",
          source_lane_id: "coverage-runtime-authority-01",
          source_lane_type: "coverage-lane",
          source_target: "runtime-authority",
          suggested_lane_type: "coverage-lane",
          suggested_target: "src/core/lease-handshake.ts"
        }
      ]
    }
  });
});

test("omission helper rejects malformed omission entries with structured errors", async () => {
  const result = await runPythonJson(returnReviewStateScript, [
    "summarize-lane-omissions",
    "--lane-result-json",
    JSON.stringify({
      lane_id: "coverage-runtime-authority-01",
      lane_type: "coverage-lane",
      target: "runtime-authority",
      scope_summary: "runtime authority surface",
      omission_entries: [
        {
          omission_id: "O3",
          kind: "thin-area",
          area: "src/core/lease-handshake.ts",
          reason: "ownership fence branch stayed materially relevant",
          disposition: "spawn-follow-up",
          suggested_lane_type: "coverage-lane"
        }
      ]
    })
  ]);

  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.json, {
    errors: [
      "lane_results[0] omission_entries[0] suggested_target must be a non-empty string when disposition is 'spawn-follow-up'"
    ],
    mode: "review-omission-summary",
    omission_summary: {
      source_lane_ids: ["coverage-runtime-authority-01"],
      ignored: [],
      carry_thin: [],
      spawn_follow_up: [
        {
          area: "src/core/lease-handshake.ts",
          disposition: "spawn-follow-up",
          kind: "thin-area",
          omission_id: "O3",
          reason: "ownership fence branch stayed materially relevant",
          scope_summary: "runtime authority surface",
          source_lane_id: "coverage-runtime-authority-01",
          source_lane_type: "coverage-lane",
          source_target: "runtime-authority",
          suggested_lane_type: "coverage-lane",
          suggested_target: null
        }
      ]
    }
  });
});

test("omission helper rejects lane results missing follow-up-bounding fields", async () => {
  const result = await runPythonJson(returnReviewStateScript, [
    "summarize-lane-omissions",
    "--lane-result-json",
    JSON.stringify({
      lane_id: "coverage-runtime-authority-01",
      omission_entries: [
        {
          omission_id: "O1",
          kind: "thin-area",
          area: "src/core/lease-handshake.ts",
          reason: "ownership fence branch stayed materially relevant",
          disposition: "carry-thin"
        }
      ]
    })
  ]);

  assert.equal(result.exitCode, 2);
  const invalidJson = result.json as {
    errors: string[];
    omission_summary: {
      source_lane_ids: string[];
      carry_thin: Array<Record<string, unknown>>;
    };
  };
  assert.deepEqual(invalidJson.omission_summary.source_lane_ids, [
    "coverage-runtime-authority-01"
  ]);
  assert.ok(invalidJson.errors.includes("lane_results[0] missing lane_type"));
  assert.ok(invalidJson.errors.includes("lane_results[0] missing target"));
  assert.ok(invalidJson.errors.includes("lane_results[0] missing scope_summary"));
  assert.deepEqual(invalidJson.omission_summary.carry_thin, [
    {
      area: "src/core/lease-handshake.ts",
      disposition: "carry-thin",
      kind: "thin-area",
      omission_id: "O1",
      reason: "ownership fence branch stayed materially relevant",
      scope_summary: "",
      source_lane_id: "coverage-runtime-authority-01",
      source_lane_type: "",
      source_target: ""
    }
  ]);
});

test("orchestrator trace helper validates omission follow-up records before appending", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-trace-"));
  const traceFile = join(tempDir, "coordinator.jsonl");

  const valid = await runPythonJson(returnReviewStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "review-orchestrator-full-review-20260419T120000Z",
      timestamp_utc: "2026-04-19T12:00:00Z",
      skill: "review-orchestrator",
      mode: "full-review",
      phase: "omission_followup",
      review_target: { mode: "branch", scope_summary: "test" },
      source_lane_ids: ["coverage-runtime-authority-01"],
      followup_decisions: [
        {
          source_lane_id: "coverage-runtime-authority-01",
          omission_id: "O3",
          area: "src/core/lease-handshake.ts",
          decision: "spawned-follow-up",
          coordinator_reason: "thin area remained materially review-relevant",
          spawned_lane_id: "coverage-runtime-authority-followup-01"
        },
        {
          source_lane_id: "coverage-runtime-authority-01",
          omission_id: "O2",
          area: "src/core/replay.ts",
          decision: "carried-thin",
          coordinator_reason: "confidence caveat preserved for synthesis"
        }
      ]
    })
  ]);

  assert.equal(valid.exitCode, 0);
  assert.deepEqual(valid.json, {
    active_campaign_cleared: false,
    appended: true,
    status: "ok",
    trace_file: traceFile
  });

  const invalid = await runPythonJson(returnReviewStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "review-orchestrator-full-review-20260419T120000Z",
      timestamp_utc: "2026-04-19T12:01:00Z",
      skill: "review-orchestrator",
      mode: "full-review",
      phase: "omission_followup",
      review_target: { mode: "branch", scope_summary: "test" },
      source_lane_ids: ["coverage-runtime-authority-01"],
      followup_decisions: [
        {
          source_lane_id: "coverage-runtime-authority-01",
          omission_id: "O3",
          area: "src/core/lease-handshake.ts",
          decision: "declined-follow-up",
          coordinator_reason: "follow-up would duplicate an existing family lane",
          spawned_lane_id: "coverage-runtime-authority-followup-01"
        }
      ]
    })
  ]);

  assert.equal(invalid.exitCode, 2);
  const invalidJson = invalid.json as {
    appended: boolean;
    errors: string[];
    status: string;
  };
  assert.equal(invalidJson.appended, false);
  assert.equal(invalidJson.status, "error");
  assert.ok(
    invalidJson.errors.some((error) =>
      error.includes("spawned_lane_id must be omitted unless decision is 'spawned-follow-up'")
    )
  );
});

test("fixer trace helper validates final-fix records before appending", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-trace-"));
  const traceFile = join(tempDir, "coordinator.jsonl");

  const invalid = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260418T120000Z",
      timestamp_utc: "2026-04-18T12:00:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "final_fix",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids_handled: "F03",
      final_statuses: []
    })
  ]);

  assert.equal(invalid.exitCode, 2);
  const invalidJson = invalid.json as {
    appended: boolean;
    errors: string[];
    status: string;
  };
  assert.equal(invalidJson.appended, false);
  assert.equal(invalidJson.status, "error");
  assert.ok(
    invalidJson.errors.some((error) =>
      error.includes("field family_ids_handled must be a list")
    )
  );
});

test("fixer trace helper blocks family-closed on red lane gates", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-trace-"));
  const traceFile = join(tempDir, "coordinator.jsonl");

  const invalid = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260425T120000Z",
      timestamp_utc: "2026-04-25T12:00:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "family_closeout",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_id: "F-001",
      write_set: ["src/a.ts"],
      tests_updated: [],
      docs_updated: [],
      files_read: ["src/a.ts"],
      docs_read: [],
      searches_run: [],
      commands_run: ["npm run build", "jb inspectcode"],
      verification_run: [
        "touched_build_gate: green before targeted tests",
        "local_quality_gates: inspectcode red before targeted tests"
      ],
      touched_build_gate: {
        command: "npm run build",
        scope: "touched package",
        status: "green",
        evidence: "ran before targeted tests"
      },
      local_quality_gates: [
        {
          name: "inspectcode",
          command: "jb inspectcode",
          status: "red",
          evidence: "static analysis found a compile/import error"
        }
      ],
      emergent_threads_followed: [],
      emergent_threads_deferred: [],
      closure_status: "family-closed",
      residual_risks: []
    })
  ]);

  assert.equal(invalid.exitCode, 2);
  const invalidJson = invalid.json as {
    appended: boolean;
    errors: string[];
    status: string;
  };
  assert.equal(invalidJson.appended, false);
  assert.equal(invalidJson.status, "error");
  assert.ok(
    invalidJson.errors.some((error) =>
      error.includes("cannot claim family-closed") && error.includes("local_quality_gates")
    )
  );
});

test("fixer trace helper validates per-family return-review round counts", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-trace-"));
  const traceFile = join(tempDir, "coordinator.jsonl");

  const closureApproved = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260420T115800Z",
      timestamp_utc: "2026-04-20T11:58:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "closure_approved",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001", "F-002"],
      reviewer_run_id: "review-orchestrator-targeted-return-review-1",
      review_result: "closure-approved",
      return_review_rounds_taken_by_family: {
        "F-001": 2,
        "F-002": 0
      }
    })
  ]);
  assert.equal(closureApproved.exitCode, 0);

  const clearGate = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260420T115900Z",
      timestamp_utc: "2026-04-20T11:59:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "pre_commit_gate_result",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001", "F-002"],
      gate_status: "clear",
      review_gate_result: "clear",
      deslop_gate_result: "clear",
      follow_up_kind: "none"
    })
  ]);
  assert.equal(clearGate.exitCode, 0);

  const commitReady = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260420T115950Z",
      timestamp_utc: "2026-04-20T11:59:50Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "commit_ready",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001", "F-002"],
      readiness_basis: "approved diff plus clear pre-commit gate plus lane evidence",
      self_deslop_evidence: ["coortex-deslop completed"],
      lane_review_evidence: ["coortex-review-lane completed"],
      seam_residue_sweep_evidence: ["stale shim and removed-symbol sweep completed"],
      final_touched_build_gate: {
        command: "npm run build",
        scope: "touched package",
        status: "green",
        evidence: "ran before targeted tests"
      },
      final_local_quality_gates: [
        {
          name: "static-analysis",
          command: "repo-configured static analysis",
          status: "green",
          evidence: "local quality gate ran before targeted tests"
        }
      ],
      final_targeted_verification: ["node --test targeted"],
      excluded_unrelated_edits: []
    })
  ]);
  assert.equal(commitReady.exitCode, 0);

  const valid = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260420T120000Z",
      timestamp_utc: "2026-04-20T12:00:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "family_commit",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001", "F-002"],
      commit_sha: "abc1234",
      commit_subject: "fix: align stale cleanup truth",
      return_review_rounds_taken_by_family: {
        "F-001": 2,
        "F-002": 0
      }
    })
  ]);

  assert.equal(valid.exitCode, 0);
  assert.deepEqual(valid.json, {
    active_campaign_cleared: false,
    appended: true,
    status: "ok",
    trace_file: traceFile
  });

  const invalid = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260420T120100Z",
      timestamp_utc: "2026-04-20T12:01:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "family_commit",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001", "F-002"],
      commit_sha: "def5678",
      commit_subject: "fix: lane L-001 cleanup",
      return_review_rounds_taken_by_family: {
        "F-001": 1
      }
    })
  ]);

  assert.equal(invalid.exitCode, 2);
  const invalidJson = invalid.json as {
    appended: boolean;
    errors: string[];
    status: string;
  };
  assert.equal(invalidJson.appended, false);
  assert.equal(invalidJson.status, "error");
  assert.ok(
    invalidJson.errors.some((error) =>
      error.includes("return_review_rounds_taken_by_family keys must match family_ids exactly")
    )
  );
  assert.ok(
    invalidJson.errors.some((error) =>
      error.includes("commit_subject must not include generated lane/slice/wave ids")
    )
  );
});

test("fixer trace helper requires closure approval before pre-commit gate records", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-trace-"));
  const traceFile = join(tempDir, "coordinator.jsonl");

  const invalid = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260425T120000Z",
      timestamp_utc: "2026-04-25T12:00:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "pre_commit_gate_result",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001"],
      gate_status: "clear",
      review_gate_result: "clear",
      deslop_gate_result: "clear",
      follow_up_kind: "none"
    })
  ]);

  assert.equal(invalid.exitCode, 2);
  const invalidJson = invalid.json as {
    appended: boolean;
    errors: string[];
    status: string;
  };
  assert.equal(invalidJson.appended, false);
  assert.equal(invalidJson.status, "error");
  assert.ok(
    invalidJson.errors.some((error) =>
      error.includes("requires a prior 'closure_approved' record")
    )
  );
});

test("fixer trace helper rejects weak commit-ready evidence", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-trace-"));
  const traceFile = join(tempDir, "coordinator.jsonl");

  const closureApproved = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260425T120500Z",
      timestamp_utc: "2026-04-25T12:05:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "closure_approved",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001"],
      reviewer_run_id: "review-orchestrator-targeted-return-review-1",
      review_result: "closure-approved",
      return_review_rounds_taken_by_family: {
        "F-001": 1
      }
    })
  ]);
  assert.equal(closureApproved.exitCode, 0);

  const clearGate = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260425T120600Z",
      timestamp_utc: "2026-04-25T12:06:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "pre_commit_gate_result",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001"],
      gate_status: "clear",
      review_gate_result: "clear",
      deslop_gate_result: "clear",
      follow_up_kind: "none"
    })
  ]);
  assert.equal(clearGate.exitCode, 0);

  const weakReady = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260425T120700Z",
      timestamp_utc: "2026-04-25T12:07:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "commit_ready",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001"],
      readiness_basis: "reviewer approval",
      self_deslop_evidence: [],
      lane_review_evidence: [],
      seam_residue_sweep_evidence: [],
      final_targeted_verification: [],
      excluded_unrelated_edits: []
    })
  ]);

  assert.equal(weakReady.exitCode, 2);
  const errors = (weakReady.json as { errors: string[] }).errors;
  assert.ok(errors.some((error) => error.includes("reviewer approval") && error.includes("alone")));
  assert.ok(errors.some((error) => error.includes("self_deslop_evidence") && error.includes("must not be empty")));
  assert.ok(errors.some((error) => error.includes("lane_review_evidence") && error.includes("must not be empty")));
  assert.ok(errors.some((error) => error.includes("seam_residue_sweep_evidence") && error.includes("must not be empty")));
  assert.ok(errors.some((error) => error.includes("final_touched_build_gate") && error.includes("missing")));
  assert.ok(errors.some((error) => error.includes("final_local_quality_gates") && error.includes("missing")));
  assert.ok(errors.some((error) => error.includes("final_targeted_verification") && error.includes("must not be empty")));
});

async function validateReviewReturnGateStatuses(options: {
  tempPrefix: string;
  touchedBuildGateStatus: string;
  localQualityGateStatus: string;
  localQualityGateName?: string;
  localQualityGateCommand?: string;
  localQualityGateEvidence?: string;
  verificationRun: string[];
}): Promise<{ exitCode: number; json: unknown; stdout: string; stderr: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), options.tempPrefix));
  const reviewHandoffPath = join(tempDir, "review-handoff.json");
  const reviewReturnHandoffPath = join(tempDir, "review-return-handoff.json");

  await writeFile(
    reviewHandoffPath,
    JSON.stringify(
      {
        review_handoff: {
          review_target: {
            mode: "return-review",
            scope_summary: "test"
          },
          families: [
            {
              family_id: "F-001",
              title: "Gate evidence family",
              review_hints: {
                likely_owning_seam: "src/a.ts"
              }
            }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    reviewReturnHandoffPath,
    JSON.stringify(
      {
        review_return_handoff: {
          original_review_target: {
            mode: "return-review",
            scope_summary: "test"
          },
          families: [
            {
              original_family_id: "F-001",
              claimed_closure_status: "family-closed",
              touched_write_set: ["src/a.ts"],
              touched_tests: ["src/__tests__/a.test.ts"],
              touched_docs: [],
              closure_gate_checked: {
                remediation_item: "fix owning seam",
                satisfied_items: ["targeted symptom fixed"],
                unsatisfied_items: "none"
              },
              emergent_threads_followed: [],
              emergent_threads_deferred: [],
              residual_risks: [],
              touched_build_gate: {
                command: "npm run build",
                scope: "touched package",
                status: options.touchedBuildGateStatus,
                evidence: `build ${options.touchedBuildGateStatus} before targeted tests`
              },
              local_quality_gates: [
                {
                  name: options.localQualityGateName ?? "static-analysis",
                  command: options.localQualityGateCommand ?? "repo-configured local quality gate",
                  status: options.localQualityGateStatus,
                  evidence:
                    options.localQualityGateEvidence ??
                    `local quality gate ${options.localQualityGateStatus} before targeted tests`
                }
              ],
              verification_run: options.verificationRun
            }
          ],
          deferred_families: "none"
        }
      },
      null,
      2
    ),
    "utf8"
  );

  return runPythonJson(fixResultStateScript, [
    "validate-review-return",
    "--review-return-handoff",
    reviewReturnHandoffPath,
    "--review-handoff",
    reviewHandoffPath
  ]);
}

test("fixer review-return helper blocks family-closed on red touched build gate", async () => {
  const invalid = await validateReviewReturnGateStatuses({
    tempPrefix: "coortex-review-return-build-gate-",
    touchedBuildGateStatus: "red",
    localQualityGateStatus: "green",
    verificationRun: [
      "touched_build_gate: red before targeted tests",
      "local_quality_gates: green before targeted tests",
      "broader_suite_status: not-run-build-red"
    ]
  });

  assert.equal(invalid.exitCode, 2);
  const errors = (invalid.json as { errors: string[] }).errors;
  assert.ok(
    errors.some((error) =>
      error.includes("cannot claim family-closed") && error.includes("touched_build_gate.status")
    )
  );
});

test("fixer review-return helper blocks family-closed on red local quality gate", async () => {
  const invalid = await validateReviewReturnGateStatuses({
    tempPrefix: "coortex-review-return-local-gate-",
    touchedBuildGateStatus: "green",
    localQualityGateName: "inspectcode",
    localQualityGateCommand: "jb inspectcode",
    localQualityGateStatus: "red",
    localQualityGateEvidence: "static analysis found a compile/import error",
    verificationRun: [
      "touched_build_gate: green before targeted tests",
      "local_quality_gates: inspectcode red before targeted tests",
      "broader_suite_status: not-run-local-quality-red"
    ]
  });

  assert.equal(invalid.exitCode, 2);
  const errors = (invalid.json as { errors: string[] }).errors;
  assert.ok(
    errors.some((error) =>
      error.includes("cannot claim family-closed") && error.includes("local_quality_gates")
    )
  );
});

test("fixer trace helper enforces clear gate and commit_ready before family_commit", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-review-trace-"));
  const traceFile = join(tempDir, "coordinator.jsonl");

  const closureApproved = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260425T121000Z",
      timestamp_utc: "2026-04-25T12:10:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "closure_approved",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001"],
      reviewer_run_id: "review-orchestrator-targeted-return-review-1",
      review_result: "closure-approved",
      return_review_rounds_taken_by_family: {
        "F-001": 1
      }
    })
  ]);
  assert.equal(closureApproved.exitCode, 0);

  const cleanupOnlyGate = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260425T121100Z",
      timestamp_utc: "2026-04-25T12:11:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "pre_commit_gate_result",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001"],
      gate_status: "needs-followup",
      review_gate_result: "clear",
      deslop_gate_result: "cleanup-residue",
      follow_up_kind: "cleanup-only"
    })
  ]);
  assert.equal(cleanupOnlyGate.exitCode, 0);

  const commitReadyBlocked = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260425T121200Z",
      timestamp_utc: "2026-04-25T12:12:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "commit_ready",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001"],
      readiness_basis: "approved diff plus clear pre-commit gate plus lane evidence",
      self_deslop_evidence: ["coortex-deslop completed"],
      lane_review_evidence: ["coortex-review-lane completed"],
      seam_residue_sweep_evidence: ["stale shim and removed-symbol sweep completed"],
      final_touched_build_gate: {
        command: "npm run build",
        scope: "touched package",
        status: "green",
        evidence: "ran before targeted tests"
      },
      final_local_quality_gates: [
        {
          name: "static-analysis",
          command: "repo-configured static analysis",
          status: "green",
          evidence: "local quality gate ran before targeted tests"
        }
      ],
      final_targeted_verification: ["node --test targeted"],
      excluded_unrelated_edits: []
    })
  ]);
  assert.equal(commitReadyBlocked.exitCode, 2);
  assert.ok(
    (commitReadyBlocked.json as { errors: string[] }).errors.some((error) =>
      error.includes("latest 'pre_commit_gate_result'") && error.includes("gate_status 'clear'")
    )
  );

  const clearGate = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260425T121300Z",
      timestamp_utc: "2026-04-25T12:13:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "pre_commit_gate_result",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001"],
      gate_status: "clear",
      review_gate_result: "clear",
      deslop_gate_result: "clear",
      follow_up_kind: "none"
    })
  ]);
  assert.equal(clearGate.exitCode, 0);

  const familyCommitBlocked = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260425T121400Z",
      timestamp_utc: "2026-04-25T12:14:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "family_commit",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001"],
      commit_sha: "abc1234",
      commit_subject: "fix: commit after clear gate",
      return_review_rounds_taken_by_family: {
        "F-001": 1
      }
    })
  ]);
  assert.equal(familyCommitBlocked.exitCode, 2);
  assert.ok(
    (familyCommitBlocked.json as { errors: string[] }).errors.some((error) =>
      error.includes("requires a prior 'commit_ready'")
    )
  );

  const commitReady = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260425T121500Z",
      timestamp_utc: "2026-04-25T12:15:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "commit_ready",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001"],
      readiness_basis: "approved diff plus clear pre-commit gate plus lane evidence",
      self_deslop_evidence: ["coortex-deslop completed"],
      lane_review_evidence: ["coortex-review-lane completed"],
      seam_residue_sweep_evidence: ["stale shim and removed-symbol sweep completed"],
      final_touched_build_gate: {
        command: "npm run build",
        scope: "touched package",
        status: "green",
        evidence: "ran before targeted tests"
      },
      final_local_quality_gates: [
        {
          name: "static-analysis",
          command: "repo-configured static analysis",
          status: "green",
          evidence: "local quality gate ran before targeted tests"
        }
      ],
      final_targeted_verification: ["node --test targeted"],
      excluded_unrelated_edits: []
    })
  ]);
  assert.equal(commitReady.exitCode, 0);

  const familyCommit = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    traceFile,
    "--record-json",
    JSON.stringify({
      run_id: "fixer-orchestrator-20260425T121600Z",
      timestamp_utc: "2026-04-25T12:16:00Z",
      skill: "fixer-orchestrator",
      mode: "native-intake",
      phase: "family_commit",
      review_target: { mode: "return-review", scope_summary: "test" },
      family_ids: ["F-001"],
      commit_sha: "def5678",
      commit_subject: "fix: commit after clear gate",
      return_review_rounds_taken_by_family: {
        "F-001": 1
      }
    })
  ]);
  assert.equal(familyCommit.exitCode, 0);
});

test("fixer trace helper blocks concurrent campaigns and clears after final fix", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-fixer-campaign-"));
  const traceRoot = join(".coortex", "review-trace");

  const init = await runPythonJson(fixResultStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--run-id",
    "fixer-orchestrator-campaign",
    "--owner-host-session-id",
    "codex-thread-fixer",
    "--owner-started-from-cwd",
    tempDir
  ]);

  assert.equal(init.exitCode, 0);
  const initJson = init.json as {
    active_campaign_file: string;
    coordinator_file: string;
    resumed: boolean;
    run_id: string;
  };
  assert.equal(initJson.resumed, false);
  const started = await readFile(initJson.coordinator_file, "utf8");
  assert.match(started, /"phase": "trace_started"/);

  const activeCampaign = JSON.parse(await readFile(initJson.active_campaign_file, "utf8")) as {
    campaign_id: string;
    campaign_type: string;
    owner_host_session_id: string;
    owner_started_from_cwd: string;
    state: string;
    worktree_root: string;
  };
  assert.equal(activeCampaign.campaign_id, "fixer-orchestrator-campaign");
  assert.equal(activeCampaign.campaign_type, "fixer-orchestrator");
  assert.equal(activeCampaign.owner_host_session_id, "codex-thread-fixer");
  assert.equal(activeCampaign.owner_started_from_cwd, tempDir);
  assert.equal(activeCampaign.state, "active");
  assert.equal(activeCampaign.worktree_root, tempDir);

  const concurrent = await runPythonJson(fixResultStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--run-id",
    "fixer-orchestrator-competing"
  ]);
  assert.equal(concurrent.exitCode, 2);
  const concurrentJson = concurrent.json as { reason: string; status: string };
  assert.equal(concurrentJson.status, "error");
  assert.equal(concurrentJson.reason, "concurrent-fixer-run");

  const finalFixPath = join(tempDir, "fixer-final-fix.json");
  await writeFile(
    finalFixPath,
    JSON.stringify(
      {
        run_id: initJson.run_id,
        timestamp_utc: "2026-04-20T16:00:00Z",
        skill: "fixer-orchestrator",
        mode: "native-intake",
        phase: "final_fix",
        review_target: { mode: "branch", scope_summary: "test" },
        family_ids_handled: ["F-001"],
        final_statuses: ["family-closed"]
      },
      null,
      2
    ),
    "utf8"
  );

  const finalFix = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    initJson.coordinator_file,
    "--record-file",
    finalFixPath
  ]);
  assert.equal(finalFix.exitCode, 0);
  const finalFixJson = finalFix.json as { active_campaign_cleared: boolean };
  assert.equal(finalFixJson.active_campaign_cleared, true);

  const fresh = await runPythonJson(fixResultStateScript, [
    "init-trace",
    "--project-root",
    tempDir,
    "--trace-root",
    traceRoot,
    "--run-id",
    "fixer-orchestrator-next"
  ]);
  assert.equal(fresh.exitCode, 0);
});

test("fixer final_fix errors when the active campaign lock is not cleared", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-fixer-terminal-lock-"));
  const traceDir = join(tempDir, ".coortex", "review-trace", "fixer-orchestrator-terminal");
  await mkdir(traceDir, { recursive: true });
  const coordinatorFile = join(traceDir, "coordinator.jsonl");
  await writeFile(coordinatorFile, "", "utf8");

  const finalFixPath = join(tempDir, "orphan-final-fix.json");
  await writeFile(
    finalFixPath,
    JSON.stringify(
      {
        run_id: "fixer-orchestrator-terminal",
        timestamp_utc: "2026-04-22T12:00:00Z",
        skill: "fixer-orchestrator",
        mode: "native-intake",
        phase: "final_fix",
        review_target: { mode: "branch", scope_summary: "test" },
        family_ids_handled: ["F-001"],
        final_statuses: ["family-closed"]
      },
      null,
      2
    ),
    "utf8"
  );

  const finalFix = await runPythonJson(fixResultStateScript, [
    "append-trace",
    "--trace-file",
    coordinatorFile,
    "--record-file",
    finalFixPath
  ]);
  assert.equal(finalFix.exitCode, 2);
  assert.deepEqual(finalFix.json, {
    active_campaign_cleared: false,
    appended: true,
    reason: "active-campaign-not-cleared",
    status: "error",
    trace_file: coordinatorFile
  });
});

function fixerCurrentWorkPacket(): Record<string, unknown> {
  return {
    packet_path: ".coortex/current-work/runtime-packet.json",
    mini_surface_review_packet: {
      packet_version: 1,
      packet_id: "current-work-runtime",
      status: "handoff",
      source: "current_implementation",
      intent: "Review runtime repair changes.",
      baseline_surface_refs: ["runtime-recovery"],
      surface: {
        id: "runtime-recovery",
        name: "Runtime recovery",
        purpose: "Runtime repair",
        primary_anchors: ["src/**"],
        supporting_anchors: ["src/__tests__/runtime.test.ts"],
        contract_docs: ["docs/runtime-state-model.md"],
        configured_builtin_lenses: [{ lens_id: "goal-fidelity", priority: "high" }],
        configured_custom_lenses: [],
        review_focus_areas: ["runtime repair preserves the current-work boundary"]
      },
      review_boundary: {
        in_scope_paths: ["src/a.ts"],
        expected_write_set: ["src/a.ts"],
        out_of_scope: []
      },
      seams: [{ path: "src/a.ts", role: "owner" }],
      invariants: ["runtime repair preserves the current-work boundary"],
      coverage_matrix: {
        rows: [
          {
            row_id: "runtime-main",
            category: "entry_path",
            paths: ["src/a.ts"],
            expected_behavior: "runtime repair preserves the owning seam behavior",
            tests: ["runtime targeted test"],
            status: "tested",
            notes: "packet used by fixer/reviewer integration tests"
          }
        ]
      },
      reviewer_focus: ["boundary preservation"],
      known_uncertainties: []
    }
  };
}

test("fixer helper plans repair slices by seam, overlap, and blocker waves", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-fix-plan-"));
  const reviewHandoffPath = join(tempDir, "review-handoff.json");
  const currentWorkPacket = fixerCurrentWorkPacket();

  const packetValidation = await runPythonJson(coortexReviewStateScript, [
    "validate-current-work-packet",
    "--packet-json",
    JSON.stringify(currentWorkPacket)
  ]);
  assert.equal(packetValidation.exitCode, 0);

  await writeFile(
    reviewHandoffPath,
    JSON.stringify(
      {
        review_handoff: {
          review_target: {
            mode: "branch",
            scope_summary: "branch delta"
          },
          current_work_review_packet: currentWorkPacket,
          families: [
            {
              family_id: "F-A",
              title: "A",
              review_hints: {
                likely_owning_seam: "src/a.ts",
                secondary_seams: [],
                candidate_write_set: ["src/a.ts"],
                candidate_test_set: ["src/__tests__/a.test.ts"],
                candidate_doc_set: [],
                parallelizable: true
              }
            },
            {
              family_id: "F-B",
              title: "B",
              review_hints: {
                likely_owning_seam: "src/a.ts",
                secondary_seams: [],
                candidate_write_set: ["src/a.ts"],
                candidate_test_set: ["src/__tests__/a.test.ts"],
                candidate_doc_set: [],
                parallelizable: true
              }
            },
            {
              family_id: "F-C",
              title: "C",
              review_hints: {
                likely_owning_seam: "src/c.ts",
                secondary_seams: [],
                candidate_write_set: ["src/c.ts"],
                candidate_test_set: ["src/__tests__/c.test.ts"],
                candidate_doc_set: [],
                parallelizable: true
              }
            },
            {
              family_id: "F-D",
              title: "D",
              review_hints: {
                likely_owning_seam: "src/d.ts",
                secondary_seams: [],
                candidate_write_set: ["src/d.ts"],
                candidate_test_set: ["src/__tests__/d.test.ts"],
                candidate_doc_set: [],
                parallelizable: true
              },
              carry_forward_context: {
                reason_kind: "sequenced-after-overlapping-family",
                blocking_family_ids: ["F-C"]
              }
            }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const result = await runPythonJson(fixResultStateScript, [
    "plan-repair-slices",
    "--review-handoff",
    reviewHandoffPath
  ]);

  assert.equal(result.exitCode, 0);
  const json = result.json as {
    status: string;
    orchestration_mode: string;
    lane_ids: string[];
    current_work_review_packet: { packet_id: string; packet_path: string };
    slices: Array<{
      lane_id: string;
      family_ids: string[];
      wave_id: string;
      execution_mode: string;
      current_work_review_packet: { packet_id: string; packet_path: string };
    }>;
    waves: Array<{ wave_id: string; slice_ids: string[] }>;
  };
  assert.equal(json.status, "ok");
  assert.equal(json.orchestration_mode, "coordinated-sequenced");
  assert.equal(json.current_work_review_packet.packet_id, "current-work-runtime");
  assert.equal(json.current_work_review_packet.packet_path, ".coortex/current-work/runtime-packet.json");
  assert.deepEqual(json.lane_ids, ["L-001", "L-002", "L-003"]);
  assert.equal(json.slices[0]?.lane_id, "L-001");
  assert.equal(json.slices[0]?.current_work_review_packet.packet_id, "current-work-runtime");
  assert.deepEqual(json.slices[0]?.family_ids, ["F-A", "F-B"]);
  assert.equal(json.slices[0]?.wave_id, "W-001");
  assert.equal(json.slices[0]?.execution_mode, "sequential-within-slice");
  assert.equal(json.slices[1]?.lane_id, "L-002");
  assert.equal(json.slices[1]?.current_work_review_packet.packet_id, "current-work-runtime");
  assert.deepEqual(json.slices[1]?.family_ids, ["F-C"]);
  assert.equal(json.slices[1]?.wave_id, "W-001");
  assert.equal(json.slices[1]?.execution_mode, "single-family");
  assert.equal(json.slices[2]?.lane_id, "L-003");
  assert.equal(json.slices[2]?.current_work_review_packet.packet_id, "current-work-runtime");
  assert.deepEqual(json.slices[2]?.family_ids, ["F-D"]);
  assert.equal(json.slices[2]?.wave_id, "W-002");
  assert.equal(json.slices[2]?.execution_mode, "single-family");
  assert.deepEqual(json.waves, [
    { wave_id: "W-001", slice_ids: ["S-001", "S-002"] },
    { wave_id: "W-002", slice_ids: ["S-003"] }
  ]);
});

test("fixer helper builds and validates same-lane continuation packets", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-lane-continuation-"));
  const reviewHandoffPath = join(tempDir, "review-handoff.json");
  const lanePlanPath = join(tempDir, "lane-plan.json");
  const continuationPath = join(tempDir, "lane-continuation.json");
  const currentWorkPacket = fixerCurrentWorkPacket();

  await writeFile(
    reviewHandoffPath,
    JSON.stringify(
      {
        review_handoff: {
          review_target: {
            mode: "branch",
            scope_summary: "actionable family lane"
          },
          current_work_review_packet: currentWorkPacket,
          families: [
            {
              family_id: "F-001",
              title: "Actionable family",
              review_hints: {
                likely_owning_seam: "src/core/reclaim.ts"
              }
            }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    lanePlanPath,
    JSON.stringify(
      {
        slices: [
          {
            slice_id: "S-001",
            lane_id: "L-001",
            family_ids: ["F-001"],
            family_metadata: [
              {
                family_id: "F-001",
                title: "Actionable family",
                likely_owning_seam: "src/core/reclaim.ts",
                identity_token: "F-001::Actionable family::src/core/reclaim.ts"
              }
            ],
            continuation_policy: "same-lane-until-approved",
            current_work_review_packet: {
              packet_id: "current-work-runtime",
              packet_path: ".coortex/current-work/runtime-packet.json",
              review_helper: ".codex/skills/coortex-review/scripts/review_state.py",
              validate_packet_command: "validate-current-work-packet",
              validate_review_output_command: "validate-current-work-review-output"
            }
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const built = await runPythonJson(fixResultStateScript, [
    "build-lane-continuation",
    "--review-handoff",
    reviewHandoffPath,
    "--lane-plan-json",
    lanePlanPath,
    "--lane-id",
    "L-001",
    "--worker-session-id",
    "worker-7",
    "--reviewer-run-id",
    "review-orchestrator-return-review-20260420T180000Z",
    "--return-review-round",
    "2"
  ]);

  assert.equal(built.exitCode, 0);
  await writeFile(continuationPath, JSON.stringify(built.json, null, 2), "utf8");
  const continuation = built.json as {
    lane_continuation: {
      lane_id: string;
      worker_session_id: string;
      slice_id: string;
      family_ids: string[];
      original_lane_family_ids: string[];
      original_lane_family_metadata: Array<{
        family_id: string;
        title: string;
        likely_owning_seam: string | null;
        identity_token: string;
      }>;
      return_review_round: number;
      review_source: { skill: string; mode: string; reviewer_run_id: string };
      current_work_review_packet: {
        packet_id: string;
        packet_path: string;
        validate_packet_command: string;
        validate_review_output_command: string;
      };
    };
  };
  assert.equal(continuation.lane_continuation.lane_id, "L-001");
  assert.equal(continuation.lane_continuation.worker_session_id, "worker-7");
  assert.equal(continuation.lane_continuation.slice_id, "S-001");
  assert.deepEqual(continuation.lane_continuation.family_ids, ["F-001"]);
  assert.deepEqual(continuation.lane_continuation.original_lane_family_ids, ["F-001"]);
  assert.deepEqual(continuation.lane_continuation.original_lane_family_metadata, [
    {
      family_id: "F-001",
      title: "Actionable family",
      likely_owning_seam: "src/core/reclaim.ts",
      identity_token: "F-001::Actionable family::src/core/reclaim.ts"
    }
  ]);
  assert.equal(continuation.lane_continuation.return_review_round, 2);
  assert.deepEqual(continuation.lane_continuation.review_source, {
    skill: "review-orchestrator",
    mode: "targeted-return-review",
    reviewer_run_id: "review-orchestrator-return-review-20260420T180000Z"
  });
  assert.equal(continuation.lane_continuation.current_work_review_packet.packet_id, "current-work-runtime");
  assert.equal(
    continuation.lane_continuation.current_work_review_packet.validate_review_output_command,
    "validate-current-work-review-output"
  );

  const validated = await runPythonJson(fixResultStateScript, [
    "validate-lane-continuation",
    "--lane-continuation",
    continuationPath,
    "--expected-lane-id",
    "L-001",
    "--expected-worker-session-id",
    "worker-7",
    "--expected-slice-id",
    "S-001",
    "--lane-plan-json",
    lanePlanPath
  ]);

  assert.equal(validated.exitCode, 0);
  const validatedJson = validated.json as {
    status: string;
    lane_id: string;
    worker_session_id: string;
    slice_id: string;
    family_ids: string[];
    original_lane_family_ids: string[];
    original_lane_family_metadata: Array<{
      family_id: string;
      title: string;
      likely_owning_seam: string | null;
      identity_token: string;
    }>;
    return_review_round: number;
    current_work_packet_id: string;
    current_work_review_packet: { packet_id: string; packet_path: string };
  };
  assert.equal(validatedJson.status, "ok");
  assert.equal(validatedJson.lane_id, "L-001");
  assert.equal(validatedJson.worker_session_id, "worker-7");
  assert.equal(validatedJson.slice_id, "S-001");
  assert.deepEqual(validatedJson.family_ids, ["F-001"]);
  assert.deepEqual(validatedJson.original_lane_family_ids, ["F-001"]);
  assert.deepEqual(validatedJson.original_lane_family_metadata, [
    {
      family_id: "F-001",
      title: "Actionable family",
      likely_owning_seam: "src/core/reclaim.ts",
      identity_token: "F-001::Actionable family::src/core/reclaim.ts"
    }
  ]);
  assert.equal(validatedJson.return_review_round, 2);
  assert.equal(validatedJson.current_work_packet_id, "current-work-runtime");
  assert.equal(validatedJson.current_work_review_packet.packet_path, ".coortex/current-work/runtime-packet.json");
});

test("fixer helper rejects continuation packets with mismatched lane metadata", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-lane-continuation-invalid-"));
  const lanePlanPath = join(tempDir, "lane-plan.json");
  const continuationPath = join(tempDir, "lane-continuation.json");

  await writeFile(
    lanePlanPath,
    JSON.stringify(
      {
        slices: [
          {
            slice_id: "S-001",
            lane_id: "L-001",
            family_ids: ["F-001"],
            family_metadata: [
              {
                family_id: "F-001",
                title: "Expected family",
                likely_owning_seam: "src/core/reclaim.ts",
                identity_token: "F-001::Expected family::src/core/reclaim.ts"
              }
            ],
            continuation_policy: "same-lane-until-approved"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    continuationPath,
    JSON.stringify(
      {
        lane_continuation: {
          lane_id: "L-001",
          worker_session_id: "worker-7",
          slice_id: "S-001",
          family_ids: ["F-001"],
          original_lane_family_ids: ["F-001"],
          original_lane_family_metadata: [
            {
              family_id: "F-001",
              title: "Wrong family",
              likely_owning_seam: "src/core/reclaim.ts",
              identity_token: "F-001::Wrong family::src/core/reclaim.ts"
            }
          ],
          continuation_policy: "same-lane-until-approved",
          return_review_round: 2,
          review_source: {
            skill: "review-orchestrator",
            mode: "targeted-return-review",
            reviewer_run_id: "review-orchestrator-return-review-20260420T180000Z"
          },
          review_handoff: {
            review_target: {
              mode: "branch",
              scope_summary: "actionable family lane"
            },
            families: [
              {
                family_id: "F-001",
                title: "Wrong family"
              }
            ]
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const validated = await runPythonJson(fixResultStateScript, [
    "validate-lane-continuation",
    "--lane-continuation",
    continuationPath,
    "--lane-plan-json",
    lanePlanPath,
    "--expected-lane-id",
    "L-001",
    "--expected-worker-session-id",
    "worker-7",
    "--expected-slice-id",
    "S-001"
  ]);

  assert.equal(validated.exitCode, 2);
  const validatedJson = validated.json as {
    status: string;
    errors: string[];
  };
  assert.equal(validatedJson.status, "error");
  assert.ok(
    validatedJson.errors.some((error) =>
      error.includes("original_lane_family_metadata does not match the provided lane plan")
    )
  );
});

test("family ledger records reopen-after-closed and surfaces it for the current run", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "coortex-family-ledger-"));

  const initial = await runPythonJson(returnReviewStateScript, [
    "append-family-ledger",
    "--trace-root",
    tempDir,
    "--run-id",
    "review-orchestrator-full-review-20260418T100000Z",
    "--review-mode",
    "full-review",
    "--review-target-mode",
    "branch",
    "--review-target-summary",
    "initial review",
    "--family-id",
    "F05",
    "--family-title",
    "Reclaim adoption still lacks durable owner fencing",
    "--family-state",
    "closed",
    "--raw-status",
    "closure-confirmed",
    "--reason-summary",
    "Initial review accepted the reclaim fencing fix."
  ]);

  assert.equal(initial.exitCode, 0);
  assert.deepEqual(initial.json, {
    ledger_file: join(tempDir, "family-ledger.jsonl"),
    previous_state: null,
    recorded: true,
    reopened_after_closed: false
  });

  const reopen = await runPythonJson(returnReviewStateScript, [
    "append-family-ledger",
    "--trace-root",
    tempDir,
    "--run-id",
    "review-orchestrator-return-review-20260418T110000Z",
    "--review-mode",
    "targeted-return-review",
    "--review-target-mode",
    "return-review",
    "--review-target-summary",
    "follow-up review",
    "--family-id",
    "F05",
    "--family-title",
    "Reclaim adoption still lacks durable owner fencing",
    "--family-state",
    "open",
    "--raw-status",
    "still-open-confirmed",
    "--reason-summary",
    "Follow-up review reopened the family after the prior closure claim."
  ]);

  assert.equal(reopen.exitCode, 0);
  assert.deepEqual(reopen.json, {
    ledger_file: join(tempDir, "family-ledger.jsonl"),
    previous_state: "closed",
    recorded: true,
    reopened_after_closed: true
  });

  const currentRunReopens = await runPythonJson(returnReviewStateScript, [
    "current-run-reopens",
    "--trace-root",
    tempDir,
    "--run-id",
    "review-orchestrator-return-review-20260418T110000Z"
  ]);

  assert.equal(currentRunReopens.exitCode, 0);
  assert.deepEqual(currentRunReopens.json, {
    ledger_file: join(tempDir, "family-ledger.jsonl"),
    reopened_families_in_run: [
      {
        family_id: "F05",
        family_title: "Reclaim adoption still lacks durable owner fencing",
        previous_state: "closed",
        current_state: "open",
        previous_run_id: "review-orchestrator-full-review-20260418T100000Z",
        raw_status: "still-open-confirmed",
        reason_summary:
          "Follow-up review reopened the family after the prior closure claim."
      }
    ],
    run_id: "review-orchestrator-return-review-20260418T110000Z"
  });
});
