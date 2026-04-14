# Codex Run Recovery Mapping

## Purpose

This document maps the host-agnostic run-recovery invariants onto the
current Codex adapter implementation.

It should be read alongside:

- `docs/run-recovery-invariants.md`
- `docs/runtime-state-model.md`
- `docs/codex-profile-integration.md`
- `docs/completed/milestone-2.md`

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

For workflow-mode runs, that lease and the matching run record must
carry the explicit workflow attempt identity from runtime-owned workflow
progress:

- `workflowId`
- `workflowCycle`
- `moduleId`
- `moduleAttempt`

### Running

While Codex is active, heartbeat updates refresh the active lease and
the derived run record.

### Completion

When Codex reaches a terminal outcome, the adapter clears the active
lease and persists terminal run metadata before the runtime appends the
durable result or decision events.

Workflow-mode completion must preserve the same explicit workflow
attempt identity that was stamped at claim time.

### Recovery

If Codex exits unexpectedly or metadata becomes stale, `inspect`,
`status`, `resume`, and `run` reconcile the adapter artifacts back into
runtime-owned queued retry state.

The reconciliation rules themselves are shared. The Codex adapter only
supplies Codex-specific metadata parsing and host-process behavior.

If a workflow-mode Codex run record is missing explicit workflow attempt
identity, recovery treats it as invalid or incomplete workflow metadata
instead of reconstructing ownership from timestamps.

---

## Codex-specific caveats

- `last-run.json` is convenience state only.
- Codex bypass mode affects how the host process is launched, but not
  the runtime recovery invariants themselves.
- Codex-specific process ids, thread ids, and output files are adapter
  implementation details; future adapters may satisfy the same
  invariants with different metadata.
