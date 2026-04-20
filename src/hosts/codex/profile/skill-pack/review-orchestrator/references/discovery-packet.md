# Discovery Packet Contract

Use this contract when `seam-walkback-review` finishes archaeology/grouped
review and hands the campaign to `review-orchestrator` for exploration-only
family synthesis.

The packet is a **discovery input**, not a final review verdict.

- commit groups are evidence buckets
- candidate families are provisional
- `review-orchestrator` validates the packet against the current family ledger
  and assigns the final family grouping, reopen status, and fixer-ready
  `review_handoff`

## Top-level shape

```yaml
packet_type: seam-walk-discovery
packet_version: 1
campaign:
  campaign_id: seam-walkback-review-20260420T120000Z
  source_run_id: seam-walkback-review-20260420T120000Z
  worktree_root: /repo
  review_target:
    mode: branch
    scope_summary: branch delta against origin/main
  base_ref: origin/main
  merge_base: abcdef1234
  head_sha: fedcba9876
  baseline_path: .coortex/review-baselines/m2-seams.yaml
commit_groups:
  - group_id: G-001
    label: operator salvage diagnostics
    scope_summary: read-only operator warning handling
    commit_shas:
      - a1b2c3d
      - e4f5g6h
    files:
      - src/cli/ctx.ts
      - src/cli/commands.ts
    primary_seams:
      - operator-command-surfaces
    review_grounded_signals:
      - signal_id: R-001
        summary: status/inspect drop salvage diagnostics after successful recovery warnings
        evidence:
          - src/cli/ctx.ts:120-176
        candidate_family_ids:
          - F-OP-001
    deslop_advisory_signals:
      - signal_id: D-001
        summary: operator warning formatting is duplicated across direct command surfaces
        evidence:
          - src/cli/ctx.ts:140-176
        candidate_family_ids:
          - F-OP-001
    thin_areas:
      - no full host-run live repro was repeated in archaeology mode
candidate_families:
  - family_id: F-OP-001
    title: Operator salvage diagnostics drift
    candidate_root_cause: read-only operator surfaces diverged from the diagnostics-bearing recovery path
    source_group_ids:
      - G-001
    review_grounded_signal_ids:
      - R-001
    deslop_advisory_signal_ids:
      - D-001
    likely_owning_seam: operator-command-surfaces
    secondary_seams:
      - projection-recovery-warning-fidelity
    status: candidate-open
handoff:
  mode: exploration-only
  requested_phases:
    - prep
    - coverage
    - family-exploration
    - synthesis
```

## Rules

- `packet_type` must be `seam-walk-discovery`.
- `packet_version` must currently be `1`.
- `campaign_id` is the stable campaign lineage identifier for the discovery
  campaign.
- `source_run_id` is the seam-walk run id that emitted this packet.
- `baseline_path` should point at the active working baseline used during
  archaeology. Prefer `.coortex/...` paths while baselines are unstable; use
  docs/doc paths only as durable fallback.
- `commit_groups` are evidence buckets, not fix slices.
- `review_grounded_signals` are the correctness/contract/recovery signals from
  the primary review lens.
- `deslop_advisory_signals` are maintainability/ownership/cleanup signals from
  the advisory deslop lens.
- `deslop_advisory_signals` alone do not create blocking families. They only
  become part of a final family when the orchestrator's combined synthesis
  grounds them.
- `candidate_families` are provisional discovery candidates. They are not the
  final family truth.
- `review-orchestrator` validates `candidate_families` against the family
  ledger, may merge/split/regroup them, and assigns the final family ids and
  reopen status used for the downstream `review_handoff`.
- `requested_phases` should normally be `prep`, `coverage`,
  `family-exploration`, and `synthesis` in that order.

## Deterministic validation

Use the review-orchestrator helper to validate a packet before handoff or before
packet-driven exploration starts:

```bash
python scripts/return_review_state.py validate-discovery-packet \
  --packet-file .coortex/review-trace/<run_id>/seam-walk-packet.json \
  --project-root .
```

The helper validates:
- required top-level fields
- commit-group shape
- signal shape and id references
- candidate-family references to groups/signals
- current `HEAD` / worktree-root consistency when `--project-root` is supplied
