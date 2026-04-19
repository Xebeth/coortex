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
  "src/hosts/codex/profile/skill-pack/review-fixer/scripts/fix_result_state.py"
);
const seamWalkbackStateScript = resolve(
  process.cwd(),
  "src/hosts/codex/profile/skill-pack/seam-walkback-review/scripts/walkback_state.py"
);
const aiSlopCleanerStateScript = resolve(
  process.cwd(),
  "src/hosts/codex/profile/skill-pack/coortex-deslop/scripts/deslop_state.py"
);

async function runPythonJson(
  scriptPath: string,
  args: string[]
): Promise<{ exitCode: number; json: unknown; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("python", [scriptPath, ...args]);
    return {
      exitCode: 0,
      json: JSON.parse(result.stdout),
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
      json: JSON.parse(failure.stdout ?? "{}"),
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? ""
    };
  }
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
      run_id: "review-fixer-20260418T120000Z",
      timestamp_utc: "2026-04-18T12:00:00Z",
      skill: "review-fixer",
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
