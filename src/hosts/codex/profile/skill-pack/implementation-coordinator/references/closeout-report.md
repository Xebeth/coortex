# Closeout Report

Use this reference before reporting completion for a non-trivial
implementation-coordinator run.

## Rule

Do not close with only a verdict such as "done" or "approved". The closeout
must make the run auditable from artifacts, evidence, and explicit remaining
state.

## Required closeout fields

Keep the final report concise, but include:

- `produced_artifacts`
  - packet, spec review, implementation handoff, return review, gate logs, docs,
    generated files, commits, or installed skill paths
- `explicit_claims`
  - what the run claims is now true
- `evidence`
  - commands, helper validations, reviews, tests, diffs, or artifacts that prove
    the claims
- `continuation_rounds`
  - count and short reason for each spec-review, intake, return-review, or
    closing-gate send-back; use `none` when there were no loops
- `first_ready_point`
  - earliest point where the slice looked substantively complete, and what later
    checks changed if any
- `commit_or_install_disposition`
  - commit hash, install target, `not requested`, `not allowed`, or `not
    applicable`
- `residual_risks`
  - explicit remaining risks, deferred threads, or `none`

## Commit and no-git workflows

Some current-work runs should not commit. Some should commit only after the user
explicitly allows it. The closeout must state which case applied.

If a commit or install happens after an initial closeout is drafted, update the
closeout before the final response so the final report does not contradict the
actual repo state.
