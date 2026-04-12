# Roadmap

Phases are ordered by **value × breadth**. The earliest phases unlock
the use cases that benefit the most users with the least per-peer
work. Specialized peer adapters wait until the general surface is
proven.

Design principles that drive this ordering live in
[`POSITIONING.md`](./POSITIONING.md). The baseline assumption is that
most tasks should still run on a single well-prompted Claude Code
session — a2a-bridge ships capability for the cases where that is
genuinely insufficient.

## Phase 1 — Foundation (done)

- Vendor import from `raysonmeng/agent-bridge` with MIT attribution
  in `NOTICE`.
- Rename to `a2a-bridge`; package, plugin directory, env vars, CLI
  binaries, ports bumped to avoid clashing with upstream.
- Introduced runtime-split layout (`runtime-plugin/`,
  `runtime-daemon/`, `shared/`, `messages/`, `transport/`, `cli/`)
  with tsconfig path aliases.
- `IPeerAdapter` interface and `peer-factory` dispatch scaffold.
- `CodexAdapter` conforms to `IPeerAdapter` without behavior change.
- Architecture boundaries enforced by dependency-cruiser via
  `bun run lint:deps`.

## Phase 2 — InboundService v0 (A2A server)

**Why first.** One feature unlocks the broadest audience: any A2A
client (Gemini CLI today, every A2A peer that follows) can drive
Claude Code through a2a-bridge with no per-peer work on our side.
This is the biggest breadth-per-effort ratio in the roadmap.

- Abstract the daemon's listener layer into a single `Listener`
  interface with stdio and unix-socket implementations (TLS TCP
  deferred until we need it).
- Implement the minimum A2A server surface documented in
  `ARCHITECTURE.md` — `GET /.well-known/agent-card.json`, JSON-RPC
  endpoint handling `message/stream` (SSE), `tasks/get`,
  `tasks/cancel`. Bearer auth.
- Wire InboundService through the existing CodexAdapter-backed
  single-room path: A2A message in → daemon → plugin → Claude Code;
  reply streams back on the same SSE connection as A2A
  `status-update` events.
- Minimum E2E: a `@a2a-js/sdk` client (the same Gemini CLI uses)
  sends a `message/stream` call and receives terminal assistant text.

**Ship criterion:** a Gemini CLI user configures one remote_agent
entry pointing at the daemon and has Claude Code answering their
queries.

## Phase 3 — Verification and delegation patterns

**Why next.** The article's validated pattern is the verification
subagent. Phase 2 makes inbound connectivity exist; Phase 3 makes
the most-valuable use of it ergonomic. This is where a2a-bridge
differentiates from "just another MCP server."

- Define a structured return schema for verification and
  delegation: an A2A artifact carrying `{verdict: pass|fail|needs-info,
  reasoning, evidence[]}`. Expose as first-class `A2A` artifact type;
  parsed back into a structured return on the caller side.
- Ship a skill template (`skills/verify/SKILL.md`) that teaches
  Claude Code how to delegate a check: "here is the artifact, here
  are the criteria, return pass/fail + reasoning, not a rewrite."
- Document three canonical patterns with end-to-end examples:
  1. **Verification** — CC produces code; peer evaluates against
     criteria; CC acts on the verdict.
  2. **Context protection** — CC delegates a long log dig to a peer
     with an explicit `return_format: summary`; peer summarizes so
     CC's context stays clean.
  3. **Parallel independent work** — CC spawns N peer tasks on
     genuinely independent subproblems; results merge.
- Token-cost reporting: emit per-turn token usage on the A2A
  response so callers can see the 3–10× overhead up front.

**Ship criterion:** a verification workflow end-to-end with a
documented skill, from a single Claude Code session, targeting the
CodexAdapter, returning structured pass/fail.

## Phase 4 — RoomRouter and TaskLog

**Why here.** Phase 3's context-protection and parallel patterns
expose scale needs: multiple concurrent Claude Code sessions per
daemon, task history that survives plugin restarts.

- `RoomId` derived from CC session id or passed via
  `A2A_BRIDGE_ROOM`; `RoomRouter` owns `Map<RoomId, Room>`.
- Every inbound A2A task routes to the room identified by
  `contextId` (minted on first contact) or by a card-level rule.
- SQLite-backed `TaskLog` per room; `tasks/get` reads from it.
- Migrate adapter state (currently daemon-singleton) into per-Room.

**Ship criterion:** two independent Claude Code sessions on one
daemon run in parallel without cross-talk; a task survives a plugin
reconnect.

## Phase 5 — OpenClawAdapter (cross-machine peer)

**Why after the patterns layer.** OpenClaw brings real multi-machine
value and a non-trivial handshake (Ed25519 device identity, synthesized
turn events). Until the patterns layer exists, adding this peer is
premature; once Phase 3 is in, OpenClaw unlocks the
context-protection and parallel patterns at datacenter scale.

- Ed25519 device handshake against the OpenClaw gateway protocol.
- `OpenClawAdapter` implementing `IPeerAdapter`, with synthesized
  `turnStarted` / `turnCompleted` (debounce + `sessions.changed` +
  tool signals).
- Persist the device keypair in the daemon state directory.
- Cross-host integration test: daemon on host A, OpenClaw gateway on
  host B.

**Ship criterion:** Claude Code delegates a task to a remote
OpenClaw and receives assistant messages back.

## Phase 6 — HermesAdapter (local ACP)

**Why last.** Hermes is a narrower fit — its built-in support for
calling Claude Code is the primary pairing direction, so CC →
Hermes is a secondary use case. Hermes also ships no inbound bridge,
so cross-host Hermes requires an external ACP proxy we do not
control. Valuable for local demos and as an ACP reference
implementation, but not on the critical path.

- Use `@zed-industries/agent-client-protocol` for stdio framing.
- `HermesAdapter` against `IPeerAdapter`; synthesize `turnStarted`
  at `session/prompt` send time; treat the `PromptResponse.stopReason`
  as `turnCompleted`.
- Surface `agent_thought_chunk` as `agentThought` events.

**Ship criterion:** a user can delegate a task to a local Hermes
subprocess and receive streamed output.

## Phase 7 — Hardening and release

- Daemon routes every peer through `peer-factory`; delete remaining
  Codex-specific coupling from daemon orchestration code.
- CI matrix: each peer tested in mocked mode (no external CLI
  required) plus one live test per peer gated on credentials.
- Publish `@firstintent/a2a-bridge` to npm; submit plugin to the
  Claude Code marketplace.
- Documentation sweep: install paths, auth setup, deployment shapes,
  peer adapter authoring guide, pattern cookbook.

## Explicitly deferred

- TLS TCP listener. Only needed when cross-machine daemon deployment
  ships; unix-socket covers same-host cleanly until then.
- Push-notification variants of A2A. Not used by today's A2A
  clients.
- gRPC transport for A2A. JSON-RPC + SSE covers the field.
- Multi-protocol inbound (e.g. MCP-over-HTTP inbound). Only add when
  a concrete caller needs it.
- Per-peer prompt templates for roles beyond verification.
  Orchestration framework territory; see `POSITIONING.md`.
