# Execution Model

## Stages

1. Trace start
2. Intake and normalization
3. Owning-seam and write-set validation
4. Execution decision
5. Repair lanes
6. Batch verification
7. Family closeout checkpoint
8. Closure synthesis
9. Return handoff emission
10. Trace close

## Repair unit

Fix by repair ownership, not by raw finding order.

The default repair unit is:
- one defect family or one coherent repair slice

Group multiple findings together when they:
- share the same owning seam
- share the same invariant or lifecycle rule
- would otherwise create duplicate or fragmented repair paths

## Worker type

Codex built-in subagent types for this workflow are `default`, `explorer`, and `worker`.

Rules:
- use a `worker` subagent for every coordinated repair lane
- spawn each coordinated repair lane with `fork_context: false`
- invoke `$review-fixer` explicitly inside the lane prompt
- keep the worker prompt family-local or slice-local
- do not substitute `explorer` as the final repair worker

## Parallelization

Parallelize only when families have disjoint write sets.

Sequence families when they overlap in:
- files
- owning seam
- lifecycle or recovery invariants
- shared tests or docs

If a family is sequenced later instead of handled now:
- record the gating reason explicitly
- name the blocking family, seam, or prerequisite when one exists
- state what would make the deferred family actionable next
- do not use placeholder reasons such as "untouched in this slice"

## Lane obligations

Every repair lane must:
- validate the likely owning seam before editing
- search for sibling manifestations inside the slice before calling the family understood
- treat issues exposed by tests, code reading, or the repair itself as threads to classify and follow
- decide for each exposed thread whether it is:
  - part of the current family
  - a sibling family that belongs in the current repair slice
  - a separate family that must be deferred and returned to review
- absorb the exposed thread into the current slice only when it clearly shares the same owning seam or root-cause boundary
- otherwise, record it and defer it rather than widening the slice opportunistically
- prefer convergence on an existing owning seam over adding local helper plumbing
- remove stale or conflicting paths when the root cause shows split-brain logic
- update tests and docs when the closure gate requires it
- verify the fix against the closure gate before reporting closure
- run the repo's normal verification for the touched area before claiming `family-closed` when feasible, not just the narrowest repro test
- treat red or hanging broader verification as a blocker to `family-closed`; do not explain it away as unrelated
- use `verification-blocked` when broader verification for the touched area is the remaining blocker but the family-local fix and targeted checks are otherwise in place
- emit a short family closeout checkpoint before moving to a different family or slice
- if using `verification-blocked`, record the blocker suite, blocking failure summary, probable seam, and why it is believed separate from the repaired family
- record the actual touched write set, tests, docs, verification runs, broader-suite status, satisfied closure-gate items, unsatisfied closure-gate items, residual risks, and any exposed threads followed or deferred for the downstream `review_return_handoff`
- append phase-boundary records to the on-disk trace file described in `references/trace-artifact.md`

## Family closeout checkpoint

Before moving from one family to the next, emit a short explicit checkpoint with:
- `family_id` or family title
- `closure_status`
- `write_set_summary`
- `tests_updated`
- `docs_updated`
- `emergent_threads_followed`
- `emergent_threads_deferred`
- `residual_risks`

This checkpoint is a progress/reporting requirement. It does not replace the final
structured handoff.
