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
- keep the worker prompt lane-local
- keep the lane prompt task-scoped and omit redundant meta-role disclaimers
- do not substitute `explorer` or `worker` for final review output

Pass the configured surface lenses through unchanged. The lane skill owns the
meaning of each built-in lens id.

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

Every coverage lane must report:
- findings by severity
- local candidate families
- scope summary
- material evidence actions
- rationale summary
- sibling-search scope
- skipped areas
- skip reasons
- stop reason
- coverage confidence
- thin areas
- local family status

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
- keep the worker prompt family-local
- keep the lane prompt task-scoped and omit redundant meta-role disclaimers
- do not substitute `explorer` or `worker` for final review output

Each return-review lane should compare:
- the original family from `review_handoff`
- the original `closure_gate` embedded in that family entry
- the `review_return_handoff`
- the actual fix diff

Deferred families reported in `review_return_handoff` are a separate carry-forward
input, not an automatic lane.

For lane prompting:
- treat the `closure_gate` as the Stage 1 spec/compliance target
- treat the supplied family-local diff as the authoritative review scope
- do not broaden `git diff` or surrounding file reads outside that scope unless the patch clearly reopens the same family outside it
- run diagnostics only on modified code/test files in scope; docs do not need diagnostics
- override the default `$coortex-review-lane` summary format and emit the base family-local return-review schema exactly
- check every closure-gate item directly and cite evidence for each one instead of only giving a family-level conclusion

Scheduling:
- if return-review lanes exceed current subagent capacity, run them in bounded waves
- preserve one independent lane per returned family
- do not collapse an unscheduled family into coordinator-local review work
- do not spawn a lane for a deferred family unless prep classified it as `requires-family-local-check` or `requires-broader-cross-family-review`

Each return-review lane must report:
- claimed closure status
- closure claim verdict:
  - `confirmed`
  - `rejected`
  - `partially-confirmed`
- closure gate checked:
  - `gate_item`
  - `item_verdict`
    - `satisfied`
    - `unsatisfied`
    - `inconclusive`
  - `evidence`
- `new_findings` or `none found`
- material evidence actions
- rationale summary
- skipped areas
- skip reasons
- stop reason
- coverage confidence
- thin areas

If a return-review lane shows the family still remains open and actionable, the
lane evidence should be rich enough for synthesis to rebuild a refreshed
downstream family entry instead of leaving only a verdict row.

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
- keep the lane prompt task-scoped and omit redundant meta-role disclaimers
- do not substitute `explorer` or `worker` for final review output

Rules:
- run these lanes only when the deferred thread is grounded enough to name a plausible seam, boundary, or family-local side path
- if the deferred thread is too broad or ambiguous to bound, do not widen the current return review into broad discovery
- instead, surface that thread as explicit follow-up review work
- if deferred-thread exploration lanes exceed current subagent capacity, run them in bounded waves rather than substituting coordinator-local exploration

Each deferred-thread exploration lane must report:
- `source_family_id`
- `thread_summary`
- `probable_seam`
- `thread_verdict`:
  - `same-family-sibling-confirmed`
  - `separate-family-confirmed`
  - `not-grounded`
- `evidence`
- `new_findings` or `none found`
- `material_evidence_actions`
- `rationale_summary`
- `skipped_areas`
- `skip_reasons`
- `stop_reason`
- `coverage_confidence`
- `thin_areas`

## Family exploration lanes

Exploration is mandatory.

Rules:
- every coverage finding belongs to a candidate family
- a lone bug is a family of one
- spawn one exploration lane per candidate family
- use a `default` subagent for every family-exploration lane
- spawn each family-exploration lane with `fork_context: false`
- invoke `$coortex-review-lane` explicitly inside the lane prompt
- keep the worker prompt family-local
- keep the lane prompt task-scoped and omit redundant meta-role disclaimers
- do not substitute `explorer` or `worker` for final review output

Exploration goals:
- test the highest plausible root cause
- search side paths
- search sibling bugs
- confirm or reject manifestations
- determine closure status
- explain what was not explored and why if the family remains open

Each family-exploration lane must report:
- `family_id`
- `source_surfaces`
- `highest_confidence_root_cause`
- `manifestations_confirmed`
- `manifestations_rejected`
- `side_paths_checked`
- `sibling_bugs_found`
- `sibling_search_scope`
- `severity_rollup`
- `closure_status`
- `material_evidence_actions`
- `rationale_summary`
- `skipped_areas`
- `skip_reasons`
- `stop_reason`
- `coverage_confidence`
- `thin_areas`

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
- wait patiently for required independent lane results instead of taking over their substantive review work
- relaunch or retry a stalled lane before giving up on it
- do not interrupt an active lane merely to force a bounded finish, stop scope expansion mid-pass, or demand a premature best-effort result
- let a lane continue when it is still making bounded progress; impatience is not a valid reason to truncate independent review work
- synthesize by root cause
- deduplicate manifestations
- roll severity up to family and review levels
- preserve deferred-thread results under the family they came from instead of flattening them into one global list
- when targeted return review leaves one or more families actionable, synthesize a refreshed open-families-only downstream `review_handoff`
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
