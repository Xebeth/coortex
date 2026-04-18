# Report Contract

Use severity and root-cause structure together.

Severity set:
- `CRITICAL`
- `HIGH`
- `MEDIUM`
- `LOW`

## Coverage lane output

Header:
- `Surface`
- `Review window`
- `Lenses used`
- `Scope summary`

Severity summary:
- `CRITICAL`
- `HIGH`
- `MEDIUM`
- `LOW`

Per finding:

```text
[HIGH] External side effects are emitted before durable state settles.

Immediate cause: ...
Higher-level root cause: ...
Defect family: ...
Immediate implications: ...
Broader implications: ...
Sibling bugs: ...
Sibling search scope: ...
Evidence: file:line refs
Fix direction: ...
```

Required fields:
- severity
- title
- immediate cause
- higher-level root cause
- defect family
- immediate implications
- broader implications
- sibling bugs or `none found`
- sibling search scope
- evidence refs
- fix direction

Also include:
- `candidate_families`
- `scope_summary`
- `material_evidence_actions`
- `rationale_summary`
- `skipped_areas`
- `skip_reasons`
- `stop_reason`
- `coverage_confidence`
- `thin_areas`
- local family status:
  - `isolated`
  - `local-family`
  - `likely-cross-surface-family`

Rules:
- `rationale_summary` should be a short evidence-based explanation of how the reviewer got from the observed code to the reported root cause. Do not dump hidden chain-of-thought.
- `material_evidence_actions` should record observable review work only: key files or docs read, searches run, diagnostics/commands used, and major family-candidate decisions. Do not turn it into hidden reasoning.
- `skipped_areas` must be explicit. Use `none` when nothing material was skipped.
- `skip_reasons` must explain why each skipped area was left out: out of lane scope, insufficient evidence, boundedness limit, or deferred to family exploration.
- `stop_reason` must say why the lane stopped when it did.
- `coverage_confidence` should be one of:
  - `high`
  - `medium`
  - `low`
- `candidate_families` should be an explicit structured list, not just prose. For each candidate family include:
  - `family_id`
  - `candidate_root_cause`
  - `manifestations`
  - `family_status`

Use these `family_status` tokens for coverage lanes:
- `isolated`
- `local-family`
- `likely-cross-surface-family`

## Exploration lane output

Required fields:
- `family_id`
- `source_surfaces`
- `highest-confidence root cause`
- `manifestations confirmed`
- `manifestations rejected`
- `side paths checked`
- `sibling bugs found`
- `sibling_search_scope`
- `severity rollup`
- `closure status`
- `material_evidence_actions`
- `rationale_summary`
- `skipped_areas`
- `skip_reasons`
- `stop_reason`
- `coverage_confidence`
- `thin_areas`

Closure status values:
- `isolated`
- `local-family`
- `cross-surface-family`
- `family-closed`
- `family-still-open`

Rules:
- Use the same self-check discipline as coverage lanes.
- `material_evidence_actions` should make the exploration lane's search behavior inspectable: key files/docs read, search pivots used, candidate manifestations rejected, and sibling paths checked.
- `thin_areas` must be explicit for exploration lanes too. Use `none` when nothing material was left unexplored inside the family lane.
- `sibling_search_scope` must state where sibling exploration was attempted, even when no sibling bugs were found.

## Final review output

Include:
- files reviewed or review window summary
- totals by severity
- final defect families
- structured `review_handoff` for downstream fix workflows
- per-family `closure_gate` inside the `review_handoff`
- when doing targeted return review, per-family closure-claim verdicts from targeted return-review synthesis comparing the `review_return_handoff` and actual fix diff against the `closure_gate` embedded in the `review_handoff`
- when doing targeted return review, per-family `closure_gate_checked` results showing which gate items were satisfied, unsatisfied, or inconclusive and why
- when doing targeted return review, for any `verification-blocked` claim, per-family `verification_blocker_verdict` showing whether the broader-suite blocker was confirmed separate, shown to belong to the same family, or left inconclusive
- when doing targeted return review, per-family targeted exploration results for any grounded `emergent_threads_deferred`
- when doing targeted return review, any fixer-reported deferred families that were:
  - carried forward as still-actionable
  - reopened for family-local re-review
  - reopened for broader cross-family exploration
  - excluded, with reason
- when doing targeted return review, a refreshed open-families-only downstream `review_handoff` whenever one or more families remain actionable after re-review
- when `scripts/return_review_state.py current-run-reopens --run-id <run_id>` reports reopened families for the current run, explicit reopened-family notes for the user
- surfaced self-check rollup:
  - rationale summaries that materially affect confidence
  - skipped areas
  - skip reasons
  - stop reasons
  - coverage-confidence summary
- thin areas or remaining open coverage risks
- final verdict:
  - `APPROVE`
  - `COMMENT`
  - `REQUEST CHANGES`

Rules:
- Do not drop lane self-check output during synthesis.
- The human-facing review summary and the structured `review_handoff` must describe the same families. Do not emit divergent root-cause groupings between them.
- The `closure_gate` must align with the same family grouping and root-cause conclusions as the review summary and `review_handoff`.
- In targeted return-review mode, explicitly state whether the fixer's claimed closure status was confirmed, rejected, partially confirmed, or left unverified.
- In targeted return-review mode, do not accept a `verification-blocked` claim without surfacing whether the reported broader-suite blocker was actually confirmed separate from the repaired family.
- In targeted return-review mode, use `unverified` when no required independent family-local lane result was completed. Do not infer a closure verdict from coordinator-local evidence alone.
- In targeted return-review mode, explicitly state which deferred threads were explored in-place and which remained open as follow-up review work.
- In targeted return-review mode, if any family remains actionable, emit a refreshed downstream `review_handoff` for those families instead of leaving the next fixer step with only verdict rows.
- In targeted return-review mode, the refreshed downstream `review_handoff` must absorb the subagent findings for the still-open families. Do not emit the original family entry unchanged when the lanes found new open seams, sibling paths, thin areas, or updated owning-seam hints.
- In targeted return-review mode, preserve actionable fixer-reported deferred families. Do not drop them from the refreshed downstream `review_handoff` merely because they were not edited in the current fixer slice.
- In targeted return-review mode, when a deferred family's reason indicates a broader shared contract or fence crossing family boundaries, reopen exploration under that broader hypothesis instead of only carrying the family forward unchanged.
- Record normalized per-family outcomes to the on-disk family ledger so later analysis can detect families that were deemed closed and then reopened.
- Use the helper's current-run reopen summary, not prose reconstruction, to decide which reopened families to surface in the human-facing final output.
- In targeted return-review mode, when the reviewer can name a concrete next action or unblock step for a still-actionable family, encode it in that family's `next_step` instead of leaving it only in human prose.
- In targeted return-review mode, do not misuse the `review_handoff` key for a verdict ledger. A downstream handoff must follow `references/review-handoff.md`.
- In targeted return-review mode, the lane output schema overrides the default `$coortex-review-lane` summary format. Emit the requested closure-verdict fields directly instead of wrapping them in a generic issue-review heading.
- In targeted return-review mode, surface the `closure_gate_checked` evidence directly. A family-level sentence such as "family closed confirmed" is not enough by itself.
- Keep deferred-thread reporting attached to the family that produced the thread. Do not flatten multiple families' deferred work into one unlabeled list.
- Surface skipped areas and stop reasons whenever they materially limit confidence or explain why a family remains open.
- If multiple lanes report similar skipped areas or confidence limits, summarize them once at the final-review level instead of repeating them verbatim.
- Use `references/review-handoff.md` for the machine-oriented downstream handoff shape.
- Use `references/closure-gate.md` for the per-family acceptance-gate shape.
- Use `references/return-review.md` for targeted fixer-to-reviewer re-review.
