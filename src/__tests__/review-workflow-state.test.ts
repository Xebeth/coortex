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
