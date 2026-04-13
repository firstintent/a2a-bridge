-- a2a-bridge TaskLog schema (Phase 4).
--
-- A `tasks` row is one A2A inbound task's lifecycle snapshot. The
-- SqliteTaskLog implementation (P4.5) reads through this so `tasks/get`
-- survives a plugin reconnect; `message/stream` writes status snapshots
-- as they occur.
--
-- `status_json` stores the full A2A `TaskStatus` object including any
-- terminal `message` so callers can reconstruct the narrative without
-- re-running the turn. `room_id` lets us scope queries to one Room;
-- `context_id` lines up with the A2A `contextId`.
--
-- created_at / updated_at are epoch-ms integers written by the
-- application; sqlite `datetime()` would complicate cross-runtime time
-- handling and bun's timers already speak ms.

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL,
  context_id  TEXT NOT NULL,
  state       TEXT NOT NULL,
  status_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id);
CREATE INDEX IF NOT EXISTS idx_tasks_room_updated ON tasks(room_id, updated_at DESC);
