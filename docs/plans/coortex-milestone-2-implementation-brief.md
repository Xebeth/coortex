# Coortex Milestone 2 Implementation Brief

## 1. Increment

Milestone 2 is the **smallest end-to-end real execution path** for Coortex.

This milestone proves that the runtime-first architecture can drive one real host-integrated run from durable runtime state through to durable runtime output.

The reference host for this milestone is Codex.

## 2. Milestone 2 objective

Deliver one real Coortex execution path that works end-to-end for a single host.

The path for this milestone is:

1. a runtime assignment exists
2. Coortex builds a bounded envelope from runtime state
3. the Codex adapter uses that envelope for a real host run
4. the host outcome is captured as a result packet or decision packet
5. that outcome is persisted back into Coortex runtime state

Milestone 2 uses the Milestone 1 runtime, persistence, recovery brief generation, bounded envelopes, trimming, telemetry scaffold, profile/kernel scaffolding, and basic CLI as its base.

Recovery work in this milestone is limited to the minimum needed for this execution path to function at all.

## 3. In-scope items

Milestone 2 includes only the following:

- one real host only: Codex
- assignment -> bounded envelope -> host run -> result or decision capture -> persistence into runtime state
- the minimum shared adapter-contract change required for one real run
- the minimum Codex adapter work required to initiate or represent that run
- storage of only the host-specific metadata strictly required to reconnect the run to runtime state
- minimal CLI or operator wiring needed to trigger and inspect the path
- basic telemetry capture from the host when the chosen execution path exposes it
- only the minimum recovery or resume integration needed for the path to be usable
- automated tests that prove the path works end-to-end

## 4. Out-of-scope items

Milestone 2 explicitly excludes the following:

- recovery hardening as a milestone goal
- lease or heartbeat models
- stale ownership or stale-claim reconciliation
- full resume or requeue policy
- multi-host support
- workflow engine expansion
- plugins or hooks expansion
- approvals, governance, or HITL systems
- advanced compaction or broader history-management work
- backend abstraction beyond what is strictly needed for the first real host path
- broad execution-lifecycle modeling beyond what this single real run requires

## 5. Acceptance criteria

Milestone 2 is complete when all of the following are true:

1. Coortex can take an existing runtime assignment and build the bounded envelope used for a real Codex-backed run.
2. The Codex adapter can execute or initiate one real host run from that envelope.
3. The outcome of that run can be captured as either a result packet or a decision packet.
4. The captured outcome is persisted back into Coortex runtime state through the normal persistence path.
5. The command surface can trigger and inspect this flow.
6. Basic host telemetry is recorded when the selected Codex execution path exposes it.
7. Basic resume or inspection works for this path only to the extent required for the path to function.
8. Automated tests prove the end-to-end path without requiring broader recovery-hardening behavior.

## 6. Suggested milestone after Milestone 2

The milestone after Milestone 2 should be **execution recovery hardening**.

That milestone should address the robustness intentionally excluded here, including:

- stronger interruption semantics
- lease and heartbeat support
- stale ownership reconciliation
- explicit resume and requeue policy
- richer recovery-oriented telemetry
