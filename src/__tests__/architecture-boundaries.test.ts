import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { readdir } from "node:fs/promises";

const PROJECT_ROOT = process.cwd();
const MODULE_POLICIES: Record<string, { allowedRoots: string[] }> = {
  "src/adapters": {
    allowedRoots: ["adapters", "core", "recovery", "telemetry", "utils"]
  },
  "src/hosts": {
    allowedRoots: ["hosts", "adapters", "core", "telemetry", "utils"]
  },
  "src/projections": {
    allowedRoots: ["projections", "core", "persistence", "utils"]
  },
  "src/recovery": {
    allowedRoots: ["recovery", "core", "projections", "utils"]
  },
  "src/workflows": {
    allowedRoots: ["workflows", "core", "utils"]
  },
  "src/cli": {
    allowedRoots: [
      "cli",
      "adapters",
      "backends",
      "config",
      "core",
      "guidance",
      "hooks",
      "hosts",
      "persistence",
      "plugins",
      "projections",
      "recovery",
      "telemetry",
      "utils",
      "verification",
      "workflows"
    ]
  },
  "src/guidance": {
    allowedRoots: ["guidance", "core", "utils"]
  },
  "src/verification": {
    allowedRoots: ["verification", "core", "utils"]
  },
  "src/hooks": {
    allowedRoots: ["hooks", "core", "telemetry", "utils"]
  },
  "src/plugins": {
    allowedRoots: ["plugins", "core", "utils"]
  }
};
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
  assert.match(contractSource, /writeJsonArtifact\(/);
  assert.match(contractSource, /readJsonArtifact</);

  const coreIndex = await readFile(resolve(PROJECT_ROOT, "src/index.ts"), "utf8");
  assert.doesNotMatch(coreIndex, /\.\/core\/host\.js/);
});

test("the pre-realignment codex tree is gone", async () => {
  await assert.rejects(readFile(resolve(PROJECT_ROOT, "src/core/host.ts"), "utf8"));
  await assert.rejects(readFile(resolve(PROJECT_ROOT, "src/codex/adapter/index.ts"), "utf8"));
});

test("hosts do not import persistence internals", async () => {
  const hostFiles = await listTsFiles(resolve(PROJECT_ROOT, "src/hosts"));
  for (const file of hostFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /persistence\//,
      `${relative(PROJECT_ROOT, file)} must not import persistence modules`
    );
  }
});

test("documented milestone dependency directions are enforced", async () => {
  for (const [moduleRoot, policy] of Object.entries(MODULE_POLICIES)) {
    await assertModuleImports(moduleRoot, policy);
  }
});

test("cli uses public persistence surfaces rather than persistence internals", async () => {
  const cliFiles = await listTsFiles(resolve(PROJECT_ROOT, "src/cli"));
  for (const file of cliFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /persistence\/files\.js/,
      `${relative(PROJECT_ROOT, file)} must not import persistence/files.js`
    );
  }
});

async function listTsFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = resolve(root, entry.name);
      if (entry.isDirectory()) {
        return listTsFiles(fullPath);
      }
      return fullPath.endsWith(".ts") ? [fullPath] : [];
    })
  );
  return files.flat();
}

async function assertModuleImports(
  moduleRoot: string,
  options: { allowedRoots: string[] }
): Promise<void> {
  const absoluteRoot = resolve(PROJECT_ROOT, moduleRoot);
  const files = await listTsFilesIfPresent(absoluteRoot);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const imports = extractInternalImportRoots(source, file);
    for (const importedRoot of imports) {
      assert.ok(
        options.allowedRoots.includes(importedRoot),
        `${relative(PROJECT_ROOT, file)} must not depend on src/${importedRoot}/`
      );
    }
  }
}

function extractInternalImportRoots(source: string, importingFile: string): string[] {
  const matches = [
    ...source.matchAll(/from\s+"([^"]+)"/g),
    ...source.matchAll(/from\s+'([^']+)'/g),
    ...source.matchAll(/import\(\s*"([^"]+)"\s*\)/g),
    ...source.matchAll(/import\(\s*'([^']+)'\s*\)/g),
    ...source.matchAll(/require\(\s*"([^"]+)"\s*\)/g),
    ...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)
  ];

  const roots = new Set<string>();
  for (const match of matches) {
    const specifier = match[1];
    if (!specifier?.startsWith(".")) {
      continue;
    }

    const resolved = resolve(importingFile, "..", specifier);
    const relativeToSrc = relative(resolve(PROJECT_ROOT, "src"), resolved);
    if (relativeToSrc.startsWith("..")) {
      continue;
    }

    const [root] = relativeToSrc.split("/");
    if (root) {
      roots.add(root);
    }
  }

  return [...roots];
}

async function listTsFilesIfPresent(root: string): Promise<string[]> {
  try {
    return await listTsFiles(root);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}
