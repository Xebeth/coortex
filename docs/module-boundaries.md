# Module Boundaries

## Purpose

This document defines the internal module boundaries for Coortex.

The main architectural pivot is that Coortex is **host-agnostic at the core** and **host-specific at the adapter boundary**.

For the full long-term target, see:

- `docs/coortex-ideal-spec.md`
- `docs/coortex-roadmap.md`

---

## Boundary Rules

### 1. Runtime truth is centralized
The runtime owns:
- assignments
- result packets
- decision packets
- lifecycle state
- verification state
- recovery state

### 2. Adapters translate, not govern
Host adapters translate between Coortex and a host. They do not own orchestration truth.

### 3. Workflows define policy
Workflow modules define sequencing and policy. They do not own durable state.

### 4. Telemetry is normalized
Host-native telemetry should be converted into a common Coortex telemetry model.

### 5. Extensions are auxiliary
Hooks, plugins, and backends extend behavior but must not become correctness-critical sources of truth.

---

## Module Map

## `core`
Owns the runtime domain model.

Responsibilities:
- assignment types and lifecycle
- result packets
- decision packets
- base host-run record shape and generic run-state rules
- runtime/session status
- workflow-facing state rules

Must not depend on host-specific code.

## `persistence`
Owns durable storage.

Responsibilities:
- event log
- snapshots
- atomic writes
- schema versioning in later phases

Must not define workflow or adapter policy.

## `projections`
Owns rebuilt current-state views.

Responsibilities:
- derive current status
- derive current assignment views
- derive recovery inputs
- support status surfaces

Must not become authoritative over runtime truth.

## `recovery`
Owns interruption handling and resume logic.

Responsibilities:
- rebuild actionable current state
- derive compact recovery brief
- derive stale/requeue decisions from runtime-owned state

Must not rely on transcript history as primary truth.

## `workflows`
Own policy modules.

Responsibilities:
- phases
- assignment emission rules
- completion semantics
- workflow-specific hints

Must not own persistence or truth.

## `adapters`
Own adapter contracts and shared adapter interfaces.

Responsibilities:
- define the host adapter interface
- define normalized host capability reporting
- define common adapter expectations

Must not become a dumping ground for host-specific implementations.

## `hosts/<host>`
Own a specific host adapter.

Examples:
- `hosts/codex`
- `hosts/opencode`
- `hosts/claude`

Responsibilities:
- integrate the host’s config/profile/session surfaces
- build task envelopes for that host
- normalize host outputs and telemetry back into Coortex

Must not own runtime truth.

## `guidance`
Own guidance retrieval and artifact references.

Responsibilities:
- project conventions
- commands
- codebase map fragments
- artifact references

Must not become hidden task state.

## `verification`
Own durable verification concepts.

Responsibilities:
- verification requirement shapes
- evidence records
- completion gating logic in later phases

## `telemetry`
Own observability schema.

Responsibilities:
- lifecycle events
- usage/token fields
- envelope/trimming metadata
- rollups in later phases

Must not own orchestration truth.

## `cli`
Own operator-facing commands.

Responsibilities:
- initialization
- status
- doctor/validation
- resume/status surfaces
- persist recovery-side mutations when operator commands reconcile
  durable state

Must remain thin.

## `hooks`
Own optional hook integration.

Responsibilities:
- lifecycle interception integrations
- prompt validation integrations
- stop-time summaries
- auxiliary telemetry emission

Must not own runtime truth.

## `plugins`
Own optional plugin packaging.

Responsibilities:
- optional skill packs
- optional MCP integrations
- optional app integrations

Must not replace the core runtime.

---

## Dependency Direction

Preferred dependency direction:

- `core` -> foundational, no host dependencies
- `persistence` -> may depend on `core`
- `projections` -> depends on `core` + `persistence`
- `recovery` -> depends on `core` + `projections`
- `workflows` -> depends on `core`
- `adapters` -> depends on `core` + `recovery` + `telemetry`
- `hosts/<host>` -> depends on `adapters` + `core` + `telemetry`
- `cli` -> depends on the public surfaces of the above

Avoid reverse dependency from the core into any specific host.

---

## First-Milestone Boundary Set

The first milestone should create at least:

- `core/`
- `persistence/`
- `projections/`
- `recovery/`
- `adapters/`
- `hosts/<reference-host>/`
- `telemetry/`
- `cli/`

Other module families can start as placeholders if useful.
