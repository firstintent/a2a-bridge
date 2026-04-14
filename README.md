# a2a-bridge

[![CI](https://github.com/firstintent/a2a-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/firstintent/a2a-bridge/actions/workflows/ci.yml)

Connect Claude Code with other AI coding agents. OpenClaw, Gemini
CLI, Zed, VS Code, Codex, Hermes — each speaks its own protocol;
a2a-bridge translates so they can call Claude Code (and each other)
without anyone switching tools.

## Example scenarios

a2a-bridge is plumbing, not a prescription. Use it when multi-agent
collaboration actually helps:

- **Verification** — ask a second agent to review your primary
  agent's output against explicit criteria. The one pattern that
  consistently justifies the extra tokens.
- **Context protection** — a subtask would dump 1000+ tokens of logs
  into the main session. Push it to a peer; take the summary back.
- **Parallel work** — truly independent subtasks (separate files,
  separate investigations) run concurrently on different agents and
  merge at the end.
- **Cross-tool access** — you need Codex's CLI skills or OpenClaw's
  orchestration without leaving your Claude Code session.

**Skip it** when the task is sequential, when the "multi-agent" split
is by job title (planner / implementer / reviewer), or when token
cost matters more than the collaboration benefit. Multi-agent chains
typically consume 3-10x more tokens than a single well-prompted
agent.

## Set up the server side (Claude Code)

The **server** is the Claude Code session that other agents call
into. Install a2a-bridge, start the daemon, then launch Claude Code
with the bridge plugin.

> **AI-assisted:** tell Claude Code
> `Read https://raw.githubusercontent.com/firstintent/a2a-bridge/main/docs/join.md and follow it.`
> — it runs everything below automatically.

### 1. Install

```bash
npm i -g a2a-bridge            # or: npm i -g ./a2a-bridge-*.tgz from source
a2a-bridge --version           # a2a-bridge v0.1.0
```

Requires Bun >= 1.3 on `PATH`. From source:

```bash
git clone https://github.com/firstintent/a2a-bridge.git
cd a2a-bridge && bun install && bun run build:plugin
npm pack && npm i -g ./a2a-bridge-*.tgz
```

### 2. Configure + start daemon

```bash
a2a-bridge init                # mint bearer token + install plugin
a2a-bridge doctor              # preflight checklist
a2a-bridge daemon start        # start background daemon
a2a-bridge daemon status       # confirm pid + ports
```

### 3. Launch Claude Code

**Interactive** — Claude Code with the bridge plugin loaded:

```bash
a2a-bridge claude
```

Inbound prompts arrive as channel messages; CC reasons and replies
via the `reply` tool.

**Tmux (headless)** — run the bridge CC in the background while
your primary session keeps working:

```bash
a2a-bridge dev                                            # register plugin (first time)
A2A_BRIDGE_CONTROL_HOST=0.0.0.0 a2a-bridge daemon start  # expose to network
tmux new-session -d -s cc-bridge "a2a-bridge claude"      # headless bridge CC
tmux send-keys -t cc-bridge Enter                         # approve dev channels
```

Inspect with `tmux attach -t cc-bridge`. Set
`A2A_BRIDGE_CONTROL_HOST=0.0.0.0` when clients connect from another
machine.

## Set up a client (call Claude Code)

A **client** is any agent that sends prompts to Claude Code through
the bridge. Clients speak one of two protocols:

- **ACP** (stdio) — OpenClaw, Zed, VS Code, Hermes. The client
  spawns `a2a-bridge acp` as a subprocess; no HTTP port or bearer
  token needed.
- **A2A** (HTTP) — Gemini CLI and other A2A-speaking agents. They
  call the daemon's JSON-RPC endpoint with a bearer token.

> **AI-assisted setup:** tell your ACP client
> `Read https://raw.githubusercontent.com/firstintent/a2a-bridge/main/docs/join.md and follow it.`
> — it detects which agent it is and self-configures. Skip the
> manual steps below if you prefer the one-liner.

### OpenClaw (ACP)

```json
{ "agents": { "a2a-bridge": { "command": "a2a-bridge", "args": ["acp"] } } }
```

Cross-host (daemon on a different machine):

```bash
export A2A_BRIDGE_CONTROL_URL=ws://<server-ip>:4512/ws
export A2A_BRIDGE_ACP_SKIP_DAEMON=1
```

### Zed (ACP)

```json
{ "agent_servers": { "a2a-bridge": { "command": "a2a-bridge", "args": ["acp"] } } }
```

### VS Code (ACP)

```json
{ "acp.agents": [{ "name": "a2a-bridge", "command": "a2a-bridge", "args": ["acp"] }] }
```

### Hermes Agent (ACP)

Same pattern as Zed / VS Code. Hermes-as-peer (Claude Code calling
Hermes) ships in v0.2 via a dedicated `HermesAdapter`.

### Gemini CLI (A2A)

```json
{
  "remoteAgents": [{
    "name": "a2a-bridge",
    "agentCardUrl": "http://localhost:4520/.well-known/agent-card.json",
    "auth": { "type": "bearer", "token": "<TOKEN_FROM_INIT>" }
  }]
}
```

Add to `~/.gemini/settings.json`. Restart Gemini CLI;
`@a2a-bridge` routes prompts to Claude Code.

## Set up a peer (bidirectional)

A **peer** is an agent that Claude Code can delegate tasks *to* —
the bridge carries messages in both directions.

### Codex

```bash
a2a-bridge codex    # starts Codex TUI + app-server proxy
```

Requires `codex` on `PATH`. Once the TUI creates a thread, Claude
Code and Codex exchange messages bidirectionally.

### OpenClaw / Hermes (outbound)

Outbound peer adapters (Claude Code → OpenClaw, Claude Code →
Hermes) ship in v0.2. Today these agents connect as **clients**
(calling Claude Code); v0.2 adds adapters for the reverse
direction.

## Advanced

### Skill templates

Copy-paste prompt scaffolds for the patterns a2a-bridge is built for:

- [`skills/verify/SKILL.md`](./skills/verify/SKILL.md) — structured
  pass/fail/needs-info verdict from a peer.
- [`skills/context-protect/SKILL.md`](./skills/context-protect/SKILL.md) —
  push long digs to a peer with `return_format: "summary"`.
- [`skills/parallel/SKILL.md`](./skills/parallel/SKILL.md) — spawn N
  peers on independent subtasks and merge.

Runnable `curl` + SDK examples:
[`docs/guides/cookbook.md`](./docs/guides/cookbook.md).

### Troubleshooting

`a2a-bridge doctor` surfaces most issues. When a subcommand prints
`error: / fix:`, the fix line names the exact command to run. Common
failures:

- **Port in use** — `A2A_BRIDGE_A2A_PORT=<free port>` before daemon
  start.
- **No bearer token** — run `a2a-bridge init`.
- **Plugin not installed** — run `a2a-bridge init` or `a2a-bridge dev`.
- **ACP SDK missing** — `bun install` in the project root.

Full logs: `a2a-bridge daemon logs --tail 200`.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `A2A_BRIDGE_BEARER_TOKEN` | (from init) | A2A HTTP endpoint auth |
| `A2A_BRIDGE_A2A_PORT` | `4520` | A2A listener port |
| `A2A_BRIDGE_CONTROL_PORT` | `4512` | Daemon control plane port |
| `A2A_BRIDGE_CONTROL_HOST` | `127.0.0.1` | Control plane bind address (`0.0.0.0` for remote) |
| `A2A_BRIDGE_CONTROL_URL` | auto | Full WS URL for ACP subprocess (`ws://host:port/ws`) |
| `A2A_BRIDGE_ACP_SKIP_DAEMON` | unset | Skip daemon auto-start in `a2a-bridge acp` |
| `A2A_BRIDGE_STATE_DIR` | `~/.local/state/a2a-bridge` | Config, logs, task DB |

## Architecture

```
┌──────────────┐   MCP stdio (channel)   ┌──────────────────┐   control WS   ┌──────────────┐
│ Claude Code  │ ◀────────────────────▶  │ a2a-bridge plugin │ ◀────────────▶ │   daemon     │
└──────────────┘                         └──────────────────┘                └──────┬───────┘
                                                                                    │
                                                               ┌────────────────────┼────────────────────┐
                                                               ▼                    ▼                    ▼
                                                        InboundService        CodexAdapter       OpenClaw / Hermes
                                                        (A2A + ACP)           (WS JSON-RPC)      (v0.2)
```

- **Plugin** — Claude Code MCP channel plugin. Pushes inbound
  messages as `<channel>` tags; exposes `reply` + `get_messages`
  tools.
- **Daemon** — background process owning peer adapters, A2A/ACP
  inbound services, room router, and SQLite task log.
- **Peer adapters** — one `IPeerAdapter` per target agent. Uniform
  interface (`start`, `injectMessage`, events).
- **InboundService** — A2A (HTTP/SSE) + ACP (stdio) servers so
  external clients can drive Claude Code.

Protocol matrix, deployment shapes, and the full adapter contract:
[`docs/design/architecture.md`](./docs/design/architecture.md).
Session isolation and restart semantics:
[`docs/guides/rooms.md`](./docs/guides/rooms.md).

## Releasing

Maintainers follow [`docs/release/publish.md`](./docs/release/publish.md).
Pre-release gate:

```bash
bash scripts/check-release-ready.sh
```

## License

MIT. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
