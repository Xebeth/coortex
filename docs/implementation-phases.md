# Implementation Phases

## Purpose

This document describes the implementation sequence for Coortex after the pivot to a host-agnostic core.

The first milestone builds the core runtime and **one reference host adapter**. Later phases expand adapters, workflows, and operational features.

For the detailed target documents, see:

- `docs/coortex-milestone-1-plan.md`
- `docs/coortex-roadmap.md`

---

## Milestone 1 — Core + Reference Adapter

### Objective

Build the first coherent slice of Coortex:

- host-agnostic core runtime
- durable persistence
- recovery brief generation
- bounded task envelopes
- trimming
- telemetry scaffold
- one reference host adapter

### Deliverables

- project scaffold
- runtime state model
- event log and snapshot support
- atomic writes
- compact recovery brief generation
- adapter contract
- reference host adapter
- bounded envelope builder
- trimming layer
- telemetry scaffold
- `ctx init`
- `ctx doctor`
- `ctx status`
- `ctx resume`

### Exit criteria

- runtime truth exists independently of the host
- one host adapter works end-to-end against real runtime state
- trimming and bounded envelopes are active
- telemetry is recorded in a common schema

---

## Milestone 2 — Real execution and recovery hardening

### Objective

Move from scaffolded integration into real host-driven task execution and make interruption recovery stronger.

### Current status

Milestone 2 is complete in the current repository.

The current implementation now includes:

- real execution through the reference adapter
- persisted result and decision capture in real runs
- run inspection through persisted host metadata
- stronger recovery logic for interrupted runs
- lease and heartbeat-backed host-run tracking
- stale-run reconciliation and queued retry behavior
- explicit execution-mode handling for live validation
- recovery-oriented telemetry for stale-run reconciliation and host lifecycle events

### Deliverables

- real task execution through the reference adapter
- result/decision capture in real runs
- run inspection through persisted host metadata
- stronger recovery logic
- improved resume behavior
- more complete telemetry
- more robust adapter lifecycle handling
- explicit execution-mode handling for live validation

---

## Milestone 3 — Workflow modules

### Objective

Move sequencing policy into explicit workflow modules.

### Deliverables

- `plan`
- `review`
- `verify`
- additional workflow modules as needed

The runtime remains authoritative.

---

## Milestone 4 — Additional host adapters

### Objective

Add at least one second host adapter to prove the host-agnostic architecture.

Possible candidates:

- OpenCode
- Claude Code
- other compatible hosts

This phase validates whether the adapter contract is real or merely Codex-shaped.

---

## Milestone 5 — Advanced operational features

### Objective

Add richer capabilities such as:

- stronger verification
- approvals/governance
- richer telemetry
- hooks and plugin integration
- guidance/artifact retrieval
- more complete backends and team execution

---

## Phase Ordering Rule

The intended order is:

1. core runtime truth
2. persistence
3. recovery
4. bounded context and trimming
5. telemetry
6. one reference adapter
7. workflow modules
8. second adapter
9. richer operations

This order is intentional. Multi-host ambitions should not come before proving the runtime-first core.
