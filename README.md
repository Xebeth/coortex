# Coortex

> A runtime-first coordination layer for coding assistants.

## What is Coortex?

Coortex is a local coordination system for AI coding tools. It provides runtime-owned task state, bounded task envelopes, durable recovery, trimming/compaction discipline, and structured workflows.

Coortex is designed to be **host-agnostic at the core**:

- the **core runtime** owns coordination truth
- **host adapters** integrate specific CLIs or coding environments
- **workflows** define policy
- **telemetry** explains what happened
- **recovery** resumes from durable state rather than transcript reconstruction

## Current direction

The project is being built in two layers:

1. **Host-agnostic core**
   - assignments
   - result packets
   - decision packets
   - event log and snapshots
   - recovery brief generation
   - bounded task envelopes
   - trimming and compaction policy
   - telemetry model

2. **Host adapters**
   - Codex adapter (reference adapter)
   - future adapters for other hosts such as OpenCode or Claude Code

The first implementation milestone builds the core and one reference host adapter rather than trying to support every host at once.

## What Coortex focuses on

- runtime-backed coordination
- bounded context and trimming
- durable recovery
- structured execution phases
- profile- or host-scoped integration
- explicit telemetry
- modular boundaries between core, adapters, workflows, and backends

## Documentation

Start here:

- `docs/README.md`
- `docs/scope.md`
- `docs/architecture.md`
- `docs/module-boundaries.md`
- `docs/runtime-state-model.md`
- `docs/run-recovery-invariants.md`
- `docs/codex-run-recovery-mapping.md`
- `docs/coortex-roadmap.md`

Reference documents:

- `docs/coortex-ideal-spec.md`
- `docs/completed/milestone-1.md`
- `docs/completed/milestone-2.md`

Host-specific and migration documents:

- `docs/codex-profile-integration.md`
- `docs/host-adapters.md`

Research and archive:

- `docs/research/opencode-adapter-findings.md`
- `docs/archive/omx-fork-developer-handoff-plan.md`
- `docs/archive/codex-coordinator-complete-plan.md`

## Design summary

The governing rule is:

**Host adapters execute. The runtime coordinates. Persistence recovers.**

That means:

- live orchestration state is not stored in prompt text
- runtime-owned attachment, claim, and provenance truth stays in `.coortex/runtime`
- prompts or kernel instructions stay small and stable
- task context is bounded intentionally
- host-specific seams are isolated behind adapter contracts
- telemetry is normalized into a common Coortex schema

## Near-term implementation focus

Milestone 2 is complete, but the current branch focus is an additional
Milestone 2 hardening slice for explicit session attachment and the
reference-host integration boundary.

Milestone 3 workflow work continues on its own branch and resumes after
that lower-layer hardening lands.

## Milestone 2 status

The current repository includes a complete Milestone 2 implementation in TypeScript/Node: the real execution slice and the recovery-hardening work described in the phase plan are both implemented and validated.

Implemented in the current repository:

- config types and validation under `src/config`
- host-agnostic runtime models under `src/core`
- append-only persistence and rebuildable snapshot/projection support under `src/persistence` and `src/projections`
- recovery brief generation under `src/recovery`
- the shared adapter contract under `src/adapters`
- a Codex profile manager under `src/hosts/codex/profile`
- a static Codex kernel boundary under `src/hosts/codex/kernel`
- a Codex reference adapter under `src/hosts/codex/adapter`
- explicit placeholder boundaries under `src/workflows` and `src/backends`
- runtime-backed `ctx` CLI surfaces under `src/cli`

The adapter/runtime path now includes:

- runtime-owned session attachments and attachment-bound claims
- explicit runtime init, host setup, wrapped launch, and wrapped resume boundaries
- bounded envelope building
- real Codex-backed `run` execution
- wrapped Codex same-session `resume` by stored native session id
- run inspection through persisted host metadata
- heartbeat and lease-backed host-run tracking
- stale-run reconciliation into queued retry state
- active-lease protection against duplicate reruns
- result normalization
- decision normalization
- telemetry normalization hooks
- explicit Codex bypass-mode support for live success-path validation

Repository tests enforce the Milestone 1 module map, guard key boundary rules, and validate the Milestone 2 execution slice through:

- the standard automated suite
- a focused Milestone 2 smoke suite under `src/__tests__/milestone-2-smoke.test.ts`
- a broader Milestone 2 integration suite under `src/__tests__/milestone-2-integration.test.ts`
- a bypass-enabled live Codex smoke path
- a bypass-enabled Milestone 2 live harness
- a restricted-mode live test that verifies truthful persisted state without bypass

The durable runtime root is `.coortex/` in the current project.

Generated files include:

- `.coortex/config.json`
- `.coortex/runtime/events.ndjson`
- `.coortex/runtime/snapshot.json`
- `.coortex/runtime/telemetry.ndjson`
- `.coortex/runtime/last-resume-envelope.json` as a derived recovery artifact, not attachment authority
- `.coortex/artifacts/results/*.txt` when envelope trimming persists large outputs
- `.coortex/adapters/codex/runs/*.json` for host run attempts and lease metadata only
- `.coortex/adapters/codex/kernel.md`
- `.coortex/adapters/codex/profile.json`
- `.codex/config.toml` with a Coortex-managed `model_instructions_file` block for project-local Codex integration preparation only

## Local usage

Install and build:

```bash
npm install
npm run build
```

Initialize the local runtime:

```bash
node dist/cli/ctx.js init
```

`ctx init` creates runtime state and prepares non-authoritative Codex host artifacts.

Check status, doctor output, run inspection, and a recovery envelope:

```bash
node dist/cli/ctx.js status
node dist/cli/ctx.js doctor
node dist/cli/ctx.js inspect
node dist/cli/ctx.js resume
```

`ctx inspect` prints adapter-owned host-run metadata under `hostRun` and,
when available, the matching runtime-owned attachment context under
`runtimeAttachment`. It is a read-only host-run inspection surface with
runtime context, not a second source of attachment authority or a
reconciliation command.

`ctx resume` first targets the single authoritative attached or
detached-but-resumable attachment that still carries a stored native
session id. During a verified wrapped reclaim the runtime marks that
attachment attached, then returns it to `detached_resumable` when the
wrapped resume process exits without a terminal runtime outcome. If no
such reclaimable attachment exists, or reclaim cannot be verified, it
refreshes the derived recovery envelope from current runtime state
instead.

Attachment and claim provenance follow the same rule: launch-created
authority records `launch`, live wrapped reclaim records `resume`, and
recovery-promoted resumable authority records `recovery`.

Successful wrapped reclaim now records result or decision outcomes
through the same runtime-owned durable path as `ctx run`. The Codex
adapter treats the `-o` last-message artifact as the authoritative
structured-output boundary. It falls back to the streamed
`agent_message` text only when that artifact is missing, and the
fallback must still be a raw JSON object with no prose or code fences.

Failed wrapped reclaim now keeps three distinct states at the
adapter/runtime seam: `reclaimed`, `verified_then_failed`, and
`unverified_failed`. Once the requested native session is verified,
later persistence failure does not collapse that proof back into a
foreign/unverified failure shape.

Execute the active assignment through the Codex adapter:

```bash
node dist/cli/ctx.js run
```

`ctx run` is the wrapped launch path for a new Coortex-managed Codex session.

Run the milestone test suite:

```bash
npm test
```

Run the focused Milestone 2 smoke gate only:

```bash
node --test dist/__tests__/milestone-2-smoke.test.js
```

Run the live Milestone 2 validation paths:

```bash
COORTEX_LIVE_CODEX_SMOKE=1 node --test dist/__tests__/cli.test.js --test-name-pattern "ctx run completes a live Codex smoke path"
COORTEX_LIVE_CODEX_HARNESS=1 npm run test:live-m2
COORTEX_LIVE_CODEX_RESTRICTED=1 node --test dist/__tests__/cli.test.js --test-name-pattern "ctx run reports truthful persisted state without bypass mode"
```

Enable Codex bypass mode for explicit live success-path validation by setting:

```bash
COORTEX_CODEX_DANGEROUS_BYPASS=1
```

When enabled, Coortex persists the Codex runtime setting and uses
`--dangerously-bypass-approvals-and-sandbox` for Codex-backed runs and
resumes. Without bypass, wrapped launch uses Codex's sandboxed
`workspace-write` mode, while wrapped resume uses the supported
`codex exec resume --full-auto` default.

## License
MIT
