# Post-M3 Proposal — Implementation Coordinator And Fixer Specialization

## Status

Proposal draft.

This document describes a **post-Milestone-3** coordinator model for bounded
implementation lanes, paired bounded review, and fixer specialization on top of
that generic implementation engine.

It is intentionally **not** an expansion of Milestone 3. Milestone 3 stays
narrow and linear. This proposal starts from the workflow foundation M3 adds and
extends it into a multi-lane execution model later.

## Why this is a separate proposal

Milestone 3 is explicitly scoped to a narrow workflow layer with one active
workflow run and no multi-worker orchestration:

- M3 introduces a dedicated runtime-owned workflow progress record for **one
  active workflow run** and minimal checkpointed workflow state. See
  `docs/plans/milestone-3-workflow-design.md`.
- M3 out of scope includes:
  - multi-worker orchestration
  - overlapping workflows or barrier semantics
  - generic multi-pass review orchestration, coverage ledgers, closure policy,
    and reusable review packs beyond the minimal `review` and `verify` module
    gates
- M3 completion criteria explicitly say it does **not** require a richer
  workflow UI or multi-worker behavior.

The roadmap also places richer verification/review work after M3:

- `docs/coortex-roadmap.md` Phase 3 delivers workflow modules and workflow-aware
  operator surfaces.
- `docs/coortex-roadmap.md` Phase 5 introduces verification and review policy.

So this coordinator proposal should be treated as **post-M3 implementation
work**, not as a hidden extension of the M3 acceptance target.

## Problem statement

The current review/fix process is too batch-oriented:

- large implementation stretches accumulate too much unchecked code before
  review
- broad review campaigns surface too many families too late
- one-agent fixer runs can drift, add helper sprawl, or fix symptoms in the
  wrong seam before bounded review catches them
- return review happens too late and over too broad a diff to give tight
  confidence

The desired working model is:

1. split implementation into bounded lanes
2. run lanes in parallel only when their write areas do not overlap
3. immediately run a bounded review lane after each implementation lane
4. allow a bounded nth revision cycle for that lane when needed
5. persist all of that in runtime-owned durable state rather than transcript or
   prompt-local policy

The coordinator role in that model should be collaborative, not opaque:

- one coordinator can temporarily steward the run
- bounded worker lanes can propose regrouping, split, reopen, or follow-up
- runtime-owned state should record those proposals and the coordinator's
  accept/reject decisions explicitly
- fresh review or fix work should be able to load relevant prior carry-forward
  state instead of rediscovering it from scratch

## Existing foundation we can build on

The current M3 branch already has the right substrate for a runtime-owned
coordinator:

### 1. Runtime-owned workflow progress

The runtime already persists workflow progress separately from operator summary
state:

- `src/core/types.ts`
  - `WorkflowModuleProgressRecord`
  - `WorkflowProgressRecord`
  - `WorkflowSummary`

### 2. Dedicated workflow events

Workflow state is already event-backed via:

- `workflow.initialized`
- `workflow.artifact.claimed`
- `workflow.gate.recorded`
- `workflow.transition.applied`

See `src/core/events.ts`.

### 3. Workflow module contract

A typed workflow contract already exists under `src/workflows/`:

- `createAssignment(...)`
- `getReadArtifacts(...)`
- `evaluateGate(...)`

See `src/workflows/types.ts`.

### 4. Workflow progression engine

Workflow progression is already runtime-side and driven from durable truth,
including gate persistence and transition emission:

- `src/workflows/progression.ts`
- `src/workflows/progression-rules.ts`
- `src/workflows/progression-transitions.ts`

### 5. Workflow-aware CLI/recovery seam

The current branch already routes `status`, `resume`, `run`, and `inspect`
through the shared workflow-aware load/reconcile seam:

- `src/cli/runtime-state.ts`
- `src/cli/commands.ts`
- `src/cli/ctx.ts`
- `src/recovery/brief.ts`

## Missing primitives

What the current foundation does **not** yet provide is the actual lane model.

### 1. Current workflow state is linear

The current workflow progress record has:

- one `currentModuleId`
- one `currentAssignmentId`
- one `currentModuleAttempt`

That works for the current M3 model, but it is not enough for multiple active
child lanes or parallel execution batches.

### 2. Current transitions are linear

Current workflow transitions are:

- `advance`
- `rewind`
- `rerun_same_module`
- `complete`

There is no fork/join or lane-merge concept yet.

### 3. No generic lane state machine exists

There is no runtime-owned model yet for:

- lane planned
- lane running
- lane awaiting review
- lane needs revision
- lane merged
- lane blocked/deferred

### 4. No overlap/parallelism policy exists in runtime

Nothing yet decides:

- which candidate write sets overlap
- which lanes can run in parallel
- which lanes must serialize
- when paired review should be scheduled automatically

### 5. No lane-level ownership or provenance model exists

The current workflow substrate has assignment/result/decision ownership, but
there is no equivalent runtime-owned identity yet for:

- who currently owns a lane
- which review or plan artifact produced the lane
- which baseline or review scope the lane was derived from
- which agent home or bounded lane thread last acted on it

### 6. No durable review-state companion model exists

There is no runtime-owned record yet for:

- per-lane review outcomes
- family-local closure claims
- carried-forward review context
- proposal/decision history such as split, merge, reopen, or defer

## Core proposal

Introduce a **generic implementation coordinator** in runtime code first.
Treat the **fixer coordinator** as a specialization of that generic engine.

### Base abstraction

#### Implementation coordinator

Owns:

- lane planning
- overlap detection
- lane scheduling
- immediate paired bounded review after each lane
- nth revision / retry loop handling
- merge and completion state
- proposal intake and decision recording
- carry-forward continuity between bounded review/fix cycles once the Stage 3
  continuity model lands

The coordinator should act as a **steward of shared runtime state**, not as an
opaque command issuer. It schedules work, integrates bounded-lane proposals,
resolves conflicts, and records merge or defer decisions in durable state.

#### Implementation lane

A lane is a bounded unit of work with:

- `lane_id`
- `objective`
- `active_seam`
- `candidate_write_set`
- `candidate_test_set`
- `candidate_doc_set`
- `acceptance_criteria`
- `depends_on`
- `parallelizable_with`
- `iteration`
- `state`
- `owner`
- `provenance`

### Fixer as a specialization

A fix lane is an implementation lane plus review-derived metadata:

- `family_ids`
- `closure_gate`
- `likely_owning_seam`
- `secondary_seams`
- review-return interpretation rules

So:

- implementation lane = generic base
- fix lane = implementation lane + family/closure semantics

## Architectural stance

### Runtime owns coordination

The coordinator must live in runtime code, not mainly in skill prompts.

Here, "runtime code" means runtime-owned durable state plus coordination logic
composed through the workflow layer. It does **not** mean moving workflow policy
into `core` or creating a second policy engine that bypasses `src/workflows/`.

The runtime should own:

- lane state
- sequencing
- overlap policy
- paired review scheduling
- retry/elevation limits
- merge decisions
- durable recovery/resume of in-flight coordination
- proposal and decision history
- carry-forward review continuity once cross-run continuity moves into runtime in
  Stage 3

The intended layering is:

- runtime-owned records and events hold coordinator truth
- persistence and projections recover and summarize that truth
- workflow code under `src/workflows/` owns coordinator progression and
  sequencing policy
- CLI/recovery surfaces invoke that shared policy rather than reimplementing it

### Skills stay thin

Skills should remain thin invocation and execution surfaces:

- one bounded implementation lane prompt
- one bounded review lane prompt
- an optional bounded analysis lane prompt in a later extension, not in the
  first coordinator milestone

They should **not** own:

- lane planning
- retry policy
- cross-lane merge rules
- durable thread progression

### Scripts remain useful, but only for deterministic helper work

Scripts can still be used for:

- schema validation
- lane-plan serialization helpers
- overlap matrix helpers
- seam/family summarization
- trace normalization

But the main control loop should not stay as an ever-growing script-only
workflow engine.

## Proposed runtime model

### 1. Add lane records

Add a runtime-owned lane record family, separate from the current linear
workflow progress record.

Illustrative shape:

```ts
interface CoordinationLaneRecord {
  laneId: string;
  parentWorkflowId: string;
  laneType: "implementation" | "review" | "analysis";
  specialization?: "feature" | "fix";
  ownerType: "runtime" | "workflow" | "agent" | "worker";
  ownerId: string;
  activeSeam: string | null;
  secondarySeams: string[];
  objective: string;
  assignmentId: string | null;
  sourceArtifactId: string | null;
  sourceArtifactKind:
    | "work-plan"
    | "review_handoff"
    | "review_return_handoff"
    | "coordinator_decision"
    | null;
  baselineRef: {
    baselinePath: string | null;
    baselineHash: string | null;
    variantId: string | null;
  } | null;
  reviewTargetFingerprint: string | null;
  candidateWriteSet: string[];
  candidateTestSet: string[];
  candidateDocSet: string[];
  acceptanceCriteria: string[];
  dependsOnLaneIds: string[];
  parallelizableWithLaneIds: string[];
  iteration: number;
  state:
    | "planned"
    | "running"
    | "awaiting_review"
    | "needs_revision"
    | "merged"
    | "blocked"
    | "deferred"
    | "cancelled";
}
```

### 2. Add lane events

Illustrative event family:

- `workflow.lane.planned`
- `workflow.lane.started`
- `workflow.lane.completed`
- `workflow.lane.review.requested`
- `workflow.lane.review.recorded`
- `workflow.lane.revision.requested`
- `workflow.lane.merged`
- `workflow.lane.blocked`
- `workflow.lane.deferred`

These should remain additive to the existing assignment/result/decision event
model, not a replacement for it.

### 3. Add review-state companion records

Add runtime-owned review-side records so paired bounded review does not live
only inside skills, traces, or handoff artifacts.

Illustrative shape:

```ts
interface CoordinationReviewRecord {
  reviewId: string;
  laneId: string;
  parentWorkflowId: string;
  reviewerAssignmentId: string | null;
  baselineRef: {
    baselinePath: string | null;
    baselineHash: string | null;
    variantId: string | null;
  } | null;
  status: "passed" | "failed" | "partial" | "blocked";
  familyIds: string[];
  likelyOwningSeam: string | null;
  secondarySeams: string[];
  closureGateRefs: string[];
  seamSummaryRef: string | null;
  closureClaims: Array<{
    familyId: string;
    status: "confirmed" | "rejected" | "partial" | "unverified";
  }>;
  carryForwardFamilyIds: string[];
}

interface CoordinationProposalRecord {
  proposalId: string;
  laneId: string;
  sourceReviewId: string | null;
  kind:
    | "split_lane"
    | "merge_lanes"
    | "reopen_family"
    | "defer_lane"
    | "change_owner"
    | "request_followup_review";
  rationale: string;
  proposedByOwnerId: string;
  state: "pending" | "accepted" | "rejected" | "superseded";
  decidedByOwnerId: string | null;
}
```

These records should be enough to support:

- lane-local return review
- explicit coordinator decisions instead of implicit regrouping
- future consumption by operator surfaces without parsing transcript text

In the first coordinator slice, these records are **recording primitives only**.
They may carry continuity-shaped data such as family ids or carried-forward
references, but they must not yet drive cross-run planning or fresh-lane
selection on their own.

The review record intentionally carries enough normalized seam and closure-gate
linkage to support later fixer batching without forcing Stage 4 to recover those
semantics only from raw handoff files.

### 4. Add a coordinator summary projection

Add a derived coordinator summary that can answer:

- which lanes are active
- which are waiting on review
- which are blocked by overlap or dependency
- which have completed and merged
- whether the coordinator is in discovery, execution, review, or finalization

The coordinator summary should be rebuilt from authoritative lane records,
review records, proposal records, assignments, and events. It should not become
an independent mutable source of truth for lane state.

If a small persisted coordinator config record is needed, keep it limited to
parent workflow linkage and coordinator policy such as retry caps or merge
policy. Do not duplicate lane truth inside it.

### 5. Keep one parent workflow, but allow child lanes

To avoid overshooting into a full DAG engine immediately:

- keep one parent workflow run authoritative
- allow that workflow to plan child lanes
- require explicit join points before parent progression advances

That gives us bounded fork/join without needing a full overlapping-workflow
system on day one.

## Review model

### Immediate paired review

Every implementation lane should be followed immediately by a bounded review
lane.

That review lane should inspect:

- the lane diff
- the lane acceptance criteria
- seam placement / ownership discipline
- obvious sibling-path risk inside the bounded seam
- whether the lane should be split, merged with a sibling lane, or deferred

### Review lanes can propose, not only judge

Bounded review should be able to emit machine-readable proposals such as:

- split this lane into two narrower follow-up lanes
- merge this lane with another overlapping lane
- reopen one family under a broader seam-level contract
- defer the lane pending a prerequisite
- reroute follow-up to a different owner

The coordinator should record accepted or rejected proposals explicitly in
runtime state rather than silently reshaping the plan.

### Bounded nth revision loop

If review fails:

- the same lane thread can re-enter a bounded revision cycle
- but iteration count must be explicit and capped

Illustrative policy:

- lane implementation
- lane review
- if failed: one or two bounded revisions
- if still failing: escalate, split, or defer

This avoids both giant review campaigns and infinite micro-loops.

## Fixer specialization model

The fixer coordinator consumes review output, but does not replace the generic
implementer engine.

### Review output should provide

- families
- likely owning seam
- optional secondary seams
- seam summary / hot seams
- closure gates

### Fixer specialization then does

- transform review families into fix lanes
- batch only when seam ownership and write overlap say it is safe
- keep family ids as the closure unit
- keep seam as the batching and ownership unit
- preserve carry-forward context and explicit coordinator decisions
- keep one implementer lane attached to one active family/slice until the
  reviewer approves closure or a genuine blocker makes the lane terminal
- send repair results through targeted return review before declaring closure
- if return review keeps the family actionable, address that follow-up back to
  the same implementer lane rather than respawning a new worker by default
- let the coordinator commit only after reviewer approval
- preserve lane/family identity metadata so the worker can prove that a
  continuation payload still belongs to the same original lane
- record per-family return-review round counts in the lane or family closeout
  trace so churn is visible without reconstructing it from prose

Stage 4 may still consume `review_handoff` as a source artifact when richer
family detail is needed, but the runtime review records should already contain
the normalized owning-seam and closure-gate linkage needed for batching and
closure tracking.

So:

- family = what is wrong
- seam = where repair is organized
- lane = bounded execution unit

## Recommended implementation order

### Stage 1 — Runtime lane and review-state primitives

Add:

- lane record types
- lane events
- review record types
- proposal/decision record types
- lane projection/rebuild support
- lane summary helpers for operator surfaces

Boundary rule:

- Stage 1 is about introducing the persistence and replay primitives
- Stage 1 is not yet about using prior-run review memory to steer fresh work
- Stage 1 may record review outcomes, closure claims, and carry-forward-shaped
  references
- Stage 1 must not yet consume prior review memory to plan or reshape fresh
  lanes
- Stage 1 must stay same-run and replay-focused, not continuity-driven

Acceptance target:

- the runtime can persist, replay, and inspect lane and review state
  deterministically
- coordinator summary is derived from lane/review/proposal truth, not stored as
  an independent second truth source
- no fresh lane planning depends on prior-run carry-forward state yet

### Stage 2 — Generic implementation coordinator

Add:

- lane planning from a bounded work plan
- overlap detection and sequencing
- paired review scheduling
- iteration state and capped retry handling
- explicit proposal intake and coordinator decision recording

Boundary rule:

- Stage 2 may use current-run lane, review, and proposal state
- Stage 2 must not yet load prior-run open families, baseline matches, or
  carry-forward hints to shape the plan

Acceptance target:

- one bounded feature implementation can be executed through lane -> review ->
  revision -> merge without transcript-owned coordination
- one bounded review lane can propose split/merge/defer actions and the runtime
  can replay the accepted or rejected decision history

### Stage 3 — Review continuity and carry-forward

Add:

- carry-forward/open-family linkage between review cycles
- baseline provenance and review-target fingerprint persistence
- lane-local return-review consumption of prior open review state as hints

This is the first stage where previously recorded review continuity data becomes
an active planning or hint input for later bounded work.

Acceptance target:

- a fresh bounded review or fix lane can load relevant prior carry-forward state
  without treating artifacts or transcript text as truth

### Stage 4 — Fixer specialization

Add:

- transform `review_handoff` families into fix lanes
- use seam summary / owning seam to batch safely
- map review results back to family closure status
- preserve family ledger / reopen behavior
- keep each active family or repair slice bound to one implementer lane until
  that lane reaches a terminal state
- keep paired targeted return review as the closure authority instead of
  letting the fixer coordinator self-certify family closure
- route actionable return-review follow-up back to the same implementer lane by
  default instead of spawning a fresh worker for the same family
- let the coordinator commit only after reviewer approval
- keep enough lane/family identity metadata for the same worker to verify that
  a continuation payload still belongs to its original family lane
- record per-family return-review send-back counts so closure traces show how
  many rework rounds each family needed before it closed

Dependency note:

Stage 4 assumes a richer review artifact contract than the minimal Milestone 3
`review` and `verify` module outputs. The current M3 workflow modules only prove
basic verdict and evidence-gate semantics. Fixer specialization therefore
depends on a post-M3 review-policy expansion or a richer review workflow surface
that can supply family, seam, and closure-gate data without making those
artifacts the source of durable truth.

Acceptance target:

- one bounded review handoff can be repaired through multiple lane-local
  fix/review cycles with family-level closure tracking preserved
- the same implementer lane can carry one family through repeated
  fix/return-review loops without losing lane-local context
- closure traces preserve per-family return-review round counts and lane
  identity continuity through those loops

### Stage 5 — Optional parallel execution hardening

Add:

- stricter overlap heuristics
- better merge-barrier handling
- improved operator visibility for queued/blocked lane batches

Acceptance target:

- disjoint lanes can run in parallel without overlap-induced corruption

## Constraints and non-goals

### Non-goals for the first coordinator milestone

- full arbitrary DAG workflow authoring
- generic overlapping workflows across several parents
- transcript-driven coordination
- skill-pack-owned orchestration as the primary source of truth
- rich new TUI/approval UI
- generalized multi-agent policy unrelated to bounded implementation/review
- fully symmetric peer-to-peer negotiation without a temporary coordinator role
- analysis-lane orchestration beyond reserving the type and prompt slot for a
  later extension

### Key design constraints

1. Runtime remains authoritative.
2. Lanes are durable runtime state, not prompt-local convenience state.
3. Paired review is part of the coordinator model, not an afterthought.
4. Fixer must remain a specialization of implementer, not a separate engine.
5. Families remain the canonical closure unit where review/fix is involved.
6. Seams guide ownership, batching, and escalation, not closure identity.
7. Coordinator summaries remain derived unless a narrow config record is
   strictly necessary.
8. Lane, review, and proposal records must carry enough provenance to explain
   who acted, from which baseline, and from which source artifact.
9. Coordinator decisions must be explicit and durable when they reshape bounded
   work.

## Risks

### 1. Silent M3 expansion

Risk:
trying to sneak lane coordination into M3 and never closing the milestone.

Mitigation:
keep this explicitly post-M3 and do not mutate the M3 completion criteria.

### 2. Building a second engine in scripts first

Risk:
recreating the same coordination logic in skill-pack scripts and then migrating
it later.

Mitigation:
put the core lane state machine in runtime code first; reserve scripts for
helper transforms only.

### 3. Over-designing toward a full DAG system too early

Risk:
spending too long on generic orchestration machinery before the first useful
implementation loop works.

Mitigation:
start with one parent workflow plus bounded child lanes and explicit join
points.

### 4. Endless lane-local churn

Risk:
immediate paired review could still loop forever.

Mitigation:
make iteration count durable and capped; force escalate/split/defer after the
cap.

### 5. Accidental second source of truth

Risk:
adding a mutable coordinator record that duplicates lane or review state and
then drifts from the underlying events.

Mitigation:
derive coordinator summaries from lane/review/proposal records and keep any
persisted coordinator record limited to narrow policy/config data.

### 6. Review memory staying trapped in artifacts

Risk:
paired review still depends on handoff files and transcript-local reasoning, so
fresh bounded reviews cannot build on prior outcomes cleanly.

Mitigation:
persist carry-forward families, baseline provenance, and proposal/decision
history as runtime-owned records before expanding coordinator breadth.

## Verification targets

This proposal should be considered implemented only when tests prove at least:

1. runtime lane records replay and snapshot correctly
2. coordinator state survives interruption and resume
3. bounded implementation lanes schedule paired bounded review lanes
4. coordinator summaries rebuild from lane/review/proposal truth without
   divergence
5. lane-local revision loops are capped and deterministic
6. disjoint lanes can be marked parallelizable while overlapping lanes cannot
7. review lanes can emit explicit proposals and the accepted/rejected decision
   history replays correctly
8. fixer specialization preserves family identity while batching by seam
9. operator surfaces can explain the current coordinator/lane state without a
   separate ad hoc transcript
10. fresh bounded review/fix work can load relevant carry-forward state and
    baseline provenance from runtime-owned records

## Recommendation

Finish M3 as currently scoped.

Then start a new milestone or post-M3 phase for a **runtime-owned implementation
coordinator**, with the **fixer coordinator implemented as a specialization of
that base engine**.

This keeps the architecture aligned with the project’s runtime-first direction,
avoids growing a second long-term coordinator in skill-pack scripts, and gives
Coortex a reusable bounded-work execution model for both feature development and
review-driven repair.
