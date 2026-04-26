#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ACTIVE_CAMPAIGN_FILE = "active-review-campaign.json"
BLOCKING_CAMPAIGN_TYPES = {
    "fixer-orchestrator",
    "review-orchestrator",
    "seam-walkback-review",
}
CURRENT_WORK_PACKET_ROOT = "mini_surface_review_packet"
SUPPORTED_CURRENT_WORK_PACKET_VERSION = 1
CURRENT_WORK_ROW_CATEGORIES = {
    "entry_path",
    "terminal_path",
    "state_transition",
    "async_race_window",
    "ownership_drop_point",
    "failure_path",
    "sibling_manifestation",
    "test_row",
}
CURRENT_WORK_ROW_STATUSES = {
    "planned",
    "checked",
    "fixed",
    "tested",
    "open",
    "deferred",
    "uncertain",
    "not_applicable",
}
APPROVAL_VERDICTS = {"approve", "approved", "pass"}


def resolve_trace_root(project_root: Path, raw_trace_root: str) -> Path:
    trace_root = Path(raw_trace_root)
    if trace_root.is_absolute():
        return trace_root.resolve()
    return (project_root / trace_root).resolve()


def load_active_campaign(trace_root: Path) -> dict[str, Any] | None:
    path = trace_root / ACTIVE_CAMPAIGN_FILE
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else None


def load_json_object(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path} did not parse to a mapping")
    return data


def parse_json_object(raw: str) -> dict[str, Any]:
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise SystemExit("JSON input must be a mapping")
    return data


def unwrap_packet(data: dict[str, Any]) -> dict[str, Any]:
    value = data.get(CURRENT_WORK_PACKET_ROOT)
    if isinstance(value, dict):
        return value
    return data


def require_string(value: Any, field: str, errors: list[str], prefix: str) -> str | None:
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{prefix}.{field} must be a non-empty string")
        return None
    return value


def require_bool(value: Any, field: str, errors: list[str], prefix: str) -> bool | None:
    if not isinstance(value, bool):
        errors.append(f"{prefix}.{field} must be a boolean")
        return None
    return value


def string_list(
    value: Any,
    field: str,
    errors: list[str],
    prefix: str,
    *,
    required: bool,
    allow_empty: bool,
) -> list[str] | None:
    if value is None:
        if required:
            errors.append(f"{prefix}.{field} must be a list")
        return None
    if not isinstance(value, list):
        errors.append(f"{prefix}.{field} must be a list")
        return None
    if not allow_empty and not value:
        errors.append(f"{prefix}.{field} must not be empty")
    result: list[str] = []
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            errors.append(f"{prefix}.{field}[{index}] must be a non-empty string")
            continue
        result.append(item)
    return result


def validate_current_work_surface(surface: Any, errors: list[str]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    if not isinstance(surface, dict):
        errors.append("packet.surface must be a mapping")
        return summary

    surface_id = require_string(surface.get("id"), "id", errors, "packet.surface")
    require_string(surface.get("name"), "name", errors, "packet.surface")
    require_string(surface.get("purpose"), "purpose", errors, "packet.surface")
    primary_anchors = string_list(
        surface.get("primary_anchors"),
        "primary_anchors",
        errors,
        "packet.surface",
        required=True,
        allow_empty=False,
    )
    string_list(
        surface.get("supporting_anchors"),
        "supporting_anchors",
        errors,
        "packet.surface",
        required=False,
        allow_empty=True,
    )
    string_list(
        surface.get("contract_docs"),
        "contract_docs",
        errors,
        "packet.surface",
        required=False,
        allow_empty=True,
    )
    string_list(
        surface.get("review_focus_areas"),
        "review_focus_areas",
        errors,
        "packet.surface",
        required=False,
        allow_empty=True,
    )

    if surface_id is not None:
        summary["surface_id"] = surface_id
    if primary_anchors is not None:
        summary["primary_anchor_count"] = len(primary_anchors)
    return summary


def validate_current_work_boundary(boundary: Any, errors: list[str]) -> None:
    if not isinstance(boundary, dict):
        errors.append("packet.review_boundary must be a mapping")
        return
    string_list(
        boundary.get("in_scope_paths"),
        "in_scope_paths",
        errors,
        "packet.review_boundary",
        required=True,
        allow_empty=False,
    )
    string_list(
        boundary.get("expected_write_set"),
        "expected_write_set",
        errors,
        "packet.review_boundary",
        required=True,
        allow_empty=True,
    )
    string_list(
        boundary.get("out_of_scope"),
        "out_of_scope",
        errors,
        "packet.review_boundary",
        required=True,
        allow_empty=True,
    )


def validate_current_work_seams(seams: Any, errors: list[str]) -> None:
    if not isinstance(seams, list) or not seams:
        errors.append("packet.seams must be a non-empty list")
        return
    for index, seam in enumerate(seams):
        prefix = f"packet.seams[{index}]"
        if not isinstance(seam, dict):
            errors.append(f"{prefix} must be a mapping")
            continue
        require_string(seam.get("path"), "path", errors, prefix)
        require_string(seam.get("role"), "role", errors, prefix)


def validate_current_work_rows(rows: Any, errors: list[str]) -> list[str]:
    if not isinstance(rows, list) or not rows:
        errors.append("packet.coverage_matrix.rows must be a non-empty list")
        return []

    row_ids: list[str] = []
    seen: set[str] = set()
    for index, row in enumerate(rows):
        prefix = f"packet.coverage_matrix.rows[{index}]"
        if not isinstance(row, dict):
            errors.append(f"{prefix} must be a mapping")
            continue

        row_id = require_string(row.get("row_id"), "row_id", errors, prefix)
        if row_id is not None:
            if row_id in seen:
                errors.append(f"{prefix}.row_id {row_id!r} must be unique")
            seen.add(row_id)
            row_ids.append(row_id)

        category = require_string(row.get("category"), "category", errors, prefix)
        if category is not None and category not in CURRENT_WORK_ROW_CATEGORIES:
            errors.append(f"{prefix}.category must be one of {sorted(CURRENT_WORK_ROW_CATEGORIES)}")

        string_list(row.get("paths"), "paths", errors, prefix, required=True, allow_empty=False)
        require_string(row.get("expected_behavior"), "expected_behavior", errors, prefix)
        status = require_string(row.get("status"), "status", errors, prefix)
        if status is not None and status not in CURRENT_WORK_ROW_STATUSES:
            errors.append(f"{prefix}.status must be one of {sorted(CURRENT_WORK_ROW_STATUSES)}")
        string_list(row.get("tests"), "tests", errors, prefix, required=True, allow_empty=True)
        require_string(row.get("notes"), "notes", errors, prefix)
    return row_ids


def validate_current_work_packet_data(data: dict[str, Any]) -> tuple[list[str], dict[str, Any]]:
    packet = unwrap_packet(data)
    errors: list[str] = []
    summary: dict[str, Any] = {}

    if packet.get("packet_version") != SUPPORTED_CURRENT_WORK_PACKET_VERSION:
        errors.append(f"packet.packet_version must be {SUPPORTED_CURRENT_WORK_PACKET_VERSION}")
    packet_id = require_string(packet.get("packet_id"), "packet_id", errors, "packet")
    require_string(packet.get("status"), "status", errors, "packet")
    require_string(packet.get("source"), "source", errors, "packet")
    require_string(packet.get("intent"), "intent", errors, "packet")

    refs = string_list(
        packet.get("baseline_surface_refs"),
        "baseline_surface_refs",
        errors,
        "packet",
        required=False,
        allow_empty=True,
    ) or []
    if len(refs) > 1:
        require_string(packet.get("cross_surface_reason"), "cross_surface_reason", errors, "packet")

    summary.update(validate_current_work_surface(packet.get("surface"), errors))
    validate_current_work_boundary(packet.get("review_boundary"), errors)
    validate_current_work_seams(packet.get("seams"), errors)
    string_list(packet.get("invariants"), "invariants", errors, "packet", required=True, allow_empty=False)
    string_list(packet.get("reviewer_focus"), "reviewer_focus", errors, "packet", required=False, allow_empty=True)
    string_list(
        packet.get("known_uncertainties"),
        "known_uncertainties",
        errors,
        "packet",
        required=False,
        allow_empty=True,
    )

    coverage_matrix = packet.get("coverage_matrix")
    if not isinstance(coverage_matrix, dict):
        errors.append("packet.coverage_matrix must be a mapping")
        row_ids: list[str] = []
    else:
        row_ids = validate_current_work_rows(coverage_matrix.get("rows"), errors)

    if packet_id is not None:
        summary["packet_id"] = packet_id
    summary["baseline_surface_refs"] = refs
    summary["row_ids"] = row_ids
    summary["row_count"] = len(row_ids)
    return errors, summary


def load_current_work_packet_from_args(args: argparse.Namespace) -> dict[str, Any]:
    if args.packet_json:
        return parse_json_object(args.packet_json)
    return load_json_object(Path(args.packet_file))


def validate_current_work_packet(args: argparse.Namespace) -> int:
    data = load_current_work_packet_from_args(args)
    errors, summary = validate_current_work_packet_data(data)
    if errors:
        print(json.dumps({"valid": False, "errors": errors, **summary}, indent=2, sort_keys=True))
        return 2
    print(json.dumps({"valid": True, **summary}, indent=2, sort_keys=True))
    return 0


def validate_unique_row_refs(value: list[str] | None, field: str, errors: list[str], known_rows: set[str]) -> set[str]:
    refs: set[str] = set()
    if value is None:
        return refs
    seen: set[str] = set()
    for row_id in value:
        if row_id in seen:
            errors.append(f"surface_checked.matrix_checked.{field} contains duplicate row id {row_id!r}")
        seen.add(row_id)
        refs.add(row_id)
        if known_rows and row_id not in known_rows:
            errors.append(f"surface_checked.matrix_checked.{field} references unknown row id {row_id!r}")
    return refs


def validate_matrix_not_applicable(value: Any, errors: list[str]) -> None:
    if not isinstance(value, dict):
        errors.append("matrix_not_applicable must be a mapping")
        return
    require_string(value.get("reason"), "reason", errors, "matrix_not_applicable")
    string_list(
        value.get("checked_paths"),
        "checked_paths",
        errors,
        "matrix_not_applicable",
        required=True,
        allow_empty=False,
    )
    require_string(value.get("residual_risk"), "residual_risk", errors, "matrix_not_applicable")


def validate_surface_checked(value: Any, errors: list[str], packet_summary: dict[str, Any] | None) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    if not isinstance(value, dict):
        errors.append("surface_checked must be a mapping")
        return summary

    packet_id = require_string(value.get("packet_id"), "packet_id", errors, "surface_checked")
    require_bool(value.get("review_boundary_respected"), "review_boundary_respected", errors, "surface_checked")
    accounted = string_list(
        value.get("packet_rows_accounted_for"),
        "packet_rows_accounted_for",
        errors,
        "surface_checked",
        required=True,
        allow_empty=True,
    ) or []
    if len(set(accounted)) != len(accounted):
        errors.append("surface_checked.packet_rows_accounted_for must not contain duplicate row ids")
    string_list(
        value.get("sibling_scope_checked"),
        "sibling_scope_checked",
        errors,
        "surface_checked",
        required=True,
        allow_empty=True,
    )
    verdict = require_string(value.get("verdict"), "verdict", errors, "surface_checked")

    matrix = value.get("matrix_checked")
    if not isinstance(matrix, dict):
        errors.append("surface_checked.matrix_checked must be a mapping")
        matrix = {}

    known_rows = set(packet_summary.get("row_ids", [])) if packet_summary is not None else set()
    rows_checked = string_list(
        matrix.get("rows_checked"),
        "rows_checked",
        errors,
        "surface_checked.matrix_checked",
        required=True,
        allow_empty=True,
    )
    rows_closed = string_list(
        matrix.get("rows_closed"),
        "rows_closed",
        errors,
        "surface_checked.matrix_checked",
        required=True,
        allow_empty=True,
    )
    rows_open = string_list(
        matrix.get("rows_open"),
        "rows_open",
        errors,
        "surface_checked.matrix_checked",
        required=True,
        allow_empty=True,
    )
    rows_deferred = string_list(
        matrix.get("rows_deferred"),
        "rows_deferred",
        errors,
        "surface_checked.matrix_checked",
        required=True,
        allow_empty=True,
    )
    rows_uncertain = string_list(
        matrix.get("rows_uncertain"),
        "rows_uncertain",
        errors,
        "surface_checked.matrix_checked",
        required=True,
        allow_empty=True,
    )
    string_list(
        matrix.get("test_coverage_gaps"),
        "test_coverage_gaps",
        errors,
        "surface_checked.matrix_checked",
        required=True,
        allow_empty=True,
    )

    for field, values in {
        "rows_checked": rows_checked,
        "rows_closed": rows_closed,
        "rows_open": rows_open,
        "rows_deferred": rows_deferred,
        "rows_uncertain": rows_uncertain,
    }.items():
        validate_unique_row_refs(values, field, errors, known_rows)

    disposition_buckets = {
        "rows_closed": set(rows_closed or []),
        "rows_open": set(rows_open or []),
        "rows_deferred": set(rows_deferred or []),
        "rows_uncertain": set(rows_uncertain or []),
    }
    dispositioned_rows: set[str] = set().union(*disposition_buckets.values())
    bucket_names = list(disposition_buckets)
    for left_index, left_name in enumerate(bucket_names):
        for right_name in bucket_names[left_index + 1:]:
            overlap = sorted(disposition_buckets[left_name] & disposition_buckets[right_name])
            if overlap:
                errors.append(
                    f"surface_checked.matrix_checked row ids cannot appear in both {left_name} and {right_name}: {overlap}"
                )

    accounted_rows = set(accounted)
    if known_rows:
        unknown_accounted = sorted(accounted_rows - known_rows)
        if unknown_accounted:
            errors.append(f"surface_checked.packet_rows_accounted_for references unknown row ids: {unknown_accounted}")
        missing = sorted(known_rows - accounted_rows)
        if missing:
            errors.append(f"surface_checked.packet_rows_accounted_for is missing packet row ids: {missing}")
    missing_disposition = sorted(accounted_rows - dispositioned_rows)
    if missing_disposition:
        errors.append(f"surface_checked.matrix_checked does not disposition accounted row ids: {missing_disposition}")

    if packet_summary is not None and packet_id is not None and packet_id != packet_summary.get("packet_id"):
        errors.append("surface_checked.packet_id does not match the current-work packet")
    if verdict is not None and verdict.strip().lower() in APPROVAL_VERDICTS:
        if rows_open:
            errors.append("surface_checked verdict approve cannot leave rows_open")
        if rows_uncertain:
            errors.append("surface_checked verdict approve cannot leave rows_uncertain")

    summary["packet_id"] = packet_id
    summary["verdict"] = verdict
    summary["accounted_row_count"] = len(accounted)
    return summary


def validate_current_work_review_output_data(
    data: dict[str, Any],
    packet_summary: dict[str, Any] | None,
) -> tuple[list[str], dict[str, Any]]:
    errors: list[str] = []
    summary: dict[str, Any] = {}

    has_surface_checked = "surface_checked" in data
    has_not_applicable = "matrix_not_applicable" in data
    if has_surface_checked == has_not_applicable:
        errors.append("review output must include exactly one of surface_checked or matrix_not_applicable")
        return errors, summary

    if has_not_applicable:
        if packet_summary is not None:
            errors.append("matrix_not_applicable cannot be used when a current-work packet is supplied")
        validate_matrix_not_applicable(data.get("matrix_not_applicable"), errors)
        summary["output_kind"] = "matrix_not_applicable"
    else:
        summary.update(validate_surface_checked(data.get("surface_checked"), errors, packet_summary))
        summary["output_kind"] = "surface_checked"

    return errors, summary


def load_review_output_from_args(args: argparse.Namespace) -> dict[str, Any]:
    if args.review_output_json:
        return parse_json_object(args.review_output_json)
    return load_json_object(Path(args.review_output_file))


def validate_current_work_review_output(args: argparse.Namespace) -> int:
    review_output = load_review_output_from_args(args)
    packet_summary: dict[str, Any] | None = None
    if args.packet_file or args.packet_json:
        packet = load_current_work_packet_from_args(args)
        packet_errors, packet_summary = validate_current_work_packet_data(packet)
        if packet_errors:
            print(
                json.dumps(
                    {
                        "valid": False,
                        "errors": [f"packet invalid: {error}" for error in packet_errors],
                        **(packet_summary or {}),
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
            return 2

    errors, summary = validate_current_work_review_output_data(review_output, packet_summary)
    if errors:
        print(json.dumps({"valid": False, "errors": errors, **summary}, indent=2, sort_keys=True))
        return 2
    print(json.dumps({"valid": True, **summary}, indent=2, sort_keys=True))
    return 0


def check_active_campaign(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root).resolve()
    trace_root = resolve_trace_root(project_root, args.trace_root)
    active = load_active_campaign(trace_root)

    if not active or str(active.get("state") or "") != "active":
        print(
            json.dumps(
                {
                    "project_root": str(project_root),
                    "trace_root": str(trace_root),
                    "standalone_review_allowed": True,
                    "reason": "no-active-review-campaign",
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0

    campaign_type = str(active.get("campaign_type") or "")
    allowed = campaign_type not in BLOCKING_CAMPAIGN_TYPES
    reason = "active-top-level-review-campaign" if not allowed else "active-campaign-not-blocking"
    print(
        json.dumps(
            {
                "project_root": str(project_root),
                "trace_root": str(trace_root),
                "standalone_review_allowed": allowed,
                "reason": reason,
                "active_campaign": active,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0 if allowed else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Deterministic helper for coortex-review campaign-lock checks.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    check = subparsers.add_parser(
        "check-active-campaign",
        help="Report whether standalone coortex-review is allowed in this worktree right now.",
    )
    check.add_argument("--project-root", default=".")
    check.add_argument("--trace-root", default=".coortex/review-trace")
    check.set_defaults(func=check_active_campaign)

    current_work_packet = subparsers.add_parser(
        "validate-current-work-packet",
        help="Validate a current-work mini-surface review packet.",
    )
    packet_group = current_work_packet.add_mutually_exclusive_group(required=True)
    packet_group.add_argument("--packet-file")
    packet_group.add_argument("--packet-json")
    current_work_packet.set_defaults(func=validate_current_work_packet)

    current_work_output = subparsers.add_parser(
        "validate-current-work-review-output",
        help="Validate reviewer output for a current-work mini-surface packet.",
    )
    output_group = current_work_output.add_mutually_exclusive_group(required=True)
    output_group.add_argument("--review-output-file")
    output_group.add_argument("--review-output-json")
    packet_input = current_work_output.add_mutually_exclusive_group(required=False)
    packet_input.add_argument("--packet-file")
    packet_input.add_argument("--packet-json")
    current_work_output.set_defaults(func=validate_current_work_review_output)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
