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

- `docs/scope.md`
- `docs/architecture.md`
- `docs/module-boundaries.md`
- `docs/runtime-state-model.md`
- `docs/implementation-phases.md`

Reference documents:

- `docs/coortex-ideal-spec.md`
- `docs/coortex-milestone-1-plan.md`
- `docs/coortex-roadmap.md`

Host-specific and migration documents:

- `docs/codex-profile-integration.md`
- `docs/host-adapters.md`
- `docs/opencode-adapter-findings.md`
- `docs/omx-fork-developer-handoff-plan.md`

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

The first milestone should deliver:

- project scaffold
- runtime state model
- append-only persistence
- snapshot/projection rebuild
- recovery brief generation
- trimming for tool output and bounded envelopes
- telemetry scaffold
- one reference host adapter
- minimal CLI/status surfaces

## Milestone 1 status

The current repository now includes a working Milestone 1 vertical slice in TypeScript/Node:

- config types and validation under `src/config`
- host-agnostic runtime models under `src/core`
- append-only persistence and rebuildable snapshot/projection support under `src/persistence` and `src/projections`
- recovery brief generation under `src/recovery`
- a Codex profile manager under `src/codex/profile`
- a static Codex kernel boundary under `src/codex/kernel`
- a Codex reference adapter under `src/codex/adapter`
- explicit placeholder boundaries under `src/workflows` and `src/backends`
- minimal `ctx` CLI surfaces under `src/cli`

The durable runtime root is `.coortex/` in the current project.

Generated files include:

- `.coortex/config.json`
- `.coortex/runtime/events.ndjson`
- `.coortex/runtime/snapshot.json`
- `.coortex/runtime/telemetry.ndjson`
- `.coortex/runtime/last-resume-envelope.json`
- `.coortex/adapters/codex/kernel.md`
- `.coortex/adapters/codex/profile.json`

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

Check status, doctor output, and a recovery envelope:

```bash
node dist/cli/ctx.js status
node dist/cli/ctx.js doctor
node dist/cli/ctx.js resume
```

Run the milestone test suite:

```bash
npm test
```

## License

TBD.
