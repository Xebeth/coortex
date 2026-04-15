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
- legacy lease normalization before attachment-aware resume or rerun
  selection
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
- legacy lease-only normalization ahead of resume selection,
  duplicate-run blocking, and rerun selection
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
- `ctx resume` adds one extra guard only: same-session identity
  verification against the existing authoritative attachment

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

Attachment-plus-claim authority mutations are written as one durable
runtime batch so interrupted persistence cannot strand half of an
authoritative pair.

### `prepareResumeRuntime()`

`prepareResumeRuntime()` is read-only over authoritative runtime truth.

It may refresh telemetry and regenerate the derived resume envelope, but
it must not normalize legacy leases, synthesize attachments or claims,
or reconcile stale or completed runs.

### `ctx resume`

`ctx resume` is the wrapped same-session reclaim path.

It first reconciles runtime truth, targets the single authoritative
attached or detached-but-resumable attachment, verifies that the native
session being reclaimed matches the requested attachment, and then
persists the resumed result or decision through the same runtime-owned
outcome path used by `ctx run`.

If reclaim cannot be verified, Coortex orphans the attachment/claim and
requeues the assignment instead of silently transferring authority.

## Recovery model

### Same-session reclaim first

When the runtime sees an attached or detached-but-resumable attachment
for unfinished work, recovery prefers wrapped same-session reclaim
before orphaning or requeueing the assignment.

### Legacy lease-only normalization

Before attachment-aware resume selection, duplicate-run blocking, or
rerun selection, the runtime now normalizes legacy lease-only states:

1. a live legacy lease with no attachment produces exactly one
   detached-but-resumable attachment plus active claim
2. a completed run record with a leftover lease reconciles truthful
   terminal runtime outcome and clears the stale blocker without
   synthesizing a live attachment
3. stale, expired, malformed, or lease-less running state is treated as
   orphaned legacy state and reconciled back to queued retry without
   synthesizing new authoritative attachment truth

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
- all three legacy normalization cases
- invalid multiple resumable attachments
- launch without native identity finalization
- snapshot-only reclaim failure preserving orphaned attachment truth
- read-only `prepareResumeRuntime()` behavior
