import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DocumentView, JsonValue } from "@foundry-mcp/protocol";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, runMigrations } from "../src/db/index.js";
import { buildContextPack } from "../src/intelligence/context-pack.js";
import { IntelligenceCoordinator } from "../src/intelligence/coordinator.js";
import { ingestEventEnvelope } from "../src/intelligence/event-ledger.js";
import { searchIntelligence } from "../src/intelligence/queries.js";
import {
  getIntelligenceStatus,
  IntelligenceReconciler,
  type ReconciliationBridge,
} from "../src/intelligence/reconciliation.js";

const CONNECTION_ID = "world-alpha:gm";

interface Page<T> {
  items: T[];
  nextCursor?: string;
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function page<T>(items: readonly T[], params: Record<string, JsonValue>): Page<T> {
  const offset = Number(params["cursor"] ?? 0);
  const pageSize = Number(params["pageSize"] ?? 50);
  const selected = items.slice(offset, offset + pageSize);
  const nextOffset = offset + selected.length;
  return {
    items: selected,
    ...(nextOffset < items.length ? { nextCursor: String(nextOffset) } : {}),
  };
}

function documentView(input: {
  uuid: string;
  type: string;
  subtype?: string;
  name: string;
  marker: string;
  parentUuid?: string;
  packId?: string;
  ownership?: number;
  private?: boolean;
  excludeFromIntelligence?: boolean;
}): DocumentView {
  return {
    id: input.uuid.split(".").at(-1) ?? input.uuid,
    uuid: input.uuid,
    type: input.type,
    ...(input.subtype ? { subtype: input.subtype } : {}),
    name: input.name,
    ...(input.parentUuid ? { parentUuid: input.parentUuid } : {}),
    ...(input.packId ? { packId: input.packId } : {}),
    sourceHash: `hash-${input.marker}`,
    sourceVersion: 1,
    data: {
      name: input.name,
      marker: input.marker,
      ...(input.subtype ? { type: input.subtype } : {}),
      ...(input.private ? { private: true, password: "must-not-be-indexed" } : {}),
      ...(input.excludeFromIntelligence
        ? { flags: { foundryMcp: { excludeFromIntelligence: true } } }
        : {}),
    },
    ownershipSummary: { default: input.ownership ?? 2 },
    schemaVersion: "14",
  };
}

function summary(document: DocumentView): Record<string, JsonValue> {
  return {
    id: document.id,
    uuid: document.uuid,
    type: document.type,
    ...(document.subtype ? { subtype: document.subtype } : {}),
    ...(document.name ? { name: document.name } : {}),
    ...(document.parentUuid ? { parentUuid: document.parentUuid } : {}),
    ...(document.packId ? { packId: document.packId } : {}),
    sourceHash: document.sourceHash,
    sourceVersion: document.sourceVersion,
  };
}

class FakeReconciliationBridge implements ReconciliationBridge {
  readonly calls: Array<{ method: string; params: Record<string, JsonValue> }> = [];
  truncateEmbedded = false;
  readonly roots = [
    documentView({
      uuid: "Actor.hero",
      type: "Actor",
      subtype: "character",
      name: "Aster Hero",
      marker: "preexisting-character",
    }),
    documentView({
      uuid: "Actor.wyrm",
      type: "Actor",
      subtype: "npc",
      name: "Ancient Wyrm",
      marker: "preexisting-npc",
    }),
    documentView({
      uuid: "Item.blade",
      type: "Item",
      subtype: "weapon",
      name: "World Blade",
      marker: "preexisting-world-item",
    }),
    documentView({
      uuid: "JournalEntry.private",
      type: "JournalEntry",
      name: "GM Plans",
      marker: "private-journal",
      ownership: 0,
      private: true,
    }),
    documentView({
      uuid: "JournalEntry.excluded",
      type: "JournalEntry",
      name: "Explicitly Excluded Notes",
      marker: "flagged-private-must-not-leak",
      ownership: 2,
      excludeFromIntelligence: true,
    }),
  ];
  readonly embedded = [
    documentView({
      uuid: "Actor.hero.Item.pack",
      type: "Item",
      subtype: "container",
      name: "Hero Pack",
      marker: "embedded-item",
      parentUuid: "Actor.hero",
    }),
    documentView({
      uuid: "JournalEntry.private.JournalEntryPage.secret",
      type: "JournalEntryPage",
      subtype: "text",
      name: "Secret Page",
      marker: "private-child-must-not-leak",
      parentUuid: "JournalEntry.private",
    }),
  ];
  readonly compendium = [
    documentView({
      uuid: "Compendium.world.bestiary.Actor.goblin",
      type: "Actor",
      subtype: "npc",
      name: "Compendium Goblin",
      marker: "compendium-visible",
      packId: "world.bestiary",
    }),
  ];
  readonly compendiumEmbedded = [
    documentView({
      uuid: "Compendium.world.bestiary.Actor.goblin.ActiveEffect.alert",
      type: "ActiveEffect",
      name: "Compendium Alert",
      marker: "compendium-embedded",
      parentUuid: "Compendium.world.bestiary.Actor.goblin",
      packId: "world.bestiary",
    }),
  ];

  async request(
    _connectionId: string,
    method: string,
    params: Record<string, JsonValue> = {},
  ): Promise<JsonValue> {
    this.calls.push({ method, params });
    if (method === "documents.types") {
      return {
        types: [
          {
            type: "Actor",
            embedded: false,
            parentTypes: [],
            readable: true,
            creatable: true,
            updatable: true,
            subtypes: [
              { subtype: "character", readable: true, creatable: true, updatable: true },
              { subtype: "npc", readable: true, creatable: true, updatable: true },
            ],
          },
          {
            type: "Item",
            embedded: true,
            parentTypes: ["Actor"],
            readable: true,
            creatable: true,
            updatable: true,
            subtypes: [{ subtype: "weapon", readable: true, creatable: true, updatable: true }],
          },
          {
            type: "JournalEntry",
            embedded: false,
            parentTypes: [],
            readable: true,
            creatable: true,
            updatable: true,
            subtypes: [],
          },
          {
            type: "ActiveEffect",
            embedded: true,
            parentTypes: ["Actor", "Item"],
            readable: true,
            creatable: true,
            updatable: true,
            subtypes: [],
          },
        ],
      };
    }
    if (method === "compendiums.list") {
      return {
        packs: [
          {
            id: "world.bestiary",
            label: "Bestiary",
            type: "Actor",
            documentCount: this.compendium.length,
            locked: false,
          },
        ],
      };
    }
    if (method === "documents.list") {
      const type = String(params["type"]);
      const selected = this.roots.filter((document) => document.type === type);
      const result = page(selected.map(summary), params);
      return json(result);
    }
    if (method === "documents.get") {
      const uuid = String(params["uuid"]);
      const found = [
        ...this.roots,
        ...this.embedded,
        ...this.compendium,
        ...this.compendiumEmbedded,
      ].find((document) => document.uuid === uuid);
      if (!found) throw new Error(`missing fake document ${uuid}`);
      return json(found);
    }
    if (method === "documents.embedded.list") {
      const parentUuid = String(params["parentUuid"]);
      const selected = [...this.embedded, ...this.compendiumEmbedded].filter(
        (document) => document.parentUuid === parentUuid,
      );
      const result = page(
        selected.map((document) => ({ ...summary(document), depth: 1 })),
        params,
      );
      return json({ ...result, truncated: this.truncateEmbedded });
    }
    if (method === "compendiums.documents.list") {
      const result = page(this.compendium, params);
      return json({ packId: "world.bestiary", hydrated: true, ...result });
    }
    throw new Error(`unexpected reconciliation method ${method}`);
  }
}

describe("background intelligence reconciliation", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => db.close());

  it("indexes pre-pair world, dynamic subtype, embedded, and compendium state without private leaks", async () => {
    const bridge = new FakeReconciliationBridge();
    const hero = bridge.roots.find(({ uuid }) => uuid === "Actor.hero");
    if (!hero) throw new Error("missing fake hero");
    hero.data = {
      ...hero.data,
      biography:
        '<p>Visible history</p><section class="secret"><p>hidden-ritual</p></section><p>Visible ending</p>',
    };
    const status = await new IntelligenceReconciler(db, bridge).reconcile(CONNECTION_ID, "initial");

    expect(status.lastError).toBeUndefined();
    expect(
      db
        .prepare("SELECT uuid FROM intelligence_objects WHERE connection_id = ? ORDER BY uuid")
        .all(CONNECTION_ID),
    ).toEqual([
      { uuid: "Actor.hero" },
      { uuid: "Actor.hero.Item.pack" },
      { uuid: "Actor.wyrm" },
      { uuid: "Compendium.world.bestiary.Actor.goblin" },
      { uuid: "Compendium.world.bestiary.Actor.goblin.ActiveEffect.alert" },
      { uuid: "Item.blade" },
    ]);
    expect(status).toMatchObject({
      status: "complete",
      gap: false,
      truncated: false,
      indexedObjects: 6,
      privateFilteredObjects: 2,
    });
    expect(
      bridge.calls.some(
        ({ method, params }) => method === "documents.list" && params["type"] === "Item",
      ),
    ).toBe(true);
    for (const query of [
      "preexisting-character",
      "preexisting-npc",
      "preexisting-world-item",
      "embedded-item",
      "compendium-visible",
      "compendium-embedded",
    ]) {
      expect(searchIntelligence(db, { connectionId: CONNECTION_ID, query })).toHaveLength(1);
    }
    expect(
      searchIntelligence(db, { connectionId: CONNECTION_ID, query: "private-journal" }),
    ).toEqual([]);
    expect(
      searchIntelligence(db, {
        connectionId: CONNECTION_ID,
        query: "flagged-private-must-not-leak",
      }),
    ).toEqual([]);
    expect(searchIntelligence(db, { connectionId: CONNECTION_ID, query: "hidden-ritual" })).toEqual(
      [],
    );
    expect(
      searchIntelligence(db, { connectionId: CONNECTION_ID, query: "Visible history" }).length,
    ).toBeGreaterThan(0);
    expect(
      searchIntelligence(db, {
        connectionId: CONNECTION_ID,
        query: "private-child-must-not-leak",
      }),
    ).toEqual([]);
    expect(
      JSON.stringify(searchIntelligence(db, { connectionId: CONNECTION_ID, query: "must" })),
    ).not.toContain("must-not-be-indexed");

    const context = buildContextPack(db, {
      connectionId: CONNECTION_ID,
      query: "Ancient Wyrm",
    });
    expect(context.events).toEqual([]);
    expect(context.objects).toHaveLength(1);
    expect(context.objects[0]).toMatchObject({
      source: "snapshot",
      uuid: "Actor.wyrm",
      subtype: "npc",
    });
    expect(context.reconciliation.status).toBe("complete");
  });

  it("catches one missed update after reconnect and keeps repeated passes idempotent", async () => {
    const bridge = new FakeReconciliationBridge();
    const reconciler = new IntelligenceReconciler(db, bridge);
    const coordinator = new IntelligenceCoordinator(db, reconciler, { retentionDays: 30 });
    coordinator.updateConnections([CONNECTION_ID]);
    await coordinator.drain();

    const actor = bridge.roots.find(({ uuid }) => uuid === "Actor.hero");
    if (!actor) throw new Error("missing fake actor");
    actor.data = { ...actor.data, marker: "missed-reconnect-update" };
    actor.name = "Aster Reconnected";

    coordinator.updateConnections([]);
    coordinator.updateConnections([CONNECTION_ID]);
    await coordinator.drain();
    const reconnect = getIntelligenceStatus(db, CONNECTION_ID);
    expect(reconnect).toMatchObject({ status: "complete", changedObjects: 1 });
    expect(
      searchIntelligence(db, { connectionId: CONNECTION_ID, query: "missed-reconnect-update" }),
    ).toHaveLength(1);

    coordinator.runPeriodic();
    await coordinator.drain();
    const repeated = getIntelligenceStatus(db, CONNECTION_ID);
    expect(repeated).toMatchObject({ status: "complete", changedObjects: 0 });
    expect(
      (
        db
          .prepare("SELECT count(*) AS count FROM intelligence_objects WHERE connection_id = ?")
          .get(CONNECTION_ID) as { count: number }
      ).count,
    ).toBe(6);
  });

  it("resumes bounded work and persists snapshots and job health across a database restart", async () => {
    const temporaryPath = path.join(
      os.tmpdir(),
      `foundry-mcp-reconcile-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    db.close();
    db = openDatabase(temporaryPath);
    runMigrations(db);
    const bridge = new FakeReconciliationBridge();

    let status = await new IntelligenceReconciler(db, bridge, { documentBudget: 1 }).reconcile(
      CONNECTION_ID,
      "initial",
    );
    expect(status.status).toBe("incomplete");
    expect(status.queueDepth).toBeGreaterThan(0);
    expect(status).toMatchObject({ gap: false, truncated: false });

    for (let attempt = 0; attempt < 30 && status.status !== "complete"; attempt += 1) {
      status = await new IntelligenceReconciler(db, bridge, { documentBudget: 1 }).reconcile(
        CONNECTION_ID,
        "reconnect",
      );
    }
    expect(status).toMatchObject({ status: "complete", indexedObjects: 6, gap: false });
    db.close();
    db = openDatabase(temporaryPath);
    runMigrations(db);

    expect(getIntelligenceStatus(db, CONNECTION_ID)).toMatchObject({
      status: "complete",
      indexedObjects: 6,
      gap: false,
    });
    expect(
      searchIntelligence(db, { connectionId: CONNECTION_ID, query: "compendium-visible" }),
    ).toHaveLength(1);
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const candidate = temporaryPath + suffix;
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  it("reports traversal gaps and preserves stale snapshots until a gap-free pass", async () => {
    const bridge = new FakeReconciliationBridge();
    const reconciler = new IntelligenceReconciler(db, bridge);
    await reconciler.reconcile(CONNECTION_ID, "initial");
    const removedIndex = bridge.roots.findIndex(({ uuid }) => uuid === "Actor.wyrm");
    bridge.roots.splice(removedIndex, 1);
    bridge.truncateEmbedded = true;

    expect(await reconciler.reconcile(CONNECTION_ID, "reconnect")).toMatchObject({
      status: "complete",
      gap: true,
      truncated: true,
    });
    expect(
      searchIntelligence(db, { connectionId: CONNECTION_ID, query: "preexisting-npc" }),
    ).toHaveLength(1);

    bridge.truncateEmbedded = false;
    expect(await reconciler.reconcile(CONNECTION_ID, "periodic")).toMatchObject({
      status: "complete",
      gap: false,
      truncated: false,
    });
    expect(
      searchIntelligence(db, { connectionId: CONNECTION_ID, query: "preexisting-npc" }),
    ).toEqual([]);
  });

  it("schedules configured event retention and exposes durable retention health", () => {
    ingestEventEnvelope(
      db,
      CONNECTION_ID,
      {
        sequenceId: 1,
        category: "document.update.Actor",
        payload: { uuid: "Actor.old" },
        emittedAt: "2026-01-01T00:00:00.000Z",
      },
      {},
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    const coordinator = new IntelligenceCoordinator(
      db,
      new IntelligenceReconciler(db, new FakeReconciliationBridge()),
      {
        retentionDays: 30,
        now: () => new Date("2026-03-01T00:00:00.000Z"),
      },
    );

    expect(coordinator.runRetention()).toBe(1);
    expect(getIntelligenceStatus(db, CONNECTION_ID)).toMatchObject({
      lastRetentionAt: "2026-03-01T00:00:00.000Z",
      retentionRemovedEvents: 1,
    });
    expect(
      (db.prepare("SELECT count(*) AS count FROM events").get() as { count: number }).count,
    ).toBe(0);
  });

  it("aborts active reconciliation so coordinator shutdown drains cleanly", async () => {
    let receivedSignal: AbortSignal | undefined;
    let requestCount = 0;
    let markRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const bridge: ReconciliationBridge = {
      request: (_connectionId, _method, _params, _requestId, options) => {
        requestCount += 1;
        receivedSignal = options?.signal;
        markRequestStarted?.();
        return new Promise<JsonValue>((_resolve, reject) => {
          const rejectCancelled = (): void => reject(new Error("reconciliation cancelled"));
          if (receivedSignal?.aborted) {
            rejectCancelled();
            return;
          }
          receivedSignal?.addEventListener("abort", rejectCancelled, { once: true });
        });
      },
    };
    const reconciler = new IntelligenceReconciler(db, bridge);
    const initialOperation = reconciler.reconcile(CONNECTION_ID, "manual");
    await requestStarted;
    const coordinator = new IntelligenceCoordinator(db, reconciler, {
      retentionDays: 30,
    });

    coordinator.updateConnections([CONNECTION_ID]);
    coordinator.stop();
    coordinator.updateConnections([CONNECTION_ID]);
    await coordinator.drain();
    await initialOperation;

    expect(receivedSignal?.aborted).toBe(true);
    expect(requestCount).toBe(1);
    expect(getIntelligenceStatus(db, CONNECTION_ID)).toMatchObject({
      status: "failed",
      gap: true,
      truncated: true,
    });
  });
});
