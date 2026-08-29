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
  {
    id: 6,
    name: "intelligence-reconciliation",
    sql: `
      CREATE TABLE IF NOT EXISTS intelligence_objects (
        connection_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        uuid TEXT NOT NULL,
        document_type TEXT NOT NULL,
        subtype TEXT,
        name TEXT,
        parent_uuid TEXT,
        pack_id TEXT,
        snapshot_hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        search_text TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_seen_run_id TEXT NOT NULL,
        PRIMARY KEY (connection_id, object_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_objects_uuid
        ON intelligence_objects (connection_id, uuid);
      CREATE INDEX IF NOT EXISTS idx_intelligence_objects_type
        ON intelligence_objects (connection_id, document_type, subtype, object_id);
      CREATE INDEX IF NOT EXISTS idx_intelligence_objects_seen
        ON intelligence_objects (connection_id, last_seen_at, object_id);

      CREATE TABLE IF NOT EXISTS reconciliation_jobs (
        connection_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'incomplete', 'complete', 'failed')),
        reason TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_completed_at TEXT,
        scanned_count INTEGER NOT NULL DEFAULT 0,
        changed_count INTEGER NOT NULL DEFAULT 0,
        private_filtered_count INTEGER NOT NULL DEFAULT 0,
        queue_depth INTEGER NOT NULL DEFAULT 0,
        gap INTEGER NOT NULL DEFAULT 0 CHECK (gap IN (0, 1)),
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS reconciliation_tasks (
        connection_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        task_key TEXT NOT NULL,
        task_kind TEXT NOT NULL CHECK (task_kind IN ('root', 'embedded', 'compendium')),
        params_json TEXT NOT NULL,
        cursor TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, run_id, task_key)
      );
      CREATE INDEX IF NOT EXISTS idx_reconciliation_tasks_pending
        ON reconciliation_tasks (connection_id, run_id, status, task_key);

      CREATE TABLE IF NOT EXISTS intelligence_retention_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_run_at TEXT NOT NULL,
        removed_events INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];
