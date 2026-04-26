# Review Return Handoff

Use this contract to hand completed fix work back to `review-orchestrator` for an
independent targeted re-review.

Validate the finished handoff with the bundled helper before finalizing:

```bash
# Serialize the handoff blocks to JSON before validating them.
python scripts/fix_result_state.py validate-review-return \
  --review-return-handoff <path> \
  --review-handoff <path>
```

## Shape

```yaml
review_return_handoff:
  original_review_target:
    mode: branch
    scope_summary: "branch delta against origin/main"
  families:
    - original_family_id: F-001
      claimed_closure_status: family-closed
      touched_write_set:
        - src/hosts/codex/adapter/execution.ts
        - src/hosts/codex/adapter/prompt.ts
      touched_tests:
        - src/__tests__/...
      touched_docs:
        - README.md
      closure_gate_checked:
        remediation_item: restore one authoritative structured-output boundary
        satisfied_items:
          - launch and resume converge on the same authoritative parsing contract
        unsatisfied_items: none
      emergent_threads_followed:
        - summary: resume-side parsing nuance proved to be the same output-boundary family
          probable_seam: src/hosts/codex/adapter/execution.ts
          relationship_to_current_family: same-family
      emergent_threads_deferred: none
      residual_risks: none
      touched_build_gate:
        command: "normal build/compile/typecheck command for touched unit"
        scope: "touched project/package/module"
        status: green
        evidence: "ran before targeted slice tests"
      local_quality_gates:
        - name: static-analysis
          command: "repo-configured local quality gate, e.g. lint or InspectCode"
          status: green
          evidence: "ran before targeted slice tests"
      verification_run:
        - broader_suite_status: green via npm test
        - npm test -- structured-output
  deferred_families:
    - family_id: F-002
      status: family-still-open
      defer_reason_kind: blocked-by-broader-contract-change
      touch_state: broader-cross-family-overlap
      reason: "Remaining lock-owner identity work spans a broader ownership contract than the replay slice fixed here."
      actionable_when: "Return review confirms the broader shared seam and refreshes the next handoff around it."
      reviewer_next_step:
        kind: follow-up-review
        action: reopen review around the shared lock-owner identity seam and reject carry-forward unless the broader overlap rationale still holds
        required_environment: none
        expected_evidence:
          - refreshed downstream review_handoff for the broader seam
        reevaluate_when:
          - targeted return review runs for this batch
      blocking_family_ids:
        - F-001
```

## Rules

- This handoff is mandatory for every handled family.
- It is the worker-to-reviewer exchange artifact. It is **not** the
  worker-continuation artifact; if return review keeps the family actionable,
  the fixer coordinator must build a lane continuation packet addressed back to
  the same implementer lane.
- It exists so the reviewer can compare:
- the original `review_handoff`
- the original `closure_gate` embedded in that `review_handoff`
  - the actual fix diff
  - the fixer's claimed closure result
- When any input families were intentionally left for a later slice, include `deferred_families`.
- `original_review_target` must copy the original review scope from `review_handoff.review_target`.
- `touched_write_set`, `touched_tests`, and `touched_docs` must reflect the actual patch.
- When `claimed_closure_status` is not `family-closed`, include `open_reason_kind` using the tokens from `references/result-contract.md`.
- `closure_gate_checked` must show what the fixer believes it satisfied and what remains unsatisfied.
- When the family remains actionable and a concrete reviewer-facing reevaluation or unblock action is known, include `reviewer_next_step`.
- When `claimed_closure_status` is `verification-blocked`, include `verification_blocker` with:
  - `broader_suite_command`
  - `blocking_failure_summary`
  - `probable_seam`
  - `reason_believed_separate`
- Every handled family entry must include `touched_build_gate` with the build,
  compile, typecheck, or equivalent command for the touched project/package,
  its scope, status, and evidence.
- Every handled family entry must include `local_quality_gates` for configured
  local repo quality checks on the touched unit, such as lint, format checks,
  static analysis, or InspectCode when the repo uses them. When no local
  quality gate is configured for the touched unit, include a
  `skipped-not-applicable` entry with concrete evidence instead of omitting the
  field.
- `family-closed` requires `touched_build_gate.status` to be `green` or
  `skipped-not-applicable`; `skipped-not-applicable` requires evidence that no
  touched-unit build/compile/typecheck gate exists.
- If the touched-unit build gate is `red`, `blocked`, or `hanging`, the lane
  must return `verification-blocked` or another open status, not
  `family-closed`.
- If a configured local quality gate is `red`, `blocked`, or `hanging`, the
  lane must return `verification-blocked` or another open status, not
  `family-closed`.
- When `claimed_closure_status` is `verification-blocked` and a concrete unblock action is known, `reviewer_next_step` is required.
- `reviewer_next_step` should include:
  - `kind`
  - `action`
  - `required_environment`
  - `expected_evidence`
  - `reevaluate_when`
- `reviewer_next_step` is reviewer-facing reevaluation guidance, not implementation instructions for another fixer slice.
- When `claimed_closure_status` is `family-closed` or `verification-blocked`, `verification_run` must make broader-suite status visible.
- `verification_run` must show build/compile/typecheck-before-tests ordering
  for the touched unit, or explicitly explain why no touched-unit build gate is
  applicable.
- `verification_run` must show local-quality-before-tests ordering for the
  touched unit, or explicitly explain why no local quality gate is applicable.
- Use `verification-blocked` when broader verification for the touched area is the remaining blocker but the family-local fix and targeted checks are otherwise in place.
- `emergent_threads_followed` must capture new threads exposed during repair or verification that were incorporated into the same family or slice. Each entry should include:
  - `summary`
  - `probable_seam`
  - `relationship_to_current_family`
- `emergent_threads_deferred` must capture newly exposed threads left for follow-up review or later fix work. Each entry should include:
  - `summary`
  - `probable_seam`
  - `relationship_to_current_family`
  - `grounding`
  - `defer_reason`
- `deferred_families` must use the same structured defer fields as the fixer's final result so return review can either carry those families forward or reopen broader exploration when the defer reason crosses family boundaries.
- `deferred_families` must include `touch_state` so return review can distinguish a true non-start from shared-file overlap caused by other family work.
- When `touch_state` is not `not-started`, `deferred_families` must also identify `blocking_family_ids`.
- A family that was materially started but left open must stay in `families` with an open `claimed_closure_status`; do not report it only in `deferred_families`.
- If nothing remains unsatisfied, set `unsatisfied_items` to `none`.
- If no new threads were followed or deferred, set those fields to `none`.
- If no residual risks remain, set `residual_risks` to `none`.
- The original implementer lane should remain open until targeted return review
  either approves closure or a genuine blocker makes the lane terminal.
