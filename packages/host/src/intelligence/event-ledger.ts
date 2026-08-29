import type Database from "better-sqlite3";
import { EventEnvelopeSchema, type EventEnvelope } from "@foundry-mcp/protocol";
import { DEFAULT_EVENT_CATEGORIES } from "../config.js";
import { redactSecrets } from "../security/redaction.js";

export type { EventEnvelope } from "@foundry-mcp/protocol";

export interface EventCaptureOptions {
  categories?: readonly string[];
  capturePrivateContent?: boolean;
}

export interface StoredEvent {
  id: number;
  connectionId: string;
  sequenceId: number;
  category: string;
  payload: unknown;
  emittedAt: string;
  receivedAt: string;
  sessionId?: string;
  worldId?: string;
}

export interface EventIngestResult {
  acknowledgedSequenceId: number;
  nextSequenceId: number;
  stored: boolean;
  duplicate: boolean;
  filtered: boolean;
}

export const MAX_EVENT_SEQUENCE_GAP = 4_096;
export const MAX_PENDING_EVENT_RECEIPTS = 4_096;

interface EventRow {
  id: number;
  connection_id: string;
  sequence_id: number;
  category: string;
  payload: string;
  emitted_at: string;
  received_at: string;
  session_id: string | null;
  world_id: string | null;
}

function requireIdentifier(value: string, label: string): string {
  const result = value.trim();
  if (result.length === 0 || result.length > 512) {
    throw new Error(`${label} must contain 1 to 512 characters`);
  }
  return result;
}

function normalizeTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return parsed.toISOString();
}

function categoryMatches(category: string, configured: string): boolean {
  if (configured.endsWith(".*")) {
    return category.startsWith(configured.slice(0, -1));
  }
  return category === configured || category.startsWith(`${configured}.`);
}

export function isPrivateEvent(envelope: EventEnvelope): boolean {
  return (
    envelope.privateContent === true ||
    envelope.category === "chat.private" ||
    envelope.category.startsWith("chat.private.") ||
    envelope.category === "content.private" ||
    envelope.category.startsWith("content.private.")
  );
}

export function shouldCaptureEvent(
  envelope: EventEnvelope,
  options: EventCaptureOptions = {},
): boolean {
  if (isPrivateEvent(envelope) && options.capturePrivateContent !== true) {
    return false;
  }
  const categories = options.categories ?? DEFAULT_EVENT_CATEGORIES;
  return categories.some((configured) => categoryMatches(envelope.category, configured));
}

function searchableText(category: string, payload: unknown): string {
  const serialized = JSON.stringify(payload);
  return `${category} ${serialized}`.slice(0, 64 * 1024).toLowerCase();
}

export function deserializeEventRow(row: EventRow): StoredEvent {
  const event: StoredEvent = {
    id: row.id,
    connectionId: row.connection_id,
    sequenceId: row.sequence_id,
    category: row.category,
    payload: JSON.parse(row.payload) as unknown,
    emittedAt: row.emitted_at,
    receivedAt: row.received_at,
  };
  if (row.session_id !== null) {
    event.sessionId = row.session_id;
  }
  if (row.world_id !== null) {
    event.worldId = row.world_id;
  }
  return event;
}

export function getAcknowledgedSequence(
  db: Database.Database,
  connectionId: string,
): number {
  const row = db
    .prepare(
      "SELECT acknowledged_sequence_id FROM event_stream_state WHERE connection_id = ?",
    )
    .get(requireIdentifier(connectionId, "connectionId")) as
    | { acknowledged_sequence_id: number }
    | undefined;
  return row?.acknowledged_sequence_id ?? 0;
}

export function getEventResumePoint(
  db: Database.Database,
  connectionId: string,
): { acknowledgedSequenceId: number; nextSequenceId: number } {
  const acknowledgedSequenceId = getAcknowledgedSequence(db, connectionId);
  return { acknowledgedSequenceId, nextSequenceId: acknowledgedSequenceId + 1 };
}

export function ingestEventEnvelope(
  db: Database.Database,
  connectionId: string,
  envelope: EventEnvelope,
  options: EventCaptureOptions = {},
  now: () => Date = () => new Date(),
): EventIngestResult {
  const validatedEnvelope = EventEnvelopeSchema.parse(envelope);
  const normalizedConnectionId = requireIdentifier(connectionId, "connectionId");
  const category = requireIdentifier(validatedEnvelope.category, "category");
  const emittedAt = normalizeTimestamp(validatedEnvelope.emittedAt, "emittedAt");
  const receivedAt = now().toISOString();
  const redactedPayload = redactSecrets(validatedEnvelope.payload);
  const payload = JSON.stringify(redactedPayload);
  const captured = shouldCaptureEvent({ ...validatedEnvelope, category }, options);

  const transaction = db.transaction((): EventIngestResult => {
    const acknowledgedSequenceId = getAcknowledgedSequence(db, normalizedConnectionId);
    if (validatedEnvelope.sequenceId <= acknowledgedSequenceId) {
      return {
        acknowledgedSequenceId,
        nextSequenceId: acknowledgedSequenceId + 1,
        stored: false,
        duplicate: true,
        filtered: false,
      };
    }

    if (validatedEnvelope.sequenceId > acknowledgedSequenceId + MAX_EVENT_SEQUENCE_GAP) {
      throw new Error(
        `sequenceId exceeds the maximum future gap of ${MAX_EVENT_SEQUENCE_GAP.toString()}`,
      );
    }

    const existingReceipt = db
      .prepare(
        "SELECT 1 AS present FROM event_receipts WHERE connection_id = ? AND sequence_id = ?",
      )
      .get(normalizedConnectionId, validatedEnvelope.sequenceId) as
      | { present: number }
      | undefined;
    if (existingReceipt) {
      return {
        acknowledgedSequenceId,
        nextSequenceId: acknowledgedSequenceId + 1,
        stored: false,
        duplicate: true,
        filtered: false,
      };
    }
    const pendingReceiptCount = (
      db
        .prepare("SELECT count(*) AS count FROM event_receipts WHERE connection_id = ?")
        .get(normalizedConnectionId) as { count: number }
    ).count;
    if (pendingReceiptCount >= MAX_PENDING_EVENT_RECEIPTS) {
      throw new Error(
        `pending event receipt window is full (${MAX_PENDING_EVENT_RECEIPTS.toString()})`,
      );
    }

    db.prepare(
        `INSERT INTO event_receipts
          (connection_id, sequence_id, received_at, captured)
         VALUES (?, ?, ?, ?)`,
      )
      .run(normalizedConnectionId, validatedEnvelope.sequenceId, receivedAt, captured ? 1 : 0);

    let stored = false;
    if (captured) {
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO events
            (sequence, type, payload, created_at, connection_id, sequence_id,
             category, emitted_at, received_at, session_id, world_id, search_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          validatedEnvelope.sequenceId,
          category,
          payload,
          receivedAt,
          normalizedConnectionId,
          validatedEnvelope.sequenceId,
          category,
          emittedAt,
          receivedAt,
          validatedEnvelope.sessionId ?? null,
          validatedEnvelope.worldId ?? null,
          searchableText(category, redactedPayload),
        );
      stored = inserted.changes === 1;
    }

    let advancedSequenceId = acknowledgedSequenceId;
    if (validatedEnvelope.sequenceId === acknowledgedSequenceId + 1) {
      const pending = db
        .prepare(
          `SELECT sequence_id FROM event_receipts
           WHERE connection_id = ? AND sequence_id > ? AND sequence_id <= ?
           ORDER BY sequence_id ASC`,
        )
        .all(
          normalizedConnectionId,
          acknowledgedSequenceId,
          acknowledgedSequenceId + MAX_PENDING_EVENT_RECEIPTS,
        ) as Array<{ sequence_id: number }>;
      for (const row of pending) {
        if (row.sequence_id !== advancedSequenceId + 1) break;
        advancedSequenceId = row.sequence_id;
      }
    }

    db.prepare(
      `INSERT INTO event_stream_state (connection_id, acknowledged_sequence_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET
         acknowledged_sequence_id = excluded.acknowledged_sequence_id,
         updated_at = excluded.updated_at`,
    ).run(normalizedConnectionId, advancedSequenceId, receivedAt);
    db.prepare(
      "DELETE FROM event_receipts WHERE connection_id = ? AND sequence_id <= ?",
    ).run(normalizedConnectionId, advancedSequenceId);

    return {
      acknowledgedSequenceId: advancedSequenceId,
      nextSequenceId: advancedSequenceId + 1,
      stored,
      duplicate: false,
      filtered: !captured,
    };
  });

  return transaction();
}

export function pruneEventsOlderThan(db: Database.Database, cutoff: string): number {
  const cutoffIso = normalizeTimestamp(cutoff, "cutoff");
  return db.prepare("DELETE FROM events WHERE received_at < ?").run(cutoffIso).changes;
}

export function pruneEventsByRetentionDays(
  db: Database.Database,
  retentionDays: number,
  now: Date = new Date(),
): number {
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new Error("retentionDays must be a non-negative integer");
  }
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
  return pruneEventsOlderThan(db, cutoff.toISOString());
}
