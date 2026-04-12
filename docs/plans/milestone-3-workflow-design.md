# Milestone 3 — Workflow Modules

## Status

Active planning document.

Milestone 1 and Milestone 2 are complete. The next implementation
milestone is the first real workflow layer above the runtime and host
adapter surfaces.

## Objective

Move sequencing policy into explicit workflow modules while keeping
truth in the runtime.

Milestone 3 should introduce the smallest useful workflow system that:

- defines a typed workflow layer in `src/workflows/`
- keeps workflow progress runtime-owned and blocker handling grounded in
  durable runtime truth
- works on top of the existing single-reference-host path
- establishes `plan`, `review`, and `verify` as real workflow modules
  with distinct gate semantics
- reuses the existing operator surfaces rather than adding a richer
  workflow UX

## Scope

### In scope

- a typed workflow-module contract under `src/workflows/`
- a built-in default workflow sequence for Milestone 3
- built-in workflow modules for:
  - `plan`
  - `review`
  - `verify`
- a small registry for built-in workflow modules
- a dedicated runtime-owned workflow progress record for one active
  workflow run
- minimal checkpointed workflow state sufficient to know:
  - active workflow id
  - ordered module ids
  - current module id
  - per-module state
  - last durable advancement
- command-surface visibility for the active workflow module in:
  - `ctx status`
  - `ctx resume`
  - `ctx inspect`
- command-surface semantics for `ctx run` under workflow control without
  adding a new top-level workflow command
- advancement rules that depend on runtime-owned durable truth:
  assignments, results, decisions, runtime status, and workflow
  progress
- Milestone 3 uses `blocked` as the only persisted wait state
  for workflow gates; a distinct workflow-level `pending_input` state
  stays deferred until approval or HITL work exists
- deterministic tests proving that workflow modules affect assignment
  emission and module progression

### Out of scope

- multi-worker orchestration
- overlapping workflows or barrier semantics
- repo-artifact or markdown-backed workflow truth
- raw hook-driven or transcript-driven workflow progression
- host-specific delegation rules, named-agent casts, tmux or worktree
  semantics
- rich workflow UX beyond the existing `status`, `resume`, and
  `inspect` surfaces
- new top-level workflow commands unless implementation evidence proves
  one is strictly required
- approval/HITL loops and explicit operator-intervention choreography
- generic multi-pass review orchestration, coverage ledgers, closure
  policy, and reusable review packs beyond the minimal `review` and
  `verify` module gates
- full verification requirement models, durable evidence storage,
  waivers, and richer completion governance
- declarative workflow authoring or workflow-as-agent exposure across
  host boundaries

## Design constraints

Milestone 3 must preserve these architectural rules:

1. The runtime remains authoritative.
   Workflow modules define policy while durable
   assignment/result/decision state stays runtime-owned.

2. Workflow modules define sequencing, not execution.
   Host adapters still execute work. Workflows only shape what should
   happen next and what counts as enough evidence to advance.

3. Workflow progression is driven by durable truth.
   Transitions must be based on persisted assignment, result, decision,
   runtime-status, and workflow-progress state, not in-memory controller
   assumptions.

4. Workflow logic consumes normalized runtime state, not adapter
   internals.
   Progression must not depend on transcript inspection, repo sidecars,
   or raw adapter or hook behavior.

5. Runtime summary state is not workflow truth.
   `RuntimeStatus` remains an operator-facing summary. Workflow progress
   must live in a dedicated runtime-owned record rather than being
   inferred only from `RuntimeStatus` or assignment labels.

6. Minimal checkpoint state should be persisted.
   Milestone 3 should persist only the state needed to recover the
   current module and its gate conditions. Blocking reason should be
   derived from durable assignment, decision, and workflow state rather
   than persisted as separate workflow truth. The next eligible module
   should be derived from the registry plus durable runtime truth rather
   than stored redundantly.

7. The first workflow system stays narrow.
   Milestone 3 proves the model with one built-in sequence and a small
   set of modules.

## Proposed implementation slice

The sections below intentionally keep more detail than a lightweight
milestone sketch so the implementer does not have to rediscover the same
workflow design constraints. Where they describe exact helper names,
local decomposition, or illustrative string templates, treat them as
one valid implementation unless the surrounding bullets make them part
of the selected milestone contract.

### 1. Workflow contract and registry

Add a small workflow contract that can answer:

- what module is this
- how does it shape or emit the assignment for this workflow run
- what durable evidence and completion predicate mark it complete
- what module becomes eligible next after success, blocker, or failure
- what operator-facing summary should be surfaced for the current module
- what workflow-progress event is emitted when a module gate is
  evaluated

Milestone 3 should reevaluate workflow progression at two checkpoints:
immediately after durable host outcome persistence and immediately after
loading durable state that includes workflow-affecting events such as
`decision.resolved`. For Milestone 3, that second checkpoint consumes
externally persisted `decision.resolved` events from durable state; it
does not require a new interactive resolver command or approval surface.

Load-time workflow reevaluation must be idempotent. Repeated
`status`/`resume`/`inspect` calls against already-converged durable
state must append no new workflow-progress events, create no duplicate
queued assignments, and surface no repeated reconciliation diagnostic
after the first successful convergence. The workflow progression surface
should append events only when durable state is missing a required gate
record, current-module assignment, or workflow-progress transition that
is strictly implied by the current event log.

Likely change areas:

- `src/workflows/`
- `src/core/types.ts`
- `src/core/events.ts`
- `src/core/runtime.ts`
- `src/cli/commands.ts`
- `src/cli/ctx.ts`
- `src/cli/runtime-state.ts`
- `src/projections/runtime-projection.ts`
- `src/recovery/brief.ts`
- `src/recovery/host-runs.ts`
- `src/cli/run-operations.ts`
- `src/adapters/contract.ts`
- `src/adapters/host-run-store.ts`
- `src/persistence/store.ts`
- `src/hosts/codex/adapter/index.ts`
- `src/hosts/codex/adapter/envelope.ts`
- `src/hosts/codex/adapter/prompt.ts`
- `src/hosts/codex/adapter/execution.ts`

One valid invocation model for Milestone 3:

- bootstrap workflow selection:
  - `src/cli/commands.ts` in `initRuntime`
  - `src/core/runtime.ts` in `createBootstrapRuntime`
- shared workflow-aware load/reconcile seam:
  - the authoritative workflow progression engine should live under
    `src/workflows/`
  - that engine should expose one authoritative progression surface; one
    valid shape is an evaluator such as
    `evaluateWorkflowProgression(projection, clock)` that returns only:
    pending additive workflow events, serialized runtime-event intents
    for `assignment.created`, `assignment.updated`, and
    `status.updated`, and derived workflow summary data from normalized
    runtime truth
  - `src/workflows/` should own the module policy and progression logic
    used by that engine:
    gate evaluation, transition selection, assignment shaping, and
    workflow-summary derivation
  - `core` must not import `src/workflows/`; if a reusable generic
    helper is extracted into `core` later, it must stay policy-agnostic
    and accept workflow policy through injection from `workflows` via
    CLI composition rather than direct `core -> workflows` imports
  - `src/cli/runtime-state.ts` should become the authoritative command
    entrypoint for workflow-aware loading and export
    `loadWorkflowAwareProjectionWithDiagnostics(store, adapter)` plus a
    thin `loadWorkflowAwareProjection(store, adapter)` wrapper
  - that CLI seam should load projections, invoke the workflow
    progression evaluator from `src/workflows/`, append any returned
    events through the existing persistence store path, and reload the
    projection; it should not own workflow policy
  - existing reconciliation logic in `src/cli/run-operations.ts` should
    move behind that exported surface rather than remaining a separate
    competing entrypoint
  - `src/cli/ctx.ts` for `status`, `resume`, and `inspect` should read
    through that seam before formatting output
  - `src/cli/commands.ts` for `resumeRuntime` and `runRuntime` should
    read through that seam before envelope building or runnable
    selection
  - that exported surface should own convergence checks so repeated load
    calls do not duplicate workflow events, assignments, or stale-run
    diagnostics
  - loader invariants for that seam should be:
    - start from `store.loadProjectionWithRecovery()`
    - incorporate stale-run reconciliation before workflow progression
    - for workflow-controlled runtimes, treat reconciliation output as
      stale-run facts plus diagnostics, not as final assignment or
      status mutations
    - apply workflow progression against the reconciled durable truth
    - persist any workflow-driven mutations, reload, and converge
      without duplicating events or rerunning host-run reconciliation in
      a competing second pass
    - return the converged projection plus accumulated diagnostics
- post-outcome workflow reevaluation:
  - `src/cli/commands.ts` in `runRuntime` after outcome events are
    appended and snapshot sync completes, using the same workflow
    progression surface that the shared load/reconcile seam applies
- stale-run reconciliation:
  - `src/recovery/host-runs.ts` and adapter `reconcileStaleRun` paths
    should feed the same workflow progression surface
  - `buildStaleRunReconciliation()` may remain the direct event-emitting
    path only for pre-workflow baseline runtimes that have no
    `workflowProgress`
  - for workflow-controlled runtimes, `src/recovery/host-runs.ts`
    should stop authoring final `assignment.updated`,
    `status.updated`, or workflow events directly and should instead
    return stale-run facts plus diagnostics to the shared workflow-aware
    load/reconcile seam
  - for workflow-controlled runtimes, stale recovery should requeue only
    the current-module assignment, preserve `workflowCycle` and
    `currentModuleId`, and avoid restoring the pre-workflow baseline
    multi-active selection behavior
- operator-facing command output:
  - `src/cli/ctx.ts` for `status`, `resume`, `run`, and `inspect`
- workflow-aware resume-envelope shaping:
  - `src/hosts/codex/adapter/index.ts` in `buildResumeEnvelope`
  - `src/hosts/codex/adapter/envelope.ts` in `buildTaskEnvelope`
- inspect target selection:
  - `src/cli/ctx.ts` should resolve inspection targets in this order:
    explicit assignment id, current workflow assignment from the shared
    load/reconcile seam, last recorded host run from
    `src/adapters/host-run-store.ts`, then exit 1

Expected result:

- a typed workflow definition surface
- a registry for built-in modules
- bootstrap support for a built-in default workflow sequence
- dedicated workflow-progress events rather than relying on
  `status.updated` as workflow truth
- no declarative workflow-authoring surface yet

Illustrative module-contract responsibilities for Milestone 3:

- `moduleId`
  - stable identifier for the built-in module
- assignment shaping or emission
  - shapes the current module assignment from workflow progress and
    runtime state
- gate evaluation
  - evaluates durable runtime truth and returns the module gate outcome,
    evidence summary, and referenced result or decision ids
- next-module resolution
  - resolves whether the workflow advances, rewinds, stays on the same
    module, or completes
- operator-summary shaping
  - provides the workflow or module summary fields surfaced through
    `ctx status`, `ctx resume`, and `ctx inspect`

### 2. Built-in `plan`, `review`, and `verify` modules

Implement three built-in modules with deterministic policy:

- `plan`
  - shapes planning-oriented assignments and outputs
  - defines the minimum durable outputs and evidence summary required
    before downstream advancement
  - does not advance on a generic completed result if required planning
    outputs are missing
- `review`
  - evaluates durable outputs from the immediately preceding module
  - can approve progression, block advancement, or require iteration
    using durable runtime state
  - remains a narrow workflow gate, not a full reviewer choreography
    system
- `verify`
  - evaluates fresh durable evidence and unresolved-decision state
  - does not advance on controller confidence, transcript sentiment, or
    stale evidence
  - on failure, rewinds only to `review` rather than resetting the
    broader workflow

These modules need to define:

- assignment objective templates
- required outputs
- expected evidence summary
- durable transition criteria
- how decisions/blockers affect progression

Minimal durable gate model for Milestone 3:

- raw worker output remains durable in `ResultPacket` and
  `DecisionPacket`
- Milestone 3 should not extend normalized `ResultPacket` or
  `DecisionPacket` with module-specific gate fields
- instead, gate payloads should live in a runtime-owned workflow gate
  record that is persisted through workflow-progress events and stored in
  workflow progress state
- gate payloads should be derived runtime-side from normalized result
  packets, decision packets, workflow progress, and optional artifact
  references; Milestone 3 should not require module-aware adapter output
  fields
- module gate evaluation becomes a separate durable workflow-progress
  update, not an overloaded `ResultPacket.status`
- minimum workflow gate record shape for Milestone 3:
  - `moduleId`
  - `assignmentId`
  - `workflowCycle`
  - `gateOutcome`
  - `sourceResultIds`
  - `sourceDecisionIds`
  - `evidenceSummary`
  - `checklistStatus` when the module requires checklist evaluation
  - `artifactReferences` for optional external evidence detail
  - `enteredAt`
  - `evaluatedAt`
- each module state entry in workflow progress should persist:
  - current or last assignment id
  - module state
  - gate outcome
  - source result ids and source decision ids used by the gate
  - evidence summary
  - entered-at and evaluated-at timestamps
- the event log should persist workflow-progress changes through
  dedicated workflow events rather than only through assignment or status
  updates

Milestone 3 durable workflow event model is:

- `workflow.initialized`
  - payload:
    - `workflowId`
    - `orderedModuleIds`
    - `currentModuleId`
    - `workflowCycle`
    - `currentModuleAttempt`
    - `currentAssignmentId`
    - `initializedAt`
  - replay rule:
    - initializes workflow progress once for the runtime session
- `workflow.artifact.claimed`
  - payload:
    - `workflowId`
    - `workflowCycle`
    - `moduleId`
    - `moduleAttempt`
    - `assignmentId`
    - `artifactPath`
    - `artifactFormat`
    - `artifactDigest`
    - `sourceResultId`
    - `claimedAt`
  - replay rule:
    - attaches one claimed current-module artifact to the module state
    - load-time convergence must not append a second claim when the same
      `assignmentId`, `sourceResultId`, and `artifactDigest` are already
      durable
    - `artifactPath` in durable workflow events should remain store-relative,
      for example `runtime/workflows/...`
- `workflow.gate.recorded`
  - payload:
    - `workflowId`
    - `workflowCycle`
    - `moduleId`
    - `moduleAttempt`
    - `assignmentId`
    - `moduleState`
    - `gateOutcome`
    - `checklistStatus`
    - `evidenceSummary`
    - `sourceResultIds`
    - `sourceDecisionIds`
    - `artifactReferences`
    - `evaluatedAt`
  - replay rule:
    - updates the gate record for that module and cycle
    - later events for the same `workflowId`, `workflowCycle`,
      `moduleId`, `moduleAttempt`, and `assignmentId` replace earlier
      gate detail
- `workflow.transition.applied`
  - payload:
    - `workflowId`
    - `fromModuleId`
    - `toModuleId`
    - `workflowCycle`
    - `moduleAttempt`
    - `transition`
    - `previousAssignmentId`
    - `nextAssignmentId`
    - `appliedAt`
  - replay rule:
    - updates current module, cycle, and active-assignment linkage
    - `moduleAttempt` is the destination attempt count for `toModuleId`
    - `rerun_same_module` is the only transition where
      `fromModuleId === toModuleId` and
      `previousAssignmentId === nextAssignmentId`
    - load-time convergence must not append a second transition when
      runtime state already reflects the same `transition`,
      `nextAssignmentId`, `workflowCycle`, and `moduleAttempt`

Workflow event idempotence rule for Milestone 3:

- one durable host outcome may cause at most one missing
  `workflow.artifact.claimed`, one missing `workflow.gate.recorded`, and
  one missing `workflow.transition.applied` event during convergence
- same-module reruns stay representable because each
  `rerun_same_module` transition increments `moduleAttempt` even when
  the assignment id and workflow cycle stay the same
- repeated `status`, `resume`, `inspect`, or replay after convergence
  must observe the existing workflow event chain and append nothing

Recovery-proof rule for reused assignment ids:

- workflow-controlled recovery and dedupe must key consumed terminal
  outcomes by `(assignmentId, moduleAttempt)`, not by `assignmentId`
  alone
- `workflow.transition.applied.appliedAt` marks the start boundary for
  the destination attempt named by `moduleAttempt`
- a terminal `result.submitted` or `decision.created` belongs to the
  latest attempt whose start boundary is less than or equal to the
  terminal outcome timestamp
- a later same-assignment terminal outcome after `rerun_same_module`
  must be treated as new work when it belongs to a higher
  `moduleAttempt`, even if the workflow cycle and assignment id stay the
  same

Ordering constraints for Milestone 3:

- recovered host outcomes must be appended before any workflow event
  derived from them
- when a module artifact is claimed for a gate evaluation,
  `workflow.artifact.claimed` must precede the corresponding
  `workflow.gate.recorded`
- when workflow progression changes the active assignment or module,
  the assignment mutation must be durable before the corresponding
  `workflow.transition.applied`
- `workflow.transition.applied.moduleAttempt` names the destination
  attempt count for the resulting module state
- `status.updated` should be derived last from the already-persisted
  assignment and workflow state for that transition

Milestone 3 `moduleState` vocabulary should stay narrow and derive from
durable runtime truth rather than duplicating gate verdicts:

- legal values:
  - `queued`
  - `in_progress`
  - `blocked`
  - `completed`
- derivation rules:
  - `queued`: the current module assignment is `queued`, no open
    decision exists for that module attempt, and no durable workflow
    transition has consumed that attempt
  - `in_progress`: the current module assignment is `in_progress` and no
    open decision exists for that module attempt
  - `blocked`: an open decision exists for that module attempt or the
    current assignment is durably `blocked`
  - `completed`: a durable workflow transition has consumed that module
    attempt, or the workflow has completed after `verify -> verified`
- `gateOutcome` remains the place for verdicts such as
  `ready_for_review`, `approved`, `needs_iteration`, `rejected`,
  `verified`, or `failed`; `moduleState` does not add separate verdict
  values for those outcomes
- after convergence, same-module reruns should surface as `queued` or
  `blocked`, not as a separate public `moduleState`

Milestone 3 gate inputs and outputs should be:

- `plan`
  - inputs: current module assignment, completed result packet from that
    assignment, any open decisions on that assignment
  - gate output: `ready_for_review` or `blocked`
  - durable output fields: source result id, evidence summary, required
    output checklist status
- `review`
  - inputs: latest accepted `plan` output for the current cycle,
    completed result packet from the current `review` assignment, any
    open decisions on that assignment
  - gate output: `approved`, `rejected`, `needs_iteration`, or `blocked`
  - durable output fields: verdict, rationale summary, source result id
- `verify`
  - inputs: latest approved `review` output for the current cycle,
    completed result packet from the current `verify` assignment,
    referenced evidence result ids, any open decisions on that
    assignment
  - gate output: `verified`, `failed`, or `blocked`
  - durable output fields: verdict, evidence summary, referenced
    evidence result ids, freshness check timestamp

Built-in gate derivation rules for Milestone 3:

- built-in modules should not derive gate verdicts from free-form
  transcript text alone
- each built-in module should require one runtime-owned module artifact
  reference in its gate record, with a deterministic path scoped by
  `workflowId`, `workflowCycle`, `moduleId`, and `assignmentId`
- allowed durable inputs for gate evaluation are:
  - the current assignment record
  - the latest terminal `ResultPacket` for that assignment
  - any `DecisionPacket` values for that assignment
  - prior workflow gate records from the current or earlier cycles
  - the runtime-owned module artifact referenced by the gate record
- no gate field should be derived from raw host transcript, temporary
  adapter files, or mutable workspace files outside a claimed artifact
  reference

Current-module artifact write and claim contract for Milestone 3:

- each active workflow module should receive one runtime-owned writable
  output target via the additive `TaskEnvelope.workflow.outputArtifact`
  field
- the deterministic artifact path pattern is:
  `runtime/workflows/<workflowId>/cycles/<workflowCycle>/<moduleId>/<assignmentId>/attempt-<moduleAttempt>.json`
- on the adapter-facing envelope surface, `workflow.outputArtifact` and
  `workflow.readArtifacts` should use project-relative `.coortex/...`
  paths, for example
  `.coortex/runtime/workflows/<workflowId>/cycles/<workflowCycle>/<moduleId>/<assignmentId>/attempt-<moduleAttempt>.json`
- the artifact format should be JSON with:
  - `workflowId`
  - `workflowCycle`
  - `moduleId`
  - `moduleAttempt`
  - `assignmentId`
  - `createdAt`
  - `payload`
- the active module learns its output target from
  `workflow.outputArtifact`; the assignment objective may restate it,
  but the path is runtime-owned data, not inferred from prompt text
- the worker writes the artifact to that target during assignment
  execution
- after the host outcome is durably appended through `result.submitted`,
  the shared workflow progression surface validates the artifact at the
  expected path and claims it into durable truth by appending
  `workflow.artifact.claimed`
- only claimed module artifacts may feed gate evaluation; unclaimed or
  malformed files do not change workflow truth
- Milestone 3 does not claim module artifacts from `decision` outcomes;
  blockers are still represented by `DecisionPacket` plus gate or
  transition events

Per-module derivation contract:

- `plan`
  - required module artifact fields:
    - `planSummary`
    - `implementationSteps`
    - `reviewEvidenceSummary`
  - `checklistStatus` source:
    - derived by comparing the emitted `Assignment.requiredOutputs`
      tokens against the presence of the required module artifact fields
  - `evidenceSummary` source:
    - `reviewEvidenceSummary` from the module artifact
  - `artifactReferences` source:
    - the claimed module artifact path plus any runtime-owned artifacts
      explicitly referenced from that artifact
  - pass rule:
    - latest result is `completed`, no open decision exists, and all
      required module artifact fields are present and non-empty
  - fail or stay rule:
    - missing artifact, invalid artifact, failed result, or incomplete
      checklist prevents advancement and applies
      `rerun_same_module`, reusing the current `plan` assignment id,
      incrementing `moduleAttempt`, and returning that assignment to
      `queued` in the same cycle
- `review`
  - required module artifact fields:
    - `verdict`
    - `rationaleSummary`
  - `checklistStatus` source:
    - `complete` only when both fields are present and `verdict` is one
      of `approved`, `rejected`, or `needs_iteration`
  - `evidenceSummary` source:
    - `rationaleSummary` from the module artifact
  - `artifactReferences` source:
    - the claimed module artifact path plus the prior accepted `plan`
      artifact reference for the same cycle
  - pass rule:
    - latest result is `completed`, no open decision exists, and the
      artifact verdict maps directly to the gate outcome
  - fail or stay rule:
    - missing artifact, invalid verdict, or failed result applies
      `rerun_same_module`, reusing the current `review` assignment id,
      incrementing `moduleAttempt`, and returning that assignment to
      `queued` in the same cycle
- `verify`
  - required module artifact fields:
    - `verdict`
    - `verificationSummary`
    - `evidenceResultIds`
  - `checklistStatus` source:
    - `complete` only when all fields are present and every
      `evidenceResultId` resolves to a durable `ResultPacket`
  - `evidenceSummary` source:
    - `verificationSummary` from the module artifact
  - `artifactReferences` source:
    - the claimed module artifact path plus any runtime-owned evidence
      artifacts referenced from it
  - pass rule:
    - latest result is `completed`, no open decision exists, verdict is
      `verified`, and every referenced evidence result id was produced
      in the current `workflowCycle`
  - fail or stay rule:
    - verdict `failed` rewinds to `review`; missing artifact, invalid
      verdict, unresolved evidence ids, or stale evidence applies
      `rerun_same_module`, reusing the current `verify` assignment id,
      incrementing `moduleAttempt`, and returning that assignment to
      `queued` in the same cycle

For Milestone 3, "fresh" evidence means the verify gate references only
durable result packets produced in the current workflow cycle after the
most recent rewind into `review` or `verify`. Evidence from an earlier
rejected or failed cycle does not satisfy `verify`.

Workflow-cycle rules for Milestone 3:

- bootstrap initializes `workflowCycle` to `1` when the first `plan`
  assignment is emitted
- `workflowCycle` increments only when the workflow rewinds to an
  earlier module after a durable gate verdict of `review` ->
  `rejected`/`needs_iteration` or `verify` -> `failed`
- normal forward progression, same-module reruns after
  `decision.resolved`, and stale-run requeues of the current-module
  assignment do not increment `workflowCycle`
- same-module reruns do increment `moduleAttempt` for the current module

Illustrative workflow-cycle traces:

- `plan(1) -> review(1) -> verify(1) -> verified`
- `plan(1) -> review(1: needs_iteration) -> plan(2) -> review(2) -> verify(2)`
- `plan(2) -> review(2) -> verify(2: failed) -> review(3) -> verify(3)`
  A stale requeue or `decision.resolved` within cycle `3` stays in
  cycle `3` and increments that module's `moduleAttempt`.

Built-in assignment-emission contract for Milestone 3:

- common emitted assignment fields for all workflow modules:
  - `parentTaskId`: runtime session id
  - `workflow`: active workflow id
  - `ownerType`: `host`
  - `ownerId`: active adapter id from runtime status
  - `state`: `queued`
  - `createdAt` and `updatedAt`: emission timestamp
- common workflow artifact I/O rule:
  - current module output target should be delivered through
    `workflow.outputArtifact`
  - `buildTaskEnvelope` should emit the host-visible project-relative
    `.coortex/...` path in `workflow.outputArtifact` and include that
    same path in `writeScope`
  - prior module artifacts must not be carried in
    `Assignment.writeScope`
  - `writeScope` remains the surfaced writable-path contract only
  - prior accepted module artifacts should be delivered through a
    separate read-only input channel on the additive
    `TaskEnvelope.workflow` object, for example `workflow.readArtifacts`
  - those references are readable workflow inputs, not writable paths,
    and host prompts should continue to interpret `writeScope` as the
    only writable scope
- common active-assignment rule:
  - advancement and rewind into a different module emit a new assignment
    id and replace `status.activeAssignmentIds` with that single id
  - same-module reruns after `decision.resolved`, stale recovery, or
    invalid-gate retry reuse the current assignment id and return that
    assignment to `queued`
  - same-module reruns increment `currentModuleAttempt`, which
    distinguishes repeated attempts in durable workflow events and
    output artifact paths
  - Milestone 3 does not add a `superseded` assignment state; same-id
    reruns use the existing `queued` / `in_progress` / `blocked` /
    `completed` / `failed` state vocabulary
  - assignments are never marked `superseded` in Milestone 3
  - when a different-module transition occurs, the previous assignment
    keeps the state already produced by its durable outcome or blocker
    path (`completed`, `failed`, or `blocked`) and simply leaves the
    active assignment set
- module-specific emitted fields:
  - `plan`
    - `objective`: produce the cycle plan artifact and review-ready
      evidence for the current workflow objective
    - `writeScope`: inherit the workflow run write scope without
      widening it
    - `requiredOutputs`:
      - `planSummary`
      - `implementationSteps`
      - `reviewEvidenceSummary`
    - emission points:
      - bootstrap
      - `review` verdict `rejected` or `needs_iteration`
      - same-module rerun when the `plan` gate cannot complete
  - `review`
    - `objective`: assess the latest accepted `plan` artifact for the
      current cycle and produce a review verdict
    - `writeScope`: inherit the current workflow write scope without
      widening it
    - `read-only artifact inputs`:
      - latest accepted `plan` artifact reference for the current cycle
        via `workflow.readArtifacts`
    - `requiredOutputs`:
      - `verdict`
      - `rationaleSummary`
    - emission points:
      - `plan` gate `ready_for_review`
      - same-module rerun when the `review` gate cannot complete
  - `verify`
    - `objective`: verify the latest approved review state against
      current-cycle durable evidence
    - `writeScope`: inherit the current workflow write scope without
      widening it
    - `read-only artifact inputs`:
      - latest approved `review` artifact reference for the current cycle
        via `workflow.readArtifacts`
    - `requiredOutputs`:
      - `verdict`
      - `verificationSummary`
      - `evidenceResultIds`
    - emission points:
      - `review` verdict `approved`
      - same-module rerun when the `verify` gate cannot complete

### 3. Workflow progress in runtime state

Persist just enough workflow progress to recover and continue after
interruption.

Minimum useful state:

- active workflow id
- ordered module ids
- current module id
- one active assignment id for the current module in workflow-controlled
  runtimes
- per-module state, including:
  - current or last assignment id
  - gate outcome
  - source result ids and source decision ids
  - evidence summary
  - entered-at and evaluated-at timestamps
- last durable advancement timestamp or summary

This should remain runtime-owned and rebuildable from durable events.

Milestone 3 should treat this as a dedicated workflow progress record,
not as an extension of `RuntimeStatus` alone and not as meaning carried
only by the existing `Assignment.workflow` string.

Blocking reason should be derived from durable assignment, result,
decision, runtime-status, and workflow-progress state rather than stored
as an independent blocker record inside workflow progress.

The next eligible module should be derived from the workflow registry
plus durable runtime state rather than stored as separate truth.

Milestone 3 should enforce a single-active-assignment invariant for
workflow-controlled runtimes. Once workflow progress exists,
`status.activeAssignmentIds` should contain only the current-module
assignment. Earlier blocked or completed assignments remain durable
history, but they are removed from the active assignment set when a
replacement or next-module assignment is emitted. The Milestone 2
multi-active runnable-selection behavior remains a pre-workflow baseline
path and should not define Milestone 3 workflow semantics.

Shared workflow type surface for Milestone 3:

- persisted runtime truth should live in a dedicated
  `WorkflowProgressRecord` in `src/core/types.ts`, not in `RuntimeStatus`
- `RuntimeProjection` should carry that record as persisted workflow
  truth, for example `workflowProgress?: WorkflowProgressRecord`
- `WorkflowProgressRecord` should persist:
  - `workflowId`
  - `orderedModuleIds`
  - `currentModuleId`
  - `workflowCycle`
  - `currentAssignmentId`
  - `currentModuleAttempt`
  - per-module state entries with:
    - `moduleId`
    - `moduleAttempt`
    - `assignmentId`
    - `moduleState`
    - `gateOutcome`
    - `sourceResultIds`
    - `sourceDecisionIds`
    - `evidenceSummary`
    - `checklistStatus` when that module requires checklist evaluation
    - `artifactReferences`
    - `enteredAt`
    - `evaluatedAt`
  - last applied workflow transition metadata
- derived operator or host-facing workflow state should live in a
  separate `WorkflowSummary` shape
- `WorkflowSummary` should live in `src/core/types.ts` or an equivalent
  core-owned shared type surface that both `workflows` and `adapters`
  may import without violating boundary rules
- `WorkflowSummary` should contain:
  - `id`
  - `currentModuleId`
  - `currentModuleState`
  - `workflowCycle`
  - `currentAssignmentId` or `null`
  - `outputArtifact` as the current-module writable project-relative
    `.coortex/...` path, or `null` when no active module assignment
    exists
  - `readArtifacts` as read-only project-relative `.coortex/...`
    references required by the current module
  - `rerunEligible`
  - `blockerReason` or `null`
  - `lastGateOutcome` or `null`
  - `lastDurableAdvancement` or `null`
- `RuntimeStatus` should keep its current flat shape and remain
  operator-summary-only; only `currentObjective`, `resumeReady`, and
  `activeAssignmentIds` are workflow-derived there
- `TaskEnvelope.workflow` and `ctx inspect.workflow` should use the same
  derived `WorkflowSummary` contract

For workflow-controlled runtimes, expired or malformed host-run lease
recovery must preserve the current module and current `workflowCycle`,
requeue only the current-module assignment, and then reevaluate through
the shared workflow progression surface. `src/recovery/host-runs.ts` may
remain responsible for stale-run diagnostics and reconciliation inputs,
but it should not bypass workflow progress by directly choosing a
different active assignment or mutating workflow state outside that
seam. For workflow-controlled runtimes, stale recovery should return
facts such as stale assignment id, stale timestamp, and recovered
terminal-outcome metadata, then let the shared workflow-aware seam
decide the resulting `assignment.updated`, `status.updated`, and
workflow events. The existing stale-run selection behavior remains a
pre-workflow baseline path for runtimes that do not yet have workflow
progress.

Snapshot and event compatibility policy for Milestone 3:

- keep the runtime snapshot schema on `version: 1` for this milestone
- add `workflowProgress` as an optional snapshot field and treat its
  absence as "pre-workflow baseline state"
- add workflow-progress event types and payloads without requiring old
  snapshots to contain them
- when recovery falls back to a v1 snapshot that has no
  `workflowProgress`, the workflow-aware loader must preserve existing
  runtime state but must not synthesize workflow advancement or new
  workflow assignments from missing workflow fields alone
- workflow-mode reevaluation is allowed only when durable workflow
  progress is present in the replayed projection or snapshot

Intended workflow-mutation ownership for Milestone 3:

- One dedicated workflow progression engine under `src/workflows/`
  should own workflow-driven mutation planning for:
  - recording gate outcomes and appending workflow-progress events
  - reacting to durable blocker state after `decision.created` or
    `decision.resolved` is persisted
  - advancing or rewinding workflow progress
  - emitting the next queued assignment and updating active assignment
    selection
- runtime truth remains owned by the existing event log, projection, and
  snapshot surfaces in `core`, `persistence`, and `projections`
- that workflows-owned engine owns mutation planning; the shared
  load/reconcile seam and post-outcome path only persist the returned
  additive workflow events plus existing `assignment.created`,
  `assignment.updated`, and `status.updated` events
- `decision.created` remains on the normal host-outcome persistence path
  rather than becoming a second event family emitted by the workflow
  engine
- `src/recovery/host-runs.ts` must not remain a competing writer for
  workflow-controlled runtimes; outside the pre-workflow baseline path,
  it should contribute facts and diagnostics, not final assignment or
  status mutations
- CLI glue and adapter code should call this seam rather than composing
  workflow mutations ad hoc inside `run-operations.ts` or host-specific
  code.

### 4. Command-surface integration

Expose workflow progress through the existing command surfaces.

Milestone 3 should not add a richer workflow control surface by
default. It should instead ensure:

- workflow-mode operator summary remains runtime-owned:
  - `RuntimeStatus.currentObjective` remains the normative user-facing
    headline for `ctx status`, `ctx resume`, and
    `RecoveryBrief.activeObjective`
  - `resumeReady` means a durable workflow-aware resume envelope can be
    emitted; it does not mean `ctx run` is currently eligible
  - `workflow.rerunEligible` remains the field that answers whether the
    current assignment is runnable now
- workflow-mode operator summary derivation should be deterministic.
  The templates below are illustrative target strings, not the only
  valid wording:
  - current module assignment in `queued` state with no open decision:
    - `currentObjective`:
      `Start <moduleId> assignment <assignmentId>: <assignment.objective>`
    - `resumeReady`: `true`
  - current module assignment in `in_progress` state with no open
    decision:
    - `currentObjective`:
      `Continue <moduleId> assignment <assignmentId>: <assignment.objective>`
    - `resumeReady`: `true`
  - current module assignment in `blocked` state with an open decision:
    - `currentObjective`:
      `Resolve decision <decisionId>: <decision.blockerSummary>`
    - `resumeReady`: `true`
  - no current assignment because the workflow is complete after
    `verify -> verified`:
    - `currentObjective`: `Workflow <workflowId> complete.`
    - `resumeReady`: `false`
  - no current assignment because durable state is incomplete or replay
    fell back to a pre-workflow baseline snapshot:
    - `currentObjective`:
      `Inspect workflow <workflowId> and repair runtime state.`
    - `resumeReady`: `false`
  - gate outcomes such as `ready_for_review`, `approved`,
    `needs_iteration`, `rejected`, and `failed` change the current
    module assignment and `workflow.lastGateOutcome`, but they do not
    introduce a second headline template beyond the state rules above
- `ctx run` still means "execute the runtime-selected runnable
  assignment" for the current workflow module and emits workflow/module
  identity before the result or decision outcome
- when a command invocation durably absorbs a previously missing
  completed result or decision during reconciliation, `ctx run` may
  still surface that recovered outcome for the operator even if workflow
  progression also activates a next-module assignment or reruns the same
  assignment before the command returns
- recovered-outcome selection should be keyed off durable deltas such as
  absorbed `resultId` or `decisionId` plus any resulting gate or
  transition events from that same command invocation, not off
  `activeAssignmentIds.length === 0`
- `ctx status` remains line-oriented and must show:
  - workflow id
  - current module id
  - current module state
  - rerun eligibility
  - derived blocker reason when not runnable
  - last gate outcome
  - last durable advancement or evidence summary
- `ctx resume` continues to emit the resume envelope and must surface a
  workflow summary in durable JSON with at least:
  - workflow id
  - current module id
  - current module state
  - current assignment id when an active assignment exists
  - current module output artifact target
  - read-only artifact references needed by the current module
  - rerun eligibility
  - derived blocker reason when present
  - last gate outcome
  - last durable advancement or evidence summary
  This summary should live in a top-level `workflow` object on
  `TaskEnvelope`, not under `recoveryBrief` or free-form `metadata`.
  `TaskEnvelope` is extended in place for Milestone 3; existing
  top-level fields remain, and the new `workflow` field is additive
  rather than a replacement envelope type.
  `metadata.activeAssignmentId` should remain the authoritative
  execution-facing assignment identifier for Milestone 3 adapters, and
  when `workflow.currentAssignmentId` is present it must match that
  metadata value.
  `ctx resume` should keep using `projection.status.currentObjective` for
  its user-facing headline. The structured `workflow` object is
  supplemental durable context, not the replacement headline surface.
  Envelope budgeting and compaction should treat the new `workflow`
  object as required state:
  - never drop `workflow.id`, `workflow.currentModuleId`,
    `workflow.currentModuleState`, `workflow.currentAssignmentId`,
    `workflow.outputArtifact`,
    `workflow.readArtifacts`,
    `workflow.rerunEligible`, or `workflow.lastGateOutcome`
  - allow trimming only for explanatory workflow strings such as
    `workflow.blockerReason` and `workflow.lastDurableAdvancement`, with
    the same artifact-reference pattern used elsewhere in the envelope
  - compact `workflow` explanatory fields before dropping durable
    identifiers or state fields from the envelope
  - `workflow.outputArtifact` must remain the writable output target for
    the active module, must not be trimmed into an unreadable summary,
    and must continue to match a path present in `writeScope`
  - `workflow.readArtifacts` must remain read-only reference data and
    must not be merged into `writeScope` during compaction or adapter
    prompt shaping
  Enforcement should live in the adapter-facing envelope or prompt path:
  - `buildTaskEnvelope` emits the project-relative host-visible paths,
    mirrors `workflow.outputArtifact` into `writeScope`, and keeps
    `workflow.readArtifacts` out of `writeScope`
  - `buildCodexExecutionPrompt` should continue to say "Stay within the
    provided write scope" while also describing `workflow.outputArtifact`
    as the runtime-owned writable target and `workflow.readArtifacts` as
    read-only references
  - preserve consistency between `workflow.blockerReason` and
    `recoveryBrief.nextRequiredAction`
  - when an open decision exists, `nextRequiredAction` must be derived
    from the same decision id and blocker summary that produce
    `workflow.blockerReason`
  - when no blocker exists, `nextRequiredAction` should be an imperative
    restatement of `currentObjective`; if the two diverge, regenerate
    `nextRequiredAction` from workflow-derived runtime truth rather than
    persisting conflicting strings
  - all public `TaskEnvelope` instances, including synthetic recovered
    ones produced after reconciliation, must flow through one shared
    builder path
  - recovered-outcome paths in `runRuntime()` are not exempt from the
    `TaskEnvelope.workflow` contract and must populate the same workflow
    summary through the same shaping rules
  - recovered envelopes must carry the same `workflow` object,
    `writeScope` or `workflow.outputArtifact` consistency, and
    compaction guarantees as the normal resume or run path
  Implementation note for Milestone 3:
  - the adapter-facing envelope builder should add the top-level
    `workflow` object and preserve it through compaction
  - the public adapter envelope entrypoint should remain the single
    public builder path for normal and recovered envelopes rather than
    allowing a second inline envelope shape in command code
  - the prompt-shaping path should explain that
    `workflow.outputArtifact` is writable because it is mirrored into
    `writeScope`, while `workflow.readArtifacts` stay read-only and must
    not appear in `writeScope`
  - `src/__tests__/adapter-contract.test.ts`,
    `src/__tests__/trimming.test.ts`, and workflow-focused envelope
    tests should prove that `workflow.readArtifacts` never leak into
    `writeScope` and that compaction preserves the required `workflow`
    fields
- `ctx inspect` becomes a runtime inspection command with a stable JSON
  object containing:
  - `workflow`
  - `assignment`
  - `run`
  When a host run exists, `run` contains the existing host-run record.
  When no host run exists but the assignment or workflow run exists,
  `run` is `null` and `assignment` plus `workflow` still return runtime
  data. `ctx inspect` should exit 0 when it returns any workflow,
  assignment, or run context, and exit 1 only when no matching host run,
  assignment, or active workflow context can be found.
  Target selection should be: explicit assignment id first; otherwise
  the current workflow assignment from reevaluated runtime truth;
  otherwise the last recorded host run; otherwise exit 1. When the
  current workflow assignment and last recorded host run disagree, the
  current workflow assignment wins.
  The CLI output contract is replaced at the command layer, but the
  adapter inspection contract is preserved: `adapter.inspectRun()` and
  the current host-run inspection helper remain host-run-only, while a
  new runtime-side inspection helper should compose workflow state,
  assignment state, and optional host-run state into the public command
  payload.
- `RecoveryBrief` should remain structurally stable in Milestone 3:
  - no new top-level workflow section is required
  - `activeObjective` and `nextRequiredAction` should be derived from
    workflow-aware runtime truth
  - richer workflow state lives on `WorkflowProgressRecord`,
    `TaskEnvelope.workflow`, and the `ctx inspect` payload

Illustrative payload when a host run exists:

```json
{
  "workflow": {
    "id": "default",
    "currentModuleId": "review",
    "currentModuleState": "blocked",
    "rerunEligible": false,
    "blockerReason": "Resolve decision decision-1: reviewer requested scope clarification.",
    "lastGateOutcome": "needs_iteration"
  },
  "assignment": {
    "id": "assignment-review-2",
    "state": "blocked",
    "workflow": "default"
  },
  "run": {
    "assignmentId": "assignment-review-2",
    "state": "completed",
    "outcomeKind": "decision"
  }
}
```

Illustrative payload when no host run exists yet:

```json
{
  "workflow": {
    "id": "default",
    "currentModuleId": "verify",
    "currentModuleState": "queued",
    "rerunEligible": true,
    "blockerReason": null,
    "lastGateOutcome": "approved"
  },
  "assignment": {
    "id": "assignment-verify-1",
    "state": "queued",
    "workflow": "default"
  },
  "run": null
}
```

Any new CLI command should stay minimal and justified.

### 5. Transition and blocker behavior

Define a narrow transition model:

- a module completes only when its module-defined durable completion
  predicate is satisfied
- open decisions block advancement
- failed results do not silently advance the workflow
- missing required outputs or expected evidence summary prevents
  advancement even when a result is marked completed
- the next module activates only after durable completion of the
  previous module
- valid `workflow.transition.applied.transition` values for Milestone 3
  are:
  - `advance`
  - `rewind`
  - `rerun_same_module`
  - `complete`
- Milestone 3 uses this small outcome matrix:
  - `plan` + completed gate -> advance to `review` with a new queued
    `review` assignment
  - `review` + `approved` -> advance to `verify` with a new queued
    `verify` assignment
  - `review` + `rejected` or `needs_iteration` -> rewind to `plan` with
    a new queued `plan` assignment
  - `verify` + `verified` -> workflow completes with no active
    assignment
  - `verify` + `failed` -> rewind to `review` with a new queued
    `review` assignment
  - any module + open decision -> current assignment remains `blocked`
    and the workflow stays on the same module
  - any module + resolved decision -> apply `rerun_same_module` with
    `fromModuleId === toModuleId`, reuse the same assignment id, return
    that assignment to `queued`, and make it runnable again
  - stale recovery of the current module -> apply `rerun_same_module`
    with `fromModuleId === toModuleId`, reuse the same assignment id,
    and return that assignment to `queued`
  - invalid or missing artifact after a terminal result -> apply
    `rerun_same_module` with `fromModuleId === toModuleId`, reuse the
    same assignment id, and return that assignment to `queued`
- rerun eligibility should be explicit:
  - `ctx run` is eligible only when workflow progress points at a
    current-module assignment in `queued` or `in_progress` state and no
    open decision exists for that assignment
  - same-module reruns do not allocate replacement assignment ids
  - same-module reruns increment `moduleAttempt`; different-module
    transitions reset `moduleAttempt` to `1` for the newly activated
    module
  - different-module transitions remove the prior assignment from the
    active set without changing its durable lifecycle state
- transitions should consume normalized runtime lifecycle state rather
  than raw adapter hooks
- `decision.resolved` progression for Milestone 3 should be exercised by
  externally persisted events appended to the durable log and then
  consumed through replay or load paths; no new resolver command surface
  is required in this milestone

This is the milestone where workflow policy becomes real, so these
rules matter more than adding many module types.

## Recommended execution order

1. define the workflow contract and dedicated workflow progress record
2. define the dedicated workflow event and gate payload model
3. add projection and recovery-brief support for workflow progress
4. implement the built-in registry and default workflow sequence
5. implement built-in `plan`, `review`, and `verify` modules with
   evidence-gated transitions and the rejection or rerun matrix
6. integrate workflow state into `run`, `status`, `resume`, and
   `inspect` semantics, including the no-run inspect fallback
7. add progression, blocker, rejection, and recovery tests
8. update `docs/runtime-state-model.md`,
   `docs/module-boundaries.md`,
   `docs/run-recovery-invariants.md`, and any affected
   milestone-tracking docs in the same commit as the implementation

## Verification strategy

Milestone 3 should be considered complete when tests prove:

- bootstrap initializes a real workflow sequence and current module
- the registry resolves built-in modules deterministically
- workflow modules shape emitted assignments deterministically
- workflow progress persists separately from operator summary state and
  rebuilds after event replay or recovery
- one shared workflow-aware load/reconcile seam drives `status`,
  `resume`, `run`, and `inspect` against the same reevaluated runtime
  truth
- workflow-controlled runtimes use the shared workflow-aware loader in
  `src/cli/runtime-state.ts` rather than keeping a second competing
  reconciliation path in command-specific code
- repeated load-time reevaluation after convergence appends no duplicate
  workflow-progress events, no duplicate queued assignments, and no
  repeated stale-reconciliation diagnostics
- the workflow-aware loader honors the documented sequencing
  constraints: recovery load first, stale-run facts before workflow
  progression, workflow-driven mutations before final status
  derivation, and convergence without duplicate events
- the workflow progression engine under `src/workflows/` is the only
  owner of workflow-driven mutation planning, and command paths only
  persist its returned events through the shared load/reconcile seam
- `core` does not import `workflows`; any generic helper kept in `core`
  remains policy-agnostic and receives workflow policy by injection from
  `workflows` through CLI composition
- assignment and status mutations remain serialized through the existing
  runtime event union as `assignment.created`, `assignment.updated`, and
  `status.updated`; workflow events are additive, not a replacement
- module gate outputs persist durably and do not rely only on
  `result.submitted`, `decision.created`, or `status.updated`
- the durable workflow event model deterministically rebuilds the same
  workflow progress state
- workflow event and runtime-event ordering constraints are
  deterministic for bootstrap, advance, rewind, same-module rerun, and
  recovered completed-run paths
- `workflowCycle` initializes at bootstrap, increments only on rewinds
  to earlier modules, and verify freshness excludes evidence from
  earlier cycles
- blocker reason is derived consistently from durable runtime truth
  rather than from transcript wording or a separate persisted blocker
  record
- workflow-mode `currentObjective` and `resumeReady` derive
  deterministically from current module state, open-decision state, and
  completion state
- `moduleState` derivation is explicit, bounded to its documented
  vocabulary, and does not smuggle gate verdicts into extra state values
- `resumeReady` and `workflow.rerunEligible` are not conflated:
  blocked workflows may keep `resumeReady=true` while
  `rerunEligible=false`
- `plan` does not advance without its declared outputs and evidence
  summary
- active modules write to a deterministic runtime-owned
  `workflow.outputArtifact` target, and only claimed artifacts affect
  gate evaluation
- adapter-facing workflow artifact paths are project-relative
  `.coortex/...` references, while claimed workflow-event artifact paths
  remain store-relative `runtime/...` values
- `review` can approve, block, or require iteration using durable state
  only
- `verify` depends on fresh durable evidence and unresolved-decision
  state
- review rejection queues a new `plan` assignment deterministically
- verify failure queues a new `review` assignment deterministically
- decision resolution on a blocked module requeues the current
  assignment for the same module, increments `moduleAttempt`, and
  restores rerun eligibility
- stale-run reconciliation on workflow-controlled runtimes requeues only
  the current-module assignment, preserves `currentModuleId` and
  `workflowCycle`, and reevaluates through the shared load/reconcile
  seam
- `buildStaleRunReconciliation()` remains a pre-workflow baseline writer
  only; workflow-controlled runtimes use stale-run facts and diagnostics
  from `src/recovery/host-runs.ts` but leave final assignment, status,
  and workflow event mutation planning to the shared workflow seam
- same-module reruns after decision resolution, stale recovery, or
  invalid-gate retry reuse the current assignment id, set it back to
  `queued`, increment `moduleAttempt`, and do not require a new assignment state such as
  `superseded`
- repeated same-module reruns within one workflow cycle append distinct
  `workflow.transition.applied` events because `moduleAttempt`
  monotonically increases even when the assignment id is reused
- recovery and dedupe for workflow-controlled runtimes distinguish
  consumed terminal outcomes by `(assignmentId, moduleAttempt)` so one
  assignment id may safely produce multiple terminal outcomes across
  reruns in the same workflow cycle
- snapshot fallback from a v1 runtime without `workflowProgress`
  preserves the pre-workflow baseline state and does not synthesize
  workflow advancement until durable workflow progress exists
- workflow-controlled runtimes maintain exactly one active assignment in
  `status.activeAssignmentIds`
- durable completed results advance only when the current module's gate
  conditions are satisfied
- open decisions block workflow advancement
- failed results and missing evidence do not silently advance
- interrupted state rebuild preserves the current module state and last
  durable advancement or evidence summary while still surfacing the same
  derived blocker reason
- `ctx run`, `ctx status`, `ctx resume`, and `ctx inspect` surface
  workflow progress consistently without adding a richer control UI
- `ctx run` can surface a recovered completed result or decision based
  on the durable delta absorbed in that invocation even when workflow
  progression also leaves an active assignment afterward
- `ctx resume` keeps `projection.status.currentObjective` as the
  user-facing headline contract
- `ctx resume` exposes workflow summary through a top-level `workflow`
  object on `TaskEnvelope` while preserving existing top-level envelope
  fields
- `WorkflowProgressRecord` is persisted runtime truth, while
  `TaskEnvelope.workflow` and `ctx inspect.workflow` expose the shared
  derived `WorkflowSummary` shape
- `WorkflowSummary` lives on a shared core-owned type surface that
  `workflows`, `adapters`, and CLI code can all import without boundary
  violations
- `metadata.activeAssignmentId` remains authoritative for execution, and
  any mirrored `workflow.currentAssignmentId` stays consistent with it
- recovered-outcome envelopes produced from reconciliation use the same
  workflow-aware envelope builder and compaction rules as the normal
  resume or run path
- public recovered-result and recovered-decision envelopes are not a
  separate contract; they remain full `TaskEnvelope` instances and must
  carry the same `workflow` object as other public envelopes
- `RecoveryBrief` keeps its current top-level shape while deriving
  `activeObjective` and `nextRequiredAction` from workflow-aware runtime
  truth
- prior-module artifact references are delivered through a read-only
  workflow field such as `workflow.readArtifacts`, not through
  `writeScope`
- `buildTaskEnvelope` mirrors `workflow.outputArtifact` into
  `writeScope`, while `workflow.readArtifacts` remain read-only and stay
  out of `writeScope`
- envelope compaction preserves mandatory workflow identity and state
  fields, trims only explanatory workflow text, and keeps
  `workflow.blockerReason` consistent with
  `recoveryBrief.nextRequiredAction`
- `ctx inspect` returns workflow and assignment context even when no host
  run exists for the target assignment
- `ctx inspect` target selection follows explicit assignment id ->
  current workflow assignment -> last recorded run -> exit 1
- adapter-level host-run inspection remains available behind the public
  runtime inspection helper

Likely test surfaces:

- rerun the full automated test suite for the repository
- `src/__tests__/cli.test.ts`
- `src/__tests__/trimming.test.ts`
- `src/__tests__/milestone-2-integration.test.ts`
- `src/__tests__/host-run-recovery-matrix.test.ts`
- `src/__tests__/architecture-boundaries.test.ts`
- `src/__tests__/persistence.test.ts`
- `src/__tests__/adapter-contract.test.ts`
- new workflow-focused tests under `src/__tests__/`
- keep current multi-active runnable-selection and stale-recovery
  assertions as pre-workflow baseline coverage for runtimes without
  workflow progress, including the existing Milestone 2 cases in
  `src/__tests__/milestone-2-integration.test.ts` and
  `src/__tests__/host-run-recovery-matrix.test.ts`
- add workflow-mode coverage, in new tests or explicit workflow-mode
  blocks, that proves:
  - `run` never skips past the current workflow assignment
  - stale recovery requeues the same module in the same cycle
  - workflow-controlled runtimes keep exactly one active assignment
    after advancement, rewind, decision resolution, and stale recovery
  - repeated `status`, `resume`, and `inspect` calls after convergence
    append no duplicate workflow events or assignments
  - workflow-mode operator summaries produce the expected
    `currentObjective`, `resumeReady`, and `rerunEligible` values for
    queued, in-progress, blocked, and completed states
  - same-assignment reruns with reused assignment ids still recover and
    dedupe correctly because later terminal outcomes are matched to a
    higher `moduleAttempt`
  - workflow-aware resume-envelope compaction keeps the required
    `workflow` fields and preserves consistency with
    `recoveryBrief.nextRequiredAction`
  - recovered-outcome envelopes from reconciliation carry the same
    `workflow` summary fields and compaction guarantees as envelopes
    produced by the normal resume or run path
  - `workflow.readArtifacts` never enter `writeScope`, including
    recovered envelopes and compacted envelopes
- persistence/projection tests where workflow progress is rebuilt
- recovery-brief tests where workflow context is surfaced
- command-contract tests for the new `inspect` fallback and workflow
  summary fields

## Success criteria

Milestone 3 is complete when all of the following are true:

1. `src/workflows/` contains real workflow modules.
2. The runtime can persist and rebuild a dedicated workflow progress
   record.
3. The built-in `plan`, `review`, and `verify` modules shape
   assignments and define evidence-gated completion policy.
4. The workflow layer defines a durable gate payload model for module
   verdicts, evidence summaries, source result ids, and evidence
   freshness.
5. Workflow progression depends on durable runtime truth rather than
   transcript convention, repo sidecars, or raw adapter hooks.
6. `ctx run`, `ctx status`, `ctx resume`, and `ctx inspect` expose the
   current workflow and module semantics through the existing command
   surface, including runtime inspection without requiring a host run.
7. Milestone 3 defines deterministic rejection, decision-resolution,
   verify-failure, and rerun-eligibility behavior.
8. Milestone 3 does not require a richer workflow UI, multi-worker
   orchestration layer, or the full Phase 5 verification subsystem.
9. Tests prove workflow progression, blocker handling, evidence gates,
   and recovery of workflow state after interruption.

## Early dogfooding

Once the initial workflow modules are working, the first hardening step
should be to run real Coortex work through the default workflow
sequence.

That dogfooding pass should validate that:

- the built-in modules are usable for real project work
- evidence gates are strong enough to keep progression honest
- the existing operator surfaces are enough to follow and recover
  workflow state without a separate workflow UI
