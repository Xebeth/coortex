# Runtime State Model

## Purpose

This document defines the core runtime state model for Coortex.

The state model is **host-agnostic**. It must work regardless of whether the active host is Codex, OpenCode, or another compatible environment.

For the longer-term target, see:

- `docs/coortex-ideal-spec.md`
- `docs/coortex-roadmap.md`
- `docs/run-recovery-invariants.md`
- `docs/codex-run-recovery-mapping.md`

---

## Core Entities

## 1. Assignment

An assignment is the smallest durable unit of owned work.

Required fields:

- `id`
- `parent_task_id`
- `workflow`
- `owner_type`
- `owner_id`
- `objective`
- `write_scope`
- `required_outputs`
- `state`
- `created_at`
- `updated_at`

This model must remain independent of any host-specific session identifier format.

## 2. Result Packet

A result packet is the durable artifact for completed or partial work output.

Required fields:

- `result_id`
- `assignment_id`
- `producer_id`
- `status`
- `summary`
- `changed_files`
- `created_at`

The producer may be a solo worker, leader, or host-specific execution unit, but the packet model stays host-neutral.

## 3. Decision Packet

A decision packet captures an unresolved branch or blocker.

Required fields:

- `decision_id`
- `assignment_id`
- `requester_id`
- `blocker_summary`
- `options`
- `recommended_option`
- `state`
- `created_at`

Decision state should be understandable without relying on host-native session text.

## 4. Runtime / Session Status

Runtime/session status is the compact operator-facing summary state.

Suggested fields:

- `active_mode`
- `current_objective`
- `active_assignment_ids`
- `active_host`
- `active_adapter`
- `last_durable_output_at`
- `resume_ready`

## 5. Recovery Brief

The recovery brief is the compact summary used to resume work.

Required contents:

- active objective
- active assignments
- last durable results
- unresolved decisions
- next required action

It must be compact enough to fit inside a bounded task envelope.

## 6. Host Run Record

The host run record is the durable, host-agnostic summary of one
assignment execution attempt.

Required fields:

- `assignment_id`
- `state`
- `started_at`

Common optional fields:

- `heartbeat_at`
- `lease_expires_at`
- `stale_at`
- `stale_reason`
- `completed_at`
- `outcome_kind`
- `result_status`
- `summary`

Host-native identifiers or extra metadata should be treated as adapter
extensions over this base shape rather than part of the core
run-lifecycle model.

---

## Lifecycle

The minimum useful lifecycle remains:

- `queued`
- `in_progress`
- `blocked`
- `completed`
- `failed`

This is sufficient for the first milestone and should be extensible later.

---

## Persistence Requirements

The state model must support:

- append-only event records
- snapshot serialization
- projection rebuild
- recovery-brief derivation
- durable host-run summaries for reconciliation

Representative events:

- assignment created
- assignment updated
- result submitted
- decision created
- decision resolved
- status updated

### Derived persistence artifacts

`events.ndjson` is the authoritative durable log and should remain
append-only during normal read/status/resume inspection paths.

`snapshot.json` and generated recovery artifacts such as
`last-resume-envelope.json` are derived caches. Rewriting them during
resume or projection refresh is acceptable because they summarize
authoritative runtime state rather than replace it.

Malformed-line recovery is best-effort. Recovery may salvage replayable
events in memory, and durable repair paths may rewrite the event log to
preserve replayable events without preserving original byte-for-byte
formatting.

---

## Adapter Relationship

Host adapters may add **mapping metadata** between runtime state and host-native concepts such as sessions, threads, or conversations.

That mapping metadata should not replace the runtime entity model.

The runtime entity model, including the base host-run record, remains
the canonical representation.

---

## Design Invariants

1. Runtime state is authoritative.
2. Recovery state derives from durable runtime artifacts.
3. Host-native session state is adapter-specific metadata, not core truth.
4. Result and decision packets remain durable host-agnostic artifacts.
5. The model must support bounded summaries rather than transcript replay.
