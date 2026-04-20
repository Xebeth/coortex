# Execution Model

## Stages

1. Trace start
2. Intake and normalization
3. Deterministic slice/wave planning
4. Owning-seam and write-set validation
5. Execution decision
6. Repair lanes
7. Lane-local self-review and self-deslop
8. Independent targeted return review
9. Same-lane continuation or approval
10. Family closeout checkpoint
11. Coordinator-side commit
12. Trace close

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

Use `scripts/fix_result_state.py plan-repair-slices --review-handoff ...` to
derive the initial slices and waves deterministically.

The helper's role is mechanical:
- group families into slices using likely owning seam, candidate write overlap,
  and carry-forward blocker links
- assign stable `slice_id`, `lane_id`, and `wave_id` values
- choose an orchestration mode:
  - `single-lane`
  - `coordinated-parallel`
  - `coordinated-sequenced`

The model still owns the judgment about whether a reported seam/write overlap
really makes sense for the current family set.

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

## Lane-local review loop

Each repair lane is owned by one worker and stays attached to that worker until
the family is terminal.

Rules:
- after the worker implements the slice, it must run lane-local
  `$coortex-review`
- after that, it must run lane-local `$coortex-deslop`
- the worker reruns targeted verification after that self-cleanup
- the worker emits `review_return_handoff`
- the worker does **not** commit

The fixer coordinator then:
- invokes `$review-orchestrator` in targeted return-review mode
- supplies the original `review_handoff`, the worker's
  `review_return_handoff`, and the actual diff
- waits for the reviewer result before deciding the next step

If return review keeps the family actionable:
- build a lane-local continuation packet with
  `scripts/fix_result_state.py build-lane-continuation ...`
- validate it in the receiving worker with
  `scripts/fix_result_state.py validate-lane-continuation ...`, passing the
  original lane plan JSON when available so the worker can deterministically
  reject mismatched lane identity or family metadata
- send that packet back to the **same original implementer lane**
- resume the same worker thread for that lane after validation
- preserve lane-local context instead of restarting first-pass analysis from
  scratch
- do not close that worker, reassign the family, or replace the worker by
  default

If return review approves closure:
- the fixer coordinator may run one final bounded coordinator-side
  `$coortex-deslop` pass if maintainability cleanup is still needed
- rerun verification as needed
- append a `family_commit` trace record with per-family
  `return_review_rounds_taken_by_family` counts so the trace shows how many
  return-review send-back rounds it took each family to close
- commit and close the family lane

## Closure authority

`review-orchestrator` targeted return review is the independent closure
authority for this transitional orchestrated fixer model.

That means:
- worker self-review and self-deslop are required but not sufficient
- fixer coordinator batching is required but not sufficient
- only reviewer-approved families may be committed as closed

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
