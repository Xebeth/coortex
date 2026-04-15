# Coortex Roadmap

## Purpose

This roadmap describes the implementation sequence for Coortex from
the current repository state toward the longer-term target.

The architecture assumes:

- a host-agnostic core runtime
- explicit host adapters
- bounded context discipline
- durable recovery
- modular workflows and extension layers

## Current state

The first two milestones are complete in the current repository:

- Milestone 1 established the host-agnostic runtime-first foundation
  and the reference adapter boundary.
- Milestone 2 added real Codex-backed execution plus the recovery
  hardening needed to make that path routine and durable.

Completed milestone summaries live under:

- `docs/completed/milestone-1.md`
- `docs/completed/milestone-2.md`

## Near-term sequence

### Immediate prerequisite — Milestone 2 session-attachment hardening

Before Phase 3 resumes, the reference-host integration boundary needs
an additional Milestone 2 hardening slice.

Focus:
- explicit session attachment for Coortex-managed host sessions
- no ambient repo-local runtime authority
- no foreign claim of attached assignments
- no duplicate assignment issuance across attached sessions
- provenance for runtime initialization and host activation

Detailed record:
- `docs/completed/milestone-2-session-attachment-hardening.md`

### Phase 3 — Workflow modules

Objective:
Move sequencing policy into explicit workflow modules.

Deliver:
- `plan`
- `review`
- `verify`
- additional workflow modules as needed

The runtime remains authoritative.

### Phase 4 — Additional host adapters

Objective:
Add at least one more host adapter to prove the architecture is
genuinely host-agnostic.

Possible hosts:
- OpenCode
- Claude Code
- other compatible environments

Deliver:
- second host adapter
- adapter capability comparison
- adapter-specific telemetry normalization
- adapter-specific integration docs

## Longer-term direction

### Phase 5 — Verification and Review

Objective:
Make completion criteria explicit and durable.

Deliver:
- verification requirement model
- evidence storage
- completion gating
- review-oriented result states
- verification telemetry

### Phase 6 — Guidance and Artifact Store

Objective:
Add targeted guidance retrieval and a typed artifact store.

Deliver:
- project guidance retrieval
- codebase map fragments
- project commands/conventions
- artifact storage for large outputs and evidence
- retrieval-by-reference model

### Phase 7 — History Management and Compaction

Objective:
Extend the initial trimming layer into a fuller context-management subsystem.

Deliver:
- history compaction
- bounded recent-history retention
- compaction triggers at soft working limits
- compaction telemetry
- regression checks for token growth

### Phase 8 — Safety, Approvals, and HITL

Objective:
Add explicit governance and human checkpoints.

Deliver:
- approval modes
- sandbox/write-scope policy
- dangerous-command policy
- pause/resume-on-approval
- approval telemetry

### Phase 9 — Hooks and Plugins

Objective:
Add optional extension surfaces without compromising the core.

Deliver:
- hooks integration layer
- plugin packaging conventions
- optional skills packs
- optional MCP/app/guidance integrations

### Phase 10 — Observability and Evaluation

Objective:
Make the system measurable as a harness.

Deliver:
- richer telemetry rollups
- trace or span views
- regression benchmarks
- workflow/token/latency comparisons
- recovery effectiveness metrics
- adapter comparison metrics

### Phase 11 — Branching and Long-Running Work

Objective:
Support explicit fork/branch semantics for long-lived work.

Deliver:
- task/session fork model
- branch identity
- branch-aware recovery
- branch comparison or reconciliation support

### Phase 12 — Security and Retention Hardening

Objective:
Add stronger data-handling and retention rules.

Deliver:
- secret-handling policy
- redaction rules
- session/artifact retention policy
- protected or encrypted storage options where needed
- trust-boundary rules for external adapter/plugin/tool data

## Priority order

The recommended order remains:

1. runtime truth
2. persistence
3. recovery
4. bounded context and trimming
5. telemetry
6. adapter contract
7. one reference adapter
8. real execution and recovery hardening
9. workflows
10. second adapter
11. governance
12. extension surfaces
13. richer observability
14. long-running branch semantics
15. security hardening

This ordering keeps the core architecture stable while adapter breadth
and operational complexity grow gradually.
