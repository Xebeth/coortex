#!/usr/bin/env node
import { join, resolve } from "node:path";

import type { HostAdapter } from "../adapters/contract.js";
import { getNativeRunId } from "../core/run-state.js";
import { RuntimeStore, toPrettyJson } from "../persistence/store.js";
import { CodexAdapter } from "../hosts/codex/adapter/index.js";
import type { RuntimeConfig } from "../config/types.js";
import {
  initRuntime,
  inspectRuntimeRun,
  loadReconciledProjectionWithDiagnostics,
  loadOperatorProjectionWithDiagnostics,
  resumeRuntime,
  runRuntime,
  type CommandDiagnostic
} from "./commands.js";
import { createRunCancellationController } from "./run-cancellation.js";

async function main(): Promise<void> {
  const [command, assignmentIdArg] = process.argv.slice(2);
  const projectRoot = process.cwd();
  const store = RuntimeStore.forProject(projectRoot);
  const adapter = await createAdapter(store, command);

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

async function createAdapter(
  store: RuntimeStore,
  command?: string
): Promise<HostAdapter> {
  if (command === "init") {
    return new CodexAdapter();
  }

  const config = await store.loadConfig();
  return createAdapterFromConfig(config);
}

function createAdapterFromConfig(config?: RuntimeConfig): HostAdapter {
  void config;
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

  const { projection, diagnostics } = await loadReconciledProjectionWithDiagnostics(store, adapter);
  const activeAssignments = [...projection.assignments.values()].filter((assignment) =>
    projection.status.activeAssignmentIds.includes(assignment.id)
  );
  const openDecisions = [...projection.decisions.values()].filter((decision) => decision.state === "open");

  console.log(`Session: ${projection.sessionId}`);
  console.log(`Objective: ${projection.status.currentObjective}`);
  console.log(`Host: ${projection.status.activeHost}`);
  console.log(`Adapter: ${projection.status.activeAdapter}`);
  console.log(`Last durable output: ${projection.status.lastDurableOutputAt || "n/a"}`);
  console.log(`Active assignments: ${activeAssignments.length}`);
  console.log(`Results: ${projection.results.size}`);
  console.log(`Open decisions: ${openDecisions.length}`);
  for (const assignment of activeAssignments) {
    console.log(`- ${assignment.id} ${assignment.state} ${assignment.objective}`);
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
    const { assignment, execution, diagnostics } = await runPromise;
    const nativeRunId = getNativeRunId(execution.run);

    console.log(`Executed assignment ${assignment.id} through ${adapter.id}`);
    if (nativeRunId) {
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

  const record = await inspectRuntimeRun(store, adapter, assignmentId);
  if (!record) {
    console.log("No recorded host run found.");
    process.exitCode = 1;
    return;
  }

  console.log(toPrettyJson(record).trimEnd());
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
