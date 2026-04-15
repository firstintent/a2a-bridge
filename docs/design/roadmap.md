# Roadmap

Phases are ordered by **value × breadth**. The earliest phases unlock
the use cases that benefit the most users with the least per-peer
work. Specialized peer adapters wait until the general surface is
proven.

Design principles that drive this ordering live in
[`positioning.md`](./positioning.md). The baseline assumption is that
most tasks should still run on a single well-prompted Claude Code
session — a2a-bridge ships capability for the cases where that is
genuinely insufficient.

## Status

**v0.1 (shipped, 2026-04-14).** Phases 1–9 complete on `dev`, tag
`v0.1.0` pushed. A2A + ACP inbound with real Claude Code routing
via `DaemonProxyGateway` (no echo fallback), Codex outbound,
RoomRouter + SQLite TaskLog, verification artifact +
`return_format` hint, `a2a-bridge init / doctor / daemon` UX, CI +
release workflow, cross-bridge join skill (`docs/join.md`), and
cross-host verification (OpenClaw → public internet → daemon → real
CC → reply). See [`CHANGELOG.md`](../../CHANGELOG.md).

**v0.2 (planned).** Outbound OpenClaw + Hermes peer adapters
(making the star topology fully bidirectional), MCP InboundService
(Cursor / Claude Desktop as clients), TLS TCP listener for
cross-machine daemon deployment. Each item needs live external
infrastructure or client software the autonomous loop cannot
provision; see the "v0.2 backlog" section at the bottom of this
file.

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

## Phase 2 — InboundService v0 (A2A server) (done)

**Why first.** One feature unlocks the broadest audience: any A2A
client (Gemini CLI today, every A2A peer that follows) can drive
Claude Code through a2a-bridge with no per-peer work on our side.
This is the biggest breadth-per-effort ratio in the roadmap.

- Abstract the daemon's listener layer into a single `Listener`
  interface with stdio and unix-socket implementations (TLS TCP
  deferred until we need it).
- Implement the minimum A2A server surface documented in
  `architecture.md` — `GET /.well-known/agent-card.json`, JSON-RPC
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

## Phase 3 — Verification and delegation patterns (done)

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

## Phase 4 — RoomRouter and TaskLog (done)

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

## Phase 5 — ACP inbound (multi-client reach) (done)

**Why next, ahead of outbound peers.** Phase 2 covered the A2A
inbound surface that Gemini CLI (and future A2A peers) speak. The
other dominant client family today — editor-style consumers (Zed, VS
Code, OpenClaw via `acpx`, Hermes) — does not speak A2A; it speaks
ACP. Adding an ACP inbound shim on the same `ClaudeCodeGateway`
multiplies our reachable client base for the price of one stdio
server. Outbound peer adapters (OpenClaw, Hermes) need live
infrastructure (Ed25519 gateway, Hermes binary) the autonomous loop
cannot provision; they move to v0.2.

- Add `@agentclientprotocol/sdk` and an `acp/` inbound subdirectory
  under `runtime-daemon/inbound/`.
- `ACPInboundService` implements the minimum ACP surface (initialize,
  newSession, prompt with streaming session/update notifications,
  cancel) over stdio JSON-RPC.
- `a2a-bridge acp` CLI subcommand starts the ACP server, connecting
  to the long-running daemon over its unix-socket control plane.
- Bridge each ACP `prompt` into the shared `ClaudeCodeGateway`; CC
  reply chunks stream back as `session/update` notifications.

**Ship criterion:** OpenClaw, Zed, and VS Code users can each
register `a2a-bridge acp` as a custom ACP agent and have Claude Code
answering their prompts end-to-end with streamed replies.

## Phase 6 — Distribution and UX polish (done)

**Why before release packaging.** The build chain produces a tarball
today, but first-run UX still requires reading source. Shipping v0.1
means a user can `npm i -g`, run a single command, and have a
functioning daemon plus correctly-formatted client config snippets
for every supported integration.

- `a2a-bridge init` — generate a bearer token, write a default config
  file, print the per-client config snippets.
- `a2a-bridge doctor` — preflight checks (port collisions, CC plugin
  install, ACP SDK availability, bun version, file permissions).
- `a2a-bridge daemon start|stop|status|logs` — full lifecycle.
- Friendly error messages on common failures (token missing, port
  busy, CC plugin not installed).
- README rewrite: install, configure, connect Gemini CLI / OpenClaw /
  Zed / VS Code (each as a copy-pasteable section).
- `npm pack` smoke test plus end-to-end script that exercises both
  A2A and ACP paths against a freshly-installed tarball.
- CHANGELOG.md 0.1.0 block; version bump 0.0.1 → 0.1.0 across all
  manifests.

**Ship criterion:** `npm pack && npm i -g ./*.tgz && a2a-bridge init
&& a2a-bridge daemon start` works, with all four client integrations
documented and locally verified.

## Phase 7 — Release packaging (done)

**Why this seam.** v0.1 release requires steps the autonomous loop
cannot fully execute — npm publish, marketplace submission, registry
PRs all need credentials or third-party approval. This phase prepares
every artifact those steps need so the human-side work is a checklist,
not a research project.

- CI workflow: typecheck + lint:deps + test + smoke-tarball on every
  PR; release workflow on tag (npm publish requires manual approve).
- ACP registry submission package: `agent.json`, `icon.svg`, README
  stub the user attaches to a registry PR.
- Claude Code marketplace submission package: required artifacts and
  a step-by-step submit guide.
- `docs/release/publish.md` runbook covering the credential-gated
  steps the user runs locally.
- `scripts/check-release-ready.sh` script that verifies version
  alignment, CHANGELOG presence, tarball integrity, and lists any
  pending manual steps before tagging.

**Ship criterion:** the user can `npm publish` and submit the two
marketplace packages by following one runbook, with no further code
changes required.

## Phase 8 — Real ACP → Claude Code routing (no mock) (done)

**Why before release.** Phase 5 built the ACP inbound wire; v0.1
shipped it against an in-process echo reply to validate the
handshake. Before any OpenClaw / Zed / VS Code user can actually
drive Claude Code through `a2a-bridge acp`, the subprocess needs to
reach the attached CC session through the daemon. Tests may use
fakes; the CLI default path may not short-circuit to a mock.

- `DaemonProxyGateway` replaces `EchoGateway` in the `runAcp()`
  default path. `a2a-bridge acp` connects to the daemon over its
  control-plane WS and forwards each ACP `prompt` into the shared
  `DaemonClaudeCodeGateway`.
- New control-plane message variants carry ACP-originated
  `turn_start` / `turn_chunk` / `turn_complete` / `turn_cancel`
  frames in both directions.
- `a2a-bridge acp` fails loudly when the daemon is unreachable
  (non-zero exit + friendly error helper) rather than silently
  degrading to echo.
- Integration test boots the real daemon + a stub CC channel
  client; drives ACP via the SDK; asserts the `session/update`
  text is the stub CC's reply verbatim. `scripts/smoke-e2e.sh`
  exercises the same path under `check:ci`.

**Ship criterion:** the existing SDK-level ACP integration test
(and `smoke-e2e.sh`) pass against the real routing — no
`A2A_BRIDGE_INBOUND_ECHO=1` in the production code path.

## Phase 9 — Join skill + first public release (done)

**Why this caps v0.1.** Once ACP → CC is real, the developer-facing
payoff is a one-URL cross-bridge skill: a user hands the same
document to Claude Code and to OpenClaw, each AI self-installs its
side, and OpenClaw can then drive Claude Code end-to-end.

- Cut a draft GitHub release at `v0.1.0` with the tarball attached
  via `release.yml`. The tarball URL is what the skill will
  reference for `npm i -g`.
- `docs/join.md` — a single self-contained Markdown skill that
  detects the host environment (asks the AI what it is) and runs
  the matching installer plus a post-install smoke. Claude Code
  side installs + `a2a-bridge init` + `daemon start`. OpenClaw
  side installs + registers the ACP agent in `acpx.config.agents`
  + round-trips a prompt to verify the reply is not echo.
- README gains a "Join the bridge" section showing the one-line
  "Read <skill-url> and follow it" invocation for each AI, linking
  to `docs/join.md` for the full document.
- Manual end-to-end verification on the maintainer's machine
  against a live Claude Code + live OpenClaw; transcript saved
  under `docs/release/verified-joins/` as evidence for publish.
- `CHANGELOG.md`'s `[0.1.0]` header flips from `— Unreleased` to
  the release date.

**Ship criterion:** a fresh OpenClaw session, having followed the
Join skill, can drive a non-trivial prompt through to Claude Code
and receive Claude Code's actual reply. The maintainer takes over
for `npm publish`, marketplace form submission, and the ACP
registry PR.

## v0.2 backlog — outbound peers, MCP inbound

These move out of the v0.1 path because they require live external
infrastructure (gateway endpoints, peer binaries, MCP host
applications) that the autonomous loop cannot provision in CI.

- **OpenClaw outbound adapter** — Ed25519 device handshake against
  the OpenClaw gateway protocol. `OpenClawAdapter` implementing
  `IPeerAdapter` with synthesized turn events. Cross-host integration
  test once a gateway endpoint is available.
- **Hermes outbound adapter** — `HermesAdapter` over Zed ACP for
  Hermes-as-peer (the rarer direction; Hermes already ships native CC
  calling). Synthesized `turnStarted` at `session/prompt` send.
- **MCP inbound** — `runtime-daemon/inbound/mcp/` shim mirroring the
  ACP shape. Targets Cursor and Claude Desktop. Same
  `ClaudeCodeGateway` underneath.
- **Multi-target routing via `--target`** — one daemon fronts
  multiple agent instances (several Claude Code workspaces, several
  Codex / Hermes peers, ...). Every target is identified by a
  `kind:id` tuple, e.g. `claude:project-a`, `codex:dev`,
  `hermes:default`. The ACP subprocess takes `--target kind:id` to
  pick where its turns go; the plugin sends its workspace id on
  attach; RoomRouter becomes `Map<TargetId, Room>` with per-target
  attach. Full design: [`multi-target-routing.md`](./multi-target-routing.md).
- **Self-signed TLS listener** — `a2a-bridge daemon start --tls`
  auto-generates a self-signed certificate pair on first run, prints
  the fingerprint, and binds `wss://` on port 443 (configurable).
  Clients trust-on-first-use (TOFU) the fingerprint, same UX as SSH's
  first-connect prompt. This makes the daemon reachable from any
  network without WSL port-forwarding, proxy workarounds, or manual
  certificate management. Optional Let's Encrypt and mTLS support
  for users with domains or enterprise requirements.

## Explicitly deferred

- ~~TLS TCP listener.~~ Moved to v0.2 backlog above (self-signed TOFU).
- Push-notification variants of A2A. Not used by today's A2A
  clients.
- gRPC transport for A2A. JSON-RPC + SSE covers the field.
- Per-peer prompt templates for roles beyond verification.
  Orchestration framework territory; see `positioning.md`.
