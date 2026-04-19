#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any


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

    return parser


if __name__ == "__main__":
    parser = build_parser()
    ns = parser.parse_args()
    raise SystemExit(ns.func(ns))
