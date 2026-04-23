# Review Baseline Schema

Use a structured YAML document.

Default path:
- `docs/review-baseline.yaml` when the project has a `docs/` directory
- `doc/review-baseline.yaml` when the project has a `doc/` directory but no `docs/` directory

Recommended working baseline path:
- `.coortex/review-baseline.yaml` for a repo-local non-committed baseline used during active branch/worktree dogfooding

Recommended alternative baseline directory:
- `docs/review-baselines/` when the project has a `docs/` directory
- `doc/review-baselines/` when the project has a `doc/` directory but no `docs/` directory
- `.coortex/review-baselines/` for repo-local non-committed working alternatives

If the project does not have a `docs/` or `doc/` directory and no explicit baseline path is already established:
- ask the user where the baseline should live before writing it

Minimum schema:

```yaml
baseline_version: 1
updated_at: "2026-04-17"

# Optional metadata. Omit for the default primary baseline unless helpful.
baseline_kind: "primary"

# Optional advisory metadata only. This does not directly control lane runtime.
reviewer_model_recommendation:
  model: "gpt-5.4"
  reasoning_effort: "high"
  reason: "recommended review depth when the environment supports it"

# Optional on the primary baseline only.
alternative_baselines:
  - id: "runtime-targeted"
    name: "Runtime Targeted"
    purpose: "Finer runtime/recovery review with fewer lenses than the primary baseline"
    path: "docs/review-baselines/runtime-targeted.yaml"
    when_to_use:
      - "reviews limited to runtime/recovery seams"
      - "targeted invariant checks"

surfaces:
  - id: "runtime-recovery"
    name: "Runtime Recovery"
    purpose: "Recovery and interruption correctness"
    primary_anchors:
      - "src/recovery/**"
      - "src/persistence/**"
    supporting_anchors:
      - "src/__tests__/recovery*.test.ts"
      - "docs/runtime-state-model.md"
    contract_docs:
      - "docs/runtime-state-model.md"
      - "docs/architecture.md"
    review_focus_areas:
      - "provisional authority must not be treated as resumable truth until promoted"
      - "provenance must track launch vs resume vs recovery correctly"
    configured_builtin_lenses:
      - lens_id: "goal-fidelity"
        priority: "high"
        reason: "recovery must preserve the documented invariants and closure conditions"
      - lens_id: "context-history"
        priority: "medium"
        reason: "nearby recovery/reconcile paths must stay aligned"
    configured_custom_lenses:
      - id: "reclaim-symmetry"
        name: "Reclaim Symmetry"
        purpose: "Check launch/resume/recovery semantic alignment"
        what_to_look_for: "side-path divergence and duplicate logic"
        key_questions:
          - "Do launch and reclaim finalize through the same contract?"
        evidence_expectations:
          - "implementation path"
          - "tests or docs"
        priority: "high"
```

Standalone variant baseline example:

```yaml
baseline_version: 1
updated_at: "2026-04-17"
baseline_kind: "variant"
variant_strategy: "derived"
variant_id: "runtime-targeted"
variant_name: "Runtime Targeted"
variant_purpose: "Finer runtime/recovery review with fewer lenses"
variant_when_to_use:
  - "reviews limited to runtime/recovery seams"
  - "targeted invariant checks"
derived_from: "docs/review-baseline.yaml"

surfaces:
  - id: "runtime-projection"
    name: "Runtime Projection"
    purpose: "Projection, recovery, and interruption truth"
    primary_anchors:
      - "src/recovery/**"
      - "src/persistence/**"
    supporting_anchors:
      - "src/__tests__/recovery*.test.ts"
    contract_docs:
      - "docs/runtime-state-model.md"
    configured_builtin_lenses:
      - lens_id: "goal-fidelity"
        priority: "high"
      - lens_id: "context-history"
        priority: "high"
    configured_custom_lenses: []
```

Required top-level fields:
- `baseline_version`
- `updated_at`
- `surfaces`

Required top-level fields for `baseline_kind: "variant"`:
- `variant_id`
- `variant_name`
- `variant_purpose`
- `variant_when_to_use`
- `variant_strategy`
- `derived_from` when `variant_strategy` is `derived`

Optional top-level fields:
- `baseline_kind`
- `reviewer_model_recommendation`
- `alternative_baselines`
- `derived_from`

Required per-surface fields:
- `id`
- `name`
- `purpose`
- `primary_anchors`
- `supporting_anchors`
- `contract_docs`
- `configured_builtin_lenses`
- `configured_custom_lenses` (use `[]` when a surface has no custom lenses)

Optional per-surface fields:
- `review_focus_areas` (list of short strings)

Required built-in lens fields:
- `lens_id`
- `priority`

Recommended built-in lens fields:
- `reason`

Required custom lens fields:
- `id`
- `name`
- `purpose`
- `what_to_look_for`
- `key_questions`
- `evidence_expectations`
- `priority`

Recommended custom lens fields:
- `why_builtin_not_enough`
- `distinction_notes`

Schema rules:
- Keep anchors broad and stable.
- Use project-relative paths or globs.
- Prefer distinct surfaces over heavily overlapping ones.
- Store project configuration only. Do not restate the generic built-in lens definitions here.
- `review_focus_areas` is optional advisory guidance for recurring
  surface-specific failure or risk themes.
- Model each `review_focus_areas` entry as a short standalone recurring check,
  not as a nested object or mini-lens.
- Keep `review_focus_areas` short, concrete, and reviewable as recurring
  checks.
- Use `supporting_anchors` and `contract_docs` for matrix, invariant, and test
  references. Do not add a separate refs field for those.
- Do not use `review_focus_areas` as a replacement for `purpose` or
  `configured_custom_lenses`.
- Custom lenses should be project-specific and meaningfully distinct. If two custom lenses differ only cosmetically, merge or rewrite them.
- `reviewer_model_recommendation` is advisory metadata. Another skill may record or report it, but should not pretend it is a guaranteed runtime control unless the environment actually supports that control.
- The primary baseline should use `baseline_kind: "primary"` when that metadata is present.
- A standalone alternative baseline should use `baseline_kind: "variant"` when that metadata is present.
- Recommended `variant_strategy` values for alternative baselines:
  - `derived`
  - `fresh`
- `alternative_baselines` entries are metadata pointers from the primary baseline; they do not change the requirement that each alternative file be fully usable on its own.
- Recommended `alternative_baselines` entry fields:
  - `id`
  - `name`
  - `purpose`
  - `path`
  - `when_to_use`
- If `variant_strategy: "derived"`, set `derived_from` to the source primary baseline path.
- If `variant_strategy: "fresh"`, `derived_from` may be omitted.
- Recommended `variant_when_to_use` values are short repeated review-mode cues, not one-off diff descriptions.
- If a variant baseline uses `derived_from`, treat it as provenance metadata only. Another skill should not need to merge the parent file to use the variant.
