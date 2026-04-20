# Trace Artifact

Persist a compact operational trace for every fixer run.

Use the bundled helper for deterministic path/file management:

```bash
python scripts/fix_result_state.py init-trace
python scripts/fix_result_state.py plan-repair-slices --review-handoff <path>
python scripts/fix_result_state.py build-lane-continuation --review-handoff <path> --lane-plan-json <path> --lane-id <lane_id> --worker-session-id <worker_session_id>
python scripts/fix_result_state.py validate-lane-continuation --lane-continuation <path> --lane-plan-json <path> --expected-lane-id <lane_id> --expected-worker-session-id <worker_session_id> --expected-slice-id <slice_id>
python scripts/fix_result_state.py lane-trace-file --trace-dir <dir> --lane-type <type> --session-id <id> --family-id <family_id> --family-name "<family name>"
python scripts/fix_result_state.py append-trace --trace-file <path> --record-file <json-file>
```

The helper owns:
- run-directory creation
- coordinator file creation
- lane filename construction
- JSONL append mechanics
- trace-record validation for known phase-boundary record types

The model still owns the contents of each trace record.

## Path layout

- Create one directory per run under:
  - `.coortex/review-trace/<run_id>/`

Suggested `run_id` shape:
- `review-fixer-<UTC timestamp>`

Inside that run directory:
- coordinator file:
  - `coordinator.jsonl`
- subagent/lane files:
  - for family-local repair lanes:
    - `<lane_type>-<family_id>-<family_name_slug>-<session_id>.jsonl`
  - for non-family-local helper lanes that do not yet have a stable family id:
    - `<lane_type>-<target_slug>-<session_id>.jsonl`

## Rules

- Create the directory if it does not exist.
- Append one JSON object per phase-boundary event.
- Let `append-trace` validate the record shape before it is written.
- Do not write hidden reasoning or a full transcript.
- Record observable repair activity only.
- Keep trace data on disk by default. Do not surface trace paths or trace internals in normal output unless the user explicitly asks.
- Do not have multiple subagents append to one shared lane file. Each lane/subagent gets its own JSONL file inside the run directory.

## Record types

At minimum, append these record types when applicable:
- `trace_started`
- `intake`
- `batch_plan`
- `execution_plan`
- `family_closeout`
- `verification`
- `return_review_loop`
- `lane_continuation`
- `review_return_handoff`
- `family_commit`
- `final_fix`

## Common fields

Every record should include:
- `run_id`
- `timestamp_utc`
- `skill`
- `mode`
- `phase`
- `review_target`

## Intake record

Include:
- `family_ids`
- `closure_gate_summaries`
- `candidate_write_sets`

## Execution-plan record

Include:
- `lane_id` when the family belongs to a coordinated lane
- `family_id`
- `owning_seam`
- `planned_write_set`
- `planned_test_set`
- `planned_doc_set`
- `execution_mode`

## Batch-plan record

Include:
- `slice_ids`
- `lane_ids`
- `family_ids`
- `wave_ids`
- `orchestration_mode`

## Return-review-loop record

Include:
- `lane_id`
- `worker_session_id`
- `family_ids`
- `reviewer_run_id`
- `review_result`
- `return_review_round`

## Lane-continuation record

Include:
- `lane_id`
- `worker_session_id`
- `family_ids`
- `continuation_reason`
- `return_review_round`

## Family-commit record

Include:
- `family_ids`
- `commit_sha`
- `return_review_rounds_taken_by_family`
  - mapping from `family_id` to the number of targeted return-review send-back
    rounds it took for that family to close

## Family-closeout record

Include:
- `family_id`
- `write_set`
- `tests_updated`
- `docs_updated`
- `files_read`
- `docs_read`
- `searches_run`
- `commands_run`
- `verification_run`
- `emergent_threads_followed`
- `emergent_threads_deferred`
- `closure_status`
- `residual_risks`

`files_read` and `docs_read` should list the material files/docs the fixer relied
on, not every incidental read.

## Verification record

Include:
- `family_id`
- `verification_run`
- `broader_suite_status`
- `verification_blocker` when applicable

## Final-fix record

Include:
- `family_ids_handled`
- `final_statuses`
