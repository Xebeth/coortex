# Coortex Repository Instructions

These instructions apply to the entire repository.

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
