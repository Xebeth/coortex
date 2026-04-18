# Built-in Lens Catalog

These lens definitions are part of the skill, not part of the baseline document.

Use them as the starting catalog when configuring a project baseline.

## Built-in lenses

These are the same built-in lens ids that `coortex-review-lane` understands at
runtime. A baseline should configure a small ordered subset of them per
surface.

- `goal-fidelity`
  - Check requested behavior, closure-gate requirements, and review-handoff
    claims before style or cleanup concerns.

- `qa-execution`
  - Check runnable behavior, failure paths, and executable evidence when the
    review surface or lane explicitly needs execution-backed confidence.

- `quality`
  - Check logic correctness, maintainability, boundary hygiene, and pattern
    consistency inside the bounded surface.

- `security`
  - Check security risks and trust-boundary mistakes only.

- `api-contract`
  - Check public contract compatibility, error semantics, and downstream caller
    impact.

- `performance`
  - Check hot-path or algorithmic risks that materially affect the bounded
    review scope.

- `context-history`
  - Check nearby sibling paths, docs, adjacent callers, and relevant history to
    judge whether the root cause is wider than the immediate diff.

## Configuration guidance

- Configure built-in lenses per surface.
- Use a small prioritized set per surface.
- Add custom lenses only when built-ins cannot capture the project-specific concern cleanly.
