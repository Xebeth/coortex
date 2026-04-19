---
name: review-baseline
description: Create or refresh a persistent project review baseline for bounded multi-agent code review. Use when a project needs a stable review configuration that defines broad review surfaces, broad file/module anchors, contract docs, configured built-in and custom lenses, and optional reviewer guidance metadata before routine review execution begins.
---

# Review Baseline

## Overview

Create or refresh a project-resident review baseline that a separate execution skill can use for repeated multi-agent reviews.
Use broad architectural discovery when primary-baseline work is in scope, then let the user refine surfaces and lens configuration before writing the baseline.
When a project has recurring narrow review modes, this skill may also write standalone alternative baseline files for those targeted checks.

## Conversation-visible plan

Keep a short conversation-visible plan/progress list updated while baseline work
runs so the user can see which phase is in flight.

- Use the conversation `update_plan` tool at the start and after each major
  phase boundary. Keep exactly one step `in_progress` and move it forward as
  the baseline work advances.
- Do not rely only on prose status messages when `update_plan` is available.

- At the start, state whether you are refreshing the primary baseline or
  creating an alternative baseline and what comes next.
- After inventory, after surface drafting, and before writing the baseline,
  update the in-conversation progress.
- If you discover that the requested baseline shape is not viable, say so
  explicitly before changing approach.
- These updates are not approval checkpoints. Unless the user explicitly asks
  you to pause or the baseline work is blocked on a missing decision, continue
  after the update without waiting for acknowledgment.

## Workflow

1. Determine whether this run is:
   - creating or refreshing the primary baseline
   - adding or refreshing one or more alternative baseline files
2. If this run is only adding or refreshing alternative baseline files and a primary baseline already exists:
   - load the existing primary baseline first
   - reuse it as reference context instead of redoing broad baseline discovery unless the user asked for a fresh targeted discovery pass or the primary baseline is too stale to reuse safely
3. Read the smallest set of project docs and source structure needed to discover broad review surfaces when broad discovery is actually needed.
4. Infer broad surfaces, broad anchors, matching contract docs, and optional reviewer guidance metadata.
5. Load these references as needed:
   - `references/lens-catalog.md`
   - `references/baseline-schema.md`
   - `references/quality-gate.md`
6. Propose the baseline shape to the user when this run includes primary-baseline work.
7. If this run includes primary-baseline work, ask exactly:
   `Would you like to refine these broad surfaces through an interview process?`
8. If the user wants refinement for primary-baseline work:
   - tighten or split broad surfaces
   - tune built-in lens priorities
   - define any custom lenses clearly enough for later execution
9. Draft or refresh the primary baseline when this run includes primary-baseline work.
10. If the user wants recurring narrower checks, ask whether each alternative baseline should:
   - derive from the existing primary baseline
   - or start fresh from a new targeted discovery pass
11. Draft any alternative baseline files needed for those targeted review modes using the chosen approach.
12. Run the quality gate and a self-review pass against the actual repo mapping and surface/lens semantics before writing anything.
13. If the self-review finds unmapped files, multiply-mapped files, over-broad anchors, surface-boundary ambiguity, weak custom-lens distinctions, or variant files that only work as delta-overrides, fix the draft and rerun the gate.
14. Write or refresh the persistent baseline documents only after the repaired drafts pass.

## Baseline Rules

- Treat the baseline as a project invariant, not a per-review artifact.
- Do not redo broad primary-baseline discovery when the user only wants to add or refresh an alternative baseline and the existing primary baseline is still usable as reference context.
- If the project has a `docs/` directory, default the baseline location to `docs/review-baseline.yaml` unless the project already has an explicit path.
- If the project has a `doc/` directory but no `docs/` directory, default the baseline location to `doc/review-baseline.yaml` unless the project already has an explicit path.
- When the user wants a non-committed working baseline for active branch/worktree review, default the primary baseline location to `.coortex/review-baseline.yaml`.
- If the project has neither `docs/` nor `doc/` and no explicit baseline path is already established, ask the user where the baseline should live before writing it.
- Keep the baseline structured and concise enough for another skill to consume directly.
- Store project-specific configuration in the baseline. Do not copy the full generic lens catalog into it.
- Prefer broad stable anchors over narrow changed-file lists.
- Keep the primary baseline broad and reusable by default.
- Only create alternative baseline files when the project has a stable repeated need for narrower review passes, such as finer surface breakdown or fewer lenses for a targeted check.
- Alternative baseline files must be standalone consumable baselines, not patch files or partial overrides that require another skill to merge them with the primary baseline.
- When writing alternative baseline files, default them under `docs/review-baselines/` or `doc/review-baselines/` when those directories exist.
- When writing non-committed working alternative baselines, default them under `.coortex/review-baselines/`.

## Surface Discovery

- Discover surfaces in the broadest stable sense: major modules, layers, subsystems, workflows, or boundary-shaped areas.
- Use the per-surface structure from `references/baseline-schema.md`.
- Keep surfaces broad enough to survive across reviews, but distinct enough that an execution skill can map changed files without rediscovering ownership.
- In alternative baseline files, it is acceptable to use a finer-grained surface split than the primary baseline, but the split must still be stable enough for repeated use.

## Lens Configuration

- Use the built-in lens catalog from `references/lens-catalog.md`.
- Treat those built-in lens ids as Coortex runtime concerns, not just labels.
  `review-baseline` chooses the ordered lens bundle per surface, and
  `coortex-review-lane` supplies the actual review behavior for those ids.
- Ask the user which built-in lenses matter most for each surface.
- Allow custom lenses when the built-ins are not sufficient.
- For each custom lens, use the shape required by `references/baseline-schema.md`.
- Make custom lenses earn their existence:
  - they should capture a project-specific concern that the built-in lenses would not express cleanly enough
  - they should be meaningfully distinct from nearby custom lenses on other surfaces
  - they should still be narrow enough that another agent could apply them consistently
- Reject vague custom lenses that another agent could not apply consistently later.
- Alternative baseline files should usually use fewer lenses than the primary baseline, not more, unless a repeated targeted review mode clearly needs the extra distinction.

## Alternative Baselines

- Use alternative baseline files for recurring targeted checks, not for one-off review windows.
- Use `.coortex` baseline paths for active working baselines that should not yet be committed.
- If the user is only adding or refreshing an alternative baseline, keep the primary baseline unchanged except for any metadata pointer updates needed to register the new alternative.
- Ask explicitly whether a new alternative baseline should be:
  - `derived` from the existing primary baseline
  - or `fresh` from a new targeted discovery pass
- Use the variant metadata shape from `references/baseline-schema.md`.
- If the user chooses `derived`:
  - start from the existing primary baseline's surface/doc/lens model
  - narrow or split only the parts needed for the targeted review mode
  - remove irrelevant lenses instead of copying them blindly
- If the user chooses `fresh`:
  - rediscover the targeted review mode independently
  - do not force alignment with the current primary baseline if the narrower mode reveals a cleaner stable split
- Keep alternative baselines intentionally narrower:
  - fewer surfaces, when the review mode only needs one subsystem
  - finer surfaces, when a repeated targeted check needs more precise ownership
  - fewer lenses, when the targeted check should suppress irrelevant review axes
- If the primary baseline lists alternative baseline files, keep those pointers accurate when writing or refreshing them.

## Quality Gate

- Apply the checks in `references/quality-gate.md`.
- Reject the baseline if it is too vague, too overlapping, missing lens configuration, missing contract structure, or does not survive a self-review pass against the actual repo mapping and lens/surface semantics.
- If the gate or self-review finds issues, fix the draft and rerun both before writing.

## Self-Review Pass

- After drafting the baseline, review the draft as another agent would consume it.
- Check the actual repo against the declared anchors and the configured surface/lens model.
- Look for:
  - relevant files that do not map to any surface
  - relevant files that map to multiple surfaces because anchors are too broad
  - anchor patterns like blanket `/**` usage that collapse distinct surfaces together
  - known docs/tests that sit outside the surface they are supposed to support
  - surfaces whose purposes or anchors overlap so much that their distinction is not operationally real
  - custom lenses that are duplicates, near-duplicates, or only cosmetically different from nearby custom lenses
  - custom lenses whose purpose does not match the surface they are attached to
  - custom lenses that should really be built-in lens priorities or surface notes instead of standalone lenses
- Tighten, split, or rewrite anchors when the draft fails this check.
- Merge, rewrite, or remove custom lenses when the draft shows that they are not meaningfully distinct.
- Prefer making `primary_anchors` more distinct instead of accepting accidental overlap.
- Only keep overlap when it is clearly intentional and does not force the execution skill to rediscover ownership.

## Output

Write a persistent YAML baseline document that matches `references/baseline-schema.md`.

Use `references/baseline-schema.md` as the source of truth for the baseline
structure, variant metadata, and standalone alternative-baseline structure.

## Reporting

- Summarize:
  - baseline path
  - surfaces created or refreshed
  - configured lens highlights
  - any custom lenses added
  - any alternative baseline files created or refreshed
  - whether each alternative baseline was derived or fresh
  - any quality-gate or self-review issues resolved
