# Roadmap

Phase ordering reflects risk and dependency. Phase 1 is complete.

## Phase 1 — Foundation (done)

- Vendor import from `raysonmeng/agent-bridge` with MIT attribution in
  `NOTICE`.
- Deep rename to `a2a-bridge`: package, plugin dir, env vars, CLI
  binaries, ports bumped to avoid clashing with upstream.
- `IPeerAdapter` interface and `peer-factory.ts` dispatch scaffold.
- `CodexAdapter` declares `implements IPeerAdapter` with a peer-name
  and interface-compatible method shapes.
- Typecheck clean, 145 unit tests passing (the 15 e2e failures require
  `codex` CLI in the environment and are not regressions).

## Phase 2 — InboundService v0 and the abstraction daemon

Goal: make Claude Code reachable by any A2A client over HTTP.

- Abstract the daemon's listener layer: stdio + unix-socket listener
  behind a single `Listener` interface. Add optional TLS TCP listener
  guarded by config.
- Implement a minimal A2A server (JSON-RPC + SSE + agent card) per
  the `InboundService: minimum A2A server surface` section of
  `ARCHITECTURE.md`. Methods: `message/stream`, `tasks/get`,
  `tasks/cancel`. Bearer auth.
- Wire InboundService through the existing `CodexAdapter` room so that
  a Gemini CLI remote-subagent call ends in a Claude Code turn and
  the answer streams back.
- End-to-end test: point a minimal A2A client (from `@a2a-js/sdk`) at
  the daemon and verify a `message/stream` call gets terminal output.

Deliverable: a Gemini CLI user adds one `remote_agent` entry and can
drive Claude Code. No multi-room yet; a single Claude Code session
handles all inbound tasks serially.

## Phase 3 — RoomRouter and TaskLog

Goal: multiple concurrent Claude Code sessions share one daemon
cleanly.

- Introduce `RoomId` derived from CC session id or an explicit
  `--room` argument forwarded via `A2A_BRIDGE_ROOM`.
- `RoomRouter` owns `Map<RoomId, Room>`; every inbound A2A task is
  routed to the room identified by `contextId` (minting a new one on
  first contact) or by an explicit card-level routing rule.
- `TaskLog` on SQLite: persistent per-room task history so plugin
  restarts don't lose in-flight state. `tasks/get` reads from here.
- Migrate Codex adapter state from daemon-singleton to per-Room.

Deliverable: two independent Claude Code sessions driven from the
same daemon without cross-talk; a task survives a plugin reconnect.

## Phase 4 — OpenClawAdapter

Goal: Claude Code can call an OpenClaw peer, including across a
network.

- Implement the Ed25519 device-identity handshake against the
  OpenClaw gateway protocol.
- Implement `OpenClawAdapter` against `IPeerAdapter`, synthesizing
  `turnStarted` / `turnCompleted` since the gateway has no explicit
  events (debounce + `sessions.changed` + tool-progress signals).
- Persist the device keypair in the daemon state directory.
- Bring up a multi-machine test: daemon on one host, OpenClaw
  gateway on another.

Deliverable: Claude Code sends a task to a remote OpenClaw and
receives the assistant messages back.

## Phase 5 — HermesAdapter (optional, deprioritized)

Goal: Claude Code can call a local Hermes ACP subprocess as a peer.

- Use `@zed-industries/agent-client-protocol` npm package for wire
  framing.
- Implement `HermesAdapter` emitting synthetic `turnStarted`
  (request-send time) and recognizing `PromptResponse.stopReason` as
  the `turnCompleted` signal.
- Surface `agent_thought_chunk` as `agentThought` events.

Deliverable: a Claude Code user can delegate a task to a local
Hermes and receive streamed output. Cross-machine Hermes remains a
future exercise unless demand appears.

## Phase 6 — Hardening and release

- Shut down the assumed-Codex path: the daemon goes through
  `peer-factory` end to end. Delete any remaining Codex-specific
  coupling from the daemon module.
- CI: matrix of peers in mocked mode (no external agent required).
- Publish `@firstintent/a2a-bridge` to npm and the plugin to the
  Claude Code marketplace.
- Documentation sweep: install paths, auth setup, deployment shapes,
  peer adapter authoring guide.

## Out of scope (for now)

- Orchestration (DAGs, human approval gates, retry policies).
- Non-Claude-Code backends behind InboundService.
- Push-notification variants of the A2A protocol.
- gRPC transport on A2A (JSON-RPC + SSE covers the field today).
