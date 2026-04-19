---
name: review-fixer
description: Repair code from structured review output with root-cause-driven fixes, sibling checks, and owning-seam repair discipline. Use when Codex should turn a review result into one or more verified fix slices without settling for line-local patches, helper sprawl, split-brain logic, or bare-minimum symptom closure.
---

# Review Fixer

Turn review output into root-cause-driven fixes that close defect families at the
owning seam rather than patching the nearest manifestation.

## Conversation-visible plan

Keep a short conversation-visible plan/progress list updated while this
workflow runs so the user can tell which family or phase is active.

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

1. Load the review input.
2. Load these references as needed:
   - `references/intake-and-normalization.md`
   - `references/execution-model.md`
   - `references/result-contract.md`
   - `references/review-return-handoff.md`
   - `references/trace-artifact.md`
   - `scripts/fix_result_state.py` for deterministic handoff validation
3. Determine mode:
   - native intake from `review_handoff`
   - lane-local repair when already scoped to one family or one repair slice
4. Create or resume the run trace directory/files via the bundled helper described in `references/trace-artifact.md`.
5. Normalize the input into repair families and closure gates before editing.
6. Validate the likely owning seam and candidate write set.
7. Choose execution mode:
   - single-lane repair when the batch is one coherent family or one coherent write set
   - coordinated repair lanes when families are disjoint
   - sequential repair when families overlap in files, ownership, or invariants
8. Implement the fix by editing code, tests, and docs as needed to close the family at the owning seam.
9. Verify the fix.
10. Before moving to a different family, emit a short family closeout checkpoint.
11. Report family closure and emit a mandatory `review_return_handoff`.
11a. Serialize the machine handoff blocks to JSON and run the bundled result-state helper against the final `review_return_handoff` before finalizing.
12. Append the final trace records on disk.

## Hard Rules

- Require `review_handoff` unless the fixer is already operating inside a lane-local repair slice derived from that handoff.
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
- If closure evidence is incomplete, prefer `family-partially-closed` or `verification-blocked` and explicit residual risk over overstating closure.
- Do not claim `family-closed` while the repo's normal verification for the touched area is red or hanging.
- Before `family-closed`, run the repo's normal test command for the touched project/package when feasible. Targeted tests alone are not enough if the broader seam-level suite is still red, hanging, or skipped unless it is truly not applicable.
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
- Always emit a `review_return_handoff`. Do not rely on fixer self-audit as the terminal acceptance step.
- Use the bundled `scripts/fix_result_state.py` helper to validate the final `review_return_handoff` and deferred-family structure before finalizing. Serialize the relevant handoff blocks to JSON before invoking it.
- Use the bundled `scripts/fix_result_state.py` helper for deterministic trace path/file handling as well as final handoff validation. Keep the model focused on repair judgments and evidence.
- Do not write a full transcript or chain-of-thought trace. Persist only phase-boundary operational trace records and observable repair/verification actions.
- Keep detailed trace data on disk. Do not serialize trace internals into `review_return_handoff` or normal final output unless the user explicitly asks for trace details.
- Keep human-facing progress and final output compact. Do not dump the same root cause, manifestation, and test/doc details repeatedly across closeout prose and `review_return_handoff`.

## Intake And Normalization

- Native mode: consume `review_handoff` and use the provided `review_hints` and `closure_gate`.
- Native mode: also consume any structured per-family `next_step` and treat it as the default follow-up action when that family remains actionable.
- Native mode: also consume any `carry_forward_context` preserved by targeted return review so the next slice keeps the prior defer/sequence rationale instead of reconstructing it from prose.
- Lane-local mode: consume the already-scoped family or repair slice derived from the same `review_handoff`, with an explicit family or slice anchor.
- If the user only supplies prose remediation guidance without that anchor, refuse and ask for the structured handoff or the exact family/slice to continue.
- If the user explicitly indicates that a reviewer-specified `next_step` is now runnable, or that the blocker environment has changed for the active family, treat that as valid reevaluation input for the anchored family or slice.

Use `references/intake-and-normalization.md`.

## Execution

- If the input is already lane-local, do not re-coordinate. Repair the family, verify it, and report closure.
- If the input contains multiple families:
  - group by owning seam and write-set overlap
  - parallelize only disjoint repair slices
  - sequence overlapping families
- Run each coordinated repair lane in a Codex `worker` subagent and invoke `$review-fixer` inside the lane prompt, scoped to that family or repair slice only.

Use `references/execution-model.md`.

## Verification And Closure

- Do not call a family closed because one manifestation is fixed.
- Verify against the closure gate, not just the direct symptom.
- `family-closed` requires green executed verification with no hanging tests. If only targeted checks ran, or the broader suite for the touched seam was skipped/failing/hanging, do not round up to `family-closed` unless that broader suite is truly not applicable.
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
