# Repo-Local Quality Gates

## Status

This is a workflow reference for Coortex. It defines the intended policy model
for repo-local quality gates and the responsibilities of baseline, coordinator
prep, lanes, and final integration.

Current skills, prompts, and helpers may not yet enforce every part of this
model. Treat this document as the target contract unless a more specific
implementation note says otherwise.

## Purpose

Coortex needs a consistent model for repo-specific validation and cleanup
commands that can affect fixer flow, review flow, and commit safety.

This document defines:

- how Coortex discovers and classifies repo-local quality gates
- how those gates participate in baseline, prep, lane, and coordinator phases
- how to handle repo-global and mutating tools without contaminating bounded
  runs or commits
- what must be traced for post-mortem accountability

It does **not** replace repo-native docs such as `AGENTS.md`, CI config, or
package scripts. Those are inputs. The Coortex baseline is the normalized
workflow contract.

## Terms

### Repo-local quality gate

A repo-specific command or tool that can affect whether Coortex may hand off,
reopen, commit, or close a run.

### Bounded run

A **Coortex** workflow mode where the run is constrained to a bounded family,
seam, or commit set. Unrelated repo work must not be silently absorbed into the
run or commit.

### Scope-aware

A **tool property**. A tool is scope-aware when it can target or report cleanly
against a bounded subset such as explicit files or paths.

Scope-aware is not the same as bounded-run-safe:

- a repo-global read-only tool can still be usable in a bounded run
- a scope-aware mutator can still be disallowed if it expands the commit scope

### Guidance vs enforced discipline

Coortex distinguishes between:

- **guidance**
  - candidate commands discovered from repo docs, CI, scripts, or heuristics
- **enforced discipline**
  - the subset of commands and policies the Coortex baseline treats as binding
    for prep, handoff, and closeout

## Gate classification

The baseline should normalize each candidate gate with at least these fields:

- `command`
- `phase`
  - `precheck`
  - `deslop`
  - `pre_handoff`
  - `final_integration`
- `mutability`
  - `non_mutating`
  - `scope_mutating`
  - `repo_mutating`
  - `uncertain`
- `scope_awareness`
  - `scope_aware`
  - `repo_global`
  - `uncertain`
- `kind`
  - `guidance`
  - `enforced_gate`
- `handoff_blocking`
  - `true`
  - `false`
  - `uncertain`
- `source_type`
  - `manual`
  - `guessed`
  - `imported`
- `confidence`
  - `high`
  - `medium`
  - `low`
- `probe_file_scanned`
  - `yes`
  - `no`
  - `uncertain`
- Coortex policy fields
  - `allowed_in_bounded_runs`
  - `allowed_in_repo_wide_runs`
  - `requires_isolated_execution`
  - `requires_user_confirmation`

`allowed_in_bounded_runs` is a **Coortex policy judgment**, not a raw repo
fact.

## Ownership by phase

### Baseline

Baseline owns:

- candidate gate discovery
- gate classification
- provenance and confidence recording
- isolated probing when mutability or scan coverage is unknown

Baseline should not need to catalog the repo's full current warning inventory.
Its job is to understand **what the tool is** and **how Coortex may use it**.

When probing is needed, baseline may use a deliberately invalid synthetic file
in an **isolated** worktree or clean checkout. The goal is to learn:

- whether the tool scanned the probe file
- whether it wrote files
- whether writes were limited or broad

If baseline cannot prove the probe file was in scope for the tool, it must
record mutability and scan coverage as `uncertain` instead of overclaiming
safety.

### Coordinator prep

Prep owns:

- tracing the active repo state before the run starts
- cataloging preexisting findings for the current run
- comparing isolated findings and mutation footprint against the active working
  repo
- asking the user to resolve high-stakes uncertainty

If prep runs a mutating gate for cataloging, it must do so in isolation.
It must not use the active working tree for mutating cataloging runs.

Prep must compare:

1. an **isolated** snapshot result
2. the **actual** working repo state

The isolated snapshot tells Coortex what the gate finds and changes in a clean
environment. The working repo comparison tells the coordinator how that gate
interacts with current dirt, untracked files, and intended commit scope.

### Target lane pre-handoff sequence

Within a fixer lane, the recommended sequence is:

1. implement
2. deslop
3. lane-local repo quality gates
4. lane-local review
5. rerun final targeted verification after the deslop, quality-gate, and
   review sequence
6. `review_return_handoff`

Anything that can fail late and reopen the run should be pulled forward into
this pre-handoff sequence when possible.

### Coordinator final integration

Coordinator-side final integration remains the last closeout gate, but it
should not be the first place a predictable repo gate is enforced.

If a repo-global gate routinely reopens work late, that gate belongs earlier in
the lane or prep model.

## Hard rules

### 1. Distinguish cleanup from validation

- **deslop / cleanup** may mutate, but only under the appropriate scope rules
- **repo quality gates** should usually be read-only proof gates

Mutating linters and similar cleanup commands belong to cleanup or repo-wide
normalization, not to normal bounded-run handoff gating.

### 2. Repo-global mutators are not normal bounded-run gates

If a command mutates broadly across the repo, it is not a normal bounded-run
pre-handoff gate.

It may still be used:

- in isolated probing
- in isolated prep cataloging
- in an explicitly repo-wide cleanup mode

But it must not silently rewrite the active repo and then be treated as a
normal scoped handoff check.

### 3. Repo-global, non-scope-aware gates need attribution rules

A repo-global gate should reopen the current bounded work only when the result
is:

- inside the current write set, or
- clearly attributable to the current changes, or
- covered by an explicit whole-repo-clean policy declared for the run

Otherwise the finding must be classified and dispositioned separately, not
blindly bounced back onto the current lane.

### 4. Unrelated edits must never be silently committed

If a coordinator-side gate produces edits outside the intended commit set:

- do not revert them by default
- do not silently commit them
- leave them uncommitted
- surface them explicitly to the user
- require explicit disposition before closeout

### 5. Nothing can remain unclaimed

At run close, every leftover finding must end as one of:

- reopen current work
- separate follow-up
- matched existing debt
- explicit waiver/noise
- user-resolved uncertainty

“Unclaimed warnings left somewhere” is not an acceptable closeout state.

## Uncertainty handling

Guessed metadata is acceptable as a starting point, but not as silent policy.

If a guessed gate affects any of these, prep should ask the user before
enforcing it:

- handoff-blocking vs advisory
- mutating vs non-mutating when uncertain
- repo-global vs scope-safe when uncertain
- bounded-run compatibility
- diff-attributable vs whole-repo-clean run policy

Never silently enforce guessed metadata when it can:

- mutate files
- expand the commit scope
- reopen a run late

## Trace and accountability

To support post-mortem analysis, prep should trace at least:

Treat the labels below as target normalized prep trace record names. If an
implementation temporarily serializes them differently, it should map back to
these names explicitly instead of inventing ad hoc buckets.

### `prep_repo_state`

- current branch / head commit
- staged files
- unstaged files
- untracked files
- run mode
- commit policy

### `prep_preexisting_findings`

- gate name
- gate command
- isolated artifact refs
- findings summary
- mutation footprint summary
- confidence / uncertainty

### `prep_findings_comparison`

- comparison between isolated results and active repo state
- collision risk with dirty files
- uncertainty about attribution

The goal is to answer, after a bad run:

- what was already dirty
- what warnings already existed
- what the gate would change
- whether Coortex introduced unrelated edits

## Summary

The Coortex model for repo-local quality gates is:

- baseline discovers and classifies
- prep traces repo state and catalogs current findings
- lanes run confirmed handoff-blocking gates before handoff
- coordinator does not silently absorb unrelated edits or warnings at closeout

The key discipline is to separate:

- tool facts
- Coortex policy
- current run state

instead of letting any one of those leak into the others.
