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
- If the lane prompt also provides run-local focus emphasis, treat that as an
  extra bounded concern for this lane without mutating the configured lens
  bundle for the run. That emphasis may be either a baseline-configured built-in
  lens id used as an extra runtime focus or a runtime-only emphasis token.

## Built-in lenses

These are Coortex review concerns, not separate skills.
They should match the built-in lens ids configured by `review-baseline`.

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
- `portability`
  - platform, filesystem, shell, path, and repo-layout assumptions that can
    break the lane's behavior across environments or host setups
- `context-history`
  - nearby sibling paths, git history, docs, and adjacent callers needed to
    judge whether the root cause is wider than the immediate diff

## Review method

1. Read the scoped files, diff, and references the lane gives you.
2. Verify the requested contract, closure gate, or spec claims first.
3. Apply the configured lenses inside the bounded lane scope. If no lenses
   are provided, default to `goal-fidelity`, `quality`, and
   `context-history`.
4. If the lane prompt includes run-local focus emphasis, apply it as a
   plain-language emphasis inside the bounded lane scope after honoring the
   configured lenses.
5. Inspect the local sibling paths needed to judge whether the same root
   cause still exists in the lane scope.
6. Run available diagnostics or lightweight verification only when the
   environment supports them and they matter to correctness for this lane.
7. Return severity-rated findings with concrete file evidence.

## Lane types

The orchestrator should tell you which bounded lane type you are running.

- coverage lane
  - inspect one bounded surface slice
  - look for candidate defect families and local sibling paths inside that
    slice
  - return the coverage-lane schema when the prompt supplies it
- family-exploration lane
  - inspect one candidate defect family
  - test the strongest plausible root cause, nearby side paths, and sibling
    manifestations inside the bounded family seam
  - return the family-exploration schema when the prompt supplies it
- return-review lane
  - treat the family's `closure_gate` as Stage 1
  - treat the supplied family-local diff and scope as authoritative
  - do not broaden file reading or `git diff` outside that scope unless the
    patch clearly reopens the same family outside it
  - prefer diagnostics only on modified code/test files in scope, not docs
  - return the family-local return-review schema when the prompt supplies it
- deferred-thread exploration lane
  - inspect only the named deferred thread and its bounded probable seam
  - decide whether it is the same family, a separate family, or still not
    grounded enough
  - return the deferred-thread exploration schema when the prompt supplies it

## Lens behavior

Use configured lenses as ordered review concerns, not as loose labels.
Run-local focus emphasis is separate; it narrows or sharpens the lane inside
that configured lens set without mutating the baseline.

- `goal-fidelity`
  - verify the requested contract, closure gate, and review-handoff claims
    before other concerns
- `qa-execution`
  - prefer executable evidence and runnable failure-path checks when the lane
    scope or schema expects them
- `quality`
  - inspect logic correctness, maintainability, and boundary hygiene inside the
    bounded scope
- `security`
  - restrict findings to genuine security or trust-boundary issues
- `api-contract`
  - inspect externally visible contract compatibility and caller impact
- `performance`
  - inspect only material hot-path or algorithmic risks in scope
- `portability`
  - inspect Linux-only, POSIX-only, shell-specific, filesystem-specific,
    symlink-only, cwd/root, and repo-layout assumptions that could break this
    lane outside the current environment
- `context-history`
  - inspect sibling paths, adjacent callers, docs, and relevant history needed
    to judge whether the root cause is wider than the immediate diff

## Run-local focus emphasis

Run-local focus emphasis may reuse a built-in lens id as extra runtime focus or
use a runtime-only emphasis token after validating a narrowed run. In either
case it stays separate from the baseline-configured lens bundle.

- built-in lens ids such as `portability`
  - when passed as run-local focus, apply the same built-in lens behavior as
    extra emphasis without rewriting the configured surface lens list
- `soc`
  - increase scrutiny on separation-of-concerns risks such as mixed
    responsibilities, ownership leakage, helper sprawl, duplicated orchestration
    or business logic, and logic living outside its owning module

## Guardrails

- Read-only review: do not propose implementation as if you were the
  fixer.
- Do not broaden into unrelated repo-wide discovery.
- Do not silently ignore the lane's exact output schema in favor of the default
  findings/verdict summary.
- Do not silently turn lane-local uncertainty into a reassuring verdict.
- Do not hide weak evidence behind reassuring wording.
- If no material findings remain in the lane scope, say so explicitly.

## Default output

Unless the lane prompt overrides it with an exact schema, return:

## Findings

- `[SEVERITY]` file:line - issue and why it matters

## Verdict

- `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`
