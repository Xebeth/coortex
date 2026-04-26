#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
from typing import Any

ALLOWED_HANDOFF_STATUSES = {"implemented", "blocked", "needs_continuation"}
CURRENT_WORK_ROOT = pathlib.Path(".coortex") / "current-work"


def emit(data: dict[str, Any], exit_code: int = 0) -> None:
    print(json.dumps(data, indent=2, sort_keys=True))
    raise SystemExit(exit_code)


def load_json_object(path: pathlib.Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path} is not valid JSON: {exc}") from exc
    except OSError as exc:
        raise ValueError(f"failed to read {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{path} did not parse to a JSON object")
    return data


def normalize_run_id(run_id: str) -> str:
    if not isinstance(run_id, str) or run_id.strip() == "":
        raise ValueError("run_id must be a non-empty string")
    if run_id != run_id.strip():
        raise ValueError("run_id must not contain leading or trailing whitespace")
    if os.path.isabs(run_id) or "/" in run_id or "\\" in run_id:
        raise ValueError("run_id must be one path segment")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", run_id):
        raise ValueError("run_id must contain only letters, numbers, dot, underscore, or hyphen")
    return run_id


def rel(path: pathlib.Path) -> str:
    return str(path)


def artifact_paths(run_id: str) -> dict[str, str]:
    run_id = normalize_run_id(run_id)
    trace_dir = CURRENT_WORK_ROOT / run_id
    return {
        "trace_dir": rel(trace_dir),
        "packet_path": rel(trace_dir / "packet.json"),
        "spec_review_path": rel(trace_dir / "spec-review-output.json"),
        "implementation_handoff_path": rel(trace_dir / "implementation-handoff.json"),
        "return_review_path": rel(trace_dir / "return-review-output.json"),
        "closeout_path": rel(trace_dir / "closeout.json"),
        "gate_dir": rel(trace_dir / "gates"),
    }


def is_non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def is_present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    if isinstance(value, list):
        return len(value) > 0
    if isinstance(value, dict):
        return len(value) > 0
    return True


def is_string_list(value: Any, *, allow_empty: bool) -> bool:
    if not isinstance(value, list):
        return False
    if not allow_empty and len(value) == 0:
        return False
    return all(is_non_empty_string(item) for item in value)


def require_mapping(container: dict[str, Any], key: str, errors: list[str]) -> dict[str, Any] | None:
    value = container.get(key)
    if not isinstance(value, dict):
        errors.append(f"{key} must be an object")
        return None
    return value


def require_non_empty(container: dict[str, Any], key: str, errors: list[str]) -> None:
    if key not in container:
        errors.append(f"{key} is required")
    elif not is_present(container.get(key)):
        errors.append(f"{key} must not be empty")


def packet_row_ids(packet: dict[str, Any]) -> list[str]:
    root = packet.get("mini_surface_review_packet")
    if not isinstance(root, dict):
        raise ValueError("packet must contain mini_surface_review_packet")
    matrix = root.get("coverage_matrix")
    if not isinstance(matrix, dict):
        raise ValueError("packet must contain coverage_matrix")
    rows = matrix.get("rows")
    if not isinstance(rows, list):
        raise ValueError("packet coverage_matrix.rows must be a list")
    row_ids: list[str] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or not is_non_empty_string(row.get("row_id")):
            raise ValueError(f"packet coverage row {index} must have a row_id")
        row_ids.append(row["row_id"])
    return row_ids


def validate_handoff_data(data: dict[str, Any], packet: dict[str, Any] | None = None) -> dict[str, Any]:
    errors: list[str] = []
    handoff = data.get("implementation_handoff")
    if not isinstance(handoff, dict):
        return {
            "valid": False,
            "errors": ["implementation_handoff object is required"],
            "status": None,
            "coverage_row_ids": [],
        }

    for key in ["packet_path", "slice_id", "owning_seam"]:
        if not is_non_empty_string(handoff.get(key)):
            errors.append(f"implementation_handoff.{key} must be a non-empty string")

    status = handoff.get("status")
    if status not in ALLOWED_HANDOFF_STATUSES:
        errors.append(
            "implementation_handoff.status must be one of "
            + ", ".join(sorted(ALLOWED_HANDOFF_STATUSES))
        )

    if not is_string_list(handoff.get("changed_files"), allow_empty=False):
        errors.append("implementation_handoff.changed_files must be a non-empty string list")

    scope = require_mapping(handoff, "scope_evidence", errors)
    if scope is not None:
        if not isinstance(scope.get("inside_packet_scope"), bool):
            errors.append("implementation_handoff.scope_evidence.inside_packet_scope must be a boolean")
        if "out_of_scope_changes" not in scope:
            errors.append("implementation_handoff.scope_evidence.out_of_scope_changes is required")

    verification = require_mapping(handoff, "verification", errors)
    if verification is not None:
        for key in [
            "build_or_typecheck",
            "local_quality_gates",
            "targeted_tests",
            "broader_tests_if_required",
        ]:
            require_non_empty(verification, key, errors)

    for key in ["self_deslop", "self_review", "deferred_threads", "residual_risks"]:
        require_non_empty(handoff, key, errors)

    coverage = handoff.get("coverage_row_evidence")
    evidence_row_ids: list[str] = []
    if not isinstance(coverage, list) or len(coverage) == 0:
        errors.append("implementation_handoff.coverage_row_evidence must be a non-empty list")
    else:
        seen: set[str] = set()
        for index, row in enumerate(coverage):
            prefix = f"implementation_handoff.coverage_row_evidence[{index}]"
            if not isinstance(row, dict):
                errors.append(f"{prefix} must be an object")
                continue
            row_id = row.get("row_id")
            if not is_non_empty_string(row_id):
                errors.append(f"{prefix}.row_id must be a non-empty string")
            else:
                if row_id in seen:
                    errors.append(f"duplicate coverage row evidence for {row_id}")
                seen.add(row_id)
                evidence_row_ids.append(row_id)
            for key in ["evidence", "gaps"]:
                require_non_empty(row, key, errors)

    expected_row_ids: list[str] = []
    if packet is not None:
        try:
            expected_row_ids = packet_row_ids(packet)
        except ValueError as exc:
            errors.append(str(exc))
        else:
            expected = set(expected_row_ids)
            actual = set(evidence_row_ids)
            missing = sorted(expected - actual)
            unknown = sorted(actual - expected)
            if missing:
                errors.append("missing coverage row evidence: " + ", ".join(missing))
            if unknown:
                errors.append("unknown coverage row evidence: " + ", ".join(unknown))

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "status": status if isinstance(status, str) else None,
        "coverage_row_ids": evidence_row_ids,
        "expected_coverage_row_ids": expected_row_ids,
    }


def validate_closeout_data(data: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    closeout = data.get("closeout_report")
    if not isinstance(closeout, dict):
        return {"valid": False, "errors": ["closeout_report object is required"]}

    for key in ["produced_artifacts", "explicit_claims", "evidence"]:
        if not is_string_list(closeout.get(key), allow_empty=False):
            errors.append(f"closeout_report.{key} must be a non-empty string list")

    for key in ["continuation_rounds", "residual_risks"]:
        if not is_string_list(closeout.get(key), allow_empty=True):
            errors.append(f"closeout_report.{key} must be a string list")

    for key in ["first_ready_point", "commit_or_install_disposition"]:
        if not is_non_empty_string(closeout.get(key)):
            errors.append(f"closeout_report.{key} must be a non-empty string")

    return {"valid": len(errors) == 0, "errors": errors}


def command_paths(args: argparse.Namespace) -> None:
    project_root = pathlib.Path(args.project_root).resolve()
    try:
        run_id = normalize_run_id(args.run_id)
    except ValueError as exc:
        emit({"valid": False, "errors": [str(exc)]}, 1)
    paths = artifact_paths(run_id)
    emit({"run_id": run_id, "project_root": str(project_root), **paths})


def command_validate_handoff(args: argparse.Namespace) -> None:
    try:
        handoff_data = load_json_object(pathlib.Path(args.handoff_file))
        packet_data = load_json_object(pathlib.Path(args.packet_file)) if args.packet_file else None
    except ValueError as exc:
        emit({"valid": False, "errors": [str(exc)]}, 1)
    result = validate_handoff_data(handoff_data, packet_data)
    emit(result, 0 if result["valid"] else 1)


def command_validate_closeout(args: argparse.Namespace) -> None:
    try:
        closeout_data = load_json_object(pathlib.Path(args.closeout_file))
    except ValueError as exc:
        emit({"valid": False, "errors": [str(exc)]}, 1)
    result = validate_closeout_data(closeout_data)
    emit(result, 0 if result["valid"] else 1)


def command_write_closeout(args: argparse.Namespace) -> None:
    try:
        run_id = normalize_run_id(args.run_id)
        closeout_data = load_json_object(pathlib.Path(args.input))
    except ValueError as exc:
        emit({"valid": False, "written": False, "errors": [str(exc)]}, 1)
    result = validate_closeout_data(closeout_data)
    if not result["valid"]:
        emit({"written": False, **result}, 1)

    project_root = pathlib.Path(args.project_root).resolve()
    paths = artifact_paths(run_id)
    output_path = project_root / paths["closeout_path"]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(closeout_data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    emit({"valid": True, "written": True, "path": paths["closeout_path"]})


def install_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Implementation-coordinator current-work artifact helper"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    paths_parser = subparsers.add_parser("paths", help="emit canonical current-work artifact paths")
    paths_parser.add_argument("--project-root", default=".")
    paths_parser.add_argument("--run-id", required=True)
    paths_parser.set_defaults(func=command_paths)

    handoff_parser = subparsers.add_parser(
        "validate-handoff", help="validate an implementation_handoff artifact"
    )
    handoff_parser.add_argument("--handoff-file", required=True)
    handoff_parser.add_argument("--packet-file")
    handoff_parser.set_defaults(func=command_validate_handoff)

    closeout_parser = subparsers.add_parser(
        "validate-closeout", help="validate a closeout_report artifact"
    )
    closeout_parser.add_argument("--closeout-file", required=True)
    closeout_parser.set_defaults(func=command_validate_closeout)

    write_closeout_parser = subparsers.add_parser(
        "write-closeout", help="validate and write closeout_report to the canonical path"
    )
    write_closeout_parser.add_argument("--project-root", default=".")
    write_closeout_parser.add_argument("--run-id", required=True)
    write_closeout_parser.add_argument("--input", required=True)
    write_closeout_parser.set_defaults(func=command_write_closeout)

    return parser


def main() -> None:
    parser = install_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
