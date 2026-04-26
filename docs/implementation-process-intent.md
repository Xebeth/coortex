# Implementation Process Intent

## Status

This is a workflow reference for implementing non-trivial current work. It
records the intended implementer process independently of any one repository's
architecture, and it also defines how fixer workflows specialize that process
for review-family repair.

Skills and helpers should enforce these invariants where possible. Treat gaps
as skill, helper, or schema work rather than runtime improvisation by agents.

The YAML blocks below are schema sketches for process artifacts, not committed
wire formats.

## Purpose

The implementation process exists to make feature and repair work reviewable
before it turns into an informal implement-review-fix loop.

The main failure mode is that reviewers discover the specification during code
review. That causes repeated local fixes, late sibling discovery, and unclear
closure gates.

The intended flow is:

```text
idea
→ milestone brief
→ milestone baseline
→ slice plan
→ slice spec
→ spec review
→ implementation lane
→ implementation handoff
→ return review
→ continuation loop if needed
→ coordinator closing gate
→ atomic commit
→ milestone closeout
```

The key improvement is:

```text
baseline defines lenses
slice spec applies lenses
spec review validates expectations
implementation proves them
return review checks proof
closing gate records completion
```

Canonical machine artifacts are enough for the workflow. Human-readable slice
docs may be produced when the project needs durable documentation, but they are
not required supplements to the canonical `.coortex/current-work/<run-id>/`
packet, review, handoff, gate, and closeout artifacts.


## Fixer specialization

Fixer workflows are repair-specialized implementations. They should share the
same protocol vocabulary for approved work packets, implementation lanes,
implementation handoffs, coordinator intake, independent return review,
continuation loops, closing gates, closeout accounting, and atomic commits.
They should not call the user-facing implementation coordinator as a nested
workflow.

The specialization changes the intake and adds repair-family obligations:

- a structured `review_handoff` replaces ordinary idea intake
- review families and closure gates replace feature goals as the acceptance
  target
- family ids are required because the work closes known review families
- family ledger updates, fixer traces, active-campaign locks, and final lock
  release remain fixer-owned
- same-worker continuation is stricter because family-local context must survive
  return-review send-backs
- `$review-orchestrator` targeted return review remains the independent closure
  authority
- commits are one approved repair slice/family set at a time

This means fixer skills consume the shared implementation protocol and add
repair-family extensions. It does not mean `$fixer-orchestrator` should invoke
`$implementation-coordinator`, and it does not mean a standalone bounded repair
needs a formal `review_handoff` when the user prompt is already scoped.

Quality-gate resolution is part of the shared protocol. Gates that can be
resolved at baseline time should be fixed there; gates that depend on the
actual touched unit must be resolved during coordinator prep before
implementation lanes run. If required gate resolution is missing at prep time,
the workflow should block for a baseline refresh or operator decision before
implementation starts.

## Relationship to existing docs

- `review-process-intent.md` defines defect-discovery review and family
  synthesis.
- `current-work-review-packets.md` defines compact review packets for active
  implementation work.
- `repo-local-quality-gates.md` defines how finish gates are discovered,
  resolved, owned, and evidenced.

This document connects those concepts into one implementer workflow.

## Core responsibilities

### Project baseline

The project baseline is persistent repo-level configuration. It defines stable
surfaces and the normal review and verification vocabulary.

```yaml
baseline_version:
updated_at:
repo_quality_gates:
  - id:
    command:
    command_template:
    owner:
    blocking_stages:
    resolution:
surfaces:
  - id:
    name:
    purpose:
    primary_anchors:
    supporting_anchors:
    contract_docs:
    configured_builtin_lenses:
    configured_custom_lenses:
    review_focus_areas:
    finish_gate_refs:
```

The project baseline is the stable reference for milestone baselines and slice
specs. It should not be rewritten for one slice unless the project model itself
changed. The shape above follows the existing review-baseline convention of
top-level baseline fields; it is not a new `project_baseline` wrapper schema.

### Milestone coordinator

The milestone coordinator turns user intent into a bounded milestone, derives a
milestone baseline, plans slices, and owns final milestone closeout. It may
coordinate lanes, but it should not implement slice code.

### Slice coordinator

The slice coordinator owns packet/spec preparation, spec review routing,
implementation-lane intake, return-review routing, closing gates, and the atomic
commit. It remains implementation-read-only after implementation begins: it may
write process artifacts, trace records, and the final commit, but it must not
patch product, test, or docs content to close the slice. If a gate or review
finds work, it sends the work back to the implementer lane.

### Spec reviewer

The spec reviewer is read-only. It validates that the slice spec is testable,
bounded, contract-aware, and realistic before implementation starts.

### Implementation lane

The implementation lane owns code changes for one approved slice. It does not
commit and does not spawn subagents. It stays inside the approved write scope and
implements or repairs at the owning seam.

### Return reviewer

The return reviewer is independent of implementation. It reviews the approved
spec, the actual diff, and the implementation handoff. It checks proof of
closure rather than rediscovering the whole spec.

## 1. Idea intake

Idea intake turns user intent into a milestone brief.

```yaml
milestone_brief:
  id:
  problem:
  desired_outcome:
  non_goals:
  affected_users_or_callers:
  known_constraints:
  unknowns:
  success_criteria:
```

Gate:

- outcome is observable
- non-goals are explicit
- unknowns are separated from assumptions
- success criteria can be checked later

If the outcome is not observable, continue clarification before planning slices.

## 2. Milestone baseline

The milestone baseline derives from the project baseline and narrows it to the
current milestone. It is broader than one slice but narrower than the repository
baseline.

```yaml
milestone_baseline:
  derives_from:
  milestone_id:
  target_architecture:
  affected_surfaces:
    - surface_id:
      baseline_surface_ref:
      owning_seam:
      primary_anchors:
      supporting_anchors:
      contract_docs:
      lenses:
        - id:
          priority:
          expectations:
          evidence_required:
      review_focus_areas:
      milestone_specific_risks:
  verification_policy:
    build_first:
    quality_gates:
    targeted_tests:
    broader_tests:
  slice_candidates:
```

Gate:

- affected surfaces map cleanly to the project baseline, or the mismatch is
  explicit
- lenses are ordered per affected surface
- milestone-specific risks are captured outside generic lens text
- finish gates are concrete when possible
- templated finish gates name the prep-time inputs needed to resolve them

Any gate that can be resolved at baseline time should be resolved there. If a
gate depends on changed files, package, project, module, or artifacts, the
baseline must say what coordinator prep must resolve before lanes start.

## 3. Slice plan

The slice plan breaks the milestone into bounded implementation units.

```yaml
slice_plan:
  slices:
    - id:
      title:
      owning_surface:
      owning_seam:
      write_scope:
      dependencies:
      parallel_safe_with:
      expected_artifacts:
      closure_gate_summary:
```

Rules:

- prefer one owning seam per slice
- keep write scopes disjoint when slices may run in parallel
- sequence overlapping write scopes
- defer unknown backend, protocol, or external integration work until probed
- avoid slices whose closure depends on another unstarted slice unless the
  dependency is explicit

## 4. Slice spec / execution packet

The execution packet is the artifact implementation starts from. It applies the
baseline and milestone baseline to one slice.

```yaml
execution_packet:
  slice_id:
  family_id: # optional; required when closing a known review family
  goal:
  non_goals:

  baseline_surface_refs:
    - surface-id
  surface:
    id:
    name:
    purpose:
    primary_anchors:
    supporting_anchors:
    contract_docs:
    review_focus_areas:

  owning_seam:
    description:
    files_or_modules:
    why_this_seam_owns_it:
    sibling_seams_to_check:

  write_scope:
    allowed:
    forbidden:
    docs:
    tests:

  contracts:
    inputs:
    outputs:
    state_changes:
    errors:
    side_effects:
    compatibility:

  invariants:
    - id:
      statement:
      applies_to:
      evidence_required:

  lenses:
    - id:
      applies:
      expectations:
      evidence_required:
      rejection_examples:

  edge_cases:
    - id:
      condition:
      expected_behavior:
      evidence_required:

  verification_gates:
    build_or_typecheck:
    quality:
    targeted_tests:
    broader_tests:
    docs_validation:

  deferred_threads:
    - id:
      reason_deferred:
      trigger_to_reopen:

  output_contract:
    requires_review_return_handoff: true
    requires_closure_matrix: true
```

The execution packet should be compatible with the current-work packet model:
its surface, seam, invariant, matrix, and focus fields should use the same
vocabulary as `current-work-review-packets.md`.
`baseline_surface_refs` are optional, but when present they follow the same
narrowing and multi-surface rules as current-work review packets.

`slice_id` is the primary identity for feature work. `family_id` is present
only when the slice repairs or closes a known review family; do not invent a
defect-family identifier just to make a feature slice look like fixer work.

After spec review approval, the approved packet is immutable for the slice. If
the packet changes, the coordinator must treat the prior approval as stale and
run spec review again. Persist the approved packet hash or equivalent immutable
reference with the spec-review artifact so later handoff and closeout checks can
prove which packet was approved.

## 5. Spec review lane

Spec review is read-only and runs before implementation.

```yaml
spec_review:
  lane_type: spec-review
  lenses:
    - goal-fidelity
    - api-contract
    - quality
    - qa-execution
    - portability
    - context-history
  checks:
    - goal is testable
    - owning seam is correct
    - scope is bounded
    - contracts are explicit
    - invariants are sufficient
    - edge cases follow from lenses
    - verification is realistic
    - deferred threads are legitimate
    - shared assumptions and sibling paths are explicit enough to review
    - stale docs, tests, generated artifacts, or checks that may encode the old
      behavior are either in scope, deferred, or explicitly not applicable
```

Output:

```yaml
spec_review_result:
  verdict: APPROVE | REQUEST_CHANGES | BLOCKED
  findings:
    - id:
      severity:
      issue:
      evidence:
      root_cause_or_sibling_family:
      required_spec_change:
  approved_packet:
  approved_packet_hash:
```

No implementation starts until spec review approves the packet. If spec review
rejects, update the packet rather than asking implementation to infer the
missing contract from code review later.

## 6. Implementation lane

The implementation lane receives the approved execution packet.

Rules:

- use the same implementation worker until the slice reaches a terminal state,
  unless an operator override or unavailable worker forces reassignment
- do not commit
- do not spawn subagents from the lane
- stay inside the approved write scope
- prefer the smallest viable diff that satisfies the approved packet
- reuse existing patterns before inventing new helpers or abstractions
- implement or repair at the owning seam instead of adding local shims around it
- surface any out-of-scope sibling immediately instead of silently widening

Required order:

```text
inspect relevant existing patterns
→ make a file-level implementation plan
implement
→ build/typecheck gate
→ quality gates
→ targeted tests
→ deslop
→ lane-local review
→ rerun build/typecheck
→ rerun quality gates
→ rerun targeted tests
→ emit handoff
```

The lane should not claim closure when required lane-owned gates are red,
blocked, hanging, missing, or not applicable without evidence.
If blocked, it should re-check assumptions against repo evidence, try a smaller
or different bounded approach when safe, and then report a concrete blocker
instead of continuing speculative edits.

Output:

```yaml
review_return_handoff:
  slice_id:
  family_id: # optional; required when closing a known review family
  claimed_closure_status:
  changed_files:
  owning_seam:
  contracts_changed:
  invariants_restored:
  lens_evidence:
    - lens:
      evidence:
      gaps:
  edge_case_evidence:
  verification:
    build:
    quality:
    tests:
  self_deslop:
  self_review:
  deferred_threads:
  residual_risks:
  latest_artifact_refs:
    packet:
    spec_review:
    handoff:
    gates:
  supersedes:
```

`claimed_closure_status` is the implementer's claim, not the review verdict.
Use the same claim vocabulary as the return-review family-local lane contract
so implementation handoffs can feed the existing reviewer tooling without
schema translation. Do not mix this field with downstream fixer
`review_handoff.closure_status`; that is a separate handoff vocabulary.
For family repair, expected claim values are `symptom-fixed-only`,
`family-partially-closed`, `verification-blocked`, or `family-closed`. For
non-family feature slices, the completion token is an open schema gap: do not
invent unvalidated persisted tokens; extend the helper/schema before
machine-consuming those handoffs.

`latest_artifact_refs` points at the current packet, approval, handoff, and gate
evidence the coordinator should use next. `supersedes` names any previous
handoff or gate artifact made stale by a continuation loop. A lane must not
claim completion against stale artifacts after a continuation produced newer
evidence.

## 7. Coordinator intake gate

Before return review, the coordinator checks that the implementation handoff is
complete. This gate is mechanical and implementation-read-only.

```yaml
intake_gate:
  handoff_present:
  changed_files_inside_scope:
  build_before_tests:
  quality_before_tests:
  targeted_tests_present:
  deslop_done:
  self_review_done:
  lens_evidence_complete:
  residual_risks_explicit:
  packet_hash_matches_latest_spec_review:
  latest_artifact_refs_current:
```

If intake fails, build a continuation packet and send it back to the same
implementation lane. Do not ask a reviewer to compensate for a missing handoff,
missing gate evidence, or out-of-scope diff.
If the packet hash no longer matches the latest approved spec-review artifact,
return to spec review before implementation continues.

## 8. Return review lane

Return review is independent review against the approved spec and actual diff.

```yaml
return_review:
  lane_type: return-review
  inputs:
    - approved_execution_packet
    - review_return_handoff
    - diff
  checks:
    - closure_gate satisfied
    - contracts preserved or updated
    - invariants hold
    - lenses addressed
    - edge cases covered
    - sibling seams checked
    - same-assumption or same-family leaks checked
    - stale docs, tests, generated artifacts, or checks updated or explicitly
      deferred
    - tests meaningful
    - no scope creep
```

Output:

```yaml
return_review_result:
  verdict: APPROVE | REQUEST_CHANGES | BLOCKED
  findings:
    - finding_id:
      severity:
      root_cause_family:
      root_cause_or_sibling_family:
      evidence_files:
      invariant_violated:
      sibling_search:
      required_fix:
      required_tests:
```

Return review checks the implementer's proof. It should not have to discover the
slice's intended contracts, lenses, or edge cases from scratch.
When it does find work, the finding should say whether it is local row closure,
a shared root-cause issue, a same-family sibling manifestation, or stale
artifact/docs/test/check evidence that still encodes the old behavior.

## 9. Continuation loop

If return review rejects, the coordinator builds a continuation packet and sends
it back to the same implementation lane.

```yaml
lane_continuation:
  original_slice_id:
  same_worker_required: true
  findings_to_close:
  closure_gate_delta:
  required_tests:
  reviewer_next_step:
```

Loop exits only on:

- `APPROVE`
- `BLOCKED` with concrete blocker evidence
- operator override

Use the same worker for continuity. Use the same reviewer for verification when
the reviewer context is still valid; use a fresh reviewer only for a final audit
or when reviewer context became suspect.

## 10. Coordinator closing gate

After return-review approval, the coordinator runs the closing gate. The
coordinator remains implementation-read-only.

```yaml
closing_gate:
  return_review_approved:
  all_findings_closed:
  final_build_typecheck:
  final_quality_gates:
  final_targeted_tests:
  broader_tests_if_required:
  diff_scope_clean:
  docs_updated_if_contract_changed:
  residual_risks_recorded:
  latest_artifact_refs_consistent:
  commit_ready_record:
```

If the closing gate finds work, send it back to the same implementation lane.
Do not patch coordinator-side and do not commit until the gate is complete.
No evidence means not complete: a closing gate cannot pass on prose confidence,
stale test output, or an assumed clean build.

## 11. Atomic commit

One approved slice becomes one atomic commit.

```yaml
commit_record:
  slice_id:
  family_id: # optional; present when the slice closes a review family
  summary:
  constraints:
  rejected_alternatives:
  tested:
  residual_risk:
```

Rules:

- no batching unrelated slices
- no commit before return-review approval and closing-gate completion
- commit body should explain what changed and why
- residual risk must be explicit, not hidden in prose optimism

## 12. Milestone closeout

After all slices close, the milestone coordinator performs closeout.

```yaml
milestone_closeout:
  completed_slices:
  contracts_delivered:
  verification:
    broader:
    integration:
    manual:
  deferred_threads:
  residual_risks:
  docs_updated:
  final_review_needed:
```

Gate:

- actual implementation still matches the milestone baseline
- all deferred threads are explicit
- integration assumptions have evidence or are carried as residual risk
- docs changed when contracts, invariants, or operator-visible behavior changed
- any final review need is named instead of implied
- closeout references the latest packet, spec review, implementation handoff,
  return review, gate artifacts, and commit or install state

## Deterministic enforcement targets

The process should become helper-enforced where possible:

- baseline and milestone baseline validation
- execution packet validation
- canonical write helpers for packet, spec review, implementation handoff,
  return review, and closeout artifacts (`write-packet`, `write-spec-review`,
  `write-handoff`, `write-return-review`, `write-closeout`)
- approved packet hash binding between spec review, handoff, return review, and
  closeout
- spec review result validation
- implementation handoff completeness
- latest artifact reference and `supersedes` consistency across continuation
  loops
- coordinator intake gate
- return-review result shape
- continuation packet shape
- closing-gate record
- commit-ready record
- milestone closeout record
- closeout consistency against the latest artifact set

Instructions alone are not enough. If a helper can detect a missing field,
invalid token, scope mismatch, gate-order violation, or artifact inconsistency,
it should do so before the next phase starts.
