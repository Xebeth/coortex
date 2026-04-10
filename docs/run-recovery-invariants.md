# Run Recovery Invariants

## Purpose

This document defines the current invariants for Coortex's run-lifecycle
and recovery behavior.

It is intentionally narrower than the full architecture documents. The
goal is to make the Milestone 2 execution and recovery paths explicit
enough that code review and test coverage can check the same model.

Related documents:

- `docs/runtime-state-model.md`
- `docs/architecture.md`
- `docs/telemetry.md`
- `docs/implementation-phases.md`

---

## Core rule

For one assignment, Coortex must expose at most one authoritative host
run state at a time.

That state is derived from:

1. runtime event log and snapshot
2. adapter-owned run record metadata
3. adapter-owned lease metadata

The runtime owns assignment truth. Adapter artifacts only explain the
current host-run situation well enough to reconcile runtime truth after
interruption.

---

## Artifacts

For the Codex adapter, the relevant durable artifacts are:

- `.coortex/runtime/events.ndjson`
- `.coortex/runtime/snapshot.json`
- `.coortex/adapters/codex/runs/<assignment>.json`
- `.coortex/adapters/codex/runs/<assignment>.lease.json`
- `.coortex/adapters/codex/last-run.json`

### Artifact roles

- `events.ndjson`
  Authoritative append-only runtime log during normal operation.

- `snapshot.json`
  Authoritative durable fallback for operator recovery when event replay
  is malformed or incomplete.

- `runs/<assignment>.json`
  Durable host-run metadata for inspection and reconciliation.

- `runs/<assignment>.lease.json`
  Exclusivity primitive for active host execution. It is authoritative
  only while the run is actually active.

- `last-run.json`
  Convenience pointer for the most recent inspected host run. It is not
  an exclusivity primitive.

---

## Run-state precedence

For `inspect`, `status`, `resume`, and `run` reconciliation, the current
effective host-run state follows these rules:

1. A valid completed run record wins over a malformed lease artifact.
2. A valid running lease wins over a running or stale run record.
3. A lease-less running record is treated as stale.
4. A running record with a missing or invalid lease expiry is treated as
   stale.
5. A running record with an expired lease is treated as stale.
6. A malformed lease with no valid completed run record is treated as
   stale running state so reconciliation can clear it.

---

## Lease invariants

### Claim

- Lease acquisition must happen before Coortex mutates runtime state for
  a new run.
- Initial lease creation must be atomic.
- Claim-time metadata failure must not leave a live lease behind.

### Running updates

- While a run is active, the lease sidecar must be updated before the
  derived run record so concurrent inspection does not observe older
  lease state than the run record implies.
- Heartbeat persistence failure is fatal because lease freshness is part
  of duplicate-run protection.

### Completion

- Once a run is no longer active, queued heartbeat callbacks must not be
  able to rewrite the run back to `running`.
- For non-running terminal writes, the lease sidecar must be removed
  before the completed run record becomes visible.
- Lease cleanup is mandatory even when final run-record persistence
  degrades to a warning.

---

## Runtime reconciliation invariants

### Stale-run reconciliation

When an active lease is stale, reconciliation must:

1. rewrite the host run record to a non-running stale-completed state
2. remove the lease sidecar
3. move the assignment back to `queued`
4. update runtime status from the latest projection, not the original
   one from the beginning of reconciliation
5. emit stale-run reconciliation telemetry

The operation must be idempotent. Re-running `status`, `resume`, or
`run` after reconciliation must not repeatedly requeue the same stale
run.

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
3. do not rewrite `events.ndjson` when an existing snapshot is the
   safer durable source

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

The test suite should explicitly cover:

- valid running lease
- expired running lease
- missing lease expiry
- invalid lease expiry
- malformed lease with no run record
- malformed lease with completed run record
- lease-only stale state
- completed record with leftover running lease
- concurrent run attempts
- queued heartbeat after completion
- claim-time metadata failure
- final metadata persistence degradation
- malformed event tail after snapshot
- malformed suffix that replays cleanly after snapshot
- malformed suffix that does not replay after snapshot
- strict rebuild failure on malformed event logs

New recovery changes should extend this matrix rather than rely on
ad-hoc regressions alone.
