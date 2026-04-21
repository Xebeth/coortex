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
For bounded-envelope fields such as `estimatedChars`, the adapter must
count the actual prompt payload sent to Codex, including schema and
prompt framing, not just the serialized envelope object.
Project-local `.codex/config.toml` installation is not the same thing as
isolating Codex user state. Live acceptance that invokes the real Codex
binary must run with a temporary HOME/XDG user-state root so operator
trust/config under `~/.codex` stays untouched, and the harness must
teardown fixture repos plus isolated user-state trees without leaving
new `coortex-live-*` paths under the OS temp root or new tracked
live-harness/Codex descendant processes behind.
The managed `model_instructions_file` entry written into
project-local `.codex/config.toml` should stay repo-relative
(`../.coortex/adapters/codex/kernel.md`) rather than embedding an
absolute project path.

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
- when reclaim adopts an already-live eligible lease, the adopted run
  must carry a fresh durable owner fence so later heartbeat,
  completion, rollback, destructive terminal lease cleanup, and
  degraded terminal-warning cleanup writes can prove the adopted owner
  instead of trusting only the initial takeover CAS; terminal cleanup
  must not drop back to an unfenced plain delete after the proof CAS
- wrapped reclaim uses the structured `exec resume` path so successful
  resume records result/decision outcomes and completion telemetry
  through the same runtime-owned outcome pipeline as wrapped launch
- the CLI wraps live launch and live wrapped reclaim in the same
  cancellation boundary so operator-visible cancellation warnings and
  persistence waiting stay aligned across both entrypoints
- a custom runner may advertise native wrapped resume support only when
  it exposes a live `startResume()` handle with cancellation and wait
  semantics; a fire-and-forget `runResume()` function is not sufficient
  to claim reclaim support
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
- wrapped launch and wrapped reclaim consume the same Coortex bypass
  policy input, including when the adapter is given an injected custom
  runner via `startExec()` / `startResume()`, but their default Codex
  CLI modes are host-specific: launch uses `codex exec --sandbox
  workspace-write`, while wrapped resume uses the supported
  `codex exec resume --full-auto` path unless bypass mode is enabled
- the `-o` last-message file is the authoritative structured-output
  boundary; if Codex does not materialize that file, Coortex may fall
  back to the transcript carrier that preserves the same raw final JSON
  object (for example `turn.completed.last_agent_message` or a streamed
  `agent_message` item), but only when that text is itself the same raw
  JSON object with no surrounding prose or code fences

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
