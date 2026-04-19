import test from "node:test";
import assert from "node:assert/strict";

import type {
  Assignment,
  ResultPacket,
  RuntimeProjection,
  RuntimeStatus,
  WorkflowProgressRecord
} from "../core/types.js";
import type { RuntimeEvent } from "../core/events.js";
import type { WorkflowArtifactDocument, WorkflowArtifactStore } from "../workflows/types.js";
import { buildRecoveryBrief } from "../recovery/brief.js";
import {
  buildWorkflowBootstrap,
  deriveWorkflowStatus,
  deriveWorkflowSummary,
  evaluateWorkflowProgression,
  workflowArtifactPath
} from "../workflows/index.js";
import {
  applyRuntimeEvent,
  createEmptyProjection,
  projectRuntimeState
} from "../projections/runtime-projection.js";

class StaticWorkflowArtifactStore implements WorkflowArtifactStore {
  constructor(private readonly artifacts = new Map<string, WorkflowArtifactDocument>()) {}

  async readJsonArtifact<T>(relativePath: string): Promise<T | undefined> {
    return this.artifacts.get(relativePath) as T | undefined;
  }
}

test("workflow progression consumes a stale run fact once its rerun attempt is durable", async () => {
  const timestamp = "2026-04-14T12:00:00.000Z";
  const bootstrap = buildWorkflowBootstrap({
    sessionId: "session-workflow-stale",
    adapterId: "codex",
    host: "codex",
    timestamp
  });
  const projection = projectRuntimeState(
    "session-workflow-stale",
    "/tmp/project",
    "codex",
    bootstrap.events
  );

  const firstPass = await evaluateWorkflowProgression(
    projection,
    new StaticWorkflowArtifactStore(),
    {
      timestamp,
      staleRunFacts: [{ assignmentId: bootstrap.initialAssignmentId, staleAt: timestamp }]
    }
  );
  const firstTransition = getTransitionEvent(firstPass.events);

  assert.equal(firstTransition?.payload.transition, "rerun_same_module");
  assert.equal(firstTransition?.payload.moduleAttempt, 2);

  for (const event of firstPass.events) {
    applyRuntimeEvent(projection, event);
  }

  assert.equal(projection.workflowProgress?.currentModuleAttempt, 2);

  const secondPass = await evaluateWorkflowProgression(
    projection,
    new StaticWorkflowArtifactStore(),
    {
      timestamp,
      staleRunFacts: [{ assignmentId: bootstrap.initialAssignmentId, staleAt: timestamp }]
    }
  );

  assert.deepEqual(secondPass.events, []);
});

test("workflow progression blocks review advancement when the current cycle has no claimed plan artifact", async () => {
  const projection = createWorkflowProjection({
    currentModuleId: "review",
    workflowCycle: 1,
    currentModuleAttempt: 1,
    currentAssignment: createWorkflowAssignment(
      "review-assignment",
      "default",
      "Assess the latest accepted plan artifact carried into the current cycle and produce a review verdict.",
      "in_progress",
      "2026-04-14T12:10:00.000Z"
    ),
    currentResult: {
      resultId: "review-result",
      assignmentId: "review-assignment",
      producerId: "codex",
      status: "completed",
      summary: "Review finished.",
      changedFiles: [],
      createdAt: "2026-04-14T12:12:00.000Z"
    },
    moduleRecords: {
      plan: {
        moduleId: "plan",
        workflowCycle: 1,
        moduleAttempt: 1,
        assignmentId: "plan-assignment",
        moduleState: "completed",
        gateOutcome: "ready_for_review",
        sourceResultIds: ["plan-result"],
        sourceDecisionIds: [],
        artifactReferences: [],
        enteredAt: "2026-04-14T12:00:00.000Z",
        evaluatedAt: "2026-04-14T12:05:00.000Z",
        checklistStatus: "complete",
        evidenceSummary: "Plan is ready for review."
      },
      review: {
        moduleId: "review",
        workflowCycle: 1,
        moduleAttempt: 1,
        assignmentId: "review-assignment",
        moduleState: "in_progress",
        sourceResultIds: [],
        sourceDecisionIds: [],
        artifactReferences: [],
        enteredAt: "2026-04-14T12:10:00.000Z"
      }
    }
  });
  const reviewArtifactPath = workflowArtifactPath(
    "default",
    1,
    "review",
    "review-assignment",
    1
  );
  const store = new StaticWorkflowArtifactStore(
    new Map([
      [
        reviewArtifactPath,
        {
          workflowId: "default",
          workflowCycle: 1,
          moduleId: "review",
          moduleAttempt: 1,
          assignmentId: "review-assignment",
          createdAt: "2026-04-14T12:12:00.000Z",
          payload: {
            verdict: "approved",
            rationaleSummary: "The plan is acceptable."
          }
        }
      ]
    ])
  );

  const progression = await evaluateWorkflowProgression(projection, store, {
    timestamp: "2026-04-14T12:12:01.000Z"
  });
  const gate = getGateEvent(progression.events);
  const transition = getTransitionEvent(progression.events);

  assert.equal(gate?.payload.gateOutcome, "blocked");
  assert.equal(transition?.payload.transition, "rerun_same_module");
  assert.equal(transition?.payload.toModuleId, "review");
});

test("workflow progression carries forward the latest accepted plan artifact after verify failure rewinds to review", async () => {
  const timestamp = "2026-04-15T11:00:00.000Z";
  const bootstrap = buildWorkflowBootstrap({
    sessionId: "session-workflow-verify-failed-review-recovery",
    adapterId: "codex",
    host: "codex",
    timestamp
  });
  const projection = projectRuntimeState(
    "session-workflow-verify-failed-review-recovery",
    "/tmp/project",
    "codex",
    bootstrap.events
  );
  const artifacts = new Map<string, WorkflowArtifactDocument>();
  const store = new StaticWorkflowArtifactStore(artifacts);

  const advanceModule = async (input: {
    assignmentId: string;
    stateAt: string;
    resultId: string;
    resultSummary: string;
    resultAt: string;
    artifact: WorkflowArtifactDocument;
    progressionAt: string;
  }) => {
    applyRuntimeEvent(projection, {
      eventId: `${input.assignmentId}-in-progress`,
      sessionId: projection.sessionId,
      timestamp: input.stateAt,
      type: "assignment.updated",
      payload: {
        assignmentId: input.assignmentId,
        patch: {
          state: "in_progress",
          updatedAt: input.stateAt
        }
      }
    });
    applyRuntimeEvent(projection, {
      eventId: input.resultId,
      sessionId: projection.sessionId,
      timestamp: input.resultAt,
      type: "result.submitted",
      payload: {
        result: {
          resultId: input.resultId,
          assignmentId: input.assignmentId,
          producerId: "codex",
          status: "completed",
          summary: input.resultSummary,
          changedFiles: [],
          createdAt: input.resultAt
        }
      }
    });
    artifacts.set(
      workflowArtifactPath(
        input.artifact.workflowId,
        input.artifact.workflowCycle,
        input.artifact.moduleId,
        input.artifact.assignmentId,
        input.artifact.moduleAttempt
      ),
      input.artifact
    );
    const progression = await evaluateWorkflowProgression(projection, store, {
      timestamp: input.progressionAt
    });
    for (const event of progression.events) {
      applyRuntimeEvent(projection, event);
    }
    return progression;
  };

  const planAssignmentId = bootstrap.initialAssignmentId;
  const planArtifactPath = workflowArtifactPath("default", 1, "plan", planAssignmentId, 1);
  await advanceModule({
    assignmentId: planAssignmentId,
    stateAt: "2026-04-15T11:01:00.000Z",
    resultId: "plan-result-carry-forward",
    resultSummary: "Plan completed.",
    resultAt: "2026-04-15T11:02:00.000Z",
    artifact: {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "plan",
      moduleAttempt: 1,
      assignmentId: planAssignmentId,
      createdAt: "2026-04-15T11:02:00.000Z",
      payload: {
        planSummary: "Plan ready for review.",
        implementationSteps: ["Carry the plan across verify failure."],
        reviewEvidenceSummary: "The plan stays authoritative after verify rewinds."
      }
    },
    progressionAt: "2026-04-15T11:02:01.000Z"
  });

  const reviewAssignmentId = projection.workflowProgress?.currentAssignmentId;
  assert.ok(reviewAssignmentId, "expected a review assignment after plan advancement");
  await advanceModule({
    assignmentId: reviewAssignmentId,
    stateAt: "2026-04-15T11:03:00.000Z",
    resultId: "review-result-cycle-1",
    resultSummary: "Review approved the plan.",
    resultAt: "2026-04-15T11:04:00.000Z",
    artifact: {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "review",
      moduleAttempt: 1,
      assignmentId: reviewAssignmentId,
      createdAt: "2026-04-15T11:04:00.000Z",
      payload: {
        verdict: "approved",
        rationaleSummary: "The carried-forward plan is approved."
      }
    },
    progressionAt: "2026-04-15T11:04:01.000Z"
  });

  const verifyAssignmentId = projection.workflowProgress?.currentAssignmentId;
  assert.ok(verifyAssignmentId, "expected a verify assignment after review approval");
  const verifyFailure = await advanceModule({
    assignmentId: verifyAssignmentId,
    stateAt: "2026-04-15T11:05:00.000Z",
    resultId: "verify-result-cycle-1-failed",
    resultSummary: "Verification failed and should rewind to review.",
    resultAt: "2026-04-15T11:06:00.000Z",
    artifact: {
      workflowId: "default",
      workflowCycle: 1,
      moduleId: "verify",
      moduleAttempt: 1,
      assignmentId: verifyAssignmentId,
      createdAt: "2026-04-15T11:06:00.000Z",
      payload: {
        verdict: "failed",
        verificationSummary: "Verification failed but the plan remains authoritative.",
        evidenceResultIds: ["review-result-cycle-1"]
      }
    },
    progressionAt: "2026-04-15T11:06:01.000Z"
  });
  const rewindTransition = getTransitionEvent(verifyFailure.events);

  assert.equal(rewindTransition?.payload.transition, "rewind");
  assert.equal(rewindTransition?.payload.toModuleId, "review");
  assert.equal(projection.workflowProgress?.workflowCycle, 2);
  assert.equal(projection.workflowProgress?.currentModuleId, "review");
  assert.deepEqual(deriveWorkflowSummary(projection)?.readArtifacts, [
    `.coortex/${planArtifactPath}`
  ]);

  const rewoundReviewAssignmentId = projection.workflowProgress?.currentAssignmentId;
  assert.ok(rewoundReviewAssignmentId, "expected a rewound review assignment");
  const rewoundReview = await advanceModule({
    assignmentId: rewoundReviewAssignmentId,
    stateAt: "2026-04-15T11:07:00.000Z",
    resultId: "review-result-cycle-2",
    resultSummary: "Review approved after verify failure.",
    resultAt: "2026-04-15T11:08:00.000Z",
    artifact: {
      workflowId: "default",
      workflowCycle: 2,
      moduleId: "review",
      moduleAttempt: 1,
      assignmentId: rewoundReviewAssignmentId,
      createdAt: "2026-04-15T11:08:00.000Z",
      payload: {
        verdict: "approved",
        rationaleSummary: "The carried-forward plan still passes review."
      }
    },
    progressionAt: "2026-04-15T11:08:01.000Z"
  });
  const rewoundReviewGate = getGateEvent(rewoundReview.events);
  const rewoundReviewTransition = getTransitionEvent(rewoundReview.events);

  assert.equal(rewoundReviewGate?.payload.gateOutcome, "approved");
  assert.equal(rewoundReviewTransition?.payload.transition, "advance");
  assert.equal(rewoundReviewTransition?.payload.toModuleId, "verify");
  assert.equal(projection.workflowProgress?.currentModuleId, "verify");
  assert.equal(projection.workflowProgress?.workflowCycle, 2);
});

test("workflow progression blocks verify advancement when the approved review artifact is not from the current cycle", async () => {
  const verifyAssignment = createWorkflowAssignment(
    "verify-assignment",
    "default",
    "Verify the latest approved review state against current-cycle durable evidence.",
    "in_progress",
    "2026-04-14T13:10:00.000Z"
  );
  const verifyResult: ResultPacket = {
    resultId: "verify-result",
    assignmentId: verifyAssignment.id,
    producerId: "codex",
    status: "completed",
    summary: "Verification finished.",
    changedFiles: [],
    createdAt: "2026-04-14T13:13:00.000Z"
  };
  const evidenceResult: ResultPacket = {
    resultId: "evidence-result",
    assignmentId: "review-assignment",
    producerId: "codex",
    status: "completed",
    summary: "Approved review evidence.",
    changedFiles: [],
    createdAt: "2026-04-14T13:12:00.000Z"
  };
  const projection = createWorkflowProjection({
    currentModuleId: "verify",
    workflowCycle: 2,
    currentModuleAttempt: 1,
    currentAssignment: verifyAssignment,
    currentResult: verifyResult,
    extraResults: [evidenceResult],
    moduleRecords: {
      review: {
        moduleId: "review",
        workflowCycle: 1,
        moduleAttempt: 1,
        assignmentId: "review-assignment",
        moduleState: "completed",
        gateOutcome: "approved",
        sourceResultIds: ["review-result"],
        sourceDecisionIds: [],
        artifactReferences: [
          {
            path: ".coortex/runtime/workflows/default/cycles/1/review/review-assignment/attempt-1.json",
            format: "json",
            digest: "review-digest",
            sourceResultId: "review-result"
          }
        ],
        enteredAt: "2026-04-14T12:00:00.000Z",
        evaluatedAt: "2026-04-14T12:05:00.000Z",
        checklistStatus: "complete",
        evidenceSummary: "Review approved."
      },
      verify: {
        moduleId: "verify",
        workflowCycle: 2,
        moduleAttempt: 1,
        assignmentId: verifyAssignment.id,
        moduleState: "in_progress",
        sourceResultIds: [],
        sourceDecisionIds: [],
        artifactReferences: [],
        enteredAt: "2026-04-14T13:10:00.000Z"
      }
    }
  });
  const verifyArtifactPath = workflowArtifactPath(
    "default",
    2,
    "verify",
    verifyAssignment.id,
    1
  );
  const store = new StaticWorkflowArtifactStore(
    new Map([
      [
        verifyArtifactPath,
        {
          workflowId: "default",
          workflowCycle: 2,
          moduleId: "verify",
          moduleAttempt: 1,
          assignmentId: verifyAssignment.id,
          createdAt: "2026-04-14T13:13:00.000Z",
          payload: {
            verdict: "verified",
            verificationSummary: "Verification completed successfully.",
            evidenceResultIds: [evidenceResult.resultId]
          }
        }
      ]
    ])
  );

  const progression = await evaluateWorkflowProgression(projection, store, {
    timestamp: "2026-04-14T13:13:01.000Z"
  });
  const gate = getGateEvent(progression.events);
  const transition = getTransitionEvent(progression.events);

  assert.equal(gate?.payload.gateOutcome, "blocked");
  assert.equal(transition?.payload.transition, "rerun_same_module");
  assert.equal(transition?.payload.toModuleId, "verify");
});

test("workflow replay does not mark a module completed when the gate persisted but the transition did not", async () => {
  const timestamp = "2026-04-15T12:00:00.000Z";
  const bootstrap = buildWorkflowBootstrap({
    sessionId: "session-workflow-gate-without-transition",
    adapterId: "codex",
    host: "codex",
    timestamp
  });
  const projection = projectRuntimeState(
    "session-workflow-gate-without-transition",
    "/tmp/project",
    "codex",
    bootstrap.events
  );
  const assignmentId = bootstrap.initialAssignmentId;
  const inProgressAt = "2026-04-15T12:01:00.000Z";
  applyRuntimeEvent(projection, {
    eventId: "assignment-in-progress",
    sessionId: projection.sessionId,
    timestamp: inProgressAt,
    type: "assignment.updated",
    payload: {
      assignmentId,
      patch: {
        state: "in_progress",
        updatedAt: inProgressAt
      }
    }
  });
  applyRuntimeEvent(projection, {
    eventId: "result-plan-ready",
    sessionId: projection.sessionId,
    timestamp: "2026-04-15T12:02:00.000Z",
    type: "result.submitted",
    payload: {
      result: {
        resultId: "result-plan-ready",
        assignmentId,
        producerId: "codex",
        status: "completed",
        summary: "Plan ready for review.",
        changedFiles: [],
        createdAt: "2026-04-15T12:02:00.000Z"
      }
    }
  });

  const artifactPath = workflowArtifactPath("default", 1, "plan", assignmentId, 1);
  const store = new StaticWorkflowArtifactStore(
    new Map([
      [
        artifactPath,
        {
          workflowId: "default",
          workflowCycle: 1,
          moduleId: "plan",
          moduleAttempt: 1,
          assignmentId,
          createdAt: "2026-04-15T12:02:00.000Z",
          payload: {
            planSummary: "Plan ready for review.",
            implementationSteps: ["Validate the gate."],
            reviewEvidenceSummary: "All required plan evidence exists."
          }
        }
      ]
    ])
  );

  const progression = await evaluateWorkflowProgression(projection, store, {
    timestamp: "2026-04-15T12:02:01.000Z"
  });
  const persistedWithoutTransition = progression.events.filter((event) =>
    event.type !== "workflow.transition.applied" && event.type !== "assignment.created"
  );
  for (const event of persistedWithoutTransition) {
    applyRuntimeEvent(projection, event);
  }

  const summary = deriveWorkflowSummary(projection);

  assert.equal(projection.workflowProgress?.currentModuleId, "plan");
  assert.equal(projection.workflowProgress?.modules.plan?.moduleState, "in_progress");
  assert.equal(projection.workflowProgress?.lastGate?.gateOutcome, "ready_for_review");
  assert.equal(summary?.currentModuleId, "plan");
  assert.equal(summary?.currentModuleState, "in_progress");
});

test("workflow progression reuses a durable next assignment when advance transition persistence is interrupted", async () => {
  const timestamp = "2026-04-15T12:30:00.000Z";
  const bootstrap = buildWorkflowBootstrap({
    sessionId: "session-workflow-advance-reuse",
    adapterId: "codex",
    host: "codex",
    timestamp
  });
  const projection = projectRuntimeState(
    "session-workflow-advance-reuse",
    "/tmp/project",
    "codex",
    bootstrap.events
  );
  const assignmentId = bootstrap.initialAssignmentId;
  const inProgressAt = "2026-04-15T12:31:00.000Z";
  applyRuntimeEvent(projection, {
    eventId: "assignment-plan-in-progress-reuse",
    sessionId: projection.sessionId,
    timestamp: inProgressAt,
    type: "assignment.updated",
    payload: {
      assignmentId,
      patch: {
        state: "in_progress",
        updatedAt: inProgressAt
      }
    }
  });
  applyRuntimeEvent(projection, {
    eventId: "result-plan-ready-reuse",
    sessionId: projection.sessionId,
    timestamp: "2026-04-15T12:32:00.000Z",
    type: "result.submitted",
    payload: {
      result: {
        resultId: "result-plan-ready-reuse",
        assignmentId,
        producerId: "codex",
        status: "completed",
        summary: "Plan ready for review.",
        changedFiles: [],
        createdAt: "2026-04-15T12:32:00.000Z"
      }
    }
  });

  const artifactPath = workflowArtifactPath("default", 1, "plan", assignmentId, 1);
  const store = new StaticWorkflowArtifactStore(
    new Map([
      [
        artifactPath,
        {
          workflowId: "default",
          workflowCycle: 1,
          moduleId: "plan",
          moduleAttempt: 1,
          assignmentId,
          createdAt: "2026-04-15T12:32:00.000Z",
          payload: {
            planSummary: "Plan ready for review.",
            implementationSteps: ["Reuse the durable next assignment."],
            reviewEvidenceSummary: "Advance convergence should consume the pre-created review assignment."
          }
        }
      ]
    ])
  );

  const firstPass = await evaluateWorkflowProgression(projection, store, {
    timestamp: "2026-04-15T12:32:01.000Z"
  });
  const createdAssignment = getCreatedAssignmentEvent(firstPass.events);
  assert.ok(createdAssignment, "expected a durable review assignment to be created");
  for (const event of firstPass.events.filter((event) => event.type !== "workflow.transition.applied")) {
    applyRuntimeEvent(projection, event);
  }

  const secondPass = await evaluateWorkflowProgression(projection, store, {
    timestamp: "2026-04-15T12:32:10.000Z"
  });
  const secondTransition = getTransitionEvent(secondPass.events);

  assert.deepEqual(secondPass.events.map((event) => event.type), ["workflow.transition.applied"]);
  assert.equal(secondTransition?.payload.transition, "advance");
  assert.equal(secondTransition?.payload.nextAssignmentId, createdAssignment.payload.assignment.id);

  for (const event of secondPass.events) {
    applyRuntimeEvent(projection, event);
  }

  assert.equal(projection.workflowProgress?.currentModuleId, "review");
  assert.equal(projection.workflowProgress?.currentAssignmentId, createdAssignment.payload.assignment.id);
  assert.equal(projection.assignments.size, 2);
});

test("workflow progression reuses a durable next assignment when rewind transition persistence is interrupted", async () => {
  const verifyAssignment = createWorkflowAssignment(
    "verify-assignment-rewind-reuse",
    "default",
    "Verify the latest approved review state against current-cycle durable evidence.",
    "in_progress",
    "2026-04-15T12:40:00.000Z"
  );
  const reviewResult: ResultPacket = {
    resultId: "review-result-rewind-reuse",
    assignmentId: "review-assignment-rewind-reuse",
    producerId: "codex",
    status: "completed",
    summary: "Approved review evidence.",
    changedFiles: [],
    createdAt: "2026-04-15T12:41:00.000Z"
  };
  const verifyResult: ResultPacket = {
    resultId: "verify-result-rewind-reuse",
    assignmentId: verifyAssignment.id,
    producerId: "codex",
    status: "completed",
    summary: "Verification failed and should rewind.",
    changedFiles: [],
    createdAt: "2026-04-15T12:42:00.000Z"
  };
  const projection = createWorkflowProjection({
    currentModuleId: "verify",
    workflowCycle: 1,
    currentModuleAttempt: 1,
    currentAssignment: verifyAssignment,
    currentResult: verifyResult,
    extraResults: [reviewResult],
    moduleRecords: {
      review: {
        moduleId: "review",
        workflowCycle: 1,
        moduleAttempt: 1,
        assignmentId: "review-assignment-rewind-reuse",
        moduleState: "completed",
        gateOutcome: "approved",
        sourceResultIds: [reviewResult.resultId],
        sourceDecisionIds: [],
        artifactReferences: [
          {
            path: workflowArtifactPath("default", 1, "review", "review-assignment-rewind-reuse", 1),
            format: "json",
            digest: "review-digest-rewind-reuse",
            sourceResultId: reviewResult.resultId
          }
        ],
        enteredAt: "2026-04-15T12:41:00.000Z",
        evaluatedAt: "2026-04-15T12:41:30.000Z",
        checklistStatus: "complete",
        evidenceSummary: "Review approved."
      },
      verify: {
        moduleId: "verify",
        workflowCycle: 1,
        moduleAttempt: 1,
        assignmentId: verifyAssignment.id,
        moduleState: "in_progress",
        sourceResultIds: [],
        sourceDecisionIds: [],
        artifactReferences: [],
        enteredAt: "2026-04-15T12:40:00.000Z"
      }
    }
  });
  const verifyArtifactPath = workflowArtifactPath("default", 1, "verify", verifyAssignment.id, 1);
  const store = new StaticWorkflowArtifactStore(
    new Map([
      [
        verifyArtifactPath,
        {
          workflowId: "default",
          workflowCycle: 1,
          moduleId: "verify",
          moduleAttempt: 1,
          assignmentId: verifyAssignment.id,
          createdAt: "2026-04-15T12:42:00.000Z",
          payload: {
            verdict: "failed",
            verificationSummary: "Verification failed and should rewind to review.",
            evidenceResultIds: [reviewResult.resultId]
          }
        }
      ]
    ])
  );

  const firstPass = await evaluateWorkflowProgression(projection, store, {
    timestamp: "2026-04-15T12:42:01.000Z"
  });
  const createdAssignment = getCreatedAssignmentEvent(firstPass.events);
  assert.ok(createdAssignment, "expected a durable rewound review assignment to be created");
  for (const event of firstPass.events.filter((event) => event.type !== "workflow.transition.applied")) {
    applyRuntimeEvent(projection, event);
  }

  const secondPass = await evaluateWorkflowProgression(projection, store, {
    timestamp: "2026-04-15T12:42:10.000Z"
  });
  const secondTransition = getTransitionEvent(secondPass.events);

  assert.deepEqual(secondPass.events.map((event) => event.type), ["workflow.transition.applied"]);
  assert.equal(secondTransition?.payload.transition, "rewind");
  assert.equal(secondTransition?.payload.nextAssignmentId, createdAssignment.payload.assignment.id);

  for (const event of secondPass.events) {
    applyRuntimeEvent(projection, event);
  }

  assert.equal(projection.workflowProgress?.workflowCycle, 2);
  assert.equal(projection.workflowProgress?.currentModuleId, "review");
  assert.equal(projection.workflowProgress?.currentAssignmentId, createdAssignment.payload.assignment.id);
  assert.equal(
    [...projection.assignments.values()].filter(
      (assignment) =>
        assignment.objective === createdAssignment.payload.assignment.objective
    ).length,
    1
  );
});

test("workflow progression does not reuse a prior-cycle equivalent assignment during advance convergence", async () => {
  const planAssignment = createWorkflowAssignment(
    "plan-assignment-advance-cycle-2",
    "default",
    "Produce the cycle plan artifact and review-ready evidence for the current workflow objective.",
    "in_progress",
    "2026-04-15T12:50:00.000Z"
  );
  const legacyReviewAssignment: Assignment = {
    id: "review-assignment-cycle-1-legacy",
    parentTaskId: "session-workflow",
    workflow: "default",
    ownerType: "host",
    ownerId: "codex",
    objective:
      "Assess the latest accepted plan artifact carried into the current cycle and produce a review verdict.",
    writeScope: ["src/", "docs/"],
    requiredOutputs: ["verdict", "rationaleSummary"],
    state: "queued",
    createdAt: "2026-04-15T12:10:00.000Z",
    updatedAt: "2026-04-15T12:10:00.000Z"
  };
  const planResult: ResultPacket = {
    resultId: "plan-result-advance-cycle-2",
    assignmentId: planAssignment.id,
    producerId: "codex",
    status: "completed",
    summary: "Plan is ready for a new-cycle review assignment.",
    changedFiles: [],
    createdAt: "2026-04-15T12:51:00.000Z"
  };
  const projection = createWorkflowProjection({
    currentModuleId: "plan",
    workflowCycle: 2,
    currentModuleAttempt: 1,
    currentAssignment: planAssignment,
    currentResult: planResult,
    moduleRecords: {
      plan: {
        moduleId: "plan",
        workflowCycle: 2,
        moduleAttempt: 1,
        assignmentId: planAssignment.id,
        moduleState: "in_progress",
        sourceResultIds: [],
        sourceDecisionIds: [],
        artifactReferences: [],
        enteredAt: "2026-04-15T12:50:00.000Z"
      },
      review: {
        moduleId: "review",
        workflowCycle: 1,
        moduleAttempt: 1,
        assignmentId: legacyReviewAssignment.id,
        moduleState: "completed",
        gateOutcome: "approved",
        sourceResultIds: ["review-result-cycle-1"],
        sourceDecisionIds: [],
        artifactReferences: [],
        enteredAt: "2026-04-15T12:10:00.000Z"
      }
    }
  });
  projection.assignments.set(legacyReviewAssignment.id, legacyReviewAssignment);
  const artifactPath = workflowArtifactPath("default", 2, "plan", planAssignment.id, 1);
  const store = new StaticWorkflowArtifactStore(
    new Map([
      [
        artifactPath,
        {
          workflowId: "default",
          workflowCycle: 2,
          moduleId: "plan",
          moduleAttempt: 1,
          assignmentId: planAssignment.id,
          createdAt: "2026-04-15T12:51:00.000Z",
          payload: {
            planSummary: "Plan ready for review.",
            implementationSteps: ["Do not reuse the prior-cycle legacy review assignment."],
            reviewEvidenceSummary: "Advance convergence should create a cycle-2 review assignment."
          }
        }
      ]
    ])
  );

  const progression = await evaluateWorkflowProgression(projection, store, {
    timestamp: "2026-04-15T12:51:01.000Z"
  });
  const transition = getTransitionEvent(progression.events);
  const createdAssignment = getCreatedAssignmentEvent(progression.events);

  assert.ok(createdAssignment, "expected a new review assignment for cycle 2");
  assert.notEqual(createdAssignment.payload.assignment.id, legacyReviewAssignment.id);
  assert.equal(createdAssignment.payload.assignment.workflowAttempt?.workflowCycle, 2);
  assert.equal(createdAssignment.payload.assignment.workflowAttempt?.moduleId, "review");
  assert.equal(transition?.payload.nextAssignmentId, createdAssignment.payload.assignment.id);
});

test("workflow progression preserves explicit runtime artifact references into the next module context", async () => {
  const timestamp = "2026-04-15T13:00:00.000Z";
  const bootstrap = buildWorkflowBootstrap({
    sessionId: "session-workflow-artifact-refs",
    adapterId: "codex",
    host: "codex",
    timestamp
  });
  const projection = projectRuntimeState(
    "session-workflow-artifact-refs",
    "/tmp/project",
    "codex",
    bootstrap.events
  );
  const assignmentId = bootstrap.initialAssignmentId;
  const inProgressAt = "2026-04-15T13:01:00.000Z";
  applyRuntimeEvent(projection, {
    eventId: "assignment-plan-in-progress",
    sessionId: projection.sessionId,
    timestamp: inProgressAt,
    type: "assignment.updated",
    payload: {
      assignmentId,
      patch: {
        state: "in_progress",
        updatedAt: inProgressAt
      }
    }
  });
  applyRuntimeEvent(projection, {
    eventId: "result-plan-artifacts",
    sessionId: projection.sessionId,
    timestamp: "2026-04-15T13:02:00.000Z",
    type: "result.submitted",
    payload: {
      result: {
        resultId: "result-plan-artifacts",
        assignmentId,
        producerId: "codex",
        status: "completed",
        summary: "Plan includes explicit runtime evidence references.",
        changedFiles: [],
        createdAt: "2026-04-15T13:02:00.000Z"
      }
    }
  });

  const artifactPath = workflowArtifactPath("default", 1, "plan", assignmentId, 1);
  const referencedEvidencePath = ".coortex/artifacts/results/plan-evidence.txt";
  const store = new StaticWorkflowArtifactStore(
    new Map([
      [
        artifactPath,
        {
          workflowId: "default",
          workflowCycle: 1,
          moduleId: "plan",
          moduleAttempt: 1,
          assignmentId,
          createdAt: "2026-04-15T13:02:00.000Z",
          payload: {
            planSummary: "Plan ready for review.",
            implementationSteps: ["Preserve runtime-owned evidence references."],
            reviewEvidenceSummary: "Review should see both the plan artifact and the referenced evidence.",
            runtimeArtifactReferences: [
              referencedEvidencePath,
              "artifacts/results/undocumented-store-relative.txt"
            ]
          }
        }
      ]
    ])
  );

  const progression = await evaluateWorkflowProgression(projection, store, {
    timestamp: "2026-04-15T13:02:01.000Z"
  });
  const gate = getGateEvent(progression.events);
  assert.ok(gate, "expected a gate event");
  assert.deepEqual(
    gate.payload.artifactReferences.map((reference) => ({
      path: reference.path,
      format: reference.format
    })),
    [
      { path: artifactPath, format: "json" },
      { path: "artifacts/results/plan-evidence.txt", format: "text" }
    ]
  );

  for (const event of progression.events) {
    applyRuntimeEvent(projection, event);
  }

  const summary = deriveWorkflowSummary(projection);
  assert.equal(summary?.currentModuleId, "review");
  assert.deepEqual(summary?.readArtifacts, [
    `.coortex/${artifactPath}`,
    referencedEvidencePath
  ]);
});

test("verify gate records only the claimed verify artifact and explicit runtime evidence refs", async () => {
  const verifyAssignment = createWorkflowAssignment(
    "verify-assignment-artifacts",
    "default",
    "Verify the latest approved review state against current-cycle durable evidence.",
    "in_progress",
    "2026-04-15T13:10:00.000Z"
  );
  const verifyResult: ResultPacket = {
    resultId: "verify-result-artifacts",
    assignmentId: verifyAssignment.id,
    producerId: "codex",
    status: "completed",
    summary: "Verification finished.",
    changedFiles: [],
    createdAt: "2026-04-15T13:13:00.000Z"
  };
  const reviewResult: ResultPacket = {
    resultId: "review-result-artifacts",
    assignmentId: "review-assignment-artifacts",
    producerId: "codex",
    status: "completed",
    summary: "Approved review evidence.",
    changedFiles: [],
    createdAt: "2026-04-15T13:12:00.000Z"
  };
  const reviewArtifactPath = workflowArtifactPath(
    "default",
    1,
    "review",
    "review-assignment-artifacts",
    1
  );
  const verifyArtifactPath = workflowArtifactPath(
    "default",
    1,
    "verify",
    verifyAssignment.id,
    1
  );
  const referencedEvidencePath = ".coortex/artifacts/results/verify-evidence.txt";
  const projection = createWorkflowProjection({
    currentModuleId: "verify",
    workflowCycle: 1,
    currentModuleAttempt: 1,
    currentAssignment: verifyAssignment,
    currentResult: verifyResult,
    extraResults: [reviewResult],
    moduleRecords: {
      review: {
        moduleId: "review",
        workflowCycle: 1,
        moduleAttempt: 1,
        assignmentId: "review-assignment-artifacts",
        moduleState: "completed",
        gateOutcome: "approved",
        sourceResultIds: ["review-result-artifacts"],
        sourceDecisionIds: [],
        artifactReferences: [
          {
            path: reviewArtifactPath,
            format: "json",
            digest: "review-digest",
            sourceResultId: "review-result-artifacts"
          }
        ],
        enteredAt: "2026-04-15T12:30:00.000Z",
        evaluatedAt: "2026-04-15T12:40:00.000Z",
        checklistStatus: "complete",
        evidenceSummary: "Review approved."
      },
      verify: {
        moduleId: "verify",
        workflowCycle: 1,
        moduleAttempt: 1,
        assignmentId: verifyAssignment.id,
        moduleState: "in_progress",
        sourceResultIds: [],
        sourceDecisionIds: [],
        artifactReferences: [],
        enteredAt: "2026-04-15T13:10:00.000Z"
      }
    }
  });
  const store = new StaticWorkflowArtifactStore(
    new Map([
      [
        verifyArtifactPath,
        {
          workflowId: "default",
          workflowCycle: 1,
          moduleId: "verify",
          moduleAttempt: 1,
          assignmentId: verifyAssignment.id,
          createdAt: "2026-04-15T13:13:00.000Z",
          payload: {
            verdict: "verified",
            verificationSummary: "Verification completed with explicit evidence.",
            evidenceResultIds: [reviewResult.resultId],
            runtimeArtifactReferences: [referencedEvidencePath]
          }
        }
      ]
    ])
  );

  const progression = await evaluateWorkflowProgression(projection, store, {
    timestamp: "2026-04-15T13:13:01.000Z"
  });
  const gate = getGateEvent(progression.events);

  assert.ok(gate, "expected a gate event");
  assert.deepEqual(
    gate.payload.artifactReferences.map((reference) => ({
      path: reference.path,
      format: reference.format
    })),
    [
      { path: verifyArtifactPath, format: "json" },
      { path: "artifacts/results/verify-evidence.txt", format: "text" }
    ]
  );
});

test("workflow status marks repair-state workflows as not resume-ready", () => {
  const projection = createEmptyProjection("session-workflow-repair", "/tmp/project", "codex");
  projection.status = {
    activeMode: "solo",
    currentObjective: "Stale objective.",
    activeAssignmentIds: ["missing-assignment"],
    activeHost: "codex",
    activeAdapter: "codex",
    lastDurableOutputAt: "2026-04-14T14:00:00.000Z",
    resumeReady: true
  };
  projection.workflowProgress = {
    workflowId: "default",
    orderedModuleIds: ["plan", "review", "verify"],
    currentModuleId: "review",
    workflowCycle: 1,
    currentAssignmentId: null,
    currentModuleAttempt: 1,
    modules: {
      review: {
        moduleId: "review",
        workflowCycle: 1,
        moduleAttempt: 1,
        assignmentId: null,
        moduleState: "blocked",
        sourceResultIds: [],
        sourceDecisionIds: [],
        artifactReferences: [],
        enteredAt: "2026-04-14T14:00:00.000Z"
      }
    }
  };

  const summary = deriveWorkflowSummary(projection);
  const status = deriveWorkflowStatus(projection, "2026-04-14T14:01:00.000Z");
  const brief = buildRecoveryBrief(projection);

  assert.equal(summary?.blockerReason, "Inspect workflow default and repair runtime state.");
  assert.equal(status.currentObjective, "Inspect workflow default and repair runtime state.");
  assert.deepEqual(status.activeAssignmentIds, []);
  assert.equal(status.resumeReady, false);
  assert.equal(brief.activeObjective, "Inspect workflow default and repair runtime state.");
  assert.deepEqual(brief.activeAssignments, []);
  assert.equal(brief.nextRequiredAction, "Inspect workflow default and repair runtime state.");
});

test("workflow derivation falls back to repair mode when the current module record is missing", () => {
  const assignment = createWorkflowAssignment(
    "repair-review-assignment",
    "default",
    "Assess the latest accepted plan artifact carried into the current cycle and produce a review verdict.",
    "queued",
    "2026-04-15T15:00:00.000Z"
  );
  const projection = createEmptyProjection("session-workflow-repair-missing-module", "/tmp/project", "codex");
  projection.status = {
    activeMode: "solo",
    currentObjective: assignment.objective,
    activeAssignmentIds: [assignment.id],
    activeHost: "codex",
    activeAdapter: "codex",
    lastDurableOutputAt: "2026-04-15T15:00:00.000Z",
    resumeReady: true
  };
  projection.assignments.set(assignment.id, assignment);
  projection.workflowProgress = {
    workflowId: "default",
    orderedModuleIds: ["plan", "review", "verify"],
    currentModuleId: "review",
    workflowCycle: 2,
    currentAssignmentId: assignment.id,
    currentModuleAttempt: 1,
    modules: {}
  };

  const summary = deriveWorkflowSummary(projection);
  const status = deriveWorkflowStatus(projection, "2026-04-15T15:01:00.000Z");
  const brief = buildRecoveryBrief(projection);

  assert.equal(summary?.blockerReason, "Inspect workflow default and repair runtime state.");
  assert.equal(summary?.currentAssignmentId, null);
  assert.equal(summary?.outputArtifact, null);
  assert.equal(status.currentObjective, "Inspect workflow default and repair runtime state.");
  assert.deepEqual(status.activeAssignmentIds, []);
  assert.equal(status.resumeReady, false);
  assert.equal(brief.activeObjective, "Inspect workflow default and repair runtime state.");
  assert.deepEqual(brief.activeAssignments, []);
  assert.equal(brief.nextRequiredAction, "Inspect workflow default and repair runtime state.");
});

test("workflow guidance stays consistent for blocked assignments without open decisions", () => {
  const assignment = createWorkflowAssignment(
    "blocked-review-assignment",
    "default",
    "Assess the latest accepted plan artifact carried into the current cycle and produce a review verdict.",
    "blocked",
    "2026-04-14T14:10:00.000Z"
  );
  const projection = createWorkflowProjection({
    currentModuleId: "review",
    workflowCycle: 1,
    currentModuleAttempt: 1,
    currentAssignment: assignment,
    currentResult: {
      resultId: "blocked-review-result",
      assignmentId: assignment.id,
      producerId: "codex",
      status: "partial",
      summary: "Review is blocked pending operator action.",
      changedFiles: [],
      createdAt: "2026-04-14T14:11:00.000Z"
    },
    moduleRecords: {
      review: {
        moduleId: "review",
        workflowCycle: 1,
        moduleAttempt: 1,
        assignmentId: assignment.id,
        moduleState: "blocked",
        gateOutcome: "blocked",
        sourceResultIds: [],
        sourceDecisionIds: [],
        artifactReferences: [],
        enteredAt: "2026-04-14T14:10:00.000Z"
      }
    }
  });

  const summary = deriveWorkflowSummary(projection);
  const status = deriveWorkflowStatus(projection, "2026-04-14T14:11:30.000Z");
  const brief = buildRecoveryBrief(projection);
  const expected = `Unblock review assignment ${assignment.id}: ${assignment.objective}`;

  assert.equal(summary?.blockerReason, expected);
  assert.equal(status.currentObjective, expected);
  assert.equal(status.resumeReady, true);
  assert.equal(brief.activeObjective, expected);
  assert.equal(brief.activeAssignments.length, 1);
  assert.equal(brief.activeAssignments[0]?.id, assignment.id);
  assert.equal(brief.nextRequiredAction, expected);
});

test("completed workflows surface a completion headline instead of a follow-up action", () => {
  const projection = createEmptyProjection("session-workflow-complete", "/tmp/project", "codex");
  projection.status = {
    activeMode: "solo",
    currentObjective: "Stale completion objective.",
    activeAssignmentIds: ["old-assignment"],
    activeHost: "codex",
    activeAdapter: "codex",
    lastDurableOutputAt: "2026-04-15T10:00:00.000Z",
    resumeReady: true
  };
  projection.workflowProgress = {
    workflowId: "default",
    orderedModuleIds: ["plan", "review", "verify"],
    currentModuleId: "verify",
    workflowCycle: 1,
    currentAssignmentId: null,
    currentModuleAttempt: 1,
    modules: {
      verify: {
        moduleId: "verify",
        workflowCycle: 1,
        moduleAttempt: 1,
        assignmentId: "verify-assignment",
        moduleState: "completed",
        sourceResultIds: ["verify-result"],
        sourceDecisionIds: [],
        artifactReferences: [],
        enteredAt: "2026-04-15T09:30:00.000Z",
        evaluatedAt: "2026-04-15T09:59:00.000Z",
        checklistStatus: "complete",
        gateOutcome: "verified",
        evidenceSummary: "Verification complete."
      }
    },
    lastTransition: {
      fromModuleId: "verify",
      toModuleId: "verify",
      workflowCycle: 1,
      moduleAttempt: 1,
      transition: "complete",
      previousAssignmentId: "verify-assignment",
      nextAssignmentId: null,
      appliedAt: "2026-04-15T10:00:00.000Z"
    }
  };

  const summary = deriveWorkflowSummary(projection);
  const status = deriveWorkflowStatus(projection, "2026-04-15T10:01:00.000Z");
  const brief = buildRecoveryBrief(projection);

  assert.equal(summary?.blockerReason, null);
  assert.equal(status.currentObjective, "Workflow default complete.");
  assert.deepEqual(status.activeAssignmentIds, []);
  assert.equal(status.resumeReady, false);
  assert.equal(brief.activeObjective, "Workflow default complete.");
  assert.deepEqual(brief.activeAssignments, []);
  assert.equal(brief.nextRequiredAction, "Workflow default complete.");
});

function createWorkflowProjection(options: {
  currentModuleId: WorkflowProgressRecord["currentModuleId"];
  workflowCycle: number;
  currentModuleAttempt: number;
  currentAssignment: Assignment;
  currentResult: ResultPacket;
  moduleRecords: WorkflowProgressRecord["modules"];
  extraResults?: ResultPacket[];
}): RuntimeProjection {
  const projection = createEmptyProjection("session-workflow", "/tmp/project", "codex");
  const status: RuntimeStatus = {
    activeMode: "solo",
    currentObjective: options.currentAssignment.objective,
    activeAssignmentIds: [options.currentAssignment.id],
    activeHost: "codex",
    activeAdapter: "codex",
    lastDurableOutputAt: options.currentResult.createdAt,
    resumeReady: true
  };
  projection.status = status;
  projection.assignments.set(options.currentAssignment.id, options.currentAssignment);
  projection.results.set(options.currentResult.resultId, options.currentResult);
  for (const result of options.extraResults ?? []) {
    projection.results.set(result.resultId, result);
  }
  projection.workflowProgress = {
    workflowId: "default",
    orderedModuleIds: ["plan", "review", "verify"],
    currentModuleId: options.currentModuleId,
    workflowCycle: options.workflowCycle,
    currentAssignmentId: options.currentAssignment.id,
    currentModuleAttempt: options.currentModuleAttempt,
    modules: options.moduleRecords
  };
  return projection;
}

function createWorkflowAssignment(
  id: string,
  workflow: string,
  objective: string,
  state: Assignment["state"],
  timestamp: string
): Assignment {
  return {
    id,
    parentTaskId: "session-workflow",
    workflow,
    ownerType: "host",
    ownerId: "codex",
    objective,
    writeScope: ["src/", "docs/"],
    requiredOutputs: ["summary"],
    state,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function getTransitionEvent(events: RuntimeEvent[]) {
  return events.find(
    (event): event is Extract<RuntimeEvent, { type: "workflow.transition.applied" }> =>
      event.type === "workflow.transition.applied"
  );
}

function getCreatedAssignmentEvent(events: RuntimeEvent[]) {
  return events.find(
    (event): event is Extract<RuntimeEvent, { type: "assignment.created" }> =>
      event.type === "assignment.created"
  );
}

function getGateEvent(events: RuntimeEvent[]) {
  return events.find(
    (event): event is Extract<RuntimeEvent, { type: "workflow.gate.recorded" }> =>
      event.type === "workflow.gate.recorded"
  );
}
