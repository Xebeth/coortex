# Milestone 2 Session Attachment Hardening

## Status

This hardening slice is complete in the current repository.

This slice now records the current session-attachment boundary for the
Codex reference host and the recovery guarantees that keep that
boundary truthful under interruption, reclaim, and snapshot-fallback
recovery.

The current repository includes:

- runtime-owned attachment, claim, and provenance records
- attachment-aware duplicate-issuance and foreign-claim protection
- wrapped same-session reclaim with verified native session identity
- snapshot-fallback attachment recovery that preserves multi-step
  authority updates
- aligned wrapped launch and wrapped reclaim lifecycle semantics for
  outcomes, finalization, and telemetry

## Objective

This hardening slice narrowed the Milestone 2 reference-host boundary
so Coortex authority is bound to an explicit runtime-owned host session
attachment rather than to ambient repo-local state or adapter-local
artifacts.

## Implemented scope

This slice now includes:

- runtime-owned attachment truth, claim truth, and reclaim provenance
- native host-session identity captured as metadata on the attachment
  rather than as standalone authority
- strict separation between attachment state and per-assignment
  execution lease state
- wrapped `ctx run` launch semantics that promote provisional authority
  only after durable native identity capture
- wrapped `ctx resume` reclaim semantics that verify same-session
  identity before preserving claim authority
- snapshot-fallback write-base rules that preserve earlier
  attachment/claim/status mutations across later writes in the same
  command
- automated coverage for reclaim, orphan, release, duplicate blocking,
  and snapshot-only recovery edges

## Current guarantees

The current repository now guarantees:

- the runtime owns attachment truth, claim truth, and provenance
- the native Codex session identifier is metadata on a runtime-owned
  attachment record
- `.codex/config.toml`, static kernel/profile artifacts, and
  `config.json` remain preparatory or descriptive only; they do not
  become authoritative session-attachment truth

- an assignment may have at most one active attachment claim
- at most one authoritative attached or detached-but-resumable
  attachment may exist per runtime
- foreign reclaim of an attached assignment is rejected
- duplicate assignment issuance is blocked while an authoritative
  attachment or valid active lease still owns the work

- attachment answers which Coortex-managed host session is authoritative
  for the work and whether it is attached, detached-but-resumable,
  released, orphaned, or still provisional
- lease answers only whether one execution attempt is currently live for
  a specific assignment
- host-run persistence remains attempt-level metadata; it does not own
  attachment state

- wrapped `ctx run` and verified wrapped `ctx resume` are two
  entrypoints into the same runtime-owned execution lifecycle
- both normalize outcomes through the same runtime event path
- both finalize attachment and claim state through the same authority
  rules
- attachment and claim provenance are now runtime-owned lifecycle facts:
  launch-created authority records `launch`, live wrapped reclaim
  records `resume`, and reconciliation-promoted resumable authority
  records `recovery`
- wrapped reclaim keeps typed reclaim proof at the adapter/runtime seam:
  `verified_then_failed` remains distinct from `unverified_failed` so
  runtime cleanup and recovery can preserve verified same-session
  ownership through later persistence errors
- that shared authority rule also applies to completed-run recovery:
  recovered decisions and recovered partial results detach active
  attached authority back to resumable state, while only recovered
  terminal results release attachment/claim authority; if the active
  binding is still provisional but the completed host record contains a
  durable native session id, recovery promotes it into resumable state
  before provisional cleanup can clear it; if the binding is already
  detached but missing that id, recovery backfills it from durable host
  metadata before wrapped reclaim is considered available
- `ctx resume` adds one extra guard only: same-session identity
  verification against the existing authoritative attachment
- while a wrapped reclaim is live, it holds the same lease-backed host
  run attempt boundary as `ctx run`

## Command model

### `ctx init`

`ctx init` creates runtime state and performs non-authoritative host
setup only.

It does not create an authoritative attachment or active claim.

### `ctx run`

`ctx run` is the wrapped launch path.

It acquires the host-run lease, creates provisional launch authority,
promotes that authority only after durable native session identity is
captured, and persists result or decision outcomes through the normal
runtime-owned outcome path.

If the thread-start metadata write itself degrades, the host outcome may
still finish successfully, but the native session id is intentionally
withheld from the runtime attachment and completed host-run record
because Coortex never durably proved that identity boundary.

Attachment-plus-claim authority mutations are written as one durable
runtime batch so interrupted persistence cannot strand half of an
authoritative pair.

Runtime event batches and malformed-log repair both pass through the
same serialized append-only store boundary, so concurrent recovery or
authority writes cannot be lost to stale whole-file replacement.

### `prepareResumeRuntime()`

`prepareResumeRuntime()` is read-only over authoritative runtime truth.

It must not refresh telemetry, regenerate the derived resume envelope,
synthesize attachments or claims, or reconcile stale or completed runs.

### `ctx resume`

`ctx resume` is the wrapped same-session reclaim path.

It first reconciles runtime truth, targets the single authoritative
attached or detached-but-resumable attachment that still carries a
stored native session id, verifies that the native session being
reclaimed matches the requested attachment, and then persists the
resumed result or decision through the same runtime-owned outcome path
used by `ctx run`.
While the wrapped reclaim is still live, Codex resume keeps the same
lease-backed host-run attempt boundary and heartbeat semantics as a
wrapped launch.
That reclaim boundary, including takeover of an already-live eligible
lease, is acquired atomically inside the adapter / host-run store
surface rather than by command-layer inspection.
If a second reclaim hits that already-live boundary, Coortex blocks it
as a duplicate reclaim attempt; it does not orphan or requeue the
current authoritative attachment truth.

If reclaim cannot be verified, Coortex orphans the attachment/claim and
requeues the assignment instead of silently transferring authority.

## Recovery model

### Same-session reclaim first

When the runtime sees an attached or detached-but-resumable attachment
for unfinished work, recovery prefers wrapped same-session reclaim
before orphaning or requeueing the assignment.

### Snapshot fallback remains truthful

When recovery must operate from `snapshot.json` because the event log is
missing or unusable:

- recovery may update snapshot truth directly rather than fabricating a
  truncated event log
- each later durable write in the same command must use the projection
  produced by the immediately prior write
- multi-step transitions such as orphan-and-requeue must preserve the
  earlier attachment, claim, assignment, and status mutations from the
  same command
- stale recovery now orphans active attachment/claim authority before
  requeueing the assignment, and completed-run recovery releases active
  authority when the recovered outcome is terminal

## Out of scope

This slice still does not attempt to deliver:

- multiple simultaneous authoritative attachments per runtime
- multi-host policy beyond the Codex reference-host boundary
- deeper workflow-module sequencing beyond Milestone 2
- broader plugin or hook ecosystems beyond the current reference-host
  path

## Verification surfaces

Repository validation for this slice includes:

- `npm test`
- `node --test dist/__tests__/host-run-recovery-matrix.test.js`
- `node --test dist/__tests__/milestone-2-integration.test.js`
- `node --test dist/__tests__/adapter-contract.test.js`
- `node --test dist/__tests__/cli.test.js`

The automated suite now includes explicit coverage for:

- attached vs unattached behavior
- foreign-claim rejection
- duplicate issuance prevention
- same-session reclaim success and reclaim failure fallback
- invalid multiple resumable attachments
- launch without native identity finalization
- snapshot-only reclaim failure preserving orphaned attachment truth
- read-only `prepareResumeRuntime()` behavior
