# Scope

## Purpose

This document defines the current implementation scope for Coortex after landing the full Milestone 2 slice: real execution plus the recovery-hardening work needed to make that path routine and durable.

The system is designed as a **host-agnostic coordination core** with **host-specific adapters**. The current implementation scope remains intentionally narrow so the runtime-first core and one real reference-host path can be proven before broad host support is attempted.

For the longer-term target, see:

- `docs/coortex-ideal-spec.md`
- `docs/coortex-milestone-1-plan.md`
- `docs/coortex-roadmap.md`

---

## Current Scope

The current scope is:

1. keep the host-agnostic runtime authoritative
2. preserve durable persistence and bounded-envelope discipline
3. run one real reference-host execution path end-to-end
4. persist truthful runtime state for both success and blocked paths
5. reconcile interrupted or stale host runs back into actionable runtime state
6. provide runtime-backed inspection and resume surfaces for that path
7. keep future host support possible without redesigning the core

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
- lease and heartbeat-backed run tracking
- stale-run reconciliation into queued retry state
- duplicate-run prevention while an active lease is present

### Context discipline
- bounded task envelopes
- tool-output trimming
- compact recovery summaries
- envelope size checks

### Telemetry
- lifecycle events
- session/task identifiers
- envelope/trimming metadata
- usage/token metrics when the host exposes them
- normalized telemetry schema independent of the host
- stale-run reconciliation telemetry

### Adapter foundation
- host adapter contract
- one reference adapter implementation
- host capability surface definition
- explicit execution-mode handling for the reference host

### Real execution path
- assignment -> bounded envelope -> host run -> result or decision capture -> persistence into runtime state
- host-run inspection through adapter-owned metadata
- truthful persisted state in both success and blocked paths

### Current command surface
- `ctx init`
- `ctx doctor`
- `ctx status`
- `ctx resume`
- `ctx run`
- `ctx inspect`

---

## Out of Scope

The following are still out of scope for the current implementation slice:

- support for multiple host adapters at once
- full workflow catalog
- full team/worker orchestration
- plugin ecosystem
- advanced hook integrations
- full safety/approval subsystem beyond the current Codex execution-mode switch
- advanced memory tiers
- advanced history compaction beyond first trimming layer
- full backend matrix
- complete verification gating
- branching/forking semantics
- full observability stack

---

## Current Success Criteria

The current implementation slice is successful when:

1. the host-agnostic core runtime exists
2. durable state can be written and rebuilt
3. a compact recovery brief can be generated from runtime state
4. bounded task envelopes can be produced
5. large tool output is trimmed before entering the envelope
6. telemetry is recorded in a host-neutral schema
7. a host adapter contract exists
8. one reference adapter executes a real host-backed run against real runtime state
9. results and decisions are persisted back through the normal runtime path
10. `ctx run` and `ctx inspect` work against real persisted data
11. stale or interrupted runs are reconciled back into queued retry state
12. duplicate reruns are rejected while an active host lease is present
13. live validation can exercise both bypass-enabled success paths and restricted-mode truthful persistence

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
