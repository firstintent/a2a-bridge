# Multi-target routing

Status: **implemented in v0.2.0** (multi-claude axis). Codex peer-id
routing (`a2a-bridge codex --id <id>`) is deferred to v0.3 — it needs
a daemon-internal refactor (per-id peer adapter registry + port
allocation) that did not fit the v0.2 minimum-diff window. v0.2 ships
with multi-claude routing end-to-end; codex stays `codex:default`.

v0.1 daemon attaches exactly one Claude Code session and knows about
exactly one Codex peer. v0.2 generalises this into a single daemon
that fronts multiple agent instances — multiple Claude Code
workspaces, and (post-v0.3) multiple Codex / Hermes peers — and
routes each inbound request to the correct target.

## Core model

Every agent instance has a **TargetId** — a `kind:id` tuple.

- `kind ∈ {claude, codex, hermes, openclaw, ...}` — the agent family.
- `id` — the instance identifier within that family (workspace name,
  session label, whatever disambiguates it).
- There is no "bare kind" — every target has an explicit id. When
  the user omits it, the system uses `default`.

Examples:

| TargetId | Meaning |
|----------|---------|
| `claude:project-a` | Claude Code session for project-a |
| `claude:project-b` | Claude Code session for project-b |
| `codex:dev` | Codex TUI bound to the dev workspace |
| `codex:prod` | Codex TUI bound to the prod workspace |
| `hermes:default` | Single Hermes instance |

The daemon maintains a `Map<TargetId, Room>` where each Room owns
its attached agent, a private message buffer, and a filtered view
of the SQLite TaskLog.

## Who supplies which id

| Role | How the id is set |
|------|-------------------|
| Attached CC (server) | Plugin sends workspace id on `claude_connect`, derived from `A2A_BRIDGE_STATE_DIR` or CC conversation id. |
| Attached Codex (peer) | `a2a-bridge codex --id <id>` CLI flag. |
| Attached Hermes (peer, v0.2) | `a2a-bridge hermes --id <id>` CLI flag. |
| ACP client (caller) | `a2a-bridge acp --target kind:id` routing parameter. |
| A2A client (caller) | `Message.contextId` on the JSON-RPC call — daemon maps contextId → TargetId (configurable). |

### Default id derivation for Claude Code

In priority order:
1. `A2A_BRIDGE_WORKSPACE_ID` env var (explicit override).
2. Basename of `A2A_BRIDGE_STATE_DIR` — e.g. `~/.config/a2a-bridge/project-a` → `project-a`.
3. First 8 chars of the CC conversation id.
4. Fallback: `default`.

The derivation happens once on `claude_connect`; the plugin sends
the resulting id in the new frame:

```json
{ "type": "claude_connect", "target": "claude:project-a" }
```

## Deployment scenarios

### Single developer, two projects

```bash
# Terminal 1 — daemon
a2a-bridge daemon start

# Terminal 2 — project-a CC
A2A_BRIDGE_STATE_DIR=~/.config/a2a-bridge/project-a a2a-bridge claude
# attaches as claude:project-a

# Terminal 3 — project-b CC
A2A_BRIDGE_STATE_DIR=~/.config/a2a-bridge/project-b a2a-bridge claude
# attaches as claude:project-b

# Inspect
$ a2a-bridge daemon targets
claude:project-a    attached  (plugin conn #1, pid 12345)
claude:project-b    attached  (plugin conn #3, pid 12389)
```

OpenClaw config (`openclaw.json`):

```json
{
  "acp": {
    "allowedAgents": ["claude", "codex", "bridge-proj-a", "bridge-proj-b"]
  },
  "plugins": {
    "entries": {
      "acpx": {
        "config": {
          "agents": {
            "bridge-proj-a": { "command": "a2a-bridge acp --target claude:project-a" },
            "bridge-proj-b": { "command": "a2a-bridge acp --target claude:project-b" }
          }
        }
      }
    }
  }
}
```

In OpenClaw:

```
/acp spawn bridge-proj-a    # → project-a's CC
/acp spawn bridge-proj-b    # → project-b's CC
```

### CC + Codex bidirectional

```bash
a2a-bridge daemon start
a2a-bridge claude                  # claude:default
a2a-bridge codex --id main         # codex:main
```

- OpenClaw calls CC: `/acp spawn bridge-cc` (routes to `claude:default`).
- CC delegates to Codex: the `reply` tool accepts an optional
  `target="codex:main"` field; daemon forwards to the Codex adapter.

### Cross-machine multi-tenant (post v0.2 TLS)

Remote server:

```bash
A2A_BRIDGE_CONTROL_HOST=0.0.0.0 a2a-bridge daemon start --tls
A2A_BRIDGE_STATE_DIR=~/.a2a/team-a a2a-bridge claude     # claude:team-a
A2A_BRIDGE_STATE_DIR=~/.a2a/team-b a2a-bridge claude     # claude:team-b
a2a-bridge codex --id shared                              # codex:shared
```

Client:

```bash
a2a-bridge acp --url wss://remote:443/ws --target claude:team-a -p "hi"
a2a-bridge acp --url wss://remote:443/ws --target codex:shared -p "list files"
```

## Routing rules

**Inbound ACP turn** (subprocess → daemon):
- Subprocess sends `acp_turn_start { target, turnId, sessionId, userText }`.
- Daemon looks up `rooms.get(target)`.
- Forwards to that Room's attached agent.
- Missing target → `acp_turn_error { turnId, message: "target not attached" }`.

**Inbound A2A turn** (HTTP → daemon):
- Client's `message/stream` carries `contextId`.
- Daemon maps `contextId → TargetId` (config `a2a.contextRoutes`,
  with a default fallback like `claude:default`).

**Outbound CC → peer** (CC's reply tool):
- Extend the `reply` tool signature with optional `target` field.
- When present, daemon routes the reply to that target's Room
  instead of the inbound turn's originator.
- Absent → routes back to whoever originated the current turn.

**Peer → CC** (e.g. Codex adapter emits a message):
- The peer's `agentMessage` event is tagged with its own TargetId.
- Daemon routes to whichever Room has subscribed (Rooms subscribe
  to peers they care about).

## id conflict policy

Two agents trying to attach with the same TargetId:

**Default: reject.** The second attach fails with a descriptive
error so the user can diagnose.

```
$ a2a-bridge claude
Error: target claude:project-a already attached
       (plugin conn #1, pid 12345, attached 2h ago)

       To take over: re-run with --force.
       To use a different workspace: set A2A_BRIDGE_STATE_DIR to a fresh dir.
```

**`--force`:** new attach kicks the old one. The previous attach
receives a `disconnect { reason: "replaced" }` notification before
being dropped.

## Daemon CLI surface

```bash
# Lifecycle
a2a-bridge daemon start
a2a-bridge daemon stop
a2a-bridge daemon status
a2a-bridge daemon logs

# Inspection
a2a-bridge daemon targets
# Lists every registered TargetId with attach state, pid, uptime.

# Server / peer attach (from their own terminals)
a2a-bridge claude [--workspace-id <id> | --force]
a2a-bridge codex --id <id> [--force]
a2a-bridge hermes --id <id> [--force]   # v0.2

# Client side
a2a-bridge acp --target <kind:id>
a2a-bridge acp --target <kind:id> -p "<prompt>"
a2a-bridge acp --target <kind:id> --url <wss-url>
```

## Backward compatibility

- Absent `--target` → daemon routes to the unique attached target
  matching the client's kind affinity (today's v0.1 behaviour).
- Single-instance deployments use `default` everywhere; users who
  never run more than one CC see no behavioural change.
- Old plugin / old daemon combos keep working: the new `target`
  field in `claude_connect` is optional; omitted → daemon assigns
  `claude:default`.

## Control-plane wire changes

Extends `transport/control-protocol.ts`:

```ts
// Plugin → daemon: optional target on attach
| { type: "claude_connect"; target?: string }

// ACP subprocess → daemon: required target on every turn
| { type: "acp_turn_start"; target: string; turnId: string; ... }

// Daemon → plugin: new response for conflict rejection
| { type: "claude_connect_rejected"; target: string; reason: string }

// Daemon → plugin: kicked by --force
| { type: "claude_connect_replaced"; target: string }
```

Reuses the identifier-safe key validator already in place for the
permission-bridge frames — TargetId strings are `[a-z0-9_:-]+`.

## Not in scope (deferred)

- **Codex multi-instance** (`a2a-bridge codex --id <id>`) — deferred
  to v0.3. Unlike claude (which attaches via the control-plane WS
  and was therefore straightforward to multi-instance), codex is a
  daemon-internal adapter whose `CodexAdapter`, `TuiConnectionState`,
  proxy port pair, and several module-level singletons would need a
  per-id registry refactor. Tracked in the deferred P10.9 entry of
  `TASKS.md`.
- **Dynamic target discovery** — an ACP client asking the daemon
  "what targets do you have?" at connect time and auto-populating
  its agent registry. Would require extending acpx (OpenClaw's
  plugin) which we don't control. Users register each target
  statically in acpx config instead.
- **Automatic target-id generation** — the daemon never invents an
  id for an attaching agent. Every attach supplies its own.
- **Hot-reload of contextId → TargetId mapping** — the A2A inbound
  side reads this map at startup; config changes require a daemon
  restart. Hot-reload is v0.3+.

## References

- `src/runtime-daemon/rooms/room-router.ts` — existing multi-Room
  scaffolding; the attach path is the only layer that becomes
  per-target rather than global.
- `src/shared/state-dir.ts` — `A2A_BRIDGE_STATE_DIR` resolver, used
  to derive the default workspace id.
- `references/claude-plugins-official/external_plugins/telegram/server.ts:26`
  — precedent for `<KIND>_STATE_DIR` workspace isolation.
- `references/openclaw/extensions/acpx/` — OpenClaw's ACP client
  manager; reads static agent config from `openclaw.json`.
