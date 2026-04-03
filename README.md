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

## License

TBD.
