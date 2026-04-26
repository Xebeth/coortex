# Trace Artifact

Persist a compact operational trace for every orchestrator run.

Use the bundled helper for deterministic path/file management:

```bash
python scripts/return_review_state.py init-trace --project-root . --mode <mode>
python scripts/return_review_state.py lane-trace-file --trace-dir <dir> --lane-type <type> --session-id <id> --family-id <family_id> --family-name "<family name>"
python scripts/return_review_state.py handoff-path --trace-dir <dir>
python scripts/return_review_state.py validate-lane-result --lane-type <type> --input-file <lane-json>
python scripts/return_review_state.py validate-review-handoff --input-file <handoff-json>
python scripts/return_review_state.py write-review-handoff --trace-dir <dir> --input-file <handoff-json>
python scripts/return_review_state.py append-trace --trace-file <path> --record-file <json-file>
python scripts/return_review_state.py summarize-lane-omissions --lane-result-file <lane-json> [--lane-result-file <lane-json> ...]
python scripts/return_review_state.py append-family-ledger --run-id <run_id> --review-mode <mode> --review-target-mode <target_mode> --review-target-summary "<summary>" --family-id <family_id> --family-state <state>
python scripts/return_review_state.py current-run-reopens --run-id <run_id>
```

Resolve these bundled script paths relative to the installed
`.codex/skills/review-orchestrator/` directory, not relative to the repository
root.

The helper owns:
- run-directory creation
- active top-level review-campaign lock handling for the current worktree
- coordinator file creation
- lane filename construction
- JSONL append mechanics
- trace-record validation for known phase-boundary record types
- structured lane-result validation for coverage, exploration, return-review,
  and deferred-thread lanes
- structured `review_handoff` family-entry validation before persistence
- structured omission-entry validation and omission-summary bucketing
- repository family-ledger append/summary mechanics
- current-run reopened-family summary mechanics

The model still owns the contents of each trace record.

Repository-level active-campaign locks should preserve operator-facing
provenance when available:
- `owner_host_session_id`
- otherwise `owner_host_thread_id`
- `owner_started_from_cwd`

## Path layout

- Create one directory per run under:
  - `.coortex/review-trace/<run_id>/`

Suggested `run_id` shape:
- `review-orchestrator-<mode>-<UTC timestamp>`

Inside that run directory:
- coordinator file:
  - `coordinator.jsonl`
- canonical downstream handoff artifact when actionable families remain:
  - `review-handoff.json`
- subagent/lane files:
  - for family-local lanes:
    - `<lane_type>-<family_id>-<family_name_slug>-<session_id>.jsonl`
  - for non-family-local lanes that do not yet have a stable family id:
    - `<lane_type>-<target_slug>-<session_id>.jsonl`

## Rules

- Create the directory if it does not exist.
- Allow only one concurrent top-level review campaign per worktree / `.coortex`
  root.
- Standalone orchestrator runs must not start while a seam-walk campaign is
  active in the same worktree.
- Standalone orchestrator runs must not start while a fixer-orchestrator
  campaign is active in the same worktree.
- Packet-driven exploration may run only when it is linked to the active
  seam-walk campaign id.
- Targeted return review may run during an active fixer-orchestrator campaign
  only when it is linked to that fixer campaign id.
- Append one JSON object per phase-boundary event.
- Let `append-trace` validate the record shape before it is written.
- Maintain a repository-level family ledger at:
  - `.coortex/review-trace/family-ledger.jsonl`
- Do not write hidden reasoning or a full transcript.
- Record observable review activity only.
- Keep trace data on disk by default. Do not surface trace paths or trace internals in normal output unless the user explicitly asks.
- Do not have multiple subagents append to one shared lane file. Each lane/subagent gets its own JSONL file inside the run directory.
- Use the family ledger to record normalized per-family outcomes and whether a family was reopened after previously being deemed closed.
- Use `current-run-reopens` to decide which reopen events from the ledger should be surfaced in the current review output.

## Record types

At minimum, append these record types when applicable:
- `trace_started`
- `prep`
- `packet_bootstrap`
- `lane_plan`
- `lane_result`
- `omission_followup`
- `family_synthesis`
- `review_handoff_emitted`
- `final_review`

## Common fields

Every record should include:
- `run_id`
- `timestamp_utc`
- `skill`
- `mode`
- `phase`
- `review_target`

## Prep record

Use normal `prep` for standalone full-discovery or targeted return review.

Include when known:
- `baseline_path`
- `changed_files`
- `surface_mapping`
- `split_triggers`
- `boundedness_exceptions`

## Packet-bootstrap record

Use `packet_bootstrap` in packet-driven exploration mode instead of pretending
that the coordinator reran full discovery prep.

Include:
- `campaign_id`
- `packet_path`
- `candidate_family_ids`
- `reopened_family_ids`

## Lane-plan record

Include:
- `lane_id`
- `lane_type`
- `target`
- `scope_summary`
- `anchors_or_family_ids`
- `configured_lenses`
- `split_triggers_fired`
- `boundedness_exception`

## Lane-result record

Include:
- `lane_id`
- `lane_type`
- `target`
- `scope_summary`
- `files_read`
- `docs_read`
- `searches_run`
- `diagnostics_run`
- `commands_run`
- `candidate_family_decisions`
- `sibling_search_paths_attempted`
- `skipped_areas`
- `thin_areas`
- `stop_reason`
- `coverage_confidence`
- `omission_entries`

`files_read` and `docs_read` should list the material files/docs the lane relied
on, not every incidental read.

`omission_entries` should preserve the lane's machine-readable omission
dispositions so later coordinator decisions are traceable on disk even when
normal output only surfaces the high-level confidence summary.

Before using a lane result for synthesis or appending its phase-boundary trace,
validate the lane artifact with:

```bash
python scripts/return_review_state.py validate-lane-result --lane-type <type> --input-file <lane-json>
```

If validation fails, the lane result is a protocol error. Do not infer missing
fields from prose or silently continue synthesis.

## Omission-followup record

Include:
- `source_lane_ids`
- `followup_decisions`

For each `followup_decisions` entry include:
- `source_lane_id`
- `omission_id`
- `area`
- `decision`
  - `ignored`
  - `carried-thin`
  - `spawned-follow-up`
  - `declined-follow-up`
- `coordinator_reason`
- `spawned_lane_id` when a follow-up lane was actually created

## Family-synthesis record

Include:
- `family_id`
- `input_lanes`
- `family_verdict`
- `closure_status`
- `thin_areas`
- `still_actionable`

## Review-handoff-emitted record

Include:
- `path`
- `family_ids`
- `kind`
  - `initial`
  - `refreshed`

Rules:
- When actionable families remain, persist the machine-oriented downstream
  `review_handoff` to the canonical run-local file:
  `.coortex/review-trace/<run_id>/review-handoff.json`
- `review_handoff_emitted` records the persisted artifact path and the exact
  actionable family-id set included in that file.
- Do not treat prose describing the handoff as a substitute for the persisted
  file and trace record.
- `write-review-handoff` validates the full `review_handoff` family-entry
  contract before writing. A failed validation is a protocol error, not an
  invitation to fall back to prose.
- `append-trace` validates `review_handoff_emitted` against the persisted
  file. The trace `family_ids` must match the family-id set inside
  `review-handoff.json`; ordering is not significant.

## Final-review record

Include:
- `final_verdict`
- `review_shape_trace_summary`
- `unexplored_area_ledger_summary`
- `boundedness_exceptions_summary`
- `review_handoff_path` when actionable families remain
- `actionable_family_ids` when actionable families remain

## Family ledger

Use the family ledger to track review churn across runs, especially:
- families marked `closed` that later return to an actionable state
- recurring `verification-blocked` families
- families repeatedly broadened or regrouped under new shared-seam hypotheses

The helper owns the ledger schema and update rules:
- `append-family-ledger` records normalized per-family outcomes
- `summarize-family-ledger` reports churn across runs
- `current-run-reopens` reports only the families this run reopened after a prior close

The ledger is primarily an analysis artifact on disk. Do not serialize the full
ledger into normal review output or handoffs unless the user explicitly asks
for it. If the current run needs reopened-family notes in normal output, get
that list from `current-run-reopens`.

## Actionable completion rule

- A run with actionable families is not complete until `review-handoff.json`
  has been written, `review_handoff_emitted` has been appended, and
  `final_review` points at that persisted path.
- `append-trace` should reject actionable `final_review` records when the
  canonical handoff file is missing or the prior `review_handoff_emitted`
  record does not match the final actionable family set.
- `append-trace` should also reject actionable `final_review` records when the
  canonical handoff file's family-id set does not match
  `actionable_family_ids`; ordering is not significant.
