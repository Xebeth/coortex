## Research: oh-my-openagent patterns for Coortex Milestone 3

### Findings

Version baseline: I checked project-primary docs/code on the moving dev branch on April 13, 2026. package.json
reports 3.17.0, and the repo is still in the oh-my-openagent/oh-my-opencode rename transition.
Source: package (https://github.com/code-yeongyu/oh-my-openagent/blob/dev/package.json#L1-L10), README note
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/README.md#L112-L116)

#### Hook-backed workflow controller

Observed patterns: Real workflows are not just prompts. They combine named roles (Prometheus, Metis, Momus, Atlas,
Sisyphus-Junior) with runtime hooks such as start-work, atlas, and continuation hooks.
Evidence from docs/code: The guide shows a planner/consultant/reviewer/controller/worker split, while the runtime
separately registers session hooks and an Atlas agent prompt factory.
Likely compatible: Runtime-owned workflow modules with explicit planner/controller/executor roles fit Coortex’s
current state-owned direction.
Would require architectural change: oh-my-openagent treats markdown plan files in .sisyphus/ as part of the control
plane.
Probably defer: Copying the whole named-agent cast and model-persona tuning for Milestone 3.
Source: orchestration guide
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/orchestration.md#L29-L228), Atlas agent
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/agents/atlas/agent.ts#L1-L117), session hook registry
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/plugin/hooks/create-session-hooks.ts#L68-L94)
Version/recency notes: One generated reference says Atlas cannot delegate, but the guide, Atlas prompt, and tests sh
ow task() delegation is the intended behavior. See stale ref
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/features.md#L44-L53), Atlas delegation test
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/agents/tool-restrictions.test.ts#L102-L113).

#### Semantic workflow boundary: categories + skills

Observed patterns: The controller delegates by semantic category (quick, deep, visual-engineering, ultrabrain) plus
load_skills, not by raw model name. A category spawns Sisyphus-Junior; skills add domain instructions and optional
MCPs.
Evidence from docs/code: The docs define categories as “what kind of work is this?” and skills as “what tools/
knowledge are needed?”, and Atlas prompts are built around task(category=..., load_skills=[...]).
Likely compatible: Coortex could expose workflow-module-to-executor contracts as intent/capability labels instead of
host/model specifics.
Would require architectural change: oh-my-openagent’s model/provider routing tables and per-category fallback chains
assume a broader multi-provider execution layer than Coortex has today.
Probably defer: Full provider fallback matrices and model-specialized category families.
Source: category+skill guide
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/orchestration.md#L273-L324), features reference
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/features.md#L97-L191), Atlas prompt
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/agents/atlas/default-prompt-sections.ts#L83-L92), Juni
or restrictions
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/agents/sisyphus-junior/agent.ts#L31-L34), Junior permi
ssions (https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/agents/sisyphus-junior/agent.ts#L96-L107)
Version/recency notes: Docs and code align well on categories/skills as the practical delegation boundary.

#### Layered continuity and restart behavior

Observed patterns: Continuity is layered: plan-level resume via boulder.json, per-top-level-task preferred subagent
session reuse, persistent task JSON with dependencies, and manual continuation via session tools and /handoff.
Evidence from docs/code: /start-work resumes or initializes workflow state, Boulder state stores session_ids,
task_sessions, and worktree_path, Atlas persists preferred subagent sessions per task, and task records store
blockedBy/blocks plus threadID.
Likely compatible: Coortex should strongly consider persistent workflow state, reusable execution-session handles,
and explicit inspect/resume surfaces.
Would require architectural change: oh-my-openagent encodes workflow truth in repo artifacts and markdown checkbox
parsing; Coortex currently keeps state runtime-owned.
Probably defer: Per-task or per-step session reuse, handoff, worktree-aware orchestration, and repo-materialized
state files for Milestone 3.
Source: session continuity guide
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/orchestration.md#L363-L415), Boulder types
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/boulder-state/types.ts#L8-L50), start-work co
ntext builder
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/hooks/start-work/context-info-builder.ts#L46-L71), Atl
as task-session tracking
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/hooks/atlas/tool-execute-after.ts#L100-L160), backgrou
nd lineage tracking
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/hooks/atlas/background-launch-session-tracking.ts#L9-L61),
task_create (https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/tools/task/task-create.ts#L15-L100), sessi
on tools (https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/tools/session-manager/tools.ts#L62-L196), han
doff
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/builtin-commands/templates/handoff.ts#L24-L159)
Version/recency notes: The task graph is real, but some enablement/docs still look transitional between experimental
.task_system and sisyphus.tasks. See experimental schema
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/config/schema/experimental.ts#L4-L13), tasks config do
cs (https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/configuration.md#L436-L456).

#### Compaction/trimming is workflow-aware

Observed patterns: Compaction is treated as a workflow event. The runtime checkpoints agent/model/tools before
compaction, restores todos after compaction, filters compaction markers from continuation logic, and can preemptively
compact before hard limits.
Evidence from docs/code: There are dedicated compaction hooks, a todo-preserver, preemptive compaction, session
recovery with optional auto-resume, and the event pipeline compacts before sending continue after a recovery.
Likely compatible: Coortex should make compaction/recovery visible at runtime-owned rebuild/resume boundaries,
without exposing raw compaction or tool hooks directly to workflow modules in Milestone 3.
Would require architectural change: If compaction currently belongs only to the host adapter, Coortex would need to
surface it into the runtime workflow contract.
Probably defer: Direct raw compaction/session hook delivery into workflow modules, and the exact toast/tmux UX around
recovery.
Source: hook taxonomy
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/features.md#L736-L810), compaction injector
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/hooks/compaction-context-injector/hook.ts#L38-L67), co
mpaction recovery
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/hooks/compaction-context-injector/recovery.ts#L29-L127),
todo preserver
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/hooks/compaction-todo-preserver/hook.ts#L57-L127), pre
emptive compaction
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/hooks/preemptive-compaction.ts#L65-L158), session reco
very (https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/hooks/session-recovery/hook.ts#L50-L147), event c
ontinue path (https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/plugin/event.ts#L611-L645)
Version/recency notes: This area is strongly backed by implementation, not just docs.

#### Extension seams are layered, but uneven

Observed patterns: Extension seams exist at several layers: built-in hooks, local/custom skills, skill-embedded MCPs
with OAuth, Claude Code config import, and Claude marketplace plugin loading with cwd scope filtering.
Evidence from docs/code: Skills are discovered from multiple project/user path conventions, MCP config can come from
skill frontmatter or mcp.json, MCP sessions are managed per skill/session/server, and marketplace plugins are
filtered by project scope.
Likely compatible: A local hook surface plus local workflow/skill extensions is a strong fit for Coortex M3 or
shortly after.
Would require architectural change: Full Claude compatibility, marketplace plugin ingestion, and OAuth-backed MCP
lifecycle management.
Probably defer: Marketplace plugin compatibility for Milestone 3.
Source: hook/MCP/compat docs
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/features.md#L732-L1040), skill discovery
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/opencode-skill-loader/loader.ts#L70-L120), sk
ill MCP config
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/opencode-skill-loader/skill-mcp-config.ts#L6-L30),
skill MCP manager
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/skill-mcp-manager/manager.ts#L15-L157), plugin
discovery
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/claude-code-plugin-loader/discovery.ts#L167-L220),
plugin scope filter
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/claude-code-plugin-loader/scope-filter.ts#L16-L29)
Version/recency notes: Docs say skills.sources[].path can be a remote URL, but current code drops http:///https:// s
ources. Treat local path-based loading as the implemented pattern. See docs
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/configuration.md#L470-L501), code
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/opencode-skill-loader/config-source-discovery.ts#L51-L59).

#### Operator-facing visibility and control are first-class

Observed patterns: Operators get explicit commands (start-work, stop-continuation, handoff), session inspection
tools, background-task notifications, optional tmux panes for live subagent output, concurrency limits, and explicit
approval gates for the final verification wave.
Evidence from docs/code: Config docs expose background concurrency and tmux controls, notification text tells the
operator when to fetch results, session tools expose list/read/search/info, and Atlas reminders pause for explicit
user approval before closing the final wave.
Likely compatible: Coortex Milestone 3 should include phase/status visibility plus resume and inspect controls.
Would require architectural change: tmux-specific pane orchestration if Coortex wants a host-neutral UI.
Probably defer: Stop, handoff, approval gates, and the full “Final Verification Wave” reviewer choreography until the
core workflow modules are stable.
Source: background concurrency + commands + tmux
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/configuration.md#L386-L560), background age
nts docs (https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/features.md#L55-L95), notification
s/continuation docs (https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/features.md#L785-L810),
tmux manager
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/tmux-subagent/manager.ts#L48-L103), background
notification template
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/features/background-agent/background-task-notification-template.ts#L12-L73),
session tools (https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/tools/session-manager/tools.ts#L73-L196),
final approval gate
(https://github.com/code-yeongyu/oh-my-openagent/blob/dev/src/hooks/atlas/verification-reminders.ts#L123-L160)
Version/recency notes: Docs and code align on operator controls; the tmux-specific pieces are clearly implementation-
specific rather than universal workflow requirements.

### Synthesis

Patterns worth integrating

- Treat workflow modules as runtime-owned controllers with typed phases/tasks, not as prompt bundles or
  artifact-parsing bridges.
- Use semantic workflow intents/capabilities at delegation boundaries instead of binding workflows directly to host/
  model specifics.
- Keep workflow truth runtime-owned, but allow a small materialized audit surface for operator visibility and
  recovery support.
- Add persistent workflow continuity early, but scope reuse to the plan level first and prioritize resume/inspect
  over handoff.
- Make compaction/recovery workflow-aware in the runtime, while keeping Milestone 3 workflow modules on durable
  lifecycle events rather than raw tool or host hooks.

Patterns worth exploring later

- Final-wave reviewer/approval gates and richer controller/reviewer/verifier choreography.
- Local skill/MCP extensions before any attempt at external marketplace/plugin compatibility.
- Raw tool-hook-driven workflow reactions.
- Host-specific operator visualization like tmux panes.
- Multi-provider/model routing tables and fallback chains.

Coortex direction notes

- Workflow truth stays runtime-owned.
- A small materialized audit surface is allowed, but artifacts should support operator visibility and recovery rather
  than act as workflow authority.
- Milestone 3 should use typed workflow phases/tasks.
- Artifact parsing is the wrong direction for Milestone 3 and should not be used as a temporary bridge.
- Workflow modules should consume durable runtime lifecycle events, not raw tool lifecycle hooks.
- The minimal Milestone 3 lifecycle surface is:
  - assignment started
  - result submitted
  - decision opened
  - decision resolved
  - assignment failed
  - runtime resumed / state rebuilt
- Session reuse should stay plan-scoped for the first cut.
- Per-step reuse should be deferred because it risks distorting workflow semantics before progression rules are
  stable.
- The minimum operator surface for Milestone 3 is:
  - status visibility of the current workflow phase
  - resume
  - inspect
- Stop, handoff, and approval should remain out of the first Milestone 3 cut unless explicit transfer or HITL
  semantics are introduced separately.
