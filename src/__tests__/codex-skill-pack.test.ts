import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const skillPackRoot = resolve(process.cwd(), "src", "hosts", "codex", "profile", "skill-pack");
const skillRefPattern = /\$([A-Za-z0-9_-]+)/g;
const forbiddenFragments = [
  "/home/ngi/.codex",
  "~/.codex",
  "quick_validate.py",
  "skill-creator"
];

test("codex managed skill pack is self-contained", async () => {
  const entries = await readdir(skillPackRoot, { withFileTypes: true });
  const managedSkills = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

  assert.deepEqual(managedSkills, [
    "coortex-review-lane",
    "review-baseline",
    "review-fixer",
    "review-orchestrator"
  ]);

  const externalRefs = new Map<string, string[]>();
  const forbiddenHits = new Map<string, string[]>();
  const pycacheDirs: string[] = [];

  await walk(skillPackRoot, async (path) => {
    if (path.endsWith("__pycache__")) {
      pycacheDirs.push(path);
      return;
    }

    const content = await readFile(path, "utf8");
    const refs = [...content.matchAll(skillRefPattern)]
      .map((match) => match[1])
      .filter((name): name is string => typeof name === "string");
    const missing = [...new Set(refs.filter((name) => !managedSkills.includes(name)))];
    if (missing.length > 0) {
      externalRefs.set(path, missing);
    }

    const hits = forbiddenFragments.filter((fragment) => content.includes(fragment));
    if (hits.length > 0) {
      forbiddenHits.set(path, hits);
    }
  });

  assert.deepEqual(pycacheDirs, []);
  assert.deepEqual(Object.fromEntries(externalRefs), {});
  assert.deepEqual(Object.fromEntries(forbiddenHits), {});
});

async function walk(
  dir: string,
  visitFile: (path: string) => Promise<void>
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, visitFile);
      continue;
    }
    await visitFile(path);
  }
}
