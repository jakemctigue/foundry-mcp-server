import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase, runMigrations } from "../src/db/index.js";
import {
  getAcknowledgedSequence,
  getEventResumePoint,
  ingestEventEnvelope,
  pruneEventsByRetentionDays,
  pruneEventsOlderThan,
  shouldCaptureEvent,
  type EventEnvelope,
} from "../src/intelligence/event-ledger.js";
import {
  getChangedSince,
  getEventsByIds,
  getTimeline,
  searchEvents,
} from "../src/intelligence/queries.js";
import { buildContextPack } from "../src/intelligence/context-pack.js";
import { summarizeEvents } from "../src/intelligence/summarization.js";

const CONNECTION_ID = "world-alpha";

function envelope(
  sequenceId: number,
  category: string,
  payload: unknown,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    sequenceId,
    category,
    payload,
    emittedAt: `2026-01-${String(sequenceId).padStart(2, "0")}T00:00:00.000Z`,
    ...overrides,
  };
}

describe("event ledger and local intelligence", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("acks only contiguous sequences, resumes, and suppresses pending and acknowledged duplicates", () => {
    const third = ingestEventEnvelope(
      db,
      CONNECTION_ID,
      envelope(3, "combat.update", { round: 2 }),
    );
    expect(third).toMatchObject({ acknowledgedSequenceId: 0, stored: true, duplicate: false });
    expect(getEventResumePoint(db, CONNECTION_ID)).toEqual({
      acknowledgedSequenceId: 0,
      nextSequenceId: 1,
    });

    const pendingDuplicate = ingestEventEnvelope(
      db,
      CONNECTION_ID,
      envelope(3, "combat.update", { round: 999 }),
    );
    expect(pendingDuplicate).toMatchObject({ acknowledgedSequenceId: 0, duplicate: true });
    expect(ingestEventEnvelope(db, CONNECTION_ID, envelope(1, "scene.update", { id: "a" })))
      .toMatchObject({ acknowledgedSequenceId: 1 });
    expect(ingestEventEnvelope(db, CONNECTION_ID, envelope(2, "journal.update", { id: "b" })))
      .toMatchObject({ acknowledgedSequenceId: 3, nextSequenceId: 4 });

    const acknowledgedDuplicate = ingestEventEnvelope(
      db,
      CONNECTION_ID,
      envelope(2, "journal.update", { id: "replacement" }),
    );
    expect(acknowledgedDuplicate).toMatchObject({
      acknowledgedSequenceId: 3,
      stored: false,
      duplicate: true,
    });
    expect(getAcknowledgedSequence(db, CONNECTION_ID)).toBe(3);
    expect(
      ingestEventEnvelope(db, "world-beta", envelope(1, "scene.update", { id: "other" })),
    ).toMatchObject({ acknowledgedSequenceId: 1, stored: true });
    expect(getAcknowledgedSequence(db, CONNECTION_ID)).toBe(3);
    expect(
      (db.prepare("SELECT count(*) AS count FROM events").get() as { count: number }).count,
    ).toBe(4);
  });

  it("filters unconfigured and private content by default while still advancing the ack", () => {
    expect(
      ingestEventEnvelope(
        db,
        CONNECTION_ID,
        envelope(1, "chat.private", { body: "GM whisper" }, { privateContent: true }),
      ),
    ).toMatchObject({ acknowledgedSequenceId: 1, stored: false, filtered: true });
    expect(
      ingestEventEnvelope(db, CONNECTION_ID, envelope(2, "weather.update", { rain: true })),
    ).toMatchObject({ acknowledgedSequenceId: 2, stored: false, filtered: true });
    expect(
      ingestEventEnvelope(
        db,
        CONNECTION_ID,
        envelope(3, "chat.private.whisper", {
          body: "allowed",
          apiKey: "sk-private-value",
        }),
        { categories: ["chat.*"], capturePrivateContent: true },
      ),
    ).toMatchObject({ acknowledgedSequenceId: 3, stored: true, filtered: false });

    const row = db.prepare("SELECT payload FROM events").get() as { payload: string };
    expect(row.payload).not.toContain("sk-private-value");
    expect(row.payload).toContain("[REDACTED]");
    expect(shouldCaptureEvent(envelope(4, "document.create.Actor", {}))).toBe(true);
    expect(shouldCaptureEvent(envelope(4, "content.private", {}))).toBe(false);
  });

  it("prunes events using explicit cutoffs and configured retention days", () => {
    ingestEventEnvelope(
      db,
      CONNECTION_ID,
      envelope(1, "journal.update", { age: "old" }),
      {},
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    ingestEventEnvelope(
      db,
      CONNECTION_ID,
      envelope(2, "journal.update", { age: "new" }),
      {},
      () => new Date("2026-03-01T00:00:00.000Z"),
    );

    expect(pruneEventsOlderThan(db, "2026-02-01T00:00:00.000Z")).toBe(1);
    expect(pruneEventsByRetentionDays(db, 10, new Date("2026-03-05T00:00:00.000Z"))).toBe(0);
    expect(() => pruneEventsByRetentionDays(db, -1)).toThrow("non-negative integer");
    expect(() => pruneEventsOlderThan(db, "not-a-date")).toThrow("valid timestamp");
  });

  it("ranks searches and provides filtered, keyset-paginated chronological timelines", () => {
    ingestEventEnvelope(
      db,
      CONNECTION_ID,
      envelope(1, "journal.update", { title: "Ancient Dragon", body: "dragon dragon hoard" }, {
        sessionId: "session-1",
        worldId: "world-1",
      }),
      {},
      () => new Date("2026-01-01T10:00:00.000Z"),
    );
    ingestEventEnvelope(
      db,
      CONNECTION_ID,
      envelope(2, "scene.update", { title: "Dragon Gate" }, {
        sessionId: "session-1",
        worldId: "world-1",
      }),
      {},
      () => new Date("2026-01-01T11:00:00.000Z"),
    );
    ingestEventEnvelope(
      db,
      CONNECTION_ID,
      envelope(3, "combat.update", { title: "Goblin ambush" }, {
        sessionId: "session-2",
        worldId: "world-1",
      }),
      {},
      () => new Date("2026-01-01T12:00:00.000Z"),
    );

    const ranked = searchEvents(db, { connectionId: CONNECTION_ID, query: "ancient dragon" });
    expect(ranked.map((result) => result.sequenceId)).toEqual([1, 2]);
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
    expect(searchEvents(db, { connectionId: CONNECTION_ID, query: "  " })).toEqual([]);

    const first = getTimeline(db, {
      connectionId: CONNECTION_ID,
      sessionId: "session-1",
      worldId: "world-1",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-02T00:00:00.000Z",
      limit: 1,
    });
    expect(first.events.map((event) => event.sequenceId)).toEqual([1]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = getTimeline(db, {
      connectionId: CONNECTION_ID,
      sessionId: "session-1",
      cursor: first.nextCursor as string,
      limit: 1,
    });
    expect(second.events.map((event) => event.sequenceId)).toEqual([2]);
    expect(second.nextCursor).toBeUndefined();
    expect(() =>
      getTimeline(db, { connectionId: CONNECTION_ID, cursor: "not-a-cursor" }),
    ).toThrow("valid timeline cursor");
  });

  it("returns changed-since results by sequence or timestamp and validates cursors", () => {
    for (let sequenceId = 1; sequenceId <= 3; sequenceId += 1) {
      ingestEventEnvelope(
        db,
        CONNECTION_ID,
        envelope(sequenceId, "journal.update", { sequenceId }),
        {},
        () => new Date(`2026-02-0${sequenceId}T00:00:00.000Z`),
      );
    }

    expect(
      getChangedSince(db, { connectionId: CONNECTION_ID, afterSequenceId: 1 }).map(
        (event) => event.sequenceId,
      ),
    ).toEqual([2, 3]);
    expect(
      getChangedSince(db, {
        connectionId: CONNECTION_ID,
        afterTimestamp: "2026-02-02T00:00:00.000Z",
      }).map((event) => event.sequenceId),
    ).toEqual([3]);
    expect(() => getChangedSince(db, { connectionId: CONNECTION_ID })).toThrow("exactly one");
    expect(() =>
      getChangedSince(db, { connectionId: CONNECTION_ID, afterSequenceId: -1 }),
    ).toThrow("non-negative");
    expect(() =>
      getChangedSince(db, {
        connectionId: CONNECTION_ID,
        afterSequenceId: 1,
        afterTimestamp: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow("exactly one");
    expect(getEventsByIds(db, CONNECTION_ID, [])).toEqual([]);
  });

  it("builds a redacted context pack bounded by event count and serialized bytes", () => {
    ingestEventEnvelope(
      db,
      CONNECTION_ID,
      envelope(1, "journal.update", {
        title: "Secret vault",
        password: "open-sesame",
        body: "x".repeat(5_000),
      }),
    );
    ingestEventEnvelope(db, CONNECTION_ID, envelope(2, "journal.update", { title: "Map" }));

    const pack = buildContextPack(db, {
      connectionId: CONNECTION_ID,
      maxEvents: 1,
      maxBytes: 1_024,
      generatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const serialized = JSON.stringify(pack);
    expect(pack.events).toHaveLength(1);
    expect(pack.truncated).toBe(true);
    expect(pack.byteLength).toBe(Buffer.byteLength(serialized));
    expect(pack.byteLength).toBeLessThanOrEqual(1_024);
    expect(serialized).not.toContain("open-sesame");

    expect(
      buildContextPack(db, { connectionId: CONNECTION_ID, query: "map" }).source,
    ).toBe("search");
    expect(
      buildContextPack(db, { connectionId: CONNECTION_ID, afterSequenceId: 1 }).source,
    ).toBe("changed-since");
    expect(() =>
      buildContextPack(db, { connectionId: CONNECTION_ID, maxBytes: 100 }),
    ).toThrow("maxBytes");
  });

  it("records success and failure provenance without letting provider failure stop ingestion", async () => {
    ingestEventEnvelope(db, CONNECTION_ID, envelope(1, "journal.update", { title: "Clue" }));
    const eventId = (
      db.prepare("SELECT id FROM events WHERE sequence_id = 1").get() as { id: number }
    ).id;

    const success = await summarizeEvents(db, {
      connectionId: CONNECTION_ID,
      eventIds: [eventId],
      provider: {
        name: "local-test",
        model: "small",
        summarize: async ({ events }) => ({ summary: events[0]?.category, apiKey: "unsafe" }),
      },
      now: () => new Date("2026-05-01T00:00:00.000Z"),
    });
    expect(success).toMatchObject({
      status: "success",
      suggestion: { summary: "journal.update", apiKey: "[REDACTED]" },
      sourceEventIds: [eventId],
    });

    const throwingProvider = vi.fn(async () => {
      throw new Error("api_key=supersecret provider unavailable");
    });
    const failure = await summarizeEvents(db, {
      connectionId: CONNECTION_ID,
      eventIds: [eventId],
      provider: { name: "remote-test", model: "large", summarize: throwingProvider },
      now: () => new Date("2026-05-01T01:00:00.000Z"),
    });
    expect(failure.status).toBe("failed");
    expect(JSON.stringify(failure)).not.toContain("supersecret");

    const provenance = db
      .prepare(
        `SELECT provider, model, status, source_event_ids_json, suggestion_json, error_message
         FROM summary_provenance ORDER BY id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(provenance).toHaveLength(2);
    expect(provenance[0]).toMatchObject({
      provider: "local-test",
      model: "small",
      status: "success",
      source_event_ids_json: JSON.stringify([eventId]),
    });
    expect(provenance[1]).toMatchObject({ provider: "remote-test", status: "failed" });
    expect(JSON.stringify(provenance)).not.toContain("supersecret");

    expect(
      ingestEventEnvelope(db, CONNECTION_ID, envelope(2, "scene.update", { title: "Still live" })),
    ).toMatchObject({ acknowledgedSequenceId: 2, stored: true });
    expect(getTimeline(db, { connectionId: CONNECTION_ID }).events).toHaveLength(2);
  });
});
