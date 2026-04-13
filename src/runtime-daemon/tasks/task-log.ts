/**
 * TaskLog migration helper (Phase 4).
 *
 * Reads `task-log-schema.sql` sibling file at runtime and applies it to
 * an open `bun:sqlite` database. Idempotent — every statement in the
 * schema is guarded with `CREATE ... IF NOT EXISTS`, so running
 * `migrateTaskLogSchema` on every open is safe.
 *
 * The `SqliteTaskLog` class itself lands in P4.5; this file owns only
 * the migration glue so the schema is committable + testable in one
 * atomic unit without coupling to the final TaskRegistry interface.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
