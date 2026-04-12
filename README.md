# a2a-bridge

Protocol-level plumbing that lets Claude Code be **called by** any
Agent2Agent (A2A) client and that lets Claude Code **call out to**
other AI coding agents — Codex, OpenClaw, Hermes — through a uniform
adapter interface.

Built on Anthropic's Claude Code Channels protocol. Inspired by
[`raysonmeng/agent-bridge`](https://github.com/raysonmeng/agent-bridge),
generalized with a proper port/adapter split, A2A inbound, and
multi-machine deployment.

## Status

Early development. See [`ROADMAP.md`](./ROADMAP.md) for the phased
plan; see [`POSITIONING.md`](./POSITIONING.md) for the design
principles.

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

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the protocol matrix,
the minimum A2A server surface, and the three deployment shapes.

## Supported peers (planned)

| Peer      | Transport              | Status  |
|-----------|------------------------|---------|
| Codex     | WebSocket JSON-RPC     | Phase 1 |
| *any A2A* | HTTPS + SSE (inbound)  | Phase 2 |
| OpenClaw  | WebSocket + Ed25519    | Phase 5 |
| Hermes    | stdio (Zed ACP)        | Phase 6 |

## License

MIT. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
