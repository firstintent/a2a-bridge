# a2a-bridge

[![CI](https://github.com/firstintent/a2a-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/firstintent/a2a-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://github.com/firstintent/a2a-bridge/blob/main/LICENSE)

<h3 align="center"><b>The bridge between AI agents.</b></h3> Claude Code, Codex, OpenClaw, Hermes Agent, Gemini CLI, Zed, and VS Code agents can finally talk to each other — one daemon, star topology, every protocol translated. Install once, pick your agents, and they collaborate across [A2A](https://google.github.io/A2A/) and [ACP](https://agentclientprotocol.org/) without copy-paste, context loss, or model switching.

<table>
<tr><td><b>Any agent calls Claude Code</b></td><td>OpenClaw, Gemini CLI, Zed, VS Code, and Hermes Agent send prompts to a live Claude Code session through the bridge. Real reasoning, not echo — verified end-to-end across the public internet.</td></tr>
<tr><td><b>Claude Code calls other agents</b></td><td>Delegate tasks to Codex today. OpenClaw and Hermes outbound adapters ship in v0.2 — the star topology goes fully bidirectional.</td></tr>
<tr><td><b>Multi-protocol hub</b></td><td>A2A (HTTP + SSE), ACP (stdio JSON-RPC), MCP Channels — one adapter per agent, the daemon translates. Adding a new agent means writing one adapter; nothing else changes.</td></tr>
<tr><td><b>Multi-session isolation</b></td><td>RoomRouter + SQLite TaskLog. Concurrent sessions don't cross-talk; task state survives restarts.</td></tr>
<tr><td><b>First-run in 60 seconds</b></td><td><code>npm i -g a2a-bridge && a2a-bridge init && a2a-bridge claude</code> — bearer token minted, plugin installed, Claude Code listening.</td></tr>
<tr><td><b>Cross-host ready</b></td><td>Set <code>A2A_BRIDGE_CONTROL_HOST=0.0.0.0</code> and your ACP clients connect from anywhere. Daemon on a server, agents on laptops.</td></tr>
</table>

---

## Quick Start — Claude Code + OpenClaw in 5 minutes

Both sides install the same package. The difference is what you run
after install.

**Step 1 — On the Claude Code machine** (the server that answers prompts):

```bash
curl -fsSL https://raw.githubusercontent.com/firstintent/a2a-bridge/main/scripts/install.sh | bash
```

The script checks prerequisites (bun, npm, claude), installs
a2a-bridge globally, and runs `a2a-bridge init`. Then start:

```bash
a2a-bridge claude                   # launch Claude Code with bridge
```

Claude Code is now listening. Note your machine's IP — the client
in Step 2 needs it to connect (`localhost` if both on the same box).

**Step 2 — On the OpenClaw / Hermes Agent machine** (the client that sends prompts):

Recommended — tell the agent:

```
Read https://raw.githubusercontent.com/firstintent/a2a-bridge/main/docs/join.md and follow it.
The Claude Code server is at <server-ip>:4512.
```

Replace `<server-ip>` with the IP from Step 1 (or skip that line if
both sides are on the same machine). The agent installs a2a-bridge,
sets `A2A_BRIDGE_CONTROL_URL`, registers itself, and smoke-tests
the connection. Full text: [`docs/join.md`](./docs/join.md)

<details>
<summary><b>Manual setup</b></summary>

```bash
npm i -g a2a-bridge                 # same package, same install
```

Add to `acpx.config.agents` (OpenClaw) or your agent's config:

```json
{ "agents": { "a2a-bridge": { "command": "a2a-bridge", "args": ["acp"] } } }
```

</details>

Send a prompt through the agent — it reaches Claude Code through the
bridge, Claude Code reasons about it, and the reply streams back.

**Same machine?** Both sides run on one box, no extra config.
**Different machines?** Two env vars:

```bash
# on the server (Claude Code side)
export A2A_BRIDGE_CONTROL_HOST=0.0.0.0

# on the client (OpenClaw / Hermes side)
export A2A_BRIDGE_CONTROL_URL=ws://<server-ip>:4512/ws
```

<details>
<summary><b>Install from source</b></summary>

```bash
git clone https://github.com/firstintent/a2a-bridge.git
cd a2a-bridge
bun install && bun run build:plugin
npm pack && npm i -g ./a2a-bridge-*.tgz
```

</details>

---

## Connect other agents

The same bridge works for every A2A / ACP agent — just swap the
client config:

| Agent | Protocol | Config |
|-------|----------|--------|
| **OpenClaw** | ACP | `openclaw.json` → add `"a2a-bridge"` to `acp.allowedAgents` + register `plugins.entries.acpx.config.agents["a2a-bridge"].command = "a2a-bridge acp"`, then `/acp spawn a2a-bridge` |
| **OpenClaw (remote)** | ACP | same + `"command": "a2a-bridge acp --url ws://<ip>:4512/ws"` |
| **OpenClaw (multi-CC)** | ACP | one `agents` entry per target: `"bridge-proj-a": { "command": "a2a-bridge acp --target claude:proj-a" }` (see [multi-target routing](./docs/design/multi-target-routing.md)) |
| **Hermes Agent** | ACP | Same pattern as OpenClaw |
| **Zed** | ACP | `settings.json` → `{ "agent_servers": { "a2a-bridge": { "command": "a2a-bridge", "args": ["acp"] } } }` |
| **VS Code** | ACP | `{ "acp.agents": [{ "name": "a2a-bridge", "command": "a2a-bridge", "args": ["acp"] }] }` |
| **Gemini CLI** | A2A | `~/.gemini/settings.json` → `{ "remoteAgents": [{ "agentCardUrl": "http://localhost:4520/...", "auth": { "token": "<TOKEN>" } }] }` |
| **Codex** | peer | `a2a-bridge codex` — Claude Code ↔ Codex bidirectional |

### Headless server (tmux)

Run the bridge CC in background while your primary Claude Code
session works on something else:

```bash
a2a-bridge daemon start
tmux new-session -d -s cc-bridge "a2a-bridge claude"
tmux send-keys -t cc-bridge Enter
```

### Multi-workspace routing (v0.2)

One daemon can front multiple Claude Code sessions at once.  Each
session attaches under a `kind:id` **TargetId** (e.g. `claude:proj-a`,
`claude:proj-b`), and ACP / A2A callers pick which session they want:

```bash
# Terminal 1 — two Claude Code sessions, one daemon
A2A_BRIDGE_STATE_DIR=~/.config/a2a-bridge/proj-a a2a-bridge claude
A2A_BRIDGE_STATE_DIR=~/.config/a2a-bridge/proj-b a2a-bridge claude
# → attach as claude:proj-a and claude:proj-b respectively

# Terminal 3 — inspect
a2a-bridge daemon targets
# TARGET            ATTACHED  CLIENT  UPTIME
# claude:proj-a     yes       3       2m
# claude:proj-b     yes       5       1m
```

ACP callers route with `--target`:

```bash
a2a-bridge acp --target claude:proj-a -p "review this branch"
```

OpenClaw registers one `acpx` agent entry per target:

```json
{ "plugins": { "entries": { "acpx": { "config": { "agents": {
  "bridge-proj-a": { "command": "a2a-bridge acp --target claude:proj-a" },
  "bridge-proj-b": { "command": "a2a-bridge acp --target claude:proj-b" }
}}}}}}
```

A2A HTTP callers route via `contextId → TargetId` config
(`A2A_BRIDGE_CONTEXT_ROUTES` env var, see below).

A second CC attaching to an already-claimed TargetId is **rejected**
with a descriptive error. Rerun with `a2a-bridge claude --force` to
kick the old attach and take over — the previous session gets a
CC-visible notification that it was replaced.

Full design + deployment shapes:
[`docs/design/multi-target-routing.md`](./docs/design/multi-target-routing.md).
v0.2 ships with the multi-claude axis; codex multi-instance lands
in v0.3.

---

## Architecture

Star topology — the daemon is the hub; every agent connects to it.

```
          Gemini CLI        OpenClaw        Zed        VS Code       Hermes Agent
              │                │             │            │               │
              │ A2A            │ ACP         │ ACP       │ ACP          │ ACP
              ▼                ▼             ▼            ▼               ▼
        ┌─────────────────────────────────────────────────────────────────────┐
        │                        a2a-bridge daemon                           │
        │                         (RoomRouter)                               │
        └──────────────┬──────────────────┬──────────────────┬───────────────┘
                       │                  │                  │
                       ▼                  ▼                  ▼
                  Claude Code          Codex           Hermes [v0.2]
                  (CC plugin)       (WS JSON-RPC)     (ACP adapter)
                    server             peer               peer
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
| `A2A_BRIDGE_ACP_ENSURE_DAEMON` | unset | Opt-in: auto-start daemon in `acp` (off by default) |
| `A2A_BRIDGE_STATE_DIR` | `~/.local/state/a2a-bridge` | Config, logs, task DB (basename also seeds the CC TargetId) |
| `A2A_BRIDGE_WORKSPACE_ID` | (derived) | Explicit override for this CC's id (wins over `STATE_DIR` basename) |
| `A2A_BRIDGE_FORCE_ATTACH` | unset | When `1`, `a2a-bridge claude` kicks an attached CC on the same TargetId (equivalent to `--force`) |
| `A2A_BRIDGE_CONTEXT_ROUTES` | unset | JSON map `{"ctx-id": "claude:workspace"}` for A2A `contextId → TargetId` routing; unmapped contexts fall back to `claude:default` |

---

## License

MIT. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
