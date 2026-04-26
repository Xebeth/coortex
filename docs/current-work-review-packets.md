# Current-Work Review Packets

## Status

This is a workflow reference for Coortex. It defines a target contract for
reviewing active implementation work before it turns into a large after-the-fact
review loop.

Current skills, prompts, and helpers may not yet enforce every part of this
model. Treat this document as the intended contract unless a more specific
implementation note says otherwise.

## Purpose

Coortex already has strong machinery for after-the-fact review:

- baseline-driven multi-agent review
- family handoff synthesis
- fixer lanes
- targeted return review

Current implementation work has a different problem. There may be no known
defect family yet, but the work still has:

- intended surfaces
- seams and owners
- invariants
- entry paths
- failure paths
- tests and acceptance criteria

Without a bounded packet for that current work, review can degrade into:

1. local patch accepted
2. sibling path rediscovered later
3. another local fix
4. another review loop

The current-work review packet reduces that risk by giving reviewer and
implementer the same bounded surface and coverage matrix while the work is
still fresh.

## Baseline alignment

Current-work packet surfaces and baseline surfaces should be compatible review
inputs. Reviewers should be able to consume either shape without learning a
different surface model.

Use the same surface vocabulary and field meanings:

- `id`
- `name`
- `purpose`
- `primary_anchors`
- `supporting_anchors`
- `contract_docs`
- optional `review_focus_areas`

Use `baseline_surface_refs` when the packet intentionally narrows one or more
existing baseline surfaces. If no baseline surface fits, omit the refs and keep
the packet surface scoped to the current work.

Multiple `baseline_surface_refs` are valid only when the current work
intentionally crosses those surfaces. Otherwise, narrow the packet to one
surface or escalate to `review-orchestrator` or a baseline refresh instead of
letting the packet absorb broad review scope.

When `baseline_surface_refs` are present, the packet surface may narrow anchors
or add current-work focus, but it should not contradict the referenced baseline
surface's purpose, contract docs, or recurring focus areas. Any intentional
departure should be called out in `known_uncertainties` or `reviewer_focus`.

## Core model

Use two complementary artifacts:

1. **Mini-surface packet**
   - defines the review boundary
   - states intent, seams, invariants, in-scope paths, and out-of-scope paths
2. **Coverage matrix**
   - lives inside the mini-surface packet
   - records which paths, transitions, races, ownership/drop points, failure
     points, sibling manifestations, and tests were considered

The mini-surface packet answers:

- what work is being reviewed?
- what surface is in scope?
- what invariants matter?
- where should the reviewer look?
- what is intentionally out of scope?

The matrix answers:

- which rows inside that surface were checked?
- which rows were fixed?
- which rows are tested?
- which rows are deferred or uncertain?

## When to use this

Use a current-work review packet for non-trivial implementation work when:

- there is no existing review family handoff
- the work crosses more than one entry path or seam
- the work changes ownership, lifecycle, recovery, persistence, or async
  behavior
- sibling paths could share the same implementation assumption
- a late broad review loop would be expensive

Do not use this as a replacement for:

- persistent project review baselines
- full review-orchestrator campaigns
- fixer-family closure gates when a family already exists

If the packet grows beyond the current work surface, escalate to a proper
review-orchestrator or baseline refresh instead of expanding the packet
indefinitely.

## Relationship to family matrices

For current implementation work:

- the **mini-surface packet** is the main artifact
- the **coverage matrix** is one section of that packet

For fixer/family work:

- the existing review handoff or family closure gate is the main artifact
- a **family matrix** can serve the same coverage role inside that family

The shape is intentionally similar so reviewer habits transfer between current
implementation review and fixer return review.

## Packet shape

The packet should stay compact, but its `surface` block should remain
baseline-compatible. Include only the surface fields needed to orient review
for the current work; do not copy a full baseline surface just to fill fields.

Use `packet_version: 1` for this schema. Future incompatible packet-shape
changes should increment that version rather than silently changing reviewer
expectations.

Illustrative shape:

```yaml
mini_surface_review_packet:
  packet_version: 1
  packet_id: current-work-<stable-slug>
  status: handoff
  source: current_implementation
  intent: "What the implementation is meant to change."
  baseline_surface_refs:
    - runtime-recovery
  surface:
    id: current-work-runtime-recovery
    name: Runtime recovery current work
    purpose: "Bounded current implementation review."
    primary_anchors:
      - path/to/owner/**
    supporting_anchors:
      - path/to/relevant-test.ts
    contract_docs:
      - docs/relevant-contract.md
    review_focus_areas:
      - "provenance must track launch vs resume vs recovery correctly"
  review_boundary:
    in_scope_paths:
      - path/to/owner.ts
      - path/to/caller.ts
    expected_write_set:
      - path/to/owner.ts
    out_of_scope:
      - "Explicitly excluded adjacent behavior."
  seams:
    - path: path/to/owner.ts
      role: owner
    - path: path/to/caller.ts
      role: caller
  invariants:
    - "One-line invariant preserved or introduced by this work."
  coverage_matrix:
    rows:
      - row_id: entry-main
        category: entry_path
        paths:
          - path/to/caller.ts
        expected_behavior: "Expected behavior for this path."
        tests:
          - "test identifier or evidence reference"
        status: tested
        notes: "Short evidence or reason."
  reviewer_focus:
    - "Specific bounded concern the reviewer should check."
  known_uncertainties:
    - "Any uncertainty the implementer wants reviewed."
```

This is a schema sketch, not a committed wire format. Implementations should
preserve the same meaning even if they serialize it as JSON or another
structured format.

## Coverage matrix rows

Use only rows that matter to the current work. Common row categories:

- `entry_path`
  - user, API, CLI, host, or internal entry point
- `terminal_path`
  - shutdown, final state, cleanup, release, or delete path
- `state_transition`
  - meaningful lifecycle or state-machine transition
- `async_race_window`
  - cancellation, timeout, shutdown, retry, or concurrent operation window
- `ownership_drop_point`
  - handoff between owner/caller/lower layer where state or authority could be
    lost
- `failure_path`
  - persistence, parse, abort, network, permission, or recovery failure
- `sibling_manifestation`
  - adjacent path likely to share the same implementation assumption or
    failure mode
- `test_row`
  - explicit test coverage row when coverage is the main concern

Each row should include:

- stable `row_id`
- category
- relevant path(s)
- expected behavior or invariant
- status
- test evidence or reason for no test
- notes for reviewer

Keep `row_id` stable once a packet is handed to review. Do not renumber rows to
hide gaps; mark rows `deferred`, `uncertain`, or `not_applicable` instead.

Recommended row status values:

- `planned`
  - identified before implementation or review, not checked yet
- `checked`
  - reviewed manually or by inspection, with evidence in `notes`
- `fixed`
  - changed by the implementation, with expected behavior stated
- `tested`
  - covered by executable test or equivalent verification evidence
- `open`
  - still failing or still requiring implementation/review work
- `deferred`
  - intentionally outside the current boundary or scheduled separately
- `uncertain`
  - not proven either way; must be called out in reviewer output
- `not_applicable`
  - explicitly considered and found irrelevant to this packet

Use the row `status` as the latest/current row state. If a row needs to retain
multiple pieces of evidence, keep `status` current and record the extra evidence
in `tests` or `notes` rather than overloading the status value.

## Implementer responsibilities

Before or during implementation, the implementer should:

1. draft the mini-surface packet when the work is non-trivial
2. state the invariant being preserved or introduced
3. identify in-scope and out-of-scope paths
4. fill the coverage matrix with the relevant rows
5. update row status as the implementation and tests change
6. attach the packet to the handoff or review request

The implementer must not use the packet to expand scope silently. New rows that
point outside the intended boundary should be marked deferred or escalated.

## Reviewer responsibilities

The reviewer should review against the packet, not just against the nearest
patched line.

For each material finding or approval, the reviewer should check:

- whether the same implementation assumption or failure mode exists across
  sibling rows
- whether ownership/drop/failure paths are closed
- whether tests cover the relevant matrix rows
- whether out-of-scope rows are genuinely out of scope

Reviewer output should include a compact check object.

Illustrative shape:

```yaml
surface_checked:
  packet_id: current-work-<stable-slug>
  review_boundary_respected: true
  packet_rows_accounted_for:
    - entry-main
    - failure-persistence
  sibling_scope_checked:
    - path/to/sibling.ts
  matrix_checked:
    rows_checked:
      - entry-main
      - failure-persistence
    rows_closed:
      - entry-main
    rows_open: []
    rows_deferred:
      - adjacent-out-of-scope
    rows_uncertain: []
    test_coverage_gaps: []
  verdict: approve
```

Reviewer approval should mean:

- the packet boundary was respected or explicitly challenged
- the reviewer accounted for each material row in the packet
- relevant matrix rows were checked
- open rows are either real findings or explicitly deferred
- uncertain rows are called out instead of being rounded up to closure
- test gaps are either closed, accepted, or called out

If the packet is missing for non-trivial work, the reviewer should either ask
for one or state why `matrix_not_applicable` is valid.

If the reviewer claims `matrix_not_applicable`, they should still make the
reason explicit:

```yaml
matrix_not_applicable:
  reason: "Mechanically local one-line change with no sibling path or lifecycle impact."
  checked_paths:
    - path/to/file.ts
  residual_risk: "none"
```

## Orchestrator responsibilities

In a current-work review mode, the orchestrator should:

- ask for or synthesize a mini-surface packet before broad review starts
- keep review lanes bounded to that packet
- require reviewer output to include `surface_checked` or
  `matrix_not_applicable`
- route same-assumption or same-failure-mode sibling findings as one grouped
  issue when possible
- reject approvals that do not account for relevant matrix rows
- reject approvals that leave `open` or `uncertain` rows without a finding,
  explicit deferment, or accepted residual risk

The orchestrator should treat the packet as ephemeral run context, not a
persistent baseline. If the same mini-surface recurs across runs, that is a
signal to create a proper baseline surface or alternative baseline.

## Guardrails

- Keep packets small enough for one reviewer to consume.
- Do not broaden the packet into a whole feature-area baseline.
- Do not let the matrix replace actual review judgment.
- Do not require artificial rows for trivial one-line or mechanically local
  changes.
- Do not let reviewer findings become local one-off fixes when they point to a
  shared matrix row.
- Do not approve non-trivial current work with only patched-line inspection.

## Summary

Mini-surface packets and coverage matrices serve different roles:

- the mini-surface packet defines the review boundary
- the coverage matrix records row-level coverage, gaps, and residual
  uncertainty inside that boundary

Together they let Coortex review current implementation work as it evolves,
instead of waiting for a large after-the-fact loop to rediscover sibling issues.
