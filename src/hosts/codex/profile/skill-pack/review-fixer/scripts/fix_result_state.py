#!/usr/bin/env python3
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import pathlib
import re
from typing import Any

TRACE_PHASES = {
    "trace_started",
    "intake",
    "execution_plan",
    "family_closeout",
    "verification",
    "review_return_handoff",
    "final_fix",
}

TRACE_PHASE_REQUIRED_FIELDS: dict[str, dict[str, str]] = {
    "trace_started": {},
    "intake": {
        "family_ids": "list",
        "closure_gate_summaries": "list",
        "candidate_write_sets": "list",
    },
    "execution_plan": {
        "family_id": "string",
        "owning_seam": "string",
        "planned_write_set": "list",
        "planned_test_set": "list",
        "planned_doc_set": "list",
        "execution_mode": "string",
    },
    "family_closeout": {
        "family_id": "string",
        "write_set": "list",
        "tests_updated": "list",
        "docs_updated": "list",
        "files_read": "list",
        "docs_read": "list",
        "searches_run": "list",
        "commands_run": "list",
        "verification_run": "list",
        "emergent_threads_followed": "list",
        "emergent_threads_deferred": "list",
        "closure_status": "string",
        "residual_risks": "list",
    },
    "verification": {
        "family_id": "string",
        "verification_run": "list",
        "broader_suite_status": "string",
    },
    "review_return_handoff": {},
    "final_fix": {
        "family_ids_handled": "list",
        "final_statuses": "list",
    },
}

CLOSURE_STATUSES = {
    "symptom-fixed-only",
    "family-partially-closed",
    "verification-blocked",
    "family-closed",
}

OPEN_REASON_KINDS = {
    "family-local-gap-remaining",
    "unfinished-family-work",
    "broader-cross-family-contract",
    "verification-separate-blocker",
}

DEFER_REASON_KINDS = {
    "sequenced-after-overlapping-family",
    "separate-family-later-slice",
    "blocked-by-broader-contract-change",
    "blocked-by-prerequisite-contract-change",
    "blocked-by-external-environment",
    "stale-or-ambiguous-input",
    "user-scope-excluded",
    "insufficient-grounded-evidence",
}

DEFER_TOUCH_STATES = {
    "not-started",
    "adjacent-file-overlap-no-owning-fix",
    "broader-cross-family-overlap",
}

CONTENT_FREE_REASONS = {
    "untouched in this slice.",
    "untouched in this slice",
}

FIXER_ORIENTED_ACTION_PATTERNS = (
    "introduce ",
    "implement ",
    "add ",
    "change ",
    "modify ",
    "update code",
    "patch ",
    "fix ",
    "wire ",
    "thread ",
    "rekey ",
    "rename ",
    "take the next fix slice",
    "land ",
)


def load_json_object(path: pathlib.Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path} did not parse to a mapping")
    return data


def unwrap_root(data: dict[str, Any], root_key: str) -> dict[str, Any]:
    value = data.get(root_key)
    if isinstance(value, dict):
        return value
    return data


def as_list(value: Any) -> list[Any]:
    if value in (None, "none"):
        return []
    if isinstance(value, list):
        return value
    return [value]


def normalize_string_list(value: Any) -> list[str]:
    return [str(item) for item in as_list(value)]


def manifest_paths(manifestations: Any) -> list[str]:
    return [item.split(":", 1)[0] for item in normalize_string_list(manifestations)]


def family_candidate_paths(family: dict[str, Any]) -> set[str]:
    review_hints = family.get("review_hints")
    candidate_write_set: list[str] = []
    if isinstance(review_hints, dict):
        candidate_write_set = normalize_string_list(review_hints.get("candidate_write_set"))
    return set(candidate_write_set + manifest_paths(family.get("manifestations")))


def family_entry_touched_paths(entry: dict[str, Any]) -> set[str]:
    touched: set[str] = set()
    for field in ("touched_write_set", "touched_tests", "touched_docs"):
        touched.update(normalize_string_list(entry.get(field)))
    return touched


def slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "item"


def default_run_id() -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"review-fixer-{timestamp}"


def parse_json_record(record_json: str) -> dict[str, Any]:
    data = json.loads(record_json)
    if not isinstance(data, dict):
        raise SystemExit("trace record must be a JSON object")
    return data


def require_trace_field_type(
    record: dict[str, Any],
    field: str,
    expected: str,
    errors: list[str],
    prefix: str,
) -> None:
    if field not in record:
        errors.append(f"{prefix} missing {field}")
        return

    value = record[field]
    if expected == "present":
        return
    if expected == "string":
        if not isinstance(value, str) or not value.strip():
            errors.append(f"{prefix} field {field} must be a non-empty string")
        return
    if expected == "list":
        if not isinstance(value, list):
            errors.append(f"{prefix} field {field} must be a list")
        return


def validate_trace_record(record: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    prefix = "trace record"

    common_fields = {
        "run_id": "string",
        "timestamp_utc": "string",
        "skill": "string",
        "mode": "string",
        "phase": "string",
        "review_target": "present",
    }
    for field, expected in common_fields.items():
        require_trace_field_type(record, field, expected, errors, prefix)

    phase = record.get("phase")
    if not isinstance(phase, str) or phase not in TRACE_PHASES:
        errors.append(f"{prefix} has invalid phase {phase!r}")
        return errors

    review_target = record.get("review_target")
    if not isinstance(review_target, (dict, str)):
        errors.append(f"{prefix} field review_target must be a mapping or string")

    for field, expected in TRACE_PHASE_REQUIRED_FIELDS[phase].items():
        require_trace_field_type(record, field, expected, errors, f"{prefix} phase {phase!r}")

    if phase in {"execution_plan", "family_closeout", "verification"} and "family_id" not in record:
        errors.append(f"{prefix} phase {phase!r} missing family_id")

    return errors


def require(entry: dict[str, Any], field: str, errors: list[str], prefix: str) -> Any:
    value = entry.get(field)
    if value is None:
        errors.append(f"{prefix} missing {field}")
    return value


def validate_reviewer_next_step(
    step: Any,
    errors: list[str],
    prefix: str,
) -> None:
    if step in (None, "none"):
        return
    if not isinstance(step, dict):
        errors.append(f"{prefix} reviewer_next_step must be a mapping or none")
        return
    action = step.get("action")
    if not isinstance(action, str):
        errors.append(f"{prefix} reviewer_next_step missing string action")
        return
    normalized = action.strip().lower()
    if any(normalized.startswith(pattern) for pattern in FIXER_ORIENTED_ACTION_PATTERNS):
        errors.append(
            f"{prefix} reviewer_next_step.action looks fixer-oriented; use reviewer-facing reevaluation guidance instead"
        )


def validate_family_entry(entry: dict[str, Any], errors: list[str], warnings: list[str]) -> None:
    family_id = str(require(entry, "original_family_id", errors, "family entry") or "")
    prefix = f"family {family_id or '<unknown>'}"
    status = require(entry, "claimed_closure_status", errors, prefix)
    if isinstance(status, str) and status not in CLOSURE_STATUSES:
        errors.append(f"{prefix} has invalid claimed_closure_status {status!r}")

    open_reason_kind = entry.get("open_reason_kind")
    if status != "family-closed":
        if open_reason_kind is None:
            errors.append(f"{prefix} remains open without open_reason_kind")
        elif not isinstance(open_reason_kind, str) or open_reason_kind not in OPEN_REASON_KINDS:
            errors.append(f"{prefix} has invalid open_reason_kind {open_reason_kind!r}")
    elif open_reason_kind not in (None, "none"):
        warnings.append(f"{prefix} is family-closed but still includes open_reason_kind")

    for field in (
        "touched_write_set",
        "touched_tests",
        "touched_docs",
        "closure_gate_checked",
        "emergent_threads_followed",
        "emergent_threads_deferred",
        "residual_risks",
        "verification_run",
    ):
        require(entry, field, errors, prefix)

    if status == "verification-blocked" and "verification_blocker" not in entry:
        errors.append(f"{prefix} uses verification-blocked without verification_blocker")
    if "next_step" in entry:
        errors.append(f"{prefix} uses next_step in review_return_handoff; use reviewer_next_step for reviewer-facing reevaluation guidance")
    reviewer_next_step = entry.get("reviewer_next_step")
    validate_reviewer_next_step(reviewer_next_step, errors, prefix)
    if status == "family-closed" and reviewer_next_step not in (None, "none"):
        errors.append(f"{prefix} is family-closed but still includes reviewer_next_step")

    if status == "family-closed":
        verification_run = as_list(entry.get("verification_run"))
        if not verification_run:
            errors.append(f"{prefix} uses family-closed without verification_run")
        broader_visible = any("broader_suite_status" in str(item) for item in verification_run)
        if not broader_visible:
            warnings.append(f"{prefix} family-closed but broader suite status is not obvious in verification_run")


def validate_deferred_family(
    entry: dict[str, Any],
    original_family: dict[str, Any] | None,
    handled_family_ids: set[str],
    handled_touched_paths: set[str],
    errors: list[str],
    warnings: list[str],
) -> None:
    family_id = str(require(entry, "family_id", errors, "deferred family") or "")
    prefix = f"deferred family {family_id or '<unknown>'}"
    reason_kind = require(entry, "defer_reason_kind", errors, prefix)
    if isinstance(reason_kind, str) and reason_kind not in DEFER_REASON_KINDS:
        errors.append(f"{prefix} has invalid defer_reason_kind {reason_kind!r}")

    touch_state = require(entry, "touch_state", errors, prefix)
    if isinstance(touch_state, str) and touch_state not in DEFER_TOUCH_STATES:
        errors.append(f"{prefix} has invalid touch_state {touch_state!r}")

    reason = require(entry, "reason", errors, prefix)
    if isinstance(reason, str) and reason.strip().lower() in CONTENT_FREE_REASONS:
        errors.append(f"{prefix} uses content-free reason {reason!r}")

    require(entry, "status", errors, prefix)
    require(entry, "actionable_when", errors, prefix)

    reviewer_next_step = entry.get("reviewer_next_step")
    if "next_step" in entry:
        errors.append(f"{prefix} uses next_step in review_return_handoff; use reviewer_next_step for reviewer-facing reevaluation guidance")
    validate_reviewer_next_step(reviewer_next_step, errors, prefix)

    blocking_ids = entry.get("blocking_family_ids")
    if blocking_ids is not None and blocking_ids != "none" and not isinstance(blocking_ids, list):
        errors.append(f"{prefix} blocking_family_ids must be a list or none")
    blocking_id_list = normalize_string_list(blocking_ids)
    if blocking_id_list:
        non_handled = sorted(set(blocking_id_list).difference(handled_family_ids))
        if non_handled:
            errors.append(
                f"{prefix} names blocking_family_ids that are not handled in this slice: {non_handled}"
            )

    if not original_family:
        return

    overlap_files = sorted(family_candidate_paths(original_family).intersection(handled_touched_paths))
    review_hints = original_family.get("review_hints")
    likely_owning_seam = review_hints.get("likely_owning_seam") if isinstance(review_hints, dict) else None
    owning_seam_overlap = bool(likely_owning_seam and likely_owning_seam in handled_touched_paths)

    if overlap_files and touch_state == "not-started":
        errors.append(
            f"{prefix} claims not-started but overlaps handled paths {overlap_files}; keep it as a handled open family or classify the overlap explicitly"
        )
    if not overlap_files and touch_state in {
        "adjacent-file-overlap-no-owning-fix",
        "broader-cross-family-overlap",
    }:
        errors.append(
            f"{prefix} claims overlap touch_state {touch_state!r} but no overlap with handled family paths was found"
        )
    if owning_seam_overlap and touch_state == "adjacent-file-overlap-no-owning-fix":
        errors.append(
            f"{prefix} overlaps the likely owning seam but is classified as adjacent-file-overlap-no-owning-fix; keep it as a handled open family or use a broader overlap defer with concrete blockers"
        )
    if owning_seam_overlap and touch_state == "broader-cross-family-overlap" and reason_kind != "blocked-by-broader-contract-change":
        errors.append(
            f"{prefix} overlaps the likely owning seam and uses broader-cross-family-overlap without blocked-by-broader-contract-change"
        )
    if touch_state != "not-started" and reason_kind == "separate-family-later-slice":
        errors.append(
            f"{prefix} uses separate-family-later-slice despite overlap; use an overlap-aware defer reason"
        )
    if touch_state != "not-started" and not blocking_id_list:
        errors.append(
            f"{prefix} uses overlap touch_state {touch_state!r} without blocking_family_ids"
        )


def validate_review_return(args: argparse.Namespace) -> int:
    data = unwrap_root(load_json_object(pathlib.Path(args.review_return_handoff)), "review_return_handoff")
    review_data: dict[str, Any] | None = None
    if args.review_handoff:
        review_data = unwrap_root(load_json_object(pathlib.Path(args.review_handoff)), "review_handoff")

    errors: list[str] = []
    warnings: list[str] = []

    original_review_target = data.get("original_review_target")
    if not isinstance(original_review_target, dict):
        errors.append("review_return_handoff missing original_review_target mapping")

    families = data.get("families")
    if not isinstance(families, list):
        errors.append("review_return_handoff.families must be a list")
        families = []

    review_family_ids: set[str] = set()
    original_family_index: dict[str, dict[str, Any]] = {}
    if review_data and isinstance(review_data.get("families"), list):
        for review_family in review_data["families"]:
            if isinstance(review_family, dict) and review_family.get("family_id"):
                family_id = str(review_family.get("family_id"))
                review_family_ids.add(family_id)
                original_family_index[family_id] = review_family

    handled_touched_paths: set[str] = set()

    for entry in families:
        if not isinstance(entry, dict):
            errors.append("family entry must be a mapping")
            continue
        validate_family_entry(entry, errors, warnings)
        handled_touched_paths.update(family_entry_touched_paths(entry))
        if review_family_ids:
            family_id = str(entry.get("original_family_id") or "")
            if family_id and family_id not in review_family_ids:
                errors.append(f"family {family_id} has no matching family_id in review_handoff")

    deferred_families = data.get("deferred_families")
    if deferred_families not in (None, "none"):
        if not isinstance(deferred_families, list):
            errors.append("review_return_handoff.deferred_families must be a list or none")
        else:
            for entry in deferred_families:
                if not isinstance(entry, dict):
                    errors.append("deferred family entry must be a mapping")
                    continue
                original_family = None
                family_id = str(entry.get("family_id") or "")
                if family_id:
                    original_family = original_family_index.get(family_id)
                validate_deferred_family(
                    entry,
                    original_family,
                    {
                        str(family_entry.get("original_family_id"))
                        for family_entry in families
                        if isinstance(family_entry, dict) and family_entry.get("original_family_id")
                    },
                    handled_touched_paths,
                    errors,
                    warnings,
                )
                if review_family_ids:
                    if family_id and family_id not in review_family_ids:
                        errors.append(f"deferred family {family_id} has no matching family_id in review_handoff")

    output = {
        "mode": "review-fixer",
        "validation": "review_return_handoff",
        "status": "ok" if not errors else "error",
        "warnings": warnings,
        "errors": errors,
    }
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0 if not errors else 2


def init_trace(args: argparse.Namespace) -> int:
    run_id = args.run_id or default_run_id()
    trace_root = pathlib.Path(args.trace_root)
    trace_dir = trace_root / run_id
    trace_dir.mkdir(parents=True, exist_ok=True)
    coordinator_file = trace_dir / "coordinator.jsonl"
    coordinator_file.touch(exist_ok=True)
    print(
        json.dumps(
            {
                "run_id": run_id,
                "trace_dir": str(trace_dir),
                "coordinator_file": str(coordinator_file),
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


def lane_trace_file(args: argparse.Namespace) -> int:
    trace_dir = pathlib.Path(args.trace_dir)
    trace_dir.mkdir(parents=True, exist_ok=True)
    lane_type = args.lane_type
    session_id = args.session_id
    if args.family_id:
        family_slug = slugify(args.family_name or args.family_id)
        filename = f"{lane_type}-{args.family_id}-{family_slug}-{session_id}.jsonl"
    else:
        if not args.target:
            raise SystemExit("--target is required when --family-id is not provided")
        filename = f"{lane_type}-{slugify(args.target)}-{session_id}.jsonl"
    trace_file = trace_dir / filename
    trace_file.touch(exist_ok=True)
    print(json.dumps({"trace_file": str(trace_file)}, indent=2, sort_keys=True))
    return 0


def append_trace(args: argparse.Namespace) -> int:
    trace_file = pathlib.Path(args.trace_file)
    trace_file.parent.mkdir(parents=True, exist_ok=True)
    if args.record_file:
        record = parse_json_record(pathlib.Path(args.record_file).read_text(encoding="utf-8"))
    else:
        record = parse_json_record(args.record_json)
    errors = validate_trace_record(record)
    if errors:
        print(
            json.dumps(
                {
                    "trace_file": str(trace_file),
                    "appended": False,
                    "status": "error",
                    "errors": errors,
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 2
    with trace_file.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True))
        handle.write("\n")
    print(
        json.dumps(
            {
                "trace_file": str(trace_file),
                "appended": True,
                "status": "ok",
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Deterministic helper for review-fixer output validation."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser(
        "init-trace",
        help="Create or resume the fixer run trace directory and coordinator file.",
    )
    init.add_argument("--trace-root", default=".coortex/review-trace")
    init.add_argument("--run-id")
    init.set_defaults(func=init_trace)

    lane_file = subparsers.add_parser(
        "lane-trace-file",
        help="Create or resolve a lane trace filename inside a fixer run directory.",
    )
    lane_file.add_argument("--trace-dir", required=True)
    lane_file.add_argument("--lane-type", required=True)
    lane_file.add_argument("--session-id", required=True)
    lane_file.add_argument("--family-id")
    lane_file.add_argument("--family-name")
    lane_file.add_argument("--target")
    lane_file.set_defaults(func=lane_trace_file)

    append = subparsers.add_parser(
        "append-trace",
        help="Append one JSON record to a trace JSONL file.",
    )
    append.add_argument("--trace-file", required=True)
    append_group = append.add_mutually_exclusive_group(required=True)
    append_group.add_argument("--record-json")
    append_group.add_argument("--record-file")
    append.set_defaults(func=append_trace)

    validate = subparsers.add_parser(
        "validate-review-return",
        help="Validate review_return_handoff structure and deferred-family state.",
    )
    validate.add_argument(
        "--review-return-handoff",
        required=True,
        help="Path to the review_return_handoff JSON file.",
    )
    validate.add_argument(
        "--review-handoff",
        help="Optional path to the original review_handoff JSON file for family-id mapping checks.",
    )
    validate.set_defaults(func=validate_review_return)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
