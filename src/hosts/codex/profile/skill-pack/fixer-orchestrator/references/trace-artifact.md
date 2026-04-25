# Trace Artifact

Persist a compact operational trace for every fixer run.

Use the bundled helper for deterministic path/file management:

```bash
python scripts/fix_result_state.py init-trace --project-root .
python scripts/fix_result_state.py plan-repair-slices --review-handoff <path>
python scripts/fix_result_state.py build-lane-continuation --review-handoff <path> --lane-plan-json <path> --lane-id <lane_id> --worker-session-id <worker_session_id>
python scripts/fix_result_state.py validate-lane-continuation --lane-continuation <path> --lane-plan-json <path> --expected-lane-id <lane_id> --expected-worker-session-id <worker_session_id> --expected-slice-id <slice_id>
python scripts/fix_result_state.py lane-trace-file --trace-dir <dir> --lane-type <type> --session-id <id> --family-id <family_id> --family-name "<family name>"
python scripts/fix_result_state.py append-trace --trace-file <path> --record-file <json-file>
```

Resolve these bundled script paths relative to the installed
`.codex/skills/fixer-orchestrator/` directory, not relative to the repository
root.

The helper owns:
- run-directory creation
- active top-level review-campaign lock handling for the current worktree
- coordinator file creation
- lane filename construction
- JSONL append mechanics
- trace-record validation for known phase-boundary record types
- approval-ladder ordering for `closure_approved`,
  `pre_commit_gate_result`, `commit_ready`, and `family_commit`

The model still owns the contents of each trace record.

## Path layout

- Create one directory per run under:
  - `.coortex/review-trace/<run_id>/`

Suggested `run_id` shape:
- `fixer-orchestrator-<UTC timestamp>`

Repository-level active-campaign lock while a top-level review campaign is
running:
- `.coortex/review-trace/active-review-campaign.json`

The active-campaign lock should also record operator-facing provenance for the
top-level run:
- `owner_host_session_id` when available from the host environment
- otherwise `owner_host_thread_id` when only thread-local host identity is available
- `owner_started_from_cwd`

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
- Allow only one concurrent top-level review campaign per worktree / `.coortex`
  root.
- Standalone fixer campaigns must not start while a seam-walk or standalone
  review-orchestrator campaign is active in the same worktree.
- Append one JSON object per phase-boundary event.
- Let `append-trace` validate the record shape before it is written.
- Do not write hidden reasoning or a full transcript.
- Record observable repair activity only.
- Keep trace data on disk by default. Do not surface trace paths or trace internals in normal output unless the user explicitly asks.
- Do not have multiple subagents append to one shared lane file. Each lane/subagent gets its own JSONL file inside the run directory.
- Do not treat a fixer run as finished until `append-trace` writes the terminal
  `final_fix` record, reports `active_campaign_cleared: true`, and the shared
  `active-review-campaign.json` file is gone.

## Record types

At minimum, append these record types when applicable:
- `trace_started`
- `intake`
- `batch_plan`
- `execution_plan`
- `family_closeout`
- `verification`
- `return_review_loop`
- `closure_approved`
- `pre_commit_gate_result`
- `commit_ready`
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

## Closure-approved record

Include:
- `family_ids`
- `reviewer_run_id`
- `review_result`
  - use `closure-approved`
- `return_review_rounds_taken_by_family`
  - mapping from `family_id` to the number of targeted return-review send-back
    rounds it took for that family set to earn reviewer approval

This record exists so reviewer approval is machine-readable before the
coordinator-side pre-commit gate runs.

## Pre-commit-gate-result record

Include:
- `family_ids`
- `gate_status`
  - `clear` or `needs-followup`
- `review_gate_result`
- `deslop_gate_result`
- `follow_up_kind`
  - use `none` when `gate_status` is `clear`
  - otherwise classify the follow-up as `cleanup-only`, `correctness`, or
    `mixed`

Rules:
- append this record after the coordinator-side bounded `$coortex-review` and
  bounded advisory `$coortex-deslop` pre-commit gate runs
- if `follow_up_kind` is `cleanup-only`, route one consolidated
  `commit-ready cleanup sweep` back to the same implementer lane instead of
  repeated piecemeal cleanup loops

## Commit-ready record

Include:
- `family_ids`
- `readiness_basis`

Rules:
- append `commit_ready` only after the latest `pre_commit_gate_result` for the
  same family set is `clear`
- `family_commit` must not be written before `commit_ready`

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
- `commit_subject`
- `return_review_rounds_taken_by_family`
  - mapping from `family_id` to the number of targeted return-review send-back
    rounds it took for that family to close

Rules:
- `commit_subject` should match the actual atomic commit subject used for that
  approved lane/slice
- `commit_subject` must be a human semantic summary, not a generated internal
  id
- do not include generated `lane_id`, `slice_id`, or `wave_id` tokens in
  `commit_subject`
- `family_commit` requires the same family set to already have, in order, a
  prior `closure_approved`, a clear `pre_commit_gate_result`, and `commit_ready`

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

Terminal rules:
- Append `final_fix` only after the last atomic commit for the run has landed.
- A successful `final_fix` append must report `active_campaign_cleared: true`.
- If `append-trace` returns `active_campaign_cleared: false`, treat the run as
  unfinished and do not report completion.
- After a successful `final_fix`, verify that
  `.coortex/review-trace/active-review-campaign.json` no longer exists.
