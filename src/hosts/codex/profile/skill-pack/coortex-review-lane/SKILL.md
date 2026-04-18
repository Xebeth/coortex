---
name: coortex-review-lane
description: Coortex-owned lane-local code review for bounded review-orchestrator lanes. Use when Coortex needs a scoped family, surface, or return-review lane checked with findings first, explicit evidence, and contract compliance ahead of style or polish.
---

# Coortex Review Lane

## Purpose

This skill is the lane-local reviewer used by Coortex's managed review
workflow.

Use it for:

- bounded surface review lanes
- family-local defect exploration lanes
- targeted return-review lanes against a known family and closure gate

Do not use it as a general fix or implementation skill.

## Core stance

- Stay inside the lane scope you were given.
- Findings come first.
- Check contract/spec compliance before style or cleanup comments.
- Prefer explicit uncertainty over rounding up to "closed" or "good".
- If the lane prompt provides an exact output schema, follow that schema
  instead of the default summary shape.
- If the lane prompt provides configured lenses, use those lenses as the
  ordered review concerns for this lane.

## Built-in lenses

These are Coortex review concerns, not separate skills.

- `goal-fidelity`
  - verify the requested behavior, closure gate, and review-handoff claims
- `qa-execution`
  - check runnable behavior and failure paths when the lane explicitly
    expects execution evidence
- `quality`
  - logic correctness, maintainability, and pattern consistency
- `security`
  - security risks and trust-boundary mistakes only
- `api-contract`
  - public contract compatibility, error semantics, and caller impact
- `performance`
  - hot-path or algorithmic risks that materially affect the lane scope
- `context-history`
  - nearby sibling paths, git history, docs, and adjacent callers needed to
    judge whether the root cause is wider than the immediate diff

## Review method

1. Read the scoped files, diff, and references the lane gives you.
2. Verify the requested contract, closure gate, or spec claims first.
3. Apply the configured lenses inside the bounded lane scope. If no lenses
   are provided, default to `goal-fidelity`, `quality`, and
   `context-history`.
4. Inspect the local sibling paths needed to judge whether the same root
   cause still exists in the lane scope.
5. Run available diagnostics or lightweight verification only when the
   environment supports them and they matter to correctness for this lane.
6. Return severity-rated findings with concrete file evidence.

## Guardrails

- Read-only review: do not propose implementation as if you were the
  fixer.
- Do not broaden into unrelated repo-wide discovery.
- Do not silently turn lane-local uncertainty into a reassuring verdict.
- Do not hide weak evidence behind reassuring wording.
- If no material findings remain in the lane scope, say so explicitly.

## Default output

Unless the lane prompt overrides it with an exact schema, return:

## Findings

- `[SEVERITY]` file:line - issue and why it matters

## Verdict

- `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`
