#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import fnmatch
import json
import pathlib
import re
from typing import Any

TRACE_PHASES = {
    "trace_started",
    "prep",
    "lane_plan",
    "lane_result",
    "omission_followup",
    "family_synthesis",
    "refreshed_review_handoff",
    "final_review",
}

TRACE_PHASE_REQUIRED_FIELDS: dict[str, dict[str, str]] = {
    "trace_started": {},
    "prep": {},
    "lane_plan": {
        "lane_id": "string",
        "lane_type": "string",
        "target": "string",
        "scope_summary": "string",
        "anchors_or_family_ids": "list",
        "configured_lenses": "list",
        "split_triggers_fired": "list",
        "boundedness_exception": "present",
    },
    "lane_result": {
        "lane_id": "string",
        "lane_type": "string",
        "target": "string",
        "scope_summary": "string",
        "files_read": "list",
        "docs_read": "list",
        "searches_run": "list",
        "diagnostics_run": "list",
        "commands_run": "list",
        "candidate_family_decisions": "list",
        "sibling_search_paths_attempted": "list",
        "skipped_areas": "list",
        "thin_areas": "list",
        "stop_reason": "string",
        "coverage_confidence": "string",
        "omission_entries": "list",
    },
    "omission_followup": {
        "source_lane_ids": "list",
        "followup_decisions": "list",
    },
    "family_synthesis": {
        "family_id": "string",
        "input_lanes": "list",
        "family_verdict": "string",
        "closure_status": "string",
        "thin_areas": "list",
        "still_actionable": "bool",
    },
    "refreshed_review_handoff": {
        "family_ids_carried_forward": "list",
        "reason": "string",
    },
    "final_review": {
        "final_verdict": "string",
        "review_shape_trace_summary": "present",
        "unexplored_area_ledger_summary": "present",
        "boundedness_exceptions_summary": "present",
    },
}

KNOWN_RUNTIME_FOCUS_TOKENS = {
    "goal-fidelity",
    "qa-execution",
    "quality",
    "security",
    "api-contract",
    "performance",
    "portability",
    "context-history",
    "soc",
}

FOCUS_ALIASES = {
    "separation-of-concerns": "soc",
    "separation_of_concerns": "soc",
    "separation of concerns": "soc",
    "separation-concerns": "soc",
}

KNOWN_OMISSION_KINDS = {
    "skipped-area",
    "thin-area",
}

KNOWN_OMISSION_DISPOSITIONS = {
    "ignore",
    "carry-thin",
    "spawn-follow-up",
}

KNOWN_FOLLOWUP_LANE_TYPES = {
    "coverage-lane",
    "family-exploration-lane",
    "return-review-lane",
    "deferred-thread-exploration-lane",
}

KNOWN_FOLLOWUP_DECISIONS = {
    "ignored",
    "carried-thin",
    "spawned-follow-up",
    "declined-follow-up",
}

SEVERITY_RANK = {
    "CRITICAL": 4,
    "HIGH": 3,
    "MEDIUM": 2,
    "LOW": 1,
}

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


def normalize_string_list(value: Any) -> list[str]:
    if value in (None, "none"):
        return []
    if isinstance(value, list):
        return [str(item) for item in value if item not in (None, "none")]
    return [str(value)]


def slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "item"


def normalize_focus_token(value: str) -> str:
    raw = value.strip().lower()
    return FOCUS_ALIASES.get(raw, raw.replace("_", "-").replace(" ", "-"))


def normalize_project_path(value: str) -> str:
    path = value.strip().replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path.rstrip("/") if path not in {"", "/"} else path


def wildcard_kind(value: str) -> str:
    if not any(char in value for char in "*?["):
        return "exact"
    if value.endswith("/**") and value.count("*") == 2 and "?" not in value and "[" not in value:
        return "tree"
    return "unsupported"


def resolve_user_path(project_root: pathlib.Path, raw_path: str) -> pathlib.Path:
    candidate = pathlib.Path(raw_path)
    if candidate.is_absolute():
        return candidate
    return project_root / candidate


def default_run_id(mode: str) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"review-orchestrator-{mode}-{timestamp}"


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
    if expected == "bool":
        if not isinstance(value, bool):
            errors.append(f"{prefix} field {field} must be a boolean")
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

    lane_id = record.get("lane_id")
    family_id = record.get("family_id")
    if phase in {"lane_plan", "lane_result"} and family_id is not None and lane_id is None:
        errors.append(f"{prefix} phase {phase!r} cannot include family_id without lane_id")
    if phase == "family_synthesis" and lane_id is not None:
        errors.append(f"{prefix} phase {phase!r} should not include lane_id")

    if phase == "lane_result":
        errors.extend(validate_omission_entries(record.get("omission_entries"), f"{prefix} phase {phase!r}"))
    if phase == "omission_followup":
        errors.extend(validate_followup_decisions(record, f"{prefix} phase {phase!r}"))

    return errors


def validate_omission_entries(value: Any, prefix: str) -> list[str]:
    errors: list[str] = []
    if not isinstance(value, list):
        return [f"{prefix} field omission_entries must be a list"]
    for index, entry in enumerate(value):
        entry_prefix = f"{prefix} omission_entries[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{entry_prefix} must be a mapping")
            continue
        omission_id = entry.get("omission_id")
        if not isinstance(omission_id, str) or not omission_id.strip():
            errors.append(f"{entry_prefix} omission_id must be a non-empty string")
        kind = entry.get("kind")
        if kind not in KNOWN_OMISSION_KINDS:
            errors.append(f"{entry_prefix} kind must be one of {sorted(KNOWN_OMISSION_KINDS)}")
        area = entry.get("area")
        if not isinstance(area, str) or not area.strip():
            errors.append(f"{entry_prefix} area must be a non-empty string")
        reason = entry.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            errors.append(f"{entry_prefix} reason must be a non-empty string")
        disposition = entry.get("disposition")
        if disposition not in KNOWN_OMISSION_DISPOSITIONS:
            errors.append(
                f"{entry_prefix} disposition must be one of {sorted(KNOWN_OMISSION_DISPOSITIONS)}"
            )
            continue
        if disposition == "spawn-follow-up":
            lane_type = entry.get("suggested_lane_type")
            if lane_type not in KNOWN_FOLLOWUP_LANE_TYPES:
                errors.append(
                    f"{entry_prefix} suggested_lane_type must be one of {sorted(KNOWN_FOLLOWUP_LANE_TYPES)} when disposition is 'spawn-follow-up'"
                )
            target = entry.get("suggested_target")
            if not isinstance(target, str) or not target.strip():
                errors.append(
                    f"{entry_prefix} suggested_target must be a non-empty string when disposition is 'spawn-follow-up'"
                )
    return errors


def validate_followup_decisions(record: dict[str, Any], prefix: str) -> list[str]:
    errors: list[str] = []
    source_lane_ids = record.get("source_lane_ids")
    if not isinstance(source_lane_ids, list):
        errors.append(f"{prefix} field source_lane_ids must be a list")
    followup_decisions = record.get("followup_decisions")
    if not isinstance(followup_decisions, list):
        return errors + [f"{prefix} field followup_decisions must be a list"]
    for index, entry in enumerate(followup_decisions):
        entry_prefix = f"{prefix} followup_decisions[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{entry_prefix} must be a mapping")
            continue
        for field in ("source_lane_id", "omission_id", "area", "coordinator_reason"):
            if not isinstance(entry.get(field), str) or not str(entry.get(field)).strip():
                errors.append(f"{entry_prefix} {field} must be a non-empty string")
        decision = entry.get("decision")
        if decision not in KNOWN_FOLLOWUP_DECISIONS:
            errors.append(f"{entry_prefix} decision must be one of {sorted(KNOWN_FOLLOWUP_DECISIONS)}")
            continue
        if decision == "spawned-follow-up":
            if not isinstance(entry.get("spawned_lane_id"), str) or not str(entry.get("spawned_lane_id")).strip():
                errors.append(f"{entry_prefix} spawned_lane_id must be a non-empty string when decision is 'spawned-follow-up'")
        if decision in {"ignored", "carried-thin", "declined-follow-up"} and entry.get("spawned_lane_id") not in (None, "", "none"):
            errors.append(f"{entry_prefix} spawned_lane_id must be omitted unless decision is 'spawned-follow-up'")
    return errors


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


def family_seam_hints(family: dict[str, Any]) -> tuple[str | None, list[str]]:
    review_hints = family.get("review_hints")
    if not isinstance(review_hints, dict):
        return None, []
    likely_owning_seam = review_hints.get("likely_owning_seam")
    likely = str(likely_owning_seam).strip() if isinstance(likely_owning_seam, str) else ""
    secondary = [
        seam
        for seam in normalize_string_list(review_hints.get("secondary_seams"))
        if seam and seam != likely
    ]
    return (likely or None), secondary


def summarize_seams_for_families(families: list[dict[str, Any]]) -> dict[str, Any]:
    seam_index: dict[str, dict[str, Any]] = {}
    families_without_owning_seam: list[str] = []

    for family in families:
        if not isinstance(family, dict):
            continue
        family_id = str(family.get("family_id") or "").strip()
        if not family_id:
            continue
        likely_owning_seam, secondary_seams = family_seam_hints(family)
        if not likely_owning_seam:
            families_without_owning_seam.append(family_id)
            continue

        entry = seam_index.setdefault(
            likely_owning_seam,
            {
                "seam": likely_owning_seam,
                "family_ids": [],
                "family_count": 0,
                "highest_severity": "LOW",
                "source_surfaces": set(),
                "secondary_seam_mentions": set(),
            },
        )
        entry["family_ids"].append(family_id)
        entry["family_count"] += 1

        severity = str(family.get("severity") or "LOW").upper()
        current = str(entry["highest_severity"])
        if SEVERITY_RANK.get(severity, 0) > SEVERITY_RANK.get(current, 0):
            entry["highest_severity"] = severity

        for surface in normalize_string_list(family.get("source_surfaces")):
            entry["source_surfaces"].add(surface)
        for seam in secondary_seams:
            entry["secondary_seam_mentions"].add(seam)

    def build_entry(raw: dict[str, Any]) -> dict[str, Any]:
        family_count = int(raw["family_count"])
        highest_severity = str(raw["highest_severity"])
        hot = family_count >= 2 or highest_severity in {"CRITICAL", "HIGH"}
        if family_count >= 2:
            hot_reason = "multiple families converge on the same likely owning seam"
        elif highest_severity in {"CRITICAL", "HIGH"}:
            hot_reason = "a high-severity family points at this likely owning seam"
        else:
            hot_reason = "none"
        return {
            "seam": raw["seam"],
            "family_ids": sorted(set(raw["family_ids"])),
            "family_count": family_count,
            "highest_severity": highest_severity,
            "source_surfaces": sorted(raw["source_surfaces"]),
            "secondary_seam_mentions": sorted(raw["secondary_seam_mentions"]),
            "hot": hot,
            "hot_reason": hot_reason,
        }

    summarized = [build_entry(entry) for entry in seam_index.values()]
    summarized.sort(
        key=lambda entry: (
            not entry["hot"],
            -entry["family_count"],
            -SEVERITY_RANK.get(str(entry["highest_severity"]), 0),
            str(entry["seam"]),
        )
    )

    return {
        "hot_seams": [entry for entry in summarized if entry["hot"]],
        "all_seams": summarized,
        "families_without_owning_seam": sorted(set(families_without_owning_seam)),
    }


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
    review_data = unwrap_root(load_json_object(pathlib.Path(args.review_handoff)), "review_handoff")
    return_data = unwrap_root(load_json_object(pathlib.Path(args.review_return_handoff)), "review_return_handoff")

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

        if (
            classification == "carry-forward-without-lane"
            and reason_kind == "user-scope-excluded"
            and touch_state == "not-started"
            and not overlap_files
            and not owning_seam_touched
            and not blocking_ids_in_slice
        ):
            actionability = "dormant-open-family"
            actionability_reason = (
                "family stayed open for visibility, but this slice explicitly excluded it and the current diff does not reactivate it"
            )
        else:
            actionability = "actionable-for-next-fixer"
            actionability_reason = (
                "family remains suitable for the next fixer handoff under the current defer classification"
            )

        results.append(
            {
                "family_id": family_id,
                "defer_reason_kind": reason_kind,
                "touch_state": touch_state,
                "classification": classification,
                "classification_reason": classification_reason,
                "actionability": actionability,
                "actionability_reason": actionability_reason,
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
    review_data = unwrap_root(load_json_object(pathlib.Path(args.review_handoff)), "review_handoff")
    return_data = unwrap_root(load_json_object(pathlib.Path(args.review_return_handoff)), "review_return_handoff")
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
    if classification_data.get("errors"):
        raise SystemExit("classification_json contains deferred-family errors; fix them before building the carried handoff")

    classification_index = {
        str(result.get("family_id")): result
        for result in raw_results
        if isinstance(result, dict) and result.get("family_id")
    }

    include_classifications = set(args.include_classification or ["carry-forward-without-lane"])
    selected_families: list[dict[str, Any]] = []
    carried_ids: list[str] = []
    dormant_ids: list[str] = []
    for result in raw_results:
        if not isinstance(result, dict):
            continue
        if result.get("classification") not in include_classifications:
            continue
        if (
            result.get("actionability") == "dormant-open-family"
            and not args.include_dormant
        ):
            family_id = str(result.get("family_id") or "")
            if family_id:
                dormant_ids.append(family_id)
            continue
        family_id = str(result.get("family_id") or "")
        if not family_id:
            continue
        original = family_index.get(family_id)
        deferred = deferred_index.get(family_id)
        classification = classification_index.get(family_id)
        if not original or not deferred or not classification:
            continue

        carried = copy.deepcopy(original)
        carried.pop("reviewer_next_step", None)
        carried["carry_forward_context"] = {
            "reason_kind": deferred.get("defer_reason_kind"),
            "touch_state": deferred.get("touch_state"),
            "reason": deferred.get("reason"),
            "actionable_when": deferred.get("actionable_when"),
            "blocking_family_ids": deferred.get("blocking_family_ids", "none"),
        }
        if deferred.get("status"):
            carried["closure_status"] = deferred["status"]
        carried["open_reason_kind"] = normalize_carried_open_reason(carried, deferred, classification)
        selected_families.append(carried)
        carried_ids.append(family_id)

    output = {
        "review_handoff": {
            "review_target": review_data.get("review_target"),
            "families": selected_families,
            "seam_summary": summarize_seams_for_families(selected_families),
        }
    }

    rendered = json.dumps(output, indent=2, sort_keys=False)
    if args.output:
        pathlib.Path(args.output).write_text(f"{rendered}\n", encoding="utf-8")
    else:
        print(rendered)

    if args.summary:
        print(
            json.dumps(
                {
                    "family_ids_carried_forward": carried_ids,
                    "family_ids_excluded_as_dormant": dormant_ids,
                    "output": args.output or "stdout",
                },
                indent=2,
                sort_keys=True,
            )
        )
    return 0


def summarize_seams(args: argparse.Namespace) -> int:
    review_data = unwrap_root(load_json_object(pathlib.Path(args.review_handoff)), "review_handoff")
    families = review_data.get("families")
    if not isinstance(families, list):
        raise SystemExit("review_handoff.families must be a list")

    valid_families = [family for family in families if isinstance(family, dict)]
    output = {"seam_summary": summarize_seams_for_families(valid_families)}

    rendered = json.dumps(output, indent=2, sort_keys=False)
    if args.output:
        pathlib.Path(args.output).write_text(f"{rendered}\n", encoding="utf-8")
    else:
        print(rendered)
    return 0


def normalize_carried_open_reason(
    carried: dict[str, Any],
    deferred: dict[str, Any],
    classification: dict[str, Any],
) -> str:
    reason_kind = str(deferred.get("defer_reason_kind") or "")
    touch_state = str(deferred.get("touch_state") or "")
    class_name = str(classification.get("classification") or "")

    if reason_kind == "blocked-by-external-environment":
        return "verification-separate-blocker"
    if (
        class_name == "requires-broader-cross-family-review"
        or touch_state == "broader-cross-family-overlap"
        or reason_kind == "blocked-by-broader-contract-change"
    ):
        return "broader-cross-family-contract"

    original = carried.get("open_reason_kind")
    if isinstance(original, str) and original:
        return original
    return "family-local-gap-remaining"


def resolve_full_review_baseline(args: argparse.Namespace) -> int:
    project_root = pathlib.Path(args.project_root).resolve()
    if args.explicit_path:
        baseline_path = resolve_user_path(project_root, args.explicit_path)
        if not baseline_path.exists():
            print(
                json.dumps(
                    {
                        "mode": "full-discovery-review",
                        "baseline_resolved": False,
                        "errors": [f"explicit baseline path {str(baseline_path)!r} does not exist"],
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
            return 2
        print(
            json.dumps(
                {
                    "mode": "full-discovery-review",
                    "baseline_resolved": True,
                    "baseline_path": str(baseline_path),
                    "resolution_source": "explicit-path",
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0

    candidates = [
        ("working-primary", project_root / ".coortex" / "review-baseline.yaml"),
        ("docs-primary", project_root / "docs" / "review-baseline.yaml"),
        ("doc-primary", project_root / "doc" / "review-baseline.yaml"),
    ]
    for source, path in candidates:
        if path.exists():
            print(
                json.dumps(
                    {
                        "mode": "full-discovery-review",
                        "baseline_resolved": True,
                        "baseline_path": str(path),
                        "resolution_source": source,
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
            return 0

    print(
        json.dumps(
            {
                "mode": "full-discovery-review",
                "baseline_resolved": False,
                "errors": [
                    "no full-review baseline was found via explicit path, .coortex/review-baseline.yaml, docs/review-baseline.yaml, or doc/review-baseline.yaml"
                ],
                "candidates_checked": [str(path) for _, path in candidates],
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 2


def summarize_lane_omissions(args: argparse.Namespace) -> int:
    lane_results: list[dict[str, Any]] = []
    if args.lane_result_file:
        for raw_path in args.lane_result_file:
            path = pathlib.Path(raw_path)
            data = load_json_object(path)
            lane_results.append(data)
    if args.lane_result_json:
        for raw_json in args.lane_result_json:
            data = json.loads(raw_json)
            if not isinstance(data, dict):
                raise SystemExit("lane_result_json entries must parse to objects")
            lane_results.append(data)
    if not lane_results:
        raise SystemExit("provide at least one --lane-result-file or --lane-result-json")

    errors: list[str] = []
    ignore_entries: list[dict[str, Any]] = []
    carry_entries: list[dict[str, Any]] = []
    followup_entries: list[dict[str, Any]] = []
    source_lane_ids: list[str] = []

    for index, lane in enumerate(lane_results):
        lane_prefix = f"lane_results[{index}]"
        lane_id = lane.get("lane_id")
        if not isinstance(lane_id, str) or not lane_id.strip():
            errors.append(f"{lane_prefix} missing lane_id")
            continue
        source_lane_ids.append(lane_id)
        lane_type = lane.get("lane_type")
        if not isinstance(lane_type, str) or not lane_type.strip():
            errors.append(f"{lane_prefix} missing lane_type")
            lane_type = ""
        target = lane.get("target")
        if not isinstance(target, str) or not target.strip():
            errors.append(f"{lane_prefix} missing target")
            target = ""
        scope_summary = lane.get("scope_summary")
        if not isinstance(scope_summary, str) or not scope_summary.strip():
            errors.append(f"{lane_prefix} missing scope_summary")
            scope_summary = ""
        omission_entries = lane.get("omission_entries")
        errors.extend(validate_omission_entries(omission_entries, lane_prefix))
        if not isinstance(omission_entries, list):
            continue
        for entry in omission_entries:
            if not isinstance(entry, dict):
                continue
            normalized = {
                "source_lane_id": lane_id,
                "source_lane_type": lane_type,
                "source_target": target,
                "scope_summary": scope_summary,
                "omission_id": entry.get("omission_id"),
                "kind": entry.get("kind"),
                "area": entry.get("area"),
                "reason": entry.get("reason"),
                "disposition": entry.get("disposition"),
            }
            if entry.get("disposition") == "ignore":
                ignore_entries.append(normalized)
            elif entry.get("disposition") == "carry-thin":
                carry_entries.append(normalized)
            elif entry.get("disposition") == "spawn-follow-up":
                normalized["suggested_lane_type"] = entry.get("suggested_lane_type")
                normalized["suggested_target"] = entry.get("suggested_target")
                followup_entries.append(normalized)

    output = {
        "mode": "review-omission-summary",
        "omission_summary": {
            "source_lane_ids": source_lane_ids,
            "ignored": ignore_entries,
            "carry_thin": carry_entries,
            "spawn_follow_up": followup_entries,
        },
    }
    if errors:
        output["errors"] = errors
        print(json.dumps(output, indent=2, sort_keys=True))
        return 2
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


def anchored_patterns(surface: dict[str, Any]) -> list[str]:
    return normalize_string_list(surface.get("primary_anchors")) + normalize_string_list(
        surface.get("supporting_anchors")
    )


def path_subset_supported(path_subset: str) -> bool:
    return wildcard_kind(path_subset) in {"exact", "tree"}


def anchor_contains_path_subset(anchor: str, path_subset: str) -> bool:
    anchor_norm = normalize_project_path(anchor)
    subset_norm = normalize_project_path(path_subset)
    anchor_kind = wildcard_kind(anchor_norm)
    subset_kind = wildcard_kind(subset_norm)

    if subset_kind == "unsupported":
        return False

    if subset_kind == "exact":
        if anchor_kind == "exact":
            return subset_norm == anchor_norm
        if anchor_kind == "tree":
            anchor_prefix = anchor_norm[:-3].rstrip("/")
            return (
                subset_norm == anchor_prefix
                or subset_norm.startswith(anchor_prefix + "/")
            )
        return fnmatch.fnmatchcase(subset_norm, anchor_norm)

    if subset_kind == "tree":
        subset_prefix = subset_norm[:-3].rstrip("/")
        if anchor_kind == "tree":
            anchor_prefix = anchor_norm[:-3].rstrip("/")
            return subset_prefix == anchor_prefix or subset_prefix.startswith(anchor_prefix + "/")
        return False

    return False


def resolve_surface_reference(
    surface_value: str | None,
    surfaces: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, list[str]]:
    if not surface_value:
        return None, []

    requested = normalize_focus_token(surface_value)
    matches = [
        surface
        for surface in surfaces
        if requested in {
            normalize_focus_token(str(surface.get("id") or "")),
            normalize_focus_token(str(surface.get("name") or "")),
        }
    ]
    if not matches:
        return None, [f"requested surface {surface_value!r} does not match any baseline surface"]
    if len(matches) > 1:
        return None, [f"requested surface {surface_value!r} matched multiple baseline surfaces"]
    return matches[0], []


def configured_focus_tokens(surface: dict[str, Any]) -> set[str]:
    tokens: set[str] = set()
    for lens in surface.get("configured_builtin_lenses", []):
        if isinstance(lens, dict) and lens.get("lens_id"):
            tokens.add(normalize_focus_token(str(lens["lens_id"])))
    for lens in surface.get("configured_custom_lenses", []):
        if isinstance(lens, dict):
            if lens.get("id"):
                tokens.add(normalize_focus_token(str(lens["id"])))
            if lens.get("name"):
                tokens.add(normalize_focus_token(str(lens["name"])))
    return tokens


def validate_full_review_narrowing(args: argparse.Namespace) -> int:
    baseline_data = load_json_object(pathlib.Path(args.baseline_json))
    surfaces = baseline_data.get("surfaces")
    if not isinstance(surfaces, list) or not surfaces:
        raise SystemExit("baseline_json.surfaces must be a non-empty list")

    valid_surfaces = [surface for surface in surfaces if isinstance(surface, dict)]
    if not valid_surfaces:
        raise SystemExit("baseline_json.surfaces must contain surface mappings")

    errors: list[str] = []

    explicit_surface, surface_errors = resolve_surface_reference(args.surface, valid_surfaces)
    errors.extend(surface_errors)

    path_subset = normalize_project_path(args.path_subset) if args.path_subset else None
    if path_subset and not path_subset_supported(path_subset):
        errors.append(
            "path_subset must be a project-relative file path, directory path, or a recursive directory glob ending in /**"
        )

    matching_surfaces: list[dict[str, Any]] = []
    if path_subset:
        matching_surfaces = [
            surface
            for surface in valid_surfaces
            if any(anchor_contains_path_subset(anchor, path_subset) for anchor in anchored_patterns(surface))
        ]
        if not matching_surfaces:
            errors.append(f"path_subset {path_subset!r} does not fit inside any baseline surface anchors")

    selected_surface = explicit_surface
    if selected_surface and path_subset:
        if not any(surface is selected_surface for surface in matching_surfaces):
            errors.append(
                f"path_subset {path_subset!r} does not fit inside the requested surface {selected_surface.get('id')!r}"
            )
        elif len(matching_surfaces) > 1:
            errors.append(
                f"path_subset {path_subset!r} overlaps multiple baseline surfaces and cannot be used as a clean run-local narrowing"
            )
    elif not selected_surface and path_subset:
        if len(matching_surfaces) == 1:
            selected_surface = matching_surfaces[0]
        elif len(matching_surfaces) > 1:
            errors.append(
                f"path_subset {path_subset!r} overlaps multiple baseline surfaces and needs an explicit surface or baseline refresh"
            )

    if not selected_surface and not args.surface and not path_subset:
        errors.append("run-local narrowing requires a resolvable surface, a path_subset, or both")

    normalized_focus = [normalize_focus_token(value) for value in normalize_string_list(args.focus)]
    if selected_surface:
        surface_focus_tokens = configured_focus_tokens(selected_surface)
        invalid_focus = [
            token
            for token in normalized_focus
            if token not in surface_focus_tokens and token not in KNOWN_RUNTIME_FOCUS_TOKENS
        ]
        if invalid_focus:
            errors.append(
                "focus override contains unsupported token(s): " + ", ".join(sorted(set(invalid_focus)))
            )
    elif normalized_focus:
        errors.append("focus override requires a resolved narrowed surface")

    if errors:
        print(
            json.dumps(
                {
                    "mode": "full-discovery-review",
                    "narrowing_valid": False,
                    "errors": errors,
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 2

    assert selected_surface is not None
    selected_surface_id = str(selected_surface.get("id") or "")
    selected_surface_name = str(selected_surface.get("name") or "")
    selected_builtin_lenses = [
        normalize_focus_token(str(lens.get("lens_id")))
        for lens in selected_surface.get("configured_builtin_lenses", [])
        if isinstance(lens, dict) and lens.get("lens_id")
    ]
    selected_custom_lenses = [
        normalize_focus_token(str(lens.get("id") or lens.get("name")))
        for lens in selected_surface.get("configured_custom_lenses", [])
        if isinstance(lens, dict) and (lens.get("id") or lens.get("name"))
    ]
    configured_tokens = configured_focus_tokens(selected_surface)
    configured_focus = [token for token in normalized_focus if token in configured_tokens]
    run_local_focus = [token for token in normalized_focus if token not in configured_tokens]

    output = {
        "mode": "full-discovery-review",
        "narrowing_valid": True,
        "narrowing": {
            "selected_surface_id": selected_surface_id,
            "selected_surface_name": selected_surface_name,
            "path_subset": path_subset,
            "requested_focus": normalized_focus,
            "configured_focus": configured_focus,
            "run_local_focus": run_local_focus,
            "configured_builtin_lenses": selected_builtin_lenses,
            "configured_custom_lenses": selected_custom_lenses,
        },
    }
    if path_subset:
        output["narrowing"]["path_subset_match_basis"] = (
            "path_subset resolved uniquely inside the selected baseline surface anchors"
        )
    elif args.surface:
        output["narrowing"]["path_subset_match_basis"] = "surface-only narrowing"

    print(json.dumps(output, indent=2, sort_keys=True))
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
    classify.add_argument("--review-handoff", required=True, help="Path to the review_handoff JSON file.")
    classify.add_argument(
        "--review-return-handoff",
        required=True,
        help="Path to the review_return_handoff JSON file.",
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
    carried.add_argument(
        "--include-dormant",
        action="store_true",
        help="Also carry forward dormant still-open families that were explicitly excluded from the current slice.",
    )
    carried.add_argument("--output")
    carried.add_argument("--summary", action="store_true")
    carried.set_defaults(func=build_carried_handoff)

    summarize = subparsers.add_parser(
        "summarize-seams",
        help="Aggregate review_handoff families by likely owning seam and flag hot seams for targeted follow-up review.",
    )
    summarize.add_argument("--review-handoff", required=True)
    summarize.add_argument("--output")
    summarize.set_defaults(func=summarize_seams)

    baseline = subparsers.add_parser(
        "resolve-full-review-baseline",
        help="Resolve the active full-review baseline path for a project.",
    )
    baseline.add_argument(
        "--project-root",
        required=True,
        help="Project root used for baseline resolution.",
    )
    baseline.add_argument(
        "--explicit-path",
        help="Optional user-provided explicit baseline path, absolute or project-relative.",
    )
    baseline.set_defaults(func=resolve_full_review_baseline)

    omissions = subparsers.add_parser(
        "summarize-lane-omissions",
        help="Validate and summarize machine-readable omission entries from one or more lane results.",
    )
    omissions.add_argument(
        "--lane-result-file",
        action="append",
        default=[],
        help="Path to a lane result JSON file. Repeat for multiple results.",
    )
    omissions.add_argument(
        "--lane-result-json",
        action="append",
        default=[],
        help="Inline lane result JSON object. Repeat for multiple results.",
    )
    omissions.set_defaults(func=summarize_lane_omissions)

    narrowing = subparsers.add_parser(
        "validate-full-review-narrowing",
        help="Validate and normalize a run-local full-review narrowing override against the selected baseline.",
    )
    narrowing.add_argument(
        "--baseline-json",
        required=True,
        help="Path to the selected baseline serialized to JSON.",
    )
    narrowing.add_argument(
        "--surface",
        help="Inferred baseline surface id or surface name to narrow to.",
    )
    narrowing.add_argument(
        "--path-subset",
        help="Project-relative file path, directory path, or recursive directory glob (dir/**) to narrow within the selected surface.",
    )
    narrowing.add_argument(
        "--focus",
        action="append",
        default=[],
        help="Run-local focus token. Repeat for multiple focuses.",
    )
    narrowing.set_defaults(func=validate_full_review_narrowing)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
