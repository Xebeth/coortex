---
name: coortex-review
description: User-facing single-agent Coortex review for one bounded seam, family, surface, or module. Use when the review scope is small enough for one agent and a full multi-agent orchestrated review would be overkill.
---

# Coortex Review

## Purpose

Use this skill when one bounded review unit can be reviewed coherently by a
single agent.

Good fits:

- one explicit seam or module
- one known defect family
- one bounded surface slice
- one targeted diff where the user already narrowed scope

Do not use this skill when the review needs:

- multiple independent coverage lanes
- family regrouping across several unrelated surfaces
- broad review-window decomposition
- return-review coordination across several families

In those cases, use `$review-orchestrator` instead.

## Core stance

- Stay inside the bounded review scope you were given.
- Findings come first.
- Check contract, closure-gate, and behavioral claims before style or cleanup.
- Prefer explicit uncertainty over rounding up to a pass.
- If the prompt gives an exact output schema, follow it instead of the default
  summary format.
- If the prompt gives configured lenses, use them as ordered review concerns.

## Built-in lenses

These match the built-in lens ids configured by `review-baseline` and used by
`coortex-review-lane`.

- `goal-fidelity`
  - verify requested behavior, closure-gate requirements, and review-handoff
    claims first
- `qa-execution`
  - prefer executable evidence and runnable failure-path checks when the review
    scope expects them
- `quality`
  - inspect logic correctness, maintainability, and boundary hygiene
- `security`
  - inspect only genuine security or trust-boundary problems
- `api-contract`
  - inspect externally visible contract compatibility and caller impact
- `performance`
  - inspect only material hot-path or algorithmic risks in scope
- `portability`
  - inspect platform, filesystem, shell, path, and repo-layout assumptions
    that could break behavior across environments or host setups
- `context-history`
  - inspect sibling paths, adjacent callers, docs, and relevant history needed
    to judge whether the root cause is wider than the immediate diff

## Deterministic helper

Use the bundled helper to avoid standalone review against an already active
top-level review/fix campaign in the same worktree:

```bash
python scripts/review_state.py check-active-campaign --project-root .
```

If it reports an active `fixer-orchestrator`, `review-orchestrator`, or
`seam-walkback-review` campaign, refuse standalone `$coortex-review` instead of
reading a live overlapping worktree. Surface the lock metadata, including any
recorded `owner_host_session_id`, fallback `owner_host_thread_id`, and
`owner_started_from_cwd`, so the operator can tell where that run was started.

## Workflow

1. Use the helper to check for an active top-level review/fix campaign lock in
   the same worktree before starting standalone review.
2. Confirm that the requested review scope is bounded enough for one agent.
3. Read the scoped files, diff, and any supplied contract docs, closure gate,
   or review handoff.
4. If the scope is too broad or would require multiple independent review
   passes, stop and direct the user to `$review-orchestrator`.
5. If a top-level fixer/review campaign is already active in this worktree,
   stop and refuse standalone `$coortex-review`. Wait for the active fixer to
   reach a review handoff, or use the linked orchestrated review path instead
   of reviewing a mutating worktree.
6. Apply the configured lenses inside the bounded scope. If none are provided,
   default to `goal-fidelity`, `quality`, and `context-history`.
7. Inspect the sibling paths needed to judge whether the same root cause still
   exists inside the bounded review scope.
8. Run lightweight diagnostics or execution evidence only when the environment
   supports them and they materially affect correctness for this review.
9. Return severity-rated findings with concrete file evidence.

## Conversation-visible progress

Even for a bounded review, keep the user informed with brief plan/progress
updates when the review takes more than one phase.

- Use the conversation `update_plan` tool at the start and after each major
  phase boundary when the review spans multiple phases.
- Do not rely only on prose status messages when `update_plan` is available.

- At the start, state the bounded scope and next review step.
- If you expand to inspect sibling paths or run executable evidence, mention
  that before doing it.
- Before delivering the verdict, briefly summarize the completed review steps.
- These updates are progress notes, not pause points. Unless the user
  explicitly asks you to stop or the review is blocked on missing input,
  continue after the update without waiting for acknowledgment.

## Optional machine output

When the user explicitly asks for a fixer-consumable one-family handoff, emit a
single-family `review_handoff` using the same contract shape as
`review-orchestrator`.

Only do this when:

- the review truly stayed bounded to one family
- the root cause and likely owning seam are grounded enough to state directly
- the evidence is strong enough to give a real closure gate and review hints

If the review scope is too fuzzy for a grounded one-family handoff, return
normal findings instead of fabricating machine output.

## Guardrails

- Read-only review: do not implement fixes.
- Do not review against a worktree that already has an active top-level
  fixer/review campaign lock.
- Do not broaden into repo-wide discovery.
- Do not silently ignore the prompt's exact output schema.
- Do not treat a whole feature area as “bounded” when the real work needs
  multiple independent review units.
- If no material findings remain in the bounded scope, say so explicitly.

## Default output

Unless the prompt overrides it with an exact schema, return:

## Findings

- `[SEVERITY]` file:line - issue and why it matters

## Verdict

- `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`
