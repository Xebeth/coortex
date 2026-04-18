#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import json
import pathlib
import re
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover - dependency failure path
    raise SystemExit("PyYAML is required to run return_review_state.py") from exc


def load_yaml_like(path: pathlib.Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path} did not parse to a mapping")
    return data


def unwrap_root(data: dict[str, Any], root_key: str) -> dict[str, Any]:
    value = data.get(root_key)
    if isinstance(value, dict):
        return value
    return data


def normalize_string_list(value: Any) -> list[str]:
    if value in (None, "none"):
        return []
    if isinstance(value, list):
        return [str(item) for item in value if item not in (None, "none")]
    return [str(value)]


def slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "item"


def default_run_id(mode: str) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"review-orchestrator-{mode}-{timestamp}"


def parse_json_record(record_json: str) -> dict[str, Any]:
    data = json.loads(record_json)
    if not isinstance(data, dict):
        raise SystemExit("trace record must be a JSON object")
    return data


def read_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        data = json.loads(line)
        if isinstance(data, dict):
            records.append(data)
    return records


def manifest_paths(manifestations: Any) -> list[str]:
    paths: list[str] = []
    for item in normalize_string_list(manifestations):
        paths.append(item.split(":", 1)[0])
    return paths


def family_candidate_paths(family: dict[str, Any]) -> set[str]:
    review_hints = family.get("review_hints")
    candidate_write_set: list[str] = []
    if isinstance(review_hints, dict):
        candidate_write_set = normalize_string_list(review_hints.get("candidate_write_set"))
    return set(candidate_write_set + manifest_paths(family.get("manifestations")))


def changed_files_from_args(args: argparse.Namespace) -> set[str]:
    changed: set[str] = set(normalize_string_list(args.changed_file))
    if args.changed_files_file:
        for line in pathlib.Path(args.changed_files_file).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                changed.add(line)
    return changed


def init_trace(args: argparse.Namespace) -> int:
    run_id = args.run_id or default_run_id(args.mode)
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
    with trace_file.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True))
        handle.write("\n")
    print(json.dumps({"trace_file": str(trace_file), "appended": True}, indent=2, sort_keys=True))
    return 0


def append_family_ledger(args: argparse.Namespace) -> int:
    trace_root = pathlib.Path(args.trace_root)
    trace_root.mkdir(parents=True, exist_ok=True)
    ledger_file = trace_root / "family-ledger.jsonl"
    history = read_jsonl(ledger_file)
    family_id = args.family_id
    previous = next((record for record in reversed(history) if record.get("family_id") == family_id), None)
    previous_state = previous.get("family_state") if previous else None
    actionable_states = {"open", "verification-blocked"}
    current_state = args.family_state
    reopened_after_closed = previous_state == "closed" and current_state in actionable_states

    record = {
        "timestamp_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "run_id": args.run_id,
        "skill": "review-orchestrator",
        "review_mode": args.review_mode,
        "review_target_mode": args.review_target_mode,
        "review_target_summary": args.review_target_summary,
        "family_id": family_id,
        "family_title": args.family_title,
        "family_state": current_state,
        "raw_status": args.raw_status,
        "evidence_source": args.evidence_source,
        "reason_summary": args.reason_summary,
        "previous_state": previous_state,
        "previous_run_id": previous.get("run_id") if previous else None,
        "reopened_after_closed": reopened_after_closed,
    }

    with ledger_file.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True))
        handle.write("\n")

    print(
        json.dumps(
            {
                "ledger_file": str(ledger_file),
                "recorded": True,
                "reopened_after_closed": reopened_after_closed,
                "previous_state": previous_state,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


def summarize_family_ledger(args: argparse.Namespace) -> int:
    ledger_file = pathlib.Path(args.trace_root) / "family-ledger.jsonl"
    history = read_jsonl(ledger_file)
    families: dict[str, list[dict[str, Any]]] = {}
    for record in history:
        family_id = str(record.get("family_id") or "")
        if family_id:
            families.setdefault(family_id, []).append(record)

    reopened_summary: list[dict[str, Any]] = []
    for family_id, records in sorted(families.items()):
        reopened_records = [record for record in records if record.get("reopened_after_closed") is True]
        if not reopened_records:
            continue
        last = records[-1]
        reopened_summary.append(
            {
                "family_id": family_id,
                "family_title": last.get("family_title"),
                "times_reopened_after_closed": len(reopened_records),
                "current_state": last.get("family_state"),
                "last_run_id": last.get("run_id"),
                "last_review_target_summary": last.get("review_target_summary"),
            }
        )

    output = {
        "ledger_file": str(ledger_file),
        "families_seen": len(families),
        "families_reopened_after_closed": reopened_summary,
    }
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


def current_run_reopens(args: argparse.Namespace) -> int:
    ledger_file = pathlib.Path(args.trace_root) / "family-ledger.jsonl"
    history = read_jsonl(ledger_file)
    reopened_records = [
        record
        for record in history
        if record.get("run_id") == args.run_id and record.get("reopened_after_closed") is True
    ]
    summary = [
        {
            "family_id": record.get("family_id"),
            "family_title": record.get("family_title"),
            "previous_state": record.get("previous_state"),
            "current_state": record.get("family_state"),
            "previous_run_id": record.get("previous_run_id"),
            "raw_status": record.get("raw_status"),
            "reason_summary": record.get("reason_summary"),
        }
        for record in reopened_records
    ]
    print(
        json.dumps(
            {
                "run_id": args.run_id,
                "ledger_file": str(ledger_file),
                "reopened_families_in_run": summary,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


def classify_deferred(args: argparse.Namespace) -> int:
    review_data = unwrap_root(load_yaml_like(pathlib.Path(args.review_handoff)), "review_handoff")
    return_data = unwrap_root(load_yaml_like(pathlib.Path(args.review_return_handoff)), "review_return_handoff")

    families = review_data.get("families")
    if not isinstance(families, list):
        raise SystemExit("review_handoff.families must be a list")

    family_index: dict[str, dict[str, Any]] = {}
    for family in families:
        if isinstance(family, dict) and family.get("family_id"):
            family_index[str(family["family_id"])] = family

    handled_family_ids: set[str] = set()
    raw_families = return_data.get("families")
    if isinstance(raw_families, list):
        handled_family_ids = {
            str(entry.get("original_family_id"))
            for entry in raw_families
            if isinstance(entry, dict) and entry.get("original_family_id")
        }

    changed_files = changed_files_from_args(args)
    deferred_entries = return_data.get("deferred_families")
    if deferred_entries in (None, "none"):
        deferred_entries = []
    if not isinstance(deferred_entries, list):
        raise SystemExit("review_return_handoff.deferred_families must be a list or none")

    results: list[dict[str, Any]] = []
    errors: list[str] = []
    valid_touch_states = {
        "not-started",
        "adjacent-file-overlap-no-owning-fix",
        "broader-cross-family-overlap",
    }
    for entry in deferred_entries:
        if not isinstance(entry, dict):
            errors.append("deferred family entry must be a mapping")
            continue

        family_id = str(entry.get("family_id") or "")
        if not family_id:
            errors.append("deferred family entry missing family_id")
            continue

        original_family = family_index.get(family_id)
        if not original_family:
            errors.append(f"deferred family {family_id} has no matching family in review_handoff")
            continue

        reason_kind = str(entry.get("defer_reason_kind") or "")
        if not reason_kind:
            errors.append(f"deferred family {family_id} missing defer_reason_kind")
            continue

        touch_state = str(entry.get("touch_state") or "")
        if not touch_state:
            errors.append(f"deferred family {family_id} missing touch_state")
            continue
        if touch_state not in valid_touch_states:
            errors.append(f"deferred family {family_id} has invalid touch_state {touch_state!r}")
            continue

        candidate_paths = family_candidate_paths(original_family)
        overlap_files = sorted(candidate_paths.intersection(changed_files))
        review_hints = original_family.get("review_hints")
        likely_owning_seam = review_hints.get("likely_owning_seam") if isinstance(review_hints, dict) else None
        owning_seam_touched = bool(likely_owning_seam and likely_owning_seam in changed_files)

        blocking_ids = normalize_string_list(entry.get("blocking_family_ids"))
        blocking_ids_in_slice = sorted(set(blocking_ids).intersection(handled_family_ids))

        if overlap_files and touch_state == "not-started":
            errors.append(
                f"deferred family {family_id} claims not-started but overlaps changed files {overlap_files}"
            )
            continue
        if not overlap_files and touch_state in {
            "adjacent-file-overlap-no-owning-fix",
            "broader-cross-family-overlap",
        }:
            errors.append(
                f"deferred family {family_id} claims overlap touch_state {touch_state!r} but no changed-file overlap was found"
            )
            continue
        if touch_state != "not-started" and not blocking_ids_in_slice:
            errors.append(
                f"deferred family {family_id} uses overlap touch_state {touch_state!r} without handled blocking_family_ids in this slice"
            )
            continue

        if touch_state == "broader-cross-family-overlap" or reason_kind == "blocked-by-broader-contract-change":
            classification = "requires-broader-cross-family-review"
            classification_reason = (
                "defer state indicates the remaining issue crosses a broader shared contract or seam"
            )
        elif overlap_files or blocking_ids_in_slice or owning_seam_touched:
            classification = "requires-family-local-check"
            if owning_seam_touched:
                classification_reason = (
                    "the likely owning seam was touched, so return review must distinguish adjacent overlap from unfinished family work"
                )
            elif overlap_files:
                classification_reason = "actual diff materially overlaps the deferred family's likely paths"
            else:
                classification_reason = "a blocking family from the same batch was handled in this slice"
        else:
            classification = "carry-forward-without-lane"
            classification_reason = (
                "actual diff does not materially overlap the deferred family's likely paths and no handled blocker forces reevaluation"
            )

        results.append(
            {
                "family_id": family_id,
                "defer_reason_kind": reason_kind,
                "touch_state": touch_state,
                "classification": classification,
                "classification_reason": classification_reason,
                "overlap_files": overlap_files,
                "owning_seam_touched": owning_seam_touched,
                "blocking_family_ids_in_slice": blocking_ids_in_slice,
            }
        )

    output = {
        "mode": "targeted-return-review",
        "deferred_family_classification": results,
    }
    if errors:
        output["errors"] = errors
        print(json.dumps(output, indent=2, sort_keys=True))
        return 2

    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


def build_carried_handoff(args: argparse.Namespace) -> int:
    review_data = unwrap_root(load_yaml_like(pathlib.Path(args.review_handoff)), "review_handoff")
    return_data = unwrap_root(load_yaml_like(pathlib.Path(args.review_return_handoff)), "review_return_handoff")
    classification_data = json.loads(pathlib.Path(args.classification_json).read_text(encoding="utf-8"))

    families = review_data.get("families")
    if not isinstance(families, list):
        raise SystemExit("review_handoff.families must be a list")
    family_index = {
        str(family["family_id"]): family
        for family in families
        if isinstance(family, dict) and family.get("family_id")
    }

    deferred_entries = return_data.get("deferred_families")
    if deferred_entries in (None, "none"):
        deferred_entries = []
    if not isinstance(deferred_entries, list):
        raise SystemExit("review_return_handoff.deferred_families must be a list or none")
    deferred_index = {
        str(entry["family_id"]): entry
        for entry in deferred_entries
        if isinstance(entry, dict) and entry.get("family_id")
    }

    raw_results = classification_data.get("deferred_family_classification")
    if not isinstance(raw_results, list):
        raise SystemExit("classification_json must contain deferred_family_classification list")

    include_classifications = set(args.include_classification or ["carry-forward-without-lane"])
    selected_families: list[dict[str, Any]] = []
    carried_ids: list[str] = []
    for result in raw_results:
        if not isinstance(result, dict):
            continue
        if result.get("classification") not in include_classifications:
            continue
        family_id = str(result.get("family_id") or "")
        if not family_id:
            continue
        original = family_index.get(family_id)
        deferred = deferred_index.get(family_id)
        if not original or not deferred:
            continue

        carried = copy.deepcopy(original)
        carried["carry_forward_context"] = {
            "reason_kind": deferred.get("defer_reason_kind"),
            "touch_state": deferred.get("touch_state"),
            "reason": deferred.get("reason"),
            "actionable_when": deferred.get("actionable_when"),
            "blocking_family_ids": deferred.get("blocking_family_ids", "none"),
        }
        if deferred.get("status"):
            carried["closure_status"] = deferred["status"]
        selected_families.append(carried)
        carried_ids.append(family_id)

    output = {
        "review_handoff": {
            "review_target": review_data.get("review_target"),
            "families": selected_families,
        }
    }

    rendered = yaml.safe_dump(output, sort_keys=False)
    if args.output:
        pathlib.Path(args.output).write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")

    if args.summary:
        print(
            json.dumps(
                {
                    "family_ids_carried_forward": carried_ids,
                    "output": args.output or "stdout",
                },
                indent=2,
                sort_keys=True,
            )
        )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Deterministic helper for review-orchestrator targeted return-review state."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser(
        "init-trace",
        help="Create or resume the orchestrator run trace directory and coordinator file.",
    )
    init.add_argument("--trace-root", default=".coortex/review-trace")
    init.add_argument("--mode", default="full-review")
    init.add_argument("--run-id")
    init.set_defaults(func=init_trace)

    lane_file = subparsers.add_parser(
        "lane-trace-file",
        help="Create or resolve a lane trace filename inside an orchestrator run directory.",
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

    family_ledger = subparsers.add_parser(
        "append-family-ledger",
        help="Append one normalized family outcome record to the repository family ledger.",
    )
    family_ledger.add_argument("--trace-root", default=".coortex/review-trace")
    family_ledger.add_argument("--run-id", required=True)
    family_ledger.add_argument("--review-mode", required=True)
    family_ledger.add_argument("--review-target-mode", required=True)
    family_ledger.add_argument("--review-target-summary", required=True)
    family_ledger.add_argument("--family-id", required=True)
    family_ledger.add_argument("--family-title", default="")
    family_ledger.add_argument(
        "--family-state",
        required=True,
        choices=["open", "closed", "verification-blocked", "unverified"],
    )
    family_ledger.add_argument("--raw-status", default="")
    family_ledger.add_argument("--evidence-source", default="review-synthesis")
    family_ledger.add_argument("--reason-summary", default="")
    family_ledger.set_defaults(func=append_family_ledger)

    family_ledger_summary = subparsers.add_parser(
        "summarize-family-ledger",
        help="Summarize families that were reopened after previously being deemed closed.",
    )
    family_ledger_summary.add_argument("--trace-root", default=".coortex/review-trace")
    family_ledger_summary.set_defaults(func=summarize_family_ledger)

    current_reopens = subparsers.add_parser(
        "current-run-reopens",
        help="Report only the families reopened-after-closed by the current run.",
    )
    current_reopens.add_argument("--trace-root", default=".coortex/review-trace")
    current_reopens.add_argument("--run-id", required=True)
    current_reopens.set_defaults(func=current_run_reopens)

    classify = subparsers.add_parser(
        "classify-deferred",
        help="Validate and classify fixer-reported deferred families against the original review handoff and changed files.",
    )
    classify.add_argument("--review-handoff", required=True, help="Path to the review_handoff YAML/JSON file.")
    classify.add_argument(
        "--review-return-handoff",
        required=True,
        help="Path to the review_return_handoff YAML/JSON file.",
    )
    classify.add_argument(
        "--changed-file",
        action="append",
        default=[],
        help="Changed file path. Repeat for multiple files.",
    )
    classify.add_argument(
        "--changed-files-file",
        help="Optional path to a newline-delimited changed-files list.",
    )
    classify.set_defaults(func=classify_deferred)

    carried = subparsers.add_parser(
        "build-carried-handoff",
        help="Build a refreshed review_handoff skeleton for deferred families carried forward without a new lane.",
    )
    carried.add_argument("--review-handoff", required=True)
    carried.add_argument("--review-return-handoff", required=True)
    carried.add_argument("--classification-json", required=True)
    carried.add_argument(
        "--include-classification",
        action="append",
        help="Classification(s) to carry forward. Defaults to carry-forward-without-lane.",
    )
    carried.add_argument("--output")
    carried.add_argument("--summary", action="store_true")
    carried.set_defaults(func=build_carried_handoff)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
