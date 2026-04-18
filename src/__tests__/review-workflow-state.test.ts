import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
      coverage_confidence: "high"
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
