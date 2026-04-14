# CLAUDE.md — a2a-bridge

## Project

**a2a-bridge** is a bidirectional bridge between Claude Code and other AI coding agents (Codex, OpenClaw, Hermes, ...) built on the Claude Code Channels protocol. Modelled after `raysonmeng/agent-bridge` but designed from day one for:

- Pluggable peer adapters (one adapter per target agent)
- Multi-machine deployment (daemon on one host, CC on another)
- Multi-room / concurrent CC sessions

## Language policy — **strict**

Everything stored in this git repo MUST be in English:

- Source code, including variable names and string literals
- **All code comments**
- **Commit messages** (subject and body)
- Pull request titles and descriptions
- Issue titles and bodies
- File and directory names
- README, ARCHITECTURE, ROADMAP, and any other top-level docs

English-language documentation targeted at readers of the repo lives under `docs/` and **is** committed (cookbook, runbooks, subsystem guides). Chinese-language scratchpads — local design notes, meeting memos, translation drafts — live under `docs-cn/`, which is **git-ignored** (see `.gitignore`) and must never be committed.

Rationale: this is an open-source project targeting a global audience. Mixed-language repos fragment the reader base and confuse grep, so the committed tree stays English-only; `docs-cn/` exists to keep the local workflow useful without polluting the repo.

## Stack

- TypeScript, Bun runtime (matches upstream `agent-bridge`)
- MIT license
- Two-process topology: foreground MCP plugin + persistent daemon
- Peer adapters implement a common `IPeerAdapter` interface

## Architecture constraints — **enforced**

The `src/` tree is organized by runtime + domain, not by abstract
"layer number":

```
src/
  shared/          zero-dep utilities (state-dir, daemon-lifecycle, config-service, logger)
  messages/        shared value objects (BridgeMessage, ...)
  transport/       plugin <-> daemon control plane
  runtime-plugin/  code that runs inside the Claude Code MCP plugin
    claude-channel/    MCP channel adapter
    daemon-client/     client side of the control plane
    bridge.ts          plugin process entrypoint
  runtime-daemon/  code that runs inside the persistent daemon
    peers/             outbound peer adapters (codex, openclaw, hermes)
    inbound/           A2A server exposing Claude Code to external clients
    rooms/             RoomRouter
    tasks/             Task lifecycle + storage
    daemon.ts          daemon process entrypoint
  cli/             user-facing CLI; composition root for integration tests
```

Import tsconfig aliases — **prefer these over relative paths** when
crossing directory boundaries:

| Alias          | Maps to                |
|----------------|------------------------|
| `@shared/*`    | `src/shared/*`         |
| `@messages/*`  | `src/messages/*`       |
| `@transport/*` | `src/transport/*`      |
| `@plugin/*`    | `src/runtime-plugin/*` |
| `@daemon/*`    | `src/runtime-daemon/*` |

Dependency rules (checked by `bun run lint:deps`, enforced in CI):

- `shared/` and `messages/` stay pure — they cannot import from any
  other layer.
- `transport/` cannot reach into `runtime-plugin/`, `runtime-daemon/`,
  or `cli/`.
- `runtime-plugin/` and `runtime-daemon/` **cannot import each
  other**. They communicate only through `transport/` and
  `messages/`.
- Peer adapters (`runtime-daemon/peers/codex/`, `.../openclaw/`,
  `.../hermes/`) **cannot import each other**.
- `inbound/` and `peers/` cannot reach into each other's concrete
  implementations — the meeting point is `rooms/`.
- Production code cannot import from `*.test.ts`.
- Unreferenced ("orphan") modules trigger a warning so we clean them
  up.

Why these rules exist: the plugin and daemon run in separate
processes, possibly on separate machines. Code that forgets that
distinction creates runtime crashes, not just type errors. Similarly,
peer adapters must be independently swappable — cross-adapter imports
make it impossible to split them into plugins later.

When adding a file, ask: **which runtime does this run inside?** That
answer determines the directory; the rules enforce the rest.

## Git workflow

- All changes land on `dev`, never directly on `main`
- `git push origin dev`, then open a PR to merge into `main`
- Never force-push `main`
- Never commit secrets (tokens, private keys, `.env` files)

## Publishing rules — **iron law**

- **Never `npm publish` without explicit human confirmation.**
  Fix → verify locally → ask the maintainer to confirm on their
  machine → only then publish. Rushing a patch version costs more
  credibility than a slow fix.
- Before publishing, the maintainer must confirm: `a2a-bridge
  --version` shows the new version, `a2a-bridge daemon start`
  starts the daemon, and `a2a-bridge claude` loads the plugin.
- This rule overrides any urgency from the autonomous loop or
  Telegram requests. "发版" / "publish" is always a human gate.

## Autonomous-mode rules

Some work on this repo runs under `/loop` or a scheduled agent with
no human in the driver's seat for hours at a time. When operating in
that mode, the following files are **read-only** and must not be
edited by the loop:

- `CLAUDE.md`
- `docs/design/architecture.md`
- `docs/design/positioning.md`
- `docs/design/roadmap.md`
- `.dependency-cruiser.cjs`

If the loop encounters a task that appears to require changing any of
these, it must **stop, commit current progress, and notify the user
via Telegram** rather than modify them. Constraint changes are
design discussions, not autonomous edits.

The loop must also stop and notify when:

- `bun run check:ci` fails (typecheck, lint:deps, unit tests, or
  build) and the failure is not cleanly attributable to the task in
  hand.
- A dependency-cruiser rule would need to be relaxed to land the
  task.
- The task as described in `TASKS.md` is ambiguous or contradicts
  something in `docs/design/architecture.md` / `docs/design/positioning.md`.
- Any change would touch external accounts, secrets, infrastructure,
  or the `main` branch.

Per-iteration checklist the loop follows, top of file:

1. `git pull origin dev`.
2. Re-read `docs/design/architecture.md`, `docs/design/positioning.md`,
   `CLAUDE.md`, `docs/design/roadmap.md`, `TASKS.md`.
3. Pick the next unchecked atomic task from `TASKS.md`.
4. Implement it with the minimum diff.
5. Run `bun run check:ci`. On failure, debug the task or stop.
6. Commit with a descriptive message and the Co-Authored-By footer.
7. Push `dev`.
8. Mark the task as done in `TASKS.md`; commit and push.
9. Send a one-line Telegram update.
10. If the phase is complete, stop and wait for human ack before
    starting the next phase.

## References (read-only)

Upstream repos cloned under the parent workspace's `references/` directory:

- `references/agent-bridge` — the CC↔Codex prototype we are generalizing
- `references/claude-plugins-official` — Anthropic's official channel plugin examples (telegram, fakechat are the best references)
- `references/gemini-cli` — Gemini CLI source (A2A client consumer)
- `references/openclaw` — OpenClaw source (peer adapter target)
- `references/hermes-agent` — Hermes ACP source (peer adapter target)
