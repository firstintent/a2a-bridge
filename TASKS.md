# TASKS — Phase 2: InboundService v0

Atomic work units for the Phase 2 autonomous development loop. Each
task has acceptance criteria; the loop must only mark a task done
when `bun run check:ci` passes AND the acceptance criteria are met.

If a task is ambiguous or a criterion cannot be met without changing
an architecture doc, **stop** and notify the user via Telegram (see
`CLAUDE.md` autonomous-mode rules).

Conventions:
- `[ ]` = not started
- `[/]` = in progress (at most one at any time)
- `[x]` = done and pushed to `dev`

Phase 2 ship criterion (from `ROADMAP.md`): a Gemini CLI user
configures one `remote_agent` entry and has Claude Code answering
their queries end-to-end.

---

## Preparation

- [x] **P2.0 — Establish a unit-test baseline on `dev`.**
  Acceptance: `bun run check:ci` passes; record the "N passing"
  count in this file's footer so later tasks can detect
  regressions.

## Transport abstraction

- [x] **P2.1 — Define the `Listener` interface in
  `src/transport/listener.ts`.**
  Acceptance: interface exports `Listener` with `listen()`,
  `close()`, and an `EventEmitter` surface emitting `connection` with
  a typed `Connection` wrapper. No implementations yet. typecheck +
  lint:deps green.

- [x] **P2.2 — Implement `StdioListener` in
  `src/transport/stdio.ts`.**
  Acceptance: implements `Listener`; a connected stdio process emits
  exactly one `connection` event whose `Connection` reads/writes the
  stdio pair. Unit test covers the happy path.

- [x] **P2.3 — Implement `UnixSocketListener` in
  `src/transport/unix.ts`.**
  Acceptance: implements `Listener`; accepts multiple inbound
  connections over a unix socket path; unit test uses a temp path
  and verifies a client can connect and send a frame.

- [x] **P2.4 — Migrate the daemon control plane to the `Listener`
  interface.**
  Acceptance: `src/runtime-daemon/daemon.ts` no longer calls
  `Bun.serve` / WebSocket directly for the plugin connection; it
  instantiates a `Listener` and reacts to `connection`. Existing
  plugin-side client tests still pass. No behavioral change for the
  Codex-backed single-room path.

## InboundService scaffold

- [x] **P2.5 — Create `src/runtime-daemon/inbound/` layout.**
  Acceptance: new files `inbound-service.ts` (interface
  `IInboundService`), `inbound-factory.ts` (dispatch by `kind:
  "a2a-http"`), and `a2a-http/` subdir with an `index.ts` stub.
  lint:deps green (enforces that `inbound/` cannot reach into
  `peers/` directly). No behavior yet.

- [ ] **P2.6 — Generate the Agent Card.**
  Acceptance: `src/runtime-daemon/inbound/a2a-http/agent-card.ts`
  exports `buildAgentCard(config)`; output validates against the
  fields in `ARCHITECTURE.md` §"Agent Card fields"; unit test
  asserts `protocolVersion === "0.3.0"`, streaming capability true,
  at least one skill, securitySchemes declares `http` Bearer.

## HTTP surface

- [ ] **P2.7 — HTTP server skeleton.**
  Acceptance: `a2a-http/server.ts` exports `startA2AServer(config)`
  returning a shutdown handle; uses `Bun.serve`; binds to
  `config.host`/`config.port`; logs requests through
  `@shared/logger`. Integration test: GET /healthz returns 200.

- [ ] **P2.8 — Bearer auth middleware.**
  Acceptance: `a2a-http/auth.ts` exports a request guard that
  accepts `Authorization: Bearer <token>` and rejects missing/bad
  tokens with 401; the agent-card endpoint is exempt if
  `config.publicAgentCard === true`. Unit tests cover both paths.

- [ ] **P2.9 — Agent-card endpoint.**
  Acceptance: `GET /.well-known/agent-card.json` returns the output
  of `buildAgentCard(config)` with `Content-Type: application/json`.
  Integration test verifies status 200 and schema.

- [ ] **P2.10 — JSON-RPC dispatcher.**
  Acceptance: `a2a-http/jsonrpc.ts` exports a `dispatch(request,
  handlers)` function that validates JSON-RPC 2.0 framing, routes
  by method, and returns `{code: -32601}` for unknown methods.
  Integration test covers success, method-not-found, and malformed
  input.

## A2A methods

- [ ] **P2.11 — `message/stream` SSE handler (no-CC echo).**
  Acceptance: `a2a-http/handlers/message-stream.ts` implements the
  method. Response is `text/event-stream`. Emits in order: one
  `task` event, one `status-update` `working`, one
  `artifact-update` with the echoed user text, one
  terminal `status-update` with `final: true`, `state: completed`,
  non-empty `status.message`. Driven by a pluggable `executor`
  callback (no CC dependency yet). Integration test asserts the
  four-event stream.

- [ ] **P2.12 — `tasks/get` handler.**
  Acceptance: returns a stub 404 (`code: -32001`) until the
  in-memory task registry lands in the next task; unit test covers
  the 404 path.

- [ ] **P2.13 — In-memory task registry.**
  Acceptance: `a2a-http/task-registry.ts` stores created tasks
  keyed by `id`; `message/stream` registers on task creation;
  `tasks/get` returns the task; `tasks/cancel` marks it canceled
  and notifies the active stream. Unit tests for each flow.

## CC integration

- [ ] **P2.14 — Wire inbound to the existing Codex-backed Room.**
  Acceptance: replace the `message/stream` executor stub with one
  that forwards the user text into the single active daemon room
  (reuses the path already consumed by the plugin's `reply` tool
  pipeline). Claude Code's reply streams back as A2A
  `artifact-update` (`append: true`) events; a final
  `status-update` fires when the Claude Code turn ends. Integration
  test with a mocked Claude Code responder asserts end-to-end
  streaming.

## Verification

- [ ] **P2.15 — SDK-level integration test.**
  Acceptance: add `@a2a-js/sdk` as a dev dependency; a new test in
  `src/cli/a2a-inbound.test.ts` starts the daemon on an ephemeral
  port with `test:unit` hooks, uses the SDK's client to call
  `message/stream`, and asserts the client receives at least one
  `artifact-update` and one terminal `status-update` with
  `final: true`. `bun run check:ci` green with the new test
  included.

- [ ] **P2.16 — README "Connect Gemini CLI" section.**
  Acceptance: add a short subsection to `README.md` showing the
  exact Gemini CLI `remote_agent` config that points at a local
  `a2a-bridge` daemon, including the Bearer token field. Do not
  touch other README sections. No behavior change.

---

## Baseline

- Unit-test count baseline: 141 pass / 0 fail / 19 E2E filtered
  (`bun run check:ci`, 13 files, 326 expect calls)
- lint:deps violations baseline: 0 (51 modules / 133 deps as of
  commit `6b398ee`)
