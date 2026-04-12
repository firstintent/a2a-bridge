# Architecture

## Goals

a2a-bridge is a protocol-level hub. Two symmetric problems, one system:

1. **Expose Claude Code as a callable agent.** Any A2A-speaking client
   (Gemini CLI today, other A2A agents tomorrow) can reach a running
   Claude Code session over the network and drive it like a remote
   subagent.
2. **Let Claude Code call other agents.** Codex, OpenClaw, Hermes — each
   speaks its own native protocol. Per-peer adapters translate between
   that native protocol and a common internal message shape.

Both problems reduce to the same plumbing: carry messages between a
Claude Code session and some other agent, preserve turn semantics, and
do not care whether the other agent sits on the same host or across a
network.

## Three layers

```
┌─ Transport ─┐  ┌─ Protocol ─┐  ┌────── Capability ──────┐
│             │  │            │  │  InboundService (A2A)  │
│ stdio       │  │ JSON-RPC   │  │                        │
│ unix-socket │─▶│ MCP notif. │─▶│  Peer Adapters         │
│ tcp+tls     │  │ A2A card   │  │    Codex / OpenClaw /  │
│             │  │ + task     │  │    Hermes / ...        │
│             │  │            │  │                        │
│             │  │            │  │  RoomRouter            │
│             │  │            │  │  TaskLog (SQLite)      │
└─────────────┘  └────────────┘  └────────────────────────┘
```

- **Transport** only moves bytes. stdio for the Claude Code plugin
  (MCP), unix-socket for low-overhead same-host calls, TLS-terminated
  TCP + bearer tokens for cross-host. Transports are interchangeable —
  swapping one does not change upstream behavior.
- **Protocol** is the wire message format. We settle on
  **JSON-RPC 2.0** for method dispatch, **MCP `notifications/...`**
  for the Claude Code channel direction, and **A2A v0.3.0 schemas**
  (`Message`, `Part`, `Task`, `Agent Card`) for capability payloads. A
  small mapper converts between MCP notifications and A2A messages
  inside the daemon.
- **Capability** is the bridge logic. Four modules: InboundService,
  PeerAdapter instances, RoomRouter, TaskLog. These are transport- and
  wire-agnostic — they trade internal `BridgeMessage` and
  `PeerAdapterEvents`.

Every listener the daemon owns pushes frames through the same decoder
into the same capability handlers. Adding remote access is adding
another listener, not another system.

## Components

### Claude Code channel plugin

A standard MCP stdio plugin (see `plugins/a2a-bridge/`). Declares
`experimental['claude/channel']` so Claude Code treats its
`notifications/claude/channel` as inbound user turns. Exposes outbound
tools: `reply`, `cancel_turn`, `switch_peer`. Plugin connects to the
daemon over whichever transport is configured (stdio-within-Claude by
default; daemon URL via `A2A_BRIDGE_DAEMON_URL` for remote daemon).

### Daemon

Bun process, optionally on a different host. Owns:

- **Listeners** (one per transport in use): stdio for the plugin,
  unix-socket for same-host agents, TLS TCP for remote.
- **InboundService** — A2A server implementation. HTTPS + SSE. Routes
  A2A tasks to a RoomRouter session which feeds the Claude Code
  channel plugin. Minimum surface defined below.
- **PeerAdapter instances** — one `IPeerAdapter` per active peer
  connection. Adapters translate CodexAdapter / OpenClawAdapter /
  HermesAdapter wire formats into `PeerAdapterEvents` and consume
  `injectMessage(text)`.
- **RoomRouter** — `Map<RoomId, Room>`. Each `Room` owns its own
  Claude Code connection slot, peer adapter set, message log, and
  subscriber list. Room isolation prevents task cross-talk across
  concurrent Claude Code sessions.
- **TaskLog** — SQLite persistence of in-flight and recent A2A tasks
  so that Claude Code restarts do not lose context.

### Peer adapter contract (`IPeerAdapter`)

Defined in `src/peer-adapter.ts`. Every peer-side adapter implements
`start`, `injectMessage`, `cancel`, `close`, and emits `ready`,
`agentMessage`, `agentThought`, `turnStarted`, `turnCompleted`,
`toolEvent`, `permissionRequest`, `error`, `exit`. The daemon drives
all adapters through this interface; Codex-, OpenClaw-, and
Hermes-specific details are private to the implementations.

## Protocol matrix

| Counterparty      | Native wire                          | a2a-bridge module      | Direction supported |
|-------------------|--------------------------------------|-------------------------|---------------------|
| Claude Code       | MCP Channels (stdio)                 | channel plugin          | ↔ (always)          |
| Codex             | App-server JSON-RPC over WebSocket   | CodexAdapter            | ↔                   |
| OpenClaw          | Gateway WS + Ed25519 handshake       | OpenClawAdapter         | ↔                   |
| Hermes            | Zed ACP (JSON-RPC 2.0 over stdio)    | HermesAdapter           | CC → Hermes only    |
| Gemini CLI        | A2A (JSON-RPC + SSE) + Bearer        | InboundService          | Gemini → CC only    |
| Any A2A client    | A2A (JSON-RPC + SSE)                 | InboundService          | client → CC         |

a2a-bridge does not run A2A to its Codex/OpenClaw/Hermes peers —
those have their own protocols and no A2A support. a2a-bridge itself
is the A2A boundary: **inbound A2A for clients, native protocol
outbound for peers.**

## InboundService: minimum A2A server surface

Aligned with what `@a2a-js/sdk`'s client (as used by Gemini CLI) will
call in practice. See `docs/` scratchpad for the research notes.

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
- `defaultOutputModes: ["text/plain"]` (optionally `application/json`)
- `skills: [{ id, name, description, tags, examples }]` — at least one
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
- No push-notification config; no `tasks/resubscribe`; no non-streaming
  `message/send` in the primary flow.

## Deployment shapes

1. **All-local.** Daemon in-process with the Claude Code plugin via
   stdio. No network exposure. Easiest dev setup.
2. **Same host, separate daemon process.** Plugin talks to daemon over
   unix socket. Daemon survives Claude Code restarts. Preferred for
   persistent task logs.
3. **Remote daemon.** Plugin connects to daemon over TLS TCP with a
   bearer token. Daemon's InboundService is exposed to other hosts.
   Required for cross-machine peers.

All three shapes share the same code; deployment differs only in which
listeners the daemon activates and which endpoints it publishes.

## Non-goals

- **Not a substitute for a well-prompted single agent with MCP
  tools.** Multi-agent chains typically cost 3–10× the tokens of the
  single-agent equivalent. If a single session suffices, skip the
  bridge. See [`POSITIONING.md`](./POSITIONING.md).
- **Fronting non-CC LLMs as A2A servers.** InboundService wraps
  Claude Code specifically. A separate project can layer
  a2a-bridge's InboundService components over other model backends if
  desired.
- **Replacing Claude Code Channels.** a2a-bridge is a channel plugin,
  not a replacement for the channel mechanism.
- **A generic orchestration framework.** RoomRouter is routing, not
  scheduling. Higher-level orchestration (DAGs, retries, human
  gates) belongs above a2a-bridge, not inside it.
- **A cross-vendor LLM abstraction.** a2a-bridge wraps specific
  agents at their native wire protocols. It is not LiteLLM or
  LangGraph.
