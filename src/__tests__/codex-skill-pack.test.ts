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
  "skill-creator",
  "PyYAML"
];

test("codex managed skill pack is self-contained", async () => {
  const entries = await readdir(skillPackRoot, { withFileTypes: true });
  const managedSkills = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

  assert.deepEqual(managedSkills, [
    "coortex-deslop",
    "coortex-fixer-lane",
    "coortex-review",
    "coortex-review-lane",
    "fixer-orchestrator",
    "review-baseline",
    "review-fixer",
    "review-orchestrator",
    "seam-walkback-review"
  ]);

  const externalRefs = new Map<string, string[]>();
  const forbiddenHits = new Map<string, string[]>();
  const pycacheDirs: string[] = [];
  const ambientPythonDeps = new Map<string, string[]>();

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

    if (path.endsWith(".py")) {
      const imports = ["import yaml", "from yaml import"].filter((fragment) => content.includes(fragment));
      if (imports.length > 0) {
        ambientPythonDeps.set(path, imports);
      }
    }
  });

  assert.deepEqual(pycacheDirs, []);
  assert.deepEqual(Object.fromEntries(ambientPythonDeps), {});
  assert.deepEqual(Object.fromEntries(externalRefs), {});
  assert.deepEqual(Object.fromEntries(forbiddenHits), {});
});

test("managed workflow skills require conversation-visible progress guidance", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/coortex-deslop/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-deslop/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/coortex-review/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-review/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-baseline/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-baseline/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-fixer/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-fixer/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/seam-walkback-review/SKILL.md",
    "src/hosts/codex/profile/skill-pack/seam-walkback-review/agents/openai.yaml"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /conversation-visible plan|conversation-visible progress/i, path);
  }
});

test("managed workflow skills treat progress updates as non-blocking", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/coortex-deslop/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-deslop/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/coortex-review/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-review/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-baseline/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-baseline/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-fixer/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-fixer/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/seam-walkback-review/SKILL.md",
    "src/hosts/codex/profile/skill-pack/seam-walkback-review/agents/openai.yaml"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /non-blocking|not approval checkpoints|not pause points|not approval gates/i, path);
  }
});

test("managed workflow skills explicitly mention update_plan usage", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/coortex-deslop/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-deslop/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/coortex-review/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-review/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-baseline/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-baseline/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-fixer/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-fixer/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/seam-walkback-review/SKILL.md",
    "src/hosts/codex/profile/skill-pack/seam-walkback-review/agents/openai.yaml"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /update_plan/, path);
  }
});

test("seam walkback explicitly forbids offer-to-continue stops after successful slices", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/seam-walkback-review/SKILL.md",
    "src/hosts/codex/profile/skill-pack/seam-walkback-review/agents/openai.yaml"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /if you want, I can continue|offer-to-continue|successful slice commit|Terminal conditions/i, path);
    assert.match(content, /packet is ready|campaign completed cleanly|packet emission alone is not terminal|packet-ready is an intermediate state|final_review/i, path);
  }
});

test("review orchestrator requires persisted review handoff artifacts for actionable outcomes", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/review-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/references/report-contract.md",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/references/trace-artifact.md",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/references/return-review.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(
      content,
      /review-handoff\.json|persist(?:ed)? .*review_handoff|review_handoff_path|review_handoff_emitted/i,
      path
    );
  }
});

test("managed skills explain installed script path resolution", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/coortex-review/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-review/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/coortex-deslop/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-deslop/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/references/trace-artifact.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/trace-artifact.md",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/SKILL.md",
    "src/hosts/codex/profile/skill-pack/seam-walkback-review/SKILL.md",
    "src/hosts/codex/profile/skill-pack/seam-walkback-review/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/seam-walkback-review/references/trace-artifact.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(
      content,
      /\.codex\/skills|installed skill directory|not relative to the repository root/i,
      path
    );
  }
});

test("fixer orchestrator explicitly requires same-worker continuation semantics", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/execution-model.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/lane-continuation.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(
      content,
      /same worker|same-worker|resume the same worker|do not close that worker|do not .*respawn|do not .*restart.*from scratch/i,
      path
    );
  }
});

test("fixer verification boundary keeps broader suites on the coordinator", async () => {
  const laneFiles = [
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/agents/openai.yaml"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of laneFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /targeted verification only|do not run repo-wide|do not run .*full-suite|broader verification .* belongs to the coordinator/i, path);
  }

  const coordinatorFiles = [
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/execution-model.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of coordinatorFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /broader verification[\s\S]*coordinator|normal suite[\s\S]*coordinator|do not have every lane run/i, path);
  }
});

test("fixer orchestrator explicitly requires atomic semantic commits and patient waiting", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/execution-model.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/trace-artifact.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(
      content,
      /atomic commit|one atomic commit|do not batch several approved lanes|commit subject/i,
      path
    );
    assert.match(
      content,
      /do not .*lane ids?|do not .*slice ids?|do not .*wave ids?|do not include generated .*lane_id|must not include .*lane ids?|must not include generated lane\/slice\/wave ids|must not include generated .*lane_id/i,
      path
    );
  }

  const waitingFiles = [
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/execution-model.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of waitingFiles) {
    const content = await readFile(path, "utf8");
    assert.match(
      content,
      /wait patiently|do not steer|do not interrupt|do not .*kill|quiet/i,
      path
    );
    assert.match(
      content,
      /\$coortex-review[\s\S]*\$coortex-deslop|\$coortex-deslop[\s\S]*\$coortex-review/i,
      path
    );
  }
});

test("fixer coordinator stays read-only and hands findings back to the same lane", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/execution-model.md",
    "src/hosts/codex/profile/skill-pack/coortex-deslop/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-deslop/agents/openai.yaml"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(
      content,
      /read-only|must not patch code, tests, or docs locally|must not edit code, tests, or docs itself/i,
      path
    );
    assert.match(
      content,
      /same implementer\s+lane|same original implementer\s+lane|hand[\s\S]*back to the same implementer\s+lane/i,
      path
    );
  }
});

test("fixer orchestrator makes terminal lock clearing explicit", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/trace-artifact.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /final_fix/i, path);
    assert.match(content, /active_campaign_cleared/i, path);
    assert.match(content, /active-review-campaign\.json/i, path);
  }
});

test("coortex review explicitly checks the shared campaign lock before standalone review", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/coortex-review/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-review/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/coortex-review/scripts/review_state.py"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(
      content,
      /check-active-campaign|active-review-campaign|owner_host_session_id|owner_host_thread_id|owner_started_from_cwd/i,
      path
    );
    assert.match(
      content,
      /fixer-orchestrator|review-orchestrator|seam-walkback-review/i,
      path
    );
  }
});

async function walk(
  dir: string,
  visitFile: (path: string) => Promise<void>
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") {
        continue;
      }
      await walk(path, visitFile);
      continue;
    }
    await visitFile(path);
  }
}
