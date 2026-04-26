# Review Process Intent

## Status

This is a workflow reference for the Coortex review skills. It records the
intended review behavior independently of any one repository's architecture.
Current skills and helpers may not yet enforce every invariant here; gaps should
be tracked as skill or helper work, not reinterpreted by agents at runtime.

## Purpose

The review process exists to find defects and make later repair bounded.

Unbounded review tends to spot-check and leave related failures for later
reviews to rediscover. A formal review run may cover a large scope, but the
process must decompose that scope into small review units so each agent can do a
complete, evidence-backed pass.

When a defect is found, review must explore its implications before handing it
to fixer:

- the highest actionable root cause
- sibling bugs and same-cause manifestations
- same-cause side effects or suspect seams
- thin areas that could change family grouping, closure criteria, or fixer scope

The final output is a set of grounded, bounded, actionable families with enough
evidence and closure criteria that fixer can repair without rediscovering the
review scope.

## Skill responsibilities

### `review-baseline`

The baseline defines stable review surfaces, anchors, contract docs, lenses, and
recurring `review_focus_areas`. It gives reviewers a consistent map for broad
review decomposition.

Baseline surfaces should stay compatible with current-work packet surfaces so a
reviewer can consume either shape without learning a second surface model.

### `review-orchestrator`

The orchestrator owns formal multi-lane review. It must:

1. validate the selected baseline or discovery packet
2. decompose the requested scope into bounded coverage lanes
3. run coverage lanes without forcing one agent to cover an unbounded surface
4. turn every material coverage finding into a candidate family
5. run family exploration for each candidate family
6. merge, split, regroup, reopen, or reject candidate families during synthesis
7. update the persistent family ledger with final synthesized family outcomes
8. persist a fixer-ready `review_handoff` when actionable families remain

The orchestrator has final say over family grouping. Lane family suggestions are
inputs, not binding truth.

### `coortex-review-lane`

The lane skill is internal to orchestrated review. It is not a user-facing
variant of `coortex-review`.

A lane reviews one bounded surface, family, return-review scope, or deferred
thread. It must produce the structured output requested by the orchestrator,
including evidence read, searches attempted, sibling paths checked, skipped
areas, thin areas, and candidate-family decisions.

### `coortex-review`

The standalone review skill is for one bounded user-facing review unit. It is
best-effort within that scope and normally reports prose findings and verdict.
It may emit a single-family fixer handoff only when the user explicitly asks and
the review is grounded enough to state root cause, evidence, and closure gate.

If the requested scope needs decomposition, cross-surface grouping, or formal
family synthesis, standalone review should redirect to `review-orchestrator`.

### `seam-walkback-review`

Seam walkback is a discovery feeder. It walks git history, groups commits into
logical evidence buckets, detects hot seams and provisional candidate families,
and emits a discovery packet.

Those families remain candidates. `review-orchestrator` validates, rejects,
merges, splits, reopens, or confirms them before any final fixer handoff.

### Fixer relationship

Review handoff should inform fixer, not prescribe implementation. Likely owning
seams, suspected repair direction, and candidate write or test sets are hints.
Fixer owns the final repair plan and implementation while preserving the family
closure criteria.

## Formal review flow

### 1. Prep and decomposition

Prep validates the baseline or packet, maps the requested scope to surfaces, and
splits work into bounded lanes. Split before lane execution when one lane would
otherwise have to skip sibling search, mix unrelated concerns, or cover a scope
too large for a complete review.

### 2. Coverage lanes

Coverage lanes inspect bounded surface slices. They look for candidate defect
families, immediate manifestations, higher root-cause hypotheses, sibling paths,
and material omissions. They must report what they read, searched, checked,
skipped, and left thin.

### 3. Coverage-to-family handoff

The coordinator must pass enough structured information from coverage to family
exploration that the exploration lane starts from the candidate defect instead
of rediscovering the whole surface. At minimum, the handoff should include:

- candidate family id and source lane ids
- immediate manifestations and file-backed evidence
- suspected root cause and owning seam hypothesis
- sibling paths already checked and outcomes
- sibling paths or side effects still suspected
- skipped or thin areas and why they matter

### 4. Family exploration

Family exploration tests the strongest plausible root cause, confirms or rejects
sibling manifestations, checks same-cause side paths, and identifies suspect
areas that remain thin. A single isolated bug is still represented as a
family-of-one when no wider root cause is confirmed.

### 5. Synthesis

The coordinator condenses lane outputs into final families. It may merge, split,
rename, reopen, or reject candidates. It must make the final family grouping
match the human summary, the persisted `review_handoff`, and the family ledger.

### 6. Completion

A formal review is not complete until:

- all material lane outputs have been accounted for
- material thin areas have been resolved, escalated, or explicitly carried
- final synthesized families have ledger outcomes
- actionable families have a persisted and traced `review_handoff`
- final output reports family changes, reopened families, hot seams, residual
  thin areas, and handoff path when applicable

## Family ledger semantics

The family ledger is persistent memory, not scratch space. It tracks final
synthesized family outcomes so repeated weak spots and reopened families are
visible over time.

Only final synthesized families update the ledger. Temporary coverage
candidates do not.

A new finding should reopen or continue an existing family when it shares a root
cause, violated invariant, owning seam, sibling manifestation pattern, or known
family lineage. File overlap alone is not enough.

## Thin-area policy

Thin areas are not a way to hide unfinished review work.

- If the coordinator can tell a thin area may materially affect family grouping,
  root cause, sibling coverage, closure criteria, or fixer scope, it should run
  another exploration lane.
- If materiality is uncertain, it should ask the user whether to run another
  exploration lane.
- If the area is clearly low-value, out of scope, or unrelated, it may be
  recorded as residual context with a reason.

## Quality-gate boundary

Normal defect-discovery review does not own repo-local quality-gate decisions
and does not run or invent fixer completion gates.

Quality gates should be established as early as possible for fixer and closure
work: at baseline time when static, or at fixer prep when they depend on current
changed files, packages, projects, or artifacts. Review lanes only evaluate gate
evidence when they are acting in a return-review or closure-check role and the
resolved gate plan has already been provided.

## Deterministic enforcement

Everything that can be checked by helper scripts should be checked by helper
scripts. Instructions alone have drifted in past runs.

Helpers should own canonical paths, trace record shape, packet validation,
handoff validation, ledger completion checks, and final-review completion
checks. If a required helper validation is missing, that is a process/tooling gap
to fix rather than a reason for an agent to improvise.
