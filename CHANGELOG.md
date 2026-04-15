# Changelog

All notable user-facing changes to a2a-bridge land here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-04-16

Multi-target routing. One daemon can now front multiple Claude Code
workspaces at once, and ACP / A2A callers pick which one they want
via an explicit `kind:id` TargetId. Existing single-CC deployments
are unchanged — everything defaults to `claude:default`.

Full design: [`docs/design/multi-target-routing.md`](./docs/design/multi-target-routing.md).

### Added

- **TargetId model** — a `kind:id` tuple (e.g. `claude:proj-a`,
  `codex:default`) is the canonical identifier for any attached
  agent instance. Validated against `[a-z0-9_-]+` at every
  boundary; invalid targets are rejected at the source instead of
  silently routing to `default`.
- **Plugin-side workspace id derivation.** `a2a-bridge claude`
  announces a TargetId on `claude_connect` derived from (in order):
  `A2A_BRIDGE_WORKSPACE_ID` env var → `A2A_BRIDGE_STATE_DIR`
  basename → conversation id prefix → `default`. The result is
  sanitised and prefixed with `claude:`. Two CC sessions with
  distinct state-dirs therefore attach as distinct targets with no
  extra config.
- **`a2a-bridge acp --target <kind:id>`.** Pick which attached
  target handles the turn. Unattached targets return
  `acp_turn_error { "target not attached" }`; missing flag keeps
  v0.1 behaviour (routes to `claude:default`).
- **A2A `contextId → TargetId` routing.** `startA2AServer` accepts
  a `contextRoutes: Record<string, string>` map; the daemon reads
  it from `A2A_BRIDGE_CONTEXT_ROUTES` (a JSON object env var).
  Unmapped contexts fall back to `claude:default` instead of
  minting their own Room. Configuration is validated at startup —
  a malformed TargetId is a fail-fast error, not a 5xx at request
  time.
- **Outbound reply targeting.** CC's `reply` tool schema grows an
  optional `target` field. Present → the daemon forwards the reply
  to that TargetId's Room instead of the inbound turn's
  originator. Absent → today's behaviour. Unknown targets, bad
  shapes, and self-loops all surface descriptive errors.
- **Attach conflict policy.** A second CC attaching to an
  already-held TargetId is **rejected** with an error naming the
  incumbent (`target claude:proj-a already attached — plugin conn
  #1, attached 3m ago`). Rerun with `a2a-bridge claude --force`
  (or `A2A_BRIDGE_FORCE_ATTACH=1`) to kick the old attach; the
  evicted session receives a `claude_connect_replaced` frame that
  surfaces as a CC-visible notification before disconnect.
- **`a2a-bridge daemon targets`.** New inspection subcommand.
  Prints a plain-text table of every TargetId the daemon tracks,
  with attach state, the WS connection id, and uptime since
  attach. Powered by a new `list_targets` control-plane RPC.

### Changed

- **Per-target inbound gateway.** The ACP turn handler resolves
  each turn's target to its own `DaemonClaudeCodeGateway` instance
  (minted lazily by `RoomRouter.getOrCreateByTarget`). Cross-CC
  delivery isolation: inbound text for `claude:ws-a` lands only on
  CC-A's socket, and CC-A's reply can only close CC-A's in-flight
  turn. Regression covered by the
  [cross-target integration test](./src/cli/multi-target.test.ts).
- **`claude_to_codex` intercept is sender-target-aware.** The
  daemon picks the sender's target's Room gateway when deciding
  whether a reply closes an inbound turn, so a reply from CC-A
  cannot accidentally complete CC-B's turn.
- **Plugin disabled-state recovery** now forwards the CC's
  TargetId on the recovery attach (was silently dropping to
  `claude:default` before the fix).

### Fixed — from the v0.2.0 pre-release smoke pass

- `a2a-bridge daemon targets` no longer advertises a phantom
  `claude:default` row when every CC attach was under an explicit
  TargetId. The legacy-singleton fallback only surfaces when no
  per-target entry already covers that connection.
- `a2a-bridge acp` now advertises `agentCapabilities.loadSession:
  true` and implements `session/load` as a stateless no-op.
  OpenClaw acpx's "persistent session" mode previously tried to
  resume a prior session id across subprocess restarts and blew
  up on `agent does not support session/load`; the adopt-as-new
  implementation keeps acpx happy without introducing cross-
  restart session state we don't actually own.

### Deferred to v0.3

- **Codex peer-id routing** (`a2a-bridge codex --id <id>`). Codex
  is a daemon-internal adapter, not a control-plane attach, so
  multi-instancing requires a per-id peer registry + port
  allocation + handler routing refactor. Out of scope for v0.2;
  codex stays `codex:default` (single instance). Tracked in the
  deferred P10.9 entry of `TASKS.md`.
- **Hot-reload of `contextRoutes`.** The A2A inbound reads the
  map at startup; config changes require a daemon restart.
- **Dynamic target discovery.** ACP clients still register each
  target statically (OpenClaw `acpx`, Zed `agent_servers`, etc.).

### Control-plane wire additions (for embedders)

- `claude_connect` grows `{ target?: string; force?: boolean }`.
- New server → plugin frames:
  - `claude_connect_rejected { target, reason }`
  - `claude_connect_replaced { target }`
- `acp_turn_start` grows `{ target?: string }`.
- `claude_to_codex` grows `{ target?: string }`.
- New RPC pair: `list_targets { requestId }` → `targets_response
  { requestId, targets: TargetEntry[] }`.

All additions are optional on the wire — v0.1 plugins / subprocesses
continue to work against a v0.2 daemon (and vice versa).

## [0.1.0] — 2026-04-14

First broadly usable release. Turns a2a-bridge from a Codex-only
prototype into a bridge that any Agent2Agent (A2A) client or any
Agent Client Protocol (ACP) editor can drive against Claude Code.

### Added

- **A2A inbound server.** Gemini CLI and any other A2A client can
  now drive Claude Code through a2a-bridge. Ships an agent card at
  `/.well-known/agent-card.json`, bearer-token auth on the JSON-RPC
  endpoint, and the `message/stream` (SSE), `tasks/get`, and
  `tasks/cancel` methods from the A2A spec. The streamed reply
  comes back as the four-event envelope: initial task →
  status-update(working) → artifact-update → status-update(completed).
- **ACP inbound server.** `a2a-bridge acp` speaks the Agent Client
  Protocol over stdio, so OpenClaw (`acpx`), Zed, and any
  VS Code ACP extension can register a2a-bridge as an agent with
  `command: "a2a-bridge", args: ["acp"]`. Implements the
  `initialize` / `session/new` / `session/prompt` / `cancel`
  surface against a `DaemonProxyGateway` that relays each turn to
  the attached Claude Code session through the daemon's
  control-plane WS. The subprocess fails loudly if no daemon is
  reachable — there is no silent echo fallback in the production
  path.
- **Verification artifact type.** New A2A artifact with MIME type
  `application/vnd.a2a-bridge.verdict+json` carries a
  `pass | fail | needs-info` verdict plus structured evidence.
  Callers opt in by setting `metadata.return_format: "verdict"`
  on the `message/stream` request. Documented with a ready-to-use
  skill template under `skills/verify/`.
- **`return_format` hint.** The same `metadata.return_format`
  field also accepts `"full"` (default) and `"summary"` — lets
  A2A clients ask the peer to keep the reply short, so the primary
  session's context stays focused on the conclusion rather than
  the scratch work. See `skills/context-protect/`.
- **Token-cost reporting.** Every terminal `status-update`
  carries `metadata.tokenUsage: { promptTokens, completionTokens,
  totalTokens }` when the executor supplies it — so A2A clients
  can surface per-turn cost without a separate call.
- **Multi-room session isolation.** A2A and ACP inbound requests
  are routed through a new `RoomRouter` that creates one `Room`
  per `contextId` (falling back to the `A2A_BRIDGE_ROOM` env var
  or `"default"`). Each room owns its own Claude Code gateway and
  peer adapter set, so two concurrent sessions never see each
  other's events. See `docs/guides/rooms.md`.
- **SQLite-backed task log.** Per-room task history is persisted
  to `<stateDir>/tasks.db` via Bun's built-in `bun:sqlite`.
  `tasks/get` on a mid-turn task id keeps working after a plugin
  reconnect — state survives the A2A client restart that used to
  lose it.
- **`a2a-bridge init`.** New subcommand that mints a 32-byte hex
  bearer token, writes `<stateDir>/config.json`, and prints
  copy-paste snippets for Gemini CLI (`remoteAgents`), OpenClaw
  (`acpx.config.agents`), and Zed (`agent_servers`). Idempotent;
  re-running prints the existing token — pass `--force` to
  rotate. `--print` skips the external dep checks and
  marketplace install steps for smoke-test friendliness.
- **`a2a-bridge doctor`.** Preflight checklist (bun version,
  A2A port free, ACP SDK installed, CC plugin discoverable,
  state-dir writable, `init` already run) with PASS / WARN / FAIL
  lines. Exits non-zero when any required check fails.
- **`a2a-bridge daemon start | stop | status | logs`.** Lifecycle
  subcommands. `start` calls `ensureRunning` (idempotent; a no-op
  if already healthy), `stop` SIGTERMs via the pid file with a
  3-second graceful window, `status` prints the pid + ports from
  `status.json`, and `logs [--tail N]` tails the daemon log.
- **Friendly error helpers.** When bind-EADDRINUSE, missing
  bearer token, missing CC plugin, or missing ACP SDK bite a
  first-run user, the CLI prints a two-line `error: / fix:` block
  naming the exact command or env var to try next.
- **Documentation.** Three new top-level docs under `docs/`:
  `docs/guides/cookbook.md` walks through the verification /
  context-protection / parallel patterns with `curl` and SDK
  examples and a rough token-cost table; `docs/guides/rooms.md` covers
  the concurrency model, RoomId derivation, and restart
  semantics; README is reorganized around Install → Configure →
  Connect (Gemini CLI / OpenClaw / Zed / VS Code) → Troubleshooting.

### Changed

- **Daemon is now per-Room, not global.** The Codex adapter and
  task registry that used to live as module-level singletons in
  `daemon.ts` are now scoped to the default `Room`; additional
  rooms can own their own adapter sets. Existing single-session
  behavior is preserved.
- **Idle shutdown is per-Room.** The daemon stops only when
  *all* rooms are idle, not when any one of them is.
- **`a2a-bridge --version`** now reads the bundled package
  manifest via a static JSON import, so the packaged tarball
  correctly reports `a2a-bridge v0.1.0` (previously printed
  `a2a-bridge (version unknown)` from the bundled binary).

### Added — infrastructure the user will not typically touch but may want to know exists

- `scripts/smoke-tarball.sh` — `npm pack` + `npm install <tgz>`
  into a tmpdir + probe `--version` / `init --print` / `doctor`.
  Runs under `bun run check:ci`.
- `scripts/smoke-e2e.sh` + `scripts/smoke-e2e-acp.ts` — spawn the
  daemon on throwaway ports, assert the four-event A2A envelope,
  then attach a stub Claude Code channel via `DaemonClient` and
  drive `a2a-bridge acp` through the ACP SDK, asserting the
  returned `session/update` text carries the stub CC's prefix
  (not an echo). Under `check:ci`.
- `A2A_BRIDGE_INBOUND_ECHO=1` env knob — **test/debug only** —
  puts the A2A HTTP inbound into echo-executor mode so the A2A
  wire contract can be validated without a Claude Code session.
  The ACP path does not rely on this knob; `a2a-bridge acp`
  always relays real turns through the daemon.
- `A2A_BRIDGE_ACP_SKIP_DAEMON=1` env knob skips the ACP
  subcommand's auto-daemon bootstrap — useful when embedding
  `a2a-bridge acp` in a test harness that already owns the
  daemon.
