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
