# Coortex Milestone 1 Plan

## 1. Objective

Deliver the first coherent working slice of Coortex.

Milestone 1 establishes the **host-agnostic runtime-first spine** of the system and proves it through **one reference host adapter**.

This milestone is intentionally narrow. It is designed to validate the architecture, not to complete the full feature set.

---

## 2. Milestone Outcome

At the end of Milestone 1, the project should have:

- a clean project scaffold
- a host-agnostic runtime state model
- append-only persistence plus snapshot support
- a compact recovery brief
- an explicit host adapter contract
- one reference adapter implementation
- a bounded task-envelope builder
- a first trimming layer
- a telemetry scaffold
- a minimal CLI

---

## 3. Scope

## In scope

1. project structure
2. core runtime entity definitions
3. event log and snapshot persistence
4. atomic writes
5. recovery brief generation
6. adapter contract definition
7. one reference host adapter
8. bounded task-envelope builder
9. tool-output trimming
10. telemetry scaffold
11. `ctx init`
12. `ctx doctor`
13. `ctx status`
14. `ctx resume`

## Out of scope

- multiple host adapters at once
- full workflow engine
- full team execution
- advanced guidance retrieval
- full approval/sandbox model
- plugin ecosystem
- advanced hooks integration
- advanced memory tiers
- full backend matrix
- full verification subsystem
- branch/fork semantics
- comprehensive observability stack

---

## 4. Milestone Architecture Slice

The first slice should create these modules under `src/`:

- `core/`
- `persistence/`
- `projections/`
- `recovery/`
- `adapters/`
- `hosts/<reference-host>/`
- `telemetry/`
- `cli/`

Optional placeholders may exist for:
- `workflows/`
- `guidance/`
- `verification/`
- `hooks/`
- `plugins/`
- `backends/`

---

## 5. Deliverables

## 5.1 Host-agnostic runtime schema

Implement minimal typed models for:

- assignments
- result packets
- decision packets
- runtime/session status
- recovery brief

## 5.2 Persistence

Implement:

- append-only event log
- snapshot file
- atomic writes
- load/save primitives
- projection rebuild from durable state

## 5.3 Recovery

Implement:

- loading prior durable state
- rebuilding current state from persisted data
- compact recovery brief generation

## 5.4 Adapter contract

Define the minimal adapter contract needed for:

- startup/resume integration
- bounded task-envelope injection
- result/decision capture
- telemetry extraction hooks
- capability reporting

## 5.5 Reference host adapter

Implement one reference host adapter against the contract.

The first host should be chosen pragmatically. It serves to validate the contract rather than to define the entire architecture.

## 5.6 Bounded task envelope

Implement a bounded envelope builder for the current assignment.

The envelope should include only:

- objective
- write scope
- required outputs
- recovery brief when relevant
- targeted metadata needed for the current step

## 5.7 Trimming

Implement the first trimming layer.

### Required behavior

1. **Tool output trimming**
   - capture large outputs as artifacts or files when needed
   - return only bounded excerpts or summaries to the envelope
   - preserve references to the full output

2. **Recovery brief compaction**
   - keep the resume payload small
   - include only current actionable state

3. **Envelope size checks**
   - compute an envelope size estimate
   - refuse or restructure oversized envelopes rather than letting them grow silently

## 5.8 Telemetry scaffold

Record at least:

- lifecycle events
- session/task identifiers
- host/adapter identifiers
- envelope size
- trimming metadata
- placeholders for token/usage fields

## 5.9 CLI

Implement at least:

- `ctx init`
- `ctx doctor`
- `ctx status`
- `ctx resume`

---

## 6. Implementation Order

1. project scaffold
2. runtime models
3. persistence
4. recovery brief generation
5. adapter contract
6. reference adapter
7. bounded envelope builder
8. trimming layer
9. telemetry scaffold
10. CLI wiring

---

## 7. Acceptance Criteria

Milestone 1 is complete when:

1. the project has a clean modular scaffold
2. runtime entities are defined and serializable
3. durable state can be written and reloaded
4. recovery brief generation works from durable state
5. the adapter contract is explicit
6. one reference adapter works against real runtime state
7. bounded task envelopes can be built
8. tool-output trimming is active
9. telemetry records lifecycle and envelope/trimming metadata
10. basic CLI commands work against real persisted state

---

## 8. Explicit Non-Goals

Milestone 1 should not try to finish:

- full workflow modules
- broad multi-host support
- plugins and hooks as mature extension systems
- advanced approvals/governance
- full memory/compaction stack
- full verification and review system
- rich telemetry stack

Those belong to later roadmap phases.
