---
name: fixer-orchestrator
description: Coordinate repair from structured review output with root-cause-driven slice planning, lane execution, and reviewer-approved closure. Use when Codex should turn a structured `review_handoff` into one or more verified fix lanes without settling for line-local patches, helper sprawl, split-brain logic, or bare-minimum symptom closure.
---

# Fixer Orchestrator

Turn review output into coordinated, root-cause-driven fixes that close defect
families at the owning seam rather than patching the nearest manifestation.

## Transitional orchestrated fixer

This skill is a workflow-level approximation of the intended fixer
specialization model.

`fixer-orchestrator` is a repair-specialized implementation coordinator. It
uses the shared implementation protocol vocabulary — implementation lane,
handoff, intake gate, return review, continuation loop, closing gate, closeout,
and atomic commit — but replaces ordinary idea intake with structured
`review_handoff` family normalization.

Do not invoke `$implementation-coordinator` as a nested workflow. The shared
protocol is a contract layer, not a parent skill call. The fixer specialization
adds repair-family obligations: family ledger updates, fixer trace records,
active-campaign locks, same-worker continuation, `$review-orchestrator`
targeted return review, and one atomic commit per approved repair slice.

It is **not** the final runtime lane system. In this skill pack:

- `review_handoff` families are transformed into bounded repair lanes/slices
- likely owning seam and write overlap drive batching
- worker lanes implement fixes
- `review-orchestrator` remains the independent closure authority through
  targeted return review
- the fixer coordinator commits only after that reviewer approval

Treat this as a transitional coordinator workflow in the skill pack, not as the
final runtime-owned implementation.

## Conversation-visible plan

Keep a short conversation-visible plan/progress list updated while this
workflow runs so the user can tell which family or phase is active.

- Use the conversation `update_plan` tool at the start and after each major
  phase boundary. Keep exactly one step `in_progress` and move it forward as
  the fixer advances.
- Do not rely only on prose status messages when `update_plan` is available.

- At the start, state the active family set (or current family) and the next
  step.
- After intake, after each family closeout, and before final verification,
  update the in-conversation progress.
- If you defer, split, or re-scope a family, say so explicitly before
  continuing.
- These updates are status signals, not approval gates. Unless the user
  explicitly asks for a pause or the fixer is blocked on missing input,
  continue after the update without waiting for acknowledgment.

## Workflow

Resolve bundled script paths relative to this installed skill directory under
`.codex/skills/fixer-orchestrator/`, not relative to the repository root.

When this workflow names a `scripts/fix_result_state.py` subcommand for trace
init, slice planning, lane continuation, review-return validation, or terminal
append-trace handling, run that exact helper command instead of hand-planning
equivalents or backfilling artifacts later. Treat helper-produced lane
metadata, trace paths, and terminal lock-clearing status as authoritative. If
any helper-owned continuation, validation, or terminal trace step fails, stop
and surface the protocol error instead of prose-completing the run.

When a `review_handoff` includes a current-work mini-surface packet or packet
path, validate it with
`.codex/skills/coortex-review/scripts/review_state.py validate-current-work-packet`
before planning lanes. Preserve that packet through slice planning, worker
lane prompts, lane continuations, targeted return review, and coordinator-side
`$coortex-review` pre-commit gates. Do not reconstruct packet or matrix
validation by hand.

1. Load the review input.
2. Load these references as needed:
   - `references/intake-and-normalization.md`
   - `references/execution-model.md`
   - `references/lane-continuation.md`
   - `references/result-contract.md`
   - `references/review-return-handoff.md`
   - `references/trace-artifact.md`
   - `scripts/fix_result_state.py` for deterministic handoff validation
3. Determine coordinator intake mode from `review_handoff`.
4. Create or resume the run trace directory/files via the bundled helper described in `references/trace-artifact.md`, using its shared active-campaign lock handling.
5. Normalize the input into repair families and closure gates before editing.
6. Use the bundled helper to derive deterministic repair slices and execution
   waves from the incoming `review_handoff`, preserving any current-work
   packet metadata that belongs to the review/fix slice.
7. Validate the likely owning seam and candidate write set for each slice.
8. Turn every planned slice into a repair lane:
   - one repair lane when one slice cleanly covers the family set
   - coordinated parallel lanes when slices are disjoint
   - coordinated sequenced lanes when overlap or blocker links require waves
9. For each repair lane:
   - keep one worker attached to that lane until the family reaches a terminal
     state
   - implement the fix by editing code, tests, and docs at the owning seam
   - identify and run the touched project/package build, compile, or typecheck
     gate and configured local quality gates first, then targeted slice tests
     only
   - run lane-local `$coortex-deslop`
   - run lane-local `$coortex-review-lane`; if a current-work packet is in
     scope, pass it through and require the lane review output to validate as
     `surface_checked` or `matrix_not_applicable`
   - rerun the touched-unit build gate and configured local quality gates
     first, then targeted slice tests, after any cleanup or review-driven edits
   - emit a mandatory `review_return_handoff`
10. The fixer coordinator must send every lane result through
    `$review-orchestrator` targeted return review using the original
    `review_handoff`, the lane's `review_return_handoff`, and the actual diff.
    If the lane output lacks touched-unit build-gate evidence before targeted
    tests, treat the lane output as incomplete and send it back to the same
    implementer lane instead of asking review to approve closure.
    If the lane output lacks configured local quality-gate evidence for the
    touched unit, treat it the same way.
11. If targeted return review approves the family closure, run an explicit
    coordinator-side **read-only** pre-commit gate over the final approved
    diff and append a `closure_approved` trace record for the approved family
    set:
    - bounded `$coortex-deslop` in advisory/read-only mode
    - bounded `$coortex-review`, including the current-work packet when one
      exists and validating its `surface_checked` / `matrix_not_applicable`
      output with the review helper
    - touched-area build/compile/typecheck plus configured local repo quality
      gates, such as lint, static analysis, or InspectCode when configured,
      before any test suite
    - normal repo test command for the touched area after those gates
    - full test suite last when the branch/workflow requires it, and only
      after the touched-unit build gate is green
    - rerun verification only if the same implementer lane had to make follow-up
      changes after the gate handed back new work
12. Append `pre_commit_gate_result` for that gate outcome. If the gate finds
    cleanup-only residue, route one consolidated `commit-ready cleanup sweep`
    back to the same implementer lane instead of dribbling out repeated
    piecemeal cleanup loops.
13. If that pre-commit gate stays clear, append `commit_ready`, then make one
    atomic commit for the approved lane/slice and close that family lane.
14. If targeted return review keeps the family actionable, build a lane-local
    continuation packet and send it back to the **same original implementer
    lane**. Resume the same worker thread for that lane. Do not close that
    worker, do not spawn a replacement worker for the same family, and do not
    hand the family to a new lane unless the workflow has a genuine blocker or
    explicit operator override.
15. Before moving to a different family, emit a short family closeout
    checkpoint.
16. After the last atomic commit for the run, append a `final_fix` record via
    `scripts/fix_result_state.py append-trace`.
17. Require that helper call to report `active_campaign_cleared: true` and
    verify `.coortex/review-trace/active-review-campaign.json` is gone before
    reporting completion.

## Hard Rules

- Require structured `review_handoff` for coordinator use.
- If the user does not have a structured `review_handoff`, direct them to
  `$review-fixer` for bounded standalone repair or to review first.
- Do not treat a user-written bug brief, remediation plan, checklist, acceptance-criteria block, or test-failure summary as `review_handoff`.
- Treat follow-on user instructions as valid lane-local continuation only when they explicitly anchor to the active `family_id` or repair slice from the existing `review_handoff`.
- If a previously blocked or open family has a structured reviewer `next_step`, treat that step as binding reevaluation guidance rather than optional prose.
- Never patch directly from a raw finding without family normalization.
- Treat the closure gate as the acceptance gate for the family.
- Validate the owning seam before writing code. Do not default to the nearest changed file.
- Before adding a helper or new path, check whether the owning abstraction already exists.
- Do not solve a family by adding fragmented helper plumbing beside an existing seam.
- Remove or absorb stale/conflicting paths when the root cause reveals split-brain logic or duplicate ownership.
- Update tests and docs in the same slice when contracts, invariants, recovery behavior, or operator-visible truth change.
- When implementation or verification exposes a new nuance, side path, sibling manifestation, or adjacent bug, treat it as a thread to follow instead of a note to ignore.
- For every newly exposed thread, decide explicitly whether it is:
  - part of the current family
  - a sibling family that should be fixed in the same slice
  - a separate family that must be deferred and handed back to review
- Only absorb a newly exposed thread into the current slice when the code proves the same owning seam or root-cause boundary. Otherwise, record it explicitly and defer it instead of letting the current slice sprawl.
- Do not defer a family with content-free wording such as "untouched in this slice." If a family is not handled now, state the concrete gating reason and what would make it actionable next.
- Defer before starting, not after partial repair. If the current slice materially touches a family's owning seam or direct family paths and still leaves the family open, keep it in the handled-family results with an open `closure_status` instead of reporting it only as deferred.
- If the review input is too stale or ambiguous to recover a grounded repair family, stop and say so instead of guessing.
- Do not optimize for completeness theater, reassurance, or a "family-closed" outcome.
- Standalone fixer campaigns must not run concurrently with an active seam-walk
  or standalone review-orchestrator campaign in the same worktree.
- If closure evidence is incomplete, prefer `family-partially-closed` or `verification-blocked` and explicit residual risk over overstating closure.
- Do not claim `family-closed` while the repo's normal verification for the touched area is red or hanging.
- Before `family-closed`, run the touched project/package build, compile, or
  typecheck gate first, then the repo's normal test command for the touched
  project/package when feasible. Targeted tests alone are not enough if the
  touched-unit build gate or broader seam-level suite is still red, hanging,
  or skipped unless it is truly not applicable.
- Do not run full-suite or broader tests before the touched-unit build,
  compile, or typecheck gate is green. Build/typecheck failures block closure;
  they are not post-review surprises.
- Do not treat targeted tests as enough when configured local repo quality
  gates for the touched unit, such as lint, static analysis, or InspectCode,
  are red, hanging, skipped without evidence, or not yet run.
- Do not use supposedly unrelated red or hanging broader verification as an excuse to round up to `family-closed`.
- Use `verification-blocked` when the family-level fix and targeted checks are in place but required broader verification for the touched area cannot be shown green because of a separate blocker in that broader suite.
- When using `verification-blocked`, record the blocking suite, blocking failure summary, probable seam, and why the blocker is believed separate from the repaired family.
- `verification-blocked` is not terminal when a structured reviewer `next_step` becomes runnable or the blocker circumstances change. Reopen the family, attempt the step when feasible, and reevaluate the status.
- Do not widen a slice just to look thorough, and do not manufacture extra problems to appear rigorous.
- Codex built-in subagent types for this workflow are `default`, `explorer`, and `worker`.
- Use `worker` subagents for coordinated repair lanes.
- Spawn coordinated repair lanes with `fork_context: false`.
- Do not use `explorer` as the final repair worker for any lane.
- Do not rely on inherited thread context for repair lanes. Pass only the scoped family/slice prompt plus the relevant `review_handoff` and closure-gate data.
- Do not let a worker lane commit. Commits are coordinator-only after
  independent targeted return review approves closure.
- Worker lanes own touched-unit build/compile/typecheck, configured local
  quality gates, and targeted verification only. Do not have every lane run
  the repo-wide or broader seam-level suite in parallel; broader verification
  required for `family-closed` is coordinator-owned.
- Do not let the fixer coordinator self-certify closure. Independent review is
  provided by `$review-orchestrator` targeted return review.
- The coordinator-side pre-commit gate must call bounded `$coortex-review` and
  bounded `$coortex-deslop` explicitly in **read-only** mode. That gate is
  required before every commit and does not replace `$review-orchestrator` as
  closure authority.
- When a current-work mini-surface packet exists, every fixer/reviewer handoff
  in the loop must preserve it. Worker lanes, lane continuations, targeted
  return review, and coordinator-side `$coortex-review` must all see the same
  packet or an explicitly validated successor packet.
- Treat reviewer approval, pre-commit gate outcome, and actual commit-readiness
  as separate traceable states. Record them with `closure_approved`,
  `pre_commit_gate_result`, and `commit_ready` before any `family_commit`.
- `commit_ready` must include explicit self-deslop evidence, lane-safe
  self-review evidence, seam-residue sweep evidence, final touched-unit build
  gate evidence, final local quality-gate evidence, final targeted
  verification, and any excluded unrelated edits.
  Reviewer approval, green gate reruns, `git diff --check`, narrow greps, and
  passing targeted suites are not sufficient by themselves.
- Do not append `family_commit` unless the same family set already has a clear
  `pre_commit_gate_result` and an explicit `commit_ready` record.
- The fixer coordinator is read-only with respect to repo content. It must not
  edit code, tests, or docs itself; only worker lanes may do that.
- Make atomic commits only: one reviewer-approved lane/slice per commit. Do not
  batch several approved lanes into one umbrella commit.
- Commit subjects must be human semantic summaries grounded in the approved
  family title, root cause, or owning seam. Do not use generated lane ids,
  slice ids, wave ids, or worker session ids in commit subjects.
- If targeted return review returns an actionable downstream handoff for a
  family lane, route it back to the same original implementer lane. Do not
  restart the family from a fresh worker by default.
- Treat same-lane continuation as thread continuity, not just lane-id reuse.
  When a lane receives a valid continuation packet, resume that same worker's
  family-local context instead of redoing first-pass analysis from scratch.
- Only treat a lane as terminal when reviewer approval lands, a genuine blocker
  makes the lane terminal, or an explicit operator override supersedes the lane.
- Do not silently replace a live lane with coordinator-local patching just
  because return review found more work.
- After spawning a worker or reviewer lane, wait patiently for a terminal
  result. Do not steer, interrupt, close, or kill a live lane merely because
  it is quiet or because a fixed timeout elapsed.
- Only interrupt or replace a live lane when the user explicitly asks, a
  deterministic validation/blocker failure appears, or the lane is clearly
  stuck outside its contract and cannot make forward progress.
- If coordinator-side `$coortex-deslop`, coordinator-side `$coortex-review`, or
  targeted return review finds more work, the coordinator must hand that work
  back to the same implementer lane and resume the review loop. It must not
  patch the repo locally to "finish the slice."
- If a coordinator-side gate produces unrelated edits outside the intended
  commit set, leave them uncommitted, exclude them from the current atomic
  commit, record them in `commit_ready.excluded_unrelated_edits`, and surface
  them to the user for disposition.
- Always emit a `review_return_handoff`. Do not rely on fixer self-audit as the terminal acceptance step.
- Use the bundled `scripts/fix_result_state.py` helper to validate the final `review_return_handoff` and deferred-family structure before finalizing. Serialize the relevant handoff blocks to JSON before invoking it.
- Use the bundled `scripts/fix_result_state.py` helper for deterministic trace path/file handling as well as final handoff validation. Keep the model focused on repair judgments and evidence.
- Do not hand-terminate a fixer run by prose alone. A top-level fixer run is
  complete only after `append-trace` writes `final_fix`, reports
  `active_campaign_cleared: true`, and the shared active-campaign lock file is
  no longer present.
- Do not write a full transcript or chain-of-thought trace. Persist only phase-boundary operational trace records and observable repair/verification actions.
- Keep detailed trace data on disk. Do not serialize trace internals into `review_return_handoff` or normal final output unless the user explicitly asks for trace details.
- Keep human-facing progress and final output compact. Do not dump the same root cause, manifestation, and test/doc details repeatedly across closeout prose and `review_return_handoff`.

## Intake And Normalization

- Native mode: consume `review_handoff` and use the provided `review_hints` and `closure_gate`.
- Every structured handoff is lane-planned, even when it collapses to one family.
- Native mode: also consume any structured per-family `next_step` and treat it as the default follow-up action when that family remains actionable.
- Native mode: also consume any `carry_forward_context` preserved by targeted return review so the next slice keeps the prior defer/sequence rationale instead of reconstructing it from prose.
- Native mode: also consume any current-work mini-surface packet or packet path
  attached to the `review_handoff`. Validate it with the `$coortex-review`
  helper and preserve it as lane context instead of treating it as prose.
- If the user only supplies prose remediation guidance without a structured
  handoff, refuse and direct them to `$review-fixer` or back to review.

Use `references/intake-and-normalization.md`.

## Execution

- Derive slices/waves with `scripts/fix_result_state.py plan-repair-slices`
  for the entire structured handoff, even when it collapses to one family.
  If the handoff carries current-work packet metadata, use the helper output's
  `current_work_review_packet` on the top-level plan and each slice as the
  authoritative packet context to pass to workers and review gates.
- Group by owning seam and write-set overlap.
- Parallelize only disjoint repair slices.
- Sequence overlapping families.
- Run every repair lane in a Codex `worker` subagent and invoke
  `$coortex-fixer-lane` inside the lane prompt, scoped to that family or
  repair slice only. The coordinator does not perform local repair itself.
- Keep the same worker attached to the same lane until
  `$review-orchestrator` targeted return review either approves closure or a
  genuine blocker forces the lane terminal.
- Each worker lane must run lane-local `$coortex-deslop` and lane-local
  `$coortex-review-lane` before handing results back to the coordinator.
- Each worker lane must run the touched project/package build, compile, or
  typecheck gate plus configured local quality gates before its targeted
  tests, and must rerun that same ordering after cleanup or review-driven
  edits.
- Worker self-review must not fall back to standalone `$coortex-review`,
  because standalone review correctly refuses while the parent fixer or review
  campaign owns the worktree.
- The coordinator must then send the lane output to `$review-orchestrator`
  targeted return review. If return review rejects closure, use
  `scripts/fix_result_state.py build-lane-continuation ...` to send the
  actionable families back to the same worker lane, and have that lane validate
  the packet with `scripts/fix_result_state.py validate-lane-continuation ...`
  before resuming, passing the original lane plan JSON when available so the
  worker can reject mismatched family metadata deterministically. After
  validation, resume the same worker thread for that lane and preserve its
  lane-local context rather than spawning a fresh worker or restarting the
  family from scratch.
- After spawning a worker lane or targeted return-review lane, wait for the
  lane to finish. Do not send mid-flight steering or kill the worker just
  because the run has been quiet for several minutes.
- Coordinator-side pre-commit gate is mandatory after return review approval
  and before commit:
  - run bounded `$coortex-deslop` on that same bounded scope in advisory/read-
    only mode
  - run bounded `$coortex-review` on the final approved diff
  - if either gate finds more work, send it back to the same implementer lane
    and resume the loop instead of patching locally
  - if the gate stays clear, commit immediately for that approved lane/slice
  - do not batch multiple already-approved lanes into one later umbrella
    commit
- After the final approved lane commit lands for the whole run, terminate the
  fixer campaign explicitly:
  - append `final_fix` through `scripts/fix_result_state.py append-trace`
  - require `active_campaign_cleared: true`
  - confirm `.coortex/review-trace/active-review-campaign.json` no longer
    exists
  - do not report success until all three are true

Use `references/execution-model.md`.

## Verification And Closure

- Do not call a family closed because one manifestation is fixed.
- Verify against the closure gate, not just the direct symptom.
- `family-closed` requires green executed verification with no hanging tests. If only targeted checks ran, or the broader suite for the touched seam was skipped/failing/hanging, do not round up to `family-closed` unless that broader suite is truly not applicable.
- Treat the broader-suite requirement as coordinator-owned closure evidence, not
  as a per-lane default gate. Lane workers should supply targeted verification
  evidence; the coordinator decides when the normal suite for the touched area
  must run before commit/closure.
- Use `verification-blocked` instead of `family-partially-closed` when the remaining blocker is verification state rather than an unresolved defect-family gap.
- Do not use `verification-blocked` without surfacing concrete blocker evidence and an explicit separation claim that downstream return review can check.
- When a family includes a structured reviewer `next_step`, reevaluate the prior status before keeping or repeating `verification-blocked`.
- If the `next_step` is runnable in the current environment, attempt it before finalizing the family status.
- If the `next_step` is still not runnable, explain concretely why it could not be attempted and keep the family in `verification-blocked` only if the blocker remains genuinely separate.
- If tests or repair work expose a new thread, classify it and either follow it to closure within the same family slice or report it explicitly as deferred/new family work.
- Do not let a current family silently widen across seams just because a test exposed an adjacent issue.
- Use `unfinished-family-work` when the fixer started a family's seam and improved one or more manifestations without carrying the family to its actual closure condition.
- Before moving from one family to the next, explicitly surface the family closeout checkpoint required by `references/result-contract.md`.
- Emit a `review_return_handoff` for every handled family so `review-orchestrator` can independently check the actual repair against the original family, the embedded closure gate, and the fix diff.
- If any families from the current input are deferred or intentionally left for a later slice, report them using the deferred-family contract in `references/result-contract.md` and include them in `review_return_handoff.deferred_families`.
- Use the closure-status and deferred-family tokens from `references/result-contract.md`.

Use `references/result-contract.md`.
