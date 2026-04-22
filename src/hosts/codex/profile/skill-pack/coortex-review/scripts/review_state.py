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

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
