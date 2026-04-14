# Milestone 2 Hardening — Session Attachment Boundary

## Objective

Harden the reference-host integration boundary so Coortex authority is
bound to an explicit Coortex-managed host session.

This slice focuses on session attachment, assignment ownership, and the
boundary between ordinary host use and Coortex-managed operation.

## Scope

This hardening slice covers:

1. explicit session attachment for Coortex-managed host sessions
2. non-ambient runtime authority for the reference host
3. assignment claim and ownership rules for attached sessions
4. durable provenance for runtime initialization and host activation
5. test coverage for attached vs unattached behavior
6. documentation of the wrapped-host operating model

## Design decisions

### 1. Coortex is wrapper-first

The primary operating model is a Coortex-managed host session with the
host TUI as the primary user experience.

### 2. Runtime authority is explicit, not ambient

Runtime state, workflow state, write scope, and recovery rules become
binding only for an explicitly attached Coortex-managed host session.

Repo-local `.coortex/` state must not make ordinary host use
Coortex-governed by ambient presence alone.

### 3. Session attachment is required for assignment authority

Assignment ownership, write scope, workflow state, and recovery state
must bind to an explicit session attachment boundary.

Unattached or foreign host sessions must not inherit those constraints.

### 4. Assignment ownership must be exclusive

The runtime must prevent:

- foreign claim of an already attached assignment
- duplicate assignment issuance to multiple attached sessions
- stale or leftover host-run artifacts from re-binding work that has
  already been recovered or released

### 5. Final command UX remains open

This slice defines the attachment boundary and authority model. It does
not freeze the final user-facing command shape for runtime init, host
setup, or wrapped host launch.

## Deliverables

This slice should deliver:

1. an explicit session-attachment model for the reference host
2. a non-ambient boundary between ordinary host use and Coortex-managed
   host sessions
3. authoritative assignment-claim rules that prevent foreign claim and
   duplicate assignment issuance
4. durable provenance for runtime initialization and host activation
5. tests that prove unattached sessions ignore repo-local Coortex state
6. tests that prove attached sessions obey runtime authority correctly
7. documentation that explains the wrapped-host operating model clearly

## Non-goals

This slice does not:

- broaden scope into richer in-host UX
- add a second host adapter
- add the full verification/review subsystem
- define the full long-term command surface for wrapped host launch

## Acceptance criteria

This hardening slice is successful when:

1. ordinary host use remains unchanged outside an explicit Coortex
   integration path
2. repo-local `.coortex/` state is inert for unattached sessions
3. attached sessions can be identified and matched back to authoritative
   runtime state
4. attached assignments cannot be claimed twice
5. recovered or cleaned-up host-run artifacts cannot silently re-bind or
   re-block unrelated work
6. the reference-host docs explain the operating model without implying
   ambient repo-wide authority
