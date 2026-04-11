# Run Recovery Invariants

## Purpose

This document defines the host-agnostic invariants for Coortex's
run-lifecycle and recovery behavior.

It describes the contract the runtime and host adapters must preserve,
independent of any particular host CLI or on-disk adapter layout.

In the current implementation:

- `core` owns the base host-run state model and generic run-state rules
- `recovery` owns pure stale-run derivation and brief-shaping logic
- `cli` owns persistence orchestration when reconciliation mutates
  durable state
- `adapters` owns shared host-run record and lease-backed persistence
  helpers plus shared execution-session coordination
- host adapters supply host-specific metadata parsing and execution
  behavior on top of that shared infrastructure

Host adapters are expected to supply metadata and execution behavior,
not redefine reconciliation policy.

Adapters must expose explicit hooks for:

- lease claim before execution
- lease release for abandoned pre-launch claims
- stale-run artifact reconciliation after runtime state is durably
  updated

Related documents:

- `docs/runtime-state-model.md`
- `docs/architecture.md`
- `docs/telemetry.md`
- `docs/implementation-phases.md`
- `docs/codex-run-recovery-mapping.md`

---

## Core rule

For one assignment, Coortex must expose at most one authoritative host
run state at a time.

That state is derived from:

1. runtime event log and snapshot
2. adapter-owned durable run metadata
3. adapter-owned active lease metadata

The runtime owns assignment truth. Adapter artifacts only describe the
host-run situation well enough to reconcile runtime truth after
interruption or host failure.

The base host-run record is runtime-owned. Adapter-specific fields, if
needed, should layer on top rather than changing the generic
run-lifecycle semantics.

---

## Artifact roles

Every adapter must provide durable artifacts with these roles:

- runtime event log
  Authoritative append-only runtime log during normal operation.

- runtime snapshot
  Authoritative durable fallback for operator recovery when event replay
  is malformed or incomplete.

- per-assignment run record
  Durable host-run metadata for inspection and reconciliation.

- per-assignment active lease
  Exclusivity primitive for active host execution. It is authoritative
  only while the run is actually active.

- last-run pointer
  Convenience pointer for the most recently inspected host run. It is
  not an exclusivity primitive.

Adapters may realize those roles with different filenames or storage
backends, but the role semantics must stay consistent.

Shared host-run infrastructure must depend on those artifact roles
through the artifact-store contract, not by hardcoding a specific
filesystem layout.

---

## Run-state precedence

For `inspect`, `status`, `resume`, and `run` reconciliation, the current
effective host-run state follows these rules:

1. A valid completed run record wins over active-lease metadata for the
   same assignment, including malformed or stale leftover leases.
2. Valid active-lease metadata wins over running or stale run-record
   metadata.
3. A lease-less running record is treated as stale.
4. A running record with a missing or invalid lease expiry is treated as
   stale.
5. A running record with an expired lease is treated as stale.
6. Malformed active-lease metadata with no valid completed run record is
   treated as stale running state so reconciliation can clear it.

---

## Lease invariants

### Claim

- Lease acquisition must happen before Coortex mutates runtime state for
  a new run.
- Initial lease creation must be atomic.
- Claim-time metadata failure must not leave a live lease behind.

### Running updates

- While a run is active, lease metadata must be refreshed before derived
  run metadata so concurrent inspection does not observe older lease
  state than the run record implies.
- Heartbeat persistence failure is fatal because lease freshness is part
  of duplicate-run protection.

### Completion

- Once a run is no longer active, queued heartbeat callbacks must not be
  able to rewrite the run back to `running`.
- For non-running terminal writes, active-lease metadata must be removed
  before the completed run record becomes visible.
- Lease cleanup is mandatory even when final run-record persistence
  degrades to a warning.

---

## Runtime reconciliation invariants

### Stale-run reconciliation

When an active lease is stale, reconciliation must:

1. rewrite the host run record to a non-running stale-completed state
2. remove the active lease
3. move the assignment back to `queued`
4. update runtime status from the latest projection, not the original
   one from the beginning of reconciliation
5. emit stale-run reconciliation telemetry

The operation must be idempotent. Re-running `status`, `resume`, or
`run` after reconciliation must not repeatedly requeue the same stale
run.

Runtime events and snapshot updates must become durable before adapter
artifacts are rewritten to their reconciled stale-completed form.

### Completed-run reconciliation

If a host adapter has already durably recorded a terminal outcome but
runtime event persistence fails afterward, the next `status`, `resume`,
or `run` must reconcile that completed host run back into runtime truth
instead of ignoring it as inert metadata.

If a completed run record and a leftover lease both exist for the same
assignment, the completed run record wins whether the leftover lease is
still active, already expired, or malformed. Recovery must absorb the
terminal outcome into runtime truth and then clear the leftover lease;
it must not requeue the assignment or fall back to stale-run handling.

Completed-run reconciliation must be idempotent. Once the runtime has
absorbed the terminal result or decision, later commands must not
replay it again.

### Command consistency

- `ctx status`
  Must show the same stale-run-reconciled state that `ctx resume` and
  `ctx run` would see.

- `ctx resume`
  Must build its brief from reconciled runtime state.

- `ctx run`
  Must refuse execution if a valid active lease is present.
  When multiple active assignments exist, it must build the envelope and
  recovery brief from the assignment actually being executed.

---

## Event-log recovery invariants

### Strict vs best-effort APIs

- `rebuildProjection()`
  Strict. Malformed events are errors.

- `loadProjectionWithRecovery()`
  Best effort. It may salvage replayable events and use the snapshot as
  a recovery boundary.

### Snapshot boundary rule

If a snapshot exists and the event log is malformed:

1. try to rebuild from the snapshot plus replayable events after the
   snapshot's `lastEventId`
2. if that suffix replay fails, fall back to the snapshot
3. do not rewrite the authoritative event log when an existing snapshot
   is the safer durable source

The goal is to preserve the latest durable state without silently
rolling back to an older salvaged projection.

---

## CLI exit semantics

- `ctx run` returns exit code `0` for completed or blocked/decision
  outcomes that were durably recorded.
- `ctx run` returns non-zero when the persisted result status is
  `failed`.
- diagnostics must not silently hide operator-relevant failures in the
  main execution or cancellation paths.

---

## Test matrix expectation

The repository now includes an explicit shared host-run matrix for
inspection precedence and reconciliation semantics, plus focused
adapter and persistence matrices for host-specific lifecycle behavior
and event-log recovery behavior.

Together, those explicit suites represent the supported contract below.
New recovery changes should extend one of those matrices rather than
rely on ad-hoc regressions alone.

The test suite should explicitly cover:

- valid active lease
- expired active lease
- missing lease expiry
- invalid lease expiry
- malformed lease with no run record
- malformed lease with completed run record
- lease-only stale state
- completed record with leftover lease recovered into runtime truth
- concurrent run attempts
- queued heartbeat after completion
- claim-time metadata failure
- final metadata persistence degradation
- malformed event tail after snapshot
- malformed suffix that replays cleanly after snapshot
- malformed suffix that does not replay after snapshot
- strict rebuild failure on malformed event logs
