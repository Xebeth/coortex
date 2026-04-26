#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import fnmatch
import glob
import json
import os
import pathlib
import re
import subprocess
from typing import Any

TRACE_PHASES = {
    "trace_started",
    "prep",
    "packet_bootstrap",
    "lane_plan",
    "lane_result",
    "omission_followup",
    "family_synthesis",
    "review_handoff_emitted",
    "refreshed_review_handoff",
    "final_review",
}

ACTIVE_CAMPAIGN_FILE = "active-review-campaign.json"
PACKET_EXPLORATION_MODE = "packet-exploration"
TARGETED_RETURN_REVIEW_MODE = "targeted-return-review"
DISCOVERY_PACKET_PHASES = {"prep", "coverage", "family-exploration", "synthesis"}

TRACE_PHASE_REQUIRED_FIELDS: dict[str, dict[str, str]] = {
    "trace_started": {},
    "prep": {},
    "packet_bootstrap": {
        "campaign_id": "string",
        "packet_path": "string",
        "candidate_family_ids": "list",
        "reopened_family_ids": "list",
    },
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
    "review_handoff_emitted": {
        "path": "string",
        "family_ids": "list",
        "kind": "string",
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

ACTIONABLE_FINAL_VERDICTS = {"REQUEST CHANGES", "REQUEST_CHANGES", "HANDOFF_READY"}
HANDOFF_EMISSION_KINDS = {"initial", "refreshed"}

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

KNOWN_BASELINE_KINDS = {"primary", "variant"}
KNOWN_VARIANT_STRATEGIES = {"derived", "fresh"}
BASELINE_EXPECT_KINDS = {"any", "primary", "variant"}

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


def load_structured_mapping(path: pathlib.Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        data = json.loads(text)
    else:
        data = parse_simple_yaml_mapping(text, path)
    if not isinstance(data, dict):
        raise SystemExit(f"{path} did not parse to a mapping")
    return data


def strip_yaml_comment(line: str) -> str:
    quote: str | None = None
    escaped = False
    for index, char in enumerate(line):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in {"'", '"'}:
            quote = char
            continue
        if char == "#" and (index == 0 or line[index - 1].isspace()):
            return line[:index].rstrip()
    return line.rstrip()


def parse_yaml_scalar(raw: str) -> Any:
    value = raw.strip()
    if value == "":
        return ""
    if value == "[]":
        return []
    if value == "{}":
        return {}
    if value in {"null", "Null", "NULL", "~"}:
        return None
    if value in {"true", "True", "TRUE"}:
        return True
    if value in {"false", "False", "FALSE"}:
        return False
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [parse_yaml_scalar(part) for part in split_inline_yaml_list(inner)]
    if re.fullmatch(r"-?\d+", value):
        try:
            return int(value)
        except ValueError:
            return value
    return value


def split_inline_yaml_list(value: str) -> list[str]:
    parts: list[str] = []
    start = 0
    quote: str | None = None
    escaped = False
    for index, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in {"'", '"'}:
            quote = char
            continue
        if char == ",":
            parts.append(value[start:index].strip())
            start = index + 1
    parts.append(value[start:].strip())
    return parts


def split_yaml_mapping_entry(content: str) -> tuple[str, str | None]:
    match = re.match(r"^([A-Za-z0-9_-]+):(.*)$", content)
    if not match:
        raise ValueError(f"expected mapping entry, got {content!r}")
    key = match.group(1)
    rest = match.group(2).strip()
    return key, rest if rest != "" else None


def tokenize_simple_yaml(text: str) -> list[tuple[int, str]]:
    tokens: list[tuple[int, str]] = []
    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        if raw_line.strip() == "":
            continue
        if raw_line.strip() in {"---", "..."}:
            continue
        uncommented = strip_yaml_comment(raw_line)
        if uncommented.strip() == "":
            continue
        if "\t" in uncommented[: len(uncommented) - len(uncommented.lstrip(" \t"))]:
            raise ValueError(f"line {line_number}: tabs are not supported in indentation")
        indent = len(uncommented) - len(uncommented.lstrip(" "))
        tokens.append((indent, uncommented.strip()))
    return tokens


def parse_simple_yaml_mapping(text: str, path: pathlib.Path) -> dict[str, Any]:
    try:
        tokens = tokenize_simple_yaml(text)
        if not tokens:
            return {}
        data, index = parse_yaml_block(tokens, 0, tokens[0][0])
        if index != len(tokens):
            raise ValueError(f"unexpected content at line token {index + 1}")
        if not isinstance(data, dict):
            raise ValueError("top-level YAML document must be a mapping")
        return data
    except ValueError as exc:
        raise SystemExit(f"{path} could not be parsed as supported baseline YAML: {exc}") from exc


def parse_yaml_block(
    tokens: list[tuple[int, str]],
    index: int,
    indent: int,
) -> tuple[Any, int]:
    if index >= len(tokens):
        return {}, index
    current_indent, content = tokens[index]
    if current_indent < indent:
        return {}, index
    if current_indent != indent:
        raise ValueError(f"expected indentation {indent}, got {current_indent} near {content!r}")
    if content.startswith("- "):
        return parse_yaml_list(tokens, index, indent)
    return parse_yaml_mapping(tokens, index, indent)


def parse_yaml_mapping(
    tokens: list[tuple[int, str]],
    index: int,
    indent: int,
) -> tuple[dict[str, Any], int]:
    result: dict[str, Any] = {}
    while index < len(tokens):
        current_indent, content = tokens[index]
        if current_indent < indent:
            break
        if current_indent > indent:
            raise ValueError(f"unexpected nested mapping content {content!r}")
        if content.startswith("- "):
            break
        key, rest = split_yaml_mapping_entry(content)
        index += 1
        if rest is not None:
            result[key] = parse_yaml_scalar(rest)
            continue
        if index < len(tokens) and tokens[index][0] > indent:
            value, index = parse_yaml_block(tokens, index, tokens[index][0])
            result[key] = value
        else:
            result[key] = {}
    return result, index


def parse_yaml_list(
    tokens: list[tuple[int, str]],
    index: int,
    indent: int,
) -> tuple[list[Any], int]:
    result: list[Any] = []
    while index < len(tokens):
        current_indent, content = tokens[index]
        if current_indent < indent:
            break
        if current_indent > indent:
            raise ValueError(f"unexpected nested list content {content!r}")
        if not content.startswith("- "):
            break

        rest = content[2:].strip()
        index += 1
        if rest == "":
            if index < len(tokens) and tokens[index][0] > indent:
                value, index = parse_yaml_block(tokens, index, tokens[index][0])
            else:
                value = None
            result.append(value)
            continue

        if re.match(r"^[A-Za-z0-9_-]+:", rest):
            item: dict[str, Any] = {}
            key, item_rest = split_yaml_mapping_entry(rest)
            item[key] = parse_yaml_scalar(item_rest) if item_rest is not None else {}
            if index < len(tokens) and tokens[index][0] > indent:
                nested, index = parse_yaml_block(tokens, index, tokens[index][0])
                if not isinstance(nested, dict):
                    raise ValueError(f"list item mapping for {key!r} cannot merge non-mapping content")
                item.update(nested)
            result.append(item)
            continue

        result.append(parse_yaml_scalar(rest))
    return result, index


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


def try_git(args: list[str], cwd: pathlib.Path) -> str | None:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip()


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
    if phase == "review_handoff_emitted":
        errors.extend(validate_review_handoff_emitted_record(record, f"{prefix} phase {phase!r}"))
    if phase == "final_review":
        errors.extend(validate_final_review_record(record, f"{prefix} phase {phase!r}"))

    return errors


def validate_review_handoff_emitted_record(record: dict[str, Any], prefix: str) -> list[str]:
    errors: list[str] = []
    kind = record.get("kind")
    if kind not in HANDOFF_EMISSION_KINDS:
        errors.append(f"{prefix} kind must be one of {sorted(HANDOFF_EMISSION_KINDS)}")
    family_ids = record.get("family_ids")
    if isinstance(family_ids, list):
        if not family_ids:
            errors.append(f"{prefix} family_ids must not be empty")
        elif any(not isinstance(item, str) or not item.strip() for item in family_ids):
            errors.append(f"{prefix} family_ids entries must be non-empty strings")
    return errors


def validate_final_review_record(record: dict[str, Any], prefix: str) -> list[str]:
    errors: list[str] = []
    final_verdict = record.get("final_verdict")
    if final_verdict in ACTIONABLE_FINAL_VERDICTS:
        require_trace_field_type(record, "review_handoff_path", "string", errors, prefix)
        require_trace_field_type(record, "actionable_family_ids", "list", errors, prefix)
        actionable_family_ids = record.get("actionable_family_ids")
        if isinstance(actionable_family_ids, list):
            if not actionable_family_ids:
                errors.append(f"{prefix} actionable_family_ids must not be empty when final_verdict is actionable")
            elif any(not isinstance(item, str) or not item.strip() for item in actionable_family_ids):
                errors.append(f"{prefix} actionable_family_ids entries must be non-empty strings")
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


def resolve_trace_root(project_root: pathlib.Path, raw_trace_root: str) -> pathlib.Path:
    trace_root = pathlib.Path(raw_trace_root)
    if trace_root.is_absolute():
        return trace_root.resolve()
    return (project_root / trace_root).resolve()


def active_campaign_path(trace_root: pathlib.Path) -> pathlib.Path:
    return trace_root / ACTIVE_CAMPAIGN_FILE


def load_active_campaign(trace_root: pathlib.Path) -> dict[str, Any] | None:
    path = active_campaign_path(trace_root)
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else None


def write_active_campaign(trace_root: pathlib.Path, data: dict[str, Any]) -> pathlib.Path:
    trace_root.mkdir(parents=True, exist_ok=True)
    path = active_campaign_path(trace_root)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def clear_active_campaign(trace_root: pathlib.Path, campaign_id: str) -> bool:
    path = active_campaign_path(trace_root)
    active = load_active_campaign(trace_root)
    if not active or str(active.get("campaign_id") or "") != campaign_id:
        return False
    if path.exists():
        path.unlink()
    return True


def campaign_owner_metadata(args: argparse.Namespace) -> dict[str, str]:
    metadata = {
        "owner_started_from_cwd": str(pathlib.Path(args.owner_started_from_cwd or os.getcwd()).resolve()),
    }
    owner_host_session_id = args.owner_host_session_id or os.environ.get("CODEX_SESSION_ID")
    if owner_host_session_id:
        metadata["owner_host_session_id"] = owner_host_session_id
    else:
        owner_host_thread_id = os.environ.get("CODEX_THREAD_ID")
        if owner_host_thread_id:
            metadata["owner_host_thread_id"] = owner_host_thread_id
    return metadata


def require_packet_string(value: Any, field: str, errors: list[str], prefix: str) -> str | None:
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{prefix} field {field} must be a non-empty string")
        return None
    return value


def require_packet_list(value: Any, field: str, errors: list[str], prefix: str) -> list[Any] | None:
    if not isinstance(value, list):
        errors.append(f"{prefix} field {field} must be a list")
        return None
    return value


def validate_discovery_signal_entries(
    entries: Any,
    prefix: str,
    errors: list[str],
) -> tuple[set[str], set[str]]:
    signal_ids: set[str] = set()
    family_ids: set[str] = set()
    if not isinstance(entries, list):
        errors.append(f"{prefix} must be a list")
        return signal_ids, family_ids
    for index, entry in enumerate(entries):
        entry_prefix = f"{prefix}[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{entry_prefix} must be a mapping")
            continue
        signal_id = require_packet_string(entry.get("signal_id"), "signal_id", errors, entry_prefix)
        require_packet_string(entry.get("summary"), "summary", errors, entry_prefix)
        evidence = require_packet_list(entry.get("evidence"), "evidence", errors, entry_prefix)
        candidate_family_ids = require_packet_list(
            entry.get("candidate_family_ids"), "candidate_family_ids", errors, entry_prefix
        )
        if signal_id is not None:
            signal_ids.add(signal_id)
        if evidence is not None and any(not isinstance(item, str) or not item.strip() for item in evidence):
            errors.append(f"{entry_prefix} evidence entries must be non-empty strings")
        if candidate_family_ids is not None:
            for family_id in candidate_family_ids:
                if not isinstance(family_id, str) or not family_id.strip():
                    errors.append(f"{entry_prefix} candidate_family_ids entries must be non-empty strings")
                    continue
                family_ids.add(family_id)
    return signal_ids, family_ids


def validate_discovery_packet_data(packet: dict[str, Any], project_root: pathlib.Path | None = None) -> tuple[list[str], dict[str, Any]]:
    errors: list[str] = []
    summary: dict[str, Any] = {}

    if packet.get("packet_type") != "seam-walk-discovery":
        errors.append("packet_type must be 'seam-walk-discovery'")
    if packet.get("packet_version") != 1:
        errors.append("packet_version must be 1")

    campaign = packet.get("campaign")
    if not isinstance(campaign, dict):
        errors.append("campaign must be a mapping")
        return errors, summary

    campaign_id = require_packet_string(campaign.get("campaign_id"), "campaign_id", errors, "campaign")
    source_run_id = require_packet_string(campaign.get("source_run_id"), "source_run_id", errors, "campaign")
    worktree_root = require_packet_string(campaign.get("worktree_root"), "worktree_root", errors, "campaign")
    require_packet_string(campaign.get("base_ref"), "base_ref", errors, "campaign")
    merge_base = require_packet_string(campaign.get("merge_base"), "merge_base", errors, "campaign")
    head_sha = require_packet_string(campaign.get("head_sha"), "head_sha", errors, "campaign")
    baseline_path = require_packet_string(campaign.get("baseline_path"), "baseline_path", errors, "campaign")

    review_target = campaign.get("review_target")
    if not isinstance(review_target, dict):
        errors.append("campaign.review_target must be a mapping")
    else:
        require_packet_string(review_target.get("mode"), "mode", errors, "campaign.review_target")
        require_packet_string(review_target.get("scope_summary"), "scope_summary", errors, "campaign.review_target")

    commit_groups = packet.get("commit_groups")
    if not isinstance(commit_groups, list) or not commit_groups:
        errors.append("commit_groups must be a non-empty list")
        commit_groups = []

    known_group_ids: set[str] = set()
    review_signal_ids: set[str] = set()
    deslop_signal_ids: set[str] = set()
    referenced_family_ids: set[str] = set()

    for index, group in enumerate(commit_groups):
        prefix = f"commit_groups[{index}]"
        if not isinstance(group, dict):
            errors.append(f"{prefix} must be a mapping")
            continue
        group_id = require_packet_string(group.get("group_id"), "group_id", errors, prefix)
        require_packet_string(group.get("label"), "label", errors, prefix)
        require_packet_string(group.get("scope_summary"), "scope_summary", errors, prefix)
        commit_shas = require_packet_list(group.get("commit_shas"), "commit_shas", errors, prefix)
        files = require_packet_list(group.get("files"), "files", errors, prefix)
        primary_seams = require_packet_list(group.get("primary_seams"), "primary_seams", errors, prefix)
        thin_areas = require_packet_list(group.get("thin_areas"), "thin_areas", errors, prefix)
        if group_id is not None:
            if group_id in known_group_ids:
                errors.append(f"{prefix} group_id {group_id!r} must be unique")
            known_group_ids.add(group_id)
        for field_name, values in {"commit_shas": commit_shas, "files": files, "primary_seams": primary_seams, "thin_areas": thin_areas}.items():
            if values is not None and any(not isinstance(item, str) or not item.strip() for item in values):
                errors.append(f"{prefix} {field_name} entries must be non-empty strings")

        review_ids, review_families = validate_discovery_signal_entries(
            group.get("review_grounded_signals"), f"{prefix}.review_grounded_signals", errors
        )
        deslop_ids, deslop_families = validate_discovery_signal_entries(
            group.get("deslop_advisory_signals"), f"{prefix}.deslop_advisory_signals", errors
        )
        review_signal_ids.update(review_ids)
        deslop_signal_ids.update(deslop_ids)
        referenced_family_ids.update(review_families)
        referenced_family_ids.update(deslop_families)

    candidate_families = packet.get("candidate_families")
    if not isinstance(candidate_families, list):
        errors.append("candidate_families must be a list")
        candidate_families = []

    candidate_family_ids: set[str] = set()
    for index, family in enumerate(candidate_families):
        prefix = f"candidate_families[{index}]"
        if not isinstance(family, dict):
            errors.append(f"{prefix} must be a mapping")
            continue
        family_id = require_packet_string(family.get("family_id"), "family_id", errors, prefix)
        require_packet_string(family.get("title"), "title", errors, prefix)
        require_packet_string(family.get("candidate_root_cause"), "candidate_root_cause", errors, prefix)
        source_group_ids = require_packet_list(family.get("source_group_ids"), "source_group_ids", errors, prefix)
        family_review_ids = require_packet_list(
            family.get("review_grounded_signal_ids"), "review_grounded_signal_ids", errors, prefix
        )
        family_deslop_ids = require_packet_list(
            family.get("deslop_advisory_signal_ids"), "deslop_advisory_signal_ids", errors, prefix
        )
        require_packet_string(family.get("likely_owning_seam"), "likely_owning_seam", errors, prefix)
        secondary_seams = require_packet_list(family.get("secondary_seams"), "secondary_seams", errors, prefix)
        require_packet_string(family.get("status"), "status", errors, prefix)

        if family_id is not None:
            if family_id in candidate_family_ids:
                errors.append(f"{prefix} family_id {family_id!r} must be unique")
            candidate_family_ids.add(family_id)
        if source_group_ids is not None:
            for group_id in source_group_ids:
                if not isinstance(group_id, str) or not group_id.strip():
                    errors.append(f"{prefix} source_group_ids entries must be non-empty strings")
                elif group_id not in known_group_ids:
                    errors.append(f"{prefix} source_group_ids references unknown group_id {group_id!r}")
        if family_review_ids is not None:
            for signal_id in family_review_ids:
                if not isinstance(signal_id, str) or not signal_id.strip():
                    errors.append(f"{prefix} review_grounded_signal_ids entries must be non-empty strings")
                elif signal_id not in review_signal_ids:
                    errors.append(f"{prefix} review_grounded_signal_ids references unknown signal_id {signal_id!r}")
        if family_deslop_ids is not None:
            for signal_id in family_deslop_ids:
                if not isinstance(signal_id, str) or not signal_id.strip():
                    errors.append(f"{prefix} deslop_advisory_signal_ids entries must be non-empty strings")
                elif signal_id not in deslop_signal_ids:
                    errors.append(f"{prefix} deslop_advisory_signal_ids references unknown signal_id {signal_id!r}")
        if secondary_seams is not None and any(not isinstance(item, str) or not item.strip() for item in secondary_seams):
            errors.append(f"{prefix} secondary_seams entries must be non-empty strings")

    if referenced_family_ids and not referenced_family_ids.issubset(candidate_family_ids):
        missing = sorted(referenced_family_ids - candidate_family_ids)
        errors.append(f"candidate_families is missing family ids referenced by signals: {missing}")

    handoff = packet.get("handoff")
    if not isinstance(handoff, dict):
        errors.append("handoff must be a mapping")
    else:
        if handoff.get("mode") != "exploration-only":
            errors.append("handoff.mode must be 'exploration-only'")
        requested_phases = require_packet_list(handoff.get("requested_phases"), "requested_phases", errors, "handoff")
        if requested_phases is not None:
            normalized = []
            for phase in requested_phases:
                if not isinstance(phase, str) or not phase.strip():
                    errors.append("handoff.requested_phases entries must be non-empty strings")
                    continue
                normalized.append(phase)
                if phase not in DISCOVERY_PACKET_PHASES:
                    errors.append(f"handoff.requested_phases contains unknown phase {phase!r}")
            if not normalized:
                errors.append("handoff.requested_phases must not be empty")

    if project_root is not None:
        resolved_root = str(project_root.resolve())
        if worktree_root is not None and str(pathlib.Path(worktree_root).resolve()) != resolved_root:
            errors.append("campaign.worktree_root does not match the current project-root")
        current_head = try_git(["rev-parse", "HEAD"], project_root)
        if current_head is not None and head_sha is not None and current_head != head_sha:
            errors.append("campaign.head_sha does not match the current HEAD")

    summary = {
        "campaign_id": campaign_id,
        "source_run_id": source_run_id,
        "group_count": len(commit_groups),
        "candidate_family_ids": sorted(candidate_family_ids),
        "review_grounded_signal_count": len(review_signal_ids),
        "deslop_advisory_signal_count": len(deslop_signal_ids),
        "baseline_path": baseline_path,
        "merge_base": merge_base,
        "head_sha": head_sha,
    }
    return errors, summary


def validate_discovery_packet_command(args: argparse.Namespace) -> int:
    if args.packet_json:
        packet = parse_json_record(args.packet_json)
    else:
        packet = load_json_object(pathlib.Path(args.packet_file))
    project_root = pathlib.Path(args.project_root).resolve() if args.project_root else None
    errors, summary = validate_discovery_packet_data(packet, project_root)
    if errors:
        print(json.dumps({"valid": False, "errors": errors, **summary}, indent=2, sort_keys=True))
        return 2
    print(json.dumps({"valid": True, **summary}, indent=2, sort_keys=True))
    return 0


def init_trace(args: argparse.Namespace) -> int:
    project_root = pathlib.Path(args.project_root).resolve()
    trace_root = resolve_trace_root(project_root, args.trace_root)
    trace_root.mkdir(parents=True, exist_ok=True)

    packet_mode = args.mode == PACKET_EXPLORATION_MODE
    targeted_return_mode = args.mode == TARGETED_RETURN_REVIEW_MODE
    run_id = args.run_id or default_run_id(args.mode)
    active = load_active_campaign(trace_root)
    resumed = False
    linked_campaign_id = None

    if active and active.get("state") == "active":
        active_type = str(active.get("campaign_type") or "")
        active_campaign_id = str(active.get("campaign_id") or "")
        active_run_id = str(active.get("run_id") or active_campaign_id)
        if packet_mode:
            if not args.campaign_id:
                print(
                    json.dumps(
                        {
                            "status": "error",
                            "reason": "missing-campaign-id",
                            "message": "packet exploration requires --campaign-id from the active seam-walk campaign",
                            "active_campaign": active,
                        },
                        indent=2,
                        sort_keys=True,
                    )
                )
                return 2
            if active_type != "seam-walkback-review" or args.campaign_id != active_campaign_id:
                print(
                    json.dumps(
                        {
                            "status": "error",
                            "reason": "concurrent-review-campaign",
                            "message": "an active review campaign already exists for this worktree and does not match the requested seam-walk campaign",
                            "active_campaign": active,
                        },
                        indent=2,
                        sort_keys=True,
                    )
                )
                return 2
            linked_campaign_id = active_campaign_id
            active["child_run_id"] = run_id
            active["child_skill"] = "review-orchestrator"
            active["child_mode"] = args.mode
            write_active_campaign(trace_root, active)
        elif targeted_return_mode and active_type == "fixer-orchestrator":
            if not args.campaign_id:
                print(
                    json.dumps(
                        {
                            "status": "error",
                            "reason": "missing-campaign-id",
                            "message": "targeted return review during an active fixer campaign requires --campaign-id from that fixer campaign",
                            "active_campaign": active,
                        },
                        indent=2,
                        sort_keys=True,
                    )
                )
                return 2
            if args.campaign_id != active_campaign_id:
                print(
                    json.dumps(
                        {
                            "status": "error",
                            "reason": "concurrent-review-campaign",
                            "message": "an active fixer campaign already exists for this worktree and does not match the requested campaign id",
                            "active_campaign": active,
                        },
                        indent=2,
                        sort_keys=True,
                    )
                )
                return 2
            linked_campaign_id = active_campaign_id
            active["child_run_id"] = run_id
            active["child_skill"] = "review-orchestrator"
            active["child_mode"] = args.mode
            write_active_campaign(trace_root, active)
        else:
            if active_type != "review-orchestrator":
                print(
                    json.dumps(
                        {
                            "status": "error",
                            "reason": "concurrent-review-campaign",
                            "message": "an active top-level review campaign already exists for this worktree",
                            "active_campaign": active,
                        },
                        indent=2,
                        sort_keys=True,
                    )
                )
                return 2
            if args.run_id and run_id != active_run_id:
                print(
                    json.dumps(
                        {
                            "status": "error",
                            "reason": "concurrent-orchestrator-run",
                            "message": "a standalone orchestrator campaign is already active for this worktree",
                            "active_campaign": active,
                        },
                        indent=2,
                        sort_keys=True,
                    )
                )
                return 2
            run_id = active_run_id
            resumed = True
            linked_campaign_id = active_campaign_id
    else:
        if packet_mode:
            print(
                json.dumps(
                    {
                        "status": "error",
                        "reason": "missing-active-seam-walk",
                        "message": "packet exploration requires an active seam-walk campaign in this worktree",
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
            return 2
        linked_campaign_id = run_id
        owner_metadata = campaign_owner_metadata(args)
        write_active_campaign(
            trace_root,
            {
                "campaign_id": linked_campaign_id,
                "campaign_type": "review-orchestrator",
                "run_id": run_id,
                "state": "active",
                "worktree_root": str(project_root),
                "started_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                **owner_metadata,
            },
        )

    trace_dir = trace_root / run_id
    trace_dir.mkdir(parents=True, exist_ok=True)
    coordinator_file = trace_dir / "coordinator.jsonl"
    coordinator_file.touch(exist_ok=True)
    print(
        json.dumps(
            {
                "run_id": run_id,
                "campaign_id": linked_campaign_id,
                "trace_dir": str(trace_dir),
                "coordinator_file": str(coordinator_file),
                "active_campaign_file": str(active_campaign_path(trace_root)),
                "resumed": resumed,
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


def review_handoff_path(trace_dir: pathlib.Path) -> pathlib.Path:
    return trace_dir / "review-handoff.json"


def resolve_handoff_artifact_path(raw_path: str, trace_root: pathlib.Path) -> pathlib.Path:
    path = pathlib.Path(raw_path)
    if path.is_absolute():
        return path
    project_root = trace_root.parent.parent
    return (project_root / path).resolve()


def handoff_path_cmd(args: argparse.Namespace) -> int:
    trace_dir = pathlib.Path(args.trace_dir)
    trace_dir.mkdir(parents=True, exist_ok=True)
    path = review_handoff_path(trace_dir)
    print(json.dumps({"review_handoff_path": str(path)}, indent=2, sort_keys=True))
    return 0


def load_review_handoff_payload(input_json: str) -> dict[str, Any]:
    data = parse_json_record(input_json)
    if "review_handoff" in data:
        root = data.get("review_handoff")
        if not isinstance(root, dict):
            raise SystemExit("review_handoff must be a mapping")
        payload = data
    else:
        payload = {"review_handoff": data}
        root = data
    families = root.get("families")
    if not isinstance(families, list):
        raise SystemExit("review_handoff.families must be a list")
    return payload


def write_review_handoff(args: argparse.Namespace) -> int:
    trace_dir = pathlib.Path(args.trace_dir)
    trace_dir.mkdir(parents=True, exist_ok=True)
    if args.input_file:
        payload = load_review_handoff_payload(pathlib.Path(args.input_file).read_text(encoding="utf-8"))
    else:
        payload = load_review_handoff_payload(args.input_json)
    handoff_path = review_handoff_path(trace_dir)
    handoff_path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    review_handoff = payload["review_handoff"]
    family_ids = [
        str(entry.get("family_id"))
        for entry in review_handoff.get("families", [])
        if isinstance(entry, dict) and isinstance(entry.get("family_id"), str) and str(entry.get("family_id")).strip()
    ]
    print(
        json.dumps(
            {
                "review_handoff_path": str(handoff_path),
                "family_ids": family_ids,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


def latest_review_handoff_emission(records: list[dict[str, Any]]) -> dict[str, Any] | None:
    for record in reversed(records):
        phase = str(record.get("phase") or "")
        if phase == "review_handoff_emitted":
            return record
        if phase == "refreshed_review_handoff":
            return {
                "phase": phase,
                "path": record.get("path"),
                "family_ids": record.get("family_ids_carried_forward"),
                "kind": "refreshed",
            }
    return None


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
    existing_records = read_jsonl(trace_file)
    phase = str(record.get("phase") or "")
    if phase == "final_review" and str(record.get("final_verdict") or "") in ACTIONABLE_FINAL_VERDICTS:
        review_handoff_path_value = str(record.get("review_handoff_path") or "")
        handoff_emission = latest_review_handoff_emission(existing_records)
        actionable_family_ids = [str(item) for item in record.get("actionable_family_ids") or []]
        if handoff_emission is None:
            print(
                json.dumps(
                    {
                        "trace_file": str(trace_file),
                        "appended": False,
                        "status": "error",
                        "errors": ["trace record phase 'final_review' is actionable but no prior review_handoff_emitted record exists"],
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
            return 2
        trace_root = trace_file.parent.parent
        handoff_path = resolve_handoff_artifact_path(review_handoff_path_value, trace_root)
        if not handoff_path.exists():
            print(
                json.dumps(
                    {
                        "trace_file": str(trace_file),
                        "appended": False,
                        "status": "error",
                        "errors": ["trace record phase 'final_review' review_handoff_path does not exist on disk"],
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
            return 2
        emitted_path = str(handoff_emission.get("path") or "")
        emitted_family_ids = [str(item) for item in handoff_emission.get("family_ids") or []]
        if emitted_path:
            resolved_emitted_path = resolve_handoff_artifact_path(emitted_path, trace_root)
            if resolved_emitted_path != handoff_path:
                print(
                    json.dumps(
                        {
                            "trace_file": str(trace_file),
                            "appended": False,
                            "status": "error",
                            "errors": ["trace record phase 'final_review' review_handoff_path does not match the latest review_handoff_emitted record"],
                        },
                        indent=2,
                        sort_keys=True,
                    )
                )
                return 2
        if emitted_family_ids != actionable_family_ids:
            print(
                json.dumps(
                    {
                        "trace_file": str(trace_file),
                        "appended": False,
                        "status": "error",
                        "errors": ["trace record phase 'final_review' actionable_family_ids must match the latest review_handoff_emitted record"],
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
            return 2

    with trace_file.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True))
        handle.write("\n")

    trace_root = trace_file.parent.parent
    active_cleared = False
    record_run_id = str(record.get("run_id") or "")
    record_campaign_id = str(record.get("campaign_id") or "")
    if phase == "review_handoff_emitted":
        active = load_active_campaign(trace_root)
        if active and str(active.get("campaign_type") or "") == "seam-walkback-review":
            active_campaign_id = str(active.get("campaign_id") or "")
            if record_campaign_id and record_campaign_id == active_campaign_id:
                active["child_review_handoff_path"] = record.get("path")
                active["child_review_handoff_family_ids"] = list(record.get("family_ids") or [])
                active["child_review_handoff_kind"] = record.get("kind")
                active["child_review_handoff_emitted_at_utc"] = str(
                    record.get("timestamp_utc") or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                )
                write_active_campaign(trace_root, active)
    if phase == "final_review":
        active = load_active_campaign(trace_root)
        if active:
            active_type = str(active.get("campaign_type") or "")
            active_campaign_id = str(active.get("campaign_id") or "")
            active_run_id = str(active.get("run_id") or active_campaign_id)
            if active_type == "review-orchestrator" and record_run_id == active_run_id:
                active_cleared = clear_active_campaign(trace_root, active_campaign_id)
            elif active_type == "seam-walkback-review" and record_campaign_id and record_campaign_id == active_campaign_id:
                active["child_final_review_run_id"] = record_run_id
                active["child_final_review_at_utc"] = str(record.get("timestamp_utc") or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
                active["child_final_verdict"] = record.get("final_verdict")
                review_handoff_path_value = record.get("review_handoff_path")
                if review_handoff_path_value:
                    active["child_review_handoff_path"] = review_handoff_path_value
                actionable_family_ids = record.get("actionable_family_ids")
                if isinstance(actionable_family_ids, list):
                    active["child_review_handoff_family_ids"] = [str(item) for item in actionable_family_ids]
                write_active_campaign(trace_root, active)

    print(
        json.dumps(
            {
                "trace_file": str(trace_file),
                "appended": True,
                "status": "ok",
                "active_campaign_cleared": active_cleared,
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


def non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def require_baseline_string(
    mapping: dict[str, Any],
    field: str,
    errors: list[str],
    prefix: str,
) -> str | None:
    value = mapping.get(field)
    if not non_empty_string(value):
        errors.append(f"{prefix} missing or invalid {field}")
        return None
    return str(value)


def require_baseline_string_list(
    mapping: dict[str, Any],
    field: str,
    errors: list[str],
    prefix: str,
    *,
    require_non_empty: bool = False,
) -> list[str]:
    value = mapping.get(field)
    if not isinstance(value, list):
        errors.append(f"{prefix} field {field} must be a list")
        return []
    result: list[str] = []
    for index, item in enumerate(value):
        if not non_empty_string(item):
            errors.append(f"{prefix}.{field}[{index}] must be a non-empty string")
            continue
        result.append(str(item))
    if require_non_empty and not result:
        errors.append(f"{prefix} field {field} must contain at least one entry")
    return result


def require_baseline_string_or_list(
    mapping: dict[str, Any],
    field: str,
    errors: list[str],
    prefix: str,
) -> list[str]:
    value = mapping.get(field)
    if isinstance(value, list):
        result = [str(item) for item in value if non_empty_string(item)]
        if not result:
            errors.append(f"{prefix}.{field} must contain at least one non-empty entry")
        return result
    if non_empty_string(value):
        return [str(value)]
    errors.append(f"{prefix}.{field} must be a non-empty string or list")
    return []


def validate_project_relative_pattern(value: str, errors: list[str], prefix: str) -> str:
    normalized = normalize_project_path(value)
    if not normalized:
        errors.append(f"{prefix} must not be empty")
        return normalized
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:/", normalized):
        errors.append(f"{prefix} must be project-relative, not absolute")
    if normalized.startswith("~"):
        errors.append(f"{prefix} must not use home-directory expansion")
    if any(part == ".." for part in normalized.split("/")):
        errors.append(f"{prefix} must not escape the project with '..'")
    return normalized


def project_pattern_exists(project_root: pathlib.Path, pattern: str) -> bool:
    if any(char in pattern for char in "*?["):
        matches = glob.glob(str(project_root / pattern), recursive=True)
        return any(pathlib.Path(match).exists() for match in matches)
    return (project_root / pattern).exists()


def validate_existing_project_patterns(
    patterns: list[str],
    project_root: pathlib.Path | None,
    errors: list[str],
    prefix: str,
    *,
    require_match: bool,
) -> None:
    for index, raw_pattern in enumerate(patterns):
        pattern = validate_project_relative_pattern(raw_pattern, errors, f"{prefix}[{index}]")
        if project_root is not None and require_match and pattern:
            if not project_pattern_exists(project_root, pattern):
                errors.append(f"{prefix}[{index}] {pattern!r} does not match any project path")


def validate_baseline_lenses(surface: dict[str, Any], errors: list[str], prefix: str) -> None:
    builtins = surface.get("configured_builtin_lenses")
    customs = surface.get("configured_custom_lenses")

    if not isinstance(builtins, list):
        errors.append(f"{prefix}.configured_builtin_lenses must be a list")
        builtins = []
    if not isinstance(customs, list):
        errors.append(f"{prefix}.configured_custom_lenses must be a list")
        customs = []

    usable_lens_count = 0
    for index, lens in enumerate(builtins):
        lens_prefix = f"{prefix}.configured_builtin_lenses[{index}]"
        if not isinstance(lens, dict):
            errors.append(f"{lens_prefix} must be a mapping")
            continue
        lens_id = require_baseline_string(lens, "lens_id", errors, lens_prefix)
        require_baseline_string(lens, "priority", errors, lens_prefix)
        if lens_id:
            usable_lens_count += 1
            if normalize_focus_token(lens_id) not in KNOWN_RUNTIME_FOCUS_TOKENS:
                errors.append(f"{lens_prefix}.lens_id {lens_id!r} is not a known built-in lens id")

    for index, lens in enumerate(customs):
        lens_prefix = f"{prefix}.configured_custom_lenses[{index}]"
        if not isinstance(lens, dict):
            errors.append(f"{lens_prefix} must be a mapping")
            continue
        required_fields = [
            "id",
            "name",
            "purpose",
            "what_to_look_for",
            "key_questions",
            "evidence_expectations",
            "priority",
        ]
        missing_required = False
        for field in required_fields:
            value = lens.get(field)
            if field in {"key_questions", "evidence_expectations"}:
                if not isinstance(value, list) or not any(non_empty_string(item) for item in value):
                    errors.append(f"{lens_prefix}.{field} must be a non-empty list of strings")
                    missing_required = True
            elif not non_empty_string(value):
                errors.append(f"{lens_prefix} missing or invalid {field}")
                missing_required = True
        if not missing_required:
            usable_lens_count += 1

    if usable_lens_count == 0:
        errors.append(f"{prefix} must configure at least one usable built-in or custom lens")


def validate_reviewer_model_recommendation(
    value: Any,
    errors: list[str],
    prefix: str,
) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        errors.append(f"{prefix} must be a mapping when present")
        return
    if "model" in value and not non_empty_string(value.get("model")):
        errors.append(f"{prefix}.model must be a non-empty string when present")
    if "reasoning_effort" in value and not non_empty_string(value.get("reasoning_effort")):
        errors.append(f"{prefix}.reasoning_effort must be a non-empty string when present")
    if "reason" in value and not non_empty_string(value.get("reason")):
        errors.append(f"{prefix}.reason must be a non-empty string when present")


def validate_alternative_entry(
    entry: Any,
    index: int,
    baseline_path: pathlib.Path,
    project_root: pathlib.Path | None,
    errors: list[str],
) -> None:
    prefix = f"alternative_baselines[{index}]"
    if not isinstance(entry, dict):
        errors.append(f"{prefix} must be a mapping")
        return

    alt_id = require_baseline_string(entry, "id", errors, prefix)
    alt_name = require_baseline_string(entry, "name", errors, prefix)
    alt_purpose = require_baseline_string(entry, "purpose", errors, prefix)
    raw_path = require_baseline_string(entry, "path", errors, prefix)
    entry_when_to_use = require_baseline_string_or_list(entry, "when_to_use", errors, prefix)

    if not raw_path:
        return
    normalized_path = validate_project_relative_pattern(raw_path, errors, f"{prefix}.path")
    if project_root is None:
        return

    alt_path = (project_root / normalized_path).resolve()
    if alt_path == baseline_path.resolve():
        errors.append(f"{prefix}.path must not point back to the primary baseline itself")
        return
    if not alt_path.exists():
        errors.append(f"{prefix}.path {normalized_path!r} does not exist")
        return

    try:
        alt_data = load_structured_mapping(alt_path)
    except SystemExit as exc:
        errors.append(f"{prefix}.path {normalized_path!r} is not parseable: {exc}")
        return

    alt_errors: list[str] = []
    validate_review_baseline_data(alt_data, alt_path, project_root, "variant", alt_errors)
    errors.extend(f"{prefix}.path {normalized_path!r}: {error}" for error in alt_errors)
    if alt_id and alt_data.get("variant_id") != alt_id:
        errors.append(
            f"{prefix}.id {alt_id!r} does not match variant_id {alt_data.get('variant_id')!r}"
        )
    if alt_name and alt_data.get("variant_name") != alt_name:
        errors.append(
            f"{prefix}.name {alt_name!r} does not match variant_name {alt_data.get('variant_name')!r}"
        )
    if alt_purpose and alt_data.get("variant_purpose") != alt_purpose:
        errors.append(
            f"{prefix}.purpose {alt_purpose!r} does not match variant_purpose {alt_data.get('variant_purpose')!r}"
        )
    alt_when_to_use = normalize_string_list(alt_data.get("variant_when_to_use"))
    if entry_when_to_use and alt_when_to_use and entry_when_to_use != alt_when_to_use:
        errors.append(f"{prefix}.when_to_use does not match variant_when_to_use")
    if alt_data.get("variant_strategy") == "derived":
        derived_from = alt_data.get("derived_from")
        if non_empty_string(derived_from):
            derived_path = (project_root / normalize_project_path(str(derived_from))).resolve()
            if derived_path != baseline_path.resolve():
                errors.append(f"{prefix}.derived_from does not resolve to this primary baseline")


def validate_baseline_surfaces(
    data: dict[str, Any],
    project_root: pathlib.Path | None,
    errors: list[str],
) -> list[str]:
    surfaces = data.get("surfaces")
    if not isinstance(surfaces, list) or not surfaces:
        errors.append("surfaces must be a non-empty list")
        return []

    surface_ids: list[str] = []
    seen_ids: set[str] = set()
    seen_names: set[str] = set()
    seen_primary_anchors: dict[str, str] = {}

    for index, surface in enumerate(surfaces):
        prefix = f"surfaces[{index}]"
        if not isinstance(surface, dict):
            errors.append(f"{prefix} must be a mapping")
            continue

        surface_id = require_baseline_string(surface, "id", errors, prefix)
        surface_name = require_baseline_string(surface, "name", errors, prefix)
        require_baseline_string(surface, "purpose", errors, prefix)

        if surface_id:
            normalized_id = normalize_focus_token(surface_id)
            surface_ids.append(surface_id)
            if normalized_id in seen_ids:
                errors.append(f"{prefix}.id {surface_id!r} duplicates another surface id")
            seen_ids.add(normalized_id)
        if surface_name:
            normalized_name = normalize_focus_token(surface_name)
            if normalized_name in seen_names:
                errors.append(f"{prefix}.name {surface_name!r} duplicates another surface name")
            seen_names.add(normalized_name)

        primary_anchors = require_baseline_string_list(
            surface, "primary_anchors", errors, prefix, require_non_empty=True
        )
        supporting_anchors = require_baseline_string_list(surface, "supporting_anchors", errors, prefix)
        contract_docs = require_baseline_string_list(surface, "contract_docs", errors, prefix)

        validate_existing_project_patterns(
            primary_anchors,
            project_root,
            errors,
            f"{prefix}.primary_anchors",
            require_match=True,
        )
        validate_existing_project_patterns(
            supporting_anchors,
            project_root,
            errors,
            f"{prefix}.supporting_anchors",
            require_match=True,
        )
        validate_existing_project_patterns(
            contract_docs,
            project_root,
            errors,
            f"{prefix}.contract_docs",
            require_match=True,
        )

        for anchor in primary_anchors:
            normalized_anchor = normalize_project_path(anchor)
            previous_surface = seen_primary_anchors.get(normalized_anchor)
            if previous_surface and previous_surface != (surface_id or prefix):
                errors.append(
                    f"{prefix}.primary_anchors contains {normalized_anchor!r}, already used by {previous_surface}"
                )
            seen_primary_anchors[normalized_anchor] = surface_id or prefix

        if "review_focus_areas" in surface:
            focus_areas = surface.get("review_focus_areas")
            if not isinstance(focus_areas, list):
                errors.append(f"{prefix}.review_focus_areas must be a list when present")
            else:
                for focus_index, focus_area in enumerate(focus_areas):
                    if not non_empty_string(focus_area):
                        errors.append(
                            f"{prefix}.review_focus_areas[{focus_index}] must be a non-empty string"
                        )

        validate_baseline_lenses(surface, errors, prefix)

    return surface_ids


def validate_primary_pointer_for_variant(
    variant_data: dict[str, Any],
    variant_path: pathlib.Path,
    primary_data: dict[str, Any],
    primary_path: pathlib.Path,
    project_root: pathlib.Path,
    errors: list[str],
) -> bool:
    alternatives = primary_data.get("alternative_baselines")
    if not isinstance(alternatives, list) or not alternatives:
        errors.append("primary_baseline has no alternative_baselines entry for this variant")
        return False

    variant_id = variant_data.get("variant_id")
    matching_entries: list[dict[str, Any]] = []
    for entry in alternatives:
        if not isinstance(entry, dict):
            continue
        raw_path = entry.get("path")
        path_matches = False
        if non_empty_string(raw_path):
            candidate = (project_root / normalize_project_path(str(raw_path))).resolve()
            path_matches = candidate == variant_path.resolve()
        id_matches = non_empty_string(variant_id) and entry.get("id") == variant_id
        if path_matches or id_matches:
            matching_entries.append(entry)

    if not matching_entries:
        errors.append("no primary alternative_baselines entry matches this variant path or variant_id")
        return False

    pointer_valid = True
    for index, entry in enumerate(matching_entries):
        prefix = f"primary_baseline.alternative_baselines match[{index}]"
        raw_path = entry.get("path")
        if non_empty_string(raw_path):
            candidate = (project_root / normalize_project_path(str(raw_path))).resolve()
            if candidate != variant_path.resolve():
                errors.append(f"{prefix}.path does not resolve to the validated variant baseline")
                pointer_valid = False
        if entry.get("id") != variant_data.get("variant_id"):
            errors.append(f"{prefix}.id does not match variant_id")
            pointer_valid = False
        if entry.get("name") != variant_data.get("variant_name"):
            errors.append(f"{prefix}.name does not match variant_name")
            pointer_valid = False
        if entry.get("purpose") != variant_data.get("variant_purpose"):
            errors.append(f"{prefix}.purpose does not match variant_purpose")
            pointer_valid = False

    if variant_data.get("variant_strategy") == "derived":
        derived_from = variant_data.get("derived_from")
        if non_empty_string(derived_from):
            derived_path = (project_root / normalize_project_path(str(derived_from))).resolve()
            if derived_path != primary_path.resolve():
                errors.append("variant derived_from does not resolve to the supplied primary_baseline")
                pointer_valid = False
    return pointer_valid


def validate_review_baseline_data(
    data: dict[str, Any],
    baseline_path: pathlib.Path,
    project_root: pathlib.Path | None,
    expect_kind: str,
    errors: list[str],
) -> dict[str, Any]:
    baseline_version = data.get("baseline_version")
    if baseline_version != 1:
        errors.append("baseline_version must be 1")
    require_baseline_string(data, "updated_at", errors, "baseline")

    declared_kind = data.get("baseline_kind")
    if declared_kind is None:
        effective_kind = "primary"
    elif non_empty_string(declared_kind):
        effective_kind = str(declared_kind)
        if effective_kind not in KNOWN_BASELINE_KINDS:
            errors.append(f"baseline_kind {effective_kind!r} must be one of primary, variant")
    else:
        effective_kind = "primary"
        errors.append("baseline_kind must be a non-empty string when present")

    if expect_kind not in BASELINE_EXPECT_KINDS:
        errors.append(f"expect_kind {expect_kind!r} is not supported")
    elif expect_kind != "any" and effective_kind != expect_kind:
        errors.append(f"expected baseline_kind {expect_kind!r}, got {effective_kind!r}")

    variant_fields = [
        "variant_id",
        "variant_name",
        "variant_purpose",
        "variant_when_to_use",
        "variant_strategy",
    ]
    if effective_kind == "variant":
        for field in variant_fields:
            if field == "variant_when_to_use":
                require_baseline_string_or_list(data, field, errors, "variant")
            else:
                require_baseline_string(data, field, errors, "variant")
        strategy = data.get("variant_strategy")
        if non_empty_string(strategy) and strategy not in KNOWN_VARIANT_STRATEGIES:
            errors.append("variant_strategy must be one of derived, fresh")
        if strategy == "derived":
            require_baseline_string(data, "derived_from", errors, "variant")
    elif any(field in data for field in variant_fields):
        errors.append("variant metadata is present but baseline_kind is not 'variant'")

    validate_reviewer_model_recommendation(
        data.get("reviewer_model_recommendation"),
        errors,
        "reviewer_model_recommendation",
    )

    alternative_baselines = data.get("alternative_baselines")
    alternative_count = 0
    if alternative_baselines is not None:
        if effective_kind == "variant":
            errors.append("variant baselines must be standalone and must not declare alternative_baselines")
        elif not isinstance(alternative_baselines, list):
            errors.append("alternative_baselines must be a list when present")
        else:
            alternative_count = len(alternative_baselines)
            for index, entry in enumerate(alternative_baselines):
                validate_alternative_entry(entry, index, baseline_path, project_root, errors)

    surface_ids = validate_baseline_surfaces(data, project_root, errors)
    return {
        "baseline_kind": effective_kind,
        "declared_baseline_kind": declared_kind,
        "surface_ids": surface_ids,
        "surface_count": len(surface_ids),
        "alternative_count": alternative_count,
        "variant_id": data.get("variant_id") if effective_kind == "variant" else None,
    }


def validate_review_baseline_command(args: argparse.Namespace) -> int:
    project_root = pathlib.Path(args.project_root).resolve() if args.project_root else None
    if project_root is not None:
        baseline_path = resolve_user_path(project_root, args.baseline).resolve()
    else:
        baseline_path = pathlib.Path(args.baseline).resolve()

    errors: list[str] = []
    warnings: list[str] = []
    summary: dict[str, Any] = {
        "mode": "review-baseline-validation",
        "baseline_path": str(baseline_path),
        "expect_kind": args.expect_kind,
    }
    if project_root is not None:
        summary["project_root"] = str(project_root)

    if not baseline_path.exists():
        errors.append(f"baseline path {str(baseline_path)!r} does not exist")
        summary["baseline_valid"] = False
        summary["errors"] = errors
        print(json.dumps(summary, indent=2, sort_keys=True))
        return 2

    try:
        data = load_structured_mapping(baseline_path)
    except SystemExit as exc:
        errors.append(str(exc))
        data = {}

    validation_summary: dict[str, Any] = {}
    if data:
        validation_summary = validate_review_baseline_data(
            data,
            baseline_path,
            project_root,
            args.expect_kind,
            errors,
        )
        summary.update(validation_summary)

    primary_pointer_valid: bool | None = None
    if args.primary_baseline:
        if project_root is None:
            primary_path = pathlib.Path(args.primary_baseline).resolve()
        else:
            primary_path = resolve_user_path(project_root, args.primary_baseline).resolve()
        summary["primary_baseline_path"] = str(primary_path)
        if not primary_path.exists():
            errors.append(f"primary_baseline path {str(primary_path)!r} does not exist")
            primary_pointer_valid = False
        else:
            try:
                primary_data = load_structured_mapping(primary_path)
                primary_errors: list[str] = []
                validate_review_baseline_data(
                    primary_data,
                    primary_path,
                    project_root,
                    "primary",
                    primary_errors,
                )
                errors.extend(f"primary_baseline: {error}" for error in primary_errors)
                if validation_summary.get("baseline_kind") == "variant":
                    primary_pointer_valid = validate_primary_pointer_for_variant(
                        data,
                        baseline_path,
                        primary_data,
                        primary_path,
                        project_root or primary_path.parent,
                        errors,
                    )
            except SystemExit as exc:
                errors.append(f"primary_baseline is not parseable: {exc}")
                primary_pointer_valid = False
    if primary_pointer_valid is not None:
        summary["primary_pointer_valid"] = primary_pointer_valid and not errors

    summary["baseline_valid"] = not errors
    if warnings:
        summary["warnings"] = warnings
    if errors:
        summary["errors"] = errors
        print(json.dumps(summary, indent=2, sort_keys=True))
        return 2
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


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
    init.add_argument("--project-root", default=".")
    init.add_argument("--mode", default="full-review")
    init.add_argument("--run-id")
    init.add_argument("--campaign-id")
    init.add_argument("--owner-host-session-id")
    init.add_argument("--owner-started-from-cwd")
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

    handoff_path = subparsers.add_parser(
        "handoff-path",
        help="Resolve the canonical review_handoff path inside an orchestrator run directory.",
    )
    handoff_path.add_argument("--trace-dir", required=True)
    handoff_path.set_defaults(func=handoff_path_cmd)

    write_handoff = subparsers.add_parser(
        "write-review-handoff",
        help="Persist a review_handoff to the canonical path inside an orchestrator run directory.",
    )
    write_handoff.add_argument("--trace-dir", required=True)
    write_handoff_group = write_handoff.add_mutually_exclusive_group(required=True)
    write_handoff_group.add_argument("--input-json")
    write_handoff_group.add_argument("--input-file")
    write_handoff.set_defaults(func=write_review_handoff)

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

    validate_packet = subparsers.add_parser(
        "validate-discovery-packet",
        help="Validate a seam-walk discovery packet before packet-driven orchestrator exploration.",
    )
    packet_group = validate_packet.add_mutually_exclusive_group(required=True)
    packet_group.add_argument("--packet-file")
    packet_group.add_argument("--packet-json")
    validate_packet.add_argument("--project-root")
    validate_packet.set_defaults(func=validate_discovery_packet_command)

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

    validate_baseline = subparsers.add_parser(
        "validate-review-baseline",
        help="Validate a primary or variant review baseline before review execution.",
    )
    validate_baseline.add_argument(
        "--project-root",
        default=".",
        help="Project root used to resolve project-relative anchors and baseline pointers.",
    )
    validate_baseline.add_argument(
        "--baseline",
        required=True,
        help="Path to the baseline YAML/JSON file, absolute or project-relative.",
    )
    validate_baseline.add_argument(
        "--expect-kind",
        choices=sorted(BASELINE_EXPECT_KINDS),
        default="any",
        help="Require a primary or variant baseline shape when the caller knows the mode.",
    )
    validate_baseline.add_argument(
        "--primary-baseline",
        help="Primary baseline path to check variant pointer and derived_from consistency.",
    )
    validate_baseline.set_defaults(func=validate_review_baseline_command)

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
