# a2a-bridge

[![CI](https://github.com/firstintent/a2a-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/firstintent/a2a-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://github.com/firstintent/a2a-bridge/blob/main/LICENSE)

**The missing bridge between AI coding agents.** Claude Code, Codex, OpenClaw, Hermes Agent, Gemini CLI, Zed, and VS Code agents can finally talk to each other — one daemon, star topology, every protocol translated. Install once, pick your agents, and they collaborate across [A2A](https://google.github.io/A2A/) and [ACP](https://agentclientprotocol.org/) without copy-paste, context loss, or model switching.

<table>
<tr><td><b>Any agent calls Claude Code</b></td><td>OpenClaw, Gemini CLI, Zed, VS Code, and Hermes Agent send prompts to a live Claude Code session through the bridge. Real reasoning, not echo — verified end-to-end across the public internet.</td></tr>
<tr><td><b>Claude Code calls other agents</b></td><td>Delegate tasks to Codex today. OpenClaw and Hermes outbound adapters ship in v0.2 — the star topology goes fully bidirectional.</td></tr>
<tr><td><b>Multi-protocol hub</b></td><td>A2A (HTTP + SSE), ACP (stdio JSON-RPC), MCP Channels — one adapter per agent, the daemon translates. Adding a new agent means writing one adapter; nothing else changes.</td></tr>
<tr><td><b>Multi-session isolation</b></td><td>RoomRouter + SQLite TaskLog. Concurrent sessions don't cross-talk; task state survives restarts.</td></tr>
<tr><td><b>First-run in 60 seconds</b></td><td><code>npm i -g a2a-bridge && a2a-bridge init && a2a-bridge claude</code> — bearer token minted, plugin installed, Claude Code listening.</td></tr>
<tr><td><b>Cross-host ready</b></td><td>Set <code>A2A_BRIDGE_CONTROL_HOST=0.0.0.0</code> and your ACP clients connect from anywhere. Daemon on a server, agents on laptops.</td></tr>
</table>

---

## Quick Install

```bash
npm i -g a2a-bridge
a2a-bridge --version    # a2a-bridge v0.1.0
```

> From source: `git clone https://github.com/firstintent/a2a-bridge.git && cd a2a-bridge && bun install && bun run build:plugin && npm pack && npm i -g ./a2a-bridge-*.tgz`

---

## Getting Started

### Server side (Claude Code)

```bash
a2a-bridge init           # mint token + install plugin
a2a-bridge claude         # launch CC with bridge plugin
```

Or headless in tmux (run bridge CC in background while your primary session works):

```bash
a2a-bridge daemon start
tmux new-session -d -s cc-bridge "a2a-bridge claude"
tmux send-keys -t cc-bridge Enter
```

> **AI-assisted:** tell Claude Code `Read https://raw.githubusercontent.com/firstintent/a2a-bridge/main/docs/join.md and follow it.` — it does everything above automatically.

### Client side (pick your agent)

| Agent | Config |
|-------|--------|
| **OpenClaw** | `acpx.config.agents` → `{ "a2a-bridge": { "command": "a2a-bridge", "args": ["acp"] } }` |
| **Zed** | `settings.json` → `{ "agent_servers": { "a2a-bridge": { "command": "a2a-bridge", "args": ["acp"] } } }` |
| **VS Code** | `{ "acp.agents": [{ "name": "a2a-bridge", "command": "a2a-bridge", "args": ["acp"] }] }` |
| **Hermes Agent** | Same ACP pattern as Zed / VS Code |
| **Gemini CLI** | `~/.gemini/settings.json` → `{ "remoteAgents": [{ "name": "a2a-bridge", "agentCardUrl": "http://localhost:4520/.well-known/agent-card.json", "auth": { "type": "bearer", "token": "<TOKEN>" } }] }` |

Cross-host (daemon on server, agent on laptop):

```bash
export A2A_BRIDGE_CONTROL_URL=ws://<server-ip>:4512/ws
export A2A_BRIDGE_ACP_SKIP_DAEMON=1
```

### Peer side (bidirectional)

```bash
a2a-bridge codex    # Claude Code ↔ Codex (requires codex on PATH)
```

OpenClaw / Hermes outbound peer adapters → v0.2.

---

## Architecture

Star topology — the daemon is the hub; every agent connects to it.

```
        Gemini CLI ─── A2A (HTTP) ───┐
                                     │
        OpenClaw ──── ACP (stdio) ───┤
                                     │
        Zed / VS Code ─ ACP (stdio) ─┤
                                     ▼
                              ┌─────────────┐
                              │  a2a-bridge  │
                              │    daemon    │
                              │ (RoomRouter) │
                              └──────┬───────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
               Claude Code       Codex          Hermes [v0.2]
                 server           peer              peer
```

| Agent | Role | Status |
|-------|------|--------|
| Claude Code | **server** — receives prompts | v0.1 |
| Codex | **peer** — CC delegates to it | v0.1 |
| OpenClaw, Zed, VS Code, Hermes, Gemini CLI | **client** — calls CC | v0.1 |
| OpenClaw, Hermes | **peer** — CC delegates to them | v0.2 |

Full protocol matrix + deployment shapes: [`docs/design/architecture.md`](./docs/design/architecture.md)

---

## Docs

| | |
|---|---|
| [Architecture](./docs/design/architecture.md) | Protocol matrix, adapter contract, deployment shapes |
| [Positioning](./docs/design/positioning.md) | When multi-agent helps vs. hurts |
| [Roadmap](./docs/design/roadmap.md) | Phased plan, v0.2 backlog |
| [Cookbook](./docs/guides/cookbook.md) | Verification, context-protection, parallel patterns with examples |
| [Rooms](./docs/guides/rooms.md) | Session isolation, RoomId, restart semantics |
| [Join Skill](./docs/join.md) | Self-install skill — hand it to any AI |
| [Release Runbook](./docs/release/publish.md) | npm publish, marketplace, ACP registry |

---

## Troubleshooting

```bash
a2a-bridge doctor             # preflight checklist
a2a-bridge daemon logs        # recent daemon activity
```

Common fixes: [see the env var reference below](#environment-variables).

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `A2A_BRIDGE_BEARER_TOKEN` | from init | A2A HTTP auth |
| `A2A_BRIDGE_A2A_PORT` | `4520` | A2A listener |
| `A2A_BRIDGE_CONTROL_PORT` | `4512` | Daemon control plane |
| `A2A_BRIDGE_CONTROL_HOST` | `127.0.0.1` | Control plane bind (`0.0.0.0` for remote) |
| `A2A_BRIDGE_CONTROL_URL` | auto | Full WS URL for ACP subprocess |
| `A2A_BRIDGE_ACP_SKIP_DAEMON` | unset | Skip daemon auto-start in `acp` |
| `A2A_BRIDGE_STATE_DIR` | `~/.local/state/a2a-bridge` | Config, logs, task DB |

---

## License

MIT. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
