# Execution Model

## Stages

1. Trace start
2. Prep
3. Mode branch
4. Coverage lanes or return-review lanes
5. Candidate family grouping and family exploration lanes when in full review mode
6. Synthesis
7. Refreshed downstream handoff when needed
8. Verdict and trace close

## Mode branch

Choose one:
- full discovery review
- targeted return review from original `review_handoff + review_return_handoff`

Use targeted return review when the user is asking to check completed fix work against
an already-known family and closure gate.

## Coverage lanes

Default unit:
- one coverage lane per bounded surface slice

Worker type:
- Codex built-in subagent types for this workflow are `default`, `explorer`, and `worker`
- use a `default` subagent for every coverage lane
- spawn each coverage lane with `fork_context: false`
- invoke `$coortex-review-lane` explicitly inside the lane prompt
- keep the worker prompt lane-local and task-scoped
- do not substitute `explorer` or `worker` for final review output

Pass the configured surface lenses through unchanged. The lane skill owns the
meaning of each built-in lens id. If prep validated run-local focus emphasis
for the narrowed run, pass it separately in the lane prompt as extra emphasis
without rewriting the configured lens list.
If the mapped surface includes baseline `review_focus_areas`, pass them through
unchanged as recurring failure checks for that lane. They sharpen bounded
inspection and sibling-path checks, but they do not create extra lanes, mutate
the lens bundle, or become automatic findings on their own.

Scheduling:
- if coverage lanes exceed current subagent capacity, run them in bounded waves
- preserve one independent lane per bounded surface slice
- do not collapse an unscheduled lane into coordinator-local review work

Split a touched surface further when:
- it contains more than 5 changed behavioral-code files
- it touches more than 2 distinct primary-anchor groups
- it contains multiple weakly related change clusters
- one lane would force spot-checking
- sibling search would be skipped to finish
- configured lenses require materially different evidence strategies

If any split trigger fires but the surface is kept as one lane anyway:
- record a boundedness exception
- explain why the slice is still grounded enough to review as one unit
- surface that exception in the final review output

Every coverage lane must emit the coverage-lane contract from
`references/report-contract.md`.

When completed coverage or return-review lanes report machine-readable
`omission_entries`, run the bundled omission helper before synthesis:
- bucket `ignore` omissions as no-action
- preserve `carry-thin` omissions for confidence rollup
- treat `spawn-follow-up` omissions as follow-up candidates that require either
  a bounded new lane or an explicit declined reason recorded in trace

## Return-review lanes

Default unit:
- one return-review lane per returned family

Use the bundled `scripts/return_review_state.py` helper before spawning lanes
when `deferred_families` are present. The script owns deterministic validation
and baseline classification of those deferred families; the model still decides
whether evidence justifies broader cross-family regrouping.

The same helper also owns deterministic trace path/file creation and carried-
deferred handoff skeleton assembly.

Worker type:
- use a `default` subagent for every return-review lane
- spawn each return-review lane with `fork_context: false`
- invoke `$coortex-review-lane` explicitly inside the lane prompt
- keep the worker prompt family-local and task-scoped
- do not substitute `explorer` or `worker` for final review output

Each return-review lane should compare:
- the original family from `review_handoff`
- the original `closure_gate` embedded in that family entry
- the `review_return_handoff`
- the actual fix diff

Deferred families reported in `review_return_handoff` are a separate carry-forward
input, not an automatic lane.

For lane prompting:
- pass the `closure_gate`, the family-local authoritative diff/scope, and the
  exact family-local return-review schema from `references/return-review.md`
- when the reviewed family maps to a surface with `review_focus_areas`, pass
  those focus areas through so the return-review lane rechecks the recurring
  failure themes most likely to regress on that surface
- let `$coortex-review-lane` own the lane-local review method for that schema

Scheduling:
- if return-review lanes exceed current subagent capacity, run them in bounded waves
- preserve one independent lane per returned family
- do not collapse an unscheduled family into coordinator-local review work
- do not spawn a lane for a deferred family unless prep classified it as `requires-family-local-check` or `requires-broader-cross-family-review`

Each return-review lane must emit the family-local return-review contract from
`references/return-review.md`.

If a return-review lane shows the family still remains open and actionable, the
lane evidence should be rich enough for synthesis to rebuild a refreshed
downstream family entry instead of leaving only a verdict row.

When a return-review lane emits `omission_entries`, use the same omission helper
and trace discipline as coverage lanes before trusting closure confidence.

`unverified` is coordinator-only:
- use it only when no required independent family-local lane result completed
- do not ask a completed lane to emit `unverified` for its own verdict

## Deferred-thread exploration lanes

Use these only in targeted return-review mode.

Default unit:
- one targeted exploration lane per grounded deferred thread reported in `emergent_threads_deferred`

Worker type:
- use a `default` subagent for every deferred-thread exploration lane
- spawn each deferred-thread exploration lane with `fork_context: false`
- invoke `$coortex-review-lane` explicitly inside the lane prompt
- keep the worker prompt tightly scoped to the deferred thread
- do not substitute `explorer` or `worker` for final review output

Rules:
- run these lanes only when the deferred thread is grounded enough to name a plausible seam, boundary, or family-local side path
- if the deferred thread is too broad or ambiguous to bound, do not widen the current return review into broad discovery
- instead, surface that thread as explicit follow-up review work
- if deferred-thread exploration lanes exceed current subagent capacity, run them in bounded waves rather than substituting coordinator-local exploration

Each deferred-thread exploration lane must emit the deferred-thread output
contract from `references/return-review.md`.

## Family exploration lanes

Exploration is mandatory.

Rules:
- every coverage finding belongs to a candidate family
- a lone bug is a family of one
- spawn one exploration lane per candidate family
- use a `default` subagent for every family-exploration lane
- spawn each family-exploration lane with `fork_context: false`
- invoke `$coortex-review-lane` explicitly inside the lane prompt
- keep the worker prompt family-local and task-scoped
- do not substitute `explorer` or `worker` for final review output
- if an explored candidate family stays grounded in one mapped surface, pass
  that surface's `review_focus_areas` through unchanged as recurring failure
  checks for the exploration lane
- if a candidate family spans multiple mapped surfaces, pass only the
  originating surfaces' grounded `review_focus_areas`, deduplicated, and keep
  the originating surface ids explicit in the lane prompt instead of inventing
  a merged generic focus list

Each family-exploration lane must emit the exploration-lane contract from
`references/report-contract.md`.

## Coordinator

The coordinator must:
- branch between full review and targeted return review
- in targeted return review, preserve structured deferred families from `review_return_handoff` and classify them into:
  - carry forward without a lane
  - requires family-local re-review
  - requires broader cross-family exploration when the defer reason identifies a shared contract or fence crossing family boundaries
- spawn coverage lanes for full review
- group local findings into candidate families for full review
- spawn family exploration lanes for full review
- when deferred families require family-local re-review or broader cross-family exploration, spawn those lanes in the same bounded-wave model as other return-review lanes
- spawn return-review lanes for targeted return review
- spawn deferred-thread exploration lanes for grounded deferred threads in targeted return review
- queue excess lanes in bounded waves when required lane count exceeds current subagent capacity
- when lane omissions are summarized as `spawn-follow-up`, either spawn a
  bounded follow-up lane or record an explicit declined-follow-up decision with
  a coordinator reason
- carry `carry-thin` omissions into synthesis as confidence-reducing thin-area
  signals instead of silently dropping them
- wait patiently for required independent lane results instead of taking over their substantive review work
- relaunch or retry a stalled lane before giving up on it
- do not interrupt an active lane merely to force a bounded finish, stop scope expansion mid-pass, or demand a premature best-effort result
- let a lane continue when it is still making bounded progress; impatience is not a valid reason to truncate independent review work
- synthesize by root cause
- deduplicate manifestations
- roll severity up to family and review levels
- preserve deferred-thread results under the family they came from instead of flattening them into one global list
- when targeted return review leaves one or more families actionable, synthesize
  a refreshed open-families-only downstream `review_handoff`, persist it to the
  canonical `review-handoff.json` path, and trace that emission before
  `final_review`
- rebuild each carried-forward family entry from the original family plus the independent lane findings
- do not use the `review_handoff` key for a verdict ledger or unchanged copy of the original handoff
- roll lane self-check signals up into the final report so skipped areas, stop reasons, confidence limits, remaining coverage risks, and boundedness exceptions are visible to the user
- append the compact `review_shape_trace` data to the on-disk trace artifacts, including:
  - coverage-lane plan
  - family-exploration lanes created from those coverage lanes
  - return-review and deferred-thread lanes when used
  - split triggers and boundedness exceptions that shaped lane creation
  - a per-lane activity ledger showing the material files/docs/queries checked, candidate-family decisions, and sibling-search paths attempted
- append phase-boundary records to the on-disk trace file described in `references/trace-artifact.md`
- do not confirm or reject a family's return-review closure claim without at least one completed independent lane result for that family
- if a required return-review lane never completes, mark that family's closure-claim verdict as `unverified` and explain why rather than inferring a verdict from coordinator-local evidence
