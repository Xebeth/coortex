---
name: review-orchestrator
description: Execute bounded multi-agent code review from a persistent project review baseline or perform targeted return review against a review handoff. Use when a project already has a review baseline and you need to review local changes, a commit, a commit range, or a branch delta with dynamic prep, bounded surface lanes, mandatory defect-family exploration, severity-rated findings, and final coordinator synthesis, or when you need to independently re-review completed fix work against an existing review handoff.
---

# Review Orchestrator

## Overview

Run a review directly from a project-resident baseline without writing a separate review plan.
Branch early between:
- full discovery review from the project baseline
- targeted return review from a `review_handoff` plus a `review_return_handoff`

In full discovery mode, do prep first, then spawn bounded coverage lanes, then run mandatory family-exploration lanes before synthesizing the final verdict.
In targeted return-review mode, stay family-local and review the completed fix against the already-known family context.

## Workflow

1. Load these references as needed:
   - `references/prep-and-refusal.md`
   - `references/execution-model.md`
   - `references/report-contract.md`
   - `references/review-handoff.md`
   - `references/closure-gate.md`
   - `references/return-review.md`
   - `references/trace-artifact.md`
   - `scripts/return_review_state.py` for deterministic targeted return-review state checks and full-review narrowing validation
2. Determine review mode:
   - full discovery review from the project baseline
   - targeted return review from `review_handoff + review_return_handoff`
3. Create or resume the run trace directory/files via the bundled helper described in `references/trace-artifact.md`.
4. If this is a full discovery review:
   - load the baseline from a user-provided explicit path when one was supplied
   - if the user explicitly requests a listed alternative baseline by id, name, path, or stated purpose, resolve and load that variant baseline instead of the primary one
   - otherwise, load the baseline from the project's explicit configured path if one exists
   - otherwise, use `docs/review-baseline.yaml` when the project has a `docs/` directory, or `doc/review-baseline.yaml` when it has a `doc/` directory but no `docs/` directory
   - if the project has neither `docs/` nor `doc/` and no explicit baseline path is established, ask the user where the baseline lives before proceeding
   - if the user asks for a run-local narrowing inside the selected baseline, infer a candidate surface/path-subset/focus tuple from the user's wording, serialize the selected baseline to JSON, and run the bundled narrowing helper before prep
   - run full-review prep
   - spawn coverage lanes, using bounded waves when required lane count exceeds current subagent capacity
   - group coverage findings into candidate defect families
   - spawn mandatory family-exploration lanes, using bounded waves when required lane count exceeds current subagent capacity
5. If this is a targeted return review:
   - load the original `review_handoff`
   - load the `review_return_handoff`
   - gather the actual fix diff
   - serialize the machine handoff blocks to JSON and run the bundled return-review state helper for deferred-family validation/classification when `deferred_families` are present
   - run return-review prep
   - spawn return-review lanes, using bounded waves when required lane count exceeds current subagent capacity
   - if the fixer reported deferred families that materially overlap the current diff or no longer look safely deferrable, spawn family-local or broader cross-family re-review lanes for those families too
   - if the fixer reported grounded deferred threads, spawn targeted exploration lanes for those threads, also using bounded waves when required
6. Synthesize the final review result.
7. In targeted return-review mode, when any families remain actionable after synthesis, emit a refreshed open-families-only `review_handoff` for the next fixer slice.
   - when deferred families are only being carried forward, use the bundled helper to assemble that refreshed handoff skeleton
8. Append the final trace records on disk.
9. Append normalized family outcomes to the repository family ledger on disk.
10. Use the bundled helper to query which families were reopened by the current run and surface those results explicitly in the final review output.

## Hard Rules

- In full discovery review, refuse if the baseline is missing, unparseable, stale, or too underspecified for grounded execution.
- In full discovery review, use the primary baseline by default. Only switch to an alternative baseline when the user explicitly requests one or provides an explicit baseline path.
- If an alternative baseline is selected, it must be standalone and parseable on its own. Do not merge it with the primary baseline at runtime.
- In full discovery review, run-local narrowing may only reduce the selected baseline to one compatible surface/path subset plus optional focus emphasis. It must not invent new surfaces, rewrite anchors, or compose several baseline files.
- When the user asks for a natural-language narrowing such as a module name or focus phrase, infer the candidate override tuple and run the bundled helper to validate it. Do not require the user to supply the structured tuple directly.
- Do not fall back to temporary rediscovery.
- Do not edit, patch, or repair the baseline in this skill. If prep finds baseline drift or stale mapping, stop and direct the user back to `review-baseline` to refresh it.
- Do not write a separate review plan.
- Codex built-in subagent types for this workflow are `default`, `explorer`, and `worker`.
- Use `default` subagents for every coverage lane, family-exploration lane, return-review lane, and deferred-thread exploration lane.
- Spawn review lanes with `fork_context: false`.
- In every lane prompt, explicitly invoke `$coortex-review-lane` as the review skill.
- Do not use `explorer` or `worker` as the final review worker for any lane. If extra reconnaissance is needed, keep it inside the `default` review worker's process rather than changing the lane worker type.
- Do not rely on inherited thread context for lane behavior. Pass only the scoped lane prompt, review window, handoff fields, and file/diff scope the lane actually needs.
- Do not waste lane-prompt budget on redundant meta-role reminders when `fork_context: false` and the scoped task already make the lane role clear.
- Treat a lone bug as a one-finding defect family.
- Run family exploration for every candidate family found in coverage.
- Use severity in every lane report and in the final synthesis.
- When given the original `review_handoff` plus a `review_return_handoff`, run a targeted re-review against that family context instead of redoing a broad discovery pass.
- In targeted return-review mode, read each family's `closure_gate` from the `review_handoff`. Do not expect a separate standalone `closure_gate` artifact.
- In targeted return-review mode, do not stop at a verdict ledger when families remain open. Emit a refreshed downstream `review_handoff` containing only the still-actionable families.
- A refreshed downstream `review_handoff` must be rebuilt from the original family entry plus return-review lane evidence. Do not reuse the original family entry unchanged, and do not replace it with bare `family_results` verdict rows.
- In targeted return-review mode, preserve structured fixer-reported deferred families. If a deferred family still remains actionable and its defer reason still holds, carry it forward in the refreshed downstream `review_handoff`; if the defer reason points to a broader shared seam, reopen exploration under that broader hypothesis.
- In targeted return-review mode, do not reactivate dormant deferred families by default. When a fixer-reported deferred family is `user-scope-excluded`, `touch_state: not-started`, and the current diff still does not overlap its owning seam, keep it visible in review output and ledger but leave it out of the refreshed downstream `review_handoff` unless the user explicitly re-includes it.
- Use the bundled `scripts/return_review_state.py` helper for deterministic deferred-family validation/classification and keep the model focused on the judgment calls the script cannot make. Serialize the relevant handoff blocks to JSON before invoking it.
- Use the bundled `scripts/return_review_state.py` helper for deterministic trace path/file handling and carried-deferred handoff assembly. Keep the model focused on review judgments and evidence.
- Use the repository family ledger on disk to track which families were deemed closed and later reopened. Treat repeated reopenings as a workflow-quality/debugging signal.
- Use the bundled helper, not prose reconstruction, to decide which reopened families from the current run should be surfaced to the user.
- Do not rely on vague "this surface seems fine" boundedness judgments. Use explicit split triggers and record boundedness exceptions whenever a large slice is kept intact.
- The baseline exception for targeted return review exists only so follow-up review can work from a stable `review_handoff`.
- Do not optimize for agreement, momentum, or a "done" verdict.
- Do not write a full transcript or chain-of-thought trace. Persist only phase-boundary operational trace records and observable evidence actions.
- Keep detailed trace data on disk. Do not serialize trace internals into `review_handoff`, `review_return_handoff`, or normal final output unless the user explicitly asks for trace details.
- If required evidence is incomplete, prefer `partially-confirmed` or `unverified` over rounding up to closure.
- Do not inflate wording or cosmetic issues into blocking findings when the closure gate is materially satisfied.
- Do not absorb unscheduled, slow, or failed lane review work into the coordinator's own analysis.
- If required lane count exceeds current subagent capacity, queue lanes in bounded waves and preserve one independent lane per review unit.
- Do not confirm or reject a family's closure claim without at least one completed independent return-review lane result for that family.
- If a required lane stalls or fails, wait patiently, retry or relaunch the lane, and surface the family as unverified if independent review still cannot be completed.
- Do not interrupt an active lane just to hurry synthesis, force a bounded finish, or demand a best-effort result from incomplete evidence.
- If a lane is slow but still making bounded progress, let it continue. Patience beats premature truncation.

## Prep

Run prep before spawning any agents.

Prep must:
- determine whether this is:
  - a full discovery review
  - a targeted return review from `review_handoff + review_return_handoff`
- for full discovery review:
  - resolve which baseline file is being used:
    - explicit path
    - primary baseline
    - explicitly requested alternative baseline
  - when the user asks for run-local narrowing within the selected baseline:
    - infer a candidate surface id/name, path subset, and focus override from the user's wording
    - serialize the selected baseline to JSON and run `scripts/return_review_state.py validate-full-review-narrowing ...`
    - use the helper output as the deterministic starting point for whether the narrowing is legal
  - choose review window: local changes, commit, commit range, branch, merge-base
  - gather changed files
  - map changed files to surfaces using primary anchors first and supporting anchors second
  - record unmatched or ambiguously matched files
  - decide whether touched surfaces are bounded enough
  - record which split triggers fired for each touched surface slice and any boundedness exceptions when a triggered slice is still kept intact
  - keep the baseline-configured lenses unchanged and carry any validated
    run-local focus override as separate emphasis metadata for this run; the override may be a built-in lens id used as extra runtime focus or a runtime-only emphasis token
  - stop and refuse instead of modifying the baseline if prep reveals stale anchors, stale docs, or misclassified surfaces
- for targeted return review:
  - validate that the `review_handoff` is present and parseable
  - validate that the `review_return_handoff` is present and parseable
  - gather the actual fix diff
  - when `deferred_families` are present, run `scripts/return_review_state.py classify-deferred ...` to validate mapping and produce the initial deferred-family classification
  - compare returned families against the family ids and closure gates embedded in the `review_handoff`
  - validate and classify any structured deferred families reported by the fixer
  - compare the claimed touched write set, tests, and docs against the actual diff
  - classify deferred threads into:
    - grounded enough for targeted exploration
    - too broad or tentative for this return review
  - refuse if the return artifacts are too stale or ambiguous to support grounded re-review

Use the refusal rules from `references/prep-and-refusal.md`.

## Coverage Lanes

- Default to one coverage lane per bounded surface slice.
- Run each coverage lane in a Codex `default` subagent and invoke `$coortex-review-lane` inside the lane prompt, scoped to that lane only.
- If coverage lanes exceed current subagent capacity, queue them in bounded waves rather than collapsing one lane into coordinator-local review.
- Give each lane the surface-specific configured lenses.
- When prep validated run-local focus emphasis, pass it separately in the lane
  prompt instead of mutating the configured lens list.
- Split a touched surface only when a single lane would force spot-checking or mixed evidence strategies.
- Require every coverage lane result to follow the coverage-lane output contract in `references/report-contract.md`.

## Return Review

- In targeted return-review mode, use the original `review_handoff`, read the embedded `closure_gate` for each family from that handoff, use the `review_return_handoff`, and compare both against the actual fix diff.
- Keep the scope family-local:
  - the original family ids
  - the actual touched write set
  - touched tests
  - touched docs
  - any residual risks from the fixer
  - any structured `deferred_families` reported by the fixer
  - any grounded `emergent_threads_deferred` reported by the fixer
- In this mode, treat structured `deferred_families` as carry-forward review inputs:
  - if the actual diff did not materially overlap the deferred family's seam and the defer reason still looks grounded, carry the family forward without a new lane
  - if the actual diff materially overlapped that family or the defer reason identifies a broader shared contract or blocker, require family-local or broader cross-family re-review before carrying it forward
  - if return review shows the fixer materially started the family and still left it open, reject the defer classification and rebuild it as an open handled family instead of carrying it forward as defer
- In this mode, treat `emergent_threads_deferred` as follow-up review prompts:
  - if a deferred thread is grounded enough to name a plausible seam or family-local boundary, run a targeted exploration lane for it
  - if a deferred thread is too broad or ambiguous to bound cleanly, surface it as follow-up review work instead of widening the current return review into broad rediscovery
- In every return-review lane prompt, pass the family-local closure gate, the authoritative diff/scope, and the exact family-local return-review schema from `references/return-review.md`.
- If return-review lanes exceed current subagent capacity, queue them in bounded waves. Do not let the coordinator take over an unscheduled family lane's substantive review work.
- In this mode, check whether the claimed closure status is actually supported by the patch.
- In this mode, if a family remains open and actionable, gather enough family-local evidence to refresh the downstream handoff:
  - updated still-open manifestations
  - updated sibling bugs or explicit sibling search scope
  - updated thin areas
  - updated `review_hints`
  - updated `closure_gate` only when return review proves the original gate was incomplete or mis-scoped
- Do not rerun broad family discovery across unrelated surfaces unless the return handoff is stale or inconsistent with the diff.

## Family Exploration

- After coverage completes, group findings into candidate defect families.
- Spawn one family-exploration lane per candidate family.
- Exploration is mandatory, not optional.
- Run each family-exploration lane in a Codex `default` subagent and invoke `$coortex-review-lane` inside the lane prompt, scoped to that family only.
- If family-exploration lanes exceed current subagent capacity, queue them in bounded waves rather than replacing missing lanes with coordinator-local review.
- Pass the exact exploration-lane output schema from `references/report-contract.md` and keep the coordinator focused on family grouping, scheduling, and synthesis.

## Synthesis And Verdict

- Merge coverage and exploration outputs by root cause.
- Deduplicate manifestations across surfaces.
- Roll severity up to the family and review level.
- Emit a structured `review_handoff` block for downstream fix workflows using `references/review-handoff.md`.
- Emit a per-family `closure_gate` inside that handoff using `references/closure-gate.md`.
- In targeted return-review mode, compare the original `review_handoff`, including each family's embedded `closure_gate`, against the `review_return_handoff` and the actual fix diff, then confirm, partially confirm, reject, or mark unverified the fixer's claimed closure status.
- In targeted return-review mode, surface the gate check itself. For each family, show which `closure_gate` items were satisfied, unsatisfied, or inconclusive and cite evidence.
- In targeted return-review mode, if any family remains actionable after the re-review, emit a refreshed downstream `review_handoff` containing only those still-open families.
- In that refreshed downstream handoff, preserve stable `family_id` values where possible and fold in the return-review lane findings. The refreshed handoff must reflect the latest family-local evidence from the subagents, not just the original handoff plus a verdict label.
- In that refreshed downstream handoff, also preserve structured `carry_forward_context` when a family remains open due to a validated defer or sequencing reason.
- When deferred families are being carried forward without a new lane, use the bundled helper to assemble that part of the refreshed downstream handoff deterministically.
- Do not include `closure-confirmed` families in the refreshed downstream handoff.
- Do not include a family whose return-review result is only `verification-blocked-separate-blocker` unless the user explicitly asks to carry blocked families forward anyway.
- Do not include `unverified` families in the refreshed downstream handoff unless the return-review lanes still produced enough grounded family-local evidence to rebuild an actionable family entry.
- In targeted return-review mode, also act on any `emergent_threads_deferred` reported by the fixer:
  - run targeted exploration for grounded deferred threads
  - report unbounded deferred threads as explicit follow-up review work
- In targeted return-review mode, do not silently lose untouched but still-actionable fixer families. Either carry them forward structurally or reopen broader exploration when the new evidence points to a shared root cause across family boundaries.
- In targeted return-review mode, do not preserve a deferred-family classification when the family was materially started and left half-done. Rebuild it as an open family with reviewer-backed open-status reasoning instead.
- In both full discovery and targeted return review, wait for the required independent lane results. If a lane is slow or capacity-limited, schedule it later or relaunch it; do not silently replace it with coordinator-local review work.
- If independent review could not be completed for a required return-review family, emit `unverified` for that family's closure-claim verdict instead of inferring a verdict from local evidence alone.
- Use the final-review output contract in `references/report-contract.md` for which lane-level and family-level self-check signals must surface in synthesis.
- Keep the detailed `review_shape_trace`, `unexplored_area_ledger`, and `boundedness_exceptions` on disk in the trace artifacts by default.
- In normal final output, summarize those trace artifacts only when they materially affect the verdict or the remaining open work.
- Keep the full family ledger on disk by default. Surface ledger-wide churn/reopen analysis only when the user explicitly asks for it.
- If the helper reports reopened families for the current run, include those reopen signals in the normal final output.
- Emit `APPROVE`, `COMMENT`, or `REQUEST CHANGES`.

Follow the output shape in `references/report-contract.md`.
