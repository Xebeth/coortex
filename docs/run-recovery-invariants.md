# Run Recovery Invariants

## Purpose

This document defines the host-agnostic invariants for Coortex's
run-lifecycle and recovery behavior.

It describes the contract the runtime and host adapters must preserve,
independent of any particular host CLI or on-disk adapter layout.

In the current implementation:

- `core` owns the base host-run state model and generic run-state rules
- `recovery` owns pure stale-run derivation and brief-shaping logic
- `workflows` owns workflow progression, gate evaluation, assignment
  shaping, and workflow summary derivation from normalized runtime truth
- `cli` owns the shared workflow-aware load/reconcile seam and
  persistence orchestration when reconciliation mutates durable state
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
- `docs/coortex-roadmap.md`
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

1. A completed run record with durable `terminalOutcome` data wins over
   active-lease metadata for the same assignment, including malformed or
   stale leftover leases.
2. Valid active-lease metadata wins over stale run-record metadata,
   including stale-completed records and running records whose lease
   state is expired, missing, or invalid.
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
- If rollback cleanup cannot remove the claimed lease, the claim must
  fail loudly; it must not silently degrade into a phantom active lease.

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
- Warning-only degradation is allowed only after lease cleanup is
  confirmed. If lease cleanup fails, the command must surface a stronger
  persistence failure than a normal warning.

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

Idempotence is a runtime-state guarantee, not a `currentObjective`
string check. Once runtime events have durably moved the assignment back
to `queued`, later benign `status.updated` drift must not cause the same
stale host run to be requeued again.

This idempotence applies to the same stale host-run instance. A later
fresh retry claim that acquires a new lease epoch or run instance and
then goes stale must emit a new stale reconciliation.

Runtime events and snapshot updates must become durable before adapter
artifacts are rewritten to their reconciled stale-completed form.

### Completed-run reconciliation

If a host adapter has already durably recorded a terminal outcome but
runtime event persistence fails afterward, the next `status`, `resume`,
or `run` must reconcile that completed host run back into runtime truth
instead of ignoring it as inert metadata.

If a completed run record and a leftover lease both exist for the same
assignment, the completed run record wins whether the leftover lease is
still active, already expired, missing an expiry, invalid, or malformed.
Recovery must absorb the terminal outcome into runtime truth and then
clear the leftover lease; it must not requeue the assignment or fall
back to stale-run handling.

Completed-run reconciliation must be idempotent. Once the runtime has
absorbed the terminal result or decision, later commands must not
replay it again. Later runtime progression, including resolved
decisions and updated status text, must not regenerate a previously
absorbed `result.submitted` or `decision.created`.

In workflow mode, if durable runtime truth for the current assignment
already contains the recovered terminal result or decision, malformed or
stale leftover run metadata is cleanup-only. Recovery must clear the
adapter artifacts without requeueing through stale-run handling and
without appending a duplicate recovered outcome event.

For workflow-mode run records, same-assignment rerun ownership must use
explicit durable attempt identity:

- `workflowId`
- `workflowCycle`
- `moduleId`
- `moduleAttempt`

That identity must be present on workflow-mode run records and leases.
It is the ownership discriminator for recovery, inspect visibility,
active-lease classification, and cleanup. `startedAt`, `completedAt`,
`staleAt`, and terminal outcome `createdAt` remain lifecycle metadata
only; they must not be used to infer which workflow attempt owns a
workflow-mode run record.

If a workflow-mode run record for the current assignment lacks explicit
attempt identity, the runtime must treat it as invalid or incomplete
workflow metadata. It may clean the leftover artifacts, but it must not
recover the outcome, block the current attempt as active, or infer
same-assignment rerun ownership from timestamps.

Completed run records without durable `terminalOutcome` data are
degraded metadata only. `inspect` may surface them, but `status`,
`resume`, and `run` must not treat them as recoverable terminal
outcomes. They do not outrank a valid active lease and do not reconcile
runtime truth on their own.

### Workflow-aware load and convergence

When `workflowProgress` is present, `status`, `resume`, `inspect`, and
`run` must converge through the same workflow-aware load path.

That path must:

1. recover completed or stale host-run state for the current workflow
   assignment
2. evaluate workflow gates and transitions from durable runtime truth
3. append only the missing workflow, assignment, or status events
   strictly implied by that truth
4. stop once replayed state is converged

Repeated load calls against already converged workflow state must not
append duplicate workflow events, recover the same outcome twice, create
duplicate queued reruns, or emit repeated reconciliation diagnostics for
the same recovered host run.

Hidden stale workflow artifacts for non-current assignments are
cleanup-only. They must not be reported as a queued rerun or counted as
`host.run.stale_reconciled` telemetry unless durable runtime state for
the current assignment actually reflects a requeue. Operator warnings
and telemetry for that path must describe hidden artifact cleanup
truthfully.

When stale-run or hidden-cleanup artifact rewriting clears the lease but
still returns a non-terminal persistence warning, the command must keep
that warning and still treat the cleanup as successful for reconciliation
diagnostics and telemetry. A warning must not make the runtime behave as
though the cleared lease were still present.

When workflow mode is active, workflow-derived status is authoritative
over later ad hoc status drift. The shared load path must re-sync
operator-facing status from workflow truth when those views diverge.

### Command consistency

- `ctx status`
  Must show the same reconciled state that `ctx resume` and `ctx run`
  would see, including stale-run and completed-run reconciliation.

- `ctx inspect`
  Must read through the same workflow-aware load path and may return
  workflow context even when no current host run is available. In
  workflow mode, it must prefer the workflow-owned inspect target,
  including a completed terminal assignment, over the convenience
  last-run pointer.

- `ctx resume`
  Must build its brief from reconciled runtime state.

- `ctx run`
  Must refuse execution if a valid active lease is present.
  When multiple active assignments exist, it must build the envelope and
  recovery brief from the assignment actually being executed.
  In workflow mode, it must execute only the current workflow
  assignment. When workflow truth has no runnable current assignment,
  it must surface the workflow's derived next action or completion
  guidance instead of a generic missing-assignment error.

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
- valid active lease blocks `ctx run`
- valid active lease overrides stale run-record metadata
- `ctx run` narrows multi-active execution to the runnable assignment
- lease removed before completed record becomes visible
- claim rollback cleanup failure is surfaced
- expired active lease
- missing lease expiry
- invalid lease expiry
- malformed lease with no run record
- malformed lease with completed run record
- lease-only stale state
- stale reconciliation clears the lease artifact
- stale-run reconciliation is idempotent across `status`, `resume`, and
  `run`
- a later fresh stale retry emits a new stale reconciliation
- multiple stale leases preserve latest status updates
- final non-running persistence only degrades to a warning after lease
  cleanup succeeds
- completed record with leftover lease recovered into runtime truth
- completed record with malformed leftover lease recovered into runtime
  truth
- durable completed decision recovered into runtime truth
- durable completed decision recovered at the command surface
- stale and completed reconciliation are visible through the command
  surfaces that own them
- completed-run recovery is idempotent for results and decisions
- outcome-less completed metadata does not drive completed-run
  reconciliation
- concurrent run attempts
- heartbeat persistence failure ends the run
- queued heartbeat after completion
- claim-time metadata failure
- final metadata persistence degradation
- malformed event tail after snapshot
- malformed suffix that replays cleanly after snapshot
- malformed suffix that does not replay after snapshot
- strict rebuild failure on malformed event logs
