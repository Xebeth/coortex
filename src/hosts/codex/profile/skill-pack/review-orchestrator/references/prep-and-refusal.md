# Prep And Refusal Contract

Run prep before spawning any reviewer agents.

## Prep steps

Choose the prep path that matches the review mode.

### Full discovery prep

1. Resolve the baseline file:
   - explicit path when the user provided one
   - otherwise an explicitly requested alternative baseline listed by the primary baseline
   - otherwise the primary baseline
2. Load the selected baseline.
3. When the user asks for a run-local narrowing inside that baseline, start with the bundled helper:

```bash
# Serialize the selected baseline to JSON before invoking the helper.
python scripts/return_review_state.py validate-full-review-narrowing \
  --baseline-json <path> \
  [--surface <inferred-surface>] \
  [--path-subset <inferred-path-subset>] \
  [--focus <inferred-focus>] ...
```

Treat the helper output as the deterministic starting point for whether the
requested narrowing is a legal reduction of the selected baseline. The reviewer
still owns the natural-language inference from user wording to the candidate
surface/path/focus tuple.
4. Choose the review window:
   - local changes
   - commit
   - commit range
   - branch
   - merge-base
5. Gather changed files.
6. Map changed files into baseline surfaces:
   - use `primary_anchors` first
   - use `supporting_anchors` second
7. Record:
   - unmatched files
   - ambiguous matches
   - touched surfaces
8. Assess boundedness of each touched surface slice.
9. Keep the baseline-configured lenses unchanged and carry any validated
   run-local focus override as separate emphasis metadata for this run; the override may be a built-in lens id used as extra runtime focus or a runtime-only emphasis token.

Boundedness assessment must use explicit split triggers, not only intuition.
For each touched surface slice, record:
- changed behavioral-code file count
- distinct primary-anchor groups touched
- weakly related change clusters
- materially different lens/evidence bundles required
- which split triggers fired
- whether the slice was split or kept intact
- if kept intact despite a trigger, a boundedness exception explaining why

Presumptive split triggers:
- more than 5 changed behavioral-code files in one slice
- more than 2 distinct primary-anchor groups in one slice
- more than 1 weakly related change cluster in one slice
- more than 1 materially different lens/evidence bundle required in one slice
- prep can already tell the lane would need spot-checking to finish

Prep is diagnostic only with respect to the baseline.
If prep finds stale mapping, stale docs, misclassified surfaces, or other baseline drift:
- do not patch the baseline
- do not rewrite anchors or lenses in place
- refuse and direct the user to rerun `review-baseline`

### Targeted return-review prep

When `deferred_families` are present in `review_return_handoff`, start with the
bundled helper:

```bash
# Serialize the handoff blocks to JSON before invoking the helper.
python scripts/return_review_state.py classify-deferred \
  --review-handoff <path> \
  --review-return-handoff <path> \
  --changed-files-file <path>
```

Treat the script output as the deterministic starting point for deferred-family
validation/classification. The reviewer still owns the judgment of whether a
broader shared seam hypothesis is actually credible enough to reopen
cross-family exploration.

1. Load the original `review_handoff`.
2. Load the `review_return_handoff`.
3. Gather the actual fix diff.
4. Validate that each returned family maps to a family in the `review_handoff`.
5. Read the `closure_gate` for each returned family from the `review_handoff`.
6. Compare:
   - claimed touched write set vs actual diff
   - claimed touched tests/docs vs actual diff
   - claimed closure status vs the embedded closure gate
7. Validate any `deferred_families` reported by the fixer:
   - each deferred family maps to a family in the `review_handoff`
   - each deferred family entry uses a concrete defer reason, actionable condition, and any named blockers or next step coherently
8. Classify each deferred family reported by the fixer:
   - `carry-forward-without-lane` when the actual diff does not materially overlap the family's owning seam or likely write set and the defer reason still appears grounded
   - `requires-family-local-check` when the actual diff materially overlaps the family's seam/write set but the family still appears locally bounded
   - `requires-broader-cross-family-review` when the defer reason or next step suggests a broader shared contract, fence, or blocker may have changed the family boundaries
9. Classify each deferred thread reported by the fixer:
   - `grounded-for-targeted-exploration` when it includes enough seam/boundary detail to scope a lane
   - `follow-up-only` when it is too broad, too tentative, or outside the current return scope
10. Record:
   - missing families
   - malformed or missing closure gates
   - stale or ambiguous return-handoff fields
   - diff artifacts outside the declared return scope
   - deferred families that can be carried forward without a lane
   - deferred families that require family-local re-review
   - deferred families that require broader cross-family re-review
   - grounded deferred threads
   - deferred threads that remain follow-up-only

## Refuse when

For full discovery review:
- the baseline is missing or unparseable
- an explicitly requested alternative baseline cannot be resolved from the primary baseline metadata and no explicit path was provided
- an alternative baseline is parseable but clearly requires runtime merging with the primary baseline to be usable
- changed files with behavioral relevance do not map cleanly to any surface
- mapping is materially ambiguous across surfaces
- required contract docs referenced by the baseline are missing
- touched surfaces are so broad or overlapping that bounded execution would require rediscovery
- one or more touched surface slices fire multiple split triggers and still cannot be split into grounded lanes
- touched surfaces have no usable configured lenses
- current repo shape shows the baseline is stale or misclassified
- a requested run-local narrowing does not resolve to exactly one compatible baseline surface
- a requested run-local narrowing would cross surfaces, rewrite the baseline shape, or require runtime baseline merging

For targeted return review:
- the `review_handoff` is missing or unparseable
- the `review_return_handoff` is missing or unparseable
- a returned family has no matching family entry or no usable embedded `closure_gate` in the `review_handoff`
- a deferred family entry has no matching family entry or is too malformed to carry forward coherently
- the return handoff is too stale or ambiguous to compare cleanly against the diff
- a deferred thread is marked grounded but lacks enough seam/boundary detail to scope a targeted exploration lane

## Refusal response

When refusing because of baseline drift or stale mapping:
- explain the concrete prep findings
- state that `review-orchestrator` will not repair the baseline
- direct the user to rerun `review-baseline` to refresh it

When refusing because targeted return-review inputs are stale, malformed, or inconsistent:
- explain which return artifacts are unusable
- state whether the problem is missing family baseline, missing closure gate, malformed deferred-family data, malformed grounded deferred-thread data, or diff mismatch
- direct the user to rerun `review-orchestrator` or `review-fixer` as appropriate
