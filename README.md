# a2a-bridge

[![CI](https://github.com/firstintent/a2a-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/firstintent/a2a-bridge/actions/workflows/ci.yml)

Protocol-level plumbing that lets Claude Code be **called by** any
Agent2Agent (A2A) client and that lets Claude Code **call out to**
other AI coding agents — Codex, OpenClaw, Hermes — through a uniform
adapter interface.

Built on Anthropic's Claude Code Channels protocol. Inspired by
[`raysonmeng/agent-bridge`](https://github.com/raysonmeng/agent-bridge),
generalized with a proper port/adapter split, A2A inbound, and
multi-machine deployment.

## Status

Early development. See [`docs/design/roadmap.md`](./docs/design/roadmap.md)
for the phased plan;
see [`docs/design/positioning.md`](./docs/design/positioning.md) for
the design principles.

## When to use

a2a-bridge is plumbing, not a prescription. Reach for it only when
multi-agent collaboration is the right call:

- **Verification.** You want a second agent to check your primary
  agent's work against explicit criteria. This is the one pattern
  Anthropic's own research flags as consistently worth the extra
  tokens.
- **Context protection.** A subtask would otherwise pollute the main
  session with 1000+ tokens of irrelevant output (long log digs,
  codebase audits, transcript analysis). Push it to a peer; take the
  summary back.
- **Parallel independent work.** Truly independent subtasks (separate
  components, separate investigations) can run concurrently on
  different agents and merge at the end.
- **Cross-tool access.** You need to use a capability only one agent
  has (Codex's CLI skills, OpenClaw's orchestration, Hermes'
  reasoning) without switching your working environment.

## When NOT to use

- The task is sequential and dependent. A single well-prompted agent
  is simpler and cheaper.
- The "multi-agent" split is by job title (planner / implementer /
  tester / reviewer). This pattern loses fidelity through repeated
  handoffs and almost always underperforms a single agent with the
  same tools.
- You're only trying to "try more models." Model-switching inside a
  single agent context usually beats spawning a second agent.
- The token cost matters. Multi-agent chains typically consume
  3–10× more tokens than the equivalent single-agent workflow. Only
  pay that cost when one of the above benefits justifies it.

## Architecture (high-level)

```
┌──────────────┐   MCP stdio (channel)   ┌──────────────────┐   control WS (TLS)   ┌──────────────┐
│ Claude Code  │ ◀────────────────────▶  │ a2a-bridge plugin │ ◀──────────────────▶ │   daemon     │
└──────────────┘                         └──────────────────┘                      └──────┬───────┘
                                                                                          │
                                                                 ┌────────────────────────┼────────────────────────┐
                                                                 ▼                        ▼                        ▼
                                                          InboundService            CodexAdapter          OpenClawAdapter / HermesAdapter
                                                          (A2A server,              (WS JSON-RPC)         (WS + Ed25519 / stdio ACP)
                                                           JSON-RPC + SSE)
```

- **Plugin** (foreground): a Claude Code MCP channel plugin. Injects
  inbound peer messages as `<channel>` tags; exposes outbound tools
  (`reply`, `cancel_turn`, `switch_peer`, ...).
- **Daemon** (background, optionally remote): owns the
  `IPeerAdapter` instances, hosts the InboundService A2A server,
  authenticates plugin clients, persists per-room task logs.
- **Peer adapters**: uniform interface (`start`, `injectMessage`,
  events `ready` / `agentMessage` / `turnStarted` / `turnCompleted` /
  ...). One implementation per target agent.
- **InboundService**: HTTPS + SSE A2A server so any A2A client
  (Gemini CLI today, any A2A peer tomorrow) can drive Claude Code
  remotely.

See [`docs/design/architecture.md`](./docs/design/architecture.md) for the protocol matrix,
the minimum A2A server surface, and the three deployment shapes.

## Supported peers (planned)

| Peer      | Transport              | Status  |
|-----------|------------------------|---------|
| Codex     | WebSocket JSON-RPC     | Phase 1 |
| *any A2A* | HTTPS + SSE (inbound)  | Phase 2 |
| OpenClaw  | WebSocket + Ed25519    | Phase 5 |
| Hermes    | stdio (Zed ACP)        | Phase 6 |

## Install (npm)

a2a-bridge ships as a single global CLI, `a2a-bridge` (with a short
alias `abg`). Both names are installed together:

```bash
npm i -g a2a-bridge
a2a-bridge --version
```

Requires Bun >= 1.3 on `PATH` (`a2a-bridge doctor` confirms).

For contributors working from source:

```bash
git clone https://github.com/firstintent/a2a-bridge.git
cd a2a-bridge
bun install
bun run build:plugin
npm pack                            # produces a2a-bridge-<version>.tgz
npm i -g ./a2a-bridge-*.tgz         # install the local tarball
```

`bun run check:ci` runs the full test suite, lint:deps, build, and
plugin-manifest check before you cut a tarball.

## Configure (init + doctor)

Two subcommands get a fresh machine ready in under a minute:

```bash
a2a-bridge init       # mint a 32-byte bearer token + write config.json
a2a-bridge doctor     # preflight checklist (bun, ports, SDK, plugin, state-dir)
```

`init` is idempotent — re-running prints the existing config without
rotating the token. Pass `--force` when you want a fresh token. The
command also emits copy-pasteable Gemini CLI, OpenClaw, and Zed
snippets keyed to the token it just wrote.

`doctor` exits non-zero when any required check fails (bun missing
or too old, ACP SDK missing, state-dir unwritable) and prints
PASS / WARN / FAIL lines for the advisory checks (port in use, CC
plugin discoverable, `init` already run).

After both pass, start the daemon:

```bash
a2a-bridge daemon start
a2a-bridge daemon status
a2a-bridge daemon logs --tail 50
a2a-bridge daemon stop
```

## Connect Gemini CLI

Any A2A client can drive Claude Code through a2a-bridge. For Gemini
CLI specifically, add a single `remoteAgents` entry pointing at the
daemon's agent-card URL and the bearer token it was started with.
In `~/.gemini/settings.json`:

```json
{
  "remoteAgents": [
    {
      "name": "a2a-bridge",
      "agentCardUrl": "http://localhost:4520/.well-known/agent-card.json",
      "auth": {
        "type": "bearer",
        "token": "<A2A_BRIDGE_BEARER_TOKEN>"
      }
    }
  ]
}
```

- Replace `<A2A_BRIDGE_BEARER_TOKEN>` with the token `a2a-bridge init`
  printed; it protects the JSON-RPC endpoint. The agent-card endpoint
  can be served publicly via `publicAgentCard: true` so discovery
  works before the token is wired client-side.
- `localhost:4520` matches the daemon's A2A listener default; swap
  the host/port when the daemon runs on a different machine.

After restarting Gemini CLI, `@a2a-bridge` in a prompt routes the
message to the paired Claude Code session; the streamed reply comes
back as A2A `artifact-update` events.

## Connect OpenClaw

OpenClaw speaks the Agent Client Protocol (ACP) over stdio. Register
`a2a-bridge acp` as an agent command in `acpx.config.agents`:

```json
{
  "agents": {
    "a2a-bridge": {
      "command": "a2a-bridge",
      "args": ["acp"],
      "description": "Claude Code via a2a-bridge (ACP over stdio)"
    }
  }
}
```

The subcommand binds `process.stdin` / `process.stdout`; no ports are
opened and no bearer token is required. Every turn is relayed through
the a2a-bridge daemon to the attached Claude Code session via
`DaemonProxyGateway`. When the daemon is unreachable the subcommand
exits non-zero with a friendly `error: / fix:` block instead of
returning a silent echo.

## Connect Zed

Zed reads the same ACP shape under `agent_servers` in its
`settings.json`:

```json
{
  "agent_servers": {
    "a2a-bridge": {
      "command": "a2a-bridge",
      "args": ["acp"]
    }
  }
}
```

Restart Zed; the new agent appears in the agent picker. As with
OpenClaw, each prompt reaches the real Claude Code session through
the daemon — the subcommand does not fall back to an in-process echo.

## Connect VS Code

Any VS Code extension that accepts a `command` + `args` pair for an
external ACP agent uses the same shape:

```json
{
  "acp.agents": [
    {
      "name": "a2a-bridge",
      "command": "a2a-bridge",
      "args": ["acp"]
    }
  ]
}
```

Each extension's exact settings key may differ as plugins evolve —
the constants are always `command: "a2a-bridge"` and `args: ["acp"]`.

## Troubleshooting

`a2a-bridge doctor` surfaces most misconfigurations before they bite.
When a subcommand prints an `error: / fix:` block, the fix line names
the exact command or environment variable to try next. The common
failures:

- **Port 4520 already in use** — another process is listening on the
  default A2A port. Stop it, or export `A2A_BRIDGE_A2A_PORT=<free
  port>` before `a2a-bridge daemon start` and update the Gemini CLI
  snippet to match.
- **No bearer token configured** — the A2A inbound endpoint cannot
  authenticate callers. Run `a2a-bridge init` to mint one, or export
  `A2A_BRIDGE_BEARER_TOKEN` in the daemon's environment.
- **Claude Code channel plugin not installed** — Claude Code cannot
  reach the daemon. Run `a2a-bridge init` (or `a2a-bridge dev` when
  working from a source checkout) to install it.
- **`@agentclientprotocol/sdk` missing** — the ACP inbound service
  cannot boot. Run `bun install` in the project root to fetch the
  SDK from npm.
- **State-dir unwritable** — the daemon cannot persist its pid file,
  task log, or status.json. `doctor` flags this as a required fail;
  set `A2A_BRIDGE_STATE_DIR=<writable path>` before retrying.

For more involved issues (stuck turns, crashed peers, plugin-daemon
disconnects), `a2a-bridge daemon logs --tail 200` shows the most
recent daemon activity.

## Skill templates

Copy-pasteable prompt scaffolds for the multi-agent patterns a2a-bridge
is designed for. Each skill documents when to use it, the wire protocol,
and a worked example.

- [`skills/verify/SKILL.md`](./skills/verify/SKILL.md) — delegate a
  check to a peer agent and receive a structured pass/fail/needs-info
  verdict instead of free-form text.
- [`skills/context-protect/SKILL.md`](./skills/context-protect/SKILL.md) —
  push a long log dig, audit, or transcript analysis to a peer with
  `return_format: "summary"` and keep the primary session's context
  focused on the conclusion.
- [`skills/parallel/SKILL.md`](./skills/parallel/SKILL.md) — spawn N
  peers on genuinely independent subtasks (different files, modules,
  or investigations), await all of them, and merge.

For end-to-end runnable `curl` + SDK examples of all three patterns
(plus a rough token-cost reference), see
[`docs/guides/cookbook.md`](./docs/guides/cookbook.md). For how the daemon isolates
concurrent sessions and what survives a restart, see
[`docs/guides/rooms.md`](./docs/guides/rooms.md).

## Releasing

Maintainers cutting a release follow
[`docs/release/publish.md`](./docs/release/publish.md) — the
11-step runbook covering bump check → CHANGELOG → tag push →
`release.yml` → manual `npm publish --otp` → marketplace form →
ACP registry PR → post-release smoke.

Before opening the tag, run the pre-release gate:

```bash
bash scripts/check-release-ready.sh
```

It asserts version alignment across all manifests, that
`CHANGELOG.md` has an entry for the current version, that
`bun run check:ci` is green, and that every artifact under
`release/` and `docs/release/` the runbook needs is present.
Exits non-zero on any failure.

## License

MIT. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
