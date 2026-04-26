---
name: implementation-coordinator
description: User-facing Coortex implementation coordinator for non-trivial current work. Use when a normal implementation request needs to become a bounded spec, current-work packet, spec review, implementation handoff, return review, continuation loop, and closing gate without requiring the user to provide a formal packet.
---

# Implementation Coordinator

Turn ordinary implementation intent into a disciplined current-work workflow so
reviewers do not discover the spec during code review.

Use this skill when the user asks for non-trivial feature or implementation
work and the prompt does not already contain a formal current-work packet.

Good fits:

- feature work crossing more than one path, seam, invariant, or acceptance case
- current work where sibling paths may share an implementation assumption
- implementation that needs spec review before code and return review after code
- user intent that is clear enough to shape but not already packetized

Do not use this skill when:

- the input is a structured `review_handoff` for defect-family repair; use
  `$fixer-orchestrator`
- the task is one bounded repair finding or deslop follow-up; use
  `$review-fixer`
- the user only asked for review; use `$coortex-review` or
  `$review-orchestrator`
- the change is trivial and mechanically local enough that a packet would add
  ceremony without reducing risk

## Core stance

- User-facing entrypoint: ordinary intent is enough to start; do not require the
  user to know the packet/spec prompt shape.
- For non-trivial work, draft or validate a current-work mini-surface packet
  before implementation edits begin.
- Run read-only spec review before implementation. Fix the packet/spec first;
  do not ask implementation to infer missing contracts later.
- Preserve role boundaries even in a single-agent session: coordinator phases
  plan, validate, route, and gate; implementation phases edit code/docs/tests.
- Delegation follows host policy. Do not spawn subagents unless the user or host
  explicitly permits delegation. When delegation is not available, execute the
  lane locally while preserving the same phase boundaries and handoff contract.
- Coordinator phases are implementation-read-only after implementation begins.
  If review or gates find work, route it back to the same implementation lane
  instead of patching coordinator-side.
- Do not require `family_id` or formal `review_handoff` for pure feature work.
- Do not commit unless the user explicitly asks for a commit or the surrounding
  workflow requires one.

## Helper use

Resolve sibling helper paths relative to the installed skill pack under
`.codex/skills/`, not relative to the repository root.

Use the current-work helper from the installed `$coortex-review` skill for
packet and reviewer-output mechanics. These exact helper commands are the
canonical protocol for current-work packet and review-output validation:

```bash
python .codex/skills/coortex-review/scripts/review_state.py validate-current-work-packet \
  --packet-file <packet.json>

python .codex/skills/coortex-review/scripts/review_state.py validate-current-work-review-output \
  --packet-file <packet.json> \
  --review-output-file <review-output.json>
```

Treat helper validation as authoritative. If packet or review-output validation
fails, stop with a protocol error for that phase and fix the artifact instead
of reconstructing matrix checks by hand.

Before starting in a worktree, also use the `$coortex-review` helper to check
for an active top-level review/fix campaign lock. Do not start a standalone
implementation workflow over a live mutating orchestrator campaign.

## Workflow

1. **Intake ordinary intent**
   - State the observable outcome, non-goals, constraints, unknowns, and
     acceptance criteria.
   - If the outcome is not observable or the write scope is unknowable, ask for
     clarification before planning code.
2. **Choose scope shape**
   - If the work is too broad for one implementation slice, split it into
     sequenced slices with one owning seam per slice when possible.
   - If the request is actually a defect-family repair from a `review_handoff`,
     redirect to `$fixer-orchestrator`.
3. **Draft the current-work packet**
   - Include surface, review boundary, seams, invariants, coverage rows,
     reviewer focus, and known uncertainties.
   - Use baseline-compatible surface vocabulary from
     `docs/current-work-review-packets.md` when available.
   - Resolve finish gates as early as possible. If a required gate cannot be
     resolved from the baseline, repo docs, or prep context, block for baseline
     refresh or operator decision before implementation.
4. **Validate the packet**
   - Run `validate-current-work-packet` and treat failures as protocol errors.
   - Update the packet until validation passes.
5. **Run read-only spec review**
   - Review the packet with `$coortex-review` before implementation.
   - Require `surface_checked` or `matrix_not_applicable` output and validate it
     with `validate-current-work-review-output`.
   - If spec review requests changes, update the packet and repeat validation
     and spec review before editing.
6. **Run the implementation lane**
   - Use the same implementation lane until the slice reaches a terminal state,
     unless an operator override or unavailable worker forces reassignment.
   - Stay inside the approved packet write scope.
   - Implement at the owning seam instead of adding local shims around it.
   - Run touched-unit build, compile, or typecheck and configured local quality
     gates before targeted tests.
   - Run targeted tests only after build/typecheck and local quality gates are
     green or explicitly not applicable with evidence.
   - Run bounded `$coortex-deslop`, then bounded `$coortex-review` against the
     same packet, and rerun gates/tests after any edits.
7. **Emit implementation handoff**
   - Include packet path, slice id, changed files, owning seam, invariants,
     coverage-row evidence, gate evidence, tests, self-deslop/self-review
     result, deferred threads, and residual risks.
8. **Coordinator intake gate**
   - Mechanically check the handoff before return review:
     - handoff present
     - changed files inside packet scope
     - build/typecheck before tests
     - local quality gates before tests
     - targeted tests present or explicitly not applicable
     - deslop and self-review done
     - coverage rows and residual risks accounted for
   - If intake fails, build a continuation note and send it back to the same
     implementation lane. Do not ask a reviewer to compensate.
9. **Return review**
   - Run independent `$coortex-review` against the approved packet, handoff, and
     diff.
   - Validate `surface_checked` or `matrix_not_applicable` output with the
     helper.
   - If return review rejects, send findings back to the same implementation
     lane and repeat from implementation handoff.
10. **Closing gate**
    - Run a coordinator-side implementation-read-only gate after return-review
      approval:
      - bounded `$coortex-deslop` in advisory mode
      - bounded `$coortex-review` with the same packet
      - touched-unit build/typecheck and configured local quality gates before
        tests
      - targeted tests
      - broader tests only when required by the branch/workflow
    - If the gate finds work, route it back to the same implementation lane.
      Stop only after a full deslop/review/gate pass produces no findings and no
      edits.
11. **Commit only when allowed**
    - If the user asked for commits, make one atomic commit per approved slice.
    - Do not batch unrelated slices.
    - Do not include generated lane, wave, or temporary packet ids in the commit
      subject.

## Conversation-visible progress

Keep a short conversation-visible plan/progress list updated while the workflow
runs.

- Use the conversation `update_plan` tool at the start and after each major
  phase boundary.
- Keep exactly one step `in_progress`.
- Treat progress updates as non-blocking status signals, not approval
  checkpoints.
- Continue without waiting unless the user asked for a pause or the workflow is
  blocked on missing input.

## Default output

Unless the prompt overrides it, report:

## Scope

- packet path or `matrix_not_applicable` reason
- approved slice/write scope

## Implementation

- changed files and owning seam
- handoff summary

## Review

- spec review result
- return review result
- continuation loops, if any

## Verification

- build/typecheck
- local quality gates
- targeted tests
- broader tests, if required

## Residual Risks

- deferred threads or `None`
