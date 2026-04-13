# Architecture

## Goals

a2a-bridge is a protocol-level hub. Two symmetric problems, one system:

1. **Expose Claude Code as a callable agent.** Any A2A-speaking client
   (Gemini CLI today, other A2A agents tomorrow) can reach a running
   Claude Code session over the network and drive it like a remote
   subagent.
2. **Let Claude Code call other agents.** Codex, OpenClaw, Hermes —
   each speaks its own native protocol. Per-peer adapters translate
   between that native protocol and a common internal message shape.

Both problems reduce to the same plumbing: carry messages between a
Claude Code session and some other agent, preserve turn semantics,
and do not care whether the other agent sits on the same host or
across a network.

## Code layout

The source tree is split by **runtime** (where the code executes)
and then by **domain** (what it does). There are no abstract "layer
numbers" — every file declares a runtime and a domain by where it
lives.

```
src/
  shared/          zero-dep utilities (state-dir, config-service,
                   daemon-lifecycle, logger)
  messages/        shared value objects (BridgeMessage, ...)
  transport/       plugin <-> daemon control plane only
                   (Listener interface + stdio/unix/tls impls)
  runtime-plugin/  code running inside the Claude Code MCP plugin
    claude-channel/    MCP channel adapter (notifications, tools)
    daemon-client/     client end of the control plane
    bridge.ts          plugin process entrypoint
  runtime-daemon/  code running inside the persistent daemon
    peers/             outbound peer adapters (CC -> peer)
      peer-adapter.ts  IPeerAdapter contract
      peer-factory.ts
      codex/
      openclaw/        scaffold; outbound ships in v0.2
      hermes/          scaffold; outbound ships in v0.2
    inbound/
      a2a-http/        A2A server (external -> CC)
      acp/             ACP stdio server
    rooms/             RoomRouter + Room
    tasks/             Task lifecycle + SqliteTaskLog
    daemon.ts          daemon process entrypoint
  cli/             user-facing CLI; also hosts cross-runtime
                   integration tests
```

Wire-format code lives where it is used. There is no shared
`protocols/` directory: the Codex JSON-RPC codec sits inside
`peers/codex/`, the A2A encoders sit inside `inbound/`, the MCP
channel types sit inside `claude-channel/`. A format only migrates
to `shared/` when two independent domains actually consume it.

Dependency rules are enforced by dependency-cruiser
(`.dependency-cruiser.cjs`). Summary (see `CLAUDE.md` for the full
list):

- `shared/` and `messages/` stay pure; no upward imports.
- `transport/` cannot reach into business layers.
- `runtime-plugin/` and `runtime-daemon/` cannot import each other.
- Peer adapters cannot import sibling peer adapters.
- `inbound/` and `peers/` concrete code cannot reach into each other.

### Path aliases

Code crossing directory boundaries uses tsconfig path aliases, not
relative `../` chains, so boundary violations stand out:

| Alias          | Maps to                |
|----------------|------------------------|
| `@shared/*`    | `src/shared/*`         |
| `@messages/*`  | `src/messages/*`       |
| `@transport/*` | `src/transport/*`      |
| `@plugin/*`    | `src/runtime-plugin/*` |
| `@daemon/*`    | `src/runtime-daemon/*` |

## Components

### Claude Code channel plugin

A standard MCP stdio plugin (see `plugins/a2a-bridge/`). Declares
`experimental['claude/channel']` so Claude Code treats its
`notifications/claude/channel` as inbound user turns. Current outbound
tools are `reply` and `get_messages`; `cancel_turn` and
`switch_peer` are planned (roadmap Phase 3–4). Plugin connects to the
daemon over whichever transport is configured (stdio-within-Claude
by default; daemon URL via `A2A_BRIDGE_DAEMON_URL` for a remote
daemon).

### Daemon

Bun process, optionally on a different host. Owns:

- **Listeners** (one per transport in use): stdio for the plugin,
  unix-socket for same-host agents, TLS TCP for remote.
- **InboundServices** — multi-protocol shims that all converge on a
  shared `ClaudeCodeGateway`:
  - A2A InboundService (HTTP + JSON-RPC + SSE).
  - ACP InboundService (stdio JSON-RPC, via `a2a-bridge acp`
    subcommand).
  - MCP InboundService (HTTP/SSE/stdio) — v0.2.
- **PeerAdapter instances** — one `IPeerAdapter` per active peer
  connection. Adapters translate per-peer wire formats into
  `PeerAdapterEvents` and consume `injectMessage(text)`.
- **RoomRouter** — `Map<RoomId, Room>`. Each `Room` owns its own
  Claude Code connection slot, peer adapter set, message log, and
  subscriber list. Room isolation prevents task cross-talk across
  concurrent Claude Code sessions.
- **TaskLog** — SQLite persistence of in-flight and recent tasks
  (across all inbound protocols) so that Claude Code restarts do not
  lose context. Backed by `bun:sqlite` at `<stateDir>/tasks.db`.

### Peer adapter contract (`IPeerAdapter`)

Defined in `src/runtime-daemon/peers/peer-adapter.ts`. Every
peer-side adapter implements `start`, `injectMessage`, `cancel`,
`close`, and emits `ready`, `agentMessage`, `agentThought`,
`turnStarted`, `turnCompleted`, `toolEvent`, `permissionRequest`,
`error`, `exit`. The daemon drives all adapters through this
interface; Codex-, OpenClaw-, and Hermes-specific details are
private to the implementations.

## Protocol matrix

| Counterparty       | Native wire                        | a2a-bridge module    | Direction         | Status |
|--------------------|------------------------------------|----------------------|-------------------|--------|
| Claude Code        | MCP Channels (stdio)               | channel plugin       | ↔ (always)        | v0.1   |
| Codex              | App-server JSON-RPC over WebSocket | CodexAdapter         | ↔                 | v0.1   |
| Any A2A client     | A2A (JSON-RPC + SSE)               | A2A InboundService   | client → CC       | v0.1   |
| OpenClaw / Zed /   | ACP (JSON-RPC 2.0 over stdio)      | ACP InboundService   | client → CC       | v0.1   |
|  VS Code / Hermes  |                                    | (`a2a-bridge acp`)   |                   |        |
| MCP clients        | MCP (HTTP/SSE/stdio)               | MCP InboundService   | client → CC       | v0.2   |
|  (Cursor, Claude   |                                    |                      |                   |        |
|   Desktop)         |                                    |                      |                   |        |
| OpenClaw (peer)    | Gateway WS + Ed25519 handshake     | OpenClawAdapter      | ↔                 | v0.2   |
| Hermes (peer)      | Zed ACP (JSON-RPC 2.0 over stdio)  | HermesAdapter        | CC → Hermes only  | v0.2   |

a2a-bridge does not run A2A to its Codex/OpenClaw/Hermes peers —
those have their own protocols and no A2A support. a2a-bridge is the
**multi-protocol inbound boundary**: A2A, ACP, MCP shims each accept
client traffic and dispatch through a shared `ClaudeCodeGateway` into
the same plugin → Claude Code pipeline. Outbound stays per-peer
native protocol.

## InboundService: minimum A2A server surface

Aligned with what `@a2a-js/sdk`'s client (as used by Gemini CLI)
calls in practice.

### Endpoints

- `GET /.well-known/agent-card.json` — publicly reachable, returns
  the agent card JSON.
- `POST <card.url>` — JSON-RPC 2.0 endpoint. Handles exactly three
  methods:
  - `message/stream` → Server-Sent Events response,
    `Content-Type: text/event-stream`. Each SSE frame is a JSON-RPC
    response whose `result` is one of
    `Task | Message | TaskStatusUpdateEvent | TaskArtifactUpdateEvent`.
  - `tasks/get` → single JSON-RPC response with the Task.
  - `tasks/cancel` → single JSON-RPC response acknowledging cancel.

### Agent Card fields (camelCase, A2A SDK names)

- `protocolVersion: "0.3.0"`
- `name`, `description`, `version`
- `url` — absolute URL of the RPC endpoint
- `capabilities: { streaming: true }`
- `defaultInputModes: ["text/plain"]`
- `defaultOutputModes: ["text/plain"]` (optionally
  `application/json`)
- `skills: [{ id, name, description, tags, examples }]` — at least
  one
- `securitySchemes` + `security` — declare `http` Bearer so SDK
  validators pass

### Authentication

- Accept `Authorization: Bearer <token>` on the RPC endpoint.
- Return `401` or `403` on bad/missing auth (clients retry with
  credentials).
- Agent-card endpoint should be publicly reachable; if auth is
  required, accept the same Bearer token.

### Task lifecycle

Every `message/stream` response emits, in order:

1. One `task` event — fresh `id`, `contextId` echoed from the
   request (or minted).
2. Zero or more `status-update` events with
   `status.state ∈ { working, auth-required, input-required }`.
3. Zero or more `artifact-update` events for streamed outputs. Use
   stable `artifactId` + `append: true` for chunked text.
4. One terminal `status-update` event with `final: true` and a
   non-empty `status.message` — avoids the client's history-fallback
   path.

Terminal states the client recognizes: `completed`, `failed`,
`canceled`, `rejected`.

### Constraints

- Keep SSE connections alive up to 30 minutes; do not idle-close.
- Do not emit proto snake-case aliases — camelCase only.
- No push-notification config; no `tasks/resubscribe`; no
  non-streaming `message/send` in the primary flow.

## InboundService: ACP server surface

Aligned with `@agentclientprotocol/sdk` v0.5+ — what Zed, VS Code,
OpenClaw (`acpx`), and Hermes call when they spawn an ACP agent
subprocess.

### Transport

- stdio JSON-RPC (the canonical ACP transport per the spec). The
  client launches `a2a-bridge acp` as a subprocess; framing is
  newline-delimited JSON-RPC 2.0.
- HTTP transport is a draft in the ACP spec; not implemented here.
- The `a2a-bridge acp` subcommand is a thin process — it connects to
  the long-running daemon over the unix-socket control plane (Phase 4)
  and forwards ACP sessions through the shared
  `ClaudeCodeGateway`.

### Required methods

The minimum surface clients call:

- `initialize` — protocol handshake; agent advertises its
  `protocolVersion` and `capabilities`.
- `newSession` / `loadSession` — open a session that maps 1:1 to a
  `Room` in the daemon.
- `prompt` (a.k.a. `session/prompt`) — user turn; response streams
  back as `session/update` notifications carrying assistant chunks
  plus a final `session/turnComplete`.
- `cancel` — abort the active turn; bridges to `Room.cancel`.

### Authentication

ACP runs as a subprocess of the client, so the trust boundary is the
local user. `a2a-bridge acp` inherits the user's filesystem identity;
no bearer tokens are exchanged on the stdio link. Authentication for
the underlying daemon control plane is filesystem-permissioned on
the unix socket.

### Permission-relay policy for ACP-originated turns

When Claude Code wants to use a tool during an in-flight turn, it
emits a `notifications/claude/channel/permission_request` to the
attached channel plugin. The plugin is expected to surface the
request to the user (via its channel) and return an allow/deny
decision as a `notifications/claude/channel/permission` notification
back to CC — this is the "five-letter verdict dance" the Channels
reference specifies.

ACP has no native "chat to reply in" analogue for that dance — a
Zed / OpenClaw / VS Code session is an IDE-style consumer, not a
chat — but the ACP SDK's `AgentSideConnection.requestPermission()`
method expresses the same intent at the protocol level: the agent
asks the client to present the user with a decision, and receives a
structured `RequestPermissionResponse` back.

**Chosen policy (v0.1):** when an ACP turn is in flight, the plugin
**bridges `notifications/claude/channel/permission_request` to the
ACP client's `session/request_permission`**:

1. Plugin receives CC's permission_request notification.
2. Plugin forwards it to the daemon over the control plane.
3. Daemon routes it to the ACP connection that owns the in-flight
   turn (via `AcpTurnHandler`).
4. The `a2a-bridge acp` subprocess invokes `conn.requestPermission()`
   on its `AgentSideConnection`, which delivers the request to the
   ACP client (editor UI).
5. The ACP client prompts the user; its `RequestPermissionResponse`
   flows back through the chain.
6. Plugin emits `notifications/claude/channel/permission` to CC with
   the decision.

Rejected alternatives:

- **Auto-allow, env-gated (e.g. `A2A_BRIDGE_ACP_AUTO_PERMISSION=1`).**
  Convenient for dev, but silently grants tool permissions on behalf
  of an editor user who never saw the prompt. A bad default for a
  feature whose whole point is surfacing prompts to the human driver.
  Can be layered on later as an explicit opt-in without changing the
  primary path.

- **Auto-deny, resolving the turn with `stopReason: "refusal"`.** Safe
  but unhelpful: every ACP client loses access to tool use during any
  turn they drive, which is most of the value proposition. Clients
  could still `loadSession` and retry without tools, but the UX is
  worse than asking the user.

Bridging to `session/request_permission` puts the decision where it
belongs — with the person at the IDE — and matches the channel
plugin pattern for human-in-the-loop approval.

## InboundService: MCP server surface (deferred to v0.2)

Will mirror the ACP shape: a `runtime-daemon/inbound/mcp/` directory
with a server that implements the MCP `tools/list` and `tools/call`
methods. One tool — `claude_code` — accepts a prompt and streams the
reply via MCP's standard SSE pattern. Same `ClaudeCodeGateway`
underneath. Targets Cursor, Claude Desktop, and other MCP-only
clients.

## Pattern contracts

The design principles behind these contracts live in
[`positioning.md`](./positioning.md).

### Verification artifact

Verification is the canonical, validated multi-agent pattern.
a2a-bridge ships a first-class artifact shape for it so that a
caller gets structured verdicts, not free-form text to re-parse.

Artifact content-type: `application/vnd.a2a-bridge.verdict+json`
(carried inside an A2A `Artifact.parts[].kind = "data"`).

Shape:

```json
{
  "verdict": "pass" | "fail" | "needs-info",
  "reasoning": "one to three sentences of rationale",
  "evidence": [
    { "claim": "string", "source": "file:line or url or inline", "note": "optional" }
  ],
  "followups": ["string", ...]
}
```

- `verdict` is the terminal decision. Unrecognized values are
  treated as `needs-info`.
- `reasoning` must be non-empty; verifiers that cannot articulate
  reasoning should return `needs-info`.
- `evidence` may be empty for trivial checks; otherwise each item
  points at the specific supporting observation.
- `followups` lists suggested next actions for the caller. May be
  empty.

Callers that do not opt into the structured shape receive plain
text as today.

### return_format hint

Callers express context-protection intent by passing a
`return_format` field in the A2A `Message.metadata`:

| `return_format` | Peer output                                  |
|-----------------|-----------------------------------------------|
| `full`          | default; peer's verbatim output               |
| `summary`       | peer compresses its own output before return  |
| `verdict`       | peer returns a verification artifact (above)  |

Adapters must surface `return_format` through `injectMessage` so the
peer sees it. Adapters never apply summarization themselves.

## Deployment shapes

1. **All-local.** Daemon in-process with the Claude Code plugin via
   stdio. No network exposure. Easiest dev setup.
2. **Same host, separate daemon process.** Plugin talks to daemon
   over unix socket. Daemon survives Claude Code restarts.
   Preferred for persistent task logs.
3. **Remote daemon.** Plugin connects to daemon over TLS TCP with a
   bearer token. Daemon's InboundService is exposed to other hosts.
   Required for cross-machine peers.

All three shapes share the same code; deployment differs only in
which listeners the daemon activates and which endpoints it
publishes.

## Non-goals

- **Not a substitute for a well-prompted single agent with MCP
  tools.** Multi-agent chains typically cost 3–10× the tokens of
  the single-agent equivalent. If a single session suffices, skip
  the bridge. See [`positioning.md`](./positioning.md).
- **Fronting non-CC LLMs as A2A servers.** InboundService wraps
  Claude Code specifically. A separate project can layer
  a2a-bridge's InboundService components over other model backends
  if desired.
- **Replacing Claude Code Channels.** a2a-bridge is a channel
  plugin, not a replacement for the channel mechanism.
- **A generic orchestration framework.** RoomRouter is routing,
  not scheduling. Higher-level orchestration (DAGs, retries, human
  gates) belongs above a2a-bridge, not inside it.
- **A cross-vendor LLM abstraction.** a2a-bridge wraps specific
  agents at their native wire protocols. It is not LiteLLM or
  LangGraph.
