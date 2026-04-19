import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTaskEnvelope } from "../hosts/codex/adapter/envelope.js";
import { buildCodexExecutionPrompt } from "../hosts/codex/adapter/prompt.js";
import { buildRecoveryBrief } from "../recovery/brief.js";
import { createEmptyProjection } from "../projections/runtime-projection.js";
import type { Assignment, RecoveryBrief, RuntimeStatus, WorkflowSummary } from "../core/types.js";
import { RuntimeStore } from "../persistence/store.js";
import type { RuntimeConfig } from "../config/types.js";
import type { RuntimeArtifactStore } from "../adapters/contract.js";
import { deriveWorkflowSummary } from "../workflows/index.js";

test("task envelope trims oversized result summaries, writes artifacts, and stays bounded", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-envelope-"));
  const store = RuntimeStore.forProject(projectRoot);
  const config: RuntimeConfig = {
    version: 1,
    sessionId: "session-1",
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: "2026-04-03T00:00:00.000Z"
  };
  await store.initialize(config);

  const projection = createEmptyProjection("session-1", "/tmp/project", "codex");
  const assignment: Assignment = {
    id: "assignment-1",
    parentTaskId: "session-1",
    workflow: "milestone-1",
    ownerType: "runtime",
    ownerId: "codex:bootstrap",
    objective: "Implement trimming.",
    writeScope: ["src/"],
    requiredOutputs: ["tests"],
    state: "in_progress",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z"
  };
  const status: RuntimeStatus = {
    activeMode: "solo",
    currentObjective: assignment.objective,
    activeAssignmentIds: [assignment.id],
    activeHost: "codex",
    activeAdapter: "codex",
    lastDurableOutputAt: "2026-04-03T00:00:00.000Z",
    resumeReady: true
  };
  projection.assignments.set(assignment.id, assignment);
  projection.status = status;

  const brief: RecoveryBrief = {
    activeObjective: assignment.objective,
    activeAssignments: [
      {
        id: assignment.id,
        objective: assignment.objective,
        state: assignment.state,
        writeScope: assignment.writeScope,
        requiredOutputs: assignment.requiredOutputs
      }
    ],
    lastDurableResults: [
      {
        resultId: "result-1",
        assignmentId: assignment.id,
        status: "partial",
        summary: "x".repeat(1_000),
        changedFiles: ["src/adapters/envelope.ts"],
        createdAt: "2026-04-03T00:00:00.000Z"
      }
    ],
    unresolvedDecisions: [],
    nextRequiredAction: "Continue assignment assignment-1",
    generatedAt: "2026-04-03T00:00:00.000Z"
  };

  const envelope = await buildTaskEnvelope(store, projection, brief, {
    host: "codex",
    adapter: "codex",
    maxChars: 1_500,
    resultSummaryLimit: 120
  });

  assert.equal(envelope.trimApplied, true);
  assert.equal(envelope.recentResults[0]?.trimmed, true);
  assert.equal(
    envelope.recentResults[0]?.reference,
    ".coortex/artifacts/results/result-1.txt"
  );
  assert.ok(envelope.estimatedChars <= 1_500);

  const artifact = await readFile(
    join(projectRoot, ".coortex", "artifacts", "results", "result-1.txt"),
    "utf8"
  );
  assert.equal(artifact.trim(), "x".repeat(1_000));
});

test("task envelope mirrors the writable workflow artifact and keeps read artifacts read-only", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-envelope-workflow-"));
  const store = RuntimeStore.forProject(projectRoot);
  const config: RuntimeConfig = {
    version: 1,
    sessionId: "session-workflow",
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: "2026-04-13T00:00:00.000Z"
  };
  await store.initialize(config);

  const projection = createEmptyProjection("session-workflow", projectRoot, "codex");
  const assignment: Assignment = {
    id: "assignment-workflow",
    parentTaskId: "session-workflow",
    workflow: "default",
    ownerType: "runtime",
    ownerId: "codex:bootstrap",
    objective: "Produce the plan artifact.",
    writeScope: ["src/", "docs/"],
    requiredOutputs: ["planSummary"],
    state: "queued",
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z"
  };
  const status: RuntimeStatus = {
    activeMode: "solo",
    currentObjective: assignment.objective,
    activeAssignmentIds: [assignment.id],
    activeHost: "codex",
    activeAdapter: "codex",
    lastDurableOutputAt: "2026-04-13T00:00:00.000Z",
    resumeReady: true
  };
  projection.assignments.set(assignment.id, assignment);
  projection.status = status;

  const brief: RecoveryBrief = {
    activeObjective: assignment.objective,
    activeAssignments: [
      {
        id: assignment.id,
        objective: assignment.objective,
        state: assignment.state,
        writeScope: assignment.writeScope,
        requiredOutputs: assignment.requiredOutputs
      }
    ],
    lastDurableResults: [],
    unresolvedDecisions: [],
    nextRequiredAction: `Start plan assignment ${assignment.id}: ${assignment.objective}`,
    generatedAt: "2026-04-13T00:00:00.000Z"
  };
  const workflow: WorkflowSummary = {
    id: "default",
    currentModuleId: "plan",
    currentModuleState: "queued",
    workflowCycle: 1,
    currentAssignmentId: assignment.id,
    outputArtifact:
      ".coortex/runtime/workflows/default/cycles/1/plan/assignment-workflow/attempt-1.json",
    readArtifacts: [
      ".coortex/runtime/workflows/default/cycles/1/review/review-assignment/attempt-1.json",
      ".coortex/artifacts/results/referenced-evidence.txt"
    ],
    rerunEligible: true,
    blockerReason: null,
    lastGateOutcome: "blocked",
    lastDurableAdvancement: "Rerun plan attempt 1."
  };

  const envelope = await buildTaskEnvelope(store, projection, brief, {
    host: "codex",
    adapter: "codex",
    maxChars: 4_000,
    workflow
  });
  const prompt = buildCodexExecutionPrompt(envelope);
  const outputArtifact = workflow.outputArtifact;
  const readArtifact = workflow.readArtifacts[0];
  const referencedEvidence = workflow.readArtifacts[1];

  assert.ok(outputArtifact, "expected a workflow output artifact");
  assert.ok(readArtifact, "expected a workflow read artifact");
  assert.ok(referencedEvidence, "expected a referenced runtime evidence artifact");

  assert.ok(envelope.writeScope.includes("src/"));
  assert.ok(envelope.writeScope.includes("docs/"));
  assert.ok(envelope.writeScope.includes(outputArtifact));
  assert.ok(!envelope.writeScope.includes(readArtifact));
  assert.ok(!envelope.writeScope.includes(referencedEvidence));
  assert.deepEqual(envelope.workflow, workflow);
  assert.match(
    prompt,
    new RegExp(`Write the workflow artifact to ${escapeForRegExp(outputArtifact)}`)
  );
  assert.match(
    prompt,
    new RegExp(`Use workflow\\.readArtifacts as read-only inputs: ${escapeForRegExp(readArtifact)}`)
  );
  assert.match(
    prompt,
    new RegExp(escapeForRegExp(referencedEvidence))
  );
  assert.doesNotMatch(
    prompt,
    new RegExp(`Write the workflow artifact to ${escapeForRegExp(readArtifact)}`)
  );
  assert.doesNotMatch(
    prompt,
    new RegExp(`Write the workflow artifact to ${escapeForRegExp(referencedEvidence)}`)
  );
});

test("task envelope prefers workflow current assignment over stale status selectors", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-envelope-workflow-selector-"));
  const store = RuntimeStore.forProject(projectRoot);
  const config: RuntimeConfig = {
    version: 1,
    sessionId: "session-workflow-selector",
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: "2026-04-18T00:00:00.000Z"
  };
  await store.initialize(config);

  const projection = createEmptyProjection("session-workflow-selector", projectRoot, "codex");
  const workflowAssignment: Assignment = {
    id: "assignment-workflow-current",
    parentTaskId: "session-workflow-selector",
    workflow: "default",
    ownerType: "runtime",
    ownerId: "codex:bootstrap",
    objective: "Produce the workflow plan artifact.",
    writeScope: ["src/", "docs/"],
    requiredOutputs: ["planSummary"],
    state: "queued",
    createdAt: "2026-04-18T00:00:00.000Z",
    updatedAt: "2026-04-18T00:00:00.000Z"
  };
  const staleStatusAssignment: Assignment = {
    id: "assignment-status-stale",
    parentTaskId: "session-workflow-selector",
    workflow: "default",
    ownerType: "runtime",
    ownerId: "codex:bootstrap",
    objective: "Old stale assignment that should not leak into the envelope.",
    writeScope: ["tests/"],
    requiredOutputs: ["staleOutput"],
    state: "queued",
    createdAt: "2026-04-18T00:00:00.000Z",
    updatedAt: "2026-04-18T00:00:00.000Z"
  };
  projection.assignments.set(workflowAssignment.id, workflowAssignment);
  projection.assignments.set(staleStatusAssignment.id, staleStatusAssignment);
  projection.status = {
    activeMode: "solo",
    currentObjective: staleStatusAssignment.objective,
    activeAssignmentIds: [staleStatusAssignment.id],
    activeHost: "codex",
    activeAdapter: "codex",
    lastDurableOutputAt: "2026-04-18T00:00:00.000Z",
    resumeReady: true
  };
  projection.workflowProgress = {
    workflowId: "default",
    orderedModuleIds: ["plan", "review", "verify"],
    currentModuleId: "plan",
    workflowCycle: 1,
    currentAssignmentId: workflowAssignment.id,
    currentModuleAttempt: 1,
    modules: {
      plan: {
        moduleId: "plan",
        workflowCycle: 1,
        moduleAttempt: 1,
        assignmentId: workflowAssignment.id,
        moduleState: "queued",
        sourceResultIds: [],
        sourceDecisionIds: [],
        artifactReferences: [],
        enteredAt: "2026-04-18T00:00:00.000Z"
      }
    }
  };

  const brief = buildRecoveryBrief(projection);
  const workflow = deriveWorkflowSummary(projection);
  assert.ok(workflow, "expected workflow summary");
  const envelope = await buildTaskEnvelope(store, projection, brief, {
    host: "codex",
    adapter: "codex",
    maxChars: 4_000,
    workflow
  });

  assert.deepEqual(brief.activeAssignments.map((assignment) => assignment.id), [workflowAssignment.id]);
  assert.equal(envelope.objective, workflowAssignment.objective);
  assert.equal(envelope.metadata.activeAssignmentId, workflowAssignment.id);
  assert.deepEqual(envelope.requiredOutputs, workflowAssignment.requiredOutputs);
  assert.ok(envelope.writeScope.includes("src/"));
  assert.ok(envelope.writeScope.includes("docs/"));
  assert.ok(!envelope.writeScope.includes("tests/"));
  assert.ok(envelope.writeScope.includes(workflow.outputArtifact!));
});

test("task envelope trims oversized workflow explanatory strings before the budget hard-fails", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-envelope-workflow-trim-"));
  const store = RuntimeStore.forProject(projectRoot);
  const config: RuntimeConfig = {
    version: 1,
    sessionId: "session-workflow-trim",
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: "2026-04-14T00:00:00.000Z"
  };
  await store.initialize(config);

  const projection = createEmptyProjection("session-workflow-trim", projectRoot, "codex");
  const assignment: Assignment = {
    id: "assignment-workflow-trim",
    parentTaskId: "session-workflow-trim",
    workflow: "default",
    ownerType: "runtime",
    ownerId: "codex:bootstrap",
    objective: "Repair the blocked workflow state.",
    writeScope: ["src/", "docs/"],
    requiredOutputs: ["planSummary"],
    state: "queued",
    createdAt: "2026-04-14T00:00:00.000Z",
    updatedAt: "2026-04-14T00:00:00.000Z"
  };
  const status: RuntimeStatus = {
    activeMode: "solo",
    currentObjective: assignment.objective,
    activeAssignmentIds: [assignment.id],
    activeHost: "codex",
    activeAdapter: "codex",
    lastDurableOutputAt: "2026-04-14T00:00:00.000Z",
    resumeReady: true
  };
  projection.assignments.set(assignment.id, assignment);
  projection.status = status;

  const blockerReason = "Need more evidence. ".repeat(260);
  const lastDurableAdvancement = "Advanced workflow context. ".repeat(220);
  const brief: RecoveryBrief = {
    activeObjective: assignment.objective,
    activeAssignments: [
      {
        id: assignment.id,
        objective: assignment.objective,
        state: assignment.state,
        writeScope: assignment.writeScope,
        requiredOutputs: assignment.requiredOutputs
      }
    ],
    lastDurableResults: [],
    unresolvedDecisions: [],
    nextRequiredAction: blockerReason,
    generatedAt: "2026-04-14T00:00:00.000Z"
  };
  const workflow: WorkflowSummary = {
    id: "default",
    currentModuleId: "review",
    currentModuleState: "blocked",
    workflowCycle: 1,
    currentAssignmentId: assignment.id,
    outputArtifact:
      ".coortex/runtime/workflows/default/cycles/1/review/assignment-workflow-trim/attempt-1.json",
    readArtifacts: [
      ".coortex/runtime/workflows/default/cycles/1/plan/plan-assignment/attempt-1.json"
    ],
    rerunEligible: false,
    blockerReason,
    lastGateOutcome: "blocked",
    lastDurableAdvancement
  };

  const envelope = await buildTaskEnvelope(store, projection, brief, {
    host: "codex",
    adapter: "codex",
    maxChars: 4_000,
    workflow
  });
  const blockerField = envelope.trimmedFields.find((field) => field.label === "workflow:blockerReason");
  const advancementField = envelope.trimmedFields.find(
    (field) => field.label === "workflow:lastDurableAdvancement"
  );

  assert.equal(envelope.trimApplied, true);
  assert.ok(envelope.estimatedChars <= 4_000);
  assert.ok(blockerField, "expected blockerReason compaction metadata");
  assert.ok(advancementField, "expected lastDurableAdvancement compaction metadata");
  assert.match(envelope.workflow?.blockerReason ?? "", /\.\.\.\[trimmed\]$/);
  assert.match(envelope.workflow?.lastDurableAdvancement ?? "", /\.\.\.\[trimmed\]$/);
  assert.equal(envelope.recoveryBrief.nextRequiredAction, envelope.workflow?.blockerReason);

  const blockerArtifact = await readFile(join(projectRoot, blockerField!.reference), "utf8");
  const advancementArtifact = await readFile(join(projectRoot, advancementField!.reference), "utf8");

  assert.equal(blockerArtifact.trim(), blockerReason.trim());
  assert.equal(advancementArtifact.trim(), lastDurableAdvancement.trim());
});

test("task envelope keeps trimmed field ordering stable across async artifact writes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coortex-envelope-trim-order-"));
  const baseStore = RuntimeStore.forProject(projectRoot);
  const store = new DelayedWriteArtifactStore(baseStore, {
    "artifacts/results/result-1.txt": 20,
    "artifacts/results/result-2.txt": 0,
    "artifacts/decisions/decision-1.txt": 20,
    "artifacts/decisions/decision-2.txt": 0
  });
  const config: RuntimeConfig = {
    version: 1,
    sessionId: "session-trim-order",
    adapter: "codex",
    host: "codex",
    rootPath: projectRoot,
    createdAt: "2026-04-19T00:00:00.000Z"
  };
  await baseStore.initialize(config);

  const projection = createEmptyProjection("session-trim-order", projectRoot, "codex");
  const assignment: Assignment = {
    id: "assignment-trim-order",
    parentTaskId: "session-trim-order",
    workflow: "milestone-1",
    ownerType: "runtime",
    ownerId: "codex:bootstrap",
    objective: "Keep trim metadata ordered.",
    writeScope: ["src/"],
    requiredOutputs: ["tests"],
    state: "in_progress",
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z"
  };
  projection.assignments.set(assignment.id, assignment);
  projection.status = {
    activeMode: "solo",
    currentObjective: assignment.objective,
    activeAssignmentIds: [assignment.id],
    activeHost: "codex",
    activeAdapter: "codex",
    lastDurableOutputAt: "2026-04-19T00:00:00.000Z",
    resumeReady: true
  };

  const brief: RecoveryBrief = {
    activeObjective: assignment.objective,
    activeAssignments: [
      {
        id: assignment.id,
        objective: assignment.objective,
        state: assignment.state,
        writeScope: assignment.writeScope,
        requiredOutputs: assignment.requiredOutputs
      }
    ],
    lastDurableResults: [
      {
        resultId: "result-1",
        assignmentId: assignment.id,
        status: "partial",
        summary: "r".repeat(900),
        changedFiles: ["src/one.ts"],
        createdAt: "2026-04-19T00:00:00.000Z"
      },
      {
        resultId: "result-2",
        assignmentId: assignment.id,
        status: "partial",
        summary: "s".repeat(900),
        changedFiles: ["src/two.ts"],
        createdAt: "2026-04-19T00:00:01.000Z"
      }
    ],
    unresolvedDecisions: [
      {
        decisionId: "decision-1",
        assignmentId: assignment.id,
        blockerSummary: "Need more detail. ".repeat(40),
        recommendedOption: "revise"
      },
      {
        decisionId: "decision-2",
        assignmentId: assignment.id,
        blockerSummary: "Need even more detail. ".repeat(40),
        recommendedOption: "revise-more"
      }
    ],
    nextRequiredAction: "Continue assignment assignment-trim-order",
    generatedAt: "2026-04-19T00:00:04.000Z"
  };

  const envelope = await buildTaskEnvelope(store, projection, brief, {
    host: "codex",
    adapter: "codex",
    maxChars: 4_000,
    resultSummaryLimit: 120
  });

  assert.deepEqual(
    envelope.trimmedFields.map((field) => field.label),
    [
      "result:result-1",
      "result:result-2",
      "decision:decision-1",
      "decision:decision-2"
    ]
  );
});

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class DelayedWriteArtifactStore implements RuntimeArtifactStore {
  constructor(
    private readonly inner: RuntimeStore,
    private readonly delaysMs: Record<string, number>
  ) {}

  get rootDir(): string {
    return this.inner.rootDir;
  }

  get runtimeDir(): string {
    return this.inner.runtimeDir;
  }

  get adaptersDir(): string {
    return this.inner.adaptersDir;
  }

  readJsonArtifact<T>(relativePath: string, label: string): Promise<T | undefined> {
    return this.inner.readJsonArtifact(relativePath, label);
  }

  readTextArtifact(relativePath: string, label: string): Promise<string | undefined> {
    return this.inner.readTextArtifact(relativePath, label);
  }

  claimTextArtifact(relativePath: string, content: string): Promise<string> {
    return this.inner.claimTextArtifact(relativePath, content);
  }

  writeJsonArtifact(relativePath: string, value: unknown): Promise<string> {
    return this.inner.writeJsonArtifact(relativePath, value);
  }

  async writeTextArtifact(relativePath: string, content: string): Promise<string> {
    const delayMs = this.delaysMs[relativePath] ?? 0;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return this.inner.writeTextArtifact(relativePath, content);
  }

  deleteArtifact(relativePath: string): Promise<void> {
    return this.inner.deleteArtifact(relativePath);
  }
}
