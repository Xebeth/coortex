# Swarm Role Concepts

## Status

Exploratory notes.

These ideas are not committed architecture. They capture possible roles for
Agent UI, OpenCode, Codex, or Coortex-backed swarm experiments.

## Context

The motivating problem is that long-running agent rooms can accumulate noisy
conversation state from users and other agents. That noise can contaminate
review, repair, and coordination work if chat history becomes the agent's
effective memory.

The working assumption is:

**Chat is transport. Runtime and validated artifacts should own truth.**

## Watchdog

A watchdog monitors agent-side protocol integrity.

Possible responsibilities:

- detect scope drift
- detect duplicate work
- detect stale session or stale packet use
- detect premature closeout
- detect hidden worker output that was not resurfaced
- ensure delegated agents produce required outputs
- flag agents that answer in the wrong room or without required evidence

The watchdog should not normally coordinate work. Its default role is to report
protocol drift and required corrections.

Suggested output shape:

```text
WATCHDOG
status: ok | warning | blocked
issue:
evidence:
required_correction:
```

## Moderator / Broker

A moderator monitors user-side intent and routes conversation.

Possible responsibilities:

- classify a user message as current-task, tangent, new task, meta, blocker, or
  decision
- route a message to the right agent or room
- fork a new room when a tangent would pollute the active thread
- queue off-topic work for later
- ask for confirmation when the routing decision is ambiguous
- summarize only the relevant context before handing off to a specialist

The moderator is different from the watchdog:

```text
Watchdog = agent-side protocol integrity
Moderator = user-side intent routing
```

The moderator should not scold the user. It should make routing decisions
explicit and protect specialist context from mixed-subject conversation.

## Specialists

Specialists should not be just personalities. A useful specialist combines:

- role authority
- surface or domain ownership
- bounded task packet
- lifecycle

Conceptual formula:

```text
specialist = role authority + surface ownership + bounded packet + lifetime
```

This aligns with the compiled surface-agent model:

```text
Surfaces own knowledge.
Roles own authority.
Packets own scope.
Helpers own truth.
Agents own judgment.
```

Possible specialist roles:

- surface reviewer
- return reviewer
- fixer specialist
- implementer specialist
- surface reconciliation reviewer
- family memory curator
- surface compiler / helper

## Lifetime Rules

Long-lived specialists are useful for ownership and orientation, but risky as
direct reviewers. Their chat transcripts can become noisy, biased, or stale.

Preferred split:

- long-lived specialist identity owns a surface or domain
- durable knowledge lives in surface packs, known-family memory, contract docs,
  and approved reconciliation artifacts
- review and return-review should normally use fresh transient invocations
- implementer and fixer loops may use run-scoped persistence when continuity is
  useful

For reviews, a long-lived specialist can provide curated context, but the review
judgment should usually happen in a forked or transient reviewer context.

## Keeping Specialists Up To Date

Specialists should refresh from durable artifacts, not from arbitrary chat
history.

Possible update path:

1. work completes
2. reconciliation or review artifact is validated
3. approved updates land in surface packs or known-family memory
4. future specialist invocations bind those artifacts by path, version, and hash

Old chat memory must not override sealed packets, validation results, or durable
surface knowledge.

## Enforcement Levels

These ideas can be tested incrementally.

### Prompt-only prototype

- create watchdog and moderator agents
- add strict output contracts
- add them to rooms manually
- useful for behavior testing
- weak enforcement

### Agent UI integration

- moderator becomes the default user-facing lead
- watchdog is auto-added to team or private rooms
- routing and forking use chat creation tools
- warnings are surfaced visibly
- medium enforcement

### Coortex runtime enforcement

- active threads, assignments, scopes, expected outputs, and owners live in
  runtime state
- moderator routes against active runtime state
- watchdog compares chat and session events against expected runtime state
- violations become durable events, blockers, or required corrections
- strong enforcement

## Open Questions

- Should watchdog and moderator be separate agents or two modes of one control
  agent?
- What minimum runtime state does a moderator need to route correctly?
- What minimum event stream does a watchdog need to detect missing resurfacing?
- How should forked specialist invocations inherit curated context without
  inheriting noisy chat history?
- How should user-side tangents be queued without becoming hidden work?
