#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
from pathlib import Path
from typing import Any


KNOWN_TRACE_PHASES: dict[str, dict[str, str]] = {
    "trace_started": {},
    "archaeology_cluster": {
        "cluster_id": "string",
        "scope_summary": "string",
        "pivot_commits": "list",
    },
    "seam_selection": {
        "seam_id": "string",
        "reason": "string",
    },
    "baseline_action": {
        "action": "string",
    },
    "review_step": {
        "review_skill": "string",
        "scope_summary": "string",
    },
    "repair_step": {
        "owning_seam": "string",
        "write_set": "list",
    },
    "deslop_step": {
        "scope_files": "list",
    },
    "verification": {
        "verification_run": "list",
    },
    "atomic_commit": {
        "commit_sha": "string",
        "commit_subject": "string",
    },
    "final_walkback": {
        "outcome_summary": "string",
    },
}


def utc_now_compact() -> str:
    return dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%SZ")


def utc_now_iso() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def default_run_id() -> str:
    return f"seam-walkback-review-{utc_now_compact()}"


def load_json_argument(record_json: str | None, record_file: str | None) -> dict[str, Any]:
    if record_json is not None:
        data = json.loads(record_json)
    elif record_file is not None:
        data = json.loads(Path(record_file).read_text(encoding="utf-8"))
    else:
        raise SystemExit("expected --record-json or --record-file")
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
    if expected == "string":
        if not isinstance(value, str) or not value.strip():
            errors.append(f"{prefix} field {field} must be a non-empty string")
    elif expected == "list":
        if not isinstance(value, list):
            errors.append(f"{prefix} field {field} must be a list")


def validate_trace_record(record: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    prefix = "trace record"
    for field, expected in {
        "run_id": "string",
        "timestamp_utc": "string",
        "skill": "string",
        "phase": "string",
        "worktree_root": "string",
    }.items():
        require_trace_field_type(record, field, expected, errors, prefix)

    phase = record.get("phase")
    if not isinstance(phase, str) or phase not in KNOWN_TRACE_PHASES:
        errors.append(f"{prefix} has invalid phase {phase!r}")
        return errors

    for field, expected in KNOWN_TRACE_PHASES[phase].items():
        require_trace_field_type(record, field, expected, errors, f"{prefix} phase {phase!r}")

    return errors


def run_git(args: list[str], cwd: Path) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def try_git(args: list[str], cwd: Path) -> str | None:
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


def changed_files_for_commit(cwd: Path, commit: str) -> list[str]:
    output = run_git(["diff-tree", "--no-commit-id", "--name-only", "-r", commit], cwd)
    return [line for line in output.splitlines() if line]


def classify_commit(subject: str, file_count: int) -> dict[str, Any]:
    lowered = subject.lower()
    type_prefix = subject.split(":", 1)[0] if ":" in subject else None
    pivot_reasons: list[str] = []
    if type_prefix == "refactor":
        pivot_reasons.append("type:refactor")
    keywords = {
        "extract": "keyword:extract",
        "align": "keyword:align",
        "move": "keyword:move",
        "migrate": "keyword:migrate",
        "drop": "keyword:drop",
        "centralize": "keyword:centralize",
        "unify": "keyword:unify",
        "harden": "keyword:harden",
    }
    for needle, reason in keywords.items():
        if needle in lowered:
            pivot_reasons.append(reason)
    if type_prefix == "fix" and file_count >= 4 and any(reason.startswith("keyword:") for reason in pivot_reasons):
        pivot_reasons.append("type:fix-with-move")
    return {
        "type": type_prefix,
        "likely_pivot": bool(pivot_reasons),
        "pivot_reasons": pivot_reasons,
    }


def inventory(args: argparse.Namespace) -> int:
    cwd = Path(args.project_root).resolve()
    branch = run_git(["branch", "--show-current"], cwd)
    merge_base = run_git(["merge-base", "HEAD", args.base_ref], cwd)
    rev_range = f"{merge_base}..HEAD"
    log_format = "%H%x1f%s"
    log_output = run_git(["log", f"--max-count={args.max_commits}", f"--format={log_format}", rev_range], cwd)
    commits: list[dict[str, Any]] = []
    for line in [entry for entry in log_output.splitlines() if entry]:
        sha, subject = line.split("\x1f", 1)
        changed_files = changed_files_for_commit(cwd, sha)
        classification = classify_commit(subject, len(changed_files))
        commits.append(
            {
                "sha": sha,
                "subject": subject,
                "file_count": len(changed_files),
                "files": changed_files if args.include_files else [],
                **classification,
            }
        )

    dirty_output = try_git(["status", "--short", "--untracked-files=all"], cwd) or ""
    dirty_files = [line for line in dirty_output.splitlines() if line]
    ahead_behind_raw = try_git(["rev-list", "--left-right", "--count", f"{args.base_ref}...HEAD"], cwd)
    base_only_count = None
    head_only_count = None
    if ahead_behind_raw:
        parts = ahead_behind_raw.split()
        if len(parts) == 2:
            base_only_count = int(parts[0])
            head_only_count = int(parts[1])
    data = {
        "project_root": str(cwd),
        "branch": branch,
        "base_ref": args.base_ref,
        "merge_base": merge_base,
        "ahead_behind": {
            "raw": ahead_behind_raw,
            "base_only_count": base_only_count,
            "head_only_count": head_only_count,
        },
        "dirty_files": dirty_files,
        "commit_count": len(commits),
        "commits": commits,
    }
    print(json.dumps(data, indent=2))
    return 0


def commit_files(args: argparse.Namespace) -> int:
    cwd = Path(args.project_root).resolve()
    files = changed_files_for_commit(cwd, args.commit)
    print(json.dumps({"commit": args.commit, "files": files, "file_count": len(files)}, indent=2))
    return 0


def init_trace(args: argparse.Namespace) -> int:
    run_id = args.run_id or default_run_id()
    project_root = Path(args.project_root).resolve()
    trace_root_arg = Path(args.trace_root)
    trace_root = (project_root / trace_root_arg).resolve() if not trace_root_arg.is_absolute() else trace_root_arg.resolve()
    trace_dir = trace_root / run_id
    trace_dir.mkdir(parents=True, exist_ok=True)
    coordinator_file = trace_dir / "coordinator.jsonl"
    if not coordinator_file.exists() or coordinator_file.stat().st_size == 0:
        record = {
            "run_id": run_id,
            "timestamp_utc": utc_now_iso(),
            "skill": "seam-walkback-review",
            "phase": "trace_started",
            "worktree_root": str(project_root),
        }
        coordinator_file.write_text(json.dumps(record, sort_keys=True) + "\n", encoding="utf-8")
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


def append_trace(args: argparse.Namespace) -> int:
    trace_file = Path(args.trace_file).resolve()
    trace_file.parent.mkdir(parents=True, exist_ok=True)
    record = load_json_argument(args.record_json, args.record_file)
    errors = validate_trace_record(record)
    if errors:
        print(json.dumps({"trace_file": str(trace_file), "appended": False, "errors": errors}, indent=2, sort_keys=True))
        return 1
    with trace_file.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")
    print(json.dumps({"trace_file": str(trace_file), "appended": True}, indent=2, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Deterministic seam-walkback state helpers.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    inventory_parser = subparsers.add_parser(
        "inventory",
        help="Emit current branch state, merge base, dirty files, and recent commits since the merge base.",
    )
    inventory_parser.add_argument("--project-root", default=".")
    inventory_parser.add_argument("--base-ref", default="origin/main")
    inventory_parser.add_argument("--max-commits", type=int, default=30)
    inventory_parser.add_argument(
        "--include-files",
        action="store_true",
        help="Include changed files for each listed commit.",
    )
    inventory_parser.set_defaults(func=inventory)

    commit_files_parser = subparsers.add_parser(
        "commit-files",
        help="Emit the changed file list for one commit.",
    )
    commit_files_parser.add_argument("commit")
    commit_files_parser.add_argument("--project-root", default=".")
    commit_files_parser.set_defaults(func=commit_files)

    init_trace_parser = subparsers.add_parser(
        "init-trace",
        help="Create or resume the seam-walkback run trace directory and coordinator file.",
    )
    init_trace_parser.add_argument("--trace-root", default=".coortex/review-trace")
    init_trace_parser.add_argument("--project-root", default=".")
    init_trace_parser.add_argument("--run-id")
    init_trace_parser.set_defaults(func=init_trace)

    append_trace_parser = subparsers.add_parser(
        "append-trace",
        help="Append one JSON record to a seam-walkback trace JSONL file.",
    )
    append_trace_parser.add_argument("--trace-file", required=True)
    append_trace_group = append_trace_parser.add_mutually_exclusive_group(required=True)
    append_trace_group.add_argument("--record-json")
    append_trace_group.add_argument("--record-file")
    append_trace_parser.set_defaults(func=append_trace)

    return parser


if __name__ == "__main__":
    parser = build_parser()
    ns = parser.parse_args()
    raise SystemExit(ns.func(ns))
