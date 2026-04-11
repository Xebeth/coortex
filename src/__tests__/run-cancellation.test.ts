import test from "node:test";
import assert from "node:assert/strict";

import type { HostAdapter } from "../adapters/contract.js";
import { createRunCancellationController } from "../cli/run-cancellation.js";

test("run cancellation escalates to force when graceful termination stalls", async () => {
  const originalGrace = process.env.COORTEX_CANCEL_GRACE_MS;
  const originalForce = process.env.COORTEX_CANCEL_FORCE_MS;
  process.env.COORTEX_CANCEL_GRACE_MS = "10";
  process.env.COORTEX_CANCEL_FORCE_MS = "10";

  const signals: string[] = [];
  const exits: number[] = [];
  let gracefulRelease!: () => void;
  const graceful = new Promise<void>((resolve) => {
    gracefulRelease = resolve;
  });

  const adapter = createCancellationAdapter(async (signal) => {
    const kind = signal ?? "graceful";
    signals.push(kind);
    if (kind === "graceful") {
      await graceful;
    }
  });

  try {
    const controller = createRunCancellationController(adapter, {
      exit: (code) => {
        exits.push(code);
      }
    });

    controller.handleSignal("SIGTERM");
    await waitFor(() => exits.length === 1, 500);
    controller.dispose();

    assert.deepEqual(signals, ["graceful", "force"]);
    assert.deepEqual(exits, [143]);
    gracefulRelease();
  } finally {
    restoreEnv("COORTEX_CANCEL_GRACE_MS", originalGrace);
    restoreEnv("COORTEX_CANCEL_FORCE_MS", originalForce);
  }
});

test("run cancellation still exits when force termination rejects", async () => {
  const originalGrace = process.env.COORTEX_CANCEL_GRACE_MS;
  const originalForce = process.env.COORTEX_CANCEL_FORCE_MS;
  process.env.COORTEX_CANCEL_GRACE_MS = "10";
  process.env.COORTEX_CANCEL_FORCE_MS = "10";

  const signals: string[] = [];
  const exits: number[] = [];
  const adapter = createCancellationAdapter(async (signal) => {
    const kind = signal ?? "graceful";
    signals.push(kind);
    if (kind === "graceful") {
      await never();
    }
    throw new Error("force failed");
  });

  try {
    const controller = createRunCancellationController(adapter, {
      exit: (code) => {
        exits.push(code);
      }
    });

    controller.handleSignal("SIGINT");
    await waitFor(() => exits.length === 1, 500);
    controller.dispose();

    assert.deepEqual(signals, ["graceful", "force"]);
    assert.deepEqual(exits, [130]);
  } finally {
    restoreEnv("COORTEX_CANCEL_GRACE_MS", originalGrace);
    restoreEnv("COORTEX_CANCEL_FORCE_MS", originalForce);
  }
});

test("run cancellation still exits when force termination stalls", async () => {
  const originalGrace = process.env.COORTEX_CANCEL_GRACE_MS;
  const originalForce = process.env.COORTEX_CANCEL_FORCE_MS;
  process.env.COORTEX_CANCEL_GRACE_MS = "10";
  process.env.COORTEX_CANCEL_FORCE_MS = "10";

  const signals: string[] = [];
  const exits: number[] = [];
  const adapter = createCancellationAdapter(async (signal) => {
    signals.push(signal ?? "graceful");
    await never();
  });

  try {
    const controller = createRunCancellationController(adapter, {
      exit: (code) => {
        exits.push(code);
      }
    });

    controller.handleSignal("SIGTERM");
    await waitFor(() => exits.length === 1, 500);
    controller.dispose();

    assert.deepEqual(signals, ["graceful", "force"]);
    assert.deepEqual(exits, [143]);
  } finally {
    restoreEnv("COORTEX_CANCEL_GRACE_MS", originalGrace);
    restoreEnv("COORTEX_CANCEL_FORCE_MS", originalForce);
  }
});

test("run cancellation waits for in-flight run persistence before exiting", async () => {
  const exits: number[] = [];
  let releasePersistence!: () => void;
  const persistence = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });

  const adapter = createCancellationAdapter(async () => undefined);
  const controller = createRunCancellationController(adapter, {
    exit: (code) => {
      exits.push(code);
    },
    awaitRunPersistence: async () => {
      await persistence;
    }
  });

  try {
    controller.handleSignal("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(exits, []);

    releasePersistence();
    await waitFor(() => exits.length === 1, 500);
    assert.deepEqual(exits, [130]);
  } finally {
    controller.dispose();
  }
});

function createCancellationAdapter(
  cancelActiveRun: NonNullable<HostAdapter["cancelActiveRun"]>
): HostAdapter {
  return {
    id: "codex",
    host: "codex",
    getCapabilities() {
      return {
        supportsProfiles: true,
        supportsHooks: false,
        supportsResume: true,
        supportsFork: false,
        supportsExactUsage: false,
        supportsCompactionHooks: false,
        supportsMcp: false,
        supportsPlugins: false,
        supportsPermissionsModel: false
      };
    },
    async initialize() {},
    async doctor() {
      return [];
    },
    async buildResumeEnvelope() {
      throw new Error("not used");
    },
    async executeAssignment() {
      throw new Error("not used");
    },
    async claimRunLease() {
      throw new Error("not used");
    },
    async releaseRunLease() {},
    async reconcileStaleRun() {},
    async inspectRun() {
      return undefined;
    },
    normalizeResult(capture) {
      return {
        resultId: "result-1",
        assignmentId: capture.assignmentId,
        producerId: capture.producerId,
        status: capture.status,
        summary: capture.summary,
        changedFiles: capture.changedFiles,
        createdAt: capture.createdAt ?? ""
      };
    },
    normalizeDecision(capture) {
      return {
        decisionId: "decision-1",
        assignmentId: capture.assignmentId,
        requesterId: capture.requesterId,
        blockerSummary: capture.blockerSummary,
        options: capture.options,
        recommendedOption: capture.recommendedOption,
        state: capture.state ?? "open",
        createdAt: capture.createdAt ?? ""
      };
    },
    normalizeTelemetry(capture) {
      return {
        eventType: capture.eventType,
        taskId: capture.taskId,
        host: "codex",
        adapter: "codex",
        metadata: capture.metadata
      };
    },
    cancelActiveRun
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("Timed out waiting for cancellation to complete.");
}

async function never(): Promise<void> {
  await new Promise(() => undefined);
}
