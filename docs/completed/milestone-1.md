# Milestone 1

## Status

Milestone 1 is complete in the current repository.

This milestone established the host-agnostic runtime-first spine of
Coortex and proved the core architecture before real host-backed
execution was added in Milestone 2.

The current repository still contains the Milestone 1 foundation:

- a clean modular scaffold under `src/`
- host-agnostic runtime entity definitions
- append-only persistence plus snapshot support
- projection rebuild from durable state
- compact recovery brief generation
- an explicit shared adapter contract
- one reference host adapter boundary
- bounded task-envelope building
- first-layer trimming and envelope size discipline
- telemetry scaffolding
- the initial runtime-backed CLI surfaces:
  - `ctx init`
  - `ctx doctor`
  - `ctx status`
  - `ctx resume`

## Objective

Milestone 1 proved that coordination truth could live in the Coortex
runtime rather than in host transcripts, while keeping the initial
slice narrow enough to validate the architecture before real execution
and recovery hardening were attempted.

## Implemented scope

Milestone 1 delivered:

- project structure and module boundaries
- core runtime models for assignments, results, decisions, and status
- append-only event-log and snapshot persistence
- atomic writes and durable load/save primitives
- recovery brief generation from durable state
- the shared adapter contract
- one reference host adapter
- bounded task-envelope building
- tool-output trimming
- telemetry schema and recorder scaffolding
- the initial CLI surfaces:
  - `ctx init`
  - `ctx doctor`
  - `ctx status`
  - `ctx resume`

## Out of scope

The following remained outside Milestone 1:

- real host-backed execution
- strong host-run recovery semantics
- workflow-module expansion
- multi-host support
- plugin ecosystems and advanced hooks
- full approval/sandbox policy systems
- advanced memory tiers
- full backend matrix
- complete verification gating
- branch/fork semantics
- full observability stack

Those areas were intentionally deferred so the runtime-first core could
be validated before broader product work.

## Acceptance criteria

Milestone 1 is complete when all of the following are true:

1. The project has a clean modular scaffold with the documented core,
   persistence, projection, recovery, adapter, host, telemetry, and
   CLI boundaries.
2. Runtime entities are defined and serializable independently of any
   host transcript.
3. Durable state can be written, reloaded, and projected from
   append-only events and snapshots.
4. Recovery brief generation works from durable runtime state.
5. The adapter contract is explicit and keeps the core host-agnostic.
6. One reference adapter proves the contract against real runtime
   state.
7. Bounded task envelopes can be built with trimming active.
8. Telemetry records lifecycle and envelope/trimming metadata in a
   common schema.
9. The initial CLI surfaces work against real persisted state.
10. Tests guard boundary regressions for the Milestone 1 slice.

## Follow-on milestone

The follow-on after Milestone 1 was Milestone 2: real execution and
recovery hardening for the reference host path.

That follow-on is now complete and documented in
`docs/completed/milestone-2.md`.
