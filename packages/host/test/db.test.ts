import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, runMigrations } from "../src/db/index.js";

describe("SQLite init and migrations", () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles.splice(0)) {
      for (const suffix of ["", "-wal", "-shm"]) {
        if (fs.existsSync(f + suffix)) {
          fs.unlinkSync(f + suffix);
        }
      }
    }
  });

  function tmpDbPath(): string {
    const file = path.join(
      os.tmpdir(),
      `fmcp-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    tmpFiles.push(file);
    return file;
  }

  it("enables WAL mode and a 5000ms busy timeout", () => {
    const db = openDatabase(tmpDbPath());
    const journalMode = db.pragma("journal_mode", { simple: true });
    const busyTimeout = db.pragma("busy_timeout", { simple: true });
    expect(journalMode).toBe("wal");
    expect(busyTimeout).toBe(5000);
    db.close();
  });

  it("creates schema_migrations, events, and documents_index tables", () => {
    const db = openDatabase(tmpDbPath());
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toContain("schema_migrations");
    expect(tables).toContain("events");
    expect(tables).toContain("documents_index");

    const eventColumns = db
      .prepare("PRAGMA table_info(events)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(eventColumns).toEqual(
      expect.arrayContaining(["id", "sequence", "type", "payload", "created_at"]),
    );

    const docColumns = db
      .prepare("PRAGMA table_info(documents_index)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(docColumns).toEqual(expect.arrayContaining(["uuid", "type", "data", "updated_at"]));

    db.close();
  });

  it("is idempotent when run twice", () => {
    const db = openDatabase(tmpDbPath());
    const first = runMigrations(db);
    const second = runMigrations(db);
    expect(first.applied.length).toBeGreaterThan(0);
    expect(second.applied.length).toBe(0);
    db.close();
  });
});
