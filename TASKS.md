# TASKS — v0.1 (Phases 3–7)

Atomic work units for the v0.1 autonomous development loop, spanning
Phases 3 through 7 of `docs/design/roadmap.md`. Each task has acceptance criteria;
the loop must only mark a task done when `bun run check:ci` passes
AND the acceptance criteria are met.

If a task is ambiguous or a criterion cannot be met without changing
an architecture doc, **stop** and notify the user via Telegram (see
`CLAUDE.md` autonomous-mode rules).

Conventions:
- `[ ]` = not started
- `[/]` = in progress (at most one at any time)
- `[x]` = done and pushed to `dev`

v0.1 ship criterion: a user can `npm pack && npm i -g ./*.tgz &&
a2a-bridge init && a2a-bridge daemon start`, then drive Claude Code
end-to-end from Gemini CLI (A2A), OpenClaw (ACP via `acpx`), Zed
(ACP), or VS Code (ACP). All loop-automatable release artifacts are
present; only credential-gated steps (npm publish, marketplace
submission) remain for the human operator.

Phase 2 baseline carried into v0.1: 223 pass / 0 fail / 19 E2E
filtered (`bun run check:ci`, 27 files, 532 expect calls) as of
commit `ed50f4c`. Each phase footer below records the new baseline
once that phase lands.

---

## Phase 3 — Verification and delegation patterns

- [x] **P3.0 — Sanity-check the v0.1 starting baseline.**
  Acceptance: `bun run check:ci` passes; record `N pass / 0 fail` in
  this file's footer for Phase 3. No other changes.

- [x] **P3.1 — Define the verification artifact schema.**
  Acceptance: `src/runtime-daemon/inbound/a2a-http/verdict.ts`
  exports `VerificationVerdict` (the literal union `"pass" | "fail" |
  "needs-info"`), `VerificationEvidence`, and `VerificationArtifact`
  matching the shape in `docs/design/architecture.md` §"Verification artifact".
  Includes a `parseVerdict(value)` validator returning a `Result`-style
  object. Unit tests cover happy parse, unrecognized verdict
  (coerced to `needs-info`), and missing-reasoning rejection.

- [x] **P3.2 — Add `return_format` hint plumbing.**
  Acceptance: `MessageStreamParams` accepts a `metadata.return_format`
  field with type `"full" | "summary" | "verdict"`. The handler
  forwards the value into the executor context (`ctx.returnFormat`).
  Unit test asserts the value reaches the executor for each variant
  and defaults to `"full"` when absent.

- [x] **P3.3 — Verification artifact serializer.**
  Acceptance: `verdict.ts` exports `serializeVerdictArtifact(verdict)`
  returning an A2A artifact whose part has
  `kind: "data"`, `mimeType: "application/vnd.a2a-bridge.verdict+json"`,
  and `data: <verdict>`. Unit test round-trips through `parseVerdict`.

- [x] **P3.4 — Wire verdict path into `message/stream`.**
  Acceptance: when `ctx.returnFormat === "verdict"`, the executor may
  call a new `emit({ kind: "artifact-update", verdict: <obj> })`
  variant; the handler emits the artifact built by
  `serializeVerdictArtifact` rather than a plain text part. Unit
  test asserts the SSE frame's artifact has the expected mime type
  and parses back into a `VerificationVerdict`.

- [x] **P3.5 — Verification skill template.**
  Acceptance: `skills/verify/SKILL.md` documents the verification
  delegation pattern: when to use, the prompt scaffold for the
  verifier subagent, expected return shape (the artifact from P3.3),
  and a worked example. README links to it. lint:deps green.

- [x] **P3.6 — Context-protection skill template.**
  Acceptance: `skills/context-protect/SKILL.md` shows how to delegate
  a long log dig to a peer with `return_format: "summary"`. README
  links to it.

- [x] **P3.7 — Parallel-work skill template.**
  Acceptance: `skills/parallel/SKILL.md` shows the spawn-N-peers
  pattern for genuinely independent subtasks. README links to it.

- [x] **P3.8 — Token-cost reporting on A2A responses.**
  Acceptance: every terminal `status-update` carries
  `metadata.tokenUsage: { promptTokens, completionTokens, totalTokens }`
  when the executor supplies it. Unit test asserts the field
  round-trips through SSE and parses back via the SDK.

- [x] **P3.9 — Pattern cookbook documentation.**
  Acceptance: `docs/guides/cookbook.md` documents the three canonical
  patterns (verification, context-protection, parallel) with
  end-to-end runnable examples (curl + SDK). Each example links to
  its skill template and lists the rough token cost. No source-code
  changes outside `docs/`.

## Phase 4 — RoomRouter and TaskLog

- [x] **P4.1 — Define `RoomId` and derivation rules.**
  Acceptance: `src/runtime-daemon/rooms/room-id.ts` exports
  `RoomId` (branded string) and `deriveRoomId({ contextId?, env? })`
  that returns the room id for an inbound request: `contextId` when
  present, `A2A_BRIDGE_ROOM` env when set, `"default"` otherwise.
  Unit tests cover each branch.

- [x] **P4.2 — Implement `Room`.**
  Acceptance: `src/runtime-daemon/rooms/room.ts` exports a `Room`
  class owning a `ClaudeCodeGateway`, a `TaskRegistry`, and a peer
  adapter set. Constructor accepts `{ id, gateway, registry }`.
  Unit tests for create / dispose lifecycle.

- [x] **P4.3 — Implement `RoomRouter`.**
  Acceptance: `src/runtime-daemon/rooms/room-router.ts` exports
  `RoomRouter` with `getOrCreate(roomId)` and `dispose(roomId)`.
  Tests for the two paths plus `Map<RoomId, Room>` size accounting.

- [x] **P4.4 — SQLite TaskLog schema.**
  Acceptance: `src/runtime-daemon/tasks/task-log-schema.sql` defines
  `tasks(id PK, room_id, context_id, state, status_json, created_at,
  updated_at)`. Migration helper in `task-log.ts` runs the schema
  idempotently on first open.

- [x] **P4.5 — Implement `SqliteTaskLog`.**
  Acceptance: `src/runtime-daemon/tasks/task-log.ts` exports
  `SqliteTaskLog` with `create / get / updateStatus / cancel /
  listByRoom` matching the `TaskRegistry` interface so call sites can
  swap. Uses Bun's built-in `bun:sqlite`. Unit tests cover each
  method against an in-memory sqlite instance.

- [x] **P4.6 — Migrate `TaskRegistry` consumers to `SqliteTaskLog`.**
  Acceptance: `message/stream`, `tasks/get`, `tasks/cancel` accept
  either implementation through a shared interface (`ITaskStore`).
  Default wiring in `startA2AServer` constructs `SqliteTaskLog` at a
  daemon-state-dir path. Existing in-memory tests pass against both
  implementations.

- [x] **P4.7 — Route inbound requests through `RoomRouter`.**
  Acceptance: `startA2AServer` and the ACP inbound (Phase 5) accept
  a `RoomRouter` and route every inbound turn to the room derived
  from `contextId`. Daemon instantiates one `RoomRouter` shared by
  both inbound surfaces. Integration test: two A2A clients with
  different `contextId`s do not see each other's events.

- [x] **P4.8 — Migrate Codex adapter into per-Room ownership.**
  Acceptance: `daemon.ts` no longer holds a module-level `codex`
  singleton; each Room owns its peer adapter set. The default room
  spawns a Codex adapter on demand (preserving today's single-CC
  behavior). All existing daemon tests pass.

- [x] **P4.9 — Per-Room idle / shutdown.**
  Acceptance: `RoomRouter.dispose(roomId)` tears down the room's
  adapters and tasks. Daemon idle-shutdown logic operates per-Room
  rather than globally — the daemon stops when *all* rooms are idle,
  not when any one is.

- [x] **P4.10 — Concurrent-session integration test.**
  Acceptance: new test in `src/cli/concurrent-sessions.test.ts`
  starts the daemon with two A2A clients posting to different
  `contextId`s in parallel; asserts each client sees its own task
  history and the other's events do not leak. `bun run check:ci`
  green with the test included.

- [x] **P4.11 — Plugin-reconnect task survival test.**
  Acceptance: integration test starts a turn, crashes the simulated
  plugin connection mid-turn, restarts it, and confirms `tasks/get`
  on the original task id still returns the latest state from
  SQLite. `bun run check:ci` green.

- [x] **P4.12 — Document the concurrency model.**
  Acceptance: `docs/guides/rooms.md` covers RoomId derivation,
  multi-session semantics, TaskLog persistence guarantees, and the
  per-Room adapter lifecycle. Linked from README.

## Phase 5 — ACP inbound (multi-client reach)

- [x] **P5.1 — Add `@agentclientprotocol/sdk` dependency.**
  Acceptance: `bun add @agentclientprotocol/sdk`; pinned version in
  `package.json` and `bun.lock`. `bun run typecheck` and `bun run
  lint:deps` green. No imports yet.

- [x] **P5.2 — Scaffold `runtime-daemon/inbound/acp/` layout.**
  Acceptance: new files `acp/index.ts` (stub
  `AcpInboundService implements IInboundService`),
  `acp/connection.ts` (placeholder for the AgentSideConnection
  glue). `inbound-factory.ts` gains an `"acp-stdio"` kind that
  constructs `AcpInboundService`. lint:deps green; no behavior yet.

- [x] **P5.3 — Implement the ACP `initialize` + `newSession` handlers.**
  Acceptance: `AcpInboundService.start(stream)` opens an
  `AgentSideConnection` over the supplied stdio pair, advertises
  the agent's `protocolVersion` and minimum capabilities, and
  responds to `newSession` with a session id derived from the
  request. Unit tests use the SDK's in-memory pair to verify the
  handshake.

- [x] **P5.4 — Bridge ACP `prompt` → `ClaudeCodeGateway`.**
  Acceptance: incoming `prompt` calls extract the user text, forward
  via `gateway.startTurn`, and stream each `chunk` event back as a
  `session/update` notification. Final `complete` produces a
  terminal `session/prompt` response with `stopReason: "end_turn"`.
  Errors map to `stopReason: "refusal"` with the message in the
  notification. Unit test mocks the gateway and asserts the wire
  sequence.

- [x] **P5.5 — Wire ACP `cancel` to gateway turn cancel.**
  Acceptance: ACP `cancel` calls `turn.cancel()` on the active
  ClaudeCodeTurn. Pending `prompt` resolves with
  `stopReason: "cancelled"`. Unit test covers the cancel path.

- [x] **P5.6 — `a2a-bridge acp` CLI subcommand.**
  Acceptance: `src/cli/cli.ts` recognizes `acp` as a subcommand that
  starts an `AcpInboundService` over `process.stdin` /
  `process.stdout`. Connects to the long-running daemon via the
  unix-socket control plane (auto-starting the daemon if missing,
  same heuristic the existing CLI uses). E2E test (filtered out of
  `test:unit`) spawns the subcommand and exercises the full ACP
  initialize → prompt → reply round trip via the SDK client.

- [x] **P5.7 — README "Connect ACP clients" section.**
  Acceptance: README gets a new section after "Connect Gemini CLI"
  with copy-paste config snippets for OpenClaw (`acpx.config.agents`),
  Zed (`agent_servers`), and VS Code's ACP plugin. Each snippet
  references `a2a-bridge acp` as the command. No other README
  sections touched.

- [x] **P5.8 — SDK-level ACP integration test.**
  Acceptance: new test in `src/cli/acp-inbound.test.ts` boots the
  ACP service against an in-memory stdio pair using the SDK's
  `ClientSideConnection`, sends a `prompt`, and asserts the client
  observes at least one streamed update plus a terminal response
  with `stopReason: "end_turn"`. `bun run check:ci` green.

## Phase 6 — Distribution and UX polish

- [x] **P6.1 — `a2a-bridge init` command.**
  Acceptance: new subcommand generates a 32-byte hex bearer token,
  writes a default config file at the state-dir's `config.json`
  (host/port/token), and prints the per-client config snippets
  (Gemini CLI `remoteAgents`, OpenClaw `acpx`, Zed `agent_servers`).
  Idempotent: re-running prints existing config without overwriting.
  Unit tests cover first-run, idempotent re-run, and explicit
  `--force` overwrite.

- [x] **P6.2 — `a2a-bridge doctor` command.**
  Acceptance: prints a checklist with pass/fail/warn for: bun
  version >= 1.3, A2A port free, ACP SDK installed, CC channel
  plugin discoverable, state-dir writable, `init` already run.
  Exits non-zero if any required check fails. Unit tests with
  injected dependencies cover each branch.

- [x] **P6.3 — `a2a-bridge daemon` lifecycle subcommands.**
  Acceptance: `daemon start | stop | status | logs` subcommands.
  `start` launches the daemon (with A2A inbound enabled if token
  present). `stop` sends SIGTERM via the pid file. `status` prints
  the running daemon's pid + ports. `logs` tails the state-dir log
  file. Unit tests with injected lifecycle.

- [x] **P6.4 — Friendly error messages for common failures.**
  Acceptance: dedicated error helpers for bind-EADDRINUSE, missing
  bearer token, missing CC plugin, ACP SDK missing. Each prints a
  one-line cause + a recommended fix. Unit tests exercise each
  helper.

- [x] **P6.5 — README rewrite with all four client install paths.**
  Acceptance: README sections — Install (npm), Configure (init +
  doctor), Connect Gemini CLI, Connect OpenClaw, Connect Zed,
  Connect VS Code, Troubleshooting. Each Connect block is
  copy-pasteable and tested locally. The existing "When to use" /
  "When NOT to use" sections stay unchanged.

- [x] **P6.6 — Polish `.claude-plugin/marketplace.json`.**
  Acceptance: marketplace entry has `categories`, `tags`, full
  description, screenshots placeholder paths, and `homepage`. Schema
  validates against the marketplace JSON schema. No behavior change.

- [x] **P6.7 — Tarball install smoke test.**
  Acceptance: `scripts/smoke-tarball.sh` runs `npm pack`, installs
  the resulting tarball into a temp directory with `npm i`, and
  invokes `a2a-bridge --version`, `a2a-bridge init --print`, and
  `a2a-bridge doctor` to confirm the binary works end-to-end.
  `bun run check:ci` invokes it.

- [x] **P6.8 — End-to-end smoke test (A2A + ACP).**
  Acceptance: `scripts/smoke-e2e.sh` starts the daemon, posts a
  `message/stream` over A2A and asserts the four-event envelope,
  then spawns `a2a-bridge acp` and drives it via the SDK to assert
  one prompt → one streamed update → one terminal response. Cleans
  up daemon on exit. `bun run check:ci` invokes it.

- [x] **P6.9 — CHANGELOG.md 0.1.0 block.**
  Acceptance: new `CHANGELOG.md` (or new top section) with a 0.1.0
  block summarizing user-facing changes since 0.0.1: A2A inbound,
  ACP inbound, RoomRouter + TaskLog, verification artifact, init /
  doctor / daemon UX. No internal-only entries.

- [x] **P6.10 — Version bump to 0.1.0.**
  Acceptance: `package.json`, `plugins/a2a-bridge/.claude-plugin/plugin.json`,
  and `.claude-plugin/marketplace.json` bumped to 0.1.0.
  `bun scripts/check-plugin-versions.js` passes. architecture.md
  references to "v0.1" remain accurate.

## Phase 7 — Release packaging

- [x] **P7.1 — Upgrade `.github/workflows/ci.yml`.**
  Acceptance: CI runs typecheck, lint:deps, test, build:plugin,
  AND `scripts/smoke-tarball.sh` on every PR. Matrix on Ubuntu and
  macOS. Caches bun deps. README badge points at the workflow.

- [x] **P7.2 — Add `.github/workflows/release.yml`.**
  Acceptance: tag-triggered workflow runs the full check, builds the
  tarball, attaches it to a draft GitHub release, and surfaces an
  npm-publish step gated on a manual `production` environment
  approval. Does NOT publish unattended.

- [x] **P7.3 — ACP registry submission package.**
  Acceptance: `release/acp-registry/agent.json` + `icon.svg`
  conforming to the public ACP registry schema. README at
  `release/acp-registry/README.md` explains the PR process the user
  follows to submit.

- [x] **P7.4 — Claude Code marketplace submission package.**
  Acceptance: `release/marketplace/SUBMIT.md` lists every artifact
  Anthropic requires (description, screenshots paths, plugin
  manifest validation steps) plus the submission URL. All referenced
  artifacts exist in the repo or have placeholder paths flagged
  for the user.

- [x] **P7.5 — `docs/release/publish.md` runbook.**
  Acceptance: step-by-step guide covering: bump check, CHANGELOG
  finalization, tag creation, GitHub Actions release run, manual
  npm publish (with `--otp` reminder), marketplace submission, ACP
  registry PR, post-release smoke test against the published
  package. Total length under 400 lines.

- [x] **P7.6 — `scripts/check-release-ready.sh`.**
  Acceptance: shell script (Bun-friendly) that asserts: version
  alignment across all manifests, CHANGELOG has an entry for the
  current version, `bun run check:ci` green, tarball builds and
  installs, all required release/ artifacts present. Exits non-zero
  on any failure. README references the script in the release
  workflow section.

## Phase 8 — Real ACP → Claude Code routing (no mock)

> Why this block lands before the first public 0.1.0 release. The
> v0.1 ACP inbound currently resolves `prompt` against an in-process
> `EchoGateway` — OpenClaw / Zed / VS Code users see `Echo: <text>`
> instead of a real Claude Code reply. Before a Join skill is useful
> (Phase 9) the `a2a-bridge acp` subprocess must actually reach the
> attached Claude Code session through the daemon. Unit tests may
> still use fakes; the CLI default path must never short-circuit to
> a mock or echo reply.

> **Plugin↔CC contract reference.** The a2a-bridge plugin is itself
> a Channel (MCP `claude/channel` capability). As Phase 8 wires ACP
> turns through the plugin, the plugin must keep emitting
> `notifications/claude/channel` with **identifier-safe meta keys**
> (`[a-z0-9_]+` only — hyphens and other non-word chars are silently
> dropped by Claude Code), keep its reply tool registered via
> `ListToolsRequestSchema` / `CallToolRequestSchema`, and keep an
> `instructions` string telling Claude how to route replies back.
> Source of truth: <https://code.claude.com/docs/en/channels-reference>.
> Full production reference: `references/claude-plugins-official/external_plugins/telegram/server.ts`
> (capability declaration at L369–396; permission_request handler at
> L405–430; reply / react / edit tool schemas at L432–504). Any
> Phase 8 change that alters plugin↔CC wire shape must be audited
> against both.

- [x] **P8.1 — Control-plane wire format for ACP turns.**
  Acceptance: new message variants in `transport/` (or the
  daemon's control-message types) covering `acp_turn_start`,
  `acp_turn_chunk`, `acp_turn_complete`, `acp_turn_error`, and
  `acp_turn_cancel`. Typed on both ends; round-trip unit tests.
  Any meta / context fields on these frames that are eventually
  forwarded to `notifications/claude/channel` use identifier-safe
  keys only (`[a-z0-9_]+`); unit test rejects hyphenated or
  otherwise non-identifier keys at the boundary so CC never
  silently drops them.

- [x] **P8.2 — Daemon-side handler for ACP turns.**
  Acceptance: when an attached client sends `acp_turn_start`, the
  daemon calls `inboundGateway.startTurn(text)` on the shared
  `DaemonClaudeCodeGateway` and pipes the resulting `chunk` /
  `complete` / `error` events back to that client as the matching
  control-plane frames. One ACP connection can own at most one
  in-flight turn; `acp_turn_cancel` fires `turn.cancel()`. Unit
  test drives the handler with a stub gateway and asserts the
  frame sequence.

- [x] **P8.2a — Permission-relay policy for ACP-triggered turns.**
  Acceptance: decide and document how the plugin's
  `notifications/claude/channel/permission_request` handler
  behaves when the in-flight turn originated from an ACP client
  (ACP has no "chat to reply in" analogue for the five-letter
  verdict dance Channels specifies). Pick one and write the
  rationale into `docs/design/architecture.md`:
  (a) auto-allow, gated by a daemon-side policy flag such as
  `A2A_BRIDGE_ACP_AUTO_PERMISSION`;
  (b) bridge to ACP `session/request_permission` (if the SDK
  exposes it) so the ACP client is prompted;
  (c) auto-deny, turn ends with `stopReason: "refusal"`.
  Integration test exercises a turn that triggers a tool-use
  permission prompt and asserts the chosen behavior end-to-end.
  References: [Channels §Relay permission prompts](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts);
  telegram reference handler at
  `references/claude-plugins-official/external_plugins/telegram/server.ts:405-430`.

- [x] **P8.3 — `DaemonProxyGateway` in `runtime-daemon/inbound/acp/`.**
  Acceptance: new class implementing `ClaudeCodeGateway` that
  opens a control-plane WS connection to the daemon and uses the
  Phase-8.1 wire format to relay turns. `startTurn(text)` returns
  a `ClaudeCodeTurn` whose `chunk` / `complete` / `error` events
  come straight from the WS frames. Reconnect logic mirrors the
  plugin-side `DaemonClient`. The `chunk` events that eventually
  propagate to the plugin's `notifications/claude/channel`
  emitter must round-trip without lossy key renaming — meta keys
  stay identifier-safe end-to-end.

- [x] **P8.4 — Wire `runAcp()` onto `DaemonProxyGateway` (no echo
  fallback).**
  Acceptance: `src/cli/acp.ts` default stdio path constructs
  `DaemonProxyGateway` after `lifecycle.ensureRunning()` resolves.
  When the daemon is unreachable the subcommand **fails loudly**
  (non-zero exit + friendly error helper from `errors.ts`) rather
  than falling back to echo. `EchoGateway` stays in the codebase
  but only test files import it; a lint:deps rule enforces this.
  Update `acp-cli.test.ts` to assert the end-to-end SDK round-trip
  lands a daemon-originated reply, not an echo.

- [x] **P8.5 — End-to-end integration test with a stub Claude Code
  channel.**
  Acceptance: new test that boots the real daemon, attaches a stub
  CC channel (via the existing `DaemonClient` seam) that replies
  with deterministic text, spawns `a2a-bridge acp` as a child
  process, drives it via the ACP SDK, and asserts the returned
  `session/update` text equals the stub CC reply verbatim. Runs
  under `check:ci`; covers the full real wire end-to-end.

- [x] **P8.6 — Update `smoke-e2e.sh` to exercise the real ACP → CC
  path.**
  Acceptance: the ACP half of `scripts/smoke-e2e.sh` no longer
  runs with `A2A_BRIDGE_INBOUND_ECHO=1`; it attaches a stub CC
  client to the daemon and asserts the smoke ACP prompt returns
  the stub's reply (not `Echo: ...`). The env-var hook stays but
  is documented as a test/debug only knob.

- [ ] **P8.7 — Fix hardcoded `agentInfo.version: "0.0.1"` in
  `src/runtime-daemon/inbound/acp/index.ts`.**
  Acceptance: the ACP `initialize` response advertises the real
  package version (via the same JSON-import trick
  `src/cli/cli.ts` uses). Unit test asserts the response's
  `agentInfo.version` matches `package.json`. The same fix
  applies plugin-side: the MCP `Server({ name, version }, ...)`
  constructor in `src/runtime-plugin/bridge.ts` (or wherever the
  plugin instantiates its `Server`) must pull `name` and
  `version` from `package.json` rather than hardcoding — this
  matches the Channels-reference example and the telegram
  reference (`server.ts:370`: `{ name: 'telegram', version: '1.0.0' }`
  is explicit and maintained in `package.json`). Unit test
  covers both the ACP `initialize` response and the plugin's
  advertised `Server` info.

- [ ] **P8.8 — Documentation sweep: no more "post-v0.1" caveats
  on ACP → CC.**
  Acceptance: `CHANGELOG.md`'s `## [0.1.0]` block describes the
  real routing; `README.md`'s Connect-OpenClaw / Zed / VS Code
  sections drop the echo-gateway warning; `docs/guides/cookbook.md`
  gains a fourth pattern example if natural; `docs/design/architecture.md`'s
  ACP subsection promotes the `DaemonProxyGateway` from
  "planned" to "implemented."

## Phase 9 — Join skill + first public release

> Why this block caps v0.1. Once ACP → CC is real (Phase 8), the
> user can hand a single URL to Claude Code AND OpenClaw and each
> AI self-installs its side of the bridge. This is the
> developer-facing payoff of the whole v0.1 body of work.

- [ ] **P9.1 — Cut a draft GitHub release with the tarball.**
  Acceptance: tag `v0.1.0` pushed to GitHub; `release.yml` runs
  green on the matrix; the resulting draft release at
  `github.com/firstintent/a2a-bridge/releases/tag/v0.1.0` carries
  the tarball. Release stays as a draft (do NOT publish-npm yet);
  the tarball URL is what the skill will reference.

- [ ] **P9.2 — `docs/join.md` — cross-bridge join skill.**
  Acceptance: a single self-contained Markdown document a user can
  hand to either Claude Code or OpenClaw via "Read <url> and
  follow it." The document detects the host environment (by
  asking the host AI) and runs one of two installers:
  - **Claude Code side**: `npm i -g <tarball-URL>` → `a2a-bridge
    init` → `a2a-bridge daemon start` → report bearer token +
    control port back to the user.
  - **OpenClaw side**: `npm i -g <tarball-URL>` → verify
    `a2a-bridge --version` → register the ACP agent in
    `acpx.config.agents` → restart acpx → test the bridge by
    sending a one-shot prompt and asserting the reply is not an
    echo. Unit / smoke tests for the parsed instructions if
    feasible; manual verification notes otherwise.

- [ ] **P9.3 — README "Join the bridge" section.**
  Acceptance: new top-level README section (between "Configure"
  and "Connect Gemini CLI") showing the single-line skill invoke
  for each side:
  ```
  Claude Code:   Read <skill-url> and follow it.
  OpenClaw:      Read <skill-url> and follow it.
  ```
  Short two-sentence intro on what happens after both sides run
  the skill. Links to `docs/join.md` for the full text.

- [ ] **P9.4 — End-to-end manual verification of the cross-bridge
  loop.**
  Acceptance: on the maintainer's machine, execute the skill
  against a live Claude Code session and a live OpenClaw session,
  then drive a non-trivial prompt through OpenClaw and record the
  full reply (must originate from Claude Code, not echo). Save
  the transcript under `docs/release/verified-joins/<date>.md`
  (or similar) as evidence for the first publish.

- [ ] **P9.5 — Bump + CHANGELOG close for the first publish.**
  Acceptance: `CHANGELOG.md`'s `## [0.1.0]` header flips from
  `— Unreleased` to the release date. `docs/release/publish.md`
  remains the runbook; the maintainer takes over from there for
  `npm publish`, the marketplace form, and the ACP registry PR.

---

## Phase footers (filled by the loop)

- Phase 3 baseline: 240 pass / 0 fail / 19 E2E filtered, 28 test files, 579 expect calls (on P3.9 close; P3.0 sanity-check started at 223 pass).
- Phase 4 baseline: 293 pass / 0 fail / 19 E2E filtered, 35 test files, 739 expect calls (on P4.12 close; Phase 4 opened with the 240-pass baseline carried from Phase 3).
- Phase 5 baseline: 304 pass / 0 fail / 20 E2E filtered, 38 test files, 768 expect calls (on P5.8 close; Phase 5 opened with the 293-pass baseline carried from Phase 4).
- Phase 6 baseline: 339 pass / 0 fail / 20 E2E filtered, 42 test files, 868 expect calls (on P6.10 close; Phase 6 opened with the 304-pass baseline carried from Phase 5).
- Phase 7 baseline: 339 pass / 0 fail / 20 E2E filtered, 42 test files, 868 expect calls (on P7.6 close; Phase 7 opened with the 339-pass baseline carried from Phase 6). v0.1 complete — every P3–P7 task is [x]; remaining release steps (`npm publish`, marketplace form, ACP registry PR) require human credentials per ROADMAP and are documented in `docs/release/publish.md`.

## v0.1 starting baseline

- Carry-over from Phase 2 (`ed50f4c`): 223 pass / 0 fail / 19 E2E
  filtered, 27 test files, 532 expect calls.
- lint:deps: 0 violations (84 modules / 213 deps).
