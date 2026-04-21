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
- verified same-session resume callbacks or result surfaces that let the
  runtime reject foreign reclaim and persist wrapped-resume outcomes

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
  Durable host-run metadata for inspection and reconciliation. The
  payload assignment id must match the assignment identity implied by
  the artifact path.

- per-assignment active lease
  Exclusivity primitive for active host execution. It is authoritative
  only while the run is actually active. The payload assignment id must
  match the assignment identity implied by the artifact path.

- last-run pointer
  Convenience pointer for the most recently inspected host run. It is
  not an exclusivity primitive.

Adapters may realize those roles with different filenames or storage
backends, including layouts where the assignment id lives in a
directory segment instead of the basename, but the role semantics must
stay consistent.

Shared host-run infrastructure must depend on those artifact roles
through the artifact-store contract, not by hardcoding a specific
filesystem layout.

---

## Run-state precedence

For `inspect` materialization and for `status`, `resume`, and `run`
reconciliation, the current effective host-run state follows these
rules:

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
7. Shared inspection materialization must preserve that malformed-lease
   blocker by default; callers must not need an opt-in flag to see the
   same precedence that `status`, `resume`, and `run` rely on. Running
   records must keep that malformed blocker truth instead of collapsing
   to a generic missing-lease state.

---

## Lease invariants

### Claim

- Lease acquisition must happen before Coortex mutates runtime state for
  a new run.
- Lease-only host state may block duplicate launch or resume selection,
  but it does not become runtime-owned attachment or claim truth.
- When one runtime mutation creates or updates attachment-and-claim
  authority together, those runtime events must be durably appended as
  one batch. A persistence failure must not strand only half of the
  authority pair.
- Shared host-run cleanup helpers and live running writes must refuse
  to cross a newer live owner fence. If a durable `runInstanceId` proof
  exists for the current live lease or running record, destructive
  cleanup and running-state refreshes must present the same fence before
  deleting or overwriting the artifacts, and lease mutation must still
  confirm the same boundary at the write/cas step.
- Runtime event batches must flow through the serialized append-only
  store boundary. Event-log repair may rewrite malformed logs, but it
  must use the same mutation boundary so concurrent runtime batches
  cannot be overwritten by stale whole-file replacement.
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
- Wrapped reclaim failure must not clear authoritative attachment truth
  before host cleanup has been proved.
- Reclaimed terminal resume finalization must rebuild the full
  operator-facing envelope from final projection truth, including top-
  level recent-results and trim metadata, rather than patching a
  pre-transition envelope.
- Provisional-authority cleanup may clear provisional attachment truth
  before host cleanup finishes, but it must not surface queued retry
  truth unless lease cleanup has been proved.

---

## Runtime reconciliation invariants

### Stale-run reconciliation

When an active lease is stale, reconciliation must:

1. orphan any active attachment and claim authority for that assignment
2. move the assignment back to `queued`
3. update runtime status from the latest projection, not the original
   one from the beginning of reconciliation
4. durably persist that runtime recovery state before clearing host-run
   artifacts
5. rewrite the host run record to a non-running stale-completed state
   and remove the active lease
6. emit stale-run reconciliation telemetry

The operation must be idempotent. Re-running `status`, `resume`, or
`run` after reconciliation must not repeatedly requeue the same stale
run.

Idempotence is a runtime-state guarantee keyed to a durable host-run
instance identity, not a `currentObjective` string check or timestamp
heuristic. Once runtime events have durably moved the assignment back to
`queued`, later benign `status.updated` drift must not cause the same
stale host run to be requeued again.

This idempotence applies to the same stale host-run instance. A later
fresh retry claim that acquires a new lease epoch or run instance and
then goes stale must emit a new stale reconciliation.

If the adapter record has no durable per-attempt `runInstanceId`, stale
reconciliation must mint one durable stale identity and persist it into
the stale-completed record plus runtime stale markers before reusing it
for idempotence. Native session ids, timestamps, and hashed record
fingerprints are diagnostic only; they are not authoritative stale-run
identities.

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

If the recovered assignment still has active attachment/claim authority,
completed-run reconciliation must finalize that authority through the
same stateful repair surface used by wrapped launch/resume finalization:
recovered terminal results release attachment/claim authority, while
recovered decisions and recovered partial results keep the active claim
and detach active attached authority back to `detached_resumable`.
When this happens through live wrapped reclaim, attachment/claim
provenance must move to `resume`; when it happens through reconciliation,
attachment/claim provenance must move to `recovery`.
If the active binding is still `provisional` but the completed host run
contains a durable native session id, reconciliation must promote that
binding into `detached_resumable` authority before provisional cleanup
can treat it as abandoned launch state.
If the active binding is already `detached_resumable` but missing a
stored native session id, completed-run reconciliation must backfill
that id from durable host metadata before leaving the claim resumable.

Completed-run reconciliation must be idempotent. Once the runtime has
absorbed the terminal result or decision, later commands must not
replay it again. Later runtime progression, including resolved
decisions and updated status text, must not regenerate a previously
absorbed `result.submitted` or `decision.created`.
When a recovered terminal decision is already resolved, the recovered
decision packet must preserve its durable resolution metadata
(`resolvedAt` and `resolutionSummary`) instead of degrading that
history to a bare resolved flag.

Completed run records without durable `terminalOutcome` data are
degraded metadata only. `inspect` may surface them, but `status`,
`resume`, and `run` must not treat them as recoverable terminal
outcomes. They do not outrank a valid active lease and do not reconcile
runtime truth on their own.

### Command consistency

- `prepareResumeRuntime()`
  Must stay read-only over authoritative runtime truth. It must not
  emit telemetry, rewrite derived envelope artifacts, synthesize
  attachments or claims, reconcile stale or completed runs, or
  otherwise mutate runtime-owned authority.

- `loadReconciledProjectionWithDiagnostics()`
  Is a stateful repair surface. `ctx status`, `ctx run`, and
  `ctx resume` may use it when they promise reconciled runtime truth,
  but read-only preparation paths must not.

- `ctx inspect`
  Must stay read-only over runtime-owned authority. It may pair
  adapter-owned host-run metadata with matching runtime attachment
  context from operator projection, but it must not reconcile stale or
  completed runs, synthesize new attachment truth, or silently rewrite
  runtime state. It must also fail closed if the runtime attachment or
  claim graph is malformed rather than silently omitting broken
  authority edges from the inspection view.

- `ctx status`
  Must show the same reconciled state that `ctx resume` and `ctx run`
  would see, including stale-run and completed-run reconciliation.
  Reported active host leases must come from post-repair host state, not
  from a pre-cleanup lease scan.

- `ctx resume`
  Must build its brief from reconciled runtime state.
  It may attempt wrapped same-session reclaim only when the targeted
  authoritative attachment still carries a stored native session id.
  While wrapped reclaim is in flight, it must hold the same lease-backed
  host-run boundary as `ctx run`.
  That boundary must be acquired atomically inside the adapter /
  host-run store surface, including reclaim of an already-live eligible
  lease. If reclaim adopts an already-live eligible lease, that takeover
  must mint a new durable run-owner fence and later heartbeat,
  completion, rollback, destructive terminal lease cleanup, and
  degraded terminal-warning cleanup writes must prove that adopted
  fence instead of relying only on the initial takeover CAS. Terminal
  cleanup must not fall back to an unfenced plain delete once lease
  ownership has been proved. Freshly minted stale-run ids from degraded
  reconciliation are valid for stale-run idempotence, but they do not
  by themselves authorize deletion of a newer adopted live lease.
  Failure to acquire that boundary because another reclaim already owns
  it is duplicate blocking, not reclaim failure; it must not orphan or
  requeue the current authoritative attachment/claim.
  Wrapped reclaim failures must distinguish `verified_then_failed` from
  `unverified_failed`: once the requested native session has been
  verified, later persistence failure must preserve that proof for
  runtime-owned cleanup and recovery instead of collapsing back to a
  foreign/unverified failure shape.
  When wrapped same-session reclaim is verified, it must persist result
  or decision outcomes through the same normalized runtime-event path as
  `ctx run`.

- `ctx run`
  Must refuse execution if a valid active lease is present.
  When multiple active assignments exist, it must build the envelope and
  recovery brief from the assignment actually being executed.

- `ctx run` and verified wrapped `ctx resume`
  Are two entrypoints into the same runtime-owned execution lifecycle.
  They must stay aligned on outcome normalization, attachment and claim
  finalization, operator-visible status progression, and durable
  telemetry semantics. The only intentional extra guard on `ctx resume`
  is same-session identity verification against an existing
  authoritative attachment.
  The same alignment applies when completed host runs are recovered:
  recovered decisions and recovered partial results must preserve the
  active claim and detach active attached authority back to
  `detached_resumable`, while only recovered terminal results may
  release attachment/claim authority. The same non-terminal rule
  applies when a durable native session id exists only on a provisional
  binding's host-run metadata: recovery must promote that binding into
  detached resumable authority instead of orphaning it. If the binding
  is already detached but missing that id, recovery must backfill it
  from durable host metadata before wrapped reclaim is considered
  available again.
  They must also use the same runtime policy inputs for approval,
  sandbox, and bypass behavior. If the host imposes different baseline
  launch and resume CLI modes, that difference must be explicit and
  documented rather than copied accidentally from launch defaults.

- `ctx run` and `ctx resume`
  When a new or recovered decision becomes the active state, the
  operator-facing `currentObjective` must stop pointing at stale
  pre-decision work and instead reflect the blocker summary unless the
  runtime already has newer decision-specific status text. Once that
  decision is resolved, lifecycle synthesis must restore runnable
  assignment truth instead of persisting blocked state.

---

## Event-log recovery invariants

### Strict vs best-effort APIs

- `rebuildProjection()`
  Strict. Malformed events are errors.

- `loadProjectionWithRecovery()`
  Best effort. It may salvage replayable events and use the snapshot as
  a recovery boundary.

### Snapshot boundary rule

If a snapshot exists and the event log is malformed, truncated, or no
longer contains the snapshot boundary:

1. try to rebuild from the snapshot plus replayable events after the
   snapshot's `lastEventId`
2. if that suffix replay fails or the boundary is missing, fall back to
   the snapshot
3. if no snapshot exists, full replay is valid only when the replayable
   log still starts at `runtime.initialized`
4. do not rewrite the authoritative event log when an existing snapshot
   is the safer durable source

A clean but semantically invalid suffix, such as an assignment update
whose assignment is absent from snapshot truth, still counts as suffix
replay failure and must fail closed to the snapshot.

The goal is to preserve the latest durable state without silently
rolling back to an older salvaged projection.

### Snapshot-fallback write-base rule

When recovery is writing directly to `snapshot.json` because snapshot
truth is authoritative:

1. each later write in the same command must use the projection returned
   by the immediately prior durable write
2. a later write must not restart from the stale projection loaded at
   the beginning of the command
3. multi-step transitions such as orphan-and-requeue, release-and-clear,
   or recover-and-update-status must preserve the earlier attachment,
   claim, assignment, and status mutations from the same command
4. snapshot-only writes must preserve the latest durable `lastEventId`
   boundary from `snapshot.json`; they must not mint a newer replay
   boundary that does not exist in `events.ndjson`

Snapshot-fallback durability must behave like one coherent state-machine
transition, not a sequence of unrelated local rewrites.

The same lock boundary must also be crash-recoverable. Event-log,
snapshot, and lease callers may not be wedged forever by orphaned path
locks from dead or reused process ids. Unreadable owner metadata is not
positive stale-owner proof: acquisition and cleanup must fail closed on
that ambiguity instead of reaping the lock. Snapshot sync must derive its
durable write payload while still holding the snapshot lock that guards
the write. If a newer snapshot-only mutation lands before that final
locked write begins, snapshot sync must preserve that newer durable
snapshot truth instead of overwriting it with older event-derived state.

---

## CLI exit semantics

- `ctx run` returns exit code `0` for completed or blocked/decision
  outcomes that were durably recorded.
- `ctx run` returns non-zero when the persisted result status is
  `failed`.
- `ctx run` and `ctx resume` must still emit any already-collected
  structured diagnostics on stderr when a later command failure forces a
  non-zero exit. Those diagnostics must print before the terminal error
  message instead of being dropped.
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
- malformed lease blocker materialized by default in shared inspection
- stale lease artifact with no durable run record
- stale reconciliation clears the lease artifact
- stale-run reconciliation is idempotent across `status`, `resume`, and
  `run`
- stale reconciliation identity is keyed to a durable run instance, not
  `startedAt` or status drift
- a later fresh stale retry emits a new stale reconciliation
- snapshot-fallback later stale retries remain distinct from earlier
  stale repairs
- multiple stale leases preserve latest status updates
- final non-running persistence only degrades to a warning after lease
  cleanup succeeds
- completed record with leftover lease recovered into runtime truth
- completed record with malformed leftover lease recovered into runtime
  truth
- durable completed decision recovered into runtime truth
- durable completed decision recovered at the command surface
- verified wrapped resume persists partial progress and returns the
  attachment to resumable state
- verified wrapped resume persists decision outcomes through the same
  runtime-owned path as launch
- verified wrapped resume with a terminal result releases attachment
  authority
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
- malformed attachment or claim graphs fail closed across inspection and
  reconciliation surfaces
- strict rebuild failure on malformed event logs
