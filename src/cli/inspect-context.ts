import type { HostAdapter } from "../adapters/contract.js";
import type { Assignment, HostRunRecord } from "../core/types.js";
import {
  selectWorkflowOwnedRunAssignmentId,
  selectWorkflowVisibleRunRecord
} from "../recovery/host-runs.js";
import { RuntimeStore } from "../persistence/store.js";
import { deriveWorkflowSummary } from "../workflows/index.js";
import { loadWorkflowAwareProjectionWithDiagnostics } from "./runtime-state.js";
import type { CommandDiagnostic } from "./types.js";

interface InspectAssignmentPayload extends Pick<Assignment, "id" | "state" | "workflow" | "objective"> {}

interface InspectRuntimeContextRecord {
  workflow: ReturnType<typeof deriveWorkflowSummary>;
  assignment: InspectAssignmentPayload | null;
  run: HostRunRecord | null;
}

export async function loadInspectRuntimeContext(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId?: string
): Promise<{
  diagnostics: CommandDiagnostic[];
  record: InspectRuntimeContextRecord | undefined;
}> {
  const loaded = await loadWorkflowAwareProjectionWithDiagnostics(store, adapter);
  const inspectVisibleRun = (assignmentId?: string) =>
    loadVisibleInspectRun(store, adapter, loaded.projection, assignmentId);
  const workflow = deriveWorkflowSummary(loaded.projection);

  if (assignmentId) {
    const explicitAssignment = loaded.projection.assignments.get(assignmentId);
    const explicitRun = (await inspectVisibleRun(assignmentId)).visibleRun;
    if (!explicitAssignment && !explicitRun) {
      return {
        diagnostics: loaded.diagnostics,
        record: undefined
      };
    }

    return {
      diagnostics: loaded.diagnostics,
      record: buildInspectRecord(workflow, explicitAssignment, explicitRun)
    };
  }

  const workflowAssignmentId = selectWorkflowOwnedRunAssignmentId(loaded.projection);
  const activeAssignmentId = loaded.projection.status.activeAssignmentIds.find((candidateAssignmentId) =>
    loaded.projection.assignments.has(candidateAssignmentId)
  );
  const inspectedLastRun = await inspectVisibleRun();
  const lastRun = inspectedLastRun.visibleRun;
  const targetAssignmentId = workflowAssignmentId ?? activeAssignmentId ?? lastRun?.assignmentId;
  const assignment = targetAssignmentId
    ? loaded.projection.assignments.get(targetAssignmentId)
    : undefined;
  const run = targetAssignmentId && inspectedLastRun.inspectedRun?.assignmentId === targetAssignmentId
    ? inspectedLastRun.visibleRun
    : targetAssignmentId
      ? (await inspectVisibleRun(targetAssignmentId)).visibleRun
      : lastRun;

  if (!workflow && !assignment && !run) {
    return {
      diagnostics: loaded.diagnostics,
      record: undefined
    };
  }

  return {
    diagnostics: loaded.diagnostics,
    record: buildInspectRecord(workflow, assignment, run)
  };
}

async function loadVisibleInspectRun(
  store: RuntimeStore,
  adapter: HostAdapter,
  projection: Parameters<typeof selectWorkflowVisibleRunRecord>[0],
  assignmentId?: string
): Promise<{
  inspectedRun: HostRunRecord | undefined;
  visibleRun: HostRunRecord | undefined;
}> {
  const inspectedRun = await adapter.inspectRun(store, assignmentId);
  return {
    inspectedRun,
    visibleRun: selectWorkflowVisibleRunRecord(projection, inspectedRun)
  };
}

function buildInspectRecord(
  workflow: ReturnType<typeof deriveWorkflowSummary>,
  assignment: Assignment | undefined,
  run: HostRunRecord | undefined
): InspectRuntimeContextRecord {
  return {
    workflow,
    assignment: assignment
      ? {
          id: assignment.id,
          state: assignment.state,
          workflow: assignment.workflow,
          objective: assignment.objective
        }
      : null,
    run: run ?? null
  };
}
