# Milestone 3 Research Synthesis

## Purpose

This note consolidates the Milestone 3 workflow research drafts into one
Coortex-facing set of design takeaways.

It is not a complete rewrite of the source drafts. Its job is to keep
the findings that should influence the Milestone 3 workflow-modules plan
and discard the rest.

Reviewed drafts:

- `milestone-3-ms-agent.md`
- `milestone-3-oh-my-openagent.md`
- `milestone-3-omx-first-pass.md`
- `milestone-3-omx.md`

Ignored unless later needed for context:

- `opencode-adapter-findings.md`

## Strongest Takeaways

- Milestone 3 should add a narrow workflow layer with reusable module
  definitions, runtime-owned per-run progress, and guarded durable
  transitions.
  Sources: `milestone-3-ms-agent.md`, `milestone-3-oh-my-openagent.md`,
  `milestone-3-omx-first-pass.md`, `milestone-3-omx.md`
- Workflow progression should be driven by durable assignment, result,
  decision, and status state rather than prompt text, repo sidecars, raw
  hooks, or transcript convention.
  Sources: `milestone-3-oh-my-openagent.md`,
  `milestone-3-omx-first-pass.md`, `milestone-3-omx.md`
- `plan`, `review`, and `verify` should be real workflow modules with
  gate semantics, not labels around one undifferentiated execution path.
  Sources: `milestone-3-omx-first-pass.md`, `milestone-3-omx.md`
- Operator visibility in Milestone 3 should stay minimal: extend
  `status`, `resume`, and `inspect` first; defer richer operator UX.
  Sources: `milestone-3-ms-agent.md`,
  `milestone-3-oh-my-openagent.md`, `milestone-3-omx.md`
- Milestone 3 should checkpoint workflow progress only, but reserve
  blocked or pause semantics now so later HITL and approval work does
  not force a workflow-model rewrite.
  Sources: `milestone-3-ms-agent.md`,
  `milestone-3-oh-my-openagent.md`, `milestone-3-omx.md`

## Recommended For Milestone 3

- Add a small typed workflow contract and registry:
  - module id
  - assignment shaper
  - durable completion predicate
  - next-module resolver
  - minimal per-run workflow state
  Sources: `milestone-3-ms-agent.md`,
  `milestone-3-oh-my-openagent.md`, `milestone-3-omx.md`
- Persist runtime-owned workflow progress only:
  - active workflow id
  - ordered module sequence
  - current module
  - completion status per module
  - blocker state reflected from runtime truth
  Sources: `milestone-3-ms-agent.md`,
  `milestone-3-oh-my-openagent.md`, `milestone-3-omx.md`
- Make `plan` own explicit acceptance criteria and expected evidence
  before advancement.
  Sources: `milestone-3-omx-first-pass.md`,
  `milestone-3-omx.md`
- Make `review` a distinct module that can approve, reject, or require
  iteration based on durable outputs and scope fit.
  Sources: `milestone-3-omx-first-pass.md`,
  `milestone-3-omx.md`
- Make `verify` depend on fresh durable evidence and unresolved-decision
  state rather than controller confidence or transcript sentiment.
  Sources: `milestone-3-omx-first-pass.md`,
  `milestone-3-omx.md`
- Reuse the existing operator surfaces for Milestone 3 visibility:
  - current workflow or module
  - blocking reason
  - last durable advancement or evidence summary
  - resumability
  Sources: `milestone-3-oh-my-openagent.md`,
  `milestone-3-omx-first-pass.md`, `milestone-3-omx.md`
- Design the workflow layer around normalized runtime lifecycle events,
  not raw tool or host hooks.
  Sources: `milestone-3-oh-my-openagent.md`,
  `milestone-3-omx.md`

## Defer Beyond Milestone 3

- Multi-worker orchestration mechanics:
  - fan-out or fan-in
  - overlapping workflows
  - mailbox or dispatch systems
  - worktree and branch-baseline guardrails
  - per-step session reuse
  - handoff flows
  Sources: `milestone-3-ms-agent.md`,
  `milestone-3-oh-my-openagent.md`, `milestone-3-omx-first-pass.md`,
  `milestone-3-omx.md`
- Full approval or HITL systems, richer reviewer choreography, and
  explicit operator intervention loops.
  Sources: `milestone-3-ms-agent.md`,
  `milestone-3-oh-my-openagent.md`
- Provider routing, model-category fallback matrices, marketplace or
  plugin compatibility, OAuth-backed MCP lifecycle, and generic workflow
  middleware.
  Sources: `milestone-3-ms-agent.md`,
  `milestone-3-oh-my-openagent.md`
- Rich operator UX such as HUD, DevUI-style consoles, tmux panes, and
  notification-heavy control surfaces.
  Sources: `milestone-3-ms-agent.md`,
  `milestone-3-oh-my-openagent.md`, `milestone-3-omx.md`
- Declarative workflow authoring and workflow-as-agent exposure across
  broader host boundaries.
  Sources: `milestone-3-ms-agent.md`

## Conflicts And Tension With Current Coortex Assumptions

- Repo-artifact or markdown-backed workflow truth conflicts with
  Coortex's runtime-first rule. Workflow artifacts may support operator
  visibility, but they should not become authoritative state.
  Sources: `milestone-3-oh-my-openagent.md`,
  `milestone-3-omx-first-pass.md`
- Raw tool-hook-driven workflow behavior is the wrong level of
  abstraction for Milestone 3. Workflow modules should consume durable
  runtime state, not adapter internals.
  Sources: `milestone-3-oh-my-openagent.md`
- Full BSP or superstep barrier semantics are stronger than Coortex
  needs for a first linear workflow-module milestone. The useful part is
  explicit progression, not sibling-branch blocking semantics.
  Sources: `milestone-3-ms-agent.md`
- Host-specific rules such as "always delegate", named-agent casts,
  tmux-pane coordination, and worktree-specific semantics should not
  become Coortex workflow invariants.
  Sources: `milestone-3-oh-my-openagent.md`,
  `milestone-3-omx-first-pass.md`

## Open Design Questions

- What exact runtime-owned workflow progress record should Milestone 3
  add?
- What minimum durable outputs must `plan` produce so downstream
  transitions are deterministic?
- Should `review` inspect only planning outputs in Milestone 3, or also
  inspect produced result packets before `verify`?
- When `verify` fails, should Coortex rewind to `review`, rewind to
  `plan`, or record a narrower fix-required outcome without adding a new
  module yet?
- What minimum durable evidence summary is needed so `status`,
  `resume`, and `inspect` can explain blocked advancement without
  pulling the full Phase 5 verification system into Milestone 3?
- Should Milestone 3 reserve a workflow-level paused or pending-input
  state now, or treat everything as `blocked` until approval and HITL
  work arrives later?

Primary source support:

- `milestone-3-ms-agent.md`
- `milestone-3-oh-my-openagent.md`
- `milestone-3-omx-first-pass.md`
- `milestone-3-omx.md`

## Redundant And Superseded Drafts

- `milestone-3-omx-first-pass.md` appears mostly superseded by
  `milestone-3-omx.md`. The later OMX note keeps the same strongest
  workflow conclusions but scopes them more cleanly to Coortex.
- `milestone-3-oh-my-openagent.md` overlaps with the OMX lineage, but
  it still adds useful continuity, compaction, and extension-seam
  judgment that the OMX notes do not cover as directly.
- `milestone-3-ms-agent.md` is not redundant. It is the main source for
  typed workflow contracts, checkpoint-boundary thinking, event-first
  observability, and pause or resume shaping.

## Recommended Final Doc Shape

- Keep one condensed Milestone 3 research summary in `docs/research/`.
- Archive the raw drafts rather than keeping all four as active planning
  inputs.
- `milestone-3-omx-first-pass.md` is the clearest candidate for later
  deletion once the condensed summary is accepted and any needed details
  are preserved elsewhere.
