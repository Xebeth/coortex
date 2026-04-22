# Trace Artifact

Persist a compact operational trace for every seam-walkback campaign.

Use the bundled helper for deterministic path/file handling and campaign-lock
management:

```bash
python scripts/walkback_state.py init-trace --project-root .
python scripts/walkback_state.py packet-path --trace-dir .coortex/review-trace/<run_id>
python scripts/walkback_state.py append-trace --trace-file <path> --record-file <json-file>
```

The helper owns:
- run-directory creation
- coordinator file creation
- canonical packet path resolution
- JSONL append mechanics
- trace-record validation for known phase-boundary record types
- active top-level campaign lock handling for the current worktree

The model still owns the contents of each trace record.

## Path layout

- Create one directory per run under:
  - `.coortex/review-trace/<run_id>/`

Suggested `run_id` shape:
- `seam-walkback-review-<UTC timestamp>`

Inside that run directory:
- coordinator file:
  - `coordinator.jsonl`
- canonical discovery packet path:
  - `seam-walk-packet.json`

Repository-level active-campaign lock while a top-level review campaign is
running:
- `.coortex/review-trace/active-review-campaign.json`

That lock should preserve operator-facing provenance for the top-level run when
available:
- `owner_host_session_id`
- otherwise `owner_host_thread_id`
- `owner_started_from_cwd`

## Rules

- Allow only one concurrent top-level review campaign per worktree / `.coortex`
  root.
- `seam-walkback-review` may not start if another active top-level review
  campaign already owns the worktree.
- The orchestrator phase launched **inside** the active seam-walk campaign is
  part of the same campaign lineage and is allowed to proceed.
- Append one JSON object per phase-boundary event.
- Let `append-trace` validate the record shape before it is written.
- Record observable workflow activity only.
- Every non-aborted campaign must end with a terminal `final_walkback` record.

## Record types

At minimum, append these record types when applicable:
- `trace_started`
- `campaign_resumed`
- `archaeology_cluster`
- `seam_selection`
- `commit_group_selected`
- `commit_group_reviewed`
- `family_consolidation`
- `handoff_emitted`
- `final_walkback`

Legacy execution-mode records remain valid for backward compatibility:
- `baseline_action`
- `review_step`
- `repair_step`
- `deslop_step`
- `verification`
- `atomic_commit`

## Common fields

Every record should include:
- `run_id`
- `timestamp_utc`
- `skill`
- `phase`
- `worktree_root`

## Phase-specific expectations

### campaign_resumed
Include:
- `previous_run_id`

### archaeology_cluster
Include:
- `cluster_id`
- `scope_summary`
- `pivot_commits`

### seam_selection
Include:
- `seam_id`
- `reason`

### commit_group_selected
Include:
- `group_id`
- `label`
- `scope_summary`
- `commit_shas`
- `primary_seams`

### commit_group_reviewed
Include:
- `group_id`
- `review_skill`
- `scope_summary`
- `review_grounded_signal_ids`
- `deslop_advisory_signal_ids`
- `candidate_family_ids`

### family_consolidation
Include:
- `candidate_family_ids`
- `summary`

### handoff_emitted
Include:
- `packet_path`
- `next_skill`
- `handoff_mode`

### final_walkback
Include:
- `outcome_summary`
- `terminal_state`

Use `terminal_state` values such as:
- `handoff-completed`
- `blocked`
- `aborted`
- `superseded`
