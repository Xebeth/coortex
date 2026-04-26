# Implementation Handoff And Intake

Use this reference when an implementation lane is ready to claim completion for
non-trivial current work.

## Rule

A bare completion summary such as "done" is not a valid handoff. The
coordinator must reject summary-only or missing handoffs before return review
and send the work back to the same implementation lane.

## Required handoff fields

The handoff should stay compact, but it must make readiness auditable:

```yaml
implementation_handoff:
  packet_path:
  slice_id:
  status: implemented | blocked | needs_continuation
  changed_files:
  owning_seam:
  scope_evidence:
    inside_packet_scope:
    out_of_scope_changes:
  coverage_row_evidence:
    - row_id:
      evidence:
      gaps:
  verification:
    build_or_typecheck:
    local_quality_gates:
    targeted_tests:
    broader_tests_if_required:
  self_deslop:
  self_review:
  deferred_threads:
  residual_risks:
```

Use `none` for empty lists or risks. Do not omit the field.

## Coordinator intake checklist

Before return review, the coordinator checks:

- handoff object is present and not just prose
- `changed_files` are inside the approved packet scope or explicitly justified
- build/typecheck evidence appears before test evidence
- configured local quality gates are present or explicitly not applicable
- targeted tests are present or explicitly not applicable
- every packet coverage row has evidence, gap, defer, or not-applicable status
- self-deslop and self-review results are explicit
- deferred threads and residual risks are explicit, even when `none`

If any item is missing, do not ask the reviewer to compensate. Return a
continuation note to the same implementation lane with the missing fields and
required evidence.
