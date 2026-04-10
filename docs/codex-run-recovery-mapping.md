# Codex Run Recovery Mapping

## Purpose

This document maps the host-agnostic run-recovery invariants onto the
current Codex adapter implementation.

It should be read alongside:

- `docs/run-recovery-invariants.md`
- `docs/runtime-state-model.md`
- `docs/codex-profile-integration.md`

---

## Codex artifact mapping

The Codex adapter currently realizes the generic artifact roles with:

- runtime event log
  - `.coortex/runtime/events.ndjson`

- runtime snapshot
  - `.coortex/runtime/snapshot.json`

- per-assignment run record
  - `.coortex/adapters/codex/runs/<assignment>.json`

- per-assignment active lease
  - `.coortex/adapters/codex/runs/<assignment>.lease.json`

- last-run pointer
  - `.coortex/adapters/codex/last-run.json`

---

## Codex-specific metadata

The Codex adapter attaches host-native execution details such as:

- Codex run id / thread id
- lease expiry timestamps
- process-launch timing
- cancellation state
- Codex-specific warnings about metadata persistence

Those fields help `inspectRun()` and stale-run reconciliation, but they
do not replace runtime-owned assignment, result, or decision state.

---

## Codex lifecycle mapping

### Claim

Before the runtime marks work active for a new Codex run, the adapter
claims the per-assignment lease.

### Running

While Codex is active, heartbeat updates refresh the active lease and
the derived run record.

### Completion

When Codex reaches a terminal outcome, the adapter clears the active
lease and persists terminal run metadata before the runtime appends the
durable result or decision events.

### Recovery

If Codex exits unexpectedly or metadata becomes stale, `inspect`,
`status`, `resume`, and `run` reconcile the adapter artifacts back into
runtime-owned queued retry state.

The reconciliation rules themselves are shared. The Codex adapter only
supplies Codex-specific metadata parsing and host-process behavior.

---

## Codex-specific caveats

- `last-run.json` is convenience state only.
- Codex bypass mode affects how the host process is launched, but not
  the runtime recovery invariants themselves.
- Codex-specific process ids, thread ids, and output files are adapter
  implementation details; future adapters may satisfy the same
  invariants with different metadata.
