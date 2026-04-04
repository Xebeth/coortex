# Coortex Milestone 2 Execution Plan

## 1. Milestone 2 objective

Implement the smallest end-to-end real execution path for one host.

In this repository, that means proving a single Codex-backed Coortex run works from runtime assignment to bounded envelope to host execution to durable result or decision capture, with only the minimum resume or recovery support required for the path to function.

Use `docs/plans/coortex-milestone-2-implementation-brief.md` as the companion brief for this milestone.

## 2. In-scope items

- one real host only: Codex
- assignment -> bounded envelope -> host run -> result capture or decision capture -> persistence into runtime
- the smallest shared adapter-contract change required for one real run
- the smallest Codex adapter execution integration required for that run
- storage of only the host metadata strictly needed to reconnect the run to runtime state
- basic CLI or operator wiring to start and inspect the run
- basic host telemetry capture if the selected Codex path exposes it
- only the minimum recovery or resume integration required for the path to function
- automated tests for the end-to-end path

## 3. Out-of-scope items

- recovery hardening as a milestone goal
- lease or heartbeat models
- stale-claim or stale-ownership reconciliation
- full resume or requeue policy
- multi-host expansion beyond what this single path strictly needs
- workflow-module expansion
- plugins or hooks expansion
- approvals, governance, or HITL work
- advanced compaction or broader history-management work
- backend abstraction beyond the first host path

## 4. Ordered implementation steps

### Step 1 — Add the minimum real-run adapter surface

Likely change areas:

- `src/adapters/contract.ts`
- `src/adapters/index.ts`
- adapter tests

Expected work:

- add the smallest contract addition needed to initiate a real host run
- define how a host run returns a result or decision back into Coortex
- avoid adding broader execution semantics that are not required for this first path

### Step 2 — Implement the Codex real execution path

Likely change areas:

- `src/hosts/codex/adapter/index.ts`
- helper files under `src/hosts/codex/adapter/`
- `src/hosts/codex/profile/` or `src/hosts/codex/kernel/` only if strictly needed

Expected work:

- use the existing bounded envelope in a real Codex run path
- capture the host outcome as either a result packet or a decision packet
- persist only the adapter metadata needed to reconnect or inspect that run later

### Step 3 — Persist the returned outcome into runtime state

Likely change areas:

- `src/core/events.ts`
- `src/persistence/store.ts`
- `src/projections/runtime-projection.ts`
- runtime-related tests

Expected work:

- append the returned result or decision through the existing event and persistence path
- ensure status and projections reflect the captured outcome
- avoid expanding the runtime model beyond what this first real run needs

### Step 4 — Add the minimum resume or inspection hook

Likely change areas:

- `src/recovery/brief.ts`
- `src/cli/ctx.ts`
- Codex adapter metadata helpers if needed

Expected work:

- make it possible to resume or inspect the real run in the narrowest workable way
- keep this limited to correctness for the first path, not general recovery hardening

### Step 5 — Record basic telemetry if available

Likely change areas:

- `src/telemetry/types.ts`
- `src/telemetry/recorder.ts`
- Codex adapter telemetry normalization

Expected work:

- record basic execution metadata and usage information if the selected Codex path exposes it
- keep telemetry non-authoritative

### Step 6 — Add end-to-end tests

Likely change areas:

- `src/__tests__/adapter-contract.test.ts`
- `src/__tests__/cli.test.ts`
- new targeted execution tests

Expected work:

- prove assignment -> envelope -> host run -> runtime persistence works
- prove the narrow resume or inspection path works well enough for this milestone
- avoid encoding expectations for later recovery-hardening behavior

## 5. Acceptance criteria

Milestone 2 is complete when all of the following are true:

1. A runtime assignment can drive a real Codex-backed run through the existing bounded-envelope path.
2. The run returns a captured outcome that Coortex stores as a result packet or decision packet.
3. The outcome is durably persisted and visible through runtime-backed status or inspection surfaces.
4. Only the minimum host-specific metadata needed for that run is stored under the adapter boundary.
5. Basic resume or inspection works for this path only to the extent required for the path to function.
6. Basic telemetry is recorded if exposed by the chosen host path.
7. Automated tests prove the end-to-end slice.

## 6. Suggested milestone after Milestone 2

The milestone after Milestone 2 should be **execution recovery hardening**.
