# Coortex Repository Instructions

These instructions apply to the entire repository.

## Standing rules
- Treat every bug, regression, or review finding as a possible defect family, not just an isolated symptom.
- Before implementing a fix or calling a finding closed, identify the higher-level root cause and check for sibling manifestations across the affected surfaces.
- Do not accept a fix or review conclusion that matches the current tests but violates the actual contract or invariants.

## Fix workflow rules
- Use each finding as a discovery prompt: do not patch only the reported line-local issue without checking whether the same cause appears elsewhere.
- Before marking a defect family closed, check the fix, its implications, and its likely siblings across the affected surfaces.
- Update tests and docs in the same slice when invariants, recovery semantics, or operator-visible behavior change.
- Before extracting a helper or adding new logic, check whether the abstraction already exists and place the code in the owning module, not just the nearest one.
- When fixing review findings, remove or absorb stale paths and conflicting ownership models instead of adding special-case local plumbing beside them.

## Review output rules
- For each finding, report the immediate cause, the higher-level root cause, and whether it belongs to a broader defect family.
- For each finding, report immediate implications, broader implications, and any sibling bugs found.
- If no sibling bugs are found, say so explicitly and state the search scope.
- Group related manifestations under one root cause when they come from the same boundary or lifecycle failure.

## Commit messages
- Every commit subject line must use the form `<type>: <subject>`.
- Keep the subject line at 50 characters or fewer.
- Allowed types are: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, and `chore`.
- After the subject, include a blank line and a body that explains what changed and why it changed, not how it was implemented.
- Keep commit bodies concise and omit boilerplate status or verification lists unless they add unique value.
- Wrap commit-message body lines at 72 characters.
- Add footer entries for issue references and breaking changes when applicable, for example:
  - `Fixes #123`
  - `BREAKING CHANGE: description`

## Documents
- When a change alters a documented invariant, contract rule, matrix
  expectation, or recovery semantics, update the corresponding docs in
  the same commit as the code or test change.

## For the architect role/skill
Read the following documents in this order:
  - `docs/architecture.md`
  - `docs/module-boundaries.md`
  - `docs/runtime-state-model.md`
  - `docs/codex-profile-integration.md`
  - `docs/telemetry.md`
  - `docs/coortex-ideal-spec.md`
  - `docs/coortex-roadmap.md`

These documents answer:
  - what the system is
  - where responsibilities live
  - what the runtime owns
  - what the host adapter boundary is
  - what the long-term target is

## For the planner role/skill
Read the following documents in this order:
  - `docs/scope.md`
  - `docs/implementation-phases.md`
  - `docs/coortex-roadmap.md`
  - `README.md`

These documents answer:
  - what is in scope now
  - what is explicitly out of scope
  - in what order to do things
  - what the next milestone should include
  - what success looks like for the next implementation slice
