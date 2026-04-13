# Rooms and concurrency

a2a-bridge routes every inbound turn through a **Room** — a
per-session container that owns the resources one Claude Code
conversation needs: the gateway that injects user text into CC, the
peer adapter set (Codex today; OpenClaw/Hermes post-v0.1), and the
task rows that track each turn's lifecycle.

This document covers the four things callers ask about most: how
Rooms are named, what multi-session isolation guarantees you get,
what survives restarts, and when adapters live or die.

## RoomId derivation

A RoomId is a **branded string** (`RoomId = string & { __brand }`)
derived per inbound request by
[`deriveRoomId`](../../src/runtime-daemon/rooms/room-id.ts):

| Precedence | Source                        | Notes                                           |
|------------|-------------------------------|-------------------------------------------------|
| 1          | `Message.contextId`           | A2A inbound — minted by the client, echoed back |
| 2          | `A2A_BRIDGE_ROOM` env var     | CLI-style callers without a contextId           |
| 3          | literal `"default"`           | Single-CC fallback — matches pre-Phase-4 behavior |

Empty or whitespace values are treated as absent. `contextId` wins
over the env var; the env var wins over `"default"`. Clients that
want a stable room across calls either thread the same `contextId`
each request or export `A2A_BRIDGE_ROOM`.

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

## Related reading

- [`architecture.md`](../design/architecture.md) — the authoritative
  directory layout and the rules `lint:deps` enforces between
  `inbound/`, `peers/`, `rooms/`, `shared/`, `messages/`.
- [`roadmap.md`](../design/roadmap.md) — Phase 4 is where the room
  abstraction was introduced; outbound peer adapters (per-Room
  ownership of OpenClaw/Hermes) move to v0.2.
- [`cookbook.md`](./cookbook.md) — parallel-work pattern uses
  distinct `contextId`s so each branch gets its own Room.
