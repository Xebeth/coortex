import test from "node:test";
import assert from "node:assert/strict";

import {
  materializeInspectableRunRecord,
  materializeInspectableRunRecords
} from "../adapters/host-run-inspection.js";
import type { HostRunArtifactInspection } from "../adapters/host-run-lease-repository.js";
import type { HostRunRecord } from "../core/types.js";

test("materializeInspectableRunRecords keeps matching authoritative inspections", () => {
  const completedRecord: HostRunRecord = {
    assignmentId: "assignment-running",
    state: "completed",
    startedAt: "2026-04-19T03:00:00.000Z",
    completedAt: "2026-04-19T03:02:00.000Z",
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Finished cleanly.",
    terminalOutcome: {
      kind: "result",
      result: {
        producerId: "codex",
        status: "completed",
        summary: "Finished cleanly.",
        changedFiles: [],
        createdAt: "2026-04-19T03:02:00.000Z"
      }
    }
  };
  const mismatchedRunRecord: HostRunRecord = {
    assignmentId: "other-assignment",
    state: "completed",
    startedAt: "2026-04-19T04:00:00.000Z",
    completedAt: "2026-04-19T04:02:00.000Z",
    outcomeKind: "result",
    resultStatus: "completed",
    summary: "Finished elsewhere.",
    terminalOutcome: {
      kind: "result",
      result: {
        producerId: "codex",
        status: "completed",
        summary: "Finished elsewhere.",
        changedFiles: [],
        createdAt: "2026-04-19T04:02:00.000Z"
      }
    }
  };
  const inspections: HostRunArtifactInspection[] = [
    {
      assignmentId: "assignment-running",
      runRecord: completedRecord,
      lease: { state: "missing" }
    },
    {
      assignmentId: "assignment-mismatch",
      runRecord: mismatchedRunRecord,
      lease: { state: "missing" }
    }
  ];

  assert.deepEqual(materializeInspectableRunRecords(inspections), [completedRecord]);
});

test("materializeInspectableRunRecords keeps malformed lease blockers by default", () => {
  const inspection: HostRunArtifactInspection = {
    assignmentId: "assignment-malformed",
    lease: {
      state: "malformed",
      raw: "{"
    }
  };

  const record = materializeInspectableRunRecord(inspection);
  assert.equal(record?.assignmentId, "assignment-malformed");
  assert.equal(record?.staleReasonCode, "malformed_lease_artifact");
  assert.deepEqual(materializeInspectableRunRecords([inspection]), [record]);
});

test("materializeInspectableRunRecord preserves malformed lease blockers on running records", () => {
  const runningRecord: HostRunRecord = {
    assignmentId: "assignment-running-malformed",
    state: "running",
    startedAt: "2026-04-19T05:00:00.000Z",
    heartbeatAt: "2026-04-19T05:01:00.000Z",
    leaseExpiresAt: "2026-04-19T05:10:00.000Z"
  };
  const inspection: HostRunArtifactInspection = {
    assignmentId: "assignment-running-malformed",
    runRecord: runningRecord,
    lease: {
      state: "malformed",
      raw: "{"
    }
  };

  const record = materializeInspectableRunRecord(inspection);
  assert.deepEqual(record, {
    ...runningRecord,
    staleReasonCode: "malformed_lease_artifact",
    staleReason: "malformed lease file"
  });
  assert.deepEqual(materializeInspectableRunRecords([inspection]), [record]);
});

test("materializeInspectableRunRecord preserves malformed lease blockers on stale completed records", () => {
  const staleCompletedRecord: HostRunRecord = {
    assignmentId: "assignment-completed-malformed",
    state: "completed",
    startedAt: "2026-04-19T05:00:00.000Z",
    completedAt: "2026-04-19T05:02:00.000Z",
    staleAt: "2026-04-19T05:02:00.000Z",
    staleReasonCode: "expired_lease",
    staleReason: "Run lease expired at 2000-01-01T00:00:00.000Z."
  };
  const inspection: HostRunArtifactInspection = {
    assignmentId: "assignment-completed-malformed",
    runRecord: staleCompletedRecord,
    lease: {
      state: "malformed",
      raw: "{"
    }
  };

  const record = materializeInspectableRunRecord(inspection);
  assert.deepEqual(record, {
    ...staleCompletedRecord,
    staleReasonCode: "malformed_lease_artifact",
    staleReason: "malformed lease file"
  });
  assert.deepEqual(materializeInspectableRunRecords([inspection]), [record]);
});

test("materializeInspectableRunRecord ignores mismatched run records and keeps the matching lease", () => {
  const leaseRecord: HostRunRecord = {
    assignmentId: "assignment-1",
    state: "running",
    startedAt: "2026-04-19T05:00:00.000Z",
    leaseExpiresAt: "2099-04-19T05:10:00.000Z"
  };
  const inspection: HostRunArtifactInspection = {
    assignmentId: "assignment-1",
    runRecord: {
      assignmentId: "assignment-2",
      state: "completed",
      startedAt: "2026-04-19T04:00:00.000Z",
      completedAt: "2026-04-19T04:02:00.000Z",
      outcomeKind: "result",
      resultStatus: "completed",
      summary: "Finished elsewhere.",
      terminalOutcome: {
        kind: "result",
        result: {
          producerId: "codex",
          status: "completed",
          summary: "Finished elsewhere.",
          changedFiles: [],
          createdAt: "2026-04-19T04:02:00.000Z"
        }
      }
    },
    lease: {
      state: "valid",
      record: leaseRecord
    }
  };

  assert.deepEqual(materializeInspectableRunRecord(inspection), leaseRecord);
});
