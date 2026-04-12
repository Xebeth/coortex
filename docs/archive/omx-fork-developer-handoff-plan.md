# Migration Handoff: From the OMX Fork to Coortex

## Purpose

This document explains how the current OMX-derived work informs Coortex after the pivot to a host-agnostic design.

The OMX fork is useful as a source of validated ideas, not as the architectural center of Coortex.

---

## What should be carried forward

The OMX-related work is useful for studying and extracting:

- quiet orchestration patterns
- runtime-backed assignment/result/decision concepts
- layered disclosure and instruction compaction ideas
- trimming and token-discipline lessons
- telemetry gaps and practical observability needs

---

## What should not be carried forward as architecture

Do not carry forward these OMX-era assumptions directly:

- runtime-generated instruction overlays
- orchestration truth living in prompt text
- mailbox-dependent normal coordination
- host-specific behavior hardcoded into the core
- global+project instruction concatenation as the orchestration model

---

## Post-pivot interpretation

After the host-agnostic pivot:

- quiet orchestration becomes a **runtime/workflow concept**
- layered disclosure becomes a **bounded-envelope and retrieval concept**
- host-specific integration becomes an **adapter concern**
- prompt/kernel behavior becomes **small and host-specific**, not the system core

---

## Practical use of the fork

Use the fork as reference material for:

- implementation ideas
- migration notes
- empirical token/coordination lessons
- trimming and compaction tactics
- telemetry lessons

Do not use it as the blueprint for the Coortex architecture.

---

## Relationship to current build

The current build should follow:

- `docs/architecture.md`
- `docs/module-boundaries.md`
- `docs/runtime-state-model.md`
- `docs/host-adapters.md`

The fork should only inform implementation choices where it supports the current architecture.
