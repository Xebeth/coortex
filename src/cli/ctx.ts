#!/usr/bin/env node
import { join, resolve } from "node:path";

import type { HostAdapter } from "../adapters/contract.js";
import { getNativeRunId } from "../core/run-state.js";
import { RuntimeStore, toPrettyJson } from "../persistence/store.js";
import { buildRecoveryBrief } from "../recovery/brief.js";
import { CodexAdapter } from "../hosts/codex/adapter/index.js";
import { deriveWorkflowSummary } from "../workflows/index.js";
import {
  initRuntime,
  inspectRuntimeContext,
  inspectRuntimeRun,
  loadOperatorProjectionWithDiagnostics,
  resumeRuntime,
  runRuntime,
  type CommandDiagnostic
} from "./commands.js";
import { createRunCancellationController } from "./run-cancellation.js";
import { loadWorkflowAwareProjectionWithDiagnostics } from "./runtime-state.js";

async function main(): Promise<void> {
  const [command, assignmentIdArg] = process.argv.slice(2);
  const projectRoot = process.cwd();
  const store = RuntimeStore.forProject(projectRoot);
  const adapter = await createAdapter(command);

  switch (command) {
    case "init":
      await initCommand(projectRoot, store, adapter);
      return;
    case "doctor":
      await doctorCommand(store, adapter);
      return;
    case "status":
      await statusCommand(store, adapter);
      return;
    case "resume":
      await resumeCommand(store, adapter);
      return;
    case "run":
      await runCommand(store, adapter);
      return;
    case "inspect":
      await inspectCommand(store, adapter, assignmentIdArg);
      return;
    default:
      printUsage();
      process.exitCode = command ? 1 : 0;
  }
}

async function createAdapter(command?: string): Promise<HostAdapter> {
  if (command === "init") {
    return new CodexAdapter();
  }

  return createAdapterFromConfig();
}

function createAdapterFromConfig(): HostAdapter {
  const envBypass = process.env.COORTEX_CODEX_DANGEROUS_BYPASS === "1";
  return new CodexAdapter(
    undefined,
    {
      dangerouslyBypassApprovalsAndSandbox: envBypass
    }
  );
}

async function initCommand(
  projectRoot: string,
  store: RuntimeStore,
  adapter: HostAdapter
): Promise<void> {
  const initialized = await initRuntime(projectRoot, store, adapter);
  if (!initialized) {
    console.log(`Coortex already initialized at ${store.rootDir}`);
    return;
  }

  console.log(`Initialized Coortex runtime at ${store.rootDir}`);
  console.log(`Session: ${initialized.sessionId}`);
  console.log(`Adapter: ${initialized.adapterId}`);
  printDiagnostics(initialized.diagnostics);
}

async function doctorCommand(store: RuntimeStore, adapter: HostAdapter): Promise<void> {
  const config = await store.loadConfig();
  if (!config) {
    console.log(`Coortex is not initialized at ${store.rootDir}`);
    process.exitCode = 1;
    return;
  }

  const { projection, diagnostics } = await loadOperatorProjectionWithDiagnostics(store);
  const checks = [
    {
      label: "config",
      ok: true,
      detail: store.configPath
    },
    {
      label: "snapshot",
      ok: projection.status.activeAdapter === config.adapter,
      detail: store.snapshotPath
    },
    ...(await adapter.doctor(store))
  ];

  const hasFailure = checks.some((check) => !check.ok);
  for (const check of checks) {
    console.log(`${check.ok ? "OK" : "FAIL"} ${check.label} ${check.detail}`);
  }
  printDiagnostics(diagnostics);
  process.exitCode = hasFailure ? 1 : 0;
}

async function statusCommand(store: RuntimeStore, adapter: HostAdapter): Promise<void> {
  const config = await store.loadConfig();
  if (!config) {
    console.log("Coortex is not initialized. Run `ctx init` first.");
    process.exitCode = 1;
    return;
  }

  const { projection, diagnostics, activeLeases, hiddenActiveLeases } =
    await loadWorkflowAwareProjectionWithDiagnostics(store, adapter);
  const activeAssignments = [...projection.assignments.values()].filter((assignment) =>
    projection.status.activeAssignmentIds.includes(assignment.id)
  );
  const brief = buildRecoveryBrief(projection);
  const workflow = deriveWorkflowSummary(projection);

  console.log(`Session: ${projection.sessionId}`);
  console.log(`Objective: ${projection.status.currentObjective}`);
  console.log(`Host: ${projection.status.activeHost}`);
  console.log(`Adapter: ${projection.status.activeAdapter}`);
  console.log(`Last durable output: ${projection.status.lastDurableOutputAt || "n/a"}`);
  if (workflow) {
    console.log(`Workflow: ${workflow.id}`);
    console.log(`Current module: ${workflow.currentModuleId}`);
    console.log(`Module state: ${workflow.currentModuleState}`);
    console.log(`Rerun eligible: ${workflow.rerunEligible ? "yes" : "no"}`);
    console.log(`Last gate: ${workflow.lastGateOutcome ?? "n/a"}`);
    console.log(`Last advancement: ${workflow.lastDurableAdvancement ?? "n/a"}`);
    if (workflow.blockerReason) {
      console.log(`Blocker: ${workflow.blockerReason}`);
    }
  }
  console.log(`Active assignments: ${activeAssignments.length}`);
  if (activeLeases.length > 0) {
    console.log(`Authoritative host leases: ${activeLeases.length}`);
  }
  console.log(`Results: ${projection.results.size}`);
  console.log(`Open decisions: ${brief.unresolvedDecisions.length}`);
  for (const assignment of activeAssignments) {
    console.log(`- ${assignment.id} ${assignment.state} ${assignment.objective}`);
  }
  for (const assignmentId of activeLeases) {
    if (hiddenActiveLeases.includes(assignmentId)) {
      console.log(`- ${assignmentId} active host run lease outside the current projection`);
      continue;
    }
    if (!projection.status.activeAssignmentIds.includes(assignmentId)) {
      console.log(
        `- ${assignmentId} active host run lease within the current projection but outside the current active assignment set`
      );
      continue;
    }
    console.log(`- ${assignmentId} active host run lease on the current active assignment`);
  }
  printDiagnostics(diagnostics);
}

async function resumeCommand(store: RuntimeStore, adapter: HostAdapter): Promise<void> {
  const config = await store.loadConfig();
  if (!config) {
    console.log("Coortex is not initialized. Run `ctx init` first.");
    process.exitCode = 1;
    return;
  }

  const { projection, envelope, envelopePath, diagnostics } = await resumeRuntime(store, adapter);

  console.log(`Recovery brief generated for ${projection.status.currentObjective}`);
  console.log(`Envelope: ${resolve(envelopePath)}`);
  console.log(toPrettyJson(envelope).trimEnd());
  printDiagnostics(diagnostics);
}

async function runCommand(store: RuntimeStore, adapter: HostAdapter): Promise<void> {
  const config = await store.loadConfig();
  if (!config) {
    console.log("Coortex is not initialized. Run `ctx init` first.");
    process.exitCode = 1;
    return;
  }

  let runSettled = Promise.resolve();
  const cancellation = createRunCancellationController(adapter, {
    exit: (code) => process.exit(code),
    awaitRunPersistence: () => runSettled
  });
  try {
    const runPromise = runRuntime(store, adapter);
    runSettled = runPromise.then(() => undefined, () => undefined);
    const { assignment, envelope, execution, diagnostics, recoveredOutcome } = await runPromise;
    const nativeRunId = getNativeRunId(execution.run);

    if (!recoveredOutcome) {
      console.log(`Executed assignment ${assignment.id} through ${adapter.id}`);
    }
    if (envelope.workflow) {
      console.log(`Workflow: ${envelope.workflow.id}`);
      console.log(`Module: ${envelope.workflow.currentModuleId}`);
    }
    if (nativeRunId && !recoveredOutcome) {
      console.log(`Host run: ${nativeRunId}`);
    }
    if (execution.outcome.kind === "decision") {
      console.log(`Decision: ${execution.outcome.capture.blockerSummary}`);
      console.log(`Recommended option: ${execution.outcome.capture.recommendedOption}`);
    } else {
      console.log(`Result (${execution.outcome.capture.status}): ${execution.outcome.capture.summary}`);
      if (execution.outcome.capture.status === "failed") {
        process.exitCode = 1;
      }
    }
    printDiagnostics(diagnostics);
  } finally {
    cancellation.dispose();
  }
}

async function inspectCommand(
  store: RuntimeStore,
  adapter: HostAdapter,
  assignmentId?: string
): Promise<void> {
  const config = await store.loadConfig();
  if (!config) {
    console.log("Coortex is not initialized. Run `ctx init` first.");
    process.exitCode = 1;
    return;
  }

  const inspection = await inspectRuntimeContext(store, adapter, assignmentId);
  if (!inspection.record) {
    printDiagnostics(inspection.diagnostics);
    console.log("No runtime context found.");
    process.exitCode = 1;
    return;
  }

  console.log(toPrettyJson(inspection.record).trimEnd());
  printDiagnostics(inspection.diagnostics);
}

function printUsage(): void {
  console.log("Usage: ctx <init|doctor|status|resume|run|inspect> [assignment-id]");
}

function printDiagnostics(diagnostics: CommandDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    console.error(`${diagnostic.level.toUpperCase()} ${diagnostic.code} ${diagnostic.message}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
