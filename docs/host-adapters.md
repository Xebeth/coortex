# Host Adapters

## Purpose

This document defines the host-adapter model for Coortex.

Coortex is designed so that the **core runtime is host-agnostic** and individual coding-assistant environments are integrated through **host adapters**.

A host adapter is the only part of the system that should need to know host-specific concepts such as:

- profiles
- instruction files
- hooks
- plugin systems
- session/thread APIs
- host-native telemetry surfaces

---

## Why adapters exist

Different hosts expose different seams.

Some hosts provide:
- profile files
- startup hooks
- prompt transformation hooks
- usage/token counters
- session resume APIs
- plugin systems

Others expose only a subset.

The adapter model prevents those differences from leaking into the Coortex runtime.

---

## Adapter Responsibilities

A host adapter should provide:

1. startup/resume integration
2. bounded task-envelope injection
3. result/decision capture
4. host telemetry extraction or normalization
5. capability reporting
6. host-specific configuration/bootstrap support

Adapters may also optionally provide:

- hook wiring
- plugin packaging helpers
- host-specific operator conveniences

---

## Capability Model

Each host adapter should report its capabilities.

Example capability fields:

- `supports_profiles`
- `supports_hooks`
- `supports_resume`
- `supports_fork`
- `supports_exact_usage`
- `supports_compaction_hooks`
- `supports_mcp`
- `supports_plugins`
- `supports_permissions_model`

This lets workflows and operator surfaces degrade cleanly when a host is missing a feature.

---

## Adapter Contract Principles

### 1. The adapter does not own truth
The runtime remains authoritative.

### 2. The adapter may normalize host-native concepts
Host-native sessions, threads, or commands may be mapped into Coortex runtime entities, but they must not replace them.

### 3. The adapter may expose host-native features
Hooks, plugins, profiles, and session APIs may be used where available.

### 4. The adapter should not drag host assumptions into the core
If a concept exists only on one host, it belongs in the adapter boundary unless it proves generally useful across hosts.

---

## Reference Adapter Strategy

The first implementation milestone should build **one reference adapter** well.

That adapter validates:

- the adapter contract
- bounded envelope handling
- trimming
- telemetry normalization
- recovery integration

After that, a second adapter should be implemented to prove the architecture is genuinely host-agnostic.

---

## Adapter Implementation Guidance

When building an adapter, start with:

1. host startup/resume path
2. bounded task envelope
3. result/decision capture
4. telemetry extraction
5. capability reporting

Do not start by trying to port every optional host feature.

## Host-run ownership and stale recovery

Adapters that persist live run metadata must treat the active lease as
the ownership boundary for host execution.

- Reclaim or adopt flows must mint or preserve one durable
  `runInstanceId` fence for the live owner.
- Launch and resume startup identity handling must still be drained if
  the launch path fails after the host already reported a native
  session/run identity, so the durable identity and callback-facing
  session identity do not disappear behind queue starvation.
- Later heartbeat, completion, rollback, and destructive cleanup writes
  must prove that same fence instead of deleting by path alone, and
  running lease writes must re-check that fence at the actual lease
  mutation boundary instead of relying only on a prewrite read.
- Completed run-record and last-run publication must use the same
  mutation-time ownership fence as lease finalization. If a newer live
  claim appears after lease cleanup, the stale terminal publish must
  fail closed so inspection does not prefer obsolete terminal metadata.
- Adapter cleanup wrappers should carry the inspected or claimed fence
  through to shared store cleanup so a newer reclaimed lease cannot be
  cleared by stale assignment-scoped cleanup.
- Shared inspection materialization must preserve malformed lease
  blockers for running and non-terminal completed records instead of
  collapsing them to a generic missing-lease state. Only terminal
  completed records may outrank a malformed leftover lease, and adapter
  inspection wrappers should surface that same truth consistently.
- Degraded stale reconciliation may mint a fresh `runInstanceId` so the
  runtime can key stale-run idempotence durably.
- That minted stale identity is not a substitute for a live adopted
  ownership fence; completed stale cleanup must not let it delete or
  overwrite a newer reclaimed lease, run record, or last-run pointer
  that belongs to a different live owner.
