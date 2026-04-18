# Return Review

Use this path when `review-fixer` has already completed work and emitted a
`review_return_handoff`.

The goal is not to redo broad family discovery. The goal is to independently
check the completed fix against the already-known family and closure gate.
If return review shows that some families are still open, the goal also
becomes producing a refreshed actionable downstream `review_handoff` for those
remaining families.

## Required inputs

- the original `review_handoff`
- the `review_return_handoff`
- the actual fix diff

Each family's `closure_gate` comes from the `review_handoff`.
Do not expect a separate standalone `closure_gate` artifact for return review.

## Targeted review scope

Keep the scope to:
- the original family ids
- the actual touched write set
- touched tests
- touched docs
- any residual risks reported by the fixer
- any `verification_blocker` reported for a `verification-blocked` claim
- any structured `deferred_families` reported by the fixer
- any grounded `emergent_threads_deferred` reported by the fixer

## Checks

For each returned family, verify:
- whether the touched write set matches the actual diff
- whether the patch converged on the owning seam instead of adding local plumbing
- whether touched tests and docs now encode the implemented contract
- whether the claimed closure status is supported by the patch
- whether each `closure_gate` item is actually satisfied, with concrete evidence for each item
- when the claimed closure status is `verification-blocked`, whether the reported broader-suite blocker is concrete and actually appears separate from the repaired family
- whether any new sibling or adjacency issues were introduced inside the returned family scope
- whether the family remains open in a way that is grounded enough to rebuild an actionable downstream handoff for the next fixer slice

For each deferred family reported by the fixer, verify:
- whether the family id still maps cleanly to the original `review_handoff`
- whether the defer reason is concrete and coherent enough to carry forward
- whether the reported `touch_state` matches the actual overlap picture
- whether the actual diff materially overlaps that family's likely owning seam or candidate write set
- whether the defer reason still appears valid, or whether the family now needs broader or family-local re-review because the shared contract, blocker, or sequencing rationale may have changed
- whether the family was truly not started; if the likely owning seam or direct family paths were materially touched and the family now looks half-done, reject the defer classification and rebuild it as an open handled family instead

When using `$coortex-review-lane` for a return-review lane:
- treat the family `closure_gate` as the Stage 1 spec/compliance target
- use the supplied family-local diff as the authoritative review scope
- do not widen `git diff` or neighboring file reads outside that scope unless the patch clearly reopens the same family outside it
- run diagnostics only on modified code/test files in scope
- omit redundant meta-role disclaimers; the scoped prompt plus `fork_context: false` should make the lane role clear
- return the base family-local return-review schema below, not the generic review-summary format
- show the gate check directly in the output instead of burying it inside a generic closure summary

For each deferred thread reported by the fixer:
- if it names a plausible seam, boundary, or family-local side path, run targeted exploration on that thread
- if it is too broad or ambiguous to bound, do not widen the current return review into broad discovery; report it as explicit follow-up review work instead

If required return-review or deferred-thread lanes exceed current subagent capacity:
- run them in bounded waves
- preserve one independent lane per family or grounded deferred thread
- do not replace an unscheduled lane with coordinator-local review work

For deferred families:
- do not silently drop them from return review just because the fixer did not edit them in this slice
- carry them forward without a family-local lane when the actual diff did not materially overlap their seam and the defer reason still appears grounded
- require family-local or broader cross-family re-review when the actual diff materially overlaps the family or when the defer reason itself identifies a broader shared contract or blocker that may change the family boundaries
- do not preserve a deferred-family classification if return review shows the family was materially started and left half-done; recast it as an open handled family for the refreshed downstream handoff

## Base family-local lane output

Each family-local return-review lane should report:
- `claimed_closure_status`
- `closure_claim_verdict`
  - `confirmed`
  - `rejected`
  - `partially-confirmed`
- `closure_gate_checked`
- `verification_blocker_verdict` when `claimed_closure_status` is `verification-blocked`
- `evidence`
- `new_findings` or `none found`
- `material_evidence_actions`
- `rationale_summary`
- `skipped_areas`
- `skip_reasons`
- `stop_reason`
- `coverage_confidence`
- `thin_areas`

For each `closure_gate_checked` entry include:
- `gate_item`
- `item_verdict`
  - `satisfied`
  - `unsatisfied`
  - `inconclusive`
- `evidence`

For `verification_blocker_verdict` include:
- `blocker_verdict`
  - `separate-blocker-confirmed`
  - `same-family-blocker`
  - `inconclusive`
- `evidence`

Use the same self-check discipline as other lane types:
- `rationale_summary` should be a short evidence-based explanation, not hidden chain-of-thought
- `material_evidence_actions` should record observable review work only: key files/docs read, searches run, diagnostics/commands used, and major family-candidate decisions. Do not turn it into hidden reasoning.
- `skipped_areas` must be explicit; use `none` when nothing material was skipped
- `skip_reasons` must explain why each skipped area was left out
- `stop_reason` must say why the lane stopped when it did
- `coverage_confidence` should be one of:
  - `high`
  - `medium`
  - `low`

## Final per-family return-review output

After family-local lanes and any deferred-thread exploration lanes complete, the
coordinator should synthesize one per-family return-review result containing:
- the base family-local lane output above
- `closure_claim_verdict: unverified` when no required independent family-local lane result completed
- `deferred_threads_explored`
- `deferred_threads_still_open`

For each `deferred_threads_explored` entry include:
- `thread_summary`
- `probable_seam`
- `thread_verdict`
- `evidence`

For each `deferred_threads_still_open` entry include:
- `thread_summary`
- `probable_seam` or `unknown`
- `reason`

## Refreshed downstream handoff

When targeted return review leaves one or more families still open and
actionable, also emit a refreshed downstream `review_handoff` containing only
those families.

Use the normal `review_handoff` contract shape from
`references/review-handoff.md`, but rebuild each open family entry from:
- the original family entry
- the return-review lane evidence
- any grounded deferred-thread exploration results

When deferred families are only being carried forward without a new lane, use
the bundled helper to assemble that skeleton deterministically:

```bash
# Serialize the handoff blocks to JSON before invoking the helper.
python scripts/return_review_state.py build-carried-handoff \
  --review-handoff <path> \
  --review-return-handoff <path> \
  --classification-json <path>
```

For each carried-forward family, update as needed:
- `highest_confidence_root_cause`
- `manifestations`
- `immediate_implications`
- `broader_implications`
- `sibling_bugs`
- `sibling_search_scope`
- `closure_status`
- `thin_areas`
- `review_hints`
- `closure_gate` when return review proves the original gate was incomplete or
  mis-scoped
- `next_step` when return review can name a concrete next action or unblock step
- `carry_forward_context` when the family is being preserved from fixer-side defer or sequencing rather than from a direct closure-rejection lane
  - preserve `touch_state` there too so the next fixer slice can tell a true non-start from shared-file overlap

For deferred families carried forward without a family-local lane, rebuild the
refreshed family entry from:
- the original family entry
- the structured deferred-family entry from `review_return_handoff`
- any grounded return-review evidence about why the defer reason still holds

When a deferred family's reason indicates a broader shared contract crossing
family boundaries, do not just carry it forward unchanged. Reopen exploration
under that broader hypothesis and refresh the downstream handoff around the new
shared seam or overlap.

Rules for the refreshed downstream handoff:
- preserve stable `family_id` values where possible
- include only families that remain actionable after return review
- do not include `closure-confirmed` families
- do not include families whose only remaining state is
  `verification-blocked-separate-blocker` unless the user explicitly asks to
  carry blocked families forward or the reviewer can provide a concrete
  `next_step` that makes the blocked family actionable for a later reevaluation
- do not include `unverified` families unless the completed lane evidence is
  still grounded enough to rebuild an actionable family entry
- do not emit a verdict ledger in place of the refreshed handoff
- do not copy the original family entry unchanged when the lanes found new
  manifestations, sibling paths, thin areas, or revised owning-seam hints
- make the refreshed handoff absorb the subagent feedback so the next fixer run
  does not need to reverse-engineer the open seam from prose
- do not drop a fixer-reported deferred family that still remains actionable; either carry it forward with structured context or explain why it was excluded
- if return review shows the fixer reported a family as deferred even though the family seam was materially started, do not carry it forward as defer; rebuild it as an open family with an explicit `open_reason_kind` such as `unfinished-family-work`
- if the family remains open because a blocker or environment constraint still
  exists, prefer a structured `next_step` over loose human prose so the next
  fixer run can reevaluate when circumstances change

## Rules

- Do not rerun broad discovery across unrelated surfaces unless the return handoff is stale or inconsistent with the diff.
- Treat this as an independent review pass. Do not trust the fixer's self-report without checking the patch.
- If the return handoff is too stale or ambiguous to support grounded re-review, refuse and say so explicitly.
- Read the family closure conditions from the `closure_gate` embedded in the `review_handoff`.
- Use targeted exploration for grounded deferred threads. Reserve full discovery review for a later explicit rerun when the deferred work is too broad or ambiguous to bound here.
- Wait for the required independent lane results. Do not substitute coordinator-local reasoning for a missing return-review lane.
- If a required return-review lane cannot be completed after patient waiting and relaunch, report that family as `unverified` rather than confirming or rejecting the closure claim from local evidence alone.
- Do not send "stop now", "bounded finish", or "return your best grounded result" interrupts to an active lane merely because synthesis is taking longer than expected.
