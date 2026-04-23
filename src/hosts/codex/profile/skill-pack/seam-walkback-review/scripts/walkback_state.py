#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
from pathlib import Path
from typing import Any

ACTIVE_CAMPAIGN_FILE = "active-review-campaign.json"
SEAM_WALK_CAMPAIGN_TYPE = "seam-walkback-review"

KNOWN_TRACE_PHASES: dict[str, dict[str, str]] = {
    "trace_started": {},
    "campaign_resumed": {
        "previous_run_id": "string",
    },
    "archaeology_cluster": {
        "cluster_id": "string",
        "scope_summary": "string",
        "pivot_commits": "list",
    },
    "seam_selection": {
        "seam_id": "string",
        "reason": "string",
    },
    "commit_group_selected": {
        "group_id": "string",
        "label": "string",
        "scope_summary": "string",
        "commit_shas": "list",
        "primary_seams": "list",
    },
    "commit_group_reviewed": {
        "group_id": "string",
        "review_skill": "string",
        "scope_summary": "string",
        "review_grounded_signal_ids": "list",
        "deslop_advisory_signal_ids": "list",
        "candidate_family_ids": "list",
    },
    "family_consolidation": {
        "candidate_family_ids": "list",
        "summary": "string",
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
    "handoff_emitted": {
        "packet_path": "string",
        "next_skill": "string",
        "handoff_mode": "string",
    },
    "final_walkback": {
        "outcome_summary": "string",
        "terminal_state": "string",
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

def resolve_trace_root(project_root: Path, raw_trace_root: str) -> Path:
    trace_root_arg = Path(raw_trace_root)
    return (project_root / trace_root_arg).resolve() if not trace_root_arg.is_absolute() else trace_root_arg.resolve()

def active_campaign_path(trace_root: Path) -> Path:
    return trace_root / ACTIVE_CAMPAIGN_FILE

def load_active_campaign(trace_root: Path) -> dict[str, Any] | None:
    path = active_campaign_path(trace_root)
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else None

def write_active_campaign(trace_root: Path, data: dict[str, Any]) -> Path:
    trace_root.mkdir(parents=True, exist_ok=True)
    path = active_campaign_path(trace_root)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path

def clear_active_campaign(trace_root: Path, campaign_id: str) -> bool:
    path = active_campaign_path(trace_root)
    active = load_active_campaign(trace_root)
    if not active or str(active.get("campaign_id") or "") != campaign_id:
        return False
    if path.exists():
        path.unlink()
    return True


def campaign_owner_metadata(args: argparse.Namespace) -> dict[str, str]:
    metadata = {
        "owner_started_from_cwd": str(Path(args.owner_started_from_cwd or os.getcwd()).resolve()),
    }
    owner_host_session_id = args.owner_host_session_id or os.environ.get("CODEX_SESSION_ID")
    if owner_host_session_id:
        metadata["owner_host_session_id"] = owner_host_session_id
    else:
        owner_host_thread_id = os.environ.get("CODEX_THREAD_ID")
        if owner_host_thread_id:
            metadata["owner_host_thread_id"] = owner_host_thread_id
    return metadata

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
    project_root = Path(args.project_root).resolve()
    trace_root = resolve_trace_root(project_root, args.trace_root)
    trace_root.mkdir(parents=True, exist_ok=True)

    active = load_active_campaign(trace_root)
    requested_run_id = args.run_id
    resumed = False
    previous_run_id = None

    if active and active.get("state") == "active":
        active_type = str(active.get("campaign_type") or "")
        active_run_id = str(active.get("campaign_id") or active.get("run_id") or "")
        if active_type != SEAM_WALK_CAMPAIGN_TYPE:
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
        if requested_run_id and requested_run_id != active_run_id:
            print(
                json.dumps(
                    {
                        "status": "error",
                        "reason": "concurrent-seam-walk",
                        "message": "a seam-walkback campaign is already active for this worktree",
                        "active_campaign": active,
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
            return 2
        run_id = active_run_id
        resumed = True
        previous_run_id = active_run_id
    else:
        run_id = requested_run_id or default_run_id()
        owner_metadata = campaign_owner_metadata(args)
        active = {
            "campaign_id": run_id,
            "campaign_type": SEAM_WALK_CAMPAIGN_TYPE,
            "state": "active",
            "worktree_root": str(project_root),
            "started_at_utc": utc_now_iso(),
            **owner_metadata,
        }
        write_active_campaign(trace_root, active)

    trace_dir = trace_root / run_id
    trace_dir.mkdir(parents=True, exist_ok=True)
    coordinator_file = trace_dir / "coordinator.jsonl"
    if not coordinator_file.exists() or coordinator_file.stat().st_size == 0:
        record = {
            "run_id": run_id,
            "timestamp_utc": utc_now_iso(),
            "skill": SEAM_WALK_CAMPAIGN_TYPE,
            "phase": "trace_started",
            "worktree_root": str(project_root),
        }
        coordinator_file.write_text(json.dumps(record, sort_keys=True) + "\n", encoding="utf-8")
    elif resumed:
        record = {
            "run_id": run_id,
            "timestamp_utc": utc_now_iso(),
            "skill": SEAM_WALK_CAMPAIGN_TYPE,
            "phase": "campaign_resumed",
            "worktree_root": str(project_root),
            "previous_run_id": previous_run_id or run_id,
        }
        with coordinator_file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")

    print(
        json.dumps(
            {
                "run_id": run_id,
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

def packet_path_cmd(args: argparse.Namespace) -> int:
    trace_dir = Path(args.trace_dir).resolve()
    trace_dir.mkdir(parents=True, exist_ok=True)
    packet_path = trace_dir / "seam-walk-packet.json"
    print(json.dumps({"packet_path": str(packet_path)}, indent=2, sort_keys=True))
    return 0

def append_trace(args: argparse.Namespace) -> int:
    trace_file = Path(args.trace_file).resolve()
    trace_file.parent.mkdir(parents=True, exist_ok=True)
    record = load_json_argument(args.record_json, args.record_file)
    errors = validate_trace_record(record)
    if errors:
        print(json.dumps({"trace_file": str(trace_file), "appended": False, "errors": errors}, indent=2, sort_keys=True))
        return 1

    phase = str(record.get("phase") or "")
    run_id = str(record.get("run_id") or "")
    trace_root = trace_file.parent.parent
    active_update = None
    active_cleared = False
    if phase == "final_walkback":
        active = load_active_campaign(trace_root)
        terminal_state = str(record.get("terminal_state") or "")
        if terminal_state == "handoff-completed":
            child_final_review_run_id = ""
            child_final_verdict = ""
            child_review_handoff_path = ""
            if active and str(active.get("campaign_id") or "") == run_id:
                child_final_review_run_id = str(active.get("child_final_review_run_id") or "")
                child_final_verdict = str(active.get("child_final_verdict") or "")
                child_review_handoff_path = str(active.get("child_review_handoff_path") or "")
            if not child_final_review_run_id:
                print(
                    json.dumps(
                        {
                            "trace_file": str(trace_file),
                            "appended": False,
                            "status": "error",
                            "reason": "downstream-review-not-complete",
                            "active_campaign_cleared": False,
                        },
                        indent=2,
                        sort_keys=True,
                    )
                )
                return 2
            if child_final_verdict != "NO_ACTIONABLE_FAMILIES":
                if not child_review_handoff_path:
                    print(
                        json.dumps(
                            {
                                "trace_file": str(trace_file),
                                "appended": False,
                                "status": "error",
                                "reason": "missing-review-handoff-artifact",
                                "active_campaign_cleared": False,
                            },
                            indent=2,
                            sort_keys=True,
                        )
                    )
                    return 2
                handoff_path = Path(child_review_handoff_path)
                if not handoff_path.is_absolute():
                    handoff_path = (trace_root.parent.parent / handoff_path).resolve()
                if not handoff_path.exists():
                    print(
                        json.dumps(
                            {
                                "trace_file": str(trace_file),
                                "appended": False,
                                "status": "error",
                                "reason": "missing-review-handoff-artifact",
                                "active_campaign_cleared": False,
                            },
                            indent=2,
                            sort_keys=True,
                        )
                    )
                    return 2

    with trace_file.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")

    if phase == "handoff_emitted":
        active = load_active_campaign(trace_root)
        if active and str(active.get("campaign_id") or "") == run_id:
            active["handoff_mode"] = record.get("handoff_mode")
            active["handoff_packet_path"] = record.get("packet_path")
            active["next_skill"] = record.get("next_skill")
            active["handoff_emitted_at_utc"] = str(record.get("timestamp_utc") or utc_now_iso())
            write_active_campaign(trace_root, active)
            active_update = "handoff-emitted"
    elif phase == "final_walkback":
        active_cleared = clear_active_campaign(trace_root, run_id)
        if not active_cleared:
            print(
                json.dumps(
                    {
                        "trace_file": str(trace_file),
                        "appended": True,
                        "status": "error",
                        "reason": "active-campaign-not-cleared",
                        "active_campaign_cleared": False,
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
            return 2

    print(
        json.dumps(
            {
                "trace_file": str(trace_file),
                "appended": True,
                "status": "ok",
                "active_campaign_update": active_update,
                "active_campaign_cleared": active_cleared,
            },
            indent=2,
            sort_keys=True,
        )
    )
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
    init_trace_parser.add_argument("--owner-host-session-id")
    init_trace_parser.add_argument("--owner-started-from-cwd")
    init_trace_parser.set_defaults(func=init_trace)

    packet_path_parser = subparsers.add_parser(
        "packet-path",
        help="Resolve the canonical seam-walk discovery packet path inside a run trace directory.",
    )
    packet_path_parser.add_argument("--trace-dir", required=True)
    packet_path_parser.set_defaults(func=packet_path_cmd)

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
