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
commands that can affect fixer flow, return-review closure checks, and commit
safety.

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

### Finish gate

A repo-local quality gate that must be satisfied, explicitly waived, or marked
not applicable before a fix, closure check, or commit unit can be considered
finished.

Finish gates are not discovered by lanes. They are fixed at baseline time when
possible and resolved during fixer or closure-check prep when they depend on
the current surface, changed files, package, project, module, or tool output
path. Normal defect-discovery review may surface gate references for downstream
fixer prep, but it does not resolve or enforce finish gates.

### Resolved gate

A finish gate whose command, inputs, owner, blocking policy, evidence
expectation, and applicability have already been made concrete for the current
run.

Return-review, closure-check, and fixer lanes receive resolved gates only. If a
required gate cannot be resolved before those lanes start, the coordinator
blocks the run and asks for a baseline refresh or operator decision.

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

The fields below are the target normalized gate model for baselines and
coordinator prep. Until the baseline schema and validators support these fields
directly, treat them as proposed policy metadata that must stay consistent with
the runnable skill contracts.

The baseline should normalize each candidate gate with at least these fields:

- `id`
- `command`
  - or `command_template` when the command cannot be concrete until prep
- `phase`
  - `precheck`
  - `deslop`
  - `pre_handoff`
  - `final_integration`
- `applies_to`
  - `reviewer`
  - `fixer`
  - `both`
- `owner`
  - `lane`
  - `coordinator`
  - `both`
- `stage_owners`
  - required when `owner: both`
  - maps each blocking stage to `lane` or `coordinator`
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
- `blocking_stages`
  - `return_review_approval`
  - `review_return_handoff`
  - `family_closure`
  - `commit_ready`
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
- resolution fields
  - `resolution`
    - `baseline`
    - `coordinator_prep`
  - `required_inputs`
  - `applicability`
  - `evidence_expectation`
  - `failure_policy`

`allowed_in_bounded_runs` is a **Coortex policy judgment**, not a raw repo
fact.

`handoff_blocking` is a coarse backward-compatible field. New policy should use
`blocking_stages` for machine-readable enforcement. If both fields are present,
they must agree: `handoff_blocking: true` means the gate blocks at least the
lane or return handoff stage named by `blocking_stages`.

Blocking stage names mean:

- `return_review_approval`: return review may not approve closure evidence as
  sufficient
- `review_return_handoff`: a fixer lane may not emit a closure-claiming return
  handoff, though it may emit a blocked return handoff with gate evidence
- `family_closure`: the family may not be marked closed
- `commit_ready`: the coordinator may not commit the family or run

`owner: both` is not an either/or shortcut. A both-owned gate must declare the
stage ownership explicitly: the lane supplies evidence for lane-owned handoff
stages, and the coordinator supplies or verifies evidence for coordinator-owned
final stages. Missing evidence from either required stage remains blocking.

Surfaces should reference the finish gates they require rather than forcing
coordinators or lanes to infer them:

```yaml
repo_quality_gates:
  - id: "build-touched-project"
    command_template: "build command for the resolved touched project"
    applies_to: "both"
    owner: "lane"
    phase: "pre_handoff"
    kind: "enforced_gate"
    handoff_blocking: true
    blocking_stages:
      - "review_return_handoff"
      - "family_closure"
      - "commit_ready"
    mutability: "non_mutating"
    scope_awareness: "scope_aware"
    allowed_in_bounded_runs: true
    resolution: "coordinator_prep"
    required_inputs:
      - "touched_project"
    evidence_expectation: "exit status and captured build output"
    failure_policy: "block listed stages when red, blocked, or hanging"

surfaces:
  - id: "runtime-recovery"
    finish_gate_refs:
      - "build-touched-project"
```

This is a schema example, not a literal command recommendation. A real baseline
must either store the concrete command when it is knowable or define the exact
prep-time inputs needed to resolve the template.

## Ownership by phase

### Baseline

Baseline owns:

- candidate gate discovery
- gate classification
- provenance and confidence recording
- isolated probing when mutability or scan coverage is unknown
- static finish-gate resolution when the command is knowable without current
  run context
- declaring prep-time resolution inputs when the command depends on the
  touched surface, package, project, module, solution, or artifact path

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

If baseline cannot make a gate concrete, it must not leave the lane to guess.
It must record:

- which surfaces reference the gate
- whether the gate applies to return-review lanes, fixer lanes, or both
- who owns the gate in the run
- which inputs prep must resolve
- which stages the gate blocks
- what evidence proves success
- what terminal state applies when the gate cannot be resolved

### Coordinator prep

Prep owns:

- tracing the active repo state before the run starts
- mapping changed files into baseline surfaces
- collecting each surface's referenced finish gates
- resolving every required prep-time gate into concrete commands, inputs,
  applicability, owner, and evidence expectations
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

Prep is the last acceptable point for predictable gate uncertainty. Before any
return-review, closure-check, or fixer lane starts, every required finish gate
for that lane must be one of:

- resolved into a concrete gate packet
- marked not applicable with trace evidence
- explicitly waived by policy or operator decision

If a required gate is still missing, templated without resolvable inputs,
unsafe, or ambiguous, prep must block with a baseline/configuration failure.
It must not spawn lanes and let them rediscover the missing check later.

The coordinator should trace a resolved gate plan before spawning lanes. That
plan is the authoritative source for lane prompts, return review, and final
closeout.

### Review discovery and return-review execution

Normal defect-discovery review lanes and review coordinators do not discover,
resolve, run, or enforce finish gates. They may carry baseline gate references
as downstream fixer-prep context, but a discovery `review_handoff` must not
pretend those gates have already been resolved.

Return-review and closure-check lanes use resolved gates to judge whether
evidence is sufficient:

- missing required gate evidence is a protocol failure
- unresolved required gates block closure-check lane execution
- return-review approval must not imply that required finish gates were optional
- no closure approval should be emitted for a family whose required finish
  gates were neither resolved nor explicitly marked not applicable during prep

Reviewers may inspect gate output and decide whether the evidence supports the
review claim, but they do not invent replacement commands.

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

Fixer lanes receive concrete lane-owned gate packets from coordinator prep.
They run those exact gates and report the evidence. They do not guess commands,
resolve templates, choose substitute tools, or decide that a missing required
gate is optional.

If a provided gate command is invalid or impossible to run, the lane reports the
provided gate failure. That is a prep/baseline failure, not a license for the
lane to rediscover a different gate.

### Coordinator final integration

Coordinator-side final integration remains the last closeout gate, but it
should not be the first place a predictable repo gate is enforced.

If a repo-global gate routinely reopens work late, that gate belongs earlier in
the lane or prep model.

Final integration uses the same resolved gate plan. Coordinator-owned gates
remain coordinator-owned, lane-owned gates must already have lane evidence, and
any missing gate evidence blocks `commit_ready` unless the gate was marked not
applicable or explicitly waived during prep.

For `owner: both`, final integration follows the gate's `stage_owners` map.
Coordinator stages require coordinator evidence; lane stages require carried
lane evidence. A coordinator must not treat successful lane evidence as
satisfying a distinct coordinator-owned stage unless the resolved gate plan says
that reuse is allowed.

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

### 6. No late finish-gate surprises

Before the relevant lanes start, every required finish gate for the surface must
be resolved, explicitly waived, or marked not applicable.

Before `review_return_handoff`, `return_review_approval`, `family-closed`, or
`commit_ready`, every applicable required finish gate must then be satisfied or
converted into an explicit blocker. Normal discovery review may emit
`review_handoff` without a resolved gate plan, but only as downstream
fixer-prep context. It must not claim closure or gate satisfaction.
Closure-check and fixer-return handoffs must trace the resolved gate plan and
carry failed or missing evidence as actionable work.

Anything that can be anticipated at baseline time belongs in the baseline.
Anything that depends on the current run belongs in fixer or closure-check
prep. Nothing that affects finish-gate enforcement should first appear during
lane execution or final closeout.

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

### `prep_resolved_finish_gates`

- surface ids
- gate ids
- resolved command or not-applicable/waiver state
- owner (`lane`, `coordinator`, or `both`)
- stage owners when `owner: both`
- applies-to target (`reviewer`, `fixer`, or `both`; `reviewer` means
  return-review or closure-check evidence, not broad discovery review)
- blocking stages or advisory policy
- evidence expectation
- required inputs used for resolution
- unresolved or waived rationale, when applicable

The goal is to answer, after a bad run:

- what was already dirty
- what warnings already existed
- what the gate would change
- which finish gates were required for each surface
- whether those gates were resolved before lanes started
- whether Coortex introduced unrelated edits

## Summary

The Coortex model for repo-local quality gates is:

- baseline discovers, classifies, and declares or resolves finish gates when
  possible
- prep traces repo state, resolves context-dependent finish gates, and blocks
  before lane execution when required gates are missing
- return-review, closure-check, and fixer lanes consume resolved gates instead
  of guessing checks
- lanes run confirmed lane-owned handoff-blocking gates before handoff
- coordinator uses the same resolved gate plan for final integration and does
  not silently absorb unrelated edits or warnings at closeout

The key discipline is to separate:

- tool facts
- Coortex policy
- current run state
- baseline-declared finish gates
- prep-resolved gate packets

instead of letting any one of those leak into the others.
