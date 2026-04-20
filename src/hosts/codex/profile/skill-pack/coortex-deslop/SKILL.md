---
name: coortex-deslop
description: Run a bounded anti-slop cleanup pass for Coortex fix slices. Use when a touched seam or fix slice works but still carries dead code, duplication, needless abstraction, stale glue, or ownership drift, and you need a regression-tests-first cleanup that stays inside the caller-supplied file scope.
---

# Coortex Deslop

Reduce AI-generated slop with a regression-tests-first, smell-by-smell cleanup
workflow that preserves behavior, stays inside the current Coortex slice, and
raises signal quality without widening the patch.

## When to use it

Use this skill when:

- a fix slice or seam-walkback slice works but still feels bloated, noisy,
  repetitive, or over-abstracted
- follow-up implementation left duplicate logic, dead code, weak boundaries,
  missing tests, or unnecessary wrapper layers
- you already know the current slice and want a disciplined cleanup pass without
  reopening broader review
- the caller can provide a touched-files list or other bounded scope for the
  cleanup pass

Do not use this skill when:

- you still need discovery review; use `$coortex-review` or
  `$review-orchestrator` first
- you need root-cause repair from structured review output; use `$review-fixer`
  first
- you want a broad refactor with no behavior lock or bounded scope

## Coortex stance

- Treat the cleanup as part of a bounded fix slice, not as a new branch-wide
  campaign.
- Stay inside the caller-supplied file scope.
- Before adding a helper or new path, check whether the owning abstraction
  already exists.
- Remove or absorb stale glue instead of layering new local plumbing beside the
  real owner.
- If the cleanup reveals a sibling smell inside the same touched files, clean it
  up in-scope. If it points outside the bounded slice, report it as residual
  risk rather than widening the pass.
- Do not simplify in ways that violate runtime invariants, recovery semantics,
  or operator-visible contract.

## Deterministic helper

Use the bundled helper for the mechanical parts that benefit from consistency:

- `scripts/deslop_state.py resolve-scope` to normalize an explicit file list or
  changed-files artifact into a bounded repo-relative scope
- `scripts/deslop_state.py run-gates` to execute pre/post cleanup verification
  commands and capture their pass/fail status deterministically
- gate specs accept `label::command` by default and treat exit code `0` as
  success; use `label[expect=1]::command` or `label[expect=0,2]::command` when
  a search-style or multi-exit check has a different acceptable exit set

Keep the model focused on cleanup judgment. Let the helper handle scope intake
and gate execution.

## Workflow

### 1. Resolve the bounded scope

If the caller provides a changed-files artifact or explicit file list, normalize
it first with the helper:

```bash
python scripts/deslop_state.py resolve-scope \
  --project-root . \
  --changed-files-path .coortex/deslop/changed-files.txt
```

You may also pass explicit paths:

```bash
python scripts/deslop_state.py resolve-scope \
  --project-root . \
  --path src/cli/commands.ts \
  --path src/__tests__/cli.test.ts
```

Use the returned repo-relative file list as the hard cleanup boundary.

### 2. Lock behavior with regression tests first

Identify the behavior that must not change and run the current verification
commands before editing. Use the helper when you want deterministic gate capture:

```bash
python scripts/deslop_state.py run-gates \
  --project-root . \
  --artifact-dir .coortex/deslop/gates-pre \
  --gate "typecheck::npm run build" \
  --gate "targeted-tests::node --test dist/__tests__/cli.test.js" \
  --gate "dead-symbol-absent[expect=1]::rg -n 'dead_symbol' src tests"
```

If behavior is currently untested, add or run the narrowest regression coverage
needed first.

### 3. Create a cleanup plan before code

List the concrete smells to remove and keep the pass bounded to the resolved
scope.

Categorize issues before editing:

- **Duplication** — repeated logic, copy-paste branches, redundant helpers
- **Dead code** — unused code, unreachable branches, stale flags, debug
  leftovers
- **Needless abstraction** — pass-through wrappers, speculative indirection,
  single-use helper layers
- **Boundary violations** — hidden coupling, leaky responsibilities, wrong-layer
  imports or side effects
- **Missing tests** — behavior not locked, weak regression coverage, edge-case
  gaps

### 4. Execute passes one smell at a time

1. **Pass 1: Dead code deletion**
2. **Pass 2: Duplicate removal**
3. **Pass 3: Naming/error handling cleanup**
4. **Pass 4: Test reinforcement**

Re-run targeted verification after each pass when the change is risky enough to
justify it. Avoid bundling unrelated refactors into the same edit set.

### 5. Run post-cleanup quality gates

Rerun the current verification commands after cleanup. The helper can record the
results deterministically:

```bash
python scripts/deslop_state.py run-gates \
  --project-root . \
  --artifact-dir .coortex/deslop/gates-post \
  --gate "typecheck::npm run build" \
  --gate "targeted-tests::node --test dist/__tests__/cli.test.js" \
  --gate "dead-symbol-absent[expect=1]::rg -n 'dead_symbol' src tests"
```

Quality gates:

- regression tests stay green
- typecheck passes
- relevant unit/integration tests pass
- lint or static analysis passes when the current slice expects it
- diff stays minimal and scoped
- no new abstractions or dependencies unless explicitly required

### 6. Finish with an evidence-dense report

Report:

- resolved scope
- behavior lock used
- cleanup plan
- passes completed
- quality-gate status
- changed files
- remaining risks or consciously deferred follow-ups

## Conversation-visible progress

Keep the user informed while the cleanup pass runs.

- Use the conversation `update_plan` tool at the start and after each major
  cleanup pass or gate rerun.
- Do not rely only on prose status messages when `update_plan` is available.

- At the start, state the bounded scope, behavior lock, and first cleanup pass.
- After each major cleanup pass or gate rerun, update the in-conversation
  progress before continuing.
- If you decide a smell is out of scope or unsafe to clean, say so explicitly
  instead of silently skipping it.
- These updates are progress notes, not approval checkpoints. Unless the user
  explicitly asks you to pause or the cleanup is blocked on missing input,
  continue after the update without waiting for acknowledgment.

## Output format

```text
AI SLOP CLEANUP REPORT
======================

Scope: [files or bounded slice]
Behavior Lock: [targeted regression tests added/run]
Cleanup Plan: [bounded smells and order]

Passes Completed:
1. Pass 1: Dead code deletion - [concise fix]
2. Pass 2: Duplicate removal - [concise fix]
3. Pass 3: Naming/error handling cleanup - [concise fix]
4. Pass 4: Test reinforcement - [concise fix]

Quality Gates:
- Regression tests: PASS/FAIL
- Typecheck: PASS/FAIL
- Tests: PASS/FAIL
- Lint/static scan: PASS/FAIL or N/A

Changed Files:
- [path] - [simplification]

Remaining Risks:
- [none or short deferred item]
```

## Guardrails

- Do not widen beyond the caller-supplied scope.
- Do not start cleanup before protecting behavior with tests or explicit gate
  commands.
- Do not turn a deslop pass into a fresh architecture rewrite.
- Do not add a helper when the owning abstraction already exists.
- Do not leave stale paths or duplicate ownership models behind if the cleanup
  clearly exposes them inside the bounded slice.
- If a cleanup change alters documented contract wording or operator-visible
  behavior, update the matching docs/tests in the same slice.
