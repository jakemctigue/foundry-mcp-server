import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";

export interface OpenDatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

export function openDatabase(
  dbPath: string,
  options: OpenDatabaseOptions = {},
): Database.Database {
  const databaseOptions: Database.Options = {
    ...(options.readonly === undefined ? {} : { readonly: options.readonly }),
    ...(options.fileMustExist === undefined ? {} : { fileMustExist: options.fileMustExist }),
  };
  const db = new Database(dbPath, databaseOptions);
  if (options.readonly !== true) {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("busy_timeout = 5000");
  return db;
}

/**
 * Applies pending migrations in order. Idempotent: migrations already
 * recorded in schema_migrations are skipped, so calling this repeatedly
 * against the same database is a no-op after the first run.
 */
export function runMigrations(db: Database.Database): { applied: number[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const appliedRows = db.prepare("SELECT id FROM schema_migrations").all() as Array<{
    id: number;
  }>;
  const appliedIds = new Set(appliedRows.map((r) => r.id));

  const applied: number[] = [];
  const insertMigration = db.prepare("INSERT INTO schema_migrations (id, name) VALUES (?, ?)");

  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) {
      continue;
    }
    const transaction = db.transaction(() => {
      db.exec(migration.sql);
      insertMigration.run(migration.id, migration.name);
    });
    transaction();
    applied.push(migration.id);
  }

  return { applied };
}
