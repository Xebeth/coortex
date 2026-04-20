#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any


GATE_SPEC_PATTERN = re.compile(r"^(?P<label>[^\[\]]+?)(?:\[expect=(?P<expect>[^\]]+)\])?$")


def read_scope_file(path: Path) -> list[str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    values: list[str] = []
    for line in lines:
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#"):
            continue
        values.append(trimmed)
    return values


def resolve_input_path(value: str, project_root: Path) -> Path:
    candidate = Path(value)
    if candidate.is_absolute():
        return candidate.resolve()
    return (project_root / candidate).resolve()


def normalize_path(value: str, project_root: Path) -> str:
    raw = Path(value)
    if raw.is_absolute():
        resolved = raw.resolve()
    else:
        resolved = (project_root / raw).resolve()
    try:
        relative = resolved.relative_to(project_root.resolve())
    except ValueError as exc:
        raise SystemExit(f"Path escapes project root: {value}") from exc
    return relative.as_posix()


def resolve_scope(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root).resolve()
    collected: list[str] = []
    for path in args.path:
        collected.append(path)
    for scope_file in args.changed_files_path:
        collected.extend(read_scope_file(resolve_input_path(scope_file, project_root)))

    normalized: list[str] = []
    seen: set[str] = set()
    for item in collected:
        value = normalize_path(item, project_root)
        if value in seen:
            continue
        seen.add(value)
        normalized.append(value)

    print(json.dumps({
        "project_root": str(project_root),
        "scope_files": normalized,
        "file_count": len(normalized),
    }, indent=2))
    return 0


def sanitize_label(label: str, index: int) -> str:
    safe = "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in label.strip().lower())
    safe = safe.strip("-") or f"gate-{index}"
    return safe


def parse_gate_spec(raw: str) -> tuple[str, set[int], str]:
    if "::" not in raw:
        raise SystemExit(f"Invalid gate spec (expected label::command): {raw}")
    raw_label, command = raw.split("::", 1)
    command = command.strip()
    if not command:
        raise SystemExit(f"Invalid gate spec (missing command): {raw}")

    match = GATE_SPEC_PATTERN.fullmatch(raw_label.strip())
    if match is None:
        raise SystemExit(f"Invalid gate label spec: {raw_label}")

    label = match.group("label").strip()
    if not label:
        raise SystemExit(f"Invalid gate spec (missing label): {raw}")

    expected_text = match.group("expect")
    if expected_text is None:
        expected_codes = {0}
    else:
        expected_codes = set()
        for item in expected_text.split(","):
            trimmed = item.strip()
            if not trimmed:
                raise SystemExit(f"Invalid expect list in gate spec: {raw}")
            try:
                expected_codes.add(int(trimmed))
            except ValueError as exc:
                raise SystemExit(f"Invalid expect code {trimmed!r} in gate spec: {raw}") from exc
        if not expected_codes:
            raise SystemExit(f"Invalid expect list in gate spec: {raw}")

    return label, expected_codes, command


def run_gates(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root).resolve()
    artifact_dir = resolve_input_path(args.artifact_dir, project_root) if args.artifact_dir else None
    if not args.gate:
        raise SystemExit("At least one --gate label::command pair is required.")
    if artifact_dir is not None:
        artifact_dir.mkdir(parents=True, exist_ok=True)

    results: list[dict[str, Any]] = []
    all_passed = True
    for index, gate in enumerate(args.gate, start=1):
        label, expected_codes, command = parse_gate_spec(gate)
        completed = subprocess.run(
            command,
            cwd=project_root,
            shell=True,
            capture_output=True,
            text=True,
        )
        log_path = None
        if artifact_dir is not None:
            filename = sanitize_label(label, index) + ".log"
            log_file = artifact_dir / filename
            log_file.write_text(
                f"$ {command}\n\n[stdout]\n{completed.stdout}\n\n[stderr]\n{completed.stderr}",
                encoding="utf-8",
            )
            log_path = str(log_file)
        ok = completed.returncode in expected_codes
        all_passed = all_passed and ok
        results.append({
            "label": label,
            "command": command,
            "expected_exit_codes": sorted(expected_codes),
            "exit_code": completed.returncode,
            "ok": ok,
            "log_path": log_path,
        })
        if args.stop_on_failure and not ok:
            break

    print(json.dumps({
        "project_root": str(project_root),
        "artifact_dir": str(artifact_dir) if artifact_dir is not None else None,
        "all_passed": all_passed,
        "gates": results,
    }, indent=2))
    return 0 if all_passed else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Deterministic helpers for bounded anti-slop cleanup.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    resolve_parser = subparsers.add_parser("resolve-scope", help="Normalize explicit paths or a changed-files artifact into a bounded repo-relative scope.")
    resolve_parser.add_argument("--project-root", default=".")
    resolve_parser.add_argument("--changed-files-path", action="append", default=[])
    resolve_parser.add_argument("--path", action="append", default=[])
    resolve_parser.set_defaults(func=resolve_scope)

    gates_parser = subparsers.add_parser("run-gates", help="Run verification commands deterministically and capture their results.")
    gates_parser.add_argument("--project-root", default=".")
    gates_parser.add_argument("--artifact-dir")
    gates_parser.add_argument("--gate", action="append", default=[])
    gates_parser.add_argument("--stop-on-failure", action="store_true")
    gates_parser.set_defaults(func=run_gates)

    return parser


if __name__ == "__main__":
    parser = build_parser()
    ns = parser.parse_args()
    raise SystemExit(ns.func(ns))
