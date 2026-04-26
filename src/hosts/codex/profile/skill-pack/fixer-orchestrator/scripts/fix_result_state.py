#!/usr/bin/env python3
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
import pathlib
import re
from typing import Any

TRACE_PHASES = {
    "trace_started",
    "intake",
    "batch_plan",
    "execution_plan",
    "family_closeout",
    "verification",
    "return_review_loop",
    "closure_approved",
    "pre_commit_gate_result",
    "commit_ready",
    "lane_continuation",
    "review_return_handoff",
    "family_commit",
    "final_fix",
}

ACTIVE_CAMPAIGN_FILE = "active-review-campaign.json"
FIXER_CAMPAIGN_TYPE = "fixer-orchestrator"
CURRENT_WORK_PACKET_KEYS = (
    "current_work_review_packet",
    "mini_surface_review_packet",
    "current_work_packet",
)
CURRENT_WORK_PACKET_PATH_KEYS = (
    "current_work_packet_path",
    "current_work_review_packet_path",
    "review_packet_path",
)

TRACE_PHASE_REQUIRED_FIELDS: dict[str, dict[str, str]] = {
    "trace_started": {},
    "intake": {
        "family_ids": "list",
        "closure_gate_summaries": "list",
        "candidate_write_sets": "list",
    },
    "batch_plan": {
        "slice_ids": "list",
        "lane_ids": "list",
        "family_ids": "list",
        "wave_ids": "list",
        "orchestration_mode": "string",
    },
    "execution_plan": {
        "family_id": "string",
        "owning_seam": "string",
        "planned_write_set": "list",
        "planned_test_set": "list",
        "planned_doc_set": "list",
        "execution_mode": "string",
    },
    "family_closeout": {
        "family_id": "string",
        "write_set": "list",
        "tests_updated": "list",
        "docs_updated": "list",
        "files_read": "list",
        "docs_read": "list",
        "searches_run": "list",
        "commands_run": "list",
        "verification_run": "list",
        "touched_build_gate": "mapping",
        "local_quality_gates": "list",
        "emergent_threads_followed": "list",
        "emergent_threads_deferred": "list",
        "closure_status": "string",
        "residual_risks": "list",
    },
    "verification": {
        "family_id": "string",
        "verification_run": "list",
        "touched_build_gate": "mapping",
        "local_quality_gates": "list",
        "broader_suite_status": "string",
    },
    "return_review_loop": {
        "lane_id": "string",
        "worker_session_id": "string",
        "family_ids": "list",
        "reviewer_run_id": "string",
        "review_result": "string",
        "return_review_round": "int",
    },
    "closure_approved": {
        "family_ids": "list",
        "reviewer_run_id": "string",
        "review_result": "string",
        "return_review_rounds_taken_by_family": "mapping",
    },
    "pre_commit_gate_result": {
        "family_ids": "list",
        "gate_status": "string",
        "review_gate_result": "string",
        "deslop_gate_result": "string",
        "follow_up_kind": "string",
    },
    "commit_ready": {
        "family_ids": "list",
        "readiness_basis": "string",
        "self_deslop_evidence": "list",
        "lane_review_evidence": "list",
        "seam_residue_sweep_evidence": "list",
        "final_touched_build_gate": "mapping",
        "final_local_quality_gates": "list",
        "final_targeted_verification": "list",
        "excluded_unrelated_edits": "list",
    },
    "lane_continuation": {
        "lane_id": "string",
        "worker_session_id": "string",
        "family_ids": "list",
        "continuation_reason": "string",
        "return_review_round": "int",
    },
    "review_return_handoff": {},
    "family_commit": {
        "family_ids": "list",
        "commit_sha": "string",
        "commit_subject": "string",
        "return_review_rounds_taken_by_family": "mapping",
    },
    "final_fix": {
        "family_ids_handled": "list",
        "final_statuses": "list",
    },
}

CLOSURE_STATUSES = {
    "symptom-fixed-only",
    "family-partially-closed",
    "verification-blocked",
    "family-closed",
}

TOUCHED_BUILD_GATE_STATUSES = {
    "green",
    "red",
    "blocked",
    "hanging",
    "skipped-not-applicable",
}

LOCAL_QUALITY_GATE_STATUSES = TOUCHED_BUILD_GATE_STATUSES

OPEN_REASON_KINDS = {
    "family-local-gap-remaining",
    "unfinished-family-work",
    "broader-cross-family-contract",
    "verification-separate-blocker",
}

DEFER_REASON_KINDS = {
    "sequenced-after-overlapping-family",
    "separate-family-later-slice",
    "blocked-by-broader-contract-change",
    "blocked-by-prerequisite-contract-change",
    "blocked-by-external-environment",
    "stale-or-ambiguous-input",
    "user-scope-excluded",
    "insufficient-grounded-evidence",
}

DEFER_TOUCH_STATES = {
    "not-started",
    "adjacent-file-overlap-no-owning-fix",
    "broader-cross-family-overlap",
}

CONTENT_FREE_REASONS = {
    "untouched in this slice.",
    "untouched in this slice",
}

FIXER_ORIENTED_ACTION_PATTERNS = (
    "introduce ",
    "implement ",
    "add ",
    "change ",
    "modify ",
    "update code",
    "patch ",
    "fix ",
    "wire ",
    "thread ",
    "rekey ",
    "rename ",
    "take the next fix slice",
    "land ",
)

GENERATED_COMMIT_ID_PATTERNS = (
    re.compile(r"\bL-\d+\b"),
    re.compile(r"\bS-\d+\b"),
    re.compile(r"\bW-\d+\b"),
)

CLOSURE_APPROVAL_RESULTS = {
    "closure-approved",
}

PRE_COMMIT_GATE_STATUSES = {
    "clear",
    "needs-followup",
}

PRE_COMMIT_GATE_FOLLOW_UP_KINDS = {
    "none",
    "cleanup-only",
    "correctness",
    "mixed",
}

WEAK_COMMIT_READY_BASIS_PATTERNS = (
    "reviewer approval",
    "reviewer-approved",
    "green gate",
    "green rerun",
    "git diff --check",
    "narrow grep",
    "targeted suite",
    "targeted tests",
)


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


def as_list(value: Any) -> list[Any]:
    if value in (None, "none"):
        return []
    if isinstance(value, list):
        return value
    return [value]


def normalize_string_list(value: Any) -> list[str]:
    return [str(item) for item in as_list(value)]


def manifest_paths(manifestations: Any) -> list[str]:
    return [item.split(":", 1)[0] for item in normalize_string_list(manifestations)]


def family_candidate_paths(family: dict[str, Any]) -> set[str]:
    review_hints = family.get("review_hints")
    candidate_write_set: list[str] = []
    if isinstance(review_hints, dict):
        candidate_write_set = normalize_string_list(review_hints.get("candidate_write_set"))
    return set(candidate_write_set + manifest_paths(family.get("manifestations")))


def family_entry_touched_paths(entry: dict[str, Any]) -> set[str]:
    touched: set[str] = set()
    for field in ("touched_write_set", "touched_tests", "touched_docs"):
        touched.update(normalize_string_list(entry.get(field)))
    return touched


def family_review_hints(family: dict[str, Any]) -> dict[str, Any]:
    review_hints = family.get("review_hints")
    return review_hints if isinstance(review_hints, dict) else {}


def family_identity_token(family_id: str, title: str, likely_owning_seam: str | None) -> str:
    return "::".join([family_id.strip(), title.strip(), (likely_owning_seam or "").strip()])


def family_identity_metadata(family: dict[str, Any]) -> dict[str, Any]:
    review_hints = family_review_hints(family)
    family_id = str(family.get("family_id") or "").strip()
    title = str(family.get("title") or "").strip()
    likely_owning_seam = str(review_hints.get("likely_owning_seam") or "").strip() or None
    return {
        "family_id": family_id,
        "title": title,
        "likely_owning_seam": likely_owning_seam,
        "identity_token": family_identity_token(family_id, title, likely_owning_seam),
    }


def empty_family_identity_metadata(family_id: str) -> dict[str, Any]:
    return {
        "family_id": family_id,
        "title": "",
        "likely_owning_seam": None,
        "identity_token": family_identity_token(family_id, "", None),
    }


def normalize_family_metadata_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    normalized: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        family_id = str(item.get("family_id") or "").strip()
        title = str(item.get("title") or "").strip()
        likely_owning_seam = str(item.get("likely_owning_seam") or "").strip() or None
        if not family_id:
            continue
        normalized.append(
            {
                "family_id": family_id,
                "title": title,
                "likely_owning_seam": likely_owning_seam,
                "identity_token": str(item.get("identity_token") or family_identity_token(family_id, title, likely_owning_seam)),
            }
        )
    return sorted(normalized, key=lambda entry: entry["family_id"])


def family_planning_record(family: dict[str, Any]) -> dict[str, Any]:
    review_hints = family_review_hints(family)
    carry_forward_context = family.get("carry_forward_context")
    carry_forward = carry_forward_context if isinstance(carry_forward_context, dict) else {}
    return {
        "family_id": str(family.get("family_id") or ""),
        "title": str(family.get("title") or ""),
        "owning_seam": str(review_hints.get("likely_owning_seam") or "") or None,
        "secondary_seams": normalize_string_list(review_hints.get("secondary_seams")),
        "candidate_write_set": normalize_string_list(review_hints.get("candidate_write_set")),
        "candidate_test_set": normalize_string_list(review_hints.get("candidate_test_set")),
        "candidate_doc_set": normalize_string_list(review_hints.get("candidate_doc_set")),
        "parallelizable": review_hints.get("parallelizable") is True,
        "blocking_family_ids": normalize_string_list(carry_forward.get("blocking_family_ids")),
        "carry_forward_reason_kind": str(carry_forward.get("reason_kind") or "") or None,
        "family_metadata": family_identity_metadata(family),
    }


def has_overlap(left: set[str], right: set[str]) -> bool:
    return bool(left.intersection(right))


def same_or_missing_seam(left: dict[str, Any], right: dict[str, Any]) -> bool:
    left_seam = left.get("owning_seam")
    right_seam = right.get("owning_seam")
    if not left_seam or not right_seam:
        return False
    return left_seam == right_seam


def plan_family_slices(families: list[dict[str, Any]], selected_family_ids: list[str] | None = None) -> dict[str, Any]:
    selected = [str(family_id) for family_id in (selected_family_ids or []) if str(family_id).strip()]
    family_records = [family_planning_record(family) for family in families if isinstance(family, dict)]
    available_ids = [record["family_id"] for record in family_records if record["family_id"]]
    missing = sorted(set(selected).difference(available_ids))
    if missing:
        raise ValueError(f"requested family ids are missing from review_handoff: {missing}")
    if selected:
        selected_set = set(selected)
        family_records = [record for record in family_records if record["family_id"] in selected_set]
    selected_ids = [record["family_id"] for record in family_records]

    slices: list[dict[str, Any]] = []
    consumed: set[str] = set()
    slice_by_family_id: dict[str, str] = {}

    for record in family_records:
        family_id = record["family_id"]
        if family_id in consumed:
            continue

        same_seam_records = [
            candidate
            for candidate in family_records
            if candidate["family_id"] not in consumed and same_or_missing_seam(record, candidate)
        ]
        grouped_records: list[dict[str, Any]] = []
        if record.get("owning_seam") and len(same_seam_records) > 1:
            candidate_pool = [
                (
                    candidate,
                    set(candidate["candidate_write_set"] + candidate["candidate_test_set"] + candidate["candidate_doc_set"]),
                )
                for candidate in same_seam_records
            ]
            overlapping = False
            for index, (left, left_paths) in enumerate(candidate_pool):
                if left.get("blocking_family_ids"):
                    overlapping = True
                    break
                for right, right_paths in candidate_pool[index + 1 :]:
                    if right.get("blocking_family_ids") or has_overlap(left_paths, right_paths):
                        overlapping = True
                        break
                if overlapping:
                    break
            if overlapping:
                grouped_records = same_seam_records

        if grouped_records:
            family_ids = [item["family_id"] for item in grouped_records]
            slice_id = f"S-{len(slices) + 1:03d}"
            slice_entry = {
                "slice_id": slice_id,
                "lane_id": f"L-{len(slices) + 1:03d}",
                "family_ids": family_ids,
                "primary_owning_seam": record.get("owning_seam"),
                "secondary_seams": sorted({path for item in grouped_records for path in item["secondary_seams"]}),
                "candidate_write_set": sorted({path for item in grouped_records for path in item["candidate_write_set"]}),
                "candidate_test_set": sorted({path for item in grouped_records for path in item["candidate_test_set"]}),
                "candidate_doc_set": sorted({path for item in grouped_records for path in item["candidate_doc_set"]}),
                "family_metadata": normalize_family_metadata_list([item["family_metadata"] for item in grouped_records]),
                "execution_mode": "sequential-within-slice",
                "blocking_family_ids": sorted({fid for item in grouped_records for fid in item["blocking_family_ids"]}),
                "return_review_mode": "targeted-return-review",
                "continuation_policy": "same-lane-until-approved",
                "reasons": [
                    "families share an owning seam and overlapping write/test/doc scope requires one bounded sequential slice"
                ],
            }
            slices.append(slice_entry)
            for item in grouped_records:
                consumed.add(item["family_id"])
                slice_by_family_id[item["family_id"]] = slice_id
            continue

        slice_id = f"S-{len(slices) + 1:03d}"
        slice_entry = {
            "slice_id": slice_id,
            "lane_id": f"L-{len(slices) + 1:03d}",
            "family_ids": [family_id],
            "primary_owning_seam": record.get("owning_seam"),
            "secondary_seams": record["secondary_seams"],
            "candidate_write_set": record["candidate_write_set"],
            "candidate_test_set": record["candidate_test_set"],
            "candidate_doc_set": record["candidate_doc_set"],
            "family_metadata": normalize_family_metadata_list([record["family_metadata"]]),
            "execution_mode": "single-family",
            "blocking_family_ids": record["blocking_family_ids"],
            "return_review_mode": "targeted-return-review",
            "continuation_policy": "same-lane-until-approved",
            "reasons": ["single family slice"],
        }
        if not record["parallelizable"]:
            slice_entry["reasons"].append(
                "review_hints.parallelizable is not true, so this slice stays isolated by default"
            )
        slices.append(slice_entry)
        consumed.add(family_id)
        slice_by_family_id[family_id] = slice_id

    dependency_ids: dict[str, set[str]] = {slice_entry["slice_id"]: set() for slice_entry in slices}
    for slice_entry in slices:
        for blocking_family_id in slice_entry["blocking_family_ids"]:
            blocking_slice_id = slice_by_family_id.get(blocking_family_id)
            if blocking_slice_id and blocking_slice_id != slice_entry["slice_id"]:
                dependency_ids[slice_entry["slice_id"]].add(blocking_slice_id)

    def slice_overlap(left: dict[str, Any], right: dict[str, Any]) -> bool:
        left_scope = set(left["candidate_write_set"] + left["candidate_test_set"] + left["candidate_doc_set"])
        right_scope = set(right["candidate_write_set"] + right["candidate_test_set"] + right["candidate_doc_set"])
        return has_overlap(left_scope, right_scope)

    waves: list[dict[str, Any]] = []
    wave_index_by_slice_id: dict[str, int] = {}
    slice_lookup = {slice_entry["slice_id"]: slice_entry for slice_entry in slices}

    def assign_wave(slice_id: str, visiting: set[str]) -> int:
        existing = wave_index_by_slice_id.get(slice_id)
        if existing is not None:
            return existing
        if slice_id in visiting:
            raise ValueError(f"blocking_family_ids produced a cycle involving slice {slice_id}")
        visiting.add(slice_id)

        slice_entry = slice_lookup[slice_id]
        dependency_wave_floor = 0
        if dependency_ids[slice_id]:
            dependency_wave_floor = max(assign_wave(dependency_id, visiting) for dependency_id in dependency_ids[slice_id]) + 1

        target_index: int | None = None
        for index in range(dependency_wave_floor, len(waves)):
            wave_slice_ids = waves[index]["slice_ids"]
            wave_slices = [slice_lookup[item] for item in wave_slice_ids]
            if any(slice_overlap(slice_entry, existing_slice) for existing_slice in wave_slices):
                continue
            target_index = index
            break

        if target_index is None:
            target_index = len(waves)
            waves.append({"wave_id": f"W-{target_index + 1:03d}", "slice_ids": []})

        waves[target_index]["slice_ids"].append(slice_id)
        wave_index_by_slice_id[slice_id] = target_index
        visiting.remove(slice_id)
        return target_index

    for slice_entry in slices:
        assign_wave(slice_entry["slice_id"], set())

    for slice_entry in slices:
        slice_entry["wave_id"] = waves[wave_index_by_slice_id[slice_entry["slice_id"]]]["wave_id"]
        if slice_entry["blocking_family_ids"]:
            slice_entry["reasons"].append("carry-forward blocking family ids require a later execution wave")

    if len(slices) == 1 and slices[0]["execution_mode"] == "single-family":
        orchestration_mode = "single-lane"
    elif len(waves) == 1 and len(slices) == len(waves[0]["slice_ids"]):
        orchestration_mode = "coordinated-parallel"
    else:
        orchestration_mode = "coordinated-sequenced"

    return {
        "selected_family_ids": selected_ids,
        "orchestration_mode": orchestration_mode,
        "slices": slices,
        "waves": waves,
        "summary": {
            "family_count": len(selected_ids),
            "slice_count": len(slices),
            "wave_count": len(waves),
        },
        "lane_ids": [slice_entry["lane_id"] for slice_entry in slices],
    }


def packet_body(packet: dict[str, Any]) -> dict[str, Any]:
    nested = packet.get("mini_surface_review_packet")
    if isinstance(nested, dict):
        return nested
    return packet


def current_work_packet_metadata(review_handoff: dict[str, Any]) -> dict[str, Any]:
    metadata: dict[str, Any] = {}

    for key in CURRENT_WORK_PACKET_PATH_KEYS:
        value = review_handoff.get(key)
        if isinstance(value, str) and value.strip():
            metadata["packet_path"] = value
            metadata["source_key"] = key
            break

    for key in CURRENT_WORK_PACKET_KEYS:
        value = review_handoff.get(key)
        if isinstance(value, dict):
            metadata["packet"] = value
            metadata["source_key"] = metadata.get("source_key", key)
            nested_path = value.get("packet_path")
            if "packet_path" not in metadata and isinstance(nested_path, str) and nested_path.strip():
                metadata["packet_path"] = nested_path
            body = packet_body(value)
            packet_id = value.get("packet_id") or body.get("packet_id")
            if isinstance(packet_id, str) and packet_id.strip():
                metadata["packet_id"] = packet_id
            break

    if metadata:
        metadata["review_helper"] = ".codex/skills/coortex-review/scripts/review_state.py"
        metadata["validate_packet_command"] = "validate-current-work-packet"
        metadata["validate_review_output_command"] = "validate-current-work-review-output"
    return metadata


def current_work_packet_metadata_matches(left: Any, right: Any) -> bool:
    if left is None or right is None:
        return left is right
    if not isinstance(left, dict) or not isinstance(right, dict):
        return False
    compared = False
    for key in ("packet_id", "packet_path"):
        left_value = left.get(key)
        right_value = right.get(key)
        if isinstance(left_value, str) and left_value.strip() and isinstance(right_value, str) and right_value.strip():
            compared = True
            if left_value != right_value:
                return False
    return compared or left == right


def attach_current_work_packet_metadata(plan: dict[str, Any], metadata: dict[str, Any]) -> None:
    if not metadata:
        return
    plan["current_work_review_packet"] = metadata
    slices = plan.get("slices")
    if isinstance(slices, list):
        for slice_entry in slices:
            if isinstance(slice_entry, dict):
                slice_entry["current_work_review_packet"] = metadata


def slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "item"


def default_run_id() -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"fixer-orchestrator-{timestamp}"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
    if expected == "mapping":
        if not isinstance(value, dict):
            errors.append(f"{prefix} field {field} must be a mapping")
        return
    if expected == "int":
        if not isinstance(value, int) or value < 0:
            errors.append(f"{prefix} field {field} must be a non-negative integer")
        return


def validate_round_count_mapping(
    family_ids: list[str],
    rounds_taken: Any,
    errors: list[str],
    prefix: str,
) -> None:
    if not isinstance(rounds_taken, dict):
        return
    mapping_keys = sorted(str(key) for key in rounds_taken.keys())
    if sorted(family_ids) != mapping_keys:
        errors.append(
            f"{prefix} return_review_rounds_taken_by_family keys must match family_ids exactly"
        )
    for family_id, round_count in rounds_taken.items():
        if not isinstance(round_count, int) or round_count < 0:
            errors.append(
                f"{prefix} round-trip count for family {family_id!r} must be a non-negative integer"
            )


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

    if phase in {"execution_plan", "family_closeout", "verification"} and "family_id" not in record:
        errors.append(f"{prefix} phase {phase!r} missing family_id")

    if phase == "family_closeout":
        closure_status = record.get("closure_status")
        validate_touched_build_gate(
            record.get("touched_build_gate"),
            closure_status,
            errors,
            [],
            f"{prefix} phase 'family_closeout'",
        )
        validate_local_quality_gates(
            record.get("local_quality_gates"),
            closure_status,
            errors,
            [],
            f"{prefix} phase 'family_closeout'",
        )

    if phase == "verification":
        validate_touched_build_gate(
            record.get("touched_build_gate"),
            record.get("closure_status"),
            errors,
            [],
            f"{prefix} phase 'verification'",
        )
        validate_local_quality_gates(
            record.get("local_quality_gates"),
            record.get("closure_status"),
            errors,
            [],
            f"{prefix} phase 'verification'",
        )

    if phase == "closure_approved":
        family_ids = normalize_string_list(record.get("family_ids"))
        review_result = record.get("review_result")
        if review_result not in CLOSURE_APPROVAL_RESULTS:
            errors.append(
                f"{prefix} phase 'closure_approved' review_result must be 'closure-approved'"
            )
        validate_round_count_mapping(
            family_ids,
            record.get("return_review_rounds_taken_by_family"),
            errors,
            f"{prefix} phase 'closure_approved'",
        )

    if phase == "pre_commit_gate_result":
        gate_status = record.get("gate_status")
        follow_up_kind = record.get("follow_up_kind")
        if gate_status not in PRE_COMMIT_GATE_STATUSES:
            errors.append(
                f"{prefix} phase 'pre_commit_gate_result' gate_status must be one of {sorted(PRE_COMMIT_GATE_STATUSES)!r}"
            )
        if follow_up_kind not in PRE_COMMIT_GATE_FOLLOW_UP_KINDS:
            errors.append(
                f"{prefix} phase 'pre_commit_gate_result' follow_up_kind must be one of {sorted(PRE_COMMIT_GATE_FOLLOW_UP_KINDS)!r}"
            )
        if gate_status == "clear" and follow_up_kind != "none":
            errors.append(
                f"{prefix} phase 'pre_commit_gate_result' follow_up_kind must be 'none' when gate_status is 'clear'"
            )
        if gate_status == "needs-followup" and follow_up_kind == "none":
            errors.append(
                f"{prefix} phase 'pre_commit_gate_result' follow_up_kind must describe the follow-up when gate_status is 'needs-followup'"
            )

    if phase == "commit_ready":
        readiness_basis = str(record.get("readiness_basis") or "").strip().lower()
        for pattern in WEAK_COMMIT_READY_BASIS_PATTERNS:
            if readiness_basis == pattern:
                errors.append(
                    f"{prefix} phase 'commit_ready' readiness_basis must not rely on {pattern!r} alone"
                )
                break
        for field in (
            "self_deslop_evidence",
            "lane_review_evidence",
            "seam_residue_sweep_evidence",
            "final_touched_build_gate",
            "final_local_quality_gates",
            "final_targeted_verification",
        ):
            if field == "final_touched_build_gate":
                build_gate = record.get(field)
                if not isinstance(build_gate, dict):
                    errors.append(
                        f"{prefix} phase 'commit_ready' field {field} must be a mapping"
                    )
                    continue
                validate_touched_build_gate(build_gate, "family-closed", errors, [], f"{prefix} phase 'commit_ready'")
                continue
            if field == "final_local_quality_gates":
                validate_local_quality_gates(
                    record.get(field),
                    "family-closed",
                    errors,
                    [],
                    f"{prefix} phase 'commit_ready'",
                )
                continue
            if not as_list(record.get(field)):
                errors.append(
                    f"{prefix} phase 'commit_ready' field {field} must not be empty"
                )

    if phase == "family_commit":
        family_ids = normalize_string_list(record.get("family_ids"))
        commit_subject = record.get("commit_subject")
        if isinstance(commit_subject, str):
            for pattern in GENERATED_COMMIT_ID_PATTERNS:
                if pattern.search(commit_subject):
                    errors.append(
                        f"{prefix} phase 'family_commit' commit_subject must not include generated lane/slice/wave ids"
                    )
                    break
        validate_round_count_mapping(
            family_ids,
            record.get("return_review_rounds_taken_by_family"),
            errors,
            f"{prefix} phase 'family_commit'",
        )

    return errors


def load_existing_trace_records(trace_file: pathlib.Path) -> tuple[list[dict[str, Any]], list[str]]:
    if not trace_file.exists():
        return [], []

    records: list[dict[str, Any]] = []
    errors: list[str] = []
    for line_number, line in enumerate(trace_file.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(
                f"existing trace file {trace_file} contains invalid JSON on line {line_number}: {exc.msg}"
            )
            continue
        if not isinstance(parsed, dict):
            errors.append(
                f"existing trace file {trace_file} line {line_number} must be a JSON object"
            )
            continue
        records.append(parsed)
    return records, errors


def matching_family_phase_indexes(
    records: list[dict[str, Any]],
    phase: str,
    family_ids: list[str],
) -> list[int]:
    normalized = sorted(family_ids)
    indexes: list[int] = []
    for index, prior in enumerate(records):
        if str(prior.get("phase") or "") != phase:
            continue
        prior_family_ids = normalize_string_list(prior.get("family_ids"))
        if sorted(prior_family_ids) == normalized:
            indexes.append(index)
    return indexes


def validate_trace_record_against_history(
    record: dict[str, Any],
    trace_file: pathlib.Path,
) -> list[str]:
    phase = str(record.get("phase") or "")
    if phase not in {"pre_commit_gate_result", "commit_ready", "family_commit"}:
        return []

    records, parse_errors = load_existing_trace_records(trace_file)
    if parse_errors:
        return parse_errors

    family_ids = normalize_string_list(record.get("family_ids"))
    errors: list[str] = []

    approval_indexes = matching_family_phase_indexes(records, "closure_approved", family_ids)
    gate_indexes = matching_family_phase_indexes(records, "pre_commit_gate_result", family_ids)
    clear_gate_indexes = [
        index
        for index in gate_indexes
        if records[index].get("gate_status") == "clear"
    ]
    ready_indexes = matching_family_phase_indexes(records, "commit_ready", family_ids)

    last_approval = approval_indexes[-1] if approval_indexes else -1
    last_gate = gate_indexes[-1] if gate_indexes else -1
    last_clear_gate = clear_gate_indexes[-1] if clear_gate_indexes else -1
    last_ready = ready_indexes[-1] if ready_indexes else -1

    if phase == "pre_commit_gate_result":
        if last_approval == -1:
            errors.append(
                "trace record phase 'pre_commit_gate_result' requires a prior 'closure_approved' record for the same family_ids"
            )
        return errors

    if last_approval == -1:
        errors.append(
            f"trace record phase {phase!r} requires a prior 'closure_approved' record for the same family_ids"
        )

    if last_gate == -1:
        errors.append(
            f"trace record phase {phase!r} requires a prior 'pre_commit_gate_result' record for the same family_ids"
        )
    elif last_gate != last_clear_gate:
        errors.append(
            f"trace record phase {phase!r} requires the latest 'pre_commit_gate_result' for the same family_ids to have gate_status 'clear'"
        )

    if last_approval != -1 and last_clear_gate != -1 and last_clear_gate <= last_approval:
        errors.append(
            f"trace record phase {phase!r} requires a clear 'pre_commit_gate_result' recorded after the latest 'closure_approved' for the same family_ids"
        )

    if phase == "commit_ready":
        return errors

    if last_ready == -1:
        errors.append(
            "trace record phase 'family_commit' requires a prior 'commit_ready' record for the same family_ids"
        )
    elif last_clear_gate != -1 and last_ready <= last_clear_gate:
        errors.append(
            "trace record phase 'family_commit' requires 'commit_ready' to be recorded after the latest clear 'pre_commit_gate_result' for the same family_ids"
        )

    return errors


def require(entry: dict[str, Any], field: str, errors: list[str], prefix: str) -> Any:
    value = entry.get(field)
    if value is None:
        errors.append(f"{prefix} missing {field}")
    return value


def validate_reviewer_next_step(
    step: Any,
    errors: list[str],
    prefix: str,
) -> None:
    if step in (None, "none"):
        return
    if not isinstance(step, dict):
        errors.append(f"{prefix} reviewer_next_step must be a mapping or none")
        return
    action = step.get("action")
    if not isinstance(action, str):
        errors.append(f"{prefix} reviewer_next_step missing string action")
        return
    normalized = action.strip().lower()
    if any(normalized.startswith(pattern) for pattern in FIXER_ORIENTED_ACTION_PATTERNS):
        errors.append(
            f"{prefix} reviewer_next_step.action looks fixer-oriented; use reviewer-facing reevaluation guidance instead"
        )


def validate_touched_build_gate(
    gate: Any,
    status: Any,
    errors: list[str],
    warnings: list[str],
    prefix: str,
) -> None:
    if not isinstance(gate, dict):
        errors.append(f"{prefix} must include touched_build_gate")
        return

    command = gate.get("command")
    if not isinstance(command, str) or not command.strip():
        errors.append(f"{prefix} touched_build_gate.command must be a non-empty string")

    scope = gate.get("scope")
    if not isinstance(scope, str) or not scope.strip():
        errors.append(f"{prefix} touched_build_gate.scope must be a non-empty string")

    gate_status = gate.get("status")
    if not isinstance(gate_status, str) or gate_status not in TOUCHED_BUILD_GATE_STATUSES:
        errors.append(
            f"{prefix} touched_build_gate.status must be one of {sorted(TOUCHED_BUILD_GATE_STATUSES)}"
        )
        return

    evidence = gate.get("evidence")
    if not isinstance(evidence, str) or not evidence.strip():
        errors.append(f"{prefix} touched_build_gate.evidence must be a non-empty string")

    if status == "family-closed" and gate_status not in {"green", "skipped-not-applicable"}:
        errors.append(
            f"{prefix} cannot claim family-closed with touched_build_gate.status {gate_status!r}"
        )
    if gate_status == "skipped-not-applicable" and status == "family-closed":
        warnings.append(
            f"{prefix} claims family-closed with touched_build_gate "
            "skipped-not-applicable; reviewer should verify that no touched "
            "build/compile/typecheck gate exists"
        )


def validate_local_quality_gates(
    gates: Any,
    status: Any,
    errors: list[str],
    warnings: list[str],
    prefix: str,
) -> None:
    if not isinstance(gates, list) or not gates:
        errors.append(f"{prefix} must include non-empty local_quality_gates")
        return

    for index, gate in enumerate(gates, start=1):
        gate_prefix = f"{prefix} local_quality_gates[{index}]"
        if not isinstance(gate, dict):
            errors.append(f"{gate_prefix} must be a mapping")
            continue

        name = gate.get("name")
        if not isinstance(name, str) or not name.strip():
            errors.append(f"{gate_prefix}.name must be a non-empty string")

        command = gate.get("command")
        if not isinstance(command, str) or not command.strip():
            errors.append(f"{gate_prefix}.command must be a non-empty string")

        gate_status = gate.get("status")
        if not isinstance(gate_status, str) or gate_status not in LOCAL_QUALITY_GATE_STATUSES:
            errors.append(
                f"{gate_prefix}.status must be one of {sorted(LOCAL_QUALITY_GATE_STATUSES)}"
            )
            continue

        evidence = gate.get("evidence")
        if not isinstance(evidence, str) or not evidence.strip():
            errors.append(f"{gate_prefix}.evidence must be a non-empty string")

        if status == "family-closed" and gate_status not in {"green", "skipped-not-applicable"}:
            errors.append(
                f"{prefix} cannot claim family-closed with local_quality_gates[{index}].status {gate_status!r}"
            )
        if gate_status == "skipped-not-applicable" and status == "family-closed":
            warnings.append(
                f"{gate_prefix} is skipped-not-applicable; reviewer should "
                "verify no configured local quality gate exists"
            )


def validate_family_entry(entry: dict[str, Any], errors: list[str], warnings: list[str]) -> None:
    family_id = str(require(entry, "original_family_id", errors, "family entry") or "")
    prefix = f"family {family_id or '<unknown>'}"
    status = require(entry, "claimed_closure_status", errors, prefix)
    if isinstance(status, str) and status not in CLOSURE_STATUSES:
        errors.append(f"{prefix} has invalid claimed_closure_status {status!r}")

    open_reason_kind = entry.get("open_reason_kind")
    if status != "family-closed":
        if open_reason_kind is None:
            errors.append(f"{prefix} remains open without open_reason_kind")
        elif not isinstance(open_reason_kind, str) or open_reason_kind not in OPEN_REASON_KINDS:
            errors.append(f"{prefix} has invalid open_reason_kind {open_reason_kind!r}")
    elif open_reason_kind not in (None, "none"):
        warnings.append(f"{prefix} is family-closed but still includes open_reason_kind")

    for field in (
        "touched_write_set",
        "touched_tests",
        "touched_docs",
        "closure_gate_checked",
        "emergent_threads_followed",
        "emergent_threads_deferred",
        "residual_risks",
        "verification_run",
        "local_quality_gates",
    ):
        require(entry, field, errors, prefix)

    validate_touched_build_gate(entry.get("touched_build_gate"), status, errors, warnings, prefix)
    validate_local_quality_gates(entry.get("local_quality_gates"), status, errors, warnings, prefix)

    if status == "verification-blocked" and "verification_blocker" not in entry:
        errors.append(f"{prefix} uses verification-blocked without verification_blocker")
    if "next_step" in entry:
        errors.append(f"{prefix} uses next_step in review_return_handoff; use reviewer_next_step for reviewer-facing reevaluation guidance")
    reviewer_next_step = entry.get("reviewer_next_step")
    validate_reviewer_next_step(reviewer_next_step, errors, prefix)
    if status == "family-closed" and reviewer_next_step not in (None, "none"):
        errors.append(f"{prefix} is family-closed but still includes reviewer_next_step")

    if status == "family-closed":
        verification_run = as_list(entry.get("verification_run"))
        if not verification_run:
            errors.append(f"{prefix} uses family-closed without verification_run")
        broader_visible = any("broader_suite_status" in str(item) for item in verification_run)
        if not broader_visible:
            warnings.append(f"{prefix} family-closed but broader suite status is not obvious in verification_run")


def validate_deferred_family(
    entry: dict[str, Any],
    original_family: dict[str, Any] | None,
    handled_family_ids: set[str],
    handled_touched_paths: set[str],
    errors: list[str],
    warnings: list[str],
) -> None:
    family_id = str(require(entry, "family_id", errors, "deferred family") or "")
    prefix = f"deferred family {family_id or '<unknown>'}"
    reason_kind = require(entry, "defer_reason_kind", errors, prefix)
    if isinstance(reason_kind, str) and reason_kind not in DEFER_REASON_KINDS:
        errors.append(f"{prefix} has invalid defer_reason_kind {reason_kind!r}")

    touch_state = require(entry, "touch_state", errors, prefix)
    if isinstance(touch_state, str) and touch_state not in DEFER_TOUCH_STATES:
        errors.append(f"{prefix} has invalid touch_state {touch_state!r}")

    reason = require(entry, "reason", errors, prefix)
    if isinstance(reason, str) and reason.strip().lower() in CONTENT_FREE_REASONS:
        errors.append(f"{prefix} uses content-free reason {reason!r}")

    require(entry, "status", errors, prefix)
    require(entry, "actionable_when", errors, prefix)

    reviewer_next_step = entry.get("reviewer_next_step")
    if "next_step" in entry:
        errors.append(f"{prefix} uses next_step in review_return_handoff; use reviewer_next_step for reviewer-facing reevaluation guidance")
    validate_reviewer_next_step(reviewer_next_step, errors, prefix)

    blocking_ids = entry.get("blocking_family_ids")
    if blocking_ids is not None and blocking_ids != "none" and not isinstance(blocking_ids, list):
        errors.append(f"{prefix} blocking_family_ids must be a list or none")
    blocking_id_list = normalize_string_list(blocking_ids)
    if blocking_id_list:
        non_handled = sorted(set(blocking_id_list).difference(handled_family_ids))
        if non_handled:
            errors.append(
                f"{prefix} names blocking_family_ids that are not handled in this slice: {non_handled}"
            )

    if not original_family:
        return

    overlap_files = sorted(family_candidate_paths(original_family).intersection(handled_touched_paths))
    review_hints = original_family.get("review_hints")
    likely_owning_seam = review_hints.get("likely_owning_seam") if isinstance(review_hints, dict) else None
    owning_seam_overlap = bool(likely_owning_seam and likely_owning_seam in handled_touched_paths)

    if overlap_files and touch_state == "not-started":
        errors.append(
            f"{prefix} claims not-started but overlaps handled paths {overlap_files}; keep it as a handled open family or classify the overlap explicitly"
        )
    if not overlap_files and touch_state in {
        "adjacent-file-overlap-no-owning-fix",
        "broader-cross-family-overlap",
    }:
        errors.append(
            f"{prefix} claims overlap touch_state {touch_state!r} but no overlap with handled family paths was found"
        )
    if owning_seam_overlap and touch_state == "adjacent-file-overlap-no-owning-fix":
        errors.append(
            f"{prefix} overlaps the likely owning seam but is classified as adjacent-file-overlap-no-owning-fix; keep it as a handled open family or use a broader overlap defer with concrete blockers"
        )
    if owning_seam_overlap and touch_state == "broader-cross-family-overlap" and reason_kind != "blocked-by-broader-contract-change":
        errors.append(
            f"{prefix} overlaps the likely owning seam and uses broader-cross-family-overlap without blocked-by-broader-contract-change"
        )
    if touch_state != "not-started" and reason_kind == "separate-family-later-slice":
        errors.append(
            f"{prefix} uses separate-family-later-slice despite overlap; use an overlap-aware defer reason"
        )
    if touch_state != "not-started" and not blocking_id_list:
        errors.append(
            f"{prefix} uses overlap touch_state {touch_state!r} without blocking_family_ids"
        )


def plan_repair_slices(args: argparse.Namespace) -> int:
    data = unwrap_root(load_json_object(pathlib.Path(args.review_handoff)), "review_handoff")
    families = data.get("families")
    if not isinstance(families, list):
        print(json.dumps({
            "status": "error",
            "message": "review_handoff.families must be a list",
        }, indent=2, sort_keys=True))
        return 2
    try:
        plan = plan_family_slices(families, args.family_id)
    except ValueError as exc:
        print(json.dumps({
            "status": "error",
            "message": str(exc),
        }, indent=2, sort_keys=True))
        return 2
    attach_current_work_packet_metadata(plan, current_work_packet_metadata(data))
    print(json.dumps({
        "status": "ok",
        **plan,
    }, indent=2, sort_keys=True))
    return 0


def build_lane_continuation(args: argparse.Namespace) -> int:
    review_handoff_data = unwrap_root(load_json_object(pathlib.Path(args.review_handoff)), "review_handoff")
    lane_plan = load_json_object(pathlib.Path(args.lane_plan_json))

    families = review_handoff_data.get("families")
    if not isinstance(families, list):
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": "review_handoff.families must be a list",
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 2

    slices = lane_plan.get("slices")
    if not isinstance(slices, list):
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": "lane plan must contain a slices list",
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 2

    lane = next(
        (
            slice_entry
            for slice_entry in slices
            if isinstance(slice_entry, dict) and str(slice_entry.get("lane_id") or "") == args.lane_id
        ),
        None,
    )
    if lane is None:
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": f"lane_id {args.lane_id!r} was not found in the lane plan",
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 2

    lane_family_ids = normalize_string_list(lane.get("family_ids"))
    lane_family_id_set = set(lane_family_ids)
    filtered_families = [
        family
        for family in families
        if isinstance(family, dict) and str(family.get("family_id") or "") in lane_family_id_set
    ]
    returned_family_ids = [
        str(family.get("family_id") or "")
        for family in filtered_families
        if isinstance(family, dict) and family.get("family_id")
    ]

    if not returned_family_ids:
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": "refreshed review_handoff does not contain any actionable families for the requested lane",
                    "original_lane_family_ids": lane_family_ids,
                    "returned_family_ids": returned_family_ids,
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 2
    if not set(returned_family_ids).issubset(lane_family_id_set):
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": "refreshed review_handoff contains families outside the requested lane",
                    "original_lane_family_ids": lane_family_ids,
                    "returned_family_ids": returned_family_ids,
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 2

    seam_summary = review_handoff_data.get("seam_summary")
    lane_family_metadata = normalize_family_metadata_list(lane.get("family_metadata"))
    if not lane_family_metadata:
        refreshed_family_metadata = {
            str(family.get("family_id") or ""): family_identity_metadata(family)
            for family in families
            if isinstance(family, dict) and family.get("family_id")
        }
        lane_family_metadata = normalize_family_metadata_list(
            [
                refreshed_family_metadata.get(family_id, empty_family_identity_metadata(family_id))
                for family_id in lane_family_ids
            ]
        )

    filtered_handoff: dict[str, Any] = {
        "review_target": review_handoff_data.get("review_target"),
        "families": filtered_families,
    }
    if seam_summary is not None:
        filtered_handoff["seam_summary"] = seam_summary
    current_work_metadata = current_work_packet_metadata(review_handoff_data)
    if not current_work_metadata and isinstance(lane.get("current_work_review_packet"), dict):
        current_work_metadata = lane["current_work_review_packet"]
    if current_work_metadata:
        filtered_handoff["current_work_review_packet"] = current_work_metadata

    continuation = {
        "lane_continuation": {
            "lane_id": args.lane_id,
            "worker_session_id": args.worker_session_id,
            "slice_id": str(lane.get("slice_id") or ""),
            "family_ids": returned_family_ids,
            "original_lane_family_ids": lane_family_ids,
            "original_lane_family_metadata": lane_family_metadata,
            "continuation_policy": str(lane.get("continuation_policy") or "same-lane-until-approved"),
            "return_review_round": args.return_review_round,
            "review_source": {
                "skill": "review-orchestrator",
                "mode": "targeted-return-review",
                "reviewer_run_id": args.reviewer_run_id or "unknown",
            },
            "review_handoff": filtered_handoff,
        }
    }
    if current_work_metadata:
        continuation["lane_continuation"]["current_work_review_packet"] = current_work_metadata
    print(json.dumps(continuation, indent=2, sort_keys=True))
    return 0


def validate_lane_continuation(args: argparse.Namespace) -> int:
    data = unwrap_root(load_json_object(pathlib.Path(args.lane_continuation)), "lane_continuation")
    errors: list[str] = []

    lane_id = data.get("lane_id")
    worker_session_id = data.get("worker_session_id")
    slice_id = data.get("slice_id")
    family_ids = normalize_string_list(data.get("family_ids"))
    original_lane_family_ids = normalize_string_list(data.get("original_lane_family_ids"))
    original_lane_family_metadata = normalize_family_metadata_list(data.get("original_lane_family_metadata"))
    continuation_policy = data.get("continuation_policy")
    return_review_round = data.get("return_review_round")
    review_source = data.get("review_source")
    review_handoff = data.get("review_handoff")
    current_work_metadata = data.get("current_work_review_packet")

    if not isinstance(lane_id, str) or not lane_id.strip():
        errors.append("lane_continuation.lane_id must be a non-empty string")
    if not isinstance(worker_session_id, str) or not worker_session_id.strip():
        errors.append("lane_continuation.worker_session_id must be a non-empty string")
    if not isinstance(slice_id, str) or not slice_id.strip():
        errors.append("lane_continuation.slice_id must be a non-empty string")
    if not family_ids:
        errors.append("lane_continuation.family_ids must contain at least one family id")
    if not original_lane_family_ids:
        errors.append("lane_continuation.original_lane_family_ids must contain at least one family id")
    if not original_lane_family_metadata:
        errors.append("lane_continuation.original_lane_family_metadata must contain at least one family metadata entry")
    if family_ids and original_lane_family_ids and not set(family_ids).issubset(set(original_lane_family_ids)):
        errors.append("lane_continuation.family_ids must be a subset of lane_continuation.original_lane_family_ids")
    if original_lane_family_metadata:
        metadata_ids = [entry["family_id"] for entry in original_lane_family_metadata]
        if sorted(original_lane_family_ids) != sorted(metadata_ids):
            errors.append(
                "lane_continuation.original_lane_family_metadata must cover lane_continuation.original_lane_family_ids exactly"
            )
    if continuation_policy != "same-lane-until-approved":
        errors.append("lane_continuation.continuation_policy must be 'same-lane-until-approved'")
    if not isinstance(return_review_round, int) or return_review_round < 1:
        errors.append("lane_continuation.return_review_round must be a positive integer")
    if not isinstance(review_source, dict):
        errors.append("lane_continuation.review_source must be a mapping")
    else:
        if review_source.get("skill") != "review-orchestrator":
            errors.append("lane_continuation.review_source.skill must be 'review-orchestrator'")
        if review_source.get("mode") != "targeted-return-review":
            errors.append("lane_continuation.review_source.mode must be 'targeted-return-review'")
    if not isinstance(review_handoff, dict):
        errors.append("lane_continuation.review_handoff must be a mapping")
    else:
        handoff_families = review_handoff.get("families")
        if not isinstance(handoff_families, list):
            errors.append("lane_continuation.review_handoff.families must be a list")
        else:
            handoff_family_ids = sorted(
                str(family.get("family_id") or "")
                for family in handoff_families
                if isinstance(family, dict) and family.get("family_id")
            )
            if sorted(family_ids) != handoff_family_ids:
                errors.append("lane_continuation.review_handoff families must match lane_continuation.family_ids exactly")
        handoff_packet_metadata = review_handoff.get("current_work_review_packet")
        if current_work_metadata is not None and not current_work_packet_metadata_matches(
            current_work_metadata,
            handoff_packet_metadata,
        ):
            errors.append(
                "lane_continuation.current_work_review_packet must match lane_continuation.review_handoff.current_work_review_packet"
            )
        if current_work_metadata is None and isinstance(handoff_packet_metadata, dict):
            current_work_metadata = handoff_packet_metadata

    if current_work_metadata is not None and not isinstance(current_work_metadata, dict):
        errors.append("lane_continuation.current_work_review_packet must be a mapping when present")

    if args.lane_plan_json:
        lane_plan = load_json_object(pathlib.Path(args.lane_plan_json))
        slices = lane_plan.get("slices")
        if not isinstance(slices, list):
            errors.append("lane plan must contain a slices list")
        else:
            planned_lane = next(
                (
                    slice_entry
                    for slice_entry in slices
                    if isinstance(slice_entry, dict) and str(slice_entry.get("lane_id") or "") == str(lane_id or "")
                ),
                None,
            )
            if planned_lane is None:
                errors.append("lane_continuation.lane_id was not found in the provided lane plan")
            else:
                planned_family_ids = normalize_string_list(planned_lane.get("family_ids"))
                if sorted(planned_family_ids) != sorted(original_lane_family_ids):
                    errors.append(
                        "lane_continuation.original_lane_family_ids do not match the provided lane plan"
                    )
                planned_family_metadata = normalize_family_metadata_list(planned_lane.get("family_metadata"))
                if planned_family_metadata and planned_family_metadata != original_lane_family_metadata:
                    errors.append(
                        "lane_continuation.original_lane_family_metadata does not match the provided lane plan"
                    )
                planned_packet_metadata = planned_lane.get("current_work_review_packet")
                if planned_packet_metadata is not None and not current_work_packet_metadata_matches(
                    planned_packet_metadata,
                    current_work_metadata,
                ):
                    errors.append(
                        "lane_continuation.current_work_review_packet does not match the provided lane plan"
                    )

    if args.expected_lane_id and lane_id != args.expected_lane_id:
        errors.append("lane_continuation.lane_id does not match the expected lane id")
    if args.expected_worker_session_id and worker_session_id != args.expected_worker_session_id:
        errors.append("lane_continuation.worker_session_id does not match the expected worker session id")
    if args.expected_slice_id and slice_id != args.expected_slice_id:
        errors.append("lane_continuation.slice_id does not match the expected slice id")

    output = {
        "status": "ok" if not errors else "error",
        "lane_id": lane_id,
        "worker_session_id": worker_session_id,
        "slice_id": slice_id,
        "family_ids": family_ids,
        "original_lane_family_ids": original_lane_family_ids,
        "original_lane_family_metadata": original_lane_family_metadata,
        "return_review_round": return_review_round,
        "errors": errors,
    }
    if isinstance(current_work_metadata, dict):
        output["current_work_review_packet"] = current_work_metadata
        packet_id = current_work_metadata.get("packet_id")
        if isinstance(packet_id, str) and packet_id.strip():
            output["current_work_packet_id"] = packet_id
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0 if not errors else 2


def validate_review_return(args: argparse.Namespace) -> int:
    data = unwrap_root(load_json_object(pathlib.Path(args.review_return_handoff)), "review_return_handoff")
    review_data: dict[str, Any] | None = None
    if args.review_handoff:
        review_data = unwrap_root(load_json_object(pathlib.Path(args.review_handoff)), "review_handoff")

    errors: list[str] = []
    warnings: list[str] = []

    original_review_target = data.get("original_review_target")
    if not isinstance(original_review_target, dict):
        errors.append("review_return_handoff missing original_review_target mapping")

    families = data.get("families")
    if not isinstance(families, list):
        errors.append("review_return_handoff.families must be a list")
        families = []

    review_family_ids: set[str] = set()
    original_family_index: dict[str, dict[str, Any]] = {}
    if review_data and isinstance(review_data.get("families"), list):
        for review_family in review_data["families"]:
            if isinstance(review_family, dict) and review_family.get("family_id"):
                family_id = str(review_family.get("family_id"))
                review_family_ids.add(family_id)
                original_family_index[family_id] = review_family

    handled_touched_paths: set[str] = set()

    for entry in families:
        if not isinstance(entry, dict):
            errors.append("family entry must be a mapping")
            continue
        validate_family_entry(entry, errors, warnings)
        handled_touched_paths.update(family_entry_touched_paths(entry))
        if review_family_ids:
            family_id = str(entry.get("original_family_id") or "")
            if family_id and family_id not in review_family_ids:
                errors.append(f"family {family_id} has no matching family_id in review_handoff")

    deferred_families = data.get("deferred_families")
    if deferred_families not in (None, "none"):
        if not isinstance(deferred_families, list):
            errors.append("review_return_handoff.deferred_families must be a list or none")
        else:
            for entry in deferred_families:
                if not isinstance(entry, dict):
                    errors.append("deferred family entry must be a mapping")
                    continue
                original_family = None
                family_id = str(entry.get("family_id") or "")
                if family_id:
                    original_family = original_family_index.get(family_id)
                validate_deferred_family(
                    entry,
                    original_family,
                    {
                        str(family_entry.get("original_family_id"))
                        for family_entry in families
                        if isinstance(family_entry, dict) and family_entry.get("original_family_id")
                    },
                    handled_touched_paths,
                    errors,
                    warnings,
                )
                if review_family_ids:
                    if family_id and family_id not in review_family_ids:
                        errors.append(f"deferred family {family_id} has no matching family_id in review_handoff")

    output = {
        "mode": "fixer-orchestrator",
        "validation": "review_return_handoff",
        "status": "ok" if not errors else "error",
        "warnings": warnings,
        "errors": errors,
    }
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0 if not errors else 2


def init_trace(args: argparse.Namespace) -> int:
    project_root = pathlib.Path(args.project_root).resolve()
    trace_root = resolve_trace_root(project_root, args.trace_root)
    trace_root.mkdir(parents=True, exist_ok=True)

    run_id = args.run_id or default_run_id()
    campaign_id = run_id
    active = load_active_campaign(trace_root)
    resumed = False

    if active and active.get("state") == "active":
        active_type = str(active.get("campaign_type") or "")
        active_campaign_id = str(active.get("campaign_id") or "")
        active_run_id = str(active.get("run_id") or active_campaign_id)
        if active_type != FIXER_CAMPAIGN_TYPE:
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
                        "reason": "concurrent-fixer-run",
                        "message": "a fixer campaign is already active for this worktree",
                        "active_campaign": active,
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
            return 2
        run_id = active_run_id
        campaign_id = active_campaign_id
        resumed = True
    else:
        owner_metadata = campaign_owner_metadata(args)
        write_active_campaign(
            trace_root,
            {
                "campaign_id": campaign_id,
                "campaign_type": FIXER_CAMPAIGN_TYPE,
                "run_id": run_id,
                "state": "active",
                "worktree_root": str(project_root),
                "started_at_utc": utc_now_iso(),
                **owner_metadata,
            },
        )

    trace_dir = trace_root / run_id
    trace_dir.mkdir(parents=True, exist_ok=True)
    coordinator_file = trace_dir / "coordinator.jsonl"
    if not coordinator_file.exists() or coordinator_file.stat().st_size == 0:
        coordinator_file.write_text(
            json.dumps(
                {
                    "run_id": run_id,
                    "timestamp_utc": utc_now_iso(),
                    "skill": FIXER_CAMPAIGN_TYPE,
                    "mode": "native-intake",
                    "phase": "trace_started",
                    "review_target": {
                        "mode": "unknown",
                        "scope_summary": "pending intake",
                    },
                },
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
    print(
        json.dumps(
            {
                "campaign_id": campaign_id,
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
    errors.extend(validate_trace_record_against_history(record, trace_file))
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
    trace_root = trace_file.parent.parent
    active_cleared = False
    if str(record.get("phase") or "") == "final_fix":
        active_cleared = clear_active_campaign(trace_root, str(record.get("run_id") or ""))
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
                "active_campaign_cleared": active_cleared,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Deterministic helper for fixer-orchestrator output validation."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser(
        "init-trace",
        help="Create or resume the fixer run trace directory and coordinator file.",
    )
    init.add_argument("--trace-root", default=".coortex/review-trace")
    init.add_argument("--project-root", default=".")
    init.add_argument("--run-id")
    init.add_argument("--owner-host-session-id")
    init.add_argument("--owner-started-from-cwd")
    init.set_defaults(func=init_trace)

    lane_file = subparsers.add_parser(
        "lane-trace-file",
        help="Create or resolve a lane trace filename inside a fixer run directory.",
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

    plan_batches = subparsers.add_parser(
        "plan-repair-slices",
        help="Derive deterministic repair slices and execution waves from a review_handoff.",
    )
    plan_batches.add_argument(
        "--review-handoff",
        required=True,
        help="Path to the review_handoff JSON file.",
    )
    plan_batches.add_argument(
        "--family-id",
        action="append",
        help="Optional family_id filter; repeat to narrow the plan to specific families.",
    )
    plan_batches.set_defaults(func=plan_repair_slices)

    continuation = subparsers.add_parser(
        "build-lane-continuation",
        help="Build a lane-local continuation packet from a refreshed actionable review_handoff.",
    )
    continuation.add_argument(
        "--review-handoff",
        required=True,
        help="Path to the refreshed actionable review_handoff JSON file.",
    )
    continuation.add_argument(
        "--lane-plan-json",
        required=True,
        help="Path to the JSON output from plan-repair-slices.",
    )
    continuation.add_argument("--lane-id", required=True)
    continuation.add_argument("--worker-session-id", required=True)
    continuation.add_argument("--reviewer-run-id")
    continuation.add_argument("--return-review-round", required=True, type=int)
    continuation.set_defaults(func=build_lane_continuation)

    validate_continuation = subparsers.add_parser(
        "validate-lane-continuation",
        help="Validate a lane-local continuation packet before resuming the same implementer lane.",
    )
    validate_continuation.add_argument(
        "--lane-continuation",
        required=True,
        help="Path to the lane_continuation JSON file.",
    )
    validate_continuation.add_argument("--expected-lane-id")
    validate_continuation.add_argument("--expected-worker-session-id")
    validate_continuation.add_argument("--expected-slice-id")
    validate_continuation.add_argument("--lane-plan-json")
    validate_continuation.set_defaults(func=validate_lane_continuation)

    validate = subparsers.add_parser(
        "validate-review-return",
        help="Validate review_return_handoff structure and deferred-family state.",
    )
    validate.add_argument(
        "--review-return-handoff",
        required=True,
        help="Path to the review_return_handoff JSON file.",
    )
    validate.add_argument(
        "--review-handoff",
        help="Optional path to the original review_handoff JSON file for family-id mapping checks.",
    )
    validate.set_defaults(func=validate_review_return)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
