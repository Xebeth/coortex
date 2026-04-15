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

`current_objective` should follow the most actionable durable runtime
state. When a decision becomes the active state, the status should move
off the pre-decision assignment objective and reflect the blocker
summary or a newer runtime-authored decision-specific objective.

## 5. Recovery Brief

The recovery brief is the compact summary used to resume work.

Required contents:

- active objective
- active assignments
- last durable results
- unresolved decisions
- next required action

It must be compact enough to fit inside a bounded task envelope.

## 6. Runtime Attachment

A runtime attachment is the runtime-owned record for a Coortex-managed
host session.

Required fields:

- `id`
- `adapter`
- `host`
- `state`
- `created_at`
- `updated_at`
- `provenance`

Common optional fields:

- `native_session_id`
- `attached_at`
- `detached_at`
- `released_at`
- `released_reason`
- `orphaned_at`
- `orphaned_reason`

The native host session identifier is attachment metadata over this
runtime-owned entity. It must not become the sole source of attachment
truth.

For Milestone 2 reclaim semantics:

- `attached` means the current wrapped launch or wrapped resume has
  verified control of the native session
- a wrapped resume that exits without a terminal runtime outcome moves
  the attachment back to `detached_resumable`
- wrapped launch and wrapped resume both durably capture result or
  decision outcomes through the same runtime-owned event path
- `provisional` is not authoritative resumable truth until runtime
  reconciliation can promote it

## 7. Assignment Claim

An assignment claim binds live execution authority to an attachment.

Required fields:

- `id`
- `assignment_id`
- `attachment_id`
- `state`
- `created_at`
- `updated_at`
- `provenance`

Common optional fields:

- `released_at`
- `released_reason`
- `orphaned_at`
- `orphaned_reason`

Milestone 2 keeps the claim rule narrow:

- at most one active claim may exist per assignment
- at most one authoritative attached or detached-but-resumable
  attachment may exist per runtime

## 8. Host Run Record

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

- runtime initialized
- host setup completed
- runtime activated
- assignment created
- assignment updated
- attachment created
- attachment updated
- claim created
- claim updated
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

`prepareResumeRuntime()` is part of that derived-artifact surface. It
may refresh telemetry or the generated resume envelope, but it must not
repair or normalize authoritative runtime truth.

When recovery has to operate from snapshot truth because the event log is
missing or unusable, recovery-side attachment normalization or reclaim
may update `snapshot.json` directly rather than fabricating a truncated
replacement event log.

When one command performs multiple snapshot-fallback mutations, each
later mutation must start from the projection produced by the earlier
durable write rather than from the stale pre-write projection loaded at
command start.

Malformed-line recovery is best-effort. Recovery may salvage replayable
events in memory, and durable repair paths may rewrite the event log to
preserve replayable events without preserving original byte-for-byte
formatting.

---

## Adapter Relationship

Host adapters may add **mapping metadata** between runtime state and
host-native concepts such as sessions, threads, or conversations.

That mapping metadata should not replace the runtime entity model.

The runtime entity model, including attachments, claims, and the base
host-run record, remains the canonical representation.

---

## Design Invariants

1. Runtime state is authoritative.
2. Recovery state derives from durable runtime artifacts.
3. Attachment truth, claim truth, and provenance are runtime-owned.
4. Host-native session state is adapter-specific metadata, not core truth.
5. Host-run records remain attempt-level artifacts, not attachment authority.
6. Result and decision packets remain durable host-agnostic artifacts.
7. The model must support bounded summaries rather than transcript replay.
