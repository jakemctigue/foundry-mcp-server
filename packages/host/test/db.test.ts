import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, runMigrations } from "../src/db/index.js";
import { MIGRATIONS } from "../src/db/migrations.js";

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

  it("creates the ledger, stream, audit, provenance, and policy tables", () => {
    const db = openDatabase(tmpDbPath());
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toContain("schema_migrations");
    expect(tables).toContain("events");
    expect(tables).toContain("documents_index");
    expect(tables).toContain("event_stream_state");
    expect(tables).toContain("event_receipts");
    expect(tables).toContain("audit_log");
    expect(tables).toContain("summary_provenance");
    expect(tables).toContain("capability_grants");
    expect(tables).toContain("intelligence_objects");
    expect(tables).toContain("reconciliation_jobs");
    expect(tables).toContain("reconciliation_tasks");
    expect(tables).toContain("intelligence_retention_state");
    expect(tables).toContain("companion_identities");

    const eventColumns = db
      .prepare("PRAGMA table_info(events)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(eventColumns).toEqual(
      expect.arrayContaining([
        "id",
        "sequence_id",
        "connection_id",
        "category",
        "payload",
        "received_at",
        "emitted_at",
        "session_id",
        "world_id",
        "search_text",
      ]),
    );

    const docColumns = db
      .prepare("PRAGMA table_info(documents_index)")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(docColumns).toEqual(expect.arrayContaining(["uuid", "type", "data", "updated_at"]));

    db.close();
  });

  it("supports file-must-exist read-only inspection without changing journal mode", () => {
    const dbPath = tmpDbPath();
    const writable = openDatabase(dbPath);
    runMigrations(writable);
    writable.pragma("journal_mode = DELETE");
    writable.close();
    expect([...fs.readFileSync(dbPath).subarray(18, 20)]).toEqual([1, 1]);

    const readonly = openDatabase(dbPath, { readonly: true, fileMustExist: true });
    expect(readonly.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: MIGRATIONS.length,
    });
    readonly.close();

    expect([...fs.readFileSync(dbPath).subarray(18, 20)]).toEqual([1, 1]);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(() =>
      openDatabase(`${dbPath}.missing`, { readonly: true, fileMustExist: true }),
    ).toThrow();
  });

  it("forward-migrates and backfills a version-one event ledger", () => {
    const db = openDatabase(tmpDbPath());
    const initial = MIGRATIONS[0];
    if (initial === undefined) {
      throw new Error("missing initial migration");
    }
    db.exec(initial.sql);
    db.prepare("INSERT INTO schema_migrations (id, name) VALUES (?, ?)").run(
      initial.id,
      initial.name,
    );
    db.prepare("INSERT INTO events (sequence, type, payload) VALUES (?, ?, ?)").run(
      7,
      "journal.update",
      '{"name":"Old note"}',
    );

    expect(runMigrations(db).applied).toEqual([2, 3, 4, 5, 6, 7]);
    const row = db
      .prepare(
        `SELECT connection_id, sequence_id, category, payload, received_at, search_text
         FROM events WHERE sequence_id = 7`,
      )
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      connection_id: "legacy",
      sequence_id: 7,
      category: "journal.update",
      payload: '{"name":"Old note"}',
    });
    expect(row["received_at"]).toMatch(/Z$/);
    expect(row["search_text"]).toContain("Old note");
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
