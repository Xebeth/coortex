import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PROJECT_ROOT = process.cwd();
const REQUIRED_PATHS = [
  "src/core/runtime.ts",
  "src/core/types.ts",
  "src/core/events.ts",
  "src/persistence/store.ts",
  "src/projections/runtime-projection.ts",
  "src/recovery/brief.ts",
  "src/adapters/contract.ts",
  "src/hosts/codex/adapter/index.ts",
  "src/workflows/index.ts",
  "src/backends/index.ts",
  "src/telemetry/recorder.ts",
  "src/cli/ctx.ts"
];

test("milestone-1 module map exists at the documented paths", async () => {
  for (const relativePath of REQUIRED_PATHS) {
    const content = await readFile(resolve(PROJECT_ROOT, relativePath), "utf8");
    assert.ok(content.length > 0, `${relativePath} should exist and be non-empty`);
  }
});

test("core remains host-agnostic and does not import adapters, hosts, or persistence", async () => {
  const runtimeSource = await readFile(resolve(PROJECT_ROOT, "src/core/runtime.ts"), "utf8");
  const eventSource = await readFile(resolve(PROJECT_ROOT, "src/core/events.ts"), "utf8");
  const typeSource = await readFile(resolve(PROJECT_ROOT, "src/core/types.ts"), "utf8");

  for (const source of [runtimeSource, eventSource, typeSource]) {
    assert.doesNotMatch(source, /adapters\//);
    assert.doesNotMatch(source, /hosts\//);
    assert.doesNotMatch(source, /persistence\//);
  }
});

test("the adapter contract stays outside core and owns normalization hooks", async () => {
  const contractSource = await readFile(resolve(PROJECT_ROOT, "src/adapters/contract.ts"), "utf8");
  assert.match(contractSource, /normalizeResult\(/);
  assert.match(contractSource, /normalizeDecision\(/);
  assert.match(contractSource, /normalizeTelemetry\(/);

  const coreIndex = await readFile(resolve(PROJECT_ROOT, "src/index.ts"), "utf8");
  assert.doesNotMatch(coreIndex, /\.\/core\/host\.js/);
});

test("the pre-realignment codex tree is gone", async () => {
  await assert.rejects(readFile(resolve(PROJECT_ROOT, "src/core/host.ts"), "utf8"));
  await assert.rejects(readFile(resolve(PROJECT_ROOT, "src/codex/adapter/index.ts"), "utf8"));
});
