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
`decision.resolved`.

Likely change areas:

- `src/workflows/`
- `src/core/types.ts`
- `src/core/events.ts`
- `src/core/runtime.ts`
- `src/projections/runtime-projection.ts`
- `src/recovery/brief.ts`
- `src/cli/run-operations.ts`
- `src/adapters/contract.ts`
- `src/hosts/codex/adapter/prompt.ts`
- `src/hosts/codex/adapter/execution.ts`

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
- gate payloads should be derived runtime-side from normalized result
  packets, decision packets, and workflow context; Milestone 3 should
  not require module-aware adapter output fields
- module gate evaluation becomes a separate durable workflow-progress
  update, not an overloaded `ResultPacket.status`
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

For Milestone 3, "fresh" evidence means the verify gate references only
durable result packets produced in the current workflow cycle after the
most recent rewind into `review` or `verify`. Evidence from an earlier
rejected or failed cycle does not satisfy `verify`.

### 3. Workflow progress in runtime state

Persist just enough workflow progress to recover and continue after
interruption.

Minimum useful state:

- active workflow id
- ordered module ids
- current module id
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

Intended runtime-owned mutation surface for Milestone 3:

- One dedicated runtime-owned workflow progression surface should own
  the write path for:
  - recording gate outcomes and appending workflow-progress events
  - opening blockers through decision creation and resolving blockers
    when `decision.resolved` is persisted
  - advancing or rewinding workflow progress
  - emitting the next queued assignment and updating active assignment
    selection
- CLI glue and adapter code should call this seam rather than composing
  workflow mutations ad hoc inside `run-operations.ts` or host-specific
  code.

### 4. Command-surface integration

Expose workflow progress through the existing command surfaces.

Milestone 3 should not add a richer workflow control surface by
default. It should instead ensure:

- `ctx run` still means "execute the runtime-selected runnable
  assignment" for the current workflow module and emits workflow/module
  identity before the result or decision outcome
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
  - rerun eligibility
  - derived blocker reason when present
  - last gate outcome
  - last durable advancement or evidence summary
- `ctx inspect` becomes a runtime inspection command with a stable JSON
  object containing:
  - `workflow`
  - `assignment`
  - `run`
  When a host run exists, `run` contains the existing host-run record.
  When no host run exists but the assignment or workflow run exists,
  `run` is `null` and `assignment` plus `workflow` still return runtime
  data. `ctx inspect` should exit 1 only when no matching host run,
  assignment, or active workflow context can be found.

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
  - any module + resolved decision -> emit a new queued assignment for
    the same module and make that assignment runnable again
- rerun eligibility should be explicit:
  - `ctx run` is eligible only when workflow progress points at a
    current-module assignment in `queued` or `in_progress` state and no
    open decision exists for that assignment
  - blocked assignments are historical once a replacement queued
    assignment is emitted for the same module
- transitions should consume normalized runtime lifecycle state rather
  than raw adapter hooks

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
8. update docs after the implementation lands

## Verification strategy

Milestone 3 should be considered complete when tests prove:

- bootstrap initializes a real workflow sequence and current module
- the registry resolves built-in modules deterministically
- workflow modules shape emitted assignments deterministically
- workflow progress persists separately from operator summary state and
  rebuilds after event replay or recovery
- module gate outputs persist durably and do not rely only on
  `result.submitted`, `decision.created`, or `status.updated`
- blocker reason is derived consistently from durable runtime truth
  rather than from transcript wording or a separate persisted blocker
  record
- `plan` does not advance without its declared outputs and evidence
  summary
- `review` can approve, block, or require iteration using durable state
  only
- `verify` depends on fresh durable evidence and unresolved-decision
  state
- review rejection queues a new `plan` assignment deterministically
- verify failure queues a new `review` assignment deterministically
- decision resolution on a blocked module queues a new assignment for
  the same module and restores rerun eligibility
- durable completed results advance only when the current module's gate
  conditions are satisfied
- open decisions block workflow advancement
- failed results and missing evidence do not silently advance
- interrupted state rebuild preserves the current module state and last
  durable advancement or evidence summary while still surfacing the same
  derived blocker reason
- `ctx run`, `ctx status`, `ctx resume`, and `ctx inspect` surface
  workflow progress consistently without adding a richer control UI
- `ctx inspect` returns workflow and assignment context even when no host
  run exists for the target assignment

Likely test surfaces:

- `src/__tests__/cli.test.ts`
- new workflow-focused tests under `src/__tests__/`
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
