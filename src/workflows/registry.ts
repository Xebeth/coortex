import type { WorkflowModuleDefinition } from "./types.js";
import { planWorkflowModule } from "./modules/plan.js";
import { reviewWorkflowModule } from "./modules/review.js";
import { verifyWorkflowModule } from "./modules/verify.js";

export const DEFAULT_WORKFLOW_ID = "default";
export const DEFAULT_WORKFLOW_MODULE_IDS = ["plan", "review", "verify"] as const;

const DEFAULT_WORKFLOW_REGISTRY = new Map<string, WorkflowModuleDefinition>([
  [planWorkflowModule.id, planWorkflowModule],
  [reviewWorkflowModule.id, reviewWorkflowModule],
  [verifyWorkflowModule.id, verifyWorkflowModule]
]);

export function getDefaultWorkflowRegistry(): ReadonlyMap<string, WorkflowModuleDefinition> {
  return DEFAULT_WORKFLOW_REGISTRY;
}

export function getWorkflowModule(moduleId: string): WorkflowModuleDefinition {
  const module = DEFAULT_WORKFLOW_REGISTRY.get(moduleId);
  if (!module) {
    throw new Error(`Unknown workflow module ${moduleId}.`);
  }
  return module;
}
