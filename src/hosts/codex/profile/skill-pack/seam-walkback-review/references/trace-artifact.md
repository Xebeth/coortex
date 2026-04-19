# Trace Artifact

Persist a compact operational trace for every seam-walkback run.

Use the bundled helper for deterministic path/file handling:

```bash
python scripts/walkback_state.py init-trace --project-root .
python scripts/walkback_state.py append-trace --trace-file <path> --record-file <json-file>
```

The helper owns:
- run-directory creation
- coordinator file creation
- JSONL append mechanics
- trace-record validation for known phase-boundary record types

The model still owns the contents of each trace record.

## Path layout

- Create one directory per run under:
  - `.coortex/review-trace/<run_id>/`

Suggested `run_id` shape:
- `seam-walkback-review-<UTC timestamp>`

Inside that run directory:
- coordinator file:
  - `coordinator.jsonl`

## Rules

- Create the directory if it does not exist.
- Append one JSON object per phase-boundary event.
- Let `append-trace` validate the record shape before it is written.
- Do not write hidden reasoning or a full transcript.
- Record observable workflow activity only.
- Keep trace data on disk by default. Do not surface trace paths or internals in
  normal output unless the user explicitly asks.

## Record types

At minimum, append these record types when applicable:
- `trace_started`
- `archaeology_cluster`
- `seam_selection`
- `baseline_action`
- `review_step`
- `repair_step`
- `deslop_step`
- `verification`
- `atomic_commit`
- `final_walkback`

## Common fields

Every record should include:
- `run_id`
- `timestamp_utc`
- `skill`
- `phase`
- `worktree_root`

## Phase-specific expectations

### archaeology_cluster
Include:
- `cluster_id`
- `scope_summary`
- `pivot_commits`

### seam_selection
Include:
- `seam_id`
- `reason`

### baseline_action
Include:
- `action`
- `baseline_path` when known

### review_step
Include:
- `review_skill`
- `scope_summary`
- `downstream_run_id` when available

### repair_step
Include:
- `owning_seam`
- `write_set`

### deslop_step
Include:
- `scope_files`
- `gate_artifact_dir` when available

### verification
Include:
- `verification_run`

### atomic_commit
Include:
- `commit_sha`
- `commit_subject`

### final_walkback
Include:
- `outcome_summary`
- `next_candidate_seam` when known
