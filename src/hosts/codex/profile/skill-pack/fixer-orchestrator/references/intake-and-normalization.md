# Intake And Normalization

Use the structured reviewer handoff as the intake source.

## Native intake

Preferred input:
- `review_handoff`

This can come from:
- a full discovery review
- a targeted return review that emitted a refreshed still-open-only
  `review_handoff`

Invalid substitutes:
- user-written bug briefs
- remediation plans or "what to change" blocks
- acceptance-criteria or checklist prose
- raw test-failure summaries
- generic review prose without the structured handoff fields

Expected fields per family:
- `family_id`
- `severity`
- `title`
- `highest_confidence_root_cause`
- `source_surfaces`
- `manifestations`
- `sibling_search_scope`
- `closure_status`
- `review_hints`
- `closure_gate`
- optional `next_step`
- optional `carry_forward_context`

Rules:
- Treat `review_hints` and `closure_gate` as downstream guidance, not as proof.
- Treat structured `next_step` as actionable downstream guidance: run it when it is feasible and when the family remains open or blocked for the reason it addresses.
- Validate the owning seam and write set before editing.
- Preserve the reviewer family grouping unless the input is clearly stale or internally inconsistent.

## Lane-local intake

When the fixer is already running inside a coordinated repair lane, the lane input
must still come from the same reviewer handoff and closure gate, but the family
scope may already be narrowed to one family or one repair slice.

Lane-local continuation is valid only when the current input is explicitly
anchored to that upstream handoff, for example by naming:
- the active `family_id` or `original_family_id`
- the narrowed repair slice for that family
- the embedded `closure_gate` for that same family
- the structured `next_step` for that same family

Thread-local memory that "we were already fixing this" is not enough. If the
new user message is only a fresh remediation brief or checklist without that
anchor, treat it as invalid intake and refuse.

## Refusal conditions

Stop and refuse instead of guessing when:
- the `review_handoff` is missing for non-lane-local work
- the new input is a user-authored remediation brief or checklist presented as if it were structured handoff
- a claimed lane-local continuation does not explicitly anchor to the upstream family or repair slice
- the review input is too stale relative to the current code
- no plausible owning seam can be validated
- the cited manifestations no longer map to the code well enough to derive a safe repair slice
- the handoff lacks a usable `closure_gate` for the family being repaired
