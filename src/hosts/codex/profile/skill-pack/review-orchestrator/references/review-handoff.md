# Review Handoff Contract

Use this contract when the review output will feed a downstream fix workflow.

The review handoff is a machine-oriented summary of the final defect families.
It is not a second review report. It must reflect the same family grouping,
severity, and root-cause conclusions as the human-facing final review output.
In targeted return-review mode, a refreshed downstream `review_handoff` uses
the same contract shape, but it should contain only the still-actionable
families and should absorb the return-review findings for those families.

## Top-level shape

```yaml
review_handoff:
  review_target:
    mode: branch
    scope_summary: "branch delta against origin/main"
  families:
    - family_id: F-001
      severity: MEDIUM
      title: Structured-output parsing is broader than the documented contract
      highest_confidence_root_cause: salvage-oriented parsing replaced a single authoritative output boundary
      source_surfaces:
        - host-adapter-execution
        - host-adapter-prompting
      manifestations:
        - src/hosts/codex/adapter/execution.ts:124
        - src/hosts/codex/adapter/execution.ts:144
        - src/hosts/codex/adapter/prompt.ts:25
        - README.md:195
      immediate_implications:
        - malformed artifacts can become successful outcomes if stdout is parseable
      broader_implications:
        - malformed host output is harder to detect
        - tests and docs may drift from the intended contract
      sibling_bugs:
        - same behavior confirmed on launch and resume
      sibling_search_scope:
        - launch path
        - resume path
        - related docs and tests
      closure_status: family-still-open
      open_reason_kind: family-local-gap-remaining
      thin_areas:
        - unrelated host adapters not inspected
      review_hints:
        likely_owning_seam: src/hosts/codex/adapter/execution.ts
        candidate_write_set:
          - src/hosts/codex/adapter/execution.ts
          - src/hosts/codex/adapter/prompt.ts
          - README.md
        candidate_test_set:
          - src/__tests__/...
        candidate_doc_set:
          - README.md
        parallelizable: false
      closure_gate:
        remediation_item: restore one authoritative structured-output boundary
        closure_checklist:
          - launch and resume converge on the same authoritative parsing contract
          - no adapter-side salvage path remains authoritative beside the main boundary
          - operator-facing status reflects post-repair truth
        required_sibling_tests:
          - malformed launch output cannot become a successful result through salvage
          - malformed resume output cannot become a successful result through salvage
        doc_closure:
          - docs describing the output contract are updated in the same patch
        reviewer_stop_conditions:
          - reject if the direct parse bug is fixed but sibling salvage paths remain
          - reject if tests or docs still encode the broader salvage contract
      next_step:
        kind: follow-up-fix
        action: tighten launch and resume parsing to one authoritative boundary
        required_environment: none
        expected_evidence:
          - updated adapter parsing code and tests
        reevaluate_when:
          - the next fixer slice starts for this family
      carry_forward_context:
        reason_kind: separate-family-later-slice
        touch_state: not-started
        reason: "This family was intentionally left for a later slice because the current fix batch stayed in a different owning seam."
        actionable_when: "A dedicated later slice starts for this family."
        blocking_family_ids: none
```

## Required fields

Top level:
- `review_target`
- `families`

Per family:
- `family_id`
- `severity`
- `title`
- `highest_confidence_root_cause`
- `source_surfaces`
- `manifestations`
- `immediate_implications`
- `broader_implications`
- `sibling_bugs`
- `sibling_search_scope`
- `closure_status`
- `open_reason_kind` when `closure_status` is not a closed state
- `thin_areas`
- `review_hints`
- `closure_gate`
- `next_step` when a concrete next action is known for an actionable family
- `carry_forward_context` when targeted return review preserves a still-open family from structured fixer defer/sequence data

Per `review_hints` block:
- `likely_owning_seam`
- `candidate_write_set`
- `candidate_test_set`
- `candidate_doc_set`
- `parallelizable`

Per `closure_gate` block:
- `remediation_item`
- `closure_checklist`
- `required_sibling_tests`
- `doc_closure`
- `reviewer_stop_conditions`

Per optional `next_step` block:
- `kind`
- `action`
- `required_environment`
- `expected_evidence`
- `reevaluate_when`

Per optional `carry_forward_context` block:
- `reason_kind`
- `touch_state`
- `reason`
- `actionable_when`
- `blocking_family_ids` when another family must land first

## Rules

- `review_hints` are downstream hints, not authoritative implementation instructions.
- Do not invent write-set hints that are unsupported by the evidence.
- `likely_owning_seam` should point to the most plausible owning module or boundary, not just the nearest changed file.
- `candidate_write_set` should include the likely owning implementation files plus any directly implicated supporting files.
- `candidate_test_set` and `candidate_doc_set` should list the tests and docs most likely to require updates if the family is fixed correctly.
- `parallelizable` should be `false` whenever the family appears to share files, invariants, or ownership with another family in the same review result.
- `closure_gate` should be a reusable acceptance gate for the family, not a prose restatement of the findings.
- `closure_checklist` should encode the root-cause closure conditions, not only the reported manifestation.
- `required_sibling_tests` should name the minimum test coverage needed to prove sibling-family closure.
- `doc_closure` should name the documentation updates required when contracts, invariants, or operator-visible truth change.
- `reviewer_stop_conditions` should tell a downstream fixer or reviewer when to reject a patch that fixes the local symptom but leaves the family open.
- When `closure_status` remains open, `open_reason_kind` should classify why: unresolved family-local gap, unfinished family work, broader cross-family contract, or separate verification blocker.
- When a family remains actionable and the reviewer can name a concrete next action, include `next_step`.
- When a family is effectively blocked pending a concrete verification or environment action, `next_step` should encode that unblock step in machine-readable form instead of leaving it as loose prose.
- `next_step.action` may be a command or a concrete action description, but it must be specific enough for a downstream fixer to either run it or explain why it cannot be run yet.
- `next_step.reevaluate_when` should tell the downstream fixer when a previously blocked or open status must be revisited.
- `carry_forward_context` should preserve structured defer/sequence rationale from targeted return review so the next fixer slice does not need to reconstruct why the family remained open.
- Use these `carry_forward_context.reason_kind` values:
  - `sequenced-after-overlapping-family`
  - `separate-family-later-slice`
  - `blocked-by-broader-contract-change`
  - `blocked-by-prerequisite-contract-change`
  - `blocked-by-external-environment`
  - `stale-or-ambiguous-input`
  - `user-scope-excluded`
  - `insufficient-grounded-evidence`
- Use these `carry_forward_context.touch_state` values:
  - `not-started`
  - `adjacent-file-overlap-no-owning-fix`
  - `broader-cross-family-overlap`
- A lone bug is still a family and must still appear in this contract as a one-family entry.
- If no sibling bugs were found, set `sibling_bugs` to `none found` and keep `sibling_search_scope` explicit.
- If no material thin areas remain, set `thin_areas` to `none`.
- When this contract is emitted from targeted return review, preserve stable `family_id` values where possible.
- When this contract is emitted from targeted return review, use the original family entry only as the starting point. Update the fields so they reflect the latest grounded subagent evidence about what remains open.
- When this contract is emitted from targeted return review, include only families that remain actionable after re-review.
- When this contract is emitted from targeted return review, update `next_step` as needed so the next fixer run can act on the latest reviewer-backed follow-up or unblock step.
- When this contract is emitted from targeted return review and a family remains open due to structured fixer defer/sequence data that still holds, include `carry_forward_context`.
- Do not use this contract as a verdict ledger. If you emit `review_handoff`, it must follow this full family-entry shape.
