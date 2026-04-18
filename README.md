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
- prompts or kernel instructions stay small and stable
- task context is bounded intentionally
- host-specific seams are isolated behind adapter contracts
- telemetry is normalized into a common Coortex schema

## Near-term implementation focus

Milestone 2 is now complete in the current repository. The next implementation milestone is workflow modules, beginning with explicit sequencing surfaces such as:

- `plan`
- `review`
- `verify`
- additional workflow modules as needed

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

- startup/resume integration
- bounded envelope building
- real Codex-backed `run` execution
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
- `.coortex/runtime/last-resume-envelope.json`
- `.coortex/artifacts/results/*.txt` when envelope trimming persists large outputs
- `.coortex/adapters/codex/runs/*.json` for persisted host run metadata
- `.coortex/adapters/codex/kernel.md`
- `.coortex/adapters/codex/profile.json`
- `.coortex/adapters/codex/skill-pack.json`
- `.codex/config.toml` with a Coortex-managed `model_instructions_file` block for project-local Codex integration
- `.codex/skills/review-baseline`, `.codex/skills/review-orchestrator`, and `.codex/skills/review-fixer` as the Coortex-managed Codex review skill pack

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

Check status, doctor output, run inspection, and a recovery envelope:

```bash
node dist/cli/ctx.js status
node dist/cli/ctx.js doctor
node dist/cli/ctx.js inspect
node dist/cli/ctx.js resume
```

Execute the active assignment through the Codex adapter:

```bash
node dist/cli/ctx.js run
```

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

When enabled, Coortex persists the Codex runtime setting and uses `--dangerously-bypass-approvals-and-sandbox` for Codex-backed runs. The default remains sandboxed execution.

## License
MIT
