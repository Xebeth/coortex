---
name: seam-walkback-review
description: Selective git-history archaeology and grouped discovery for seam-based maintainability campaigns. Use when broad branch review churn is too expensive and you need a repeatable way to walk back pivot commits, extract stable seams, build logical commit groups, run bounded two-lens discovery, and hand the campaign to review-orchestrator for exploration-only family synthesis.
---

# Seam Walkback Review

## Purpose

Use this skill when a branch has accumulated maintainability debt and broad
review/fix campaigns are no longer converging.

This skill is now the **discovery phase** of a larger review pipeline:

1. archaeology from selected pivot commits
2. logical commit-group selection
3. bounded two-lens discovery over those groups
4. candidate-family consolidation
5. packet emission
6. automatic handoff to `$review-orchestrator` in packet/exploration mode

This discovery mode does **not** repair code, run mutating cleanup, or commit
micro-slices.

## Conversation-visible plan

Keep a short conversation-visible plan/progress list updated while this skill
runs so the user can tell what is happening.

- Use the conversation `update_plan` tool at the start and after each major
  phase boundary. Keep exactly one step `in_progress` and move it forward as
  the workflow advances.
- Do not rely only on prose status messages when `update_plan` is available.
- At the start, state the active campaign and the next planned phase.
- After archaeology, commit-group review, family consolidation, and handoff,
  update the in-conversation plan/progress before continuing.
- If you re-scope, skip a phase, or discover a better grouping, say so
  explicitly instead of silently changing course.
- These updates are status signals, not approval checkpoints. Unless the user
  explicitly asks you to pause or you are genuinely blocked, continue after the
  update without waiting for acknowledgment.
- Do not end with “if you want, I can continue” or similar offer-to-continue
  wording unless a real terminal condition is met.
- Do not stop with “the packet is ready” or “the campaign completed cleanly”
  while the downstream `$review-orchestrator` exploration phase has not yet
  completed its own packet-driven review run. Packet-ready is an intermediate
  state, not a terminal result.
- Terminal conditions for this workflow are: explicit user stop, no actionable
  commit groups remain, a deterministic helper reports a blocking campaign/lock
  error, the downstream orchestrator handoff cannot be emitted cleanly, or the
  downstream packet-driven `$review-orchestrator` run has reached its own
  terminal review state and the campaign has recorded its terminal walkback
  handoff state.

## When to use it

Good fits:

- a branch has repeated review churn and keeps surfacing new debt
- refactors moved responsibilities, but stale glue or split ownership remains
- one file appears in multiple broad review surfaces and needs a seam-first
  discovery model
- you need stable family ids early enough for reopen tracking to matter

Do not use this skill when:

- you already have one small bounded review slice with no archaeology needed;
  use `$coortex-review`
- you need a normal broad multi-surface review from an already-good baseline;
  use `$review-orchestrator`
- you already have a structured review handoff and only need to repair it;
  use `$fixer-orchestrator`

## Core stance

- History is for archaeology, not for fixing old commits.
- Commit groups are evidence buckets.
- Families are fix units.
- Candidate families emitted here are provisional; `$review-orchestrator` has
  the final say on family grouping, reopen status, and downstream `review_handoff`.
- Use `$coortex-review` as the primary correctness/contract/recovery lens.
- Use `$coortex-deslop` only as a **read-only advisory lens** for duplication,
  stale glue, helper sprawl, seam-placement drift, and ownership confusion.
- In discovery mode, `$coortex-deslop` must not modify files, run cleanup
  passes, or behave like a fixer.
- Deslop-advisory signals alone do not create blocking families. They only
  become actionable through combined orchestrator synthesis.

## Repo defaults for this repository

Treat the active working baselines under `.coortex` as first-class defaults when
present:

- `.coortex/review-baseline.yaml`
- `.coortex/review-baselines/m2-seams.yaml`
- `.coortex/review-baselines/m2-hot-families.yaml`

Use the durable docs/doc baseline paths only as committed fallback when no local
working baseline exists.

## Reuse existing bricks

This skill is a workflow wrapper. Reuse the installed review-skill-pack bricks
instead of redoing their jobs:

- `$review-baseline` to refresh or derive the active working baseline when repo
  mapping is stale
- `$coortex-review` as the primary bounded discovery lens over each selected
  commit group
- `$coortex-deslop` as the secondary **read-only advisory** discovery lens over
  the same bounded group window
- `$review-orchestrator` to consume the emitted packet and run packet-bootstrap
  prep + coverage + family exploration + synthesis

## Deterministic helpers

Push the truly mechanical pieces into scripts.

### Seam-walk helper

Use this skill's helper for worktree inventory, packet pathing, campaign lock
handling, and seam-walk trace management:

```bash
python scripts/walkback_state.py inventory --project-root . --base-ref origin/main
python scripts/walkback_state.py commit-files <sha> --project-root .
python scripts/walkback_state.py init-trace --project-root .
python scripts/walkback_state.py packet-path --trace-dir .coortex/review-trace/<run_id>
python scripts/walkback_state.py append-trace --trace-file <path> --record-file <json-file>
```

The helper also prevents concurrent top-level seam-walk campaigns in the same
worktree and blocks seam-walk startup when another top-level review campaign is
already active there.

### Orchestrator helper

Use the review-orchestrator helper for packet validation and the eventual
packet-mode handoff:

```bash
python ../review-orchestrator/scripts/return_review_state.py validate-discovery-packet \
  --packet-file .coortex/review-trace/<run_id>/seam-walk-packet.json \
  --project-root .
```

(When working from the installed skill pack, resolve the script path relative to
that installed skill directory instead of the source path shown above.)

## Workflow

Before the workflow phases below, create or resume a seam-walkback trace via the
bundled helper and append phase-boundary records as described in
`references/trace-artifact.md`.

### 1. Check runtime and worktree state

Before touching anything:

- check Coortex runtime/worktree state
- inspect the current worktree for pre-existing dirt
- fail fast if the helper reports another top-level review campaign already owns
  this worktree

### 2. Run selective walkback archaeology

Do **not** review every commit.

Instead, select a small set of pivot commits that moved responsibilities. Look
for:

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

Keep the output short: a debt note with a few concrete items.

### 3. Consolidate archaeology into stable seams

Group the archaeology into recurring review units such as:

- command orchestration
- run reconciliation
- attachment lifecycle mutation
- shared host-run infrastructure
- host adapter contract
- envelope or prompt bounds

Avoid naming seams after one temporary file unless that file is the clear
long-term owner.

### 4. Select logical commit groups

Choose bounded commit groups that act as **evidence buckets** for the next
review window.

For each group, record:

- group id and label
- why these commits belong together
- primary seams involved
- candidate files / surfaces that define the bounded group window

### 5. Run two-lens grouped discovery

For each bounded commit group, run two complementary **read-only** lenses over
that same window:

- `$coortex-review` (primary)
  - correctness
  - contracts/invariants
  - operator truth
  - recovery semantics
  - root cause and defect-family grounding
- `$coortex-deslop` (advisory)
  - duplication
  - stale glue
  - seam-placement drift
  - helper sprawl
  - ownership confusion
  - cleanup debt

In discovery mode:

- neither lens may modify files
- `$coortex-deslop` must not act like a fixer or post-fix cleanup pass
- deslop signals alone do not become blocking families

### 6. Consolidate candidate families

Merge the grouped lens outputs into provisional discovery families.

For each candidate family, record enough for downstream synthesis:

- stable provisional `family_id`
- candidate root cause
- source commit-group ids
- which signals are review-grounded
- which signals are deslop-advisory
- likely owning seam and any grounded secondary seams

### 7. Emit a discovery packet and hand off automatically

Emit a discovery packet that follows the orchestrator packet contract in:
`../review-orchestrator/references/discovery-packet.md`.

Validate the packet with the orchestrator helper before handoff.

Then hand the campaign directly to `$review-orchestrator` in packet-driven
exploration mode in the same workflow turn. The user should not need to
manually chain the next skill, and packet emission alone is not a successful
stop point.

If the downstream orchestrator leaves actionable families, do not consider the
handoff complete until it has persisted the canonical downstream
`review-handoff.json` artifact. Surface the packet path, downstream
orchestrator run id, and downstream `review_handoff` path in the final summary
when that artifact exists.

### 8. End with a real terminal record

Every non-aborted run must end with an explicit terminal record after handoff.
`handoff_emitted` is not terminal by itself; the downstream
`$review-orchestrator` packet-driven run must have completed its own
`final_review` before the seam-walk campaign may report completion.

Use `handoff-completed` only when the downstream orchestrator either:
- ended with `NO_ACTIONABLE_FAMILIES`, or
- persisted and traced the downstream `review_handoff`

If actionable families remain but the downstream handoff artifact is missing,
end as `blocked` with the missing-handoff reason instead of reporting a clean
handoff completion.

Do not leave a campaign with only intermediate records such as review,
verification, or commit-like boundaries.

## Guardrails

- Do not repair code or commit slices in discovery mode.
- Do not run mutating `$coortex-deslop` cleanup inside discovery mode.
- Do not start a concurrent seam-walk campaign in the same worktree.
- Do not allow standalone `$review-orchestrator` to run concurrently in the
  same worktree; only the orchestrator phase launched from this campaign may
  proceed while the campaign is active.
- Do not end after discovery-packet emission alone. Start the packet-driven
  `$review-orchestrator` exploration phase, wait for its terminal review
  record, or report a real blocking failure.
- Do not let candidate families become final family truth locally; the
  orchestrator validates them against the family ledger and assigns final family
  grouping.
