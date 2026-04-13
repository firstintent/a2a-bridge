# Changelog

All notable user-facing changes to a2a-bridge land here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

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
  surface against the shared Claude Code gateway. v0.1 ships an
  in-process echo reply so the wire can be validated before
  daemon-backed ACP → CC routing lands post-v0.1.
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
  daemon in A2A-echo mode, assert the four-event envelope, then
  spawn `a2a-bridge acp` and drive it with the ACP SDK client to
  assert one prompt → streamed update → `end_turn`. Also under
  `check:ci`.
- `A2A_BRIDGE_INBOUND_ECHO=1` env knob puts the daemon in
  echo-executor mode so A2A wire behavior can be validated
  without a Claude Code session attached.
- `A2A_BRIDGE_ACP_SKIP_DAEMON=1` env knob skips the ACP
  subcommand's auto-daemon bootstrap — useful when embedding
  `a2a-bridge acp` in a test harness that already owns the
  daemon.
