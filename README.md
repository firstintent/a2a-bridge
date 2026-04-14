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

## Quick start

```bash
# 1. Install
npm i -g a2a-bridge          # or: npm i -g ./a2a-bridge-*.tgz from source
a2a-bridge --version          # a2a-bridge v0.1.0

# 2. Configure
a2a-bridge init               # mint bearer token + install channel plugin
a2a-bridge doctor             # preflight checklist

# 3. Start the daemon
a2a-bridge daemon start
a2a-bridge daemon status      # confirm pid + ports
```

Requires Bun >= 1.3 on `PATH` (`a2a-bridge doctor` confirms).

From source:

```bash
git clone https://github.com/firstintent/a2a-bridge.git
cd a2a-bridge && bun install && bun run build:plugin
npm pack && npm i -g ./a2a-bridge-*.tgz
```

## Connect your agents

### Claude Code (CC side)

Claude Code is the brain of the bridge. Two deployment modes:

**Interactive** — start a Claude Code session with the plugin loaded:

```bash
a2a-bridge claude
```

All inbound prompts arrive as channel messages; CC reasons about them
and replies via the built-in `reply` tool.

**Tmux (headless)** — spawn a second CC from an existing session:

```bash
a2a-bridge dev                                            # register plugin (first time)
A2A_BRIDGE_CONTROL_HOST=0.0.0.0 a2a-bridge daemon start  # expose to network
tmux new-session -d -s cc-bridge "a2a-bridge claude"      # headless CC
tmux send-keys -t cc-bridge Enter                         # approve dev channels
```

Your primary session keeps working; the tmux CC serves bridge
traffic in the background. Use `tmux attach -t cc-bridge` to inspect.

### Gemini CLI (A2A over HTTP)

Add to `~/.gemini/settings.json`:

```json
{
  "remoteAgents": [{
    "name": "a2a-bridge",
    "agentCardUrl": "http://localhost:4520/.well-known/agent-card.json",
    "auth": { "type": "bearer", "token": "<TOKEN_FROM_INIT>" }
  }]
}
```

Restart Gemini CLI; `@a2a-bridge` routes prompts to Claude Code.

### OpenClaw (ACP over stdio)

Add to `acpx.config.agents`:

```json
{ "agents": { "a2a-bridge": { "command": "a2a-bridge", "args": ["acp"] } } }
```

No bearer token needed. For cross-host (daemon on a remote server):

```bash
export A2A_BRIDGE_CONTROL_URL=ws://<server-ip>:4512/ws
export A2A_BRIDGE_ACP_SKIP_DAEMON=1
```

### Zed (ACP)

Add to Zed `settings.json`:

```json
{ "agent_servers": { "a2a-bridge": { "command": "a2a-bridge", "args": ["acp"] } } }
```

### VS Code (ACP)

Any VS Code ACP extension:

```json
{ "acp.agents": [{ "name": "a2a-bridge", "command": "a2a-bridge", "args": ["acp"] }] }
```

### Hermes Agent (ACP)

Same ACP pattern as Zed / VS Code above. Hermes-as-peer (Claude Code
calling Hermes) ships in v0.2 via a dedicated `HermesAdapter`.

### Codex (peer adapter)

Claude Code can delegate tasks to Codex:

```bash
a2a-bridge codex    # starts Codex TUI + app-server proxy
```

Requires `codex` on `PATH`. Once the TUI creates a thread, messages
flow bidirectionally between Claude Code and Codex.

## Join the bridge (self-install skill)

Hand this URL to **both** AIs and each self-installs its side:

```
Read https://raw.githubusercontent.com/firstintent/a2a-bridge/main/docs/join.md and follow it.
```

Works for Claude Code, OpenClaw, Zed, and VS Code — step 0 detects
the host and branches. Full text: [`docs/join.md`](./docs/join.md).

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
