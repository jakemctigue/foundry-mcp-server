import { describe, expect, it, vi } from "vitest";

import { MAX_PAGE_SIZE, makeError, type OperationResult } from "@foundry-mcp/protocol";
import { FoundryDocumentService, sourceHash } from "../src/documents.js";
import { BrowserFoundryRuntime } from "../src/runtime.js";
import { FakeFoundryRuntime, FakeRole, createRichFakeRuntime } from "./fake-runtime/index.js";

function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function allPages(
  service: FoundryDocumentService,
  type: string,
  pageSize: number,
): Promise<string[]> {
  const uuids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = unwrap(
      await service.list({
        type,
        pageSize,
        ...(cursor ? { cursor } : {}),
      }),
    );
    uuids.push(...page.items.map((item) => item.uuid));
    cursor = page.nextCursor;
  } while (cursor);
  return uuids;
}

describe("FoundryDocumentService type discovery", () => {
  it("exports canonical source for hydrated compendiums and UUID reads", async () => {
    const source = {
      _id: "spell-source",
      name: "Source Spell",
      type: "spell",
      img: "icons/magic/fire/projectile-fireball-smoke-orange.webp",
      system: {
        properties: ["vocal", "somatic"],
        activities: {
          cast: {
            type: "save",
            save: { dc: { calculation: "spellcasting", formula: "" } },
            damage: { parts: [{ number: 2, denomination: 6, types: ["fire"] }] },
          },
        },
      },
    };
    const transformed = {
      ...source,
      system: { ...source.system, properties: new Set(source.system.properties), derivedDc: 17 },
    };
    const toObject = vi.fn((useSource: boolean) => (useSource ? source : transformed));
    const raw = {
      id: source._id,
      uuid: `Compendium.world.spells.Item.${source._id}`,
      documentName: "Item",
      type: "spell",
      pack: "world.spells",
      toObject,
    };
    const runtime = new BrowserFoundryRuntime({
      game: {
        ready: true,
        user: { isGM: true },
        packs: new Map([
          [
            raw.pack,
            {
              collection: raw.pack,
              documentName: "Item",
              visible: true,
              locked: true,
              getDocuments: async () => [raw],
            },
          ],
        ]),
      },
      foundry: { utils: { parseUuid: (uuid: string) => ({ uuid }) } },
      fromUuid: async () => raw,
    });
    expect((await runtime.fromUuid(raw.uuid))?.toObject()).toBe(source);

    const service = new FoundryDocumentService(runtime);
    const hydrated = unwrap(
      await service.compendiumDocumentsList({ packId: raw.pack, hydrate: true }),
    );
    const document = unwrap(await service.get({ uuid: raw.uuid }));
    for (const view of [hydrated.items[0], document]) {
      expect(view).toMatchObject({ data: source, sourceHash: sourceHash(source) });
      expect(view).not.toHaveProperty("data.system.derivedDc");
      expect(JSON.parse(JSON.stringify(view))).toHaveProperty("data.system.properties", [
        "vocal",
        "somatic",
      ]);
    }
    expect(toObject).toHaveBeenCalledWith(true);
    expect(toObject.mock.calls.every(([useSource]) => useSource === true)).toBe(true);
  });

  it("adapts Foundry globals structurally without a compiled-in Document registry", async () => {
    const rawDocument = {
      id: "actor-a",
      uuid: "Actor.actor-a",
      documentName: "Actor",
      type: "stellar",
      ownership: { default: 1 },
      toObject: () => ({
        _id: "actor-a",
        name: "Stellar Actor",
        type: "stellar",
        system: { runtimeOnly: 9 },
      }),
      testUserPermission: () => true,
      canUserModify: () => true,
      update: async () => rawDocument,
      delete: async () => undefined,
    };
    const documentClass = {
      documentName: "Actor",
      metadata: { name: "Actor", collection: "actors", schemaVersion: "14" },
      canUserCreate: () => true,
      create: async () => rawDocument,
    };
    const globals = {
      game: {
        ready: true,
        user: { isGM: true },
        documentTypes: { Actor: ["stellar", "voidborn"] },
        collections: new Map([
          ["Actor", { documentName: "Actor", documentClass, contents: [rawDocument] }],
        ]),
        packs: new Map(),
        system: { version: "1.2.3" },
      },
      CONFIG: { Actor: { documentClass } },
      foundry: { utils: { parseUuid: (uuid: string) => ({ uuid }) } },
      fromUuid: async (uuid: string) => (uuid === rawDocument.uuid ? rawDocument : null),
      Hooks: { callAll: () => undefined },
    };
    const service = new FoundryDocumentService(new BrowserFoundryRuntime(globals));
    const types = unwrap(await service.types()).types;
    expect(types).toHaveLength(1);
    expect(types[0]?.subtypes.map((subtype) => subtype.subtype)).toEqual(["stellar", "voidborn"]);
    expect(unwrap(await service.list({ type: "Actor" })).items[0]).toMatchObject({
      uuid: "Actor.actor-a",
      subtype: "stellar",
    });
    expect(unwrap(await service.get({ uuid: "Actor.actor-a" })).data.system).toEqual({
      runtimeOnly: 9,
    });
  });

  it("reports empty and single-type runtimes without a built-in type list", async () => {
    expect(
      unwrap(await new FoundryDocumentService(new FakeFoundryRuntime()).types()).types,
    ).toEqual([]);

    const runtime = new FakeFoundryRuntime().registerDocumentType("Constellation", {
      collection: "constellations",
      subtypes: { aurora: { label: "Aurora" } },
    });
    const output = unwrap(await new FoundryDocumentService(runtime).types());
    expect(output.types.map((entry) => entry.type)).toEqual(["Constellation"]);
    expect(output.types[0]?.subtypes.map((entry) => entry.subtype)).toEqual(["aurora"]);
  });

  it("reports every runtime Actor and Item subtype, including forbidden reasons", async () => {
    const runtime = new FakeFoundryRuntime(FakeRole.PLAYER)
      .registerDocumentType("Actor", {
        collection: "actors",
        subtypes: {
          "system-alpha": {},
          "system-beta": { minCreateRole: FakeRole.GAMEMASTER },
        },
      })
      .registerDocumentType("Item", {
        collection: "items",
        embedded: true,
        parentTypes: ["Actor"],
        subtypes: { "system-gamma": {}, "system-delta": {} },
      });
    const types = unwrap(await new FoundryDocumentService(runtime).types()).types;
    expect(
      types.find((entry) => entry.type === "Actor")?.subtypes.map((entry) => entry.subtype),
    ).toEqual(["system-alpha", "system-beta"]);
    expect(types.find((entry) => entry.type === "Item")?.subtypes).toHaveLength(2);
    for (const type of types) {
      expect(type.creatable).toBe(false);
      expect(type.reason).toBeTypeOf("string");
      for (const subtype of type.subtypes) {
        expect(subtype.creatable).toBe(false);
        expect(subtype.reason).toBeTypeOf("string");
      }
    }
  });
});

describe("FoundryDocumentService listing and UUID reads", () => {
  it("walks stable cursor pages without gaps or duplicates and supports projection/filter/sort", async () => {
    const runtime = createRichFakeRuntime();
    for (let index = 0; index < 7; index += 1) {
      runtime.seedDocument("Actor", {
        name: `Actor ${String.fromCharCode(71 - index)}`,
        type: index % 2 === 0 ? "stormborn" : "clockwork",
        folder: index < 4 ? "folder-a" : null,
        system: { unknownField: { index, preserved: true } },
      });
    }
    const service = new FoundryDocumentService(runtime);
    const uuids = await allPages(service, "Actor", 2);
    expect(uuids).toHaveLength(7);
    expect(new Set(uuids).size).toBe(7);
    expect(uuids).toEqual([...uuids].sort());

    const filtered = unwrap(
      await service.list({
        type: "Actor",
        subtype: "stormborn",
        folder: "folder-a",
        nameFilter: "actor",
        fields: ["system.unknownField.index"],
        sort: { field: "name", direction: "asc" },
      }),
    );
    expect(filtered.items).toHaveLength(2);
    expect(filtered.items[0]?.data).toEqual({ system: { unknownField: { index: 2 } } });

    const invalid = await service.list({ type: "Actor", pageSize: MAX_PAGE_SIZE + 1 });
    expect(invalid).toMatchObject({ ok: false, error: { code: "INVALID_DATA" } });
  });

  it("reads root and embedded UUIDs through runtime parseUuid/fromUuid and never returns prototypes", async () => {
    const runtime = createRichFakeRuntime();
    const actor = runtime.seedDocument("Actor", {
      name: "Root",
      type: "stormborn",
      system: { custom: { value: 42 } },
    });
    const item = runtime.seedDocument(
      "Item",
      { name: "Embedded", type: "rune", system: { arbitrary: "kept" } },
      { parentUuid: actor.uuid },
    );
    const service = new FoundryDocumentService(runtime);
    const root = unwrap(await service.get({ uuid: actor.uuid }));
    const embedded = unwrap(await service.get({ uuid: item.uuid }));
    expect(root.parent).toBeUndefined();
    expect(embedded.parent).toEqual({ uuid: actor.uuid, type: "Actor" });
    expect(embedded.data.system).toEqual({ arbitrary: "kept" });
    expect(Object.getPrototypeOf(embedded.data)).toBe(Object.prototype);
    expect(await service.get({ uuid: "Actor.missing" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("honors Foundry visibility for Player, Trusted, Assistant, and GM fixtures", async () => {
    for (const role of [
      FakeRole.PLAYER,
      FakeRole.TRUSTED,
      FakeRole.ASSISTANT,
      FakeRole.GAMEMASTER,
    ]) {
      const runtime = createRichFakeRuntime(role);
      runtime.seedDocument(
        "Actor",
        { name: "Public", type: "stormborn" },
        { minReadRole: FakeRole.PLAYER },
      );
      runtime.seedDocument(
        "Actor",
        { name: "GM Secret", type: "clockwork" },
        { minReadRole: FakeRole.GAMEMASTER },
      );
      const listed = unwrap(await new FoundryDocumentService(runtime).list({ type: "Actor" }));
      expect(listed.items.map((item) => item.name)).toEqual(
        role === FakeRole.GAMEMASTER ? ["Public", "GM Secret"] : ["Public"],
      );
    }
  });
});

describe("FoundryDocumentService generic create and update", () => {
  it("uses a versioned SHA-256 source hash and requires legacy clients to refresh", async () => {
    expect(sourceHash({})).toBe(
      "fmcp-v2-44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );

    const runtime = createRichFakeRuntime();
    const actor = runtime.seedDocument("Actor", { name: "Hash fixture", type: "stormborn" });
    const service = new FoundryDocumentService(runtime);
    const before = unwrap(await service.get({ uuid: actor.uuid }));
    expect(before.sourceHash).toMatch(/^fmcp-v2-[0-9a-f]{64}$/);

    expect(
      await service.update({
        uuid: actor.uuid,
        data: { name: "Must refetch" },
        expectedHash: "fmcp-v1-00000000",
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "CONFLICT",
        details: { reason: "hash_algorithm_upgraded", actual: before.sourceHash },
      },
    });
    expect(unwrap(await service.get({ uuid: actor.uuid })).name).toBe("Hash fixture");
  });

  it("creates every discovered Actor/Item subtype, world Items, and Actor embedded Items", async () => {
    const runtime = createRichFakeRuntime();
    const service = new FoundryDocumentService(runtime);
    const types = unwrap(await service.types()).types;
    const actorType = types.find((entry) => entry.type === "Actor");
    const itemType = types.find((entry) => entry.type === "Item");
    expect(actorType?.subtypes).toHaveLength(2);
    expect(itemType?.subtypes).toHaveLength(2);

    const actorUuids: string[] = [];
    for (const subtype of actorType?.subtypes ?? []) {
      const created = unwrap(
        await service.create({
          type: "Actor",
          data: {
            name: `Actor ${subtype.subtype}`,
            type: subtype.subtype,
            system: { arbitrary: { subtype: subtype.subtype } },
          },
        }),
      );
      const result = created.results[0];
      expect(result?.status).toBe("created");
      if (result?.status === "created") actorUuids.push(result.document.uuid);
    }
    for (const subtype of itemType?.subtypes ?? []) {
      const world = unwrap(
        await service.create({
          type: "Item",
          data: {
            name: `World ${subtype.subtype}`,
            type: subtype.subtype,
            system: { opaque: "world" },
          },
        }),
      );
      expect(world.results[0]?.status).toBe("created");
      const embedded = unwrap(
        await service.create({
          type: "Item",
          parentUuid: actorUuids[0],
          data: {
            name: `Embedded ${subtype.subtype}`,
            type: subtype.subtype,
            system: { opaque: "embedded" },
          },
        }),
      );
      expect(embedded.results[0]?.status).toBe("created");
    }
    expect(unwrap(await service.list({ type: "Actor" })).items).toHaveLength(2);
    expect(unwrap(await service.list({ type: "Item" })).items).toHaveLength(2);
    expect(
      unwrap(
        await service.embeddedList({
          parentUuid: actorUuids[0],
          embeddedType: "Item",
          maxDepth: 1,
        }),
      ).items,
    ).toHaveLength(2);
  });

  it("creates every runtime Actor and Item subtype directly in writable compendiums", async () => {
    const runtime = createRichFakeRuntime()
      .addCompendium({
        id: "world.actors",
        label: "Writable Actors",
        type: "Actor",
        documents: [],
      })
      .addCompendium({
        id: "world.items",
        label: "Writable Items",
        type: "Item",
        documents: [],
      })
      .addCompendium({
        id: "world.locked",
        label: "Locked Actors",
        type: "Actor",
        locked: true,
        documents: [],
      })
      .addCompendium({
        id: "world.denied",
        label: "Denied Items",
        type: "Item",
        writable: false,
        writeReason: "The test user cannot write this pack",
        documents: [],
      });
    const service = new FoundryDocumentService(runtime);
    const types = unwrap(await service.types()).types;
    const createdUuids: string[] = [];

    for (const type of ["Actor", "Item"] as const) {
      const packId = type === "Actor" ? "world.actors" : "world.items";
      const discovered = types.find((entry) => entry.type === type);
      expect(discovered?.subtypes.length).toBeGreaterThan(0);
      for (const subtype of discovered?.subtypes ?? []) {
        const output = unwrap(
          await service.create({
            type,
            packId,
            data: {
              name: `${type} ${subtype.subtype}`,
              type: subtype.subtype,
              system: { runtimeField: { preserved: subtype.subtype } },
            },
          }),
        );
        const result = output.results[0];
        expect(result?.status).toBe("created");
        if (result?.status === "created") {
          expect(result.document.pack?.id).toBe(packId);
          createdUuids.push(result.document.uuid);
        }
      }
    }

    const packs = unwrap(await service.compendiumsList()).packs;
    expect(packs.find((pack) => pack.id === "world.actors")).toMatchObject({
      documentCount: 2,
      writable: true,
    });
    expect(packs.find((pack) => pack.id === "world.items")).toMatchObject({
      documentCount: 2,
      writable: true,
    });
    expect(packs.find((pack) => pack.id === "world.locked")).toMatchObject({
      locked: true,
      writable: false,
      writeReason: expect.stringContaining("locked"),
    });
    expect(packs.find((pack) => pack.id === "world.denied")).toMatchObject({
      writable: false,
      writeReason: "The test user cannot write this pack",
    });

    const actorIndex = unwrap(
      await service.compendiumDocumentsList({ packId: "world.actors", hydrate: false }),
    );
    expect(actorIndex.items).toHaveLength(2);
    expect(actorIndex.items.every((item) => !("data" in item))).toBe(true);
    const hydratedItems = unwrap(
      await service.compendiumDocumentsList({ packId: "world.items", hydrate: true }),
    );
    expect(hydratedItems.items).toHaveLength(2);
    expect(hydratedItems.items[0]).toHaveProperty("data.system.runtimeField.preserved");
    for (const uuid of createdUuids) {
      expect(unwrap(await service.get({ uuid })).data.system).toHaveProperty("runtimeField");
    }

    for (const [packId, type] of [
      ["world.locked", "Actor"],
      ["world.denied", "Item"],
    ] as const) {
      expect(
        await service.create({
          type,
          packId,
          data: {
            name: "Must not be created",
            type: type === "Actor" ? "stormborn" : "rune",
          },
        }),
      ).toMatchObject({
        ok: true,
        value: {
          committed: false,
          results: [
            {
              status: "error",
              error: { code: "PERMISSION_DENIED", details: { packId } },
            },
          ],
        },
      });
      expect(
        unwrap(await service.compendiumDocumentsList({ packId, hydrate: true })).items,
      ).toHaveLength(0);
    }
    expect(
      await service.create({
        type: "Item",
        packId: "world.actors",
        data: { name: "Wrong pack", type: "rune" },
      }),
    ).toMatchObject({
      ok: true,
      value: { results: [{ status: "error", error: { code: "UNSUPPORTED_TYPE" } }] },
    });
  });

  it("validates world, embedded, compendium, and update dry-runs without side effects", async () => {
    const runtime = createRichFakeRuntime().addCompendium({
      id: "world.actors",
      label: "Writable Actors",
      type: "Actor",
      documents: [],
    });
    const actor = runtime.seedDocument("Actor", {
      name: "Existing",
      type: "stormborn",
      system: { preserved: true },
    });
    const pack = await runtime.getCompendium("world.actors");
    if (!pack) throw new Error("Expected writable fake compendium");
    const createWorld = vi.spyOn(runtime, "createDocument");
    const createPacked = vi.spyOn(pack, "createDocument");
    const update = vi.spyOn(runtime, "updateDocument");
    const snapshot = vi.spyOn(runtime, "snapshotState");
    const markCommitted = vi.fn();
    const service = new FoundryDocumentService(runtime);

    const create = unwrap(
      await service.create(
        {
          atomic: true,
          dryRun: true,
          items: [
            { type: "Actor", data: { name: "World", type: "clockwork" } },
            {
              type: "Item",
              parentUuid: actor.uuid,
              data: { name: "Embedded", type: "rune" },
            },
            {
              type: "Actor",
              packId: "world.actors",
              data: { name: "Packed", type: "stormborn" },
            },
          ],
        },
        { markCommitted },
      ),
    );
    expect(create).toMatchObject({ atomic: true, dryRun: true, committed: false });
    expect(
      create.results.map((result) =>
        result.status === "validated"
          ? {
              status: result.status,
              target: result.validation.target,
              schemaValidated: result.validation.schemaValidated,
            }
          : { status: result.status },
      ),
    ).toEqual([
      { status: "validated", target: "world", schemaValidated: true },
      { status: "validated", target: "embedded", schemaValidated: true },
      { status: "validated", target: "compendium", schemaValidated: true },
    ]);
    expect(createWorld).not.toHaveBeenCalled();
    expect(createPacked).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(markCommitted).not.toHaveBeenCalled();
    expect(unwrap(await service.list({ type: "Actor" })).items).toHaveLength(1);
    expect(
      unwrap(
        await service.embeddedList({ parentUuid: actor.uuid, embeddedType: "Item", maxDepth: 1 }),
      ).items,
    ).toHaveLength(0);
    expect(
      unwrap(await service.compendiumDocumentsList({ packId: "world.actors", hydrate: true }))
        .items,
    ).toHaveLength(0);

    expect(
      unwrap(
        await service.create({
          type: "Actor",
          data: { name: "", type: "stormborn" },
          dryRun: true,
        }),
      ),
    ).toMatchObject({
      dryRun: true,
      committed: false,
      results: [{ status: "error", error: { code: "INVALID_DATA" } }],
    });
    expect(createWorld).not.toHaveBeenCalled();

    const before = unwrap(await service.get({ uuid: actor.uuid }));
    const auditCount = runtime.auditEvents.length;
    const updateDryRun = unwrap(
      await service.update(
        {
          uuid: actor.uuid,
          data: { name: "Would change" },
          expectedHash: before.sourceHash,
          dryRun: true,
        },
        { markCommitted },
      ),
    );
    expect(updateDryRun).toMatchObject({
      uuid: actor.uuid,
      dryRun: true,
      committed: false,
      document: { name: "Existing" },
      validation: {
        valid: true,
        operation: "update",
        target: "world",
        schemaValidated: true,
      },
    });
    expect(update).not.toHaveBeenCalled();
    expect(markCommitted).not.toHaveBeenCalled();
    expect(runtime.auditEvents).toHaveLength(auditCount);
    expect(unwrap(await service.get({ uuid: actor.uuid })).data).toEqual(before.data);
    expect(
      await service.update({
        uuid: actor.uuid,
        data: { name: "" },
        expectedHash: before.sourceHash,
        dryRun: true,
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_DATA" } });
    expect(update).not.toHaveBeenCalled();
    expect(unwrap(await service.get({ uuid: actor.uuid })).data).toEqual(before.data);
  });

  it("uses Foundry's runtime document class for direct compendium creates", async () => {
    const rawCreated = {
      id: "packed-a",
      uuid: "Compendium.world.actors.Actor.packed-a",
      documentName: "Actor",
      type: "stellar",
      pack: "world.actors",
      ownership: { default: 0 },
      toObject: () => ({ _id: "packed-a", name: "Packed", type: "stellar" }),
      testUserPermission: () => true,
      canUserModify: () => true,
    };
    const create = vi.fn(async () => rawCreated);
    const documentClass = {
      documentName: "Actor",
      metadata: { name: "Actor", collection: "actors", schemaVersion: "14" },
      canUserCreate: () => true,
      create,
    };
    const pack = {
      collection: "world.actors",
      documentName: "Actor",
      documentClass,
      metadata: { label: "Actors", type: "Actor" },
      locked: false,
      visible: true,
      size: 0,
      index: [],
      canUserModify: () => true,
      getIndex: async () => [],
      getDocuments: async () => [rawCreated],
    };
    const runtime = new BrowserFoundryRuntime({
      game: {
        ready: true,
        user: { isGM: true },
        documentTypes: { Actor: ["stellar"] },
        collections: new Map([["Actor", { documentName: "Actor", documentClass, contents: [] }]]),
        packs: new Map([["world.actors", pack]]),
      },
      CONFIG: { Actor: { documentClass } },
      foundry: { utils: { parseUuid: (uuid: string) => ({ uuid }) } },
      fromUuid: async (uuid: string) => (uuid === rawCreated.uuid ? rawCreated : null),
    });
    const service = new FoundryDocumentService(runtime);
    const output = unwrap(
      await service.create({
        type: "Actor",
        packId: "world.actors",
        data: { name: "Packed", type: "stellar" },
      }),
    );
    expect(output.results[0]).toMatchObject({
      status: "created",
      document: { uuid: rawCreated.uuid, packId: "world.actors" },
    });
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      { name: "Packed", type: "stellar" },
      { pack: "world.actors", renderSheet: false },
    );
    expect(unwrap(await service.get({ uuid: rawCreated.uuid })).name).toBe("Packed");
  });

  it("reports partial batch results explicitly and rolls back an atomic runtime failure", async () => {
    const runtime = createRichFakeRuntime();
    const service = new FoundryDocumentService(runtime);
    const partial = unwrap(
      await service.create({
        items: [
          { type: "Actor", data: { name: "Valid", type: "stormborn" } },
          { type: "NotRegistered", data: { name: "Invalid" } },
        ],
      }),
    );
    expect(partial).toMatchObject({
      atomic: false,
      committed: false,
      results: [{ status: "created" }, { status: "error", error: { code: "UNSUPPORTED_TYPE" } }],
    });
    expect(unwrap(await service.list({ type: "Actor" })).items.map((item) => item.name)).toContain(
      "Valid",
    );

    const before = unwrap(await service.list({ type: "Actor" })).items.length;
    runtime.failCreateOnCall(2);
    const atomic = unwrap(
      await service.create({
        atomic: true,
        items: [
          { type: "Actor", data: { name: "Atomic A", type: "stormborn" } },
          { type: "Actor", data: { name: "Atomic B", type: "clockwork" } },
        ],
      }),
    );
    expect(atomic.committed).toBe(false);
    expect(atomic.results[0]?.status).toBe("rolled_back");
    expect(unwrap(await service.list({ type: "Actor" })).items).toHaveLength(before);
  });

  it("rejects atomic browser batches before any create when transactions are unsupported", async () => {
    const create = vi.fn(async () => {
      throw new Error("must not create");
    });
    const documentClass = {
      documentName: "Actor",
      metadata: { name: "Actor", collection: "actors", schemaVersion: "14" },
      canUserCreate: () => true,
      create,
    };
    const runtime = new BrowserFoundryRuntime({
      game: {
        ready: true,
        user: { isGM: true },
        documentTypes: { Actor: ["stellar"] },
        collections: new Map([["Actor", { documentName: "Actor", documentClass, contents: [] }]]),
        packs: new Map(),
      },
      CONFIG: { Actor: { documentClass } },
    });

    expect(
      await new FoundryDocumentService(runtime).create({
        atomic: true,
        items: [
          { type: "Actor", data: { name: "Atomic A", type: "stellar" } },
          { type: "Actor", data: { name: "Atomic B", type: "stellar" } },
        ],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_TYPE", message: expect.stringContaining("Atomic") },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns structured detail when a supported atomic rollback fails", async () => {
    const runtime = createRichFakeRuntime();
    runtime.failCreateOnCall(2);
    runtime.restoreState = () => {
      throw new Error("Injected rollback failure");
    };
    const service = new FoundryDocumentService(runtime);

    expect(
      await service.create({
        atomic: true,
        items: [
          { type: "Actor", data: { name: "Atomic A", type: "stormborn" } },
          { type: "Actor", data: { name: "Atomic B", type: "clockwork" } },
        ],
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "FOUNDRY_ERROR",
        message: "Atomic batch rollback failed",
        details: {
          partialSideEffectsPossible: true,
          createdIndexes: [0],
          createError: { code: "FOUNDRY_ERROR", message: "Injected create failure" },
          rollbackError: { code: "FOUNDRY_ERROR", message: "Injected rollback failure" },
        },
      },
    });
  });

  it("enforces optimistic hashes, records forced waivers, and preserves unknown fields", async () => {
    const runtime = createRichFakeRuntime();
    const actor = runtime.seedDocument("Actor", {
      name: "Before",
      type: "clockwork",
      system: { unknown: { nested: 7 }, untouched: true },
    });
    const item = runtime.seedDocument("Item", {
      name: "World Item",
      type: "relic",
      system: { unknownWorldItem: "keep" },
    });
    const embedded = runtime.seedDocument(
      "Item",
      { name: "Embedded Item", type: "rune", system: { unknownEmbedded: "keep" } },
      { parentUuid: actor.uuid },
    );
    const service = new FoundryDocumentService(runtime);

    for (const uuid of [actor.uuid, item.uuid, embedded.uuid]) {
      const before = unwrap(await service.get({ uuid }));
      const updated = unwrap(
        await service.update({
          uuid,
          data: { name: `${before.name} Updated` },
          expectedHash: before.sourceHash,
        }),
      );
      expect(updated.sourceHash).not.toBe(before.sourceHash);
      expect(updated.document.data.system).toEqual(before.data.system);
    }

    const current = unwrap(await service.get({ uuid: actor.uuid }));
    const conflict = await service.update({
      uuid: actor.uuid,
      data: { name: "Must Not Apply" },
      expectedHash: "stale-hash",
    });
    expect(conflict).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(unwrap(await service.get({ uuid: actor.uuid })).name).toBe(current.name);

    const forced = unwrap(
      await service.update({
        uuid: actor.uuid,
        data: { name: "Forced" },
        forceOverwrite: true,
      }),
    );
    expect(forced.forced).toBe(true);
    expect(runtime.auditEvents).toContainEqual({
      action: "document.update",
      uuid: actor.uuid,
      forced: true,
    });
  });

  it("denies non-GM mutation without changing the stored object", async () => {
    const runtime = createRichFakeRuntime(FakeRole.PLAYER);
    const actor = runtime.seedDocument("Actor", {
      name: "Original",
      type: "stormborn",
      system: { kept: true },
    });
    const service = new FoundryDocumentService(runtime);
    const before = unwrap(await service.get({ uuid: actor.uuid }));
    expect(
      await service.create({ type: "Actor", data: { name: "Denied", type: "stormborn" } }),
    ).toMatchObject({
      ok: true,
      value: { results: [{ status: "error", error: { code: "PERMISSION_DENIED" } }] },
    });
    expect(
      await service.update({
        uuid: actor.uuid,
        data: { name: "Denied" },
        expectedHash: before.sourceHash,
      }),
    ).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(unwrap(await service.get({ uuid: actor.uuid })).data).toEqual(before.data);
  });
});

describe("FoundryDocumentService embedded and compendium enumeration", () => {
  it("lists direct embedded types and reports recursive depth truncation", async () => {
    const runtime = createRichFakeRuntime();
    const actor = runtime.seedDocument("Actor", { name: "Parent", type: "stormborn" });
    const item = runtime.seedDocument(
      "Item",
      { name: "Child", type: "rune" },
      { parentUuid: actor.uuid },
    );
    const attachment = runtime.seedDocument(
      "Attachment",
      { name: "Grandchild" },
      { parentUuid: item.uuid },
    );
    runtime.seedDocument(
      "Annotation",
      { name: "Great-grandchild" },
      { parentUuid: attachment.uuid },
    );
    const service = new FoundryDocumentService(runtime);

    const direct = unwrap(
      await service.embeddedList({
        parentUuid: actor.uuid,
        embeddedType: "Item",
        recursive: false,
        maxDepth: 1,
      }),
    );
    expect(direct.items).toHaveLength(1);
    expect(direct.items[0]).toMatchObject({ parentUuid: actor.uuid, subtype: "rune", depth: 1 });

    const bounded = unwrap(
      await service.embeddedList({
        parentUuid: actor.uuid,
        recursive: true,
        maxDepth: 2,
      }),
    );
    expect(bounded.items.map((entry) => entry.depth)).toEqual([1, 2]);
    expect(bounded).toMatchObject({
      truncated: true,
      truncationReason: expect.stringContaining("maxDepth"),
    });
  });

  it("lists readable locked packs while preserving their write lock", async () => {
    const runtime = createRichFakeRuntime()
      .addCompendium({
        id: "world.actors",
        label: "Actors",
        type: "Actor",
        documents: [
          { name: "Packed Stormborn", type: "stormborn", system: { packed: 1 } },
          { name: "Packed Clockwork", type: "clockwork", system: { packed: 2 } },
        ],
      })
      .addCompendium({
        id: "world.items",
        label: "Items",
        type: "Item",
        documents: [
          { name: "Packed Rune", type: "rune" },
          { name: "Packed Relic", type: "relic" },
        ],
      })
      .addCompendium({
        id: "world.locked",
        label: "Locked",
        type: "Actor",
        locked: true,
        documents: [{ name: "Hidden", type: "stormborn" }],
      });
    const service = new FoundryDocumentService(runtime);
    const packs = unwrap(await service.compendiumsList()).packs;
    expect(packs.map((pack) => pack.id)).toEqual(["world.actors", "world.items", "world.locked"]);
    expect(packs.map((pack) => pack.documentCount)).toEqual([2, 2, 1]);

    const index = unwrap(
      await service.compendiumDocumentsList({
        packId: "world.actors",
        hydrate: false,
        pageSize: 1,
      }),
    );
    expect(index.hydrated).toBe(false);
    expect(index.items[0]).not.toHaveProperty("data");
    expect(index.nextCursor).toBeTypeOf("string");

    const hydrated = unwrap(
      await service.compendiumDocumentsList({ packId: "world.actors", hydrate: true }),
    );
    expect(hydrated.items).toHaveLength(2);
    expect(hydrated.items[0]).toHaveProperty("data.system.packed");
    const locked = unwrap(
      await service.compendiumDocumentsList({ packId: "world.locked", hydrate: true }),
    );
    expect(locked.items).toHaveLength(1);
    const lockedDocument = locked.items[0];
    expect(lockedDocument).toBeDefined();
    if (!lockedDocument || !("sourceHash" in lockedDocument)) {
      throw new Error("Expected the hydrated locked pack fixture");
    }
    expect(lockedDocument.pack).toEqual({
      id: "world.locked",
      label: "Locked",
      locked: true,
    });
    expect(
      await service.update({
        uuid: lockedDocument.uuid,
        data: { name: "Must remain hidden" },
        expectedHash: lockedDocument.sourceHash,
      }),
    ).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(unwrap(await service.get({ uuid: lockedDocument.uuid })).name).toBe("Hidden");
    expect(
      await service.create({
        type: "Actor",
        parentUuid: "Compendium.world.locked.Actor.actor-0001",
        data: { name: "No write", type: "stormborn" },
      }),
    ).toMatchObject({ ok: true, value: { results: [{ status: "error" }] } });
  });

  it("keeps resolvable Foundry v14 compendium index UUIDs across every fallback", async () => {
    const indexedUuid = "Compendium.world.indexed.Actor.indexed";
    const helperUuid = "Compendium.world.helper.Actor.helper";
    const constructedUuid = "Compendium.world.constructed.Actor.constructed";
    const rawDocuments = new Map(
      [
        ["indexed", indexedUuid, "Indexed Actor", "world.indexed"],
        ["helper", helperUuid, "Helper Actor", "world.helper"],
        ["constructed", constructedUuid, "Constructed Actor", "world.constructed"],
      ].map(([id, uuid, name, pack]) => [
        uuid,
        {
          id,
          uuid,
          documentName: "Actor",
          type: "npc",
          pack,
          ownership: { default: 0 },
          toObject: () => ({ _id: id, name, type: "npc" }),
          testUserPermission: () => true,
          canUserModify: () => true,
        },
      ]),
    );
    const documentClass = {
      documentName: "Actor",
      metadata: { name: "Actor", collection: "actors", schemaVersion: "14" },
      canUserCreate: () => true,
    };
    const indexedGetUuid = vi.fn(() => "Compendium.wrong.Actor.wrong");
    const helperGetUuid = vi.fn((id: string) => `Compendium.world.helper.Actor.${id}`);
    const makePack = (
      collection: string,
      entry: Record<string, unknown>,
      getUuid?: (id: string) => string,
    ) => ({
      collection,
      documentName: "Actor",
      documentClass,
      metadata: { label: collection, type: "Actor" },
      locked: false,
      visible: true,
      size: 1,
      index: [entry],
      canUserModify: () => true,
      getIndex: async () => [entry],
      getDocuments: async () => [],
      ...(getUuid ? { getUuid } : {}),
    });
    const runtime = new BrowserFoundryRuntime({
      game: {
        ready: true,
        user: { isGM: true },
        documentTypes: { Actor: ["npc"] },
        collections: new Map([["Actor", { documentName: "Actor", documentClass, contents: [] }]]),
        packs: new Map([
          [
            "world.indexed",
            makePack(
              "world.indexed",
              { _id: "indexed", uuid: indexedUuid, name: "Indexed Actor", type: "npc" },
              indexedGetUuid,
            ),
          ],
          [
            "world.helper",
            makePack(
              "world.helper",
              { _id: "helper", name: "Helper Actor", type: "npc" },
              helperGetUuid,
            ),
          ],
          [
            "world.constructed",
            makePack("world.constructed", {
              _id: "constructed",
              name: "Constructed Actor",
              type: "npc",
            }),
          ],
        ]),
      },
      CONFIG: { Actor: { documentClass } },
      foundry: { utils: { parseUuid: (uuid: string) => ({ uuid }) } },
      fromUuid: async (uuid: string) => rawDocuments.get(uuid) ?? null,
    });
    const service = new FoundryDocumentService(runtime);

    for (const [packId, expectedUuid, expectedName] of [
      ["world.indexed", indexedUuid, "Indexed Actor"],
      ["world.helper", helperUuid, "Helper Actor"],
      ["world.constructed", constructedUuid, "Constructed Actor"],
    ] as const) {
      const index = unwrap(await service.compendiumDocumentsList({ packId, hydrate: false }));
      expect(index.items).toEqual([
        expect.objectContaining({ uuid: expectedUuid, type: "Actor", name: expectedName }),
      ]);
      expect(unwrap(await service.get({ uuid: index.items[0]?.uuid ?? "" }))).toMatchObject({
        uuid: expectedUuid,
        type: "Actor",
        name: expectedName,
      });
    }
    expect(indexedGetUuid).not.toHaveBeenCalled();
    expect(helperGetUuid).toHaveBeenCalledOnce();
    expect(helperGetUuid).toHaveBeenCalledWith("helper");
  });
});

describe("FoundryDocumentService bounded snapshots and complete generic coverage", () => {
  it("walks every stable query cursor when maxItems exceeds the list page limit", async () => {
    const runtime = createRichFakeRuntime();
    const expectedUuids: string[] = [];
    for (let index = 0; index < 250; index += 1) {
      expectedUuids.push(
        runtime.seedDocument("Actor", {
          name: `Snapshot ${index.toString().padStart(3, "0")}`,
          type: "stormborn",
        }).uuid,
      );
    }
    const service = new FoundryDocumentService(runtime);
    const output = unwrap(
      await service.snapshot({
        query: { type: "Actor" },
        maxDepth: 4,
        maxItems: 500,
        maxBytes: 2_000_000,
      }),
    );
    const actualUuids = output.snapshot.map((item) =>
      item && typeof item === "object" && !Array.isArray(item) ? item.uuid : undefined,
    );

    expect(actualUuids).toEqual(expectedUuids);
    expect(output.itemCount).toBe(250);
    expect(output.truncated).toBe(false);
    expect(output.truncationReasons).not.toContain("maxItems");
  });

  it("stops query pagination at maxItems and reports the remaining stable page", async () => {
    const runtime = createRichFakeRuntime();
    for (let index = 0; index < 250; index += 1) {
      runtime.seedDocument("Actor", {
        name: `Snapshot ${index.toString().padStart(3, "0")}`,
        type: "stormborn",
      });
    }
    const output = unwrap(
      await new FoundryDocumentService(runtime).snapshot({
        query: { type: "Actor" },
        maxDepth: 4,
        maxItems: 225,
        maxBytes: 2_000_000,
      }),
    );

    expect(output.snapshot).toHaveLength(225);
    expect(output.itemCount).toBe(225);
    expect(output.truncated).toBe(true);
    expect(output.truncationReasons).toContain("maxItems");
  });

  it("redacts native Foundry secret HTML recursively by default without mutating the source", async () => {
    const runtime = createRichFakeRuntime(FakeRole.PLAYER);
    const actor = runtime.seedDocument("Actor", {
      name: "Public actor",
      type: "stormborn",
      system: {
        biography: {
          value:
            '<p>Public introduction</p><section class="secret"><p>Hidden biography</p></section><p>Public conclusion</p>',
        },
        nested: [
          {
            value:
              "<p data-example=\"<section class='secret'>\">Visible note</p><section data-owner='gm' class='journal secret'><span data-example=\"</section>\">Hidden nested note</span></section><p>Visible tail</p>",
          },
        ],
        selfClosing:
          '<p>Visible before self-closing</p><section class="secret" />SELF_CLOSING_SECRET</section><p>Visible after self-closing</p>',
        entityEncoded:
          '<p>Visible before entity</p><section class="journal&#32;sec&#x72;et">ENTITY_CLASS_SECRET</section><p>Visible after entity</p>',
      },
    });
    const sourceBefore = actor.toObject();

    const output = unwrap(
      await new FoundryDocumentService(runtime).snapshot({
        uuids: [actor.uuid],
        maxDepth: 8,
        maxItems: 10,
        maxBytes: 10_000,
      }),
    );
    const serialized = JSON.stringify(output.snapshot);

    expect(serialized).toContain("Public introduction");
    expect(serialized).toContain("Public conclusion");
    expect(serialized).toContain("Visible note");
    expect(serialized).toContain("Visible tail");
    expect(serialized).toContain("Visible before self-closing");
    expect(serialized).toContain("Visible after self-closing");
    expect(serialized).toContain("Visible before entity");
    expect(serialized).toContain("Visible after entity");
    expect(serialized).not.toContain("Hidden biography");
    expect(serialized).not.toContain("Hidden nested note");
    expect(serialized).not.toContain("SELF_CLOSING_SECRET");
    expect(serialized).not.toContain("ENTITY_CLASS_SECRET");
    expect(serialized).not.toContain('class=\\"secret\\"');
    expect(actor.toObject()).toEqual(sourceBefore);
  });

  it("detects UUID cycles, redacts configured paths, and reports each bound", async () => {
    const runtime = createRichFakeRuntime();
    runtime.seedDocument(
      "Actor",
      {
        name: "A",
        type: "stormborn",
        system: { related: "Actor.b", secret: "remove-me", large: "x".repeat(1_000) },
      },
      { id: "a" },
    );
    runtime.seedDocument(
      "Actor",
      { name: "B", type: "clockwork", system: { related: "Actor.a" } },
      { id: "b" },
    );
    const service = new FoundryDocumentService(runtime, ["system.secret"]);
    const full = unwrap(
      await service.snapshot({
        uuids: ["Actor.a"],
        maxDepth: 6,
        maxItems: 10,
        maxBytes: 10_000,
        redactionPaths: [],
      }),
    );
    expect(JSON.stringify(full.snapshot)).toContain('"$cycle":true');
    expect(JSON.stringify(full.snapshot)).not.toContain("remove-me");
    expect(full.redactedPaths).toContain("Actor.a:system.secret");

    const depth = unwrap(
      await service.snapshot({ uuids: ["Actor.a"], maxDepth: 1, maxItems: 10, maxBytes: 10_000 }),
    );
    expect(depth.truncationReasons).toContain("maxDepth");
    const items = unwrap(
      await service.snapshot({ uuids: ["Actor.a"], maxDepth: 6, maxItems: 1, maxBytes: 10_000 }),
    );
    expect(items.truncationReasons).toContain("maxItems");
    const bytes = unwrap(
      await service.snapshot({ uuids: ["Actor.a"], maxDepth: 6, maxItems: 10, maxBytes: 256 }),
    );
    expect(bytes.truncationReasons).toContain("maxBytes");
    expect(bytes.byteCount).toBeLessThanOrEqual(256);
  });

  it("rejects poison redaction paths without mutating global prototypes", async () => {
    const runtime = createRichFakeRuntime();
    const actor = runtime.seedDocument("Actor", {
      name: "Prototype fixture",
      type: "stormborn",
    });
    const service = new FoundryDocumentService(runtime);
    const originalToString = Object.prototype.toString;

    expect(
      await service.snapshot({
        uuids: [actor.uuid],
        maxDepth: 6,
        maxItems: 10,
        maxBytes: 10_000,
        redactionPaths: ["/__proto__/toString"],
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_DATA" } });
    expect(Object.prototype.toString).toBe(originalToString);
  });

  it("rejects deeply nested and huge source graphs before recursive expansion", async () => {
    const runtime = createRichFakeRuntime();
    const actor = runtime.seedDocument("Actor", {
      name: "Bound fixture",
      type: "stormborn",
    });
    const service = new FoundryDocumentService(runtime);

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 70; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor["next"] = next;
      cursor = next;
    }
    actor.toObject = () => deep as never;
    expect(
      await service.snapshot({
        uuids: [actor.uuid],
        maxDepth: 12,
        maxItems: 10,
        maxBytes: 10_000,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_DATA", message: expect.stringContaining("depth safety limit") },
    });

    actor.toObject = () => ({ values: new Array(50_001).fill(0) }) as never;
    expect(
      await service.snapshot({
        uuids: [actor.uuid],
        maxDepth: 12,
        maxItems: 10,
        maxBytes: 10_000,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_DATA", message: expect.stringContaining("node safety limit") },
    });
  });

  it("uses the same generic path for scenes, tables, playlists, cards, and macros", async () => {
    const runtime = createRichFakeRuntime();
    const service = new FoundryDocumentService(runtime);
    for (const type of ["Scene", "RollTable", "Playlist", "Cards", "Macro"]) {
      const created = unwrap(
        await service.create({
          type,
          data: { name: `${type} Fixture`, system: { moduleSpecific: { type } } },
        }),
      );
      const result = created.results[0];
      expect(result?.status).toBe("created");
      if (result?.status !== "created") continue;
      expect(unwrap(await service.get({ uuid: result.document.uuid })).data.system).toEqual({
        moduleSpecific: { type },
      });
      expect(unwrap(await service.list({ type })).items.map((item) => item.uuid)).toContain(
        result.document.uuid,
      );
    }
  });

  it("maps runtime failures and operational guards to the structured taxonomy", async () => {
    const offlineRuntime = createRichFakeRuntime();
    offlineRuntime.online = false;
    expect(await new FoundryDocumentService(offlineRuntime).types()).toMatchObject({
      ok: false,
      error: { code: "OFFLINE_BRIDGE" },
    });

    const runtime = createRichFakeRuntime(FakeRole.PLAYER);
    const actor = runtime.seedDocument("Actor", { name: "Fixture", type: "stormborn" });
    const service = new FoundryDocumentService(runtime);
    expect(await service.list({ type: "Nope" })).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_TYPE" },
    });
    expect(await service.list({ type: "Actor", pageSize: 0 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_DATA" },
    });
    expect(await service.get({ uuid: "Actor.missing" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(
      await service.create({ type: "Actor", data: { name: "Denied", type: "stormborn" } }),
    ).toMatchObject({
      ok: true,
      value: { results: [{ error: { code: "PERMISSION_DENIED" } }] },
    });
    expect(
      await service.update({ uuid: actor.uuid, data: { name: "Conflict" }, expectedHash: "wrong" }),
    ).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });

    runtime.role = FakeRole.GAMEMASTER;
    expect(
      await service.update({ uuid: actor.uuid, data: { name: "Conflict" }, expectedHash: "wrong" }),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(await service.types({}, { deadline: Date.now() - 1 })).toMatchObject({
      ok: false,
      error: { code: "TIMEOUT" },
    });
    const controller = new AbortController();
    controller.abort();
    expect(await service.types({}, { signal: controller.signal })).toMatchObject({
      ok: false,
      error: { code: "CANCELLED" },
    });

    const failingRuntime = createRichFakeRuntime();
    failingRuntime.listRootDocuments = async () => {
      throw new Error("Injected Foundry failure");
    };
    expect(await new FoundryDocumentService(failingRuntime).list({ type: "Actor" })).toMatchObject({
      ok: false,
      error: { code: "FOUNDRY_ERROR" },
    });
    expect(makeError("AMBIGUOUS_CONNECTION", "multiple worlds").code).toBe("AMBIGUOUS_CONNECTION");
  });
});
