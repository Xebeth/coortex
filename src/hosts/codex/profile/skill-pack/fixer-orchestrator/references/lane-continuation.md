# Lane Continuation Packet

Use this packet when `$review-orchestrator` targeted return review leaves one or
more actionable families in a fixer lane.

The goal is to keep the family with the **same original implementer lane**
instead of closing that worker and starting from scratch.

Build it with the bundled helper:

```bash
python scripts/fix_result_state.py build-lane-continuation \
  --review-handoff <path> \
  --lane-plan-json <path> \
  --lane-id <lane_id> \
  --worker-session-id <worker_session_id> \
  --reviewer-run-id <reviewer_run_id> \
  --return-review-round <n>

python scripts/fix_result_state.py validate-lane-continuation \
  --lane-continuation <path> \
  --lane-plan-json <path> \
  --expected-lane-id <lane_id> \
  --expected-worker-session-id <worker_session_id> \
  --expected-slice-id <slice_id>
```

## Shape

```yaml
lane_continuation:
  lane_id: L-001
  worker_session_id: worker-17
  slice_id: S-001
  family_ids:
    - F-001
  original_lane_family_ids:
    - F-001
    - F-002
  original_lane_family_metadata:
    - family_id: F-001
      title: "Actionable family"
      likely_owning_seam: src/core/reclaim.ts
      identity_token: "F-001::Actionable family::src/core/reclaim.ts"
    - family_id: F-002
      title: "Sibling family"
      likely_owning_seam: src/core/reclaim.ts
      identity_token: "F-002::Sibling family::src/core/reclaim.ts"
  continuation_policy: same-lane-until-approved
  return_review_round: 2
  review_source:
    skill: review-orchestrator
    mode: targeted-return-review
    reviewer_run_id: review-orchestrator-return-review-20260420T180000Z
  review_handoff:
    review_target:
      mode: branch
      scope_summary: "branch delta against origin/main"
    families:
      - family_id: F-001
        ...
```

## Rules

- Build this packet only from a **refreshed actionable** `review_handoff`
  returned by targeted return review.
- `family_ids` should contain the actionable subset that still belongs to the
  lane after return review.
- `original_lane_family_ids` should preserve the lane's full original family
  membership so the worker can verify that the actionable subset still belongs
  to the same lane.
- `original_lane_family_metadata` should preserve the original lane-local family
  identity snapshot so the worker can check it is receiving the correct family
  lineage rather than an unrelated payload.
- The packet must route back to the same `worker_session_id` that handled the
  lane previously.
- `return_review_round` should increment each time targeted return review sends
  the family back for rework.
- Do not use this packet to reassign a family to a different worker unless the
  workflow has a genuine blocker or explicit operator override.
- A valid packet means the receiving **same worker** should resume its existing
  lane-local context for that family lane.
- Do not respawn a replacement worker for the same family lane just because
  targeted return review found more work.
- Do not restart the lane from scratch after a valid continuation packet lands.
- This packet is fixer-local continuation state. It does not replace the
  authoritative `review_handoff` or `review_return_handoff` artifacts.
- The receiving worker should validate the packet before resuming so it can
  reject mismatched lane, worker, slice, or family metadata.
- When the original lane plan JSON is available, pass it to
  `validate-lane-continuation` so the helper can deterministically prove that
  the continuation packet still matches the original lane family ids and
  metadata.
