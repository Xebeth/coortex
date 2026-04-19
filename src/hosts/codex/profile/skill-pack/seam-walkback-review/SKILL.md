---
name: seam-walkback-review
description: Selective git-history archaeology for seam-based maintainability cleanup. Use when broad branch review churn is too expensive and you need a repeatable process to walk back pivot commits, extract stable seams, refresh or derive review baselines, run targeted seam reviews, repair the owning module on current HEAD, run a touched-files-only anti-slop cleanup pass, verify, and commit each slice atomically.
---

# Seam Walkback Review

## Purpose

Use this skill when a branch has accumulated maintainability debt and broad
review/fix campaigns are no longer converging.

This skill turns that work into a repeatable loop:

1. archaeology from selected pivot commits
2. seam extraction from the archaeology notes
3. baseline refresh or seam-variant baseline creation
4. targeted seam review on current HEAD
5. owning-seam repair
6. mandatory post-fix anti-slop cleanup on touched files only
7. targeted verification and atomic commit

## Conversation-visible plan

Keep a short conversation-visible plan/progress list updated while this skill
runs so the user can tell what is happening.

- At the start, state the current cluster or seam and the next planned step.
- After each major phase boundary, update the in-conversation plan/progress
  before diving back into execution.
- If you re-scope, skip a phase, or discover a better next slice, say so
  explicitly instead of silently changing course.
- These updates are status signals, not approval checkpoints. Unless the user
  explicitly asks you to pause or you are genuinely blocked, continue after the
  update without waiting for acknowledgment.

## When to use it

Good fits:

- a branch has repeated review churn and keeps surfacing new debt
- refactors moved responsibilities, but stale glue or split ownership remains
- one file appears in multiple broad review surfaces and needs a seam-first
  review model
- you want reproducible maintainability cleanup instead of ad hoc prompts

Do not use this skill when:

- you already have one small bounded review slice with no archaeology needed;
  use `$coortex-review`
- you need a normal broad multi-surface review from an already-good baseline;
  use `$review-orchestrator`
- you only need to refresh or create baselines with no execution slice;
  use `$review-baseline`
- you already have a structured review handoff and only need to repair it;
  use `$review-fixer`

## Core stance

- History is for archaeology, not for fixing old commits.
- Fix only on current `HEAD`.
- Treat findings as defect families, not isolated symptoms.
- Prefer stable seams over one-off files or temporary bug labels.
- Use a post-fix anti-slop cleanup pass only after a bounded repair lands; do
  not use cleanup as the archaeology tool.
- Keep every repair slice small enough to verify and commit atomically.

## Repo defaults for this repository

When working in this repo, the durable committed defaults are:

- primary baseline: `docs/review-baseline.yaml`
- seam variant baseline: `docs/review-baselines/m2-seams.yaml`

But treat `.coortex/review-baseline.yaml` as the active working baseline when it
exists. Use the existing `review-orchestrator` helper to resolve the active
baseline before assuming the docs path is authoritative.

Refresh the relevant baseline if repo mapping is stale before relying on it.

## Reuse existing bricks

This skill is a workflow wrapper. Reuse the installed review-skill-pack bricks
instead of redoing their jobs:

- `$review-baseline` for primary-baseline refresh or seam-variant baseline work
- `$review-orchestrator` for seam reviews that cleanly match a baseline surface
- `$coortex-review` for one bounded slice that does not narrow cleanly through
  the baseline
- `$review-fixer` when a structured review handoff already exists
- `$coortex-deslop` for the mandatory post-fix cleanup pass on touched files only

This skill decides **when** to use those bricks and in what order.

## Deterministic helpers

Only push the parts that are truly mechanical into scripts.

Use the bundled helper in this skill for the git-side mechanics:

- `scripts/walkback_state.py inventory --project-root . --base-ref origin/main`
  to capture current branch state, merge base, dirty files, and recent commits
- `scripts/walkback_state.py commit-files <sha>` to emit the changed-file set
  for a pivot commit while doing archaeology
- `scripts/walkback_state.py init-trace --project-root .` to create or resume a
  first-class seam-walkback trace directory
- `scripts/walkback_state.py append-trace --trace-file <path> --record-file <json-file>`
  to append validated phase-boundary trace records

Reuse the existing deterministic helper in `$review-orchestrator` for baseline
resolution and narrowing instead of inventing a second implementation:

- `scripts/return_review_state.py resolve-full-review-baseline ...`
- `scripts/return_review_state.py validate-full-review-narrowing ...`

Together, those helpers cover the mechanical parts that benefit from
repeatability:

- current worktree and merge-base inventory
- per-commit changed-file lookup during archaeology
- seam-walkback trace directory and JSONL record handling
- baseline resolution
- baseline narrowing validation

Do **not** script the archaeology judgment itself yet. Pivot selection and seam
consolidation are still judgment-heavy and should remain in the skill text until
a stable deterministic pattern emerges.

## Workflow

Before the workflow phases below, create or resume a seam-walkback trace via the
bundled helper and append phase-boundary records as described in
`references/trace-artifact.md`.

### 1. Check runtime and worktree state

Before touching anything:

- check Coortex runtime state
- inspect the current worktree
- note any pre-existing dirty files so they do not leak into later commits

### 2. Run selective walkback archaeology

Do **not** review every commit.

Instead, select a small set of pivot commits that moved responsibilities.
Look for:

- seam extraction refactors
- ownership migrations
- adapter contract rewrites
- recovery/persistence boundary changes
- command-layer consolidations

For each pivot cluster, answer:

1. what responsibility moved?
2. what old path was supposed to disappear?
3. what tests or docs define the new contract?
4. what later patches suggest fallout from that move?

Keep the output short: a debt note with at most a few concrete items.

### 3. Consolidate debt notes into stable seams

Group the archaeology into recurring review units such as:

- command orchestration
- run reconciliation
- attachment lifecycle mutation
- shared host-run infrastructure
- host adapter contract
- envelope or prompt bounds

Avoid naming seams after one current file unless that file is the clear long-term
owner.

### 4. Refresh or derive baselines

If the primary baseline has stale paths or obvious ownership overlap, refresh it
first.

Then decide whether you need an alternative seam-focused baseline.

Use `$review-baseline` when you need to:

- refresh the primary repo mapping
- create a seam-focused derived or fresh variant baseline
- replace noisy broad surfaces with better seam surfaces

For this repo, the existing seam variant already lives at:
`docs/review-baselines/m2-seams.yaml`.

### 5. Choose the next execution slice

Pick one seam or one debt note.

Review choice:

- use `$review-orchestrator` when the seam cleanly matches a baseline surface
- use `$coortex-review` when the slice is bounded but does not narrow cleanly
  through the baseline

Default to one seam or one bounded slice at a time.
Do not reopen the whole branch.

### 6. Repair in the owning module on current HEAD

When a finding is confirmed:

- identify the owning seam/module
- remove stale glue or duplicate interpretation paths
- check sibling manifestations in the affected seam
- avoid adding new wrappers or compatibility plumbing beside the real owner

Use `$review-fixer` when structured review output already exists and you want a
repair driven from that handoff.
Otherwise perform one bounded repair slice on current `HEAD`.

### 7. Mandatory post-fix anti-slop pass

After the code repair and before final verification, run `$coortex-deslop` on
touched files only. Use the bundled `scripts/deslop_state.py` helper from that
skill to resolve the changed-files scope and execute the pre/post cleanup gates
deterministically.

Use it to:

- delete stale code left behind by the fix
- absorb duplicate branches or local helper drift
- simplify naming and local ownership
- keep the diff bounded

Do **not** broaden this into an unrelated refactor.

### 8. Verify the slice

Run targeted verification for the touched seam:

- diagnostics or typecheck on touched files
- focused tests for the repaired behavior
- build or integration coverage when materially needed

Do not rely on a generic broad branch rerun if targeted verification is what
actually locks the slice.

### 9. Commit atomically

Commit only the files that belong to the slice.
Leave unrelated dirty files alone.

The commit should capture:

- one maintainability or ownership slice
- the repair
- any same-slice test or doc update

## Output expectations

When using this skill, keep progress visible. Prefer short structured updates
such as:

- current archaeology cluster
- current seam or debt note
- why this slice was chosen
- verification run
- whether the slice is ready to commit

## Guardrails

- Do not turn archaeology into commit-by-commit closure review.
- Do not fix on historical commits.
- Do not create a fake baseline for one transient annoyance.
- Do not skip the post-fix anti-slop pass.
- Do not mix several seams into one cleanup commit just because they are nearby.
- If a seam note turns into a broader branch-wide issue, stop and re-scope
  rather than silently expanding the slice.
