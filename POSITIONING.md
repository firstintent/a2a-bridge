# Positioning and Design Principles

## One sentence

a2a-bridge is protocol plumbing for multi-agent collaboration. It
does **not** decide when multi-agent is worth it — the user does.

## Principles

### 1. Start with the simplest approach that works

The default assumption is that a single well-prompted Claude Code
session with MCP tools is sufficient. a2a-bridge exists for the cases
where it is not. If you reach for a peer adapter before you've tried
better prompting, better tool selection, or context compaction, you
are likely over-engineering. Tool search and larger contexts have
closed a great deal of ground that used to require multi-agent.

### 2. Context-centric decomposition, not problem-centric

Good splits happen where context naturally isolates: an independent
research track, a component with a clean interface, a blackbox
verification step. Bad splits happen where *we* imagine a workflow:
"planner → implementer → tester → reviewer." The planner/implementer
pattern has been tried many times and consistently underperforms —
each handoff degrades fidelity, and coordination costs eat any
specialization benefit.

a2a-bridge does not ship a "planner peer" or a "tester peer." It
ships adapters to real agents, and the user picks when a context
boundary is real.

### 3. Verification is the canonical pattern

Of the patterns Anthropic has validated in production, the
verification subagent is the one that consistently works across
domains. It requires minimal context handoff: parent produces
artifact, child evaluates against criteria, child returns pass/fail
plus notes. a2a-bridge is designed to make this pattern easy — it is
the first use case we document, the first we teach, and the first we
benchmark.

### 4. Preserve fidelity across handoffs

The "telephone game" failure mode is real. Every peer adapter must
pass `agentMessage` and `agentThought` through without summarization,
must preserve `contextId` across turns, and must return the peer's
output verbatim. Summarization, if wanted, is the caller's decision,
expressed as an A2A `return_format` hint — not something an adapter
does unasked.

### 5. Be a transport, not an orchestrator

a2a-bridge routes messages and manages session state. It does not
decide task ordering, retry policies, branching, or human approval
gates. Orchestration belongs in the caller or in a separate tool
built on top of a2a-bridge. Keeping this boundary honest prevents
scope creep and keeps the bridge composable.

### 6. Uniform inbound, per-peer outbound

Inbound (external → Claude Code) standardizes on A2A because there is
a genuine open spec with real clients (Gemini CLI). Outbound (Claude
Code → peer) does **not** force A2A — the peers we care about today
(Codex, OpenClaw, Hermes) each speak their own wire protocol, and
per-peer adapters translate. Forcing A2A outbound would mean waiting
for peers to adopt A2A or building unreliable protocol proxies.

### 7. Honest cost accounting

Multi-agent workflows typically consume 3–10× the tokens of the
single-agent equivalent. Documentation, examples, and tooling in this
repo should always surface that cost, not hide it. If a benchmark or
tutorial shows a multi-agent pattern, it should also show the
single-agent baseline and acknowledge when the baseline wins.

## Non-goals

- **Not a substitute for a well-prompted single agent with MCP
  tools.** If that approach works, use it and skip a2a-bridge.
- **Not an orchestration framework.** Task graphs, retries, branches,
  approval gates — out of scope.
- **Not a cross-vendor LLM abstraction.** a2a-bridge wraps specific
  agents at their native wire protocols. It is not LiteLLM or
  LangGraph.
- **Not a benchmarking harness.** Evaluating whether multi-agent
  helps on a given task is the user's responsibility; we provide
  plumbing, not a verdict.

## Informing sources

- Anthropic Engineering — [When to use multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)
- Google A2A protocol — [a2aproject/A2A](https://github.com/a2aproject/A2A)
- Claude Code Channels research preview (Anthropic)
