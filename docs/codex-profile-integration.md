# Codex Host Integration

## Purpose

This document describes the **Codex reference adapter** for Coortex.

Coortex is designed to be host-agnostic at the core. Codex is the first host adapter used to validate that design in practice.

This document is therefore intentionally host-specific. It should be read together with:

- `docs/architecture.md`
- `docs/module-boundaries.md`
- `docs/coortex-ideal-spec.md`

---

## Why Codex Is the Reference Adapter

Codex is a practical first host because it provides:

- profile-scoped configuration
- model instruction file support
- host-native CLI operation
- a well-defined current integration target

Using Codex first does **not** make Coortex a Codex-only project.

---

## Adapter Responsibilities

The Codex adapter is responsible for:

- generating or validating the Coortex Codex profile
- generating the stable kernel instruction file for Codex
- building bounded task envelopes for Codex runs
- surfacing native Codex session identity for runtime-owned attachments
- invoking wrapped Codex same-session resume by stored session id when available
- capturing structured last-message output for wrapped launch and
  wrapped resume so runtime-owned result/decision persistence stays
  symmetric
- mapping Codex-native execution results into Coortex runtime artifacts
- normalizing Codex-native telemetry into the Coortex telemetry model

The Codex adapter is **not** responsible for owning runtime truth.

---

## Profile Strategy

The Codex adapter should isolate Coortex behavior behind a dedicated profile.

The default Codex profile must remain unchanged.

The Coortex-specific Codex profile may manage:

- `model_instructions_file`
- Coortex-specific developer instructions if needed
- Coortex-specific environment/config placeholders
- later host-specific hooks or MCP registration if required

These profile artifacts are preparatory only. They must not become the
authoritative source of attachment state, claim state, or provenance.

---

## Kernel Strategy

The Codex adapter uses a small static kernel file.

The kernel should define only the stable interaction contract:

- consult runtime before acting
- obey runtime-provided scope
- use recovery brief when resuming
- keep outputs structured and concise

The kernel must remain:

- static
- small
- overlay-free

It must not embed live runtime state or dynamic overlays.

`.codex/config.toml`, `kernel.md`, `profile.json`, and related
repo-local Codex artifacts stay non-authoritative. Coortex authority
begins only when a wrapped `ctx run` launch or wrapped `ctx resume`
reclaim creates or updates a runtime-owned attachment.

---

## Bounded Envelope Strategy

The Codex adapter must build bounded task envelopes from runtime state.

A first-milestone envelope may include:

- current objective
- write scope
- required outputs
- compact recovery brief when relevant

The adapter must apply trimming before large data enters the prompt-facing path.

---

## Trimming Requirements

For the Codex adapter, trimming is required to keep the envelope bounded.

The adapter must:

- trim large tool outputs into excerpts or summaries
- preserve references to full artifacts
- keep the recovery brief compact
- check envelope size before use

This logic should live in adapter-facing envelope/trimming code, not in the core runtime.

---

## Telemetry Relationship

The Codex adapter should normalize host-native usage or session metadata into the Coortex telemetry model.

The telemetry schema must stay Coortex-owned even if the host surface is Codex-specific.

## Wrapped Session Boundary

For the current hardening slice:

- `ctx init` initializes the runtime and prepares Codex host artifacts
- `ctx run` performs the wrapped Codex launch path
- `ctx resume` reclaims the authoritative Codex session when one
  attached or detached-but-resumable attachment still carries a stored
  native session id, then returns that attachment to
  `detached-but-resumable` when the wrapped reclaim exits without a
  terminal runtime outcome
- wrapped reclaim claims and heartbeats the same lease-backed host-run
  attempt boundary as wrapped launch while the Codex resume process is
  still live
- the claim-or-adopt step for that reclaim boundary is atomic inside the
  adapter / host-run store seam, including the path that reuses an
  already-live eligible lease
- wrapped reclaim uses the structured `exec resume` path so successful
  resume records result/decision outcomes and completion telemetry
  through the same runtime-owned outcome pipeline as wrapped launch
- wrapped reclaim reports three states at the adapter/runtime seam:
  `reclaimed`, `verified_then_failed`, and `unverified_failed`; the
  runtime must not collapse a verified same-session reclaim back into an
  unverified/foreign failure once the requested native session has been
  observed and matched
- wrapped launch and wrapped reclaim are expected to remain behaviorally
  aligned on runtime-owned persistence, attachment finalization, and
  operator-visible status semantics; reclaim adds only the prior
  attachment / same-session verification requirement
- attachment and claim provenance remain runtime-owned facts through the
  same lifecycle: wrapped reclaim records `resume`, and reconciliation-
  promoted resumable authority records `recovery`
- the same finalization rule applies when a completed Codex host run is
  recovered after an interruption: recovered decisions and recovered
  partial results detach back to detached-but-resumable authority,
  while only recovered terminal results release the attachment and
  claim; if the binding is still provisional but Codex already
  persisted a durable native session id, recovery promotes it into
  detached resumable authority instead of clearing it as abandoned; if
  the binding is already detached but missing that id, recovery
  backfills it from durable host metadata before wrapped reclaim is
  considered available
- wrapped launch and wrapped reclaim use the same default sandbox /
  approval mode selection at the Codex CLI boundary; reclaim must not
  introduce a second unmodeled execution policy difference
- the `-o` last-message file is the authoritative structured-output
  boundary; if Codex does not materialize that file, Coortex may fall
  back to the streamed `agent_message` JSONL item, but only when that
  text is itself the same raw JSON object with no surrounding prose or
  code fences

The native Codex session id remains metadata on the runtime-owned
attachment, not a replacement for that attachment record.

Launch-side native session identity is surfaced to runtime lifecycle
callbacks only after the matching running host-run record has been
persisted successfully. If that thread-start metadata write degrades,
the host outcome may still complete successfully, but Coortex
intentionally withholds the native session id from both runtime
attachment truth and the completed host-run record.

---

## Design Rule

The Codex adapter is the **reference adapter**, not the architectural center of the project.

The core runtime must remain usable in principle with additional host adapters later.
