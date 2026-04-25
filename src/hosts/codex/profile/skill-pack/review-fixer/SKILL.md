---
name: review-fixer
description: User-facing single-agent Coortex fixer for one bounded repair slice, one narrowed review result, or one deslop follow-up. Use when Codex should repair a scoped issue directly without coordinated lanes or a formal review_handoff.
---

# Review Fixer

Use this skill when one bounded repair can be executed coherently by a single
agent.

Good fits:

- one narrowed seam or module fix
- one bounded review finding set
- one deslop follow-up that now needs actual repair
- one grounded family or symptom cluster that does not need coordinated lanes
- one prompt-driven repair where the write scope and closure target are already
  reasonably bounded

Do not use this skill when the fix needs:

- coordinated repair lanes or wave planning across several families
- a structured `review_handoff` with cross-family batching and independent lane
  review
- archaeology, broad discovery, or family synthesis before repair

In those cases, use `$fixer-orchestrator`, `$coortex-review`, or
`$review-orchestrator` as appropriate.

## Core stance

- Stay inside one bounded repair unit.
- Repair at the owning seam, not the nearest manifestation.
- Prefer converging on an existing owner over adding new helper glue.
- Lock behavior with targeted verification before and after repair.
- Run a bounded `$coortex-deslop` and `$coortex-review` pass on your own
  changes before you claim the slice is done.
- Prefer explicit residual risk over pretending closure is stronger than the
  evidence.

## Workflow

1. Confirm the requested fix scope is bounded enough for one agent.
2. Read the prompt, changed files, review findings, deslop findings, tests,
   and any closure target the user supplied.
3. If the input is actually a multi-family coordinated repair request or a full
   `review_handoff` that should be lane-orchestrated, stop and direct the user
   to `$fixer-orchestrator`.
4. Normalize the work into one bounded repair objective and one closure target.
5. Implement the fix at the owning seam.
6. Run targeted verification.
7. Run bounded `$coortex-deslop` on the touched scope.
8. Run bounded `$coortex-review` on the touched scope.
9. Rerun targeted verification after any cleanup.
10. Report the resulting state, residual risks, and any still-open adjacent
    threads.

## Hard rules

- Single-agent only. Do not spawn subagents.
- Do not widen into coordinated lane planning.
- Do not require a formal `review_handoff` when the prompt already gives a
  bounded fix objective.
- Do not treat a broad or ambiguous fix brief as if it were bounded enough; if
  the real work needs family synthesis or lane coordination, stop and redirect.
- Before adding a helper or new path, check whether the owning abstraction
  already exists.
- Update tests and docs in the same slice when the repair changes an operator-
  visible contract, invariant, or documented behavior.
- Do not commit unless the user explicitly asks for a commit or the surrounding
  workflow requires it.

## Conversation-visible progress

- Use the conversation `update_plan` tool at the start and after each major
  phase boundary when the repair spans multiple phases.
- Do not rely only on prose status updates when `update_plan` is available.
- Treat those updates as non-blocking progress notes, not approval
  checkpoints.
- State the active repair scope and next step.

## Default output

Unless the prompt overrides it, return:

## Scope

- [bounded files / seam / objective]

## Repair

- [what changed and why]

## Verification

- [tests/checks run]

## Residual Risks

- [remaining open issues or `None`]
