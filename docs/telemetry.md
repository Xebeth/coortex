# Telemetry

## Purpose

This document defines the current telemetry model for Coortex.

Coortex telemetry is **host-agnostic at the schema level** and **host-specific at the collection layer**.

That means:

- adapters collect whatever telemetry a host exposes
- Coortex normalizes it into a common schema

For the longer-term target, see:

- `docs/coortex-ideal-spec.md`
- `docs/coortex-roadmap.md`

---

## Telemetry Goals

The system should make it possible to answer:

- what runtime actions occurred
- which task/session they belong to
- how large the task envelope was
- whether trimming or compaction occurred
- what recovery summary was generated
- what usage/token information was available from the active host

---

## Telemetry Layers

## 1. Core telemetry

Core telemetry is host-independent and should always be recordable.

Examples:

- assignment created
- assignment updated
- result submitted
- decision created/resolved
- recovery brief generated
- resume requested
- status requested

## 2. Envelope telemetry

Envelope telemetry is produced by the adapter-facing bounded-envelope builder.

Examples:

- actual prompt-payload size estimate
- oversized-envelope detection
- trim applied
- recovery-brief size
- artifact/reference substitution

## 3. Host telemetry

Host telemetry is whatever the active host can provide.

Examples:

- usage/token counts
- model/session identifiers
- host-native latency data
- session lifecycle identifiers

Host telemetry must be normalized into the Coortex schema when possible.

---

## Schema Rules

The telemetry schema should support at least:

- `timestamp`
- `event_type`
- `task_id`
- `assignment_id` where relevant
- `host`
- `adapter`
- `metadata`

Usage-related fields may include:

- `input_tokens`
- `output_tokens`
- `total_tokens`
- `cached_tokens`
- `reasoning_tokens`

These fields should exist in the schema even if some hosts cannot populate them yet.

---

## Precision Policy

Telemetry values fall into three categories:

### Exact
Collected from authoritative host or runtime data.

### Derived
Computed from exact values.

### Estimated
Used only when exact data is unavailable. Must be labeled clearly.

---

## First-Milestone Telemetry

The first milestone must record:

- lifecycle events
- session/task identifiers
- actual prompt-payload size after prompt framing and schema injection
- trimming actions
- recovery-related events
- placeholders for usage/token fields

This is enough to support bounded-context work and future adapter comparisons.

---

## Boundary Rule

Telemetry must not become a hidden source of truth.

If telemetry writing fails, runtime correctness must still hold.
