# Research: oh-my-codex patterns for Coortex Milestone 3

This note focuses on workflow and coordination patterns in
`Yeachan-Heo/oh-my-codex`, using project-primary sources first. The
goal is to extract reusable workflow ideas for Coortex Milestone 3, not
to produce an implementation plan.

## Findings

### 1. Explicit workflow modules with guarded handoffs

**Observed patterns**

- OMX treats planning and execution as named workflows or modes rather
  than leaving progression implicit in free-form prompts.
- Public guidance presents a canonical flow of
  `deep-interview -> ralplan -> ralph|team`.
- The durable team runtime still carries internal phases such as
  `team-plan`, `team-prd`, `team-exec`, `team-verify`, and `team-fix`.
- State transitions are governed by an allowlisted workflow state model
  instead of arbitrary mode switching.

**Evidence from docs/code**

- `README.md` defines the recommended flow as clarify, approve plan,
  then choose either persistent solo execution or coordinated parallel
  execution.
- `docs/STATE_MODEL.md` defines authoritative state, overlap rules, and
  allowed transitions between workflows.
- `src/team/orchestrator.ts` and `src/team/phase-controller.ts` retain a
  concrete internal phase model for the team runtime, including verify
  and fix loops.

**Likely compatible**

- High. Coortex already has runtime-owned state and one real execution
  path, so explicit workflow-module boundaries with guarded handoffs fit
  its current direction well.

**Would require architectural change**

- Full multi-workflow overlap and reconciliation rules would require a
  broader state model than Coortex currently appears to expose.

**Probably defer**

- Public support for overlapping active workflows.
- Full internal phase richness if Milestone 3 only needs a smaller
  module chain.

**Source**

- https://github.com/Yeachan-Heo/oh-my-codex/blob/main/README.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/docs/STATE_MODEL.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/src/team/orchestrator.ts
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/src/team/phase-controller.ts

**Version/recency notes**

- The repo `main` branch is newer than the public site for some OMX
  surfaces. `CHANGELOG.md` and `package.json` are at `0.12.5` dated
  2026-04-11, so the repo is the stronger source for current workflow
  behavior.

### 2. Clear controller / worker / reviewer / verifier separation

**Observed patterns**

- OMX separates orchestration, execution, review, and verification into
  different roles and prompts instead of treating them as one blended
  agent behavior.
- Workers are scoped to assigned tasks and are expected to report claim
  state, progress, blockers, and completion.
- Reviewer-style roles such as architect and critic are used for
  judgment and rejection or approval, not for direct implementation.
- Verifier is framed as a separate evidence-gathering surface rather
  than a synonym for executor self-report.

**Evidence from docs/code**

- `docs/guidance-schema.md` standardizes role, execution protocol,
  verification, and recovery sections across prompts and overlays.
- `AGENTS.md` distinguishes between the leader experience, skills, and
  project guidance.
- `skills/worker/SKILL.md` defines explicit worker claim and completion
  behavior.
- `prompts/architect.md`, `prompts/critic.md`, `prompts/executor.md`,
  and `prompts/verifier.md` use sharply different remits.

**Likely compatible**

- High. Coortex Milestone 3 can likely benefit from first-class module
  contracts for controller, review, and verification responsibilities.

**Would require architectural change**

- Coortex would need to make workflow-role boundaries explicit in
  runtime truth rather than keeping them only as adapter or prompt
  conventions.

**Probably defer**

- Consensus planning with planner, architect, and critic on every
  workflow. That looks valuable for higher-risk work, but heavy for an
  initial workflow-module milestone.

**Source**

- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/docs/guidance-schema.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/AGENTS.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/skills/worker/SKILL.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/prompts/architect.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/prompts/critic.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/prompts/executor.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/prompts/verifier.md

**Version/recency notes**

- These role contracts are present in the current repo tree and appear
  aligned rather than legacy leftovers.

### 3. Task lifecycle is claim-safe and runtime-authoritative

**Observed patterns**

- Workers do not mutate task state by ad hoc transcript convention.
  They claim tasks, update status, record blockers, and mark completion
  through an authoritative mutation surface.
- Task progression is dependency-aware and guarded by optimistic version
  checks and claim tokens.
- Claims can expire and be reclaimed, which reduces permanent deadlock
  from abandoned work.
- The docs explicitly reject tmux-pane nudges or transcript-only updates
  as the source of truth for task progression.

**Evidence from docs/code**

- `skills/worker/SKILL.md` requires ACK, claim, execute, and complete
  behavior via the team APIs and CLI interop.
- `docs/interop-team-mutation-contract.md` makes `omx team api` the
  authoritative mutation path and describes file edits as mediated by
  that contract rather than direct truth.
- `src/team/contracts.ts` defines task status/event structures.
- `src/team/state/tasks.ts` implements dependency checks, lease-style
  claims, optimistic versioning, terminal transitions, and reclaim
  behavior.

**Likely compatible**

- Very high. This is one of the strongest transferable patterns for
  Coortex once Milestone 3 introduces real workflow modules and durable
  progression.

**Would require architectural change**

- Coortex would need a small authoritative workflow-state mutation API
  instead of relying only on controller-local logic or host callbacks.

**Probably defer**

- Full mailbox, dispatch, and team transport mechanics.
- Rich parallel staffing logic before Coortex actually has multiple
  durable workers.

**Source**

- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/skills/worker/SKILL.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/docs/interop-team-mutation-contract.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/src/team/contracts.ts
- https://github.com/Yeachan-Heo/oh-my-codex/blob/main/src/team/state/tasks.ts

**Version/recency notes**

- Recent `0.12.5` release notes still call out workflow-state and
  team-runtime hardening, which suggests the task lifecycle contract is
  actively maintained.

### 4. Completion is gated by fresh evidence, not executor confidence

**Observed patterns**

- OMX repeatedly distinguishes implementation from proof.
- Executors are not supposed to declare success based on confidence or
  inspection alone.
- Verification requires fresh evidence such as tests, build output, lint
  status, and explicit zero-pending work checks.
- Ralph adds a reviewer gate on top of evidence by requiring architect
  verification before completion.

**Evidence from docs/code**

- `prompts/executor.md` says completion claims need real proof.
- `prompts/verifier.md` is dedicated to proving or disproving completion
  using commands, diffs, and direct checks.
- `skills/ralph/SKILL.md` requires fresh test/build/lint evidence, no
  pending work, and architect verification before task completion.
- `skills/team/SKILL.md` treats team completion as terminal task state,
  not informal worker claims.
- `src/verification/verifier.ts` encodes structured verification
  expectations.

**Likely compatible**

- High. Coortex Milestone 3 should likely separate workflow completion
  from transcript sentiment and require durable evidence summaries.

**Would require architectural change**

- If Coortex currently considers a controller verdict sufficient for
  completion, it would need a stronger evidence record and verifier
  surface.

**Probably defer**

- Mandatory architect sign-off for every non-trivial workflow.
- Ralph's full deslop and re-verification tail.

**Source**

- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/prompts/executor.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/prompts/verifier.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/skills/ralph/SKILL.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/skills/team/SKILL.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/src/verification/verifier.ts

**Version/recency notes**

- The evidence-first completion rule is consistent across prompt,
  workflow-skill, and code surfaces, which makes it look like a stable
  project assumption.

### 5. Recovery discipline starts before execution and continues through resume and cleanup

**Observed patterns**

- Heavy workflows are expected to start from a reusable context
  snapshot, not from a vague prompt alone.
- Mode state is durable and session-aware, with explicit precedence and
  reconciliation logic.
- Recovery is treated as part of the workflow contract, including
  startup recovery, stale-state rejection, cleanup, and resume.
- For parallel execution, OMX now tracks a baseline branch per active
  task and guards against starting workers from the wrong baseline.

**Evidence from docs/code**

- `skills/team/SKILL.md` and `skills/ralph/SKILL.md` both require
  `.omx/context/{slug}-*.md` grounding snapshots before serious
  execution.
- `docs/STATE_MODEL.md` defines authoritative state and reconciliation
  rules.
- `src/team/current-task-baseline.ts` persists
  `current-task-baseline.json` with active task metadata.
- `src/team/worktree.ts` enforces clean leader workspaces, guarded
  branch selection, and worktree rollback behavior.
- `CHANGELOG.md` and `docs/release-notes-0.12.5.md` call out current
  task baseline guardrails, workflow handoff correctness, and startup
  recovery fixes.

**Likely compatible**

- High for reusable grounding snapshots and resumable runtime-owned
  workflow state.

**Would require architectural change**

- Baseline-branch tracking and worktree guardrails assume a more
  parallel and branch-aware execution model than Coortex currently
  exposes.

**Probably defer**

- Full worktree management and branch guardrails until Coortex has real
  parallel execution or branch-isolated workers.

**Source**

- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/skills/team/SKILL.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/skills/ralph/SKILL.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/docs/STATE_MODEL.md
- https://github.com/Yeachan-Heo/oh-my-codex/blob/main/src/team/current-task-baseline.ts
- https://github.com/Yeachan-Heo/oh-my-codex/blob/main/src/team/worktree.ts
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/CHANGELOG.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/docs/release-notes-0.12.5.md

**Version/recency notes**

- The baseline-branch guardrail was added in `0.12.5`, so it is a
  current coordination concern, not an older abandoned pattern.

### 6. Operator visibility is state-backed first, with richer UX layered on top

**Observed patterns**

- OMX exposes workflow visibility through durable state and CLI surfaces
  before adding richer UI such as the HUD.
- Operators can query status, resume execution, await stabilization, and
  inspect traces.
- Trace and note/notepad surfaces support long-running work and
  compaction resilience without becoming the source of workflow truth.
- The durable team runtime is explicitly separated from lighter native
  subagent use.

**Evidence from docs/code**

- `skills/team/SKILL.md` defines `status`, `resume`, `await`, and
  `shutdown` as operator-facing lifecycle commands.
- `src/hud/state.ts` reads session-aware mode state to build HUD
  renderable context.
- `skills/trace/SKILL.md` exposes timeline and summary views of agent
  flow.
- `skills/note/SKILL.md` persists `.omx/notepad.md` for durable notes
  and pruning discipline.
- `README.md` distinguishes native delegation from the durable team
  runtime with tmux and worktrees.

**Likely compatible**

- Medium-high. Basic workflow visibility such as current module,
  blocker, evidence summary, and resumability looks directly useful for
  Coortex Milestone 3.

**Would require architectural change**

- A full HUD-style operator layer would require a stable event and state
  schema that Coortex may not yet expose.

**Probably defer**

- Full HUD and tmux-driven operator experience.
- Compaction-resilience features beyond simple workflow inspection and
  durable status.

**Source**

- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/skills/team/SKILL.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/src/hud/state.ts
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/skills/trace/SKILL.md
- https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/skills/note/SKILL.md
- https://github.com/Yeachan-Heo/oh-my-codex/blob/main/README.md

**Version/recency notes**

- `0.12.4` and `0.12.5` both include significant HUD, trace, session,
  and state hardening. That suggests operator visibility is an active
  layer, but still secondary to the underlying state model.

## Synthesis

**Patterns worth integrating**

- Reusable workflow modules with guarded durable transitions.
- A shared contract shape for controller, worker, reviewer, and
  verifier-style modules.
- Runtime-authoritative workflow and task mutation instead of transcript
  convention.
- Evidence-based completion gates on the existing executor path.
- Resumable runtime-owned workflow state with workflow-progress
  checkpointing only.

**Patterns worth exploring later**

- Internal phase controllers behind a simpler public workflow surface.
- Worktree and baseline-branch guardrails once Coortex has multi-worker
  or branch-isolated execution.
- Rich operator visibility beyond status and inspection surfaces.
- Heavier consensus-planning loops for high-risk work.
- Full executor/verifier separation as distinct workflow modules.
- Reusable context snapshots inside the workflow layer.

### Coortex direction notes

These notes capture the current Coortex-shaped answer for Milestone 3.
They are project decisions informed by the OMX research, not claims
about OMX itself.

**Workflow shape**

- Prefer reusable workflow modules with guarded transitions.
- Do not model Milestone 3 as global runtime mode switching.
- Module definitions should be reusable, but progression between modules
  should be explicit and guarded by durable runtime truth.

**Execution and verification**

- Keep one executor path for Milestone 3, but enforce an evidence
  contract on it now.
- Do not split executor and verifier into fully separate workflow
  modules yet.
- Design the workflow contract so `verify` can become a genuinely
  separate module later without changing the underlying progression
  model.

**Authoritative mutation API**

- Introduce a small runtime-owned transition API before host transports
  diversify.
- The minimum surface should be enough to:
  - create or shape the next assignment
  - record module completion
  - open and resolve blockers
  - advance workflow progress
- Host adapters should not mutate workflow progress directly.

**Checkpoint scope**

- Checkpoint workflow progress only, alongside existing runtime durable
  state.
- Do not add reusable context snapshots to the workflow layer yet.
- That avoids creating a second persistence and recovery problem inside
  Milestone 3.

**Operator visibility**

- Start with status plus inspect or trace-style visibility.
- Defer HUD-like operator surfaces until later.
- The first operator-facing requirement is visibility into:
  - active workflow
  - current module
  - blocking reason
  - last durable advancement

**Practical Milestone 3 shape**

- reusable workflow modules
- guarded durable transitions
- one executor path with an evidence contract
- small runtime-owned mutation API
- checkpoint workflow progress only
- operator visibility through status, inspect, and trace-style surfaces
  first
