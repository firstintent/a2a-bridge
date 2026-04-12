# cc-bridge

A bidirectional bridge that lets Claude Code talk to other AI coding agents — **Codex**, **OpenClaw**, **Hermes**, and more — inside the same live session.

Built on Anthropic's Claude Code Channels protocol. Inspired by [`raysonmeng/agent-bridge`](https://github.com/raysonmeng/agent-bridge), generalized with pluggable peer adapters and multi-machine deployment.

## Status

Early development. See `ROADMAP.md` (TBD) for phased plan.

## Goals

- **Expose Claude Code as a callable peer** to other agents, and consume other agents from inside Claude Code
- **One bridge, many peers**: Codex, OpenClaw, Hermes adapters ship in-tree; third-party adapters plug in via a common interface
- **Multi-machine**: the daemon can run on a separate host from Claude Code
- **Multi-room**: concurrent Claude Code sessions share a single daemon without cross-talk

## Architecture (high-level)

```
┌──────────────┐   MCP stdio (channel)   ┌──────────────────┐   control WS (TLS)   ┌──────────────┐
│ Claude Code  │ ◀────────────────────▶  │ cc-bridge plugin │ ◀──────────────────▶ │   daemon     │
└──────────────┘                         └──────────────────┘                      └──────┬───────┘
                                                                                          │
                                                                       ┌──────────────────┼──────────────────┐
                                                                       ▼                  ▼                  ▼
                                                                 CodexAdapter      OpenClawAdapter      HermesAdapter
                                                                 (WS JSON-RPC)     (WS + Ed25519)       (stdio ACP)
```

- **Plugin** (foreground): a Claude Code MCP channel plugin. Pushes inbound peer messages into the CC conversation as `<channel>` tags; exposes outbound tools (`reply`, `cancel_turn`, `switch_peer`, ...).
- **Daemon** (background, optionally remote): manages one or more `IPeerAdapter` instances, persists per-room task logs, authenticates plugin clients over TLS.
- **Peer adapters**: uniform `IPeerAdapter` interface (`start`, `injectMessage`, events `ready` / `agentMessage` / `turnStarted` / `turnCompleted` / ...). One implementation per target agent.

## Supported peers (planned)

| Peer      | Transport              | Status  |
|-----------|------------------------|---------|
| Codex     | WebSocket JSON-RPC     | Phase 1 |
| Hermes    | stdio (Zed ACP)        | Phase 2 |
| OpenClaw  | WebSocket + Ed25519    | Phase 3 |

## License

MIT. See [`LICENSE`](./LICENSE).
