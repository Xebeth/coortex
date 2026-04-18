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
- installing the Coortex-managed Codex review skill pack into project-local `.codex/skills`
- building bounded task envelopes for Codex runs
- mapping Codex-native execution results into Coortex runtime artifacts
- normalizing Codex-native telemetry into the Coortex telemetry model

The Codex adapter is **not** responsible for owning runtime truth.

---

## Profile Strategy

The Codex adapter should isolate Coortex behavior behind a dedicated profile.

The default Codex profile must remain unchanged.

The Coortex-specific Codex profile may manage:

- `model_instructions_file`
- the Coortex-managed review skill pack installed into project-local `.codex/skills`, including the user-facing bounded reviewer and the lane-review dependency skill used by the review workflow
- Coortex-specific developer instructions if needed
- Coortex-specific environment/config placeholders
- later host-specific hooks or MCP registration if required

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

---

## Design Rule

The Codex adapter is the **reference adapter**, not the architectural center of the project.

The core runtime must remain usable in principle with additional host adapters later.
