# Rooms and concurrency

a2a-bridge routes every inbound turn through a **Room** — a
per-session container that owns the resources one Claude Code
conversation needs: the gateway that injects user text into CC, the
peer adapter set (Codex today; OpenClaw/Hermes post-v0.2), and the
task rows that track each turn's lifecycle.

This document covers the four things callers ask about most: how
Rooms are named, what multi-session isolation guarantees you get,
what survives restarts, and when adapters live or die.

## TargetId and RoomId

Since v0.2, every agent instance has a **TargetId** — a `kind:id`
tuple like `claude:proj-a` or `codex:default`. TargetIds are the
canonical key for multi-target routing: CC attaches announce one,
ACP callers pick one with `--target`, and A2A callers map their
`contextId` to one via `A2A_BRIDGE_CONTEXT_ROUTES`.

A **RoomId** is a branded string (`RoomId = string & { __brand }`)
derived per inbound request. In v0.2 the room is typically keyed
directly by its TargetId (`claude:proj-a` is both the attach id and
the Room id). The legacy fallback still applies when no target is
supplied — see precedence table below.

TargetIds must pass `[a-z0-9_-]+` on each side of the `:` —
validated by [`parseTarget`](../../src/shared/target-id.ts) at every
boundary that accepts one. Invalid targets are rejected at the
source instead of silently routing to `default`.

| Precedence | Source                                 | Notes                                                                                                    |
|------------|----------------------------------------|----------------------------------------------------------------------------------------------------------|
| 1          | ACP `--target kind:id` flag            | Sets the Room key on `acp_turn_start`; unattached targets return `acp_turn_error`                         |
| 2          | A2A `contextRoutes[contextId]`         | Operator map (`A2A_BRIDGE_CONTEXT_ROUTES` env var); unmapped contexts fall back to `claude:default`       |
| 3          | A2A `Message.contextId` (no routes)    | v0.1 compat — each distinct `contextId` is its own Room                                                  |
| 4          | `A2A_BRIDGE_ROOM` env var              | CLI-style callers without a contextId                                                                    |
| 5          | literal `"default"`                    | Single-CC fallback — matches pre-Phase-4 behavior                                                        |

Empty or whitespace values are treated as absent. Clients that want
a stable room across calls either thread the same `contextId` each
request, export `A2A_BRIDGE_ROOM`, or — recommended on v0.2 — pick an
explicit TargetId.

## CC attach and TargetId derivation

`a2a-bridge claude` announces its TargetId to the daemon on the
control-plane WebSocket via `claude_connect { target }`. The id is
derived by [`resolveClaudeTarget`](../../src/shared/workspace-id.ts):

1. `A2A_BRIDGE_WORKSPACE_ID` env var (explicit override)
2. Basename of `A2A_BRIDGE_STATE_DIR` (`~/.config/a2a-bridge/proj-a` → `proj-a`)
3. First 8 chars of the CC conversation id
4. Fallback: `default`

The derived id is sanitised against `[a-z0-9_-]+` and prefixed with
`claude:` to produce the TargetId. A second `a2a-bridge claude` with
the same TargetId is **rejected** with a descriptive error; pass
`--force` (or set `A2A_BRIDGE_FORCE_ATTACH=1`) to kick the existing
attach and take over.

## Inspection

```bash
a2a-bridge daemon targets
```

Prints a table of every TargetId the daemon currently tracks, with
attach state, the WS connection id, and uptime since the attach
landed. Uses the `list_targets` control-plane RPC — no daemon
restart needed.

## Multi-session semantics

The daemon holds one `RoomRouter` shared by every inbound surface
(A2A today, ACP in Phase 5). The router keeps `Map<RoomId, Room>`
with these guarantees:

- **First access mints.** `getOrCreate(id)` calls the factory once
  per id; a concurrent second call for the same id waits on the same
  promise rather than duplicating construction.
- **Default room is eagerly seeded.** The daemon builds the
  `"default"` Room (with its Codex adapter) at boot and calls
  `router.adopt(defaultRoom)` before inbound traffic arrives, so the
  first request for `"default"` never triggers a second
  `CodexAdapter` (which would conflict on the Codex ports).
- **Non-default rooms are minted lazily.** They share the daemon's
  gateway and task store but do not spawn their own peer adapter
  set. Single-CC ships in v0.1; outbound peer adapters per room
  arrive with OpenClaw/Hermes post-v0.1.
- **Streams are per-request.** Each `message/stream` call gets its
  own SSE pipe. Events emitted during room A's turn never reach
  room B's stream, because they're written into different Response
  bodies. The
  [concurrent-sessions integration test](../../src/cli/concurrent-sessions.test.ts)
  is the regression guard.

## TaskLog persistence guarantees

All tasks route through a daemon-wide `SqliteTaskLog` at
`stateDir.taskLogFile` (`tasks.db` in the a2a-bridge state dir). Rows
are scoped by `room_id`; the
[`ITaskStore`](../../src/runtime-daemon/tasks/task-store.ts) seam lets
in-memory `TaskRegistry` substitute in unit tests without changing
any call sites.

- **Crash survival.** A task created mid-turn is written to SQLite
  with state `"submitted"` and updated to `"working"` / `"completed"`
  as the executor reports progress. If the daemon goes away mid-turn,
  the row's most recent state is what reopens see — a fresh
  `SqliteTaskLog` on the same file answers `tasks/get` with the last
  persisted snapshot. The
  [plugin-reconnect survival test](../../src/cli/plugin-reconnect-survival.test.ts)
  drives this flow end-to-end.
- **Room-scoped history.** `listByRoom(roomId)` returns every task
  tagged with that id, most-recently-updated first — the source of
  truth for room-scoped queries. `deleteByRoom(roomId)` purges them
  all and is called from `Room.dispose()`.
- **Cancellation is an event.** `ITaskStore.cancel(id)` flips
  `state` to `"canceled"` and emits a `cancel` event; the active
  `message/stream` SSE handler listens for it and delivers the
  terminal frame to the client before closing.

## Per-Room adapter lifecycle

- **Construction.** A Room's `peers` array is fixed at construction;
  `attachPeer(adapter)` grows it, but only before disposal. The
  daemon wires the default room with a `CodexAdapter` in its `peers`.
- **Ownership.** The Room is the adapter's owner; the module's
  `codex` const is only a cached handle, not a separate singleton.
  This is enforced by moving the `new CodexAdapter(...)` call into
  the Room construction inline (no more module-level
  `const codex = new CodexAdapter(...)`).
- **Idle check.** `Room.isIdle` is true when no peer reports
  `turnInProgress` and the store has no tasks for the room.
  `RoomRouter.allIdle` aggregates across rooms. The daemon's
  idle-shutdown path gates on this so it never shuts down while any
  room is mid-turn, even if no client is attached at that moment.
- **Disposal.** `Room.dispose()` runs each peer's optional
  `dispose()` (swallowing per-adapter errors), purges the room's
  tasks from the shared store, and marks the room disposed. The
  externally-owned gateway and store are **not** closed — they
  typically outlive individual rooms.
- **Re-mint after dispose.** `RoomRouter.dispose(id)` removes the
  entry from the map *before* awaiting the Room's disposal, so a
  concurrent `getOrCreate` for the same id spins up a fresh Room
  rather than waiting on the in-flight teardown.

## Outbound reply routing (v0.2)

CC's `reply` tool accepts an optional `target` field. Absent, the
reply routes back to the inbound turn's originator (v0.1 behaviour).
Present, the daemon delivers the reply to that target's Room
instead — handy for handing a conversation off between CCs or from a
CC to Codex:

```
reply({ text: "over to you", target: "codex:default" })
```

Unknown or unattached targets surface a descriptive error through
the tool's error channel; replies cannot loop back to the sender.

## Related reading

- [`architecture.md`](../design/architecture.md) — the authoritative
  directory layout and the rules `lint:deps` enforces between
  `inbound/`, `peers/`, `rooms/`, `shared/`, `messages/`.
- [`multi-target-routing.md`](../design/multi-target-routing.md) —
  the v0.2 `kind:id` model: who supplies which id, conflict policy,
  deployment shapes.
- [`roadmap.md`](../design/roadmap.md) — Phase 4 is where the room
  abstraction was introduced; Phase 10 (v0.2) added multi-target
  routing on the claude axis; codex peer-id lands in v0.3.
- [`cookbook.md`](./cookbook.md) — parallel-work pattern uses
  distinct `contextId`s so each branch gets its own Room.
