import type { HostAdapter } from "../adapters/contract.js";
import type { Assignment, HostRunRecord } from "../core/types.js";
import { selectWorkflowVisibleRunRecord } from "../recovery/host-runs.js";
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
  const workflow = deriveWorkflowSummary(loaded.projection);

  if (assignmentId) {
    const explicitAssignment = loaded.projection.assignments.get(assignmentId);
    const explicitRun = selectWorkflowVisibleRunRecord(
      loaded.projection,
      await adapter.inspectRun(store, assignmentId)
    );
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

  const workflowAssignmentId = loaded.projection.workflowProgress?.currentAssignmentId;
  const lastRun = selectWorkflowVisibleRunRecord(
    loaded.projection,
    await adapter.inspectRun(store)
  );
  const targetAssignmentId = workflowAssignmentId ?? lastRun?.assignmentId;
  const assignment = targetAssignmentId
    ? loaded.projection.assignments.get(targetAssignmentId)
    : undefined;
  const run = selectWorkflowVisibleRunRecord(
    loaded.projection,
    targetAssignmentId
      ? await adapter.inspectRun(store, targetAssignmentId)
      : lastRun
  );

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
