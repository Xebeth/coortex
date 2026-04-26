# Review Baseline Quality Gate

Reject the baseline if any of these conditions are true.

Run these checks on the drafted baseline before it is written. If any check fails, repair the draft and rerun the gate.

Run the shared deterministic helper as part of the gate:

```bash
python ../review-orchestrator/scripts/return_review_state.py validate-review-baseline \
  --project-root <repo-root> \
  --baseline <baseline-path> \
  --expect-kind <primary|variant|any> \
  [--primary-baseline <primary-baseline-path>]
```

This is the same baseline validation used by `review-orchestrator`; helper
failure is a gate failure.

When `repo_quality_gates` are present, the helper validates gate ids, required
classification fields, resolution hints, blocking-stage consistency, and
surface `finish_gate_refs`. Existing baselines without `repo_quality_gates`
remain valid, but any gate metadata that is present must be coherent enough for
coordinator prep and lanes to consume without guessing. Use
`resolution: coordinator_prep` for gates that require prep-time inputs before
they become concrete commands.

## Surface failures

- No surfaces are defined.
- A surface is missing `id`, `purpose`, or `primary_anchors`.
- A surface has no configured built-in or custom lenses.
- `review_focus_areas` restate the surface `purpose`, duplicate built-in lens
  reasons, or are so vague that another reviewer could not use them.
- Surface anchors are so overlapping that another skill would have to rediscover ownership.
- Surface anchors are so narrow that they only describe one current review target instead of a stable project area.
- Surface anchors rely on overly broad patterns that cause unrelated files to map into the same surface by default.

## Lens failures

- A built-in lens is configured without `lens_id` or `priority`.
- A custom lens is missing `purpose`, `what_to_look_for`, `key_questions`, or `evidence_expectations`.
- Custom lenses are too vague for another agent to apply consistently.
- Custom lenses duplicate or nearly duplicate other custom lenses without a clear operational distinction.
- A custom lens is attached to a surface whose purpose or anchors do not support that lens cleanly.
- A custom lens is really just a built-in lens priority, surface note, or wording variant rather than a distinct executable lens.

## Contract failures

- Relevant contract docs are discoverable but omitted from the surface.
- A surface `finish_gate_refs` entry references a missing or advisory-only gate.
- A `repo_quality_gates` entry leaves a baseline-resolved gate without a
  concrete command or a prep-resolved gate without `command_template` and
  `required_inputs`.
- `review_focus_areas` are really custom lenses in disguise or are just docs,
  tests, or matrix refs that belong in `supporting_anchors` or `contract_docs`.
- The baseline is too underspecified for another skill to map changed files into surfaces without rediscovery.
- `reviewer_model_recommendation` is present but malformed or presented as a guaranteed runtime control rather than advisory metadata.
- A primary baseline lists alternative baseline files whose paths, ids, or stated purposes are inconsistent with what was actually written.
- An alternative baseline only works as a patch or delta against the primary baseline instead of as a standalone consumable baseline.
- A variant baseline claims to be `derived` but does not record which primary baseline it derives from.
- A variant baseline omits any usable `variant_purpose` or `variant_when_to_use`, leaving another skill unable to tell when it should be selected.

## Repo-mapping failures

- Relevant source, test, or contract files do not map to any surface.
- Relevant files map to multiple surfaces because anchors are too broad or poorly separated.
- Supporting docs/tests consistently fall outside the surface they are meant to support.
- The draft baseline only looks correct when read abstractly, but fails when checked against the actual repo layout.

## Surface-model failures

- Surface purposes are not operationally distinct once the anchors are tested against the real repo.
- Two surfaces differ only cosmetically and would force the execution skill to guess ownership during review.
- Surface-to-doc or surface-to-test relationships are too weak to support grounded review.
- An alternative baseline narrows scope so far that it only describes one current diff instead of a stable repeated targeted review mode.

## Required self-review pass

Review the drafted baseline as if you were the execution skill consuming it.

At minimum:
- test the declared anchors against real project files
- identify unmapped files
- identify multiply-mapped files
- tighten or split surfaces when blanket globs collapse distinct areas
- review whether custom lenses are genuinely distinct and surface-specific
- review whether any alternative baseline file is genuinely narrower and repeatedly useful rather than just a one-off copy of the current review target
- review whether surface distinctions are operationally real, not just prose-deep
- rerun the gate after each repair

## Pass condition

The baseline passes only if another review-execution skill could:
- load it,
- map changed files into surfaces,
- choose surface-specific lenses,
- and proceed without having to rediscover the project’s review structure from scratch.

That pass condition must hold both conceptually and when checked against the actual repo mapping.
