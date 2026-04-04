# Milestone 2 Manual Test Checklist

## Purpose

This checklist validates Milestone 2 of Coortex as an end-to-end host-integrated execution slice.

Milestone 2 is considered manually validated when Coortex can:

- create or select a real assignment
- build a bounded task envelope
- run one real host execution
- persist results or decisions back into runtime state
- expose the outcome through status and resume paths
- preserve bounded-context behavior under large outputs

This checklist is intended for local developer validation.

---

## Preconditions

Before running these checks:

- the repository builds successfully
- the test suite passes
- the target host for Milestone 2 is installed and usable locally
- any required Coortex profile/kernel generation is implemented
- you know where Coortex runtime data is stored (for example `.coortex/`)

Suggested pre-checks:

- `npm test`
- `ctx doctor`

Record:

- commit being tested
- host being tested
- OS/environment
- date/time
- whether the run is against a clean workspace

---

## Test Data Setup

Use a small disposable repository or temporary fixture project.

It should contain:

- a tiny source file that can be changed safely
- a predictable place for a small edit
- optionally one small failing test for validation scenarios
- enough files to allow a large-output search case

Suggested fixture characteristics:

- one README or text file
- one small source file
- one test file
- a few extra files so search output can be made noisy if needed

---

## Test 1 — Fresh Initialization

### Goal
Validate that Coortex can initialize its local runtime state and profile/kernel artifacts cleanly.

### Steps

1. Start from a clean workspace.
2. Run:
   - `ctx init`
3. Run:
   - `ctx doctor`
4. Inspect generated state/artifacts.

### Expected Results

- Coortex runtime directories/files are created.
- profile/kernel artifacts are generated if Milestone 2 depends on them.
- `ctx doctor` reports a valid environment for the chosen host.
- no unexpected runtime errors occur.

### Record

- created files/directories
- any warnings
- any missing required artifacts

---

## Test 2 — Happy Path Real Run

### Goal
Validate one complete end-to-end run through the real host.

### Example Task

Use a tiny, low-risk task such as:

- change a fixed string in a file
- add a very small helper function
- update a short comment/doc string
- fix a trivial failing test

### Steps

1. Create or select a simple assignment.
2. Trigger the Coortex execution path for the host.
3. Let the run complete normally.
4. Inspect:
   - runtime state
   - result packet
   - status output
   - telemetry output/logs

### Expected Results

- the host is actually launched through the Coortex path
- the bounded task envelope is built and used
- the task completes
- a result packet is persisted
- status reflects completion
- telemetry reflects the run

### Record

- assignment id
- result packet location/id
- changed files
- whether the output matched the task
- any unexpected host behavior

---

## Test 3 — Blocked / Decision Path

### Goal
Validate that Coortex records a blocker or decision instead of silently failing or fabricating success.

### Example Task

Use a task that should legitimately block, such as:

- request an edit to a file that does not exist
- request an edit outside allowed scope
- create an intentionally ambiguous instruction

### Steps

1. Create or select a blocking task.
2. Trigger the Coortex execution path.
3. Inspect:
   - runtime state
   - decision packet or equivalent blocker artifact
   - status output

### Expected Results

- the run does not incorrectly report success
- a decision/blocker artifact is persisted
- status reflects blocked or unresolved state
- the blocked state is visible without reading raw host transcript history

### Record

- blocker/decision packet id
- status output
- whether the reason is explicit and actionable

---

## Test 4 — Large Output / Trimming Path

### Goal
Validate that large output is trimmed before it pollutes prompt-facing context.

### Example Trigger

Use a task or command likely to create noisy output, for example:

- a broad grep/search across many files
- a noisy test failure log
- a generated long shell output

### Steps

1. Run a task that triggers large output during execution.
2. Inspect:
   - stored raw output artifact if applicable
   - trimmed envelope-facing representation
   - telemetry/logs related to trimming
3. Verify the next runtime-facing context does not include the raw unbounded output.

### Expected Results

- large output is not injected wholesale into the envelope
- a trimmed summary/excerpt is used
- a reference to the full artifact/output is preserved if applicable
- envelope size remains bounded
- telemetry/logs record trimming

### Record

- raw output size if measurable
- trimmed output size if measurable
- artifact/reference location
- whether trimming preserved enough information to remain useful

---

## Test 5 — Resume Path

### Goal
Validate that Coortex can rebuild actionable state from durable artifacts after interruption.

### Steps

1. Start a run.
2. Interrupt it in a controlled way before the normal completion path.
   Examples:
   - stop Coortex after task start
   - terminate the process after partial state is written
3. Run:
   - `ctx resume`
4. Inspect:
   - recovery brief
   - status output
   - reconstructed runtime state

### Expected Results

- Coortex rebuilds state from durable artifacts
- `ctx resume` produces a compact actionable recovery brief
- resume does not depend on raw transcript replay
- recovered state matches the expected partial progress

### Record

- interruption point
- recovery brief contents
- whether any state was lost or corrupted
- whether resume is actionable

---

## Test 6 — Repeatability Check

### Goal
Validate that equivalent runs behave consistently enough for Milestone 2.

### Steps

1. Reset the fixture project to a known state.
2. Run the same small happy-path task twice.
3. Compare:
   - status behavior
   - result packet structure
   - telemetry structure
   - envelope shape if inspectable

### Expected Results

- results are structurally consistent
- runtime state transitions are consistent
- no erratic growth or divergence appears in persisted artifacts
- bounded-envelope behavior is stable

### Record

- differences between runs
- whether differences are expected or suspicious

---

## Optional Test 7 — Real Host Usage/Telemetry Check

### Goal
Validate that real host usage/token data is captured if Milestone 2 exposes it.

### Steps

1. Run a small real task.
2. Inspect telemetry output.
3. Verify whether token/usage fields are:
   - populated with real values, or
   - intentionally empty/placeholder

### Expected Results

- if the host exposes authoritative usage data, Coortex records it
- if not yet available, the telemetry schema remains stable and honest

### Record

- which fields were present
- whether values are exact, placeholder, or missing
- any mismatch between claimed and actual telemetry behavior

---

## Manual Sign-Off Criteria

Milestone 2 manual validation is successful when all of the following are true:

- initialization works
- one real host run completes end-to-end
- one blocked run records a decision/blocker correctly
- trimming is exercised and visibly effective
- resume works from durable state
- runtime status reflects the persisted truth
- no critical mismatch appears between runtime state and actual run outcome

---

## Test Log Template

Use this template for each run:

- Date:
- Commit:
- Host:
- Environment:
- Test case:
- Steps run:
- Expected result:
- Actual result:
- Pass/Fail:
- Notes:
