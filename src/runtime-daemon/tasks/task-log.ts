/**
 * TaskLog — SQLite-backed replacement for the in-memory `TaskRegistry`
 * (Phase 4).
 *
 * Shares the same create / get / updateStatus / cancel surface as the
 * in-memory registry so `message/stream`, `tasks/get`, and `tasks/cancel`
 * can swap between the two via an `ITaskStore` shim (P4.6 seam). Adds
 * `listByRoom` because room-scoped queries are the whole point of going
 * to disk — the daemon can survive a plugin restart and still answer
 * `tasks/get` against the same task id.
 *
 * The migration helper `migrateTaskLogSchema` loads `task-log-schema.sql`
 * once from disk and is idempotent.
 */

import { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_ROOM_ID, type RoomId } from "@daemon/rooms/room-id";
import type {
  ITaskStore,
  InitialTask,
  TaskSnapshot,
  TaskStatus as ITaskStatus,
} from "@daemon/tasks/task-store";

/** Minimal shape of `bun:sqlite`'s Database needed by the migrator. */
export interface SqliteDatabaseLike {
  exec(sql: string): void;
}

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "task-log-schema.sql");

let cachedSchema: string | undefined;

function loadSchema(): string {
  if (cachedSchema === undefined) {
    cachedSchema = readFileSync(schemaPath, "utf8");
  }
  return cachedSchema;
}

/**
 * Apply the TaskLog schema to `db`. Safe to call on every open; all
 * statements are `IF NOT EXISTS`.
 */
export function migrateTaskLogSchema(db: SqliteDatabaseLike): void {
  db.exec(loadSchema());
}

/** Exposed for tests — lets them assert the statement list directly. */
export function readTaskLogSchemaSql(): string {
  return loadSchema();
}

/** Row-level snapshot of a task, mirroring the `tasks` table. */
export interface StoredTask {
  id: string;
  roomId: RoomId;
  contextId: string;
  kind: "task";
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

export type TaskStatus = ITaskStatus;

/**
 * Superset of `ITaskStore`'s `InitialTask`: the caller can pass either
 * the lean `{ id, contextId, kind, status, roomId? }` shape (what the
 * handler uses today) or the full record with status already built.
 */
export interface TaskCreateInput {
  id: string;
  roomId?: RoomId;
  contextId: string;
  kind?: "task";
  status?: TaskStatus;
}

interface SqliteTaskLogEvents {
  cancel: [taskId: string];
}

interface TaskRow {
  id: string;
  room_id: string;
  context_id: string;
  state: string;
  status_json: string;
  created_at: number;
  updated_at: number;
}

export interface SqliteTaskLogOptions {
  /** Deterministic clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * `bun:sqlite`-backed task registry. Not safe to share across processes;
 * callers should route through the one SqliteTaskLog the daemon opens at
 * its state-dir path.
 */
export class SqliteTaskLog
  extends EventEmitter<SqliteTaskLogEvents>
  implements ITaskStore {
  private readonly db: Database;
  private readonly now: () => number;

  constructor(db: Database, options: SqliteTaskLogOptions = {}) {
    super();
    this.db = db;
    this.now = options.now ?? (() => Date.now());
  }

  /** Open + migrate a database at `path`. `:memory:` is allowed for tests. */
  static open(path: string, options: SqliteTaskLogOptions = {}): SqliteTaskLog {
    const db = new Database(path);
    migrateTaskLogSchema(db);
    return new SqliteTaskLog(db, options);
  }

  /**
   * Register a freshly-minted task. Throws if the id is already present.
   * Accepts both the lean `InitialTask` shape (handler callers) and the
   * fuller shape with explicit `roomId`. `roomId` defaults to
   * `DEFAULT_ROOM_ID` until P4.7 threads the real room through the
   * handler.
   */
  create(input: TaskCreateInput | InitialTask): StoredTask {
    const now = this.now();
    const status: TaskStatus = input.status ?? { state: "submitted" };
    const roomId: RoomId = input.roomId ?? DEFAULT_ROOM_ID;
    const row: StoredTask = {
      id: input.id,
      roomId,
      contextId: input.contextId,
      kind: "task",
      status,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.db
        .prepare(
          "INSERT INTO tasks (id, room_id, context_id, state, status_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          row.id,
          roomId,
          row.contextId,
          status.state,
          JSON.stringify(status),
          now,
          now,
        );
    } catch (err) {
      // SQLITE_CONSTRAINT on the primary key — surface the same shape
      // the in-memory registry uses so call sites keep one error path.
      throw new Error(`SqliteTaskLog: task ${input.id} already registered`, {
        cause: err,
      });
    }
    return row;
  }

  get(id: string): StoredTask | undefined {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as TaskRow | null;
    if (!row) return undefined;
    return this.rowToStoredTask(row);
  }

  /** Replace the status snapshot. No-op if the task is gone. */
  updateStatus(id: string, status: TaskStatus): void {
    const now = this.now();
    this.db
      .prepare(
        "UPDATE tasks SET state = ?, status_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(status.state, JSON.stringify(status), now, id);
  }

  /**
   * Mark the task canceled and emit `cancel` so an active stream can
   * deliver its terminal frame. Returns the updated snapshot or
   * undefined when the id is unknown.
   */
  cancel(id: string): StoredTask | undefined {
    const now = this.now();
    const canceled: TaskStatus = { state: "canceled" };
    const changes = this.db
      .prepare(
        "UPDATE tasks SET state = ?, status_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(canceled.state, JSON.stringify(canceled), now, id);
    if (changes.changes === 0) return undefined;
    this.emit("cancel", id);
    return this.get(id);
  }

  /** Forget a task. Used sparingly; `tasks/get` typically wants history. */
  delete(id: string): void {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  /** All tasks for a room, most-recently-updated first. */
  listByRoom(roomId: RoomId): StoredTask[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE room_id = ? ORDER BY updated_at DESC")
      .all(roomId) as TaskRow[];
    return rows.map((r) => this.rowToStoredTask(r));
  }

  /** Current row count. Useful for diagnostics and tests. */
  get size(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as {
      c: number;
    };
    return row.c;
  }

  /** Release the underlying DB handle. Safe to call once. */
  close(): void {
    this.db.close();
  }

  private rowToStoredTask(row: TaskRow): StoredTask {
    return {
      id: row.id,
      roomId: row.room_id as RoomId,
      contextId: row.context_id,
      kind: "task",
      status: JSON.parse(row.status_json) as TaskStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
