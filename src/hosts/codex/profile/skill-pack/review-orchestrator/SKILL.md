---
name: review-orchestrator
description: Execute bounded multi-agent code review from a persistent project review baseline, consume a seam-walk discovery packet for exploration-only synthesis, or perform targeted return review against a review handoff. Use when a project already has a review baseline and you need coordinated prep, bounded lanes, mandatory family exploration, severity-rated synthesis, or fixer-ready handoff emission.
---

# Review Orchestrator

## Overview

`review-orchestrator` still works on its own.

It now supports three entry modes:

1. **full discovery review**
   - baseline-driven review from the current project state
2. **packet-driven exploration review**
   - consume a precomputed seam-walk discovery packet and continue from packet
     bootstrap prep into coverage/family exploration/synthesis
3. **targeted return review**
   - re-review a fixer slice against an existing `review_handoff`

In packet-driven exploration mode, the orchestrator still has the **final say
on families**. Even when seam-walk provides candidate families, the coordinator
validates them against the current family ledger, merges/splits/regroups them as
needed, and assigns the final family grouping, reopen status, and downstream
`review_handoff`.

## Workflow

Resolve bundled script paths relative to this installed skill directory under
`.codex/skills/review-orchestrator/`, not relative to the repository root.

When this workflow names a `scripts/return_review_state.py` subcommand for
trace init, packet validation, canonical handoff pathing/writing, omission
summaries, ledger updates, or reopen reporting, run that exact helper command
instead of recreating those outputs by hand. Treat helper-produced paths,
validation results, and ledger summaries as authoritative. If a required
helper-owned artifact or trace step cannot be produced, stop and surface a
protocol error instead of prose-completing the review.

1. Load these references as needed:
   - `references/prep-and-refusal.md`
   - `references/execution-model.md`
   - `references/report-contract.md`
   - `references/review-handoff.md`
   - `references/discovery-packet.md`
   - `references/closure-gate.md`
   - `references/return-review.md`
   - `references/trace-artifact.md`
   - `scripts/return_review_state.py`
2. Determine review mode:
   - full discovery review from the project baseline
   - packet-driven exploration review from a seam-walk discovery packet
   - targeted return review from `review_handoff + review_return_handoff`
3. Create or resume the run trace directory/files via the bundled helper.
4. If this is a full discovery review:
   - resolve the active baseline, preferring `.coortex/...` working baselines
     and falling back to durable docs/doc paths only when no local working
     baseline exists
   - run full prep
   - spawn coverage lanes, then mandatory family-exploration lanes
5. If this is a packet-driven exploration review:
   - validate the seam-walk discovery packet with the bundled helper
   - run **packet-bootstrap prep**, not full archaeology/discovery prep
   - preload the family ledger and surface reopen candidates from existing
     family history
   - treat the packet's commit groups as evidence buckets and the packet's
     candidate families as provisional inputs
   - run coverage + mandatory family-exploration lanes against the packet's
     bounded group windows
   - synthesize final families, preserving packet family ids where possible and
     recording merge/split/regroup outcomes when they change
6. If this is a targeted return review:
   - keep the current return-review flow
7. Synthesize the final review result.
8. Emit **and persist** a fixer-ready downstream `review_handoff` at the
   canonical trace path when actionable families remain.
9. Append final trace records and normalized family-ledger outcomes.
10. Surface families reopened in the current run using the helper's ledger
    summary rather than prose reconstruction.

## Packet-driven exploration specifics

Packet-driven exploration exists to continue a seam-walk campaign without
repeating archaeology.

Use it when `seam-walkback-review` has already produced:
- archaeology clusters
- logical commit groups
- bounded two-lens discovery windows
- provisional candidate families

In packet mode:
- prep is **packet bootstrap**, not a second archaeology pass
- the packet is canonical campaign input
- the coordinator still aggregates, normalizes, groups, and assigns the final
  family result
- packet family ids are provisional but stable enough to support ledger-based
  reopen reasoning
- the coordinator may merge/split/regroup packet families, but it must make the
  lineage explicit in the synthesized output

## Two-lens discovery model

In packet-driven exploration mode, use the two-lens distinction explicitly:

- `$coortex-review`
  - primary review lens
  - correctness / contracts / invariants / operator truth / recovery semantics
- `$coortex-deslop`
  - read-only advisory maintainability lens
  - duplication / stale glue / seam drift / helper sprawl / ownership confusion

Rules:
- packet-driven discovery lanes are read-only
- `$coortex-deslop` must not mutate files in this mode
- deslop-advisory signals alone do not become blocking families
- the coordinator's combined synthesis decides whether advisory signals join a
  final family

## Surface focus areas

When a mapped baseline surface includes `review_focus_areas`:

- pass them through to the relevant coverage, exploration, and return-review
  lanes as recurring failure checks
- use them to sharpen sibling inspection and return-review rechecks
- do not create extra lanes just because focus areas exist
- do not treat them as automatic findings or as replacements for custom lenses

## Current-work packets

When the review input includes a current-work mini-surface packet:

- validate it with the installed
  `.codex/skills/coortex-review/scripts/review_state.py validate-current-work-packet`
  helper before using it as lane context
- pass the validated packet surface, boundary, and coverage rows to the
  relevant review lanes
- require lane output to include `surface_checked` or `matrix_not_applicable`
  and validate that output with
  `.codex/skills/coortex-review/scripts/review_state.py validate-current-work-review-output`
- treat helper validation results as authoritative; do not reconstruct packet
  or matrix validation in prose

## Conversation-visible plan

Because orchestrated review can run for a while, keep a short
conversation-visible plan/progress list updated so the user knows what phase is
active.

- Use the conversation `update_plan` tool at the start and after each major
  phase boundary. Keep exactly one step `in_progress` and move it forward as
  the review advances.
- Do not rely only on prose status messages when `update_plan` is available.
- At the start, state the review mode and the next phase.
- After prep/bootstrap, after lane spawning, and before final synthesis, update
  the in-conversation plan/progress.
- If the review has to re-scope, wait on slow lanes, relaunch work, or surface
  reopen events, say so explicitly rather than going silent.
- These updates are not pause points. Unless the user explicitly asks you to
  stop or the workflow is blocked on missing input/evidence, continue after the
  update without waiting for acknowledgment.

## Hard rules

- In full discovery review, refuse if the baseline is missing, unparseable,
  stale, or too underspecified for grounded execution.
- In packet-driven exploration mode, refuse if the packet fails validation or
  no longer matches the current worktree/head state.
- A run with actionable families is not complete until `review-handoff.json`
  has been written to the canonical trace path, traced via
  `review_handoff_emitted`, and referenced by the terminal `final_review`
  record.
- Standalone top-level orchestrator campaigns must not run concurrently with an
  active seam-walk or fixer-orchestrator campaign in the same worktree.
- Packet-driven orchestrator exploration is allowed during an active seam-walk
  campaign only when it is linked to that campaign id.
- Targeted return review is allowed during an active fixer-orchestrator
  campaign only when it is linked to that campaign id.
- Do not redo seam-walk archaeology inside packet-driven exploration mode.
- Do not let packet candidate families bypass coordinator synthesis or ledger
  validation.
- Do not preserve a deferred-family classification if the family was materially
  started and left half-done.
- Keep the trace on disk rather than surfacing it in normal output unless the
  user explicitly asks.
