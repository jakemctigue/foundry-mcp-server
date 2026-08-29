export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "init",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_sequence ON events (sequence);

      CREATE TABLE IF NOT EXISTS documents_index (
        uuid TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    id: 2,
    name: "event-ledger",
    sql: `
      DROP INDEX IF EXISTS idx_events_sequence;

      ALTER TABLE events ADD COLUMN connection_id TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE events ADD COLUMN sequence_id INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE events ADD COLUMN category TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE events ADD COLUMN emitted_at TEXT NOT NULL DEFAULT '';
      ALTER TABLE events ADD COLUMN received_at TEXT NOT NULL DEFAULT '';
      ALTER TABLE events ADD COLUMN session_id TEXT;
      ALTER TABLE events ADD COLUMN world_id TEXT;
      ALTER TABLE events ADD COLUMN search_text TEXT NOT NULL DEFAULT '';

      UPDATE events
      SET connection_id = 'legacy',
          sequence_id = sequence,
          category = type,
          emitted_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at),
          received_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at),
          search_text = type || ' ' || payload
      WHERE sequence_id = 0;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_connection_sequence
        ON events (connection_id, sequence_id);
      CREATE INDEX IF NOT EXISTS idx_events_timeline
        ON events (connection_id, received_at, id);
      CREATE INDEX IF NOT EXISTS idx_events_changed
        ON events (connection_id, sequence_id, received_at);
      CREATE INDEX IF NOT EXISTS idx_events_session
        ON events (connection_id, session_id, received_at);
      CREATE INDEX IF NOT EXISTS idx_events_world
        ON events (connection_id, world_id, received_at);

      CREATE TABLE IF NOT EXISTS event_stream_state (
        connection_id TEXT PRIMARY KEY,
        acknowledged_sequence_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_receipts (
        connection_id TEXT NOT NULL,
        sequence_id INTEGER NOT NULL,
        received_at TEXT NOT NULL,
        captured INTEGER NOT NULL CHECK (captured IN (0, 1)),
        PRIMARY KEY (connection_id, sequence_id)
      );
    `,
  },
  {
    id: 3,
    name: "audit-log",
    sql: `
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        capability TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
        correlation_id TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_connection_time
        ON audit_log (connection_id, timestamp, id);
      CREATE INDEX IF NOT EXISTS idx_audit_log_correlation
        ON audit_log (correlation_id);
    `,
  },
  {
    id: 4,
    name: "summary-provenance",
    sql: `
      CREATE TABLE IF NOT EXISTS summary_provenance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
        suggestion_json TEXT,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_summary_provenance_connection_time
        ON summary_provenance (connection_id, timestamp, id);
    `,
  },
  {
    id: 5,
    name: "capability-grants",
    sql: `
      CREATE TABLE IF NOT EXISTS capability_grants (
        connection_id TEXT NOT NULL,
        foundry_user_role TEXT NOT NULL,
        capability TEXT NOT NULL,
        allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, foundry_user_role, capability)
      );
    `,
  },
];
