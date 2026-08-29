import type Database from "better-sqlite3";
import type { IntelligenceObjectSnapshot } from "@foundry-mcp/protocol";
import { deserializeEventRow, type StoredEvent } from "./event-ledger.js";

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
  search_text: string;
}

export interface SearchOptions {
  connectionId: string;
  query: string;
  limit?: number;
}

export interface SearchResult extends StoredEvent {
  score: number;
}

export interface ObjectSearchResult extends IntelligenceObjectSnapshot {
  score: number;
}

export type IntelligenceSearchResult = SearchResult | ObjectSearchResult;

export interface TimelineOptions {
  connectionId: string;
  sessionId?: string;
  worldId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface TimelinePage {
  events: StoredEvent[];
  nextCursor?: string;
}

export interface ChangedSinceOptions {
  connectionId: string;
  afterSequenceId?: number;
  afterTimestamp?: string;
  cursor?: string;
  limit?: number;
}

export interface ChangedSincePage {
  events: StoredEvent[];
  nextCursor?: string;
}

type ChangedSinceCursor =
  | { mode: "sequence"; sequenceId: number; id: number }
  | { mode: "timestamp"; receivedAt: string; id: number };

interface TimelineCursor {
  receivedAt: string;
  id: number;
}

interface ObjectSnapshotRow {
  snapshot_json: string;
  search_text: string;
}

const EVENT_COLUMNS = `
  id, connection_id, sequence_id, category, payload, emitted_at,
  received_at, session_id, world_id, search_text
`;

function boundedLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error("limit must be a positive integer");
  }
  return Math.min(resolved, 100);
}

function validTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return parsed.toISOString();
}

function encodeCursor(cursor: TimelineCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): TimelineCursor {
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<TimelineCursor>;
    if (
      typeof decoded.receivedAt !== "string" ||
      typeof decoded.id !== "number" ||
      !Number.isSafeInteger(decoded.id)
    ) {
      throw new Error("invalid fields");
    }
    return { receivedAt: validTimestamp(decoded.receivedAt, "cursor timestamp"), id: decoded.id };
  } catch (error) {
    throw new Error("cursor must be a valid timeline cursor", { cause: error });
  }
}

function encodeChangedSinceCursor(cursor: ChangedSinceCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeChangedSinceCursor(cursor: string): ChangedSinceCursor {
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<ChangedSinceCursor>;
    if (decoded.mode === "sequence") {
      if (
        !Number.isSafeInteger(decoded.sequenceId) ||
        (decoded.sequenceId as number) < 0 ||
        !Number.isSafeInteger(decoded.id) ||
        (decoded.id as number) < 1
      )
        throw new Error("invalid sequence fields");
      return {
        mode: "sequence",
        sequenceId: decoded.sequenceId as number,
        id: decoded.id as number,
      };
    }
    if (
      decoded.mode !== "timestamp" ||
      typeof decoded.receivedAt !== "string" ||
      !Number.isSafeInteger(decoded.id) ||
      (decoded.id as number) < 1
    )
      throw new Error("invalid timestamp fields");
    return {
      mode: "timestamp",
      receivedAt: validTimestamp(decoded.receivedAt, "changed-since cursor timestamp"),
      id: decoded.id as number,
    };
  } catch (error) {
    throw new Error("cursor must be a valid changed-since cursor", { cause: error });
  }
}

function tokensFor(query: string): string[] {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(tokens)].slice(0, 12);
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (count < 100) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) {
      break;
    }
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function rank(row: EventRow, phrase: string, tokens: readonly string[]): number {
  return rankText(row.search_text, row.category, phrase, tokens);
}

function rankText(
  searchable: string,
  category: string,
  phrase: string,
  tokens: readonly string[],
): number {
  const text = searchable.toLowerCase();
  const normalizedCategory = category.toLowerCase();
  let score = text.includes(phrase) ? 25 : 0;
  for (const token of tokens) {
    score += occurrences(text, token);
    if (normalizedCategory.includes(token)) {
      score += 5;
    }
  }
  return score;
}

export function searchObjectSnapshots(
  db: Database.Database,
  options: SearchOptions,
): ObjectSearchResult[] {
  const limit = boundedLimit(options.limit, 20);
  const phrase = options.query.trim().toLowerCase();
  const tokens = tokensFor(phrase);
  if (tokens.length === 0) return [];
  const tokenClauses = tokens.map(() => "instr(lower(search_text), ?) > 0").join(" OR ");
  const rows = db
    .prepare(
      `SELECT snapshot_json, search_text
       FROM intelligence_objects
       WHERE connection_id = ? AND (${tokenClauses})
       ORDER BY last_seen_at DESC, object_id ASC
       LIMIT ?`,
    )
    .all(
      options.connectionId,
      ...tokens,
      Math.min(Math.max(limit * 20, 100), 1_000),
    ) as ObjectSnapshotRow[];
  return rows
    .map((row) => {
      const snapshot = JSON.parse(row.snapshot_json) as IntelligenceObjectSnapshot;
      return {
        ...snapshot,
        score: rankText(row.search_text, snapshot.documentType, phrase, tokens),
      };
    })
    .sort((left, right) => right.score - left.score || left.objectId.localeCompare(right.objectId))
    .slice(0, limit);
}

export function searchIntelligence(
  db: Database.Database,
  options: SearchOptions,
): IntelligenceSearchResult[] {
  const limit = boundedLimit(options.limit, 20);
  return [
    ...searchEvents(db, { ...options, limit }),
    ...searchObjectSnapshots(db, { ...options, limit }),
  ]
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftKey = "objectId" in left ? left.objectId : `event:${left.id.toString()}`;
      const rightKey = "objectId" in right ? right.objectId : `event:${right.id.toString()}`;
      return leftKey.localeCompare(rightKey);
    })
    .slice(0, limit);
}

/** Local, deterministic FTS-equivalent ranker over bounded SQLite candidates. */
export function searchEvents(db: Database.Database, options: SearchOptions): SearchResult[] {
  const limit = boundedLimit(options.limit, 20);
  const phrase = options.query.trim().toLowerCase();
  const tokens = tokensFor(phrase);
  if (tokens.length === 0) {
    return [];
  }

  const tokenClauses = tokens.map(() => "instr(lower(search_text), ?) > 0").join(" OR ");
  const candidateLimit = Math.min(Math.max(limit * 20, 100), 1_000);
  const rows = db
    .prepare(
      `SELECT ${EVENT_COLUMNS}
       FROM events
       WHERE connection_id = ? AND (${tokenClauses})
       ORDER BY sequence_id DESC, id DESC
       LIMIT ?`,
    )
    .all(options.connectionId, ...tokens, candidateLimit) as EventRow[];

  return rows
    .map((row): SearchResult => ({ ...deserializeEventRow(row), score: rank(row, phrase, tokens) }))
    .sort((left, right) => right.score - left.score || right.sequenceId - left.sequenceId)
    .slice(0, limit);
}

export function getTimeline(db: Database.Database, options: TimelineOptions): TimelinePage {
  const limit = boundedLimit(options.limit, 50);
  const clauses = ["connection_id = ?"];
  const parameters: unknown[] = [options.connectionId];

  if (options.sessionId !== undefined) {
    clauses.push("session_id = ?");
    parameters.push(options.sessionId);
  }
  if (options.worldId !== undefined) {
    clauses.push("world_id = ?");
    parameters.push(options.worldId);
  }
  if (options.from !== undefined) {
    clauses.push("received_at >= ?");
    parameters.push(validTimestamp(options.from, "from"));
  }
  if (options.to !== undefined) {
    clauses.push("received_at <= ?");
    parameters.push(validTimestamp(options.to, "to"));
  }
  if (options.cursor !== undefined) {
    const cursor = decodeCursor(options.cursor);
    clauses.push("(received_at > ? OR (received_at = ? AND id > ?))");
    parameters.push(cursor.receivedAt, cursor.receivedAt, cursor.id);
  }

  const rows = db
    .prepare(
      `SELECT ${EVENT_COLUMNS}
       FROM events
       WHERE ${clauses.join(" AND ")}
       ORDER BY received_at ASC, id ASC
       LIMIT ?`,
    )
    .all(...parameters, limit + 1) as EventRow[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const page: TimelinePage = { events: pageRows.map(deserializeEventRow) };
  const last = pageRows.at(-1);
  if (hasMore && last !== undefined) {
    page.nextCursor = encodeCursor({ receivedAt: last.received_at, id: last.id });
  }
  return page;
}

export function getChangedSince(
  db: Database.Database,
  options: ChangedSinceOptions,
): StoredEvent[] {
  return getChangedSincePage(db, options).events;
}

export function getChangedSincePage(
  db: Database.Database,
  options: ChangedSinceOptions,
): ChangedSincePage {
  const sequenceCursor = options.afterSequenceId;
  const timestampCursor = options.afterTimestamp;
  if ((sequenceCursor === undefined) === (timestampCursor === undefined)) {
    throw new Error("provide exactly one of afterSequenceId or afterTimestamp");
  }

  const limit = boundedLimit(options.limit, 100);
  const clauses = ["connection_id = ?"];
  const parameters: unknown[] = [options.connectionId];
  let orderBy: string;
  let mode: ChangedSinceCursor["mode"];
  if (sequenceCursor !== undefined) {
    if (!Number.isSafeInteger(sequenceCursor) || sequenceCursor < 0) {
      throw new Error("afterSequenceId must be a non-negative safe integer");
    }
    mode = "sequence";
    clauses.push("sequence_id > ?");
    parameters.push(sequenceCursor);
    orderBy = "sequence_id ASC, id ASC";
  } else {
    mode = "timestamp";
    clauses.push("received_at > ?");
    parameters.push(validTimestamp(timestampCursor as string, "afterTimestamp"));
    orderBy = "received_at ASC, id ASC";
  }

  if (options.cursor !== undefined) {
    const cursor = decodeChangedSinceCursor(options.cursor);
    if (cursor.mode !== mode) throw new Error("changed-since cursor mode does not match input");
    if (cursor.mode === "sequence") {
      clauses.push("(sequence_id > ? OR (sequence_id = ? AND id > ?))");
      parameters.push(cursor.sequenceId, cursor.sequenceId, cursor.id);
    } else {
      clauses.push("(received_at > ? OR (received_at = ? AND id > ?))");
      parameters.push(cursor.receivedAt, cursor.receivedAt, cursor.id);
    }
  }

  const rows = db
    .prepare(
      `SELECT ${EVENT_COLUMNS}
       FROM events
       WHERE ${clauses.join(" AND ")}
       ORDER BY ${orderBy}
       LIMIT ?`,
    )
    .all(...parameters, limit + 1) as EventRow[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const page: ChangedSincePage = { events: pageRows.map(deserializeEventRow) };
  const last = pageRows.at(-1);
  if (hasMore && last) {
    page.nextCursor = encodeChangedSinceCursor(
      mode === "sequence"
        ? { mode, sequenceId: last.sequence_id, id: last.id }
        : { mode, receivedAt: last.received_at, id: last.id },
    );
  }
  return page;
}
export function getEventsByIds(
  db: Database.Database,
  connectionId: string,
  eventIds: readonly number[],
): StoredEvent[] {
  const ids = [...new Set(eventIds)];
  if (ids.length === 0) {
    return [];
  }
  if (ids.length > 200 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error("eventIds must contain 1 to 200 positive safe integers");
  }
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT ${EVENT_COLUMNS}
       FROM events
       WHERE connection_id = ? AND id IN (${placeholders})
       ORDER BY sequence_id ASC, id ASC`,
    )
    .all(connectionId, ...ids) as EventRow[];
  return rows.map(deserializeEventRow);
}
