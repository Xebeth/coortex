# Result Contract

Use severity and family-closure structure together.

## Per-family result

Required fields:
- `family_id`
- `severity`
- `title`
- `root_cause_confirmed`
- `owning_seam`
- `write_set`
- `manifestations_fixed`
- `siblings_checked`
- `siblings_fixed`
- `emergent_threads_followed`
- `emergent_threads_deferred`
- `tests_updated`
- `docs_updated`
- `verification`
- `closure_status`
- `open_reason_kind` when `closure_status` is not `family-closed`
- `residual_risks`
- `reviewer_next_step` when the family remains actionable and a concrete reviewer-facing reevaluation or unblock step is known

Use these `closure_status` values:
- `symptom-fixed-only`
- `family-partially-closed`
- `verification-blocked`
- `family-closed`

Use these `open_reason_kind` values when `closure_status` is not `family-closed`:
- `family-local-gap-remaining`
- `unfinished-family-work`
- `broader-cross-family-contract`
- `verification-separate-blocker`

Rules:
- `siblings_checked` must be explicit. Use `none` only when a grounded search found nothing.
- `siblings_fixed` must distinguish between fixed siblings and checked-but-not-present siblings.
- `emergent_threads_followed` must be a structured list of newly exposed threads that were incorporated into the slice. Use `none` when nothing new was exposed.
- Each `emergent_threads_followed` entry must include:
  - `summary`
  - `probable_seam`
  - `relationship_to_current_family`
- `emergent_threads_followed` should only include threads that clearly shared the same owning seam or root-cause boundary and were therefore legitimately absorbed into the current slice.
- `emergent_threads_deferred` must be a structured list of exposed threads that were judged separate or too large for the current slice and therefore left for downstream review. Use `none` only when nothing material was deferred.
- Each `emergent_threads_deferred` entry must include:
  - `summary`
  - `probable_seam`
  - `relationship_to_current_family`
  - `grounding`
  - `defer_reason`
- `verification` must include the concrete diagnostics/tests/build evidence that supports closure, and must distinguish targeted checks from broader suite checks.
- `family-closed` is invalid if any executed verification is failing or hanging.
- `family-closed` requires the normal suite for the touched area to be green or explicitly proven not applicable.
- If the current slice materially touched the family's owning seam or direct family paths, the family must remain in the handled-family results with an open `closure_status` when closure is incomplete. Do not move that family into `deferred_families`.
- Use `unfinished-family-work` when the fixer started the family seam, improved one or more manifestations, but did not carry the family to its actual closure condition.
- `verification-blocked` should be used when the family-local fix and targeted checks are in place, but the normal suite for the touched area cannot be shown green because of a separate failing or hanging blocker in that broader suite.
- `reviewer_next_step` should be present when the family remains actionable and the fixer can name a concrete reviewer-facing reevaluation or unblock step.
- When `verification-blocked` is used and a concrete unblock action is known, `reviewer_next_step` is required.
- `residual_risks` must be explicit. Use `none` only when nothing material remains open in the family slice.

## Review return handoff

Emit a mandatory `review_return_handoff` for downstream re-review.

Before finalizing it, run the bundled helper:

```bash
python scripts/fix_result_state.py validate-review-return \
  --review-return-handoff <path> \
  --review-handoff <path>
```

Use that helper for deterministic shape checks, status-token validation,
deferred-family validation, and family-id mapping. The fixer still owns the
judgment-heavy closure decision; the helper just stops malformed handoffs from
slipping through.

Required top-level fields:
- `original_review_target`
- `families`
- `deferred_families` when any input families were intentionally left for a later slice

Per family:
- `original_family_id`
- `claimed_closure_status`
- `open_reason_kind` when `claimed_closure_status` is not `family-closed`
- `touched_write_set`
- `touched_tests`
- `touched_docs`
- `closure_gate_checked`
- `verification_blocker` when `claimed_closure_status` is `verification-blocked`
- `reviewer_next_step` when the family remains actionable and a concrete reviewer-facing reevaluation or unblock step is known
- `emergent_threads_followed`
- `emergent_threads_deferred`
- `residual_risks`
- `verification_run`

Per `closure_gate_checked` block:
- `remediation_item`
- `satisfied_items`
- `unsatisfied_items`

Per `verification_blocker` block:
- `broader_suite_command`
- `blocking_failure_summary`
- `probable_seam`
- `reason_believed_separate`

Per optional `reviewer_next_step` block:
- `kind`
- `action`
- `required_environment`
- `expected_evidence`
- `reevaluate_when`

Rules:
- `original_review_target` must preserve the original review scope from `review_handoff.review_target`.
- `claimed_closure_status` must use the same tokens as the family result.
- `open_reason_kind` must use the same tokens as the family result when the family remains open.
- `touched_write_set`, `touched_tests`, and `touched_docs` must reflect the actual patch, not the original candidate hints.
- Keep `review_return_handoff` compact and factual. Do not restate full root-cause narratives, manifestation lists, or doc/test rationales that already exist in the human summary or upstream `review_handoff`.
- `closure_gate_checked` must stay a single compact block per family. Do not expand it into multiple ad hoc gate entries unless the contract is explicitly changed.
- When `claimed_closure_status` is `verification-blocked`, `verification_blocker` is required.
- `verification_blocker` must make the broader-suite blocker concrete enough for downstream return review to check whether it is actually separate from the repaired family.
- When the family remains actionable and a concrete reevaluation or unblock action is known, include `reviewer_next_step`.
- When `claimed_closure_status` is `verification-blocked` and a concrete unblock action is known, `reviewer_next_step` is required.
- If a previously blocked family is reevaluated because `reviewer_next_step` became runnable or the blocker circumstances changed, `verification_run` should show that reevaluation attempt explicitly.
- `reviewer_next_step` is reviewer-facing reevaluation guidance, not implementation instructions for another fixer slice.
- `reviewer_next_step.action` should say what the reviewer should verify, rerun, reject, or reopen. Do not use it to tell another fixer what code to write next.
- `emergent_threads_followed` must reflect newly exposed threads that were actually incorporated into the fix slice using the structured entry shape above.
- `emergent_threads_deferred` must reflect newly exposed threads that remain open for follow-up review or later fix work using the structured entry shape above.
- `verification_run` must capture the concrete commands or checks used to justify the claim.
- `verification_run` must make broader-suite status visible when `family-closed` or `verification-blocked` is claimed.
- `residual_risks` must be explicit. Use `none` only when nothing material remains open.
- When any input families were intentionally left for a later slice, also emit `deferred_families` using the deferred/refused-family contract below so targeted return review can preserve or reopen them structurally instead of rediscovering them from prose.
- Emit this handoff for every claimed closure status, including `family-closed` and `verification-blocked`.

## Final output

Include:
- total families handled
- totals by severity
- per-family closure results
- structured `review_return_handoff`
- any families refused or deferred
- batch-level verification summary

## Deferred or refused families

When any input families are not handled in the current slice, report them as a
structured list instead of leaving them implied.

Required fields per deferred/refused family:
- `family_id`
- `status`
- `defer_reason_kind`
- `touch_state`
- `reason`
- `actionable_when`
- `reviewer_next_step` when a concrete reviewer-facing reevaluation action is known
- `blocking_family_ids` when another family in the same batch is the gating reason

Use these `defer_reason_kind` values:
- `sequenced-after-overlapping-family`
- `separate-family-later-slice`
- `blocked-by-broader-contract-change`
- `blocked-by-prerequisite-contract-change`
- `blocked-by-external-environment`
- `stale-or-ambiguous-input`
- `user-scope-excluded`
- `insufficient-grounded-evidence`

Use these `touch_state` values:
- `not-started`
- `adjacent-file-overlap-no-owning-fix`
- `broader-cross-family-overlap`

Rules:
- Do not use content-free reasons such as `Untouched in this slice.`
- `deferred_families` is only for families whose owning fix was not materially started in the current slice.
- If the slice materially touched the family's owning seam or direct family paths and still left the family open, keep it in the handled-family results with an open `closure_status` instead of reporting it only as deferred.
- `reason` must explain why the family was not handled now, not merely that it was not handled.
- `touch_state` must explain whether the family was truly not started or only had adjacent/shared-file overlap from other family work.
- `actionable_when` must state what change in circumstances would make the family ready for the next fixer slice.
- Use `not-started` only when the current slice did not materially overlap the deferred family's direct family paths.
- Use `adjacent-file-overlap-no-owning-fix` only when nearby files overlapped but the family's own fix was not started.
- Use `broader-cross-family-overlap` only when the current slice overlapped the family through a broader shared seam or contract without actually closing or partially closing this family.
- When `touch_state` is not `not-started`, do not use `separate-family-later-slice`; use an overlap-aware defer reason such as `sequenced-after-overlapping-family` or `blocked-by-broader-contract-change`.
- When `touch_state` is not `not-started`, `blocking_family_ids` is required so downstream review can see which handled families created the overlap/sequencing pressure.
- When `touch_state` is not `not-started`, treat the defer as risky. Downstream return review must challenge whether the family was truly not started or was left half-done.
- When the family was deferred because another family must land first, use `blocking_family_ids` to name that dependency.
- When the family was deferred for an environment blocker and a concrete unblock action is known, `reviewer_next_step` is required.

Human-facing final output should summarize:
- what families were fixed
- what root causes were addressed
- what sibling coverage was checked
- what newly exposed threads were followed
- what remains open, if anything

Rules for human-facing output:
- keep the summary short: one compact closeout paragraph or a few flat bullets per family
- do not duplicate the machine-oriented fields verbatim when the structured blocks already carry them
- refer to the structured handoff blocks for exact paths and verification details rather than repeating every field in prose
- if families were deferred or refused, summarize the gating reason categories rather than repeating each raw reason verbatim in prose

## Family closeout checkpoint

Before the fixer moves from one family to another, it should emit a short visible
checkpoint containing:
- `family_id` or family title
- `closure_status`
- `write_set_summary`
- `tests_updated`
- `docs_updated`
- `emergent_threads_followed`
- `emergent_threads_deferred`
- `residual_risks`

This checkpoint exists so in-progress runs do not silently roll from one family
into the next without surfacing what was actually closed.
