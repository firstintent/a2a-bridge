import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  SqliteTaskLog,
  migrateTaskLogSchema,
  readTaskLogSchemaSql,
} from "@daemon/tasks/task-log";
import type { RoomId } from "@daemon/rooms/room-id";

interface TableRow {
  name: string;
}

interface IndexRow {
  name: string;
}

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

function openMemoryDb(): Database {
  return new Database(":memory:");
}

describe("migrateTaskLogSchema", () => {
  test("creates the tasks table with the documented columns", () => {
    const db = openMemoryDb();
    migrateTaskLogSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .all() as TableRow[];
    expect(tables.length).toBe(1);

    const columns = db.prepare("PRAGMA table_info(tasks)").all() as ColumnRow[];
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.size).toBe(7);
    const id = byName.get("id");
    expect(id?.type).toBe("TEXT");
    expect(id?.pk).toBe(1);
    for (const required of [
      "room_id",
      "context_id",
      "state",
      "status_json",
      "created_at",
      "updated_at",
    ]) {
      const col = byName.get(required);
      expect(col).toBeDefined();
      expect(col!.notnull).toBe(1);
    }
  });

  test("creates the room-scoped indexes", () => {
    const db = openMemoryDb();
    migrateTaskLogSchema(db);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'")
      .all() as IndexRow[];
    const names = indexes.map((r) => r.name).sort();
    expect(names).toContain("idx_tasks_room");
    expect(names).toContain("idx_tasks_room_updated");
  });

  test("is idempotent — running twice does not throw or duplicate tables", () => {
    const db = openMemoryDb();
    migrateTaskLogSchema(db);
    migrateTaskLogSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .all() as TableRow[];
    expect(tables.length).toBe(1);
  });

  test("reads the schema file from disk and exposes it for inspection", () => {
    const sql = readTaskLogSchemaSql();
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS tasks/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_tasks_room /);
  });
});

describe("SqliteTaskLog", () => {
  function freshLog() {
    let tick = 1_700_000_000_000;
    const log = SqliteTaskLog.open(":memory:", { now: () => tick++ });
    return {
      log,
      peek: () => tick,
    };
  }

  test("create/get round-trips a task with default submitted state", () => {
    const { log } = freshLog();
    const stored = log.create({
      id: "task-1",
      roomId: "room-a" as RoomId,
      contextId: "ctx-x",
    });
    expect(stored.kind).toBe("task");
    expect(stored.status.state).toBe("submitted");
    expect(stored.roomId).toBe("room-a" as RoomId);

    const fetched = log.get("task-1");
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe("task-1");
    expect(fetched!.status.state).toBe("submitted");
  });

  test("create throws on duplicate id", () => {
    const { log } = freshLog();
    log.create({ id: "dup", roomId: "r" as RoomId, contextId: "c" });
    expect(() => log.create({ id: "dup", roomId: "r" as RoomId, contextId: "c" })).toThrow(
      /already registered/,
    );
  });

  test("updateStatus replaces state + status_json and bumps updated_at", () => {
    const { log } = freshLog();
    const created = log.create({
      id: "t",
      roomId: "r" as RoomId,
      contextId: "c",
    });
    log.updateStatus("t", {
      state: "completed",
      message: { parts: [{ kind: "text", text: "done" }] },
    });
    const after = log.get("t")!;
    expect(after.status.state).toBe("completed");
    expect((after.status.message as { parts: Array<{ text: string }> }).parts[0]!.text).toBe(
      "done",
    );
    expect(after.updatedAt).toBeGreaterThan(created.updatedAt);
    expect(after.createdAt).toBe(created.createdAt);
  });

  test("updateStatus is a no-op when the task is gone", () => {
    const { log } = freshLog();
    log.updateStatus("never-created", { state: "ignored" });
    expect(log.get("never-created")).toBeUndefined();
  });

  test("cancel flips state, emits cancel, and returns the row; no-op for unknown id", () => {
    const { log } = freshLog();
    log.create({ id: "t", roomId: "r" as RoomId, contextId: "c" });

    const seen: string[] = [];
    log.on("cancel", (id) => seen.push(id));

    const canceled = log.cancel("t");
    expect(canceled).toBeDefined();
    expect(canceled!.status.state).toBe("canceled");
    expect(seen).toEqual(["t"]);
    expect(log.get("t")!.status.state).toBe("canceled");

    const missing = log.cancel("nope");
    expect(missing).toBeUndefined();
    expect(seen).toEqual(["t"]);
  });

  test("listByRoom returns only the room's tasks, most-recently-updated first", () => {
    const { log } = freshLog();
    log.create({ id: "a", roomId: "room-a" as RoomId, contextId: "c1" });
    log.create({ id: "b", roomId: "room-b" as RoomId, contextId: "c2" });
    log.create({ id: "c", roomId: "room-a" as RoomId, contextId: "c3" });
    log.updateStatus("a", { state: "completed" });

    const roomA = log.listByRoom("room-a" as RoomId);
    expect(roomA.map((t) => t.id)).toEqual(["a", "c"]);

    const roomB = log.listByRoom("room-b" as RoomId);
    expect(roomB.map((t) => t.id)).toEqual(["b"]);

    const empty = log.listByRoom("unused" as RoomId);
    expect(empty).toEqual([]);
  });

  test("delete removes a task entirely", () => {
    const { log } = freshLog();
    log.create({ id: "t", roomId: "r" as RoomId, contextId: "c" });
    expect(log.size).toBe(1);
    log.delete("t");
    expect(log.size).toBe(0);
    expect(log.get("t")).toBeUndefined();
  });

  test("size reflects table row count", () => {
    const { log } = freshLog();
    expect(log.size).toBe(0);
    log.create({ id: "1", roomId: "r" as RoomId, contextId: "c" });
    log.create({ id: "2", roomId: "r" as RoomId, contextId: "c" });
    expect(log.size).toBe(2);
  });

  test("data survives a reopen of the same file", () => {
    const path = `${require("node:os").tmpdir()}/a2a-bridge-sqlite-tasklog-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
    const first = SqliteTaskLog.open(path);
    first.create({ id: "survive", roomId: "room-x" as RoomId, contextId: "c" });
    first.close();

    const second = SqliteTaskLog.open(path);
    const recovered = second.get("survive");
    expect(recovered).toBeDefined();
    expect(recovered!.roomId).toBe("room-x" as RoomId);
    second.close();
    require("node:fs").rmSync(path, { force: true });
  });
});
