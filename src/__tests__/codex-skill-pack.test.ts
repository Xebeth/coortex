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
    "implementation-coordinator",
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
    "src/hosts/codex/profile/skill-pack/implementation-coordinator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/implementation-coordinator/agents/openai.yaml",
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
    "src/hosts/codex/profile/skill-pack/implementation-coordinator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/implementation-coordinator/agents/openai.yaml",
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
    "src/hosts/codex/profile/skill-pack/implementation-coordinator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/implementation-coordinator/agents/openai.yaml",
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

test("review baseline supports optional surface focus areas without extra matrix refs", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/review-baseline/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-baseline/references/baseline-schema.md",
    "src/hosts/codex/profile/skill-pack/review-baseline/references/quality-gate.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /review_focus_areas/i, path);
    assert.doesNotMatch(content, /test_matrix_refs/i, path);
  }

  const schema = await readFile(
    resolve(
      process.cwd(),
      "src/hosts/codex/profile/skill-pack/review-baseline/references/baseline-schema.md"
    ),
    "utf8"
  );
  assert.match(schema, /supporting_anchors[\s\S]*contract_docs|contract_docs[\s\S]*supporting_anchors/i);
  assert.match(schema, /review_focus_areas.*list of short strings|list of short strings.*review_focus_areas/i);
});

test("review baseline and orchestrator share deterministic baseline validation", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/review-baseline/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-baseline/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/references/prep-and-refusal.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /validate-review-baseline/i, path);
    assert.match(content, /shared|same|helper validation|deterministic/i, path);
  }

  const script = await readFile(
    resolve(
      process.cwd(),
      "src/hosts/codex/profile/skill-pack/review-orchestrator/scripts/return_review_state.py"
    ),
    "utf8"
  );
  assert.match(script, /validate-review-baseline/i);
  assert.match(script, /baseline_kind|variant_strategy|alternative_baselines/i);
});

test("review skills consume baseline focus areas as recurring failure checks", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/coortex-review/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-review/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/coortex-review-lane/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-review-lane/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/references/execution-model.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /review_focus_areas/i, path);
    assert.match(content, /recurring[\s-]+failure[\s-]+checks|recurring[\s-]+failure[\s-]+themes/i, path);
    assert.match(
      content,
      /automatic findings|replacement custom lenses|extra lanes|does not create extra lanes/i,
      path
    );
  }

  const executionModel = await readFile(
    resolve(
      process.cwd(),
      "src/hosts/codex/profile/skill-pack/review-orchestrator/references/execution-model.md"
    ),
    "utf8"
  );
  assert.match(
    executionModel,
    /Family exploration lanes[\s\S]*review_focus_areas[\s\S]*originating surface ids/i
  );
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
    "src/hosts/codex/profile/skill-pack/implementation-coordinator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/implementation-coordinator/agents/openai.yaml",
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

test("script-using managed skills treat helper steps as canonical protocol", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/coortex-review/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-review/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/coortex-deslop/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-deslop/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/implementation-coordinator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/implementation-coordinator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/seam-walkback-review/SKILL.md",
    "src/hosts/codex/profile/skill-pack/seam-walkback-review/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/agents/openai.yaml"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(
      content,
      /canonical|exact helper command|exact command|named subcommands|canonical identity check|canonical safety check/i,
      path
    );
    assert.match(content, /authoritative/i, path);
    assert.match(
      content,
      /stop rather than|protocol error|replace .* with prose|do not reconstruct|do not recreat/i,
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
    assert.match(
      content,
      /do not run repo-wide|do not run .*full-suite|broader verification .* belongs to the coordinator/i,
      path
    );
    assert.doesNotMatch(content, /lanes own targeted verification only|run targeted verification only/i, path);
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

test("fixer workflows require local gates before targeted tests", async () => {
  const laneFiles = [
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-fixer/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-fixer/agents/openai.yaml"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of laneFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /build,\s+compile,?\s+or typecheck|build,\s+compile,\s+typecheck|build\/compile\/typecheck/i, path);
    assert.match(content, /local quality|InspectCode|static analysis|lint/i, path);
    assert.match(content, /before\s+targeted/i, path);
    assert.match(content, /verification-blocked/i, path);
  }

  const coordinatorFiles = [
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/execution-model.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/result-contract.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/review-return-handoff.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/trace-artifact.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of coordinatorFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /touched[- ](?:unit|project|area)|touched_build_gate|final_touched_build_gate/i, path);
    assert.match(content, /local quality|local_quality_gates|final_local_quality_gates|InspectCode/i, path);
    assert.match(content, /build,\s+compile,?\s+or typecheck|build,\s+compile,\s+typecheck|build\/compile\/typecheck/i, path);
    assert.match(content, /before (?:targeted|test[- ]suite|any test|tests)/i, path);
  }

  const orderingFiles = [
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/execution-model.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of orderingFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /full[- ]suite.*last|full test suite last/i, path);
  }

  const fixerHelper = await readFile(
    resolve(
      process.cwd(),
      "src/hosts/codex/profile/skill-pack/fixer-orchestrator/scripts/fix_result_state.py"
    ),
    "utf8"
  );
  assert.match(fixerHelper, /TOUCHED_BUILD_GATE_STATUSES/);
  assert.match(fixerHelper, /LOCAL_QUALITY_GATE_STATUSES/);
  assert.match(fixerHelper, /touched_build_gate/);
  assert.match(fixerHelper, /local_quality_gates/);
  assert.match(fixerHelper, /final_touched_build_gate/);
  assert.match(fixerHelper, /final_local_quality_gates/);
});

test("fixer lanes require lane-safe self-review under parent campaigns", async () => {
  const laneFiles = [
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/agents/openai.yaml"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of laneFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /\$coortex-review-lane/i, path);
    assert.match(
      content,
      /standalone[\s`]+\$coortex-review[\s\S]*refus|parent[\s\S]*campaign|active .*campaign lock/i,
      path
    );
  }

  const coordinatorFiles = [
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/execution-model.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of coordinatorFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /\$coortex-review-lane/i, path);
    assert.match(
      content,
      /standalone[\s`]+\$coortex-review[\s\S]*refus|parent[\s\S]*campaign|active .*campaign lock/i,
      path
    );
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
  }
});

test("repair-oriented skills run deslop before review", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/review-fixer/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-fixer/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/execution-model.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /\$coortex-deslop[\s\S]*\$coortex-review(?:-lane)?/i, path);
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

test("fixer orchestrator makes approval ladder and cleanup sweep explicit", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/execution-model.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/trace-artifact.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /closure_approved|pre_commit_gate_result|commit_ready/i, path);
    assert.match(content, /cleanup-only|commit-ready cleanup sweep/i, path);
  }
});

test("fixer commit-ready evidence and unrelated edit handling are explicit", async () => {
  const fixerFiles = [
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/execution-model.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/trace-artifact.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of fixerFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /self[_-]?deslop|lane-safe\s+self-review|lane_review_evidence/i, path);
    assert.match(content, /seam-residue sweep|seam_residue_sweep_evidence/i, path);
    assert.match(content, /final targeted|final_targeted_verification/i, path);
    assert.match(content, /excluded_unrelated_edits|unrelated edits/i, path);
  }
});

test("coortex deslop flags mechanical seam-move residue in touched scope", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/coortex-deslop/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-deslop/agents/openai.yaml"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(
      content,
      /stale shims|pass-through wrappers|dead helpers|unused params|type-only import|removed-symbol residue/i,
      path
    );
  }
});

test("coortex deslop keeps semantic ownership checks judgment-driven", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/coortex-deslop/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-deslop/agents/openai.yaml"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /semantic ownership|ownership-collapse/i, path);
    assert.match(content, /checklist-driven|implementer\/reviewer judgment|not automatic/i, path);
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

test("review skills delegate current-work packet mechanics to the helper", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/coortex-review/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-review/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/coortex-review-lane/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-review-lane/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-orchestrator/references/execution-model.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /current-work|mini-surface/i, path);
    assert.match(content, /validate-current-work-packet|review_state\.py/i, path);
    assert.match(content, /validate-current-work-review-output|surface_checked|matrix_not_applicable/i, path);
    assert.match(content, /do not reconstruct|instead of recreating|authoritative/i, path);
  }

  const helper = await readFile(
    resolve(
      process.cwd(),
      "src/hosts/codex/profile/skill-pack/coortex-review/scripts/review_state.py"
    ),
    "utf8"
  );
  assert.match(helper, /validate-current-work-packet/);
  assert.match(helper, /validate-current-work-review-output/);
});

test("implementation coordinator turns ordinary intent into reviewed current-work flow", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/implementation-coordinator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/implementation-coordinator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/implementation-coordinator/references/implementation-handoff.md"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /implementation handoff|handoff present|implementation_handoff/i, path);
    assert.match(content, /bare \"?done\"?|summary-only/i, path);
    assert.match(content, /same implementation lane|same implementer/i, path);
  }

  const coordinator = await readFile(expectedFiles[0]!, "utf8");
  const prompt = await readFile(expectedFiles[1]!, "utf8");
  assert.match(coordinator, /ordinary|normal implementation request|normal prompt|user-facing/i);
  assert.match(coordinator, /current-work|mini-surface|validate-current-work-packet/i);
  assert.match(coordinator, /spec review[\s\S]*before implementation|before implementation[\s\S]*spec review/i);
  assert.match(coordinator, /return review|surface_checked|matrix_not_applicable/i);
  assert.match(coordinator, /do not spawn subagents unless|delegation follows host policy/i);
  assert.match(coordinator, /Do not commit unless|commit only when allowed/i);
  assert.match(coordinator, /fixer-orchestrator|review_handoff/i);
  assert.match(coordinator, /references\/implementation-handoff\.md/i);
  assert.match(prompt, /references\/implementation-handoff\.md/i);

  const currentWorkDocs = await readFile(
    resolve(process.cwd(), "docs/current-work-review-packets.md"),
    "utf8"
  );
  assert.match(currentWorkDocs, /Implementation handoff and intake/i);
  assert.match(currentWorkDocs, /bare \"?done\"?|summary-only/i);
  assert.match(currentWorkDocs, /same implementation lane/i);
});

test("fixer skills preserve current-work packets through review gates", async () => {
  const expectedFiles = [
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/SKILL.md",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/fixer-orchestrator/references/execution-model.md",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/SKILL.md",
    "src/hosts/codex/profile/skill-pack/coortex-fixer-lane/agents/openai.yaml",
    "src/hosts/codex/profile/skill-pack/review-fixer/SKILL.md",
    "src/hosts/codex/profile/skill-pack/review-fixer/agents/openai.yaml"
  ].map((path) => resolve(process.cwd(), path));

  for (const path of expectedFiles) {
    const content = await readFile(path, "utf8");
    assert.match(content, /current-work|mini-surface|current_work_review_packet/i, path);
    assert.match(content, /validate-current-work-packet|review_state\.py/i, path);
    assert.match(content, /validate-current-work-review-output|surface_checked|matrix_not_applicable/i, path);
    assert.match(content, /preserve|pass (?:it|the same packet)|same packet/i, path);
  }

  const fixerHelper = await readFile(
    resolve(
      process.cwd(),
      "src/hosts/codex/profile/skill-pack/fixer-orchestrator/scripts/fix_result_state.py"
    ),
    "utf8"
  );
  assert.match(fixerHelper, /current_work_review_packet/);
  assert.match(fixerHelper, /validate-current-work-packet/);
  assert.match(fixerHelper, /validate-current-work-review-output/);
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
