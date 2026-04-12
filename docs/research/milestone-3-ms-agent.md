## Research: Microsoft Agent Framework patterns for Coortex Milestone 3

### Findings
**1. Typed executor graph and composition as the core module boundary**

**Observed patterns**: Workflows are directed graphs of typed executors and edges; executors can be deterministic logic or agents, and build-time validation checks type compatibility, reachability, and edge correctness. Composition happens two ways: nesting sub-workflows, and wrapping a workflow so it behaves like an agent.

**Evidence from docs/code**: Official docs define executors as the fundamental workflow unit and workflows as validated graphs; repo orchestration code shows builders are thin layers over `WorkflowBuilder`, with small adapter executors for input normalization and output shaping rather than hidden orchestration magic.

**Likely compatible**: High. This maps well to "real workflow modules" if Coortex wants explicit runtime-owned module contracts instead of model-chosen routing.

**Would require architectural change**: If Coortex currently treats modules as untyped host callbacks, or expects nested modules to freely keep mutable internal state. Agent Framework explicitly warns that reused sub-workflow instances should be stateless under concurrent execution.

**Probably defer**: Declarative/YAML workflow authoring; it is a higher-level surface, not the core runtime pattern.

**Source**:
- https://learn.microsoft.com/en-us/agent-framework/workflows/workflows
- https://learn.microsoft.com/en-us/agent-framework/workflows/executors
- https://learn.microsoft.com/en-us/agent-framework/workflows/advanced/sub-workflows
- https://learn.microsoft.com/en-us/agent-framework/workflows/as-agents
- https://learn.microsoft.com/en-us/agent-framework/workflows/declarative
- https://raw.githubusercontent.com/microsoft/agent-framework/main/python/packages/orchestrations/agent_framework_orchestrations/_sequential.py

**Version/recency notes**: Docs cited here were updated between March 5, 2026 and March 26, 2026; the Learn overview still marks Agent Framework as public preview.

**2. Phase progression is explicit, and the runtime is opinionated about barriers**

**Observed patterns**: Core workflow execution uses supersteps: collect pending messages, route them, run all triggered executors concurrently, then hit a synchronization barrier before the next superstep. On top of that, Agent Framework ships prebuilt orchestration families: sequential, concurrent, handoff, group chat, and magentic.

**Evidence from docs/code**: The workflow docs explicitly describe a modified Pregel/BSP model and note that one long-running branch can hold back another branch after fan-out. Repo code shows `ConcurrentBuilder` using explicit dispatcher/aggregator nodes, while `GroupChatOrchestrator` is a real state machine driven by a speaker-selection function.

**Likely compatible**: Explicit phase/edge progression is compatible and useful. Sequential and bounded fan-out/fan-in patterns look most relevant to Milestone 3.

**Would require architectural change**: Adopting full BSP barrier semantics would change Coortex assumptions if it wants independently advancing branches or per-edge streaming progression without sibling blocking.

**Probably defer**: Handoff, group chat, and magentic; they are real patterns, but they bring more autonomy and conversational state than Milestone 3 likely needs.

**Source**:
- https://learn.microsoft.com/en-us/agent-framework/workflows/workflows
- https://learn.microsoft.com/en-us/agent-framework/journey/workflows
- https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/
- https://raw.githubusercontent.com/microsoft/agent-framework/main/python/packages/orchestrations/agent_framework_orchestrations/_concurrent.py
- https://raw.githubusercontent.com/microsoft/agent-framework/main/python/packages/orchestrations/agent_framework_orchestrations/_group_chat.py
- https://raw.githubusercontent.com/microsoft/agent-framework/main/python/packages/orchestrations/agent_framework_orchestrations/_handoff.py

**Version/recency notes**: Docs were updated March 5, 2026, March 31, 2026, and April 10, 2026; repo `main` is actively evolving.

**3. Checkpointing is tied to execution boundaries, not arbitrary callbacks**

**Observed patterns**: Checkpoints are created at superstep boundaries and capture executor state, pending messages, pending requests/responses, and shared state. Sub-workflows participate in parent checkpoints, and orchestration code has a unified serialized state surface for group-chat-style patterns.

**Evidence from docs/code**: The checkpoint docs define end-of-superstep persistence; sub-workflow docs say parent checkpoints serialize inner workflow progress; repo orchestration code has an `OrchestrationState` dataclass specifically for checkpoint serialization. State docs also warn against reusing workflow instances across separate tasks because executor and agent state can leak across runs.

**Likely compatible**: Medium-high, if Coortex wants restartable modules and runtime-owned persistence keyed to explicit workflow progression.

**Would require architectural change**: Coortex would need serializable/resettable module state and a clearer distinction between "workflow instance for one task" and "reusable module definition."

**Probably defer**: Durable storage backends and richer time-travel/debug UX; the core idea is boundary-based resume, not full historical replay tooling.

**Source**:
- https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints
- https://learn.microsoft.com/en-us/agent-framework/workflows/state
- https://learn.microsoft.com/en-us/agent-framework/workflows/advanced/sub-workflows
- https://raw.githubusercontent.com/microsoft/agent-framework/main/python/packages/orchestrations/agent_framework_orchestrations/_orchestration_state.py

**Version/recency notes**: Docs were updated March 26, 2026 and April 2, 2026.

**4. Cross-cutting behavior is modeled mostly with agent middleware plus explicit workflow nodes**

**Observed patterns**: Agent Framework has first-class middleware for agent runs, function calls, and chat clients. I did not find a first-class workflow-step middleware abstraction in the workflow docs or the inspected repo surfaces; instead, workflow builders encode cross-cutting behavior with adapter executors, wrapped sub-workflows, and agent middleware where needed.

**Evidence from docs/code**: `SequentialBuilder` uses internal executors for normalization, response adaptation, and end-of-chain output; handoff uses middleware to intercept tool calls and convert them into routing signals; approval support is implemented as a wrapped workflow loop, not as a generic interceptor chain around every executor.

**Likely compatible**: High, if Coortex keeps workflow modules explicit and reserves generic interception for the runtime/host layer.

**Would require architectural change**: If Coortex expects "middleware around every workflow step" as a primary extension model, it would need a new abstraction beyond what Agent Framework appears to favor.

**Probably defer**: A generic workflow middleware API, unless repeated Milestone 3 use-cases make explicit adapter modules too cumbersome.

**Source**:
- https://learn.microsoft.com/en-us/agent-framework/agents/middleware/
- https://raw.githubusercontent.com/microsoft/agent-framework/main/python/packages/orchestrations/agent_framework_orchestrations/_sequential.py
- https://raw.githubusercontent.com/microsoft/agent-framework/main/python/packages/orchestrations/agent_framework_orchestrations/_handoff.py
- https://raw.githubusercontent.com/microsoft/agent-framework/main/python/packages/orchestrations/agent_framework_orchestrations/_orchestration_request_info.py

**Version/recency notes**: Middleware docs are March 2026; this finding partly relies on repo inspection and is therefore an informed inference, not an explicit Learn statement.

**5. Observability is a first-class execution surface, and operator visibility is layered on top**

**Observed patterns**: Workflows emit lifecycle, executor, superstep, request, and custom events; they also emit OpenTelemetry spans/logs/metrics with workflow-specific span names. Visibility layers then build on those primitives: Mermaid/DOT graph export, DevUI trace viewing, and DevUI workflow execution/testing.

**Evidence from docs/code**: Learn docs list the event taxonomy and workflow span names; visualization docs expose Mermaid/DOT generation; DevUI docs say it consumes Agent Framework traces rather than inventing its own spans, and the repo DevUI package maps workflow events, approval events, and traces onto an OpenAI-compatible API surface.

**Likely compatible**: High. Stable executor IDs, event streams, and graph export are strong fits for Coortex Milestone 3.

**Would require architectural change**: If Coortex currently lacks stable per-step identifiers, event schemas, or trace correlation between runtime and host execution.

**Probably defer**: A full DevUI-style operator console. The important Milestone 3 takeaway is to design the event model first.

**Source**:
- https://learn.microsoft.com/en-us/agent-framework/workflows/events
- https://learn.microsoft.com/en-us/agent-framework/workflows/observability
- https://learn.microsoft.com/en-us/agent-framework/workflows/visualization
- https://learn.microsoft.com/en-us/agent-framework/devui/
- https://learn.microsoft.com/en-us/agent-framework/devui/tracing
- https://github.com/microsoft/agent-framework/tree/main/python/packages/devui

**Version/recency notes**: Docs were updated from December 2025 through March 2026; DevUI docs still note missing C# coverage, so Python docs/repo are the stronger evidence source.

**6. HITL/approval is modeled as pause-resume workflow control, not ad hoc UI prompts**

**Observed patterns**: Human-in-the-loop shows up as explicit request/response pauses: request external input, await typed response, then resume the workflow. Sequential orchestration supports both approval-required tools and request-info pauses after agent responses; when a workflow is exposed as an agent, these pauses surface as function calls.

**Evidence from docs/code**: Learn docs describe orchestration HITL and tool approval; repo approval code shows `AgentApprovalExecutor` as an internal two-node workflow loop between an agent executor and a request-info executor.

**Likely compatible**: Designing Coortex modules to support "pause with request payload, resume with response payload" looks worthwhile even if the UI comes later.

**Would require architectural change**: If the current Coortex host path assumes runs are synchronous/fire-and-forget and cannot suspend mid-module with durable pending input.

**Probably defer**: Full approval UX, per-tool policy surfaces, and general operator intervention flows for Milestone 3 unless they are already in scope.

**Source**:
- https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/
- https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/sequential
- https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval
- https://learn.microsoft.com/en-us/agent-framework/workflows/as-agents
- https://raw.githubusercontent.com/microsoft/agent-framework/main/python/packages/orchestrations/agent_framework_orchestrations/_orchestration_request_info.py

**Version/recency notes**: Docs were updated in March 2026; repo code on `main` matches the documented pause/resume shape.

### Synthesis
**Patterns worth integrating**
- Explicit runtime modules with typed input/output contracts, validated edges, and stable executor IDs.
- A composition model that allows sub-workflows and, later, "workflow as module/agent" wrapping.
- Event-first observability: executor events, superstep/phase events, and graph export from day one.
- Checkpoint boundaries tied to explicit workflow progression, not arbitrary host callbacks.
- A pause/resume contract for future external-input gates, even if Milestone 3 does not expose full HITL UX.

**Patterns worth exploring later**
- Declarative workflow authoring.
- Workflow-as-agent exposure across broader host boundaries.
- Durable/distributed checkpoint backends and richer replay tooling.
- Prebuilt higher-autonomy orchestrators such as handoff, group chat, and magentic.
- A dedicated operator console beyond basic visibility/events.

### Coortex direction notes
These notes capture follow-up Coortex decisions for Milestone 3. They are internal project direction, not Microsoft Agent Framework claims.

**Progression model**
- Prefer independent progression.
- Milestone 3 should be linear or locally ordered, not globally barriered.
- Superstep and barrier semantics are heavier than needed unless the runtime already supports branch and fan-out execution.

**Minimal workflow-module contract**
- Use both structure and state, but keep both small.
- A module definition should include:
  - module id
  - assignment shaping function
  - completion predicate over durable runtime state
  - next-module resolution
- Per-run instance state should stay minimal and runtime-owned; avoid arbitrary module-local blobs.

**Definition and instance split**
- Use reusable workflow definitions with per-run workflow instances.
- Treat the module definition as static policy.
- Treat the workflow instance as runtime-owned per-session progress.

**Checkpoint scope for Milestone 3**
- Checkpoint only:
  - workflow id
  - ordered module sequence
  - current module
  - module completion status
  - blocking decision state as reflected in runtime truth
- Do not checkpoint rich executor or controller internals yet.
- Keep serialization in the normal runtime durable state under the same trust model as existing runtime artifacts.

**Cross-cutting behavior**
- Put cross-cutting behavior in the runtime and host layer first.
- Do not build a full workflow middleware stack for Milestone 3.
- If extensibility is needed, reserve a narrow hook point in the contract instead of introducing general middleware now.

**Pause and blocked semantics**
- Reserve pause and resume at the interface level now.
- Do not build a full approval system yet.
- Leave a first-class way for a module to be:
  - active
  - blocked
  - completed
- This keeps later HITL work from forcing a workflow-model rewrite.

**Practical Milestone 3 shape**
- reusable workflow definitions
- runtime-owned per-run workflow state
- independent phase progression
- minimal checkpointable progress
- no full middleware layer
- reserved blocked and pause semantics now
