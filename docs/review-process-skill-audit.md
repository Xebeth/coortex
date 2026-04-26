# Review Process Skill Audit

## Status

Fresh audit after the review-process interview. This document compares the
current review skill files and helpers against `review-process-intent.md`.
It intentionally does not audit the host repository architecture.

## Audited files

- `.codex/skills/review-baseline/SKILL.md`
- `.codex/skills/review-baseline/references/baseline-schema.md`
- `.codex/skills/review-orchestrator/SKILL.md`
- `.codex/skills/review-orchestrator/references/prep-and-refusal.md`
- `.codex/skills/review-orchestrator/references/execution-model.md`
- `.codex/skills/review-orchestrator/references/report-contract.md`
- `.codex/skills/review-orchestrator/references/review-handoff.md`
- `.codex/skills/review-orchestrator/references/trace-artifact.md`
- `.codex/skills/review-orchestrator/scripts/return_review_state.py`
- `.codex/skills/coortex-review-lane/SKILL.md`
- `.codex/skills/coortex-review/SKILL.md`
- `.codex/skills/seam-walkback-review/SKILL.md`
- `.codex/skills/seam-walkback-review/references/trace-artifact.md`

## Findings

### 1. Structured validation is still incomplete

The prose contracts are richer than the helper enforcement.

At audit time, helper commands validated baselines, discovery packets,
current-work narrowing, omissions, basic trace records, ledger appends, and
canonical handoff pathing. They did not expose dedicated validators for:

- coverage lane output shape
- family exploration output shape
- return-review lane output shape
- the coverage-to-family handoff packet
- full `review_handoff` family-entry shape
- final synthesized family set versus ledger entries
- final review summary versus handoff family set beyond basic actionable ids

Impact: an agent can satisfy prose superficially while skipping required fields
or emitting an under-specified handoff.

Needed change: add helper commands that validate each structured artifact used
for orchestration, synthesis, handoff, and completion.

Implementation status: the first validator slice adds helper validation for
coverage lane output, family-exploration output, return-review output,
deferred-thread lane output, and full `review_handoff` family-entry shape.
Remaining work is still needed for the coverage-to-family packet, final summary
alignment, and final synthesized family set versus ledger entries.

### 2. Coverage-to-family handoff is too implicit

`review-orchestrator` requires mandatory family exploration after coverage, and
coverage lanes report candidate families, sibling searches, thin areas, and
omissions. However, there is no canonical intermediate artifact that packages a
candidate family for the family-exploration lane.

Impact: exploration lanes may rediscover too much context, miss key coverage
evidence, or fail to test the intended sibling/root-cause hypothesis.

Needed change: define and validate a candidate-family exploration packet. The
packet should carry candidate id, source lanes, evidence, suspected root cause,
owning seam hypothesis, sibling paths checked, sibling paths still suspected,
and thin areas that could change family shape.

### 3. Thin-area follow-up policy needs sharper states

Current docs support omission dispositions such as `ignore`, `carry-thin`, and
`spawn-follow-up`, and coordinator follow-up decisions such as ignored, carried,
spawned, or declined. The intended policy is stricter:

- material thin areas should trigger another exploration lane
- uncertain materiality should be surfaced to the user
- clearly low-value or out-of-scope areas may be recorded with a reason

Impact: `carry-thin` or `declined-follow-up` can become a vague escape hatch for
work that should have been explored or escalated.

Needed change: require a materiality classification and make the coordinator's
follow-up decision prove why it spawned, asked, or safely carried the area.

### 4. Family-ledger completion is not a hard enough gate

The skills require normalized family outcomes in the on-disk ledger, and the
helper can append and summarize ledger entries. The final actionable review gate
currently enforces persisted handoff emission, but it does not clearly prove
that every final synthesized family has a ledger entry for the run.

Impact: a review can appear complete while losing the persistent memory needed
to detect weak spots and repeated reopenings.

Needed change: final review completion should fail unless the final family set
has matching current-run ledger entries, with only explicit no-actionable or
non-family outcomes exempted.

### 5. Quality-gate ownership needs to stay out of discovery review

Recent quality-gate notes risk blurring normal discovery review with fixer
closure checks. The intended boundary is that normal review discovers and
familizes defects; it does not invent, resolve, or run repo-local finish gates.

Impact: review orchestrators may block or broaden discovery on gate decisions
that belong to fixer prep or return-review evidence checking.

Needed change: keep quality-gate resolution in baseline/fixer-prep work. Review
lanes should check gate evidence only when acting as return-review or closure
lanes with a resolved gate plan.

## Aligned areas

The current skills already align with several core intents:

- `review-baseline` defines stable surfaces, lenses, and optional
  `review_focus_areas`.
- `review-orchestrator` has final say on packet-driven family grouping and can
  merge, split, regroup, reopen, or reject candidate families.
- Full review requires coverage lanes followed by family exploration lanes.
- Seam walkback emits provisional candidate families and hands them to
  `review-orchestrator` for formal validation.
- Actionable orchestrator outcomes must persist and trace `review-handoff.json`.
- `coortex-review` is a bounded standalone review, not a substitute for formal
  multi-lane orchestration.
- `coortex-review-lane` is internal lane machinery, not a user-facing wrapper
  around standalone review.
- `review_handoff` fields are framed as review hints, not binding
  implementation instructions.

## Next implementation targets

1. Finish deterministic validators for candidate-family packets, final
   synthesis, and ledger completion. Lane-output and handoff-shape validators
   now exist.
2. Add a canonical coverage-to-family exploration packet to the orchestrator
   trace model.
3. Tighten thin-area materiality and follow-up states.
4. Enforce final family ledger coverage before final review closeout.
5. Keep quality-gate resolution out of normal review-discovery flow while
   preserving return-review evidence checks.
