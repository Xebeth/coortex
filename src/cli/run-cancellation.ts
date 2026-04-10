import type { HostAdapter } from "../adapters/contract.js";

const DEFAULT_GRACEFUL_TIMEOUT_MS = 2_000;
const DEFAULT_FORCE_TIMEOUT_MS = 2_000;

export interface RunCancellationHooks {
  exit: (code: number) => void;
  awaitRunPersistence?: () => Promise<void>;
  warn?: (message: string) => void;
}

export interface RunCancellationController {
  handleSignal(signal: NodeJS.Signals): void;
  dispose(): void;
}

export function createRunCancellationController(
  adapter: HostAdapter,
  hooks: RunCancellationHooks = {
    exit: (code) => process.exit(code),
    warn: (message) => console.error(message)
  }
): RunCancellationController {
  let forwarded = false;
  const gracefulTimeoutMs = readTimeout("COORTEX_CANCEL_GRACE_MS", DEFAULT_GRACEFUL_TIMEOUT_MS);
  const forceTimeoutMs = readTimeout("COORTEX_CANCEL_FORCE_MS", DEFAULT_FORCE_TIMEOUT_MS);

  const forward = (signal: NodeJS.Signals) => {
    if (forwarded) {
      return;
    }
    forwarded = true;
    const exitCode = signal === "SIGINT" ? 130 : 143;

    void Promise.resolve()
      .then(async () => {
        await raceWithTimeout(adapter.cancelActiveRun?.("graceful"), gracefulTimeoutMs);
      })
      .catch(async (error) => {
        hooks.warn?.(formatCancellationWarning("graceful", error));
        try {
          await raceWithTimeout(adapter.cancelActiveRun?.("force"), forceTimeoutMs);
        } catch (forceError) {
          hooks.warn?.(formatCancellationWarning("force", forceError));
        }
      })
      .then(async () => {
        try {
          await hooks.awaitRunPersistence?.();
        } catch (error) {
          hooks.warn?.(formatCancellationWarning("persistence", error));
        }
      })
      .finally(() => {
        hooks.exit(exitCode);
      });
  };

  const onSigint = () => {
    forward("SIGINT");
  };
  const onSigterm = () => {
    forward("SIGTERM");
  };

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return {
    handleSignal: forward,
    dispose: () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  };
}

async function raceWithTimeout(
  operation: Promise<void> | undefined,
  timeoutMs: number
): Promise<void> {
  await Promise.race([
    Promise.resolve(operation),
    delay(timeoutMs).then(() => {
      throw new Error(`Timed out after ${timeoutMs}ms.`);
    })
  ]);
}

function readTimeout(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatCancellationWarning(stage: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Cancellation ${stage} handling failed: ${detail}`;
}
