# Coortex Ideal Specification

## 1. Purpose

Coortex is a runtime-first coordination system for coding-assistant hosts.

The architecture is designed so that the **core runtime is host-agnostic**, while **host-specific adapters** integrate with individual environments such as Codex, OpenCode, or other compatible tools.

The system is intended to provide:

- runtime-owned orchestration state
- bounded task execution
- durable recovery
- trimming and compaction discipline
- explicit workflow control
- precise telemetry
- modular host adapters
- explicit governance and verification mechanisms

---

## 2. Product Goals

Coortex should:

1. keep the host-agnostic core independent of any single CLI or coding host
2. support multiple host adapters through explicit seams
3. keep ordinary host behavior unchanged outside an explicit Coortex integration path
4. store orchestration truth in runtime rather than prompt history
5. support solo and coordinated multi-worker execution
6. recover safely after interruption, crash, or restart
7. keep task context bounded and token usage predictable
8. expose useful telemetry across sessions, workflows, tasks, and workers
9. support modular workflows, backends, hooks, plugins, and skills without compromising runtime truth
10. support approvals, verification gates, and human checkpoints where required

---

## 3. Design Principles

### 3.1 Runtime owns truth
Assignments, ownership, decisions, results, verification, and recovery state live in runtime state.

### 3.2 Adapters translate
Host adapters translate Coortex state into host-native sessions, prompts, or API calls. They do not own orchestration truth.

### 3.3 Prompts or kernels define the contract, not the world
Any host-facing kernel, prompt, instruction file, or startup contract should remain small and stable.

### 3.4 Recovery is part of correctness
If work cannot be resumed from durable state, the coordination model is incomplete.

### 3.5 Guidance is retrieved, not preloaded
Project guidance, codebase maps, and workflow notes should be fetched on demand.

### 3.6 Bounded context is a system property
Token discipline comes from fewer calls, bounded envelopes, trimming, compaction, and careful retrieval.

### 3.7 Policy is separate from truth
Workflow modules define policy. The runtime core owns state and lifecycle truth.

### 3.8 Safety belongs in the harness
Approvals, sandboxing, write boundaries, network policy, and command policy belong in the system, not just in prompt wording.

---

## 4. System Overview

The ideal architecture includes these layers:

1. CLI / operator layer
2. core runtime
3. persistence and projections
4. recovery and reconciliation
5. workflow modules
6. adapter contracts
7. host adapters
8. guidance and artifact store
9. verification subsystem
10. telemetry and observability subsystem
11. optional extension layers (hooks/plugins/backends)

---

## 5. Core Runtime Model

The runtime must own these durable concepts:

- assignments
- result packets
- decision packets
- verification records
- runtime status
- recovery summaries
- leases and heartbeats
- telemetry linkage to runtime entities

The runtime model must be host-agnostic.

---

## 6. Adapter Model

A host adapter is the boundary between Coortex and a specific host.

An adapter should be responsible for:

- startup/resume integration
- bounded task-envelope injection
- result/decision capture
- telemetry extraction and normalization
- lifecycle event mapping
- capability reporting

Adapters may rely on host-native mechanisms such as:

- profile/config files
- instruction files or kernels
- hooks
- plugin systems
- session APIs
- telemetry APIs

Adapters must not become the source of orchestration truth.

---

## 7. Persistence and Recovery

The persistence layer must provide:

- append-only event log
- snapshots
- projections
- atomic writes
- schema versioning
- durable recovery artifacts

Recovery must operate from durable state rather than transcript replay.

---

## 8. Context, Memory, and Compaction

The system should distinguish between:

- working set
- session memory
- durable memory

Required capabilities:

- bounded task envelopes
- tool-output trimming
- history compaction
- compact recovery briefs
- targeted guidance retrieval
- explicit context budgets

These capabilities should work across hosts, even if specific compaction hooks differ per adapter.

---

## 9. Safety, Governance, and HITL

The system should define:

- approval modes
- sandbox/write-root policy
- network policy
- command/tool policy
- pause/resume on approval
- human decision checkpoints

These policies must be enforced by the harness/runtime/adapter combination rather than by prompt wording alone.

---

## 10. Workflow Architecture

Workflow modules define policy rather than persistence.

Possible workflow families:

- plan
- team
- review
- verify
- persistent completion workflows

Workflow policy remains host-agnostic.

---

## 11. Delegation and Parallelism Policy

The system must define explicit controls for:

- delegation depth
- worker fan-out
- when parallelism is allowed
- when solo execution is preferred
- when workers may re-delegate
- how negotiation loops are bounded

This policy belongs in workflow/runtime logic, not in host-specific session rules.

---

## 12. Guidance and Artifact Store

The guidance/artifact layer should store and retrieve:

- project conventions
- build/test/lint/typecheck commands
- architecture notes
- codebase map fragments
- large tool outputs
- verification evidence
- imported external artifacts

The prompt-facing path should use compact summaries or references.

---

## 13. Verification

Verification must be explicit and durable.

The system must support:

- declared verification requirements
- evidence storage
- verification status tracking
- completion gating
- waiver records when bypassing checks

This model should be independent of any single host.

---

## 14. Telemetry and Observability

Telemetry must support:

- task-level observability
- workflow-level rollups
- session-level rollups
- worker-level telemetry
- recovery visibility
- context/compaction visibility
- usage/token visibility where available

Host-native telemetry should be normalized into a common Coortex schema.

---

## 15. Hooks and Plugins

Hooks and plugins are optional extension surfaces.

### Hooks
Appropriate uses:
- startup/resume interception
- prompt validation
- command policy checks
- telemetry emission
- stop-time summaries

### Plugins
Appropriate uses:
- skills packs
- MCP integrations
- app integrations
- guidance packs

Neither hooks nor plugins may replace runtime truth.

---

## 16. Protocol Strategy

The system should adopt explicit protocol boundaries:

- MCP for tool/data integrations
- optional cross-agent interoperability later if needed
- optional UI/event protocols later if needed
- stable internal runtime and adapter schemas

Tool access, agent interoperability, and UI transport should remain distinct concerns.

---

## 17. Branching and Long-Running Work

The system should support:

- pause/resume
- intentional work/session forking
- branch identity
- branch comparison or reconciliation
- branch-aware recovery

These semantics should be runtime-based, not transcript-based.

---

## 18. Security and Data Handling

The system should define policies for:

- secret handling
- persisted session retention
- artifact retention
- log/telemetry redaction
- encryption or protected storage when needed
- trust boundaries for external host/plugin/tool data

---

## 19. Evaluation and Regression Measurement

The system must support harness-level evaluation, including:

- token usage by workflow
- latency by workflow
- recovery success rate
- compaction effectiveness
- verification completion rate
- coordination overhead comparisons
- adapter-specific capability differences

---

## 20. Success Criteria

The ideal system is achieved when:

- runtime truth is sufficient to execute and recover work without transcript replay
- multiple hosts can be supported through explicit adapters
- prompts or kernels remain small and stable
- bounded envelopes, trimming, and compaction keep context predictable
- governance and verification live in the harness
- telemetry explains system behavior clearly
- extensions remain optional and non-authoritative
