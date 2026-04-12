# Milestone 2

## Status

Milestone 2 is complete in the current repository.

This milestone now represents the full reference-host execution slice
for Coortex plus the recovery hardening needed to make that slice
routine and durable in practice.

The current repository includes:

- real Codex-backed `ctx run` execution from runtime-owned bounded
  envelopes
- durable result and decision capture through the normal runtime path
- runtime-backed `ctx status`, `ctx resume`, `ctx run`, `ctx inspect`,
  and `ctx doctor` surfaces
- persisted host-run inspection through adapter-owned metadata
- lease and heartbeat-backed host-run tracking
- stale-run reconciliation into queued retry state
- duplicate-run protection while an authoritative lease is active
- completed-run and failed-run recovery after interrupted runtime
  persistence
- snapshot-fallback recovery constrained by the snapshot-boundary rule
- explicit execution-mode handling for live validation
- recovery-oriented telemetry for stale-run reconciliation and host
  lifecycle events

## Objective

Milestone 2 proves that the runtime-first architecture can drive one
real host-integrated run from durable runtime state through to durable
runtime output, and can recover that truth after interruption without
lying to operator-facing command surfaces.

The reference host for this milestone is Codex.

## Implemented scope

Milestone 2 now includes:

- one real host path: Codex
- assignment -> bounded envelope -> host run -> result or decision
  capture -> persistence into runtime state
- the shared adapter contract needed for real host execution,
  inspection, and reconciliation
- storage of only the host-specific metadata needed to reconnect,
  inspect, or reconcile a run back into runtime truth
- runtime-backed inspection, status, resume, and run behavior for that
  path
- recovery brief generation from durable runtime state
- lease and heartbeat-backed host-run lifecycle tracking
- stale-run reconciliation and queued retry behavior
- duplicate-run prevention while an active lease is authoritative
- completed-run and failed-run reconciliation when runtime event
  persistence degrades
- snapshot fallback with boundary-safe replay and hydration rules
- automated verification through:
  - the standard automated suite
  - a focused Milestone 2 smoke suite
  - a broader Milestone 2 integration suite
  - live Codex validation paths for bypass-enabled and restricted-mode
    behavior

## Out of scope

The following remain outside Milestone 2:

- support for multiple host adapters at once
- workflow-module expansion beyond placeholder boundaries
- full team/worker orchestration
- plugins or advanced hook ecosystems
- a full safety/approval subsystem beyond the current Codex
  execution-mode switch
- advanced memory tiers
- advanced history compaction beyond the first trimming layer
- backend abstraction beyond what the first real host path required
- full observability stack

## Acceptance criteria

Milestone 2 is complete when all of the following are true:

1. A runtime assignment can drive a real Codex-backed run through the
   existing bounded-envelope path.
2. The run returns a captured outcome that Coortex stores as a result
   packet or decision packet.
3. The outcome is durably persisted and visible through runtime-backed
   status, resume, run, and inspection surfaces.
4. Host-run metadata remains under the adapter boundary and does not
   move runtime authority out of Coortex.
5. Interrupted, stale, or partially persisted host runs reconcile back
   into truthful runtime state without enabling duplicate execution.
6. Snapshot fallback preserves the snapshot-boundary rule during
   recovery.
7. Automated tests prove the end-to-end slice, and live validation
   paths still work for the Codex reference host.

## Verification surfaces

Repository validation for Milestone 2 includes:

- `npm test`
- `node --test dist/__tests__/milestone-2-smoke.test.js`
- `node --test dist/__tests__/milestone-2-integration.test.js`
- `COORTEX_LIVE_CODEX_SMOKE=1 node --test dist/__tests__/cli.test.js --test-name-pattern "ctx run completes a live Codex smoke path"`
- `COORTEX_LIVE_CODEX_HARNESS=1 npm run test:live-m2`
- `COORTEX_LIVE_CODEX_RESTRICTED=1 node --test dist/__tests__/cli.test.js --test-name-pattern "ctx run reports truthful persisted state without bypass mode"`

## Next milestone

The next implementation milestone after Milestone 2 is workflow
modules, beginning with explicit sequencing surfaces such as `plan`,
`review`, and `verify`.
