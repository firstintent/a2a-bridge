# TASKS — v0.1 (Phases 3–7)

Atomic work units for the v0.1 autonomous development loop, spanning
Phases 3 through 7 of `ROADMAP.md`. Each task has acceptance criteria;
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
  matching the shape in `ARCHITECTURE.md` §"Verification artifact".
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
  Acceptance: `docs/cookbook.md` documents the three canonical
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
  Acceptance: `docs/rooms.md` covers RoomId derivation,
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
  `bun scripts/check-plugin-versions.js` passes. ARCHITECTURE.md
  references to "v0.1" remain accurate.

## Phase 7 — Release packaging

- [ ] **P7.1 — Upgrade `.github/workflows/ci.yml`.**
  Acceptance: CI runs typecheck, lint:deps, test, build:plugin,
  AND `scripts/smoke-tarball.sh` on every PR. Matrix on Ubuntu and
  macOS. Caches bun deps. README badge points at the workflow.

- [ ] **P7.2 — Add `.github/workflows/release.yml`.**
  Acceptance: tag-triggered workflow runs the full check, builds the
  tarball, attaches it to a draft GitHub release, and surfaces an
  npm-publish step gated on a manual `production` environment
  approval. Does NOT publish unattended.

- [ ] **P7.3 — ACP registry submission package.**
  Acceptance: `release/acp-registry/agent.json` + `icon.svg`
  conforming to the public ACP registry schema. README at
  `release/acp-registry/README.md` explains the PR process the user
  follows to submit.

- [ ] **P7.4 — Claude Code marketplace submission package.**
  Acceptance: `release/marketplace/SUBMIT.md` lists every artifact
  Anthropic requires (description, screenshots paths, plugin
  manifest validation steps) plus the submission URL. All referenced
  artifacts exist in the repo or have placeholder paths flagged
  for the user.

- [ ] **P7.5 — `docs/release/PUBLISH.md` runbook.**
  Acceptance: step-by-step guide covering: bump check, CHANGELOG
  finalization, tag creation, GitHub Actions release run, manual
  npm publish (with `--otp` reminder), marketplace submission, ACP
  registry PR, post-release smoke test against the published
  package. Total length under 400 lines.

- [ ] **P7.6 — `scripts/check-release-ready.sh`.**
  Acceptance: shell script (Bun-friendly) that asserts: version
  alignment across all manifests, CHANGELOG has an entry for the
  current version, `bun run check:ci` green, tarball builds and
  installs, all required release/ artifacts present. Exits non-zero
  on any failure. README references the script in the release
  workflow section.

---

## Phase footers (filled by the loop)

- Phase 3 baseline: 240 pass / 0 fail / 19 E2E filtered, 28 test files, 579 expect calls (on P3.9 close; P3.0 sanity-check started at 223 pass).
- Phase 4 baseline: 293 pass / 0 fail / 19 E2E filtered, 35 test files, 739 expect calls (on P4.12 close; Phase 4 opened with the 240-pass baseline carried from Phase 3).
- Phase 5 baseline: 304 pass / 0 fail / 20 E2E filtered, 38 test files, 768 expect calls (on P5.8 close; Phase 5 opened with the 293-pass baseline carried from Phase 4).
- Phase 6 baseline: 339 pass / 0 fail / 20 E2E filtered, 42 test files, 868 expect calls (on P6.10 close; Phase 6 opened with the 304-pass baseline carried from Phase 5).
- Phase 7 baseline:

## v0.1 starting baseline

- Carry-over from Phase 2 (`ed50f4c`): 223 pass / 0 fail / 19 E2E
  filtered, 27 test files, 532 expect calls.
- lint:deps: 0 violations (84 modules / 213 deps).
