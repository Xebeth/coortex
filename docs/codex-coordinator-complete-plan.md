# Coortex Implementation Plan

## Purpose

This document provides a consolidated implementation plan for Coortex after the pivot to a host-agnostic design.

It should be read together with:

- `docs/coortex-ideal-spec.md`
- `docs/coortex-milestone-1-plan.md`
- `docs/coortex-roadmap.md`

---

## Planning Summary

The implementation strategy is:

1. build the host-agnostic core
2. prove it with one reference adapter
3. harden recovery, trimming, and telemetry
4. add workflows
5. add a second host adapter
6. expand governance and extension surfaces

This plan intentionally avoids anchoring the system around a single host.

---

## First Milestone Priorities

1. runtime state model
2. persistence
3. recovery brief generation
4. bounded task-envelope logic
5. trimming
6. telemetry scaffold
7. adapter contract
8. one reference adapter
9. minimal CLI/status surfaces

---

## Long-Term Priorities

1. recovery hardening
2. verification
3. guidance/artifact store
4. history compaction
5. workflow modules
6. additional host adapters
7. governance/approvals
8. hooks/plugins
9. richer observability

---

## Implementation Rule

Whenever there is tension between:

- host-specific convenience
- and host-agnostic runtime truth

prefer the host-agnostic runtime truth.
