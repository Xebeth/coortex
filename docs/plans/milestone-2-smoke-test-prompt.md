Adversarial implementation of Milestone 2 smoke tests for Coortex.

Repo:
- Root: /path/to/coortex

Task:
Implement a small, reliable smoke test suite for Milestone 2.

Read first:
- README.md
- docs/scope.md
- docs/architecture.md
- docs/module-boundaries.md
- docs/runtime-state-model.md
- docs/codex-profile-integration.md
- docs/telemetry.md
- docs/implementation-phases.md
- docs/coortex-ideal-spec.md
- docs/coortex-roadmap.md
- docs/milestone-2-manual-test-checklist.md

Goal:
Add smoke tests that validate the first real host-integrated execution slice without turning the test suite into a fragile end-to-end lab.

Important constraints:
- This is a smoke-test task, not a framework rewrite.
- Prefer deterministic tests.
- Prefer one fake/stub host plus thin real-artifact assertions over brittle deep integration.
- Do not broaden scope into workflows, approvals, plugins, or multi-host support.
- Keep tests aligned with the Milestone 2 contract only.

What the smoke tests should cover:
1. **Happy path execution**
   - assignment created or selected
   - bounded envelope built
   - host invoked through the adapter path
   - result packet persisted
   - status updated

2. **Blocked / decision path**
   - host returns a blocked/decision outcome
   - decision packet persisted
   - status reflects blocked or unresolved state

3. **Trimming path**
   - large output is trimmed before entering prompt-facing context
   - full output reference/artifact is preserved if that is part of the current design
   - envelope remains bounded

4. **Resume / recovery smoke path**
   - partial durable state exists
   - a resume operation rebuilds actionable state correctly
   - recovery brief is compact and derived from durable artifacts

5. **Profile / kernel smoke path**
   - profile artifacts are generated correctly
   - kernel artifact exists and is small/static
   - no runtime overlay is required for the path under test

Testing strategy:
- Use a stub/fake host adapter for the automated smoke suite unless a real host call is already intentionally testable and deterministic in CI.
- Keep host adapter responses explicit and controllable.
- Assert on runtime artifacts, not on vague console output alone.
- Preserve separation between:
  - unit tests
  - smoke tests
  - future real-host manual tests

What to inspect before coding:
- current test layout
- current adapter boundary
- current persistence/recovery design
- current trimming behavior
- current CLI/status behavior

Implementation requirements:
- add a clearly named smoke-test suite
- keep fixtures small
- avoid duplicating all unit-test coverage
- test the end-to-end Milestone 2 path at the adapter/runtime boundary
- assert on:
  - persisted result/decision artifacts
  - status state
  - recovery brief contents
  - envelope/trimming outcomes
  - profile/kernel artifacts where applicable

Do not:
- rewrite the adapter architecture
- add broad new abstractions just for tests
- make the suite depend on a human-installed host unless that path is explicitly separated and optional

At the end:
- report what smoke tests were added
- explain what they cover
- explain what is intentionally left to manual testing
- run the test suite and report results
