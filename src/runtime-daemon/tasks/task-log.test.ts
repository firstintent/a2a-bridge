import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  migrateTaskLogSchema,
  readTaskLogSchemaSql,
} from "@daemon/tasks/task-log";

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
