# Scope

## Purpose

This document defines the current implementation scope for Coortex.

The system is designed as a **host-agnostic coordination core** with **host-specific adapters**. The current implementation scope is intentionally limited to the first milestone so the core runtime can be proven before broad host support is attempted.

For the longer-term target, see:

- `docs/coortex-ideal-spec.md`
- `docs/coortex-milestone-1-plan.md`
- `docs/coortex-roadmap.md`

---

## Current Scope

The current scope is:

1. build the host-agnostic core runtime
2. build the persistence and recovery substrate
3. build bounded task-envelope logic with trimming
4. define the host adapter contract
5. implement one **reference host adapter**
6. keep future host support possible without redesigning the core

The current reference host is **Codex**. That does not make Coortex Codex-specific; it is simply the first adapter used to validate the core architecture.

---

## In Scope

### Host-agnostic core
- runtime entity definitions
- assignments
- result packets
- decision packets
- runtime/session status
- recovery brief model

### Persistence
- append-only event log
- snapshot support
- atomic writes
- durable load/save primitives
- projection rebuild from durable state

### Recovery
- rebuild actionable state from durable artifacts
- compact recovery brief generation
- resume-oriented state reconstruction

### Context discipline
- bounded task envelopes
- tool-output trimming
- compact recovery summaries
- envelope size checks

### Telemetry
- lifecycle events
- session/task identifiers
- envelope/trimming metadata
- placeholders or fields for usage/token metrics
- normalized telemetry schema independent of the host

### Adapter foundation
- host adapter contract
- one reference adapter implementation
- host capability surface definition

### Initial command surface
- `ctx init`
- `ctx doctor`
- `ctx status`
- `ctx resume`

---

## Out of Scope

The following are not required in the first milestone:

- support for multiple host adapters at once
- full workflow catalog
- full team/worker orchestration
- plugin ecosystem
- advanced hook integrations
- full safety/approval subsystem
- advanced memory tiers
- advanced history compaction beyond first trimming layer
- full backend matrix
- complete verification gating
- branching/forking semantics
- full observability stack

---

## First-Milestone Success Criteria

The first milestone is successful when:

1. the host-agnostic core runtime exists
2. durable state can be written and rebuilt
3. a compact recovery brief can be generated from runtime state
4. bounded task envelopes can be produced
5. large tool output is trimmed before entering the envelope
6. telemetry is recorded in a host-neutral schema
7. a host adapter contract exists
8. one reference adapter works against real runtime state
9. the initial CLI/status surfaces work against real persisted data

---

## Scope Boundary Rule

A proposed change belongs in the current scope only if it materially improves one of:

- runtime truth
- persistence
- recovery
- bounded context
- trimming
- telemetry
- adapter boundary clarity
- reference-adapter viability
