# Findings: Potential OpenCode Adapter for Coortex

## Purpose

This document summarizes the findings from reviewing the `oh-my-openagent` repository as a potential aid or dependency for an OpenCode adapter in Coortex.

The goal is to answer four questions:

1. What does `oh-my-openagent` actually add to OpenCode?
2. Which OpenCode host gaps does it close for a Coortex-like system?
3. Which gaps remain even with that repository?
4. Should Coortex depend on it, require users to install it, or extract selected capabilities into its own adapter?

---

## Executive Summary

`oh-my-openagent` significantly improves OpenCode as a host for a Coortex-like system.

It closes many of the **host seam** gaps that matter for a coordination layer:

- lifecycle interception
- session continuity helpers
- compaction and trimming
- compatibility loading for skills/agents/MCP/config-style assets
- several practical hook-based guardrails

However, it does **not** provide the core runtime architecture that Coortex needs.

It does not appear to provide:

- runtime-owned orchestration truth
- a durable workflow/checkpoint engine
- a full telemetry/observability model aligned with Coortex’s spec
- a harness-owned approval/sandbox/governance model
- a host-agnostic runtime architecture

The correct conclusion is:

- `oh-my-openagent` is a strong **reference implementation and source of adapter ideas**
- it may be acceptable as an **optional installation requirement for an early OpenCode integration**
- it should **not** become the architectural foundation of Coortex
- the long-term OpenCode adapter should own its own contract and selectively implement or vendor the required capabilities

---

## What the Repository Appears to Do

The repository is not just a set of prompt files or skill definitions. It is an OpenCode plugin/harness layer built around the OpenCode plugin and SDK surfaces.

Its entrypoint and supporting modules show that it adds:

- plugin-level configuration
- chat/message/system transforms
- command pre-execution handling
- tool pre- and post-execution handling
- event handling
- compaction-time behaviors
- recovery/session-oriented helpers
- tooling and guards around common host actions

This makes it much closer to a real host adaptation layer than a passive content pack.

---

## Host Gaps It Closes Well

## 1. Lifecycle interception

One of the main concerns for an OpenCode host adapter is whether there are enough seams to intercept and shape behavior at the right moments.

This repository substantially closes that gap.

It adds integration points around:

- message transforms
- system transforms
- command execution
- tool execution
- event handling
- session compaction

This makes OpenCode much more workable as a host for:

- startup/resume handling
- compact context shaping
- runtime reminders
- command/tool policy enforcement
- lifecycle telemetry

### Assessment
**Status:** mostly closed

---

## 2. Trimming and compaction

This is one of the strongest areas of the repository and one of the most important for a Coortex-style design.

The repository includes logic for:

- tool-output truncation
- context-window monitoring
- preemptive compaction
- preserving actionable context across compaction

This directly addresses one of the biggest practical risks in host integration: uncontrolled prompt growth due to shell output, searches, test logs, and repeated tool results.

### Assessment
**Status:** strongly closed

---

## 3. Session continuity helpers

The repository includes support for:

- session recovery behavior
- continuation state
- session-oriented tooling
- error recovery for some host/session failures

This is valuable because it reduces the amount of raw host glue that Coortex would otherwise need to build just to make OpenCode tolerable for long-lived work.

However, this is not the same as a full runtime-owned recovery model. It is closer to session repair and continuity assistance.

### Assessment
**Status:** partly closed

---

## 4. Compatibility loading

The repository includes loaders for multiple forms of configuration and packaged behavior, including Claude-style assets and OpenCode skills.

That helps close the ecosystem/portability gap by making OpenCode more flexible as a host and lowering friction for reuse of established conventions and content.

### Assessment
**Status:** strongly closed

---

## 5. Hook-based guardrails

The repository includes several practical guardrails, including protections around file writes, reads, redirect handling, and related host/tool behaviors.

These are meaningful improvements over a host with no policy layer at all.

However, these remain hook/plugin-level guardrails rather than a full governance model.

### Assessment
**Status:** partly closed

---

## Gaps It Does Not Close

## 1. Runtime-owned orchestration truth

This is the most important gap.

Coortex’s core design requires durable runtime ownership of:

- assignments
- result packets
- decision packets
- lifecycle transitions
- verification state
- recovery state

`oh-my-openagent` does not appear to provide that kind of runtime-first orchestration core.

It is still primarily a host/plugin/hook/session enhancement layer rather than a durable coordination runtime.

### Assessment
**Status:** not closed

---

## 2. Durable workflow engine

Coortex’s target architecture calls for durable workflow behavior that can survive interruption and resume from explicit runtime state.

The repository adds recovery-oriented behavior and continuation helpers, but it does not appear to provide:

- typed workflow state machines
- durable workflow checkpoints
- workflow-graph execution with explicit persisted transitions
- core runtime-owned workflow semantics

### Assessment
**Status:** not closed

---

## 3. Full telemetry model

The repository improves visibility in some important areas such as context monitoring and compaction-related behavior.

But it does not appear to implement the full telemetry model Coortex wants, including:

- per-assignment rollups
- per-workflow rollups
- durable token/session/workflow ledger
- structured recovery metrics
- telemetry as a first-class runtime subsystem

### Assessment
**Status:** partly closed

---

## 4. Harness-level approvals and governance

The repository improves policy enforcement through hooks and guards, but that is not the same as a first-class harness governance model.

It does not appear to provide a full system for:

- approval modes
- pause/resume on approval
- durable authority checkpoints
- explicit sandbox/write-root governance
- network policy governance

### Assessment
**Status:** not closed

---

## 5. Host-agnostic architecture

The repository is deeply valuable as an OpenCode enhancement layer, but it is host-specific by design.

It does not provide a host-neutral coordination core or adapter abstraction.

That means it cannot replace the need for Coortex’s own host-adapter interface.

### Assessment
**Status:** not closed

---

## Adapter Strategy Options

There are three realistic approaches.

## Option A — Make `oh-my-openagent` a required dependency for OpenCode support

### Model
Require users who want OpenCode support to install the plugin, and build the first OpenCode adapter assuming it is present.

### Advantages
- fastest path to a useful OpenCode integration
- avoids rebuilding host-specific seams immediately
- leverages existing compaction/trimming/session glue
- gives the adapter strong lifecycle surfaces early

### Risks
- Coortex would depend on a separate host-specific project it does not control
- adapter behavior would inherit that project’s configuration model and assumptions
- changes in that plugin could become breaking changes for Coortex users
- architecture could drift toward the plugin’s design rather than Coortex’s own adapter contract

### Assessment
Reasonable as a **prototype or transitional strategy**, weak as a long-term architectural dependency.

---

## Option B — Treat it only as a reference implementation

### Model
Do not require installation. Study the repository and reimplement needed capabilities in the Coortex OpenCode adapter.

### Advantages
- full ownership of adapter behavior
- cleaner long-term boundary
- no dependence on third-party release cadence or configuration model
- easier to keep the adapter aligned with Coortex’s runtime-first design

### Risks
- slower initial OpenCode integration
- requires rebuilding host glue that already exists elsewhere
- more work before the OpenCode adapter becomes practical

### Assessment
Best **long-term** architecture, but not the fastest route to initial support.

---

## Option C — Transitional dependency with selective extraction

### Model
Support an initial OpenCode adapter that assumes `oh-my-openagent` is installed, while treating that as a temporary bridge. Over time, extract or reimplement the specific capabilities needed in the Coortex adapter and remove the requirement.

### Advantages
- practical time-to-first-support
- preserves a long-term path toward architectural independence
- allows prioritization of high-value capabilities first
- reduces immediate host-integration effort

### Risks
- temporary dependency could linger if not managed actively
- adapter boundaries must be defined carefully to avoid accidental lock-in
- documentation and support become more complex during the transition

### Assessment
Best overall balance if OpenCode support is important relatively early.

---

## Recommended Strategy

The best strategy is:

**Option C: a transitional dependency with selective extraction.**

### Recommended policy

1. Do **not** let `oh-my-openagent` define Coortex architecture.
2. Do allow it to accelerate the first OpenCode adapter if OpenCode support is needed early.
3. Treat it as a temporary host-augmentation dependency, not as the source of truth.
4. Define a Coortex-owned OpenCode adapter contract from the start.
5. Gradually replace the dependency with native adapter capabilities where the abstraction boundary becomes clear.

---

## What Coortex Should Extract or Reimplement

If Coortex uses `oh-my-openagent` as a transitional dependency, the long-term OpenCode adapter should own these capabilities directly.

## 1. Lifecycle interception glue

Needed for:

- startup handling
- resume handling
- message/system shaping
- stop/finalization behavior
- tool/command policy integration

This is one of the first capabilities worth reimplementing in a Coortex-owned adapter.

## 2. Trimming and compaction hooks

Needed for:

- large tool-output truncation
- context-window monitoring
- compaction-safe preservation of actionable state
- bounded envelope enforcement

This is a high-value area and should be treated as core adapter functionality over time.

## 3. Session continuity mapping

Needed for:

- resume/continue mapping between OpenCode sessions and Coortex runtime state
- graceful recovery from host/session interruption
- minimizing host-specific resume pain

## 4. Telemetry extraction and normalization

Needed for:

- token/session/workflow telemetry
- compaction telemetry
- session continuity telemetry
- host-neutral reporting in Coortex

---

## What Coortex Should Not Inherit Wholesale

The following should not be imported wholesale into Coortex as permanent architectural dependencies:

- broad Claude compatibility loaders
- generalized agent catalogs
- plugin-defined orchestration policy
- host-specific skill/loading abstractions beyond what the adapter actually needs
- broad hook stacks that exceed Coortex’s explicit adapter contract

These are useful in that repository, but too broad to become the basis of a clean Coortex adapter.

---

## Recommended OpenCode Adapter Boundary

The Coortex OpenCode adapter should ultimately own:

- session startup/resume integration
- bounded envelope injection
- trimming and compaction integration
- session-to-runtime mapping
- telemetry extraction and normalization
- command/tool lifecycle glue needed for Coortex runtime coordination

The adapter should not outsource its core contract to an external plugin.

---

## Final Conclusion

`oh-my-openagent` is a meaningful improvement to OpenCode as a host.

It closes many of the important **adapter-level** gaps:

- lifecycle interception
- session helpers
- compaction/trimming
- compatibility loading
- hook-based practical guardrails

It does **not** close the **core runtime** gaps that Coortex still needs to own:

- runtime-first orchestration truth
- durable workflow state
- explicit result/decision/verification artifacts
- full recovery substrate
- full telemetry model
- harness-level governance

The most practical approach is:

- treat the repository as a **strong reference implementation**
- optionally require it for **early OpenCode support**
- design the Coortex OpenCode adapter as a Coortex-owned boundary from day one
- plan to absorb or reimplement the necessary capabilities over time

This preserves time-to-first-support without turning a host-specific plugin into the foundation of the overall system.
