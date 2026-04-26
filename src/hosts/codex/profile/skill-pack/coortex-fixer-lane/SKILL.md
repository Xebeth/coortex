---
name: coortex-fixer-lane
description: Coortex-owned bounded repair lane for one family or one lane-continuation packet. Use when a fixer-orchestrator worker needs to implement one scoped family slice, self-review, self-deslop, and emit review_return_handoff without committing.
---

# Coortex Fixer Lane

## Purpose

This skill is the lane-local repair worker used by Coortex's managed fixer
workflow.

Use it for:

- one family-local repair slice from a `review_handoff`
- one lane-continuation packet returned by targeted return review
- one bounded owning-seam repair lane that must preserve same-worker context
- one of the above with a current-work mini-surface packet that must stay in
  sync with lane-local review

This is an internal lane worker, not a user-facing fixer entrypoint.
Use `review-fixer` for bounded standalone repair and `fixer-orchestrator` for
structured coordinated repair.

## Core stance

- Stay inside the supplied lane scope.
- Repair at the owning seam, not the nearest manifestation.
- Treat the closure gate as the family acceptance target.
- Preserve same-worker thread continuity when resuming from a valid
  continuation packet.
- Preserve any current-work mini-surface packet supplied by the coordinator.
  Treat its review boundary and coverage rows as repair/review context, not
  optional prose.
- Run lane-safe self-deslop and self-review before handing back results.
- Emit `review_return_handoff` and never commit.

## Workflow

Resolve bundled script paths relative to the installed skill directories under
`.codex/skills/`. For sibling helpers, resolve `../fixer-orchestrator/...`
relative to `.codex/skills/coortex-fixer-lane/`, not relative to the
repository root.

When a continuation packet is present,
`../fixer-orchestrator/scripts/fix_result_state.py validate-lane-continuation`
is the canonical identity check. Run that exact helper command instead of
re-deriving lane/session/slice matching by hand, treat the helper result as
authoritative, and stop with a protocol error if the validation step cannot
run or fails.

When the lane prompt or continuation packet includes `current_work_review_packet`
or a current-work packet path, validate it with the sibling review helper before
using it:

```bash
python ../coortex-review/scripts/review_state.py validate-current-work-packet \
  --packet-file <packet-path>
```

Use `--packet-json` when the packet is embedded. Treat that helper result as
authoritative, and pass the same packet into lane-local `$coortex-review-lane`.
Do not reconstruct coverage-row or matrix validation by hand.

1. Read the scoped family or continuation packet.
2. If this is a continuation packet, validate it before resuming. When the
   original lane plan JSON is available, use the shared helper from the sibling
   orchestrator skill:

```bash
python ../fixer-orchestrator/scripts/fix_result_state.py validate-lane-continuation \
  --lane-continuation <path> \
  --lane-plan-json <path> \
  --expected-lane-id <lane_id> \
  --expected-worker-session-id <worker_session_id> \
  --expected-slice-id <slice_id>
```

3. Resume the same worker's family-local context. Do not restart first-pass
   analysis from scratch after a valid continuation packet.
4. If a current-work packet is supplied, validate it and keep the repair inside
   its review boundary unless the coordinator explicitly expands the slice.
5. Implement the bounded fix at the owning seam.
6. Run targeted verification only.
7. Run lane-local `$coortex-deslop`.
8. Run lane-local `$coortex-review-lane`, not standalone `$coortex-review`.
   Standalone `$coortex-review` correctly refuses while the parent
   fixer-orchestrator or review-orchestrator campaign owns the worktree, so it
   must not be used to satisfy worker self-review.
   If a current-work packet is in scope, pass it through and validate the
   lane-review output with
   `../coortex-review/scripts/review_state.py validate-current-work-review-output`.
9. Rerun targeted verification only.
10. Emit `review_return_handoff` for the coordinator, including packet-aware
    review evidence when a current-work packet was supplied.
11. Stop. Do not commit.

## Hard rules

- Read-write repair is allowed only inside the bounded lane scope.
- Do not spawn subagents from this lane skill.
- Do not broaden into multi-family coordination.
- Do not commit.
- Do not run repo-wide, full-suite, or broader seam-level verification from
  the lane by default. Lanes own targeted verification only; broader
  verification required for `family-closed` belongs to the coordinator's
  closure gate.
- Do not self-certify family closure as final truth; targeted return review has
  final say.
- Do not respawn yourself as a new lane when a valid continuation packet says
  to resume the existing lane.
- Do not drop or silently replace `current_work_review_packet` from the lane
  prompt, continuation packet, self-review prompt, or `review_return_handoff`.
- If continuation validation fails, stop and surface the mismatch instead of
  guessing.

## Conversation-visible progress

- Use the conversation `update_plan` tool at the start and after major phase
  boundaries when the lane spans multiple phases.
- Do not rely only on prose status updates when `update_plan` is available.
- Treat those updates as non-blocking progress notes, not approval
  checkpoints.
- State the active family/lane and next step.

## Default output

Return compact lane-local repair progress plus the emitted
`review_return_handoff` path or summary.
