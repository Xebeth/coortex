# Coortex Roadmap

## Purpose

This roadmap describes the work required after the first milestone to reach the full Coortex target.

The architecture assumes:

- a host-agnostic core runtime
- explicit host adapters
- bounded context discipline
- durable recovery
- modular workflows and extension layers

---

## Phase 1 — Milestone 1: Core + Reference Adapter

Deliver:

- core runtime
- persistence
- recovery brief
- trimming
- telemetry scaffold
- adapter contract
- one reference host adapter

This phase proves the runtime-first architecture.

---

## Phase 2 — Real Execution Path

Objective:
Move from foundational scaffolding to real task execution through the reference adapter.

Deliver:
- real host-driven task execution
- result/decision capture in real runs
- better usage/token collection where the host exposes it
- stronger bounded-envelope discipline in real execution

---

## Phase 3 — Recovery Hardening

Objective:
Make interruption handling robust enough for routine development use.

Deliver:
- lease and heartbeat model
- stale-claim reconciliation
- idempotent restart behavior
- stronger recovery telemetry
- resume/requeue policy

---

## Phase 4 — Verification and Review

Objective:
Make completion criteria explicit and durable.

Deliver:
- verification requirement model
- evidence storage
- completion gating
- review-oriented result states
- verification telemetry

---

## Phase 5 — Guidance and Artifact Store

Objective:
Add targeted guidance retrieval and a typed artifact store.

Deliver:
- project guidance retrieval
- codebase map fragments
- project commands/conventions
- artifact storage for large outputs and evidence
- retrieval-by-reference model

---

## Phase 6 — History Management and Compaction

Objective:
Extend the initial trimming layer into a fuller context-management subsystem.

Deliver:
- history compaction
- bounded recent-history retention
- compaction triggers at soft working limits
- compaction telemetry
- regression checks for token growth

---

## Phase 7 — Workflow Modules

Objective:
Move orchestration policy into explicit workflow modules.

Deliver:
- `plan`
- `review`
- `verify`
- team-oriented workflows
- optional persistent completion workflow

The runtime remains authoritative.

---

## Phase 8 — Additional Host Adapters

Objective:
Add at least one more host adapter to prove the architecture is genuinely host-agnostic.

Possible hosts:
- OpenCode
- Claude Code
- other compatible environments

Deliver:
- second host adapter
- adapter capability comparison
- adapter-specific telemetry normalization
- adapter-specific integration docs

---

## Phase 9 — Safety, Approvals, and HITL

Objective:
Add explicit governance and human checkpoints.

Deliver:
- approval modes
- sandbox/write-scope policy
- dangerous-command policy
- pause/resume-on-approval
- approval telemetry

---

## Phase 10 — Hooks and Plugins

Objective:
Add optional extension surfaces without compromising the core.

Deliver:
- hooks integration layer
- plugin packaging conventions
- optional skills packs
- optional MCP/app/guidance integrations

---

## Phase 11 — Observability and Evaluation

Objective:
Make the system measurable as a harness.

Deliver:
- richer telemetry rollups
- trace or span views
- regression benchmarks
- workflow/token/latency comparisons
- recovery effectiveness metrics
- adapter comparison metrics

---

## Phase 12 — Branching and Long-Running Work

Objective:
Support explicit fork/branch semantics for long-lived work.

Deliver:
- task/session fork model
- branch identity
- branch-aware recovery
- branch comparison or reconciliation support

---

## Phase 13 — Security and Retention Hardening

Objective:
Add stronger data-handling and retention rules.

Deliver:
- secret-handling policy
- redaction rules
- session/artifact retention policy
- protected or encrypted storage options where needed
- trust-boundary rules for external adapter/plugin/tool data

---

## Priority Order

The recommended order remains:

1. runtime truth
2. persistence
3. recovery
4. bounded context and trimming
5. telemetry
6. adapter contract
7. one reference adapter
8. workflows
9. second adapter
10. governance
11. extension surfaces
12. richer observability
13. long-running branch semantics
14. security hardening

This ordering keeps the core architecture stable while adapter breadth grows gradually.
