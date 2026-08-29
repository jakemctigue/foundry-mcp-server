import type Database from "better-sqlite3";
import type { IntelligenceObjectSnapshot } from "@foundry-mcp/protocol";
import { redactSecrets } from "../security/redaction.js";
import type { StoredEvent } from "./event-ledger.js";
import { getIntelligenceStatus } from "./reconciliation.js";
import { getChangedSince, getTimeline, searchIntelligence } from "./queries.js";

export interface ContextPackOptions {
  connectionId: string;
  query?: string;
  afterSequenceId?: number;
  afterTimestamp?: string;
  sessionId?: string;
  worldId?: string;
  from?: string;
  to?: string;
  maxEvents?: number;
  maxObjects?: number;
  maxBytes?: number;
  generatedAt?: Date;
}

export interface ContextPack {
  version: 1;
  connectionId: string;
  generatedAt: string;
  source: "search" | "changed-since" | "timeline";
  events: StoredEvent[];
  objects: IntelligenceObjectSnapshot[];
  sourceEventIds: number[];
  sourceObjectIds: string[];
  truncated: boolean;
  limits: {
    maxEvents: number;
    maxObjects: number;
    maxBytes: number;
  };
  reconciliation: ReturnType<typeof getIntelligenceStatus>;
  byteLength: number;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function withoutSearchScore(event: StoredEvent & { score?: number }): StoredEvent {
  const storedEvent: StoredEvent = {
    id: event.id,
    connectionId: event.connectionId,
    sequenceId: event.sequenceId,
    category: event.category,
    payload: event.payload,
    emittedAt: event.emittedAt,
    receivedAt: event.receivedAt,
  };
  if (event.sessionId !== undefined) {
    storedEvent.sessionId = event.sessionId;
  }
  if (event.worldId !== undefined) {
    storedEvent.worldId = event.worldId;
  }
  return storedEvent;
}

/**
 * Produces a redacted prompt-ready pack with hard event-count and UTF-8 byte
 * bounds. It contains provenance IDs only; it performs no external calls.
 */
export function buildContextPack(db: Database.Database, options: ContextPackOptions): ContextPack {
  const maxEvents = boundedInteger(options.maxEvents, 25, 1, 100, "maxEvents");
  const maxObjects = boundedInteger(options.maxObjects, 25, 1, 100, "maxObjects");
  const maxBytes = boundedInteger(options.maxBytes, 64 * 1024, 1_024, 512 * 1024, "maxBytes");
  let source: ContextPack["source"];
  let candidates: StoredEvent[];
  let objectCandidates: IntelligenceObjectSnapshot[] = [];
  let sourceTruncated = false;

  if (options.query !== undefined) {
    source = "search";
    const hits = searchIntelligence(db, {
      connectionId: options.connectionId,
      query: options.query,
      limit: Math.min(100, maxEvents + maxObjects),
    });
    candidates = hits
      .filter((hit): hit is StoredEvent & { score: number } => "sequenceId" in hit)
      .slice(0, maxEvents)
      .map(withoutSearchScore);
    objectCandidates = hits
      .filter((hit): hit is IntelligenceObjectSnapshot & { score: number } => "objectId" in hit)
      .slice(0, maxObjects)
      .map(({ score: _score, ...snapshot }) => snapshot);
  } else if (options.afterSequenceId !== undefined || options.afterTimestamp !== undefined) {
    source = "changed-since";
    candidates = getChangedSince(db, {
      connectionId: options.connectionId,
      ...(options.afterSequenceId === undefined
        ? { afterTimestamp: options.afterTimestamp as string }
        : { afterSequenceId: options.afterSequenceId }),
      limit: maxEvents,
    });
  } else {
    source = "timeline";
    const page = getTimeline(db, {
      connectionId: options.connectionId,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.worldId === undefined ? {} : { worldId: options.worldId }),
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.to === undefined ? {} : { to: options.to }),
      limit: maxEvents,
    });
    candidates = page.events;
    sourceTruncated = page.nextCursor !== undefined;
  }

  const pack: ContextPack = {
    version: 1,
    connectionId: options.connectionId,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    source,
    events: [],
    objects: [],
    sourceEventIds: [],
    sourceObjectIds: [],
    truncated: sourceTruncated,
    limits: { maxEvents, maxObjects, maxBytes },
    reconciliation: getIntelligenceStatus(db, options.connectionId),
    byteLength: 0,
  };

  for (const candidate of candidates.slice(0, maxEvents)) {
    const safeEvent = redactSecrets(candidate) as StoredEvent;
    pack.events.push(safeEvent);
    pack.sourceEventIds.push(candidate.id);
    if (serializedBytes(pack) <= maxBytes) {
      continue;
    }

    pack.events.pop();
    pack.sourceEventIds.pop();
    const compactEvent = { ...safeEvent, payload: "[TRUNCATED]" };
    pack.events.push(compactEvent);
    pack.sourceEventIds.push(candidate.id);
    if (serializedBytes(pack) > maxBytes) {
      pack.events.pop();
      pack.sourceEventIds.pop();
    }
    pack.truncated = true;
    break;
  }

  if (pack.events.length < candidates.length) {
    pack.truncated = true;
  }
  for (const candidate of objectCandidates.slice(0, maxObjects)) {
    const safeObject = redactSecrets(candidate) as IntelligenceObjectSnapshot;
    pack.objects.push(safeObject);
    pack.sourceObjectIds.push(candidate.objectId);
    if (serializedBytes(pack) <= maxBytes) continue;
    pack.objects.pop();
    pack.sourceObjectIds.pop();
    const compactObject: IntelligenceObjectSnapshot = {
      ...safeObject,
      data: { _reconciliationTruncated: true },
    };
    pack.objects.push(compactObject);
    pack.sourceObjectIds.push(candidate.objectId);
    if (serializedBytes(pack) > maxBytes) {
      pack.objects.pop();
      pack.sourceObjectIds.pop();
    }
    pack.truncated = true;
    break;
  }
  if (pack.objects.length < objectCandidates.length) pack.truncated = true;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    pack.byteLength = serializedBytes(pack);
  }
  while (pack.byteLength > maxBytes && pack.events.length > 0) {
    pack.events.pop();
    pack.sourceEventIds.pop();
    pack.truncated = true;
    pack.byteLength = serializedBytes(pack);
  }
  while (pack.byteLength > maxBytes && pack.objects.length > 0) {
    pack.objects.pop();
    pack.sourceObjectIds.pop();
    pack.truncated = true;
    pack.byteLength = serializedBytes(pack);
  }
  pack.byteLength = serializedBytes(pack);
  if (pack.byteLength > maxBytes) {
    throw new Error("maxBytes is too small for context-pack metadata");
  }
  return pack;
}
