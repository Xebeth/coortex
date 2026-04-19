# Architecture

## Purpose

This document describes the system-level architecture of Coortex.

Coortex is a **host-agnostic coordination core** with **host-specific adapters**. It is designed to work with coding-assistant hosts such as Codex, OpenCode, or other compatible environments through explicit adapter seams.

For the full target design, see:

- `docs/coortex-ideal-spec.md`
- `docs/coortex-roadmap.md`

---

## Governing Rule

The architectural rule for Coortex is:

**The runtime coordinates. Persistence recovers. Host adapters integrate execution.**

This rule keeps coordination truth out of host-specific prompt/session behavior.

---

## Architectural Layers

Coortex is organized into these layers:

1. CLI / operator layer
2. core runtime
3. persistence and projections
4. recovery and reconciliation
5. workflow modules
6. adapter contracts
7. host adapters
8. guidance and artifact store
9. verification subsystem
10. telemetry subsystem
11. optional extension layers (hooks/plugins/backends)

---

## 1. Core Runtime

The core runtime is the source of truth for:

- assignments
- runtime attachments
- attachment-bound claims
- result packets
- decision packets
- lifecycle state
- ownership/claims
- init/setup/activation provenance
- recovery state
- verification state

The core runtime must remain independent of any specific host.

---

## 2. Persistence and Projections

The persistence layer stores durable artifacts:

- append-only event log
- snapshots
- durable records

Projections derive query-friendly views:

- current assignment views
- status summaries
- recovery inputs
- telemetry rollups

The event log is authoritative. Projections are rebuildable.
Serialized path locks that guard event-log, snapshot, and lease writes
must be crash-recoverable so dead processes cannot wedge later recovery.
Those locks must verify the holder's process identity, not just PID
liveness, before treating an existing lock as still owned. Missing
owner metadata may be crash-recovered, but unreadable owner identity is
not stale-owner proof: that case must fail closed or retry rather than
reap a possibly live holder.

---

## 3. Recovery

Recovery rebuilds actionable current state after interruption.

Responsibilities:

- load durable state
- reconcile current view
- handle stale claims/leases
- generate a compact recovery brief
- prefer same-session reclaim before orphan/requeue when the host supports it
- treat snapshot-only state as non-event-backed truth and avoid
  recreating truncated authority from it

Recovery must not depend on transcript replay.

Runtime-owned attachment and claim transitions should enter through one
shared lifecycle mutation facility. Commands and recovery may decide
when authority needs to change, but they should not hand-build separate
launch, reclaim, and recovery mutation rules beside each other.

---

## 4. Workflows

Workflows define policy, not truth.

Examples:

- `plan`
- `team`
- `review`
- `verify`
- optional persistent completion workflows

Workflow modules may define:

- phases
- assignment emission
- completion conditions
- workflow-specific recovery hints

The runtime core remains authoritative for state.

---

## 5. Adapter Contracts

An adapter contract defines what a host integration must provide.

A host adapter should expose at least:

- wrapped launch/resume integration
- bounded task-envelope injection
- result/decision capture
- telemetry extraction or normalization
- lifecycle event integration, including native session identity callbacks
- capability reporting

Host adapters must not redefine runtime truth.

---

## 6. Host Adapters

A host adapter is the bridge between Coortex and a specific coding-assistant host.

Possible hosts:

- Codex
- OpenCode
- Claude Code
- other future compatible environments

The first implementation milestone uses a **reference adapter** rather than trying to support all hosts immediately.

A host adapter may use:
- profiles/config
- host hooks
- host plugin systems
- session APIs
- host-native commands
- host-native telemetry surfaces

But those are adapter concerns, not core-runtime concerns.

---

## 7. Guidance and Artifact Store

Guidance is not part of live runtime truth.

The guidance/artifact layer stores and retrieves:

- project conventions
- commands
- codebase map fragments
- architecture notes
- large tool outputs
- verification artifacts
- summaries and references

The prompt-facing path should carry compact summaries or references rather than large raw blobs.

---

## 8. Verification

Verification is explicit and durable.

Responsibilities:

- verification requirements
- evidence records
- completion gates
- waivers or override records in later phases

Verification should be host-agnostic.

---

## 9. Telemetry

Telemetry is a first-class subsystem.

Responsibilities:

- lifecycle telemetry
- usage/token telemetry where available
- envelope/trimming telemetry
- latency and recovery telemetry in later phases
- host-neutral normalization of host-native telemetry

Telemetry should be useful without becoming correctness-critical.

---

## 10. Extension Layers

Optional extension layers include:

- hooks integration
- plugin packaging
- execution backends
- guidance providers

These layers may extend behavior, but they must not replace:

- runtime truth
- persistence truth
- recovery truth
- verification truth

---

## First-Milestone Architecture Slice

The first implementation slice should include:

- core runtime
- persistence
- projections
- recovery
- telemetry scaffold
- adapter contract
- one reference host adapter
- bounded task-envelope builder
- trimming

It should not attempt to complete all later-phase layers.

---

## Data Flow

### Normal path
1. CLI or operator triggers an action.
2. Runtime creates or updates task state.
3. State is persisted durably.
4. Projections rebuild current views.
5. Recovery summary can be generated when needed.
6. Adapter builds a bounded envelope for the host.
7. Host executes and returns results or blockers.
8. Adapter normalizes results back into runtime artifacts.
9. Telemetry records what happened.

### Recovery path
1. Load persisted state.
2. Rebuild projections.
3. Determine actionable current state.
4. Generate compact recovery brief.
5. Provide that brief through the adapter as needed.

---

## Architectural Invariants

1. Runtime state is authoritative.
2. Host adapters are not authoritative.
3. Prompts or kernel instructions stay small and stable.
4. Recovery is based on durable state.
5. Task context is intentionally bounded.
6. Trimming is part of the architecture, not optional polish.
7. Telemetry is normalized into a Coortex schema.
