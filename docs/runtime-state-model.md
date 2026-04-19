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

Optional workflow-mode assignment identity may also be stored when an
assignment belongs to a workflow attempt:

- `workflow_attempt.workflow_id`
- `workflow_attempt.workflow_cycle`
- `workflow_attempt.module_id`
- `workflow_attempt.module_attempt`

That identity is durable workflow metadata for convergence and
recovery. It must not be derived from wall-clock ordering heuristics.

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

## 5. Workflow Progress

Workflow progress is the durable runtime-owned checkpoint for workflow
mode.

Required fields:

- `workflow_id`
- `ordered_module_ids`
- `current_module_id`
- `workflow_cycle`
- `current_assignment_id`
- `current_module_attempt`
- `modules`

Common optional fields:

- `last_gate`
- `last_transition`

Module progress entries must be sufficient to recover the current
module, current attempt, durable evidence references, and last gate
evaluation without inferring workflow truth from status text alone.

## 6. Workflow Summary

Workflow summary is a **derived** workflow-facing view, not a durable
record.

It is rebuilt from `WorkflowProgress`, assignments, decisions, results,
and workflow guidance. The runtime exposes it through:

- `TaskEnvelope.workflow` on resume and run surfaces
- `ctx inspect` as the public workflow inspection shape

Common fields:

- `id`
- `current_module_id`
- `current_module_state`
- `workflow_cycle`
- `current_assignment_id`
- `output_artifact`
- `read_artifacts`
- `rerun_eligible`
- `blocker_reason`
- `last_gate_outcome`
- `last_durable_advancement`

This summary must stay derived from durable runtime truth rather than
becoming a second persisted workflow record.

## 7. Recovery Brief

The recovery brief is the compact summary used to resume work.

Required contents:

- active objective
- active assignments
- last durable results
- unresolved decisions
- next required action

It must be compact enough to fit inside a bounded task envelope.

## 8. Host Run Record

The host run record is the durable, host-agnostic summary of one
assignment execution attempt.

Required fields:

- `assignment_id`
- `state`
- `started_at`

Common optional fields:

- `workflow_attempt`
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

For workflow-mode executions, `workflow_attempt` is part of the required
contract, not a best-effort hint. Its durable shape is:

- `workflow_id`
- `workflow_cycle`
- `module_id`
- `module_attempt`

The implementation currently serializes that nested object as
`workflowAttempt` with camelCase child fields in `HostRunRecord`.

Same-assignment reruns must use that explicit attempt identity to
distinguish attempt 1 from attempt 2. Workflow-mode run records that
lack `workflow_attempt` are invalid or incomplete workflow metadata and
must not infer attempt ownership from `started_at`, `completed_at`, or
terminal outcome timestamps.

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
- workflow initialized
- workflow artifact claimed
- workflow gate recorded
- workflow transition applied
- status updated

### Derived persistence artifacts

`events.ndjson` is the authoritative durable log and should remain
append-only during normal status, resume, inspect, and run paths.

Workflow-aware load/reconcile may append convergence events during those
operator commands when durable state already implies missing workflow
gates, transitions, assignments, or workflow-derived status. It must do
so by appending new events, not by rewriting prior history.

`snapshot.json` and generated recovery artifacts such as
`last-resume-envelope.json` are derived caches. Rewriting them during
resume, recovered-run handling, or projection refresh is acceptable
because they summarize authoritative runtime state rather than replace
it.

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
