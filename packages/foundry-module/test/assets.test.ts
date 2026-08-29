import { describe, expect, it } from "vitest";

import type { OperationResult } from "@foundry-mcp/protocol";
import { FoundryAssetService, validateAssetPath } from "../src/assets.js";
import { FoundryDocumentService } from "../src/documents.js";
import { createFakeAssetRuntime, VALID_PNG } from "./fake-runtime/assets.js";
import { createRichFakeRuntime, FakeRole } from "./fake-runtime/index.js";

function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function createService(options: ConstructorParameters<typeof FoundryAssetService>[3] = {}) {
  const runtime = createRichFakeRuntime();
  const assets = createFakeAssetRuntime();
  const documents = new FoundryDocumentService(runtime);
  return {
    runtime,
    assets,
    documents,
    service: new FoundryAssetService(assets, documents, runtime, options),
  };
}

describe("FoundryAssetService listing", () => {
  it("enumerates writable/read-only sources, deduplicates first-seen paths, paginates, and bounds depth", async () => {
    const { assets, service } = createService();
    assets
      .seed("data", "art/shared.png", VALID_PNG, "image/png")
      .seed("data", "art/a.png", VALID_PNG, "image/png")
      .seed("data", "art/deep/b.png", VALID_PNG, "image/png")
      .seed("public", "art/shared.png", VALID_PNG, "image/png")
      .seed("public", "icons/core.png", VALID_PNG, "image/png");

    const shallow = unwrap(await service.list({ pathPrefix: "art", maxDepth: 0, pageSize: 50 }));
    expect(shallow.items.map((item) => [item.path, item.source])).toEqual([
      ["art/a.png", "data"],
      ["art/shared.png", "data"],
    ]);
    expect(shallow.truncated).toBe(true);
    expect(shallow.truncationReasons[0]).toContain("maxDepth 0");
    expect(shallow.sources).toEqual([
      { id: "data", writable: true },
      { id: "public", writable: false, reason: "Foundry core assets are read-only" },
    ]);

    const first = unwrap(await service.list({ maxDepth: 4, pageSize: 2 }));
    expect(first.nextCursor).toBeDefined();
    const second = unwrap(
      await service.list({ maxDepth: 4, pageSize: 2, cursor: first.nextCursor }),
    );
    expect([...first.items, ...second.items].map((item) => item.path)).toEqual([
      "art/a.png",
      "art/deep/b.png",
      "art/shared.png",
      "icons/core.png",
    ]);
    expect(second.items.at(-1)).toMatchObject({ writable: false, writeReason: expect.any(String) });
  });
});

describe("FoundryAssetService reference discovery", () => {
  it("finds image paths in root and nested embedded Documents with RFC 6901 paths", async () => {
    const { runtime, service } = createService();
    const actor = runtime.seedDocument("Actor", {
      name: "Nested art",
      type: "stormborn",
      img: "tokens/hero.webp?cache=1",
      system: { portrait: { path: "art/portrait.png" }, notImage: "notes.txt" },
    });
    const item = runtime.seedDocument(
      "Item",
      { name: "Rune", type: "rune", system: { cards: ["art/front.jpg", "art/back.jpeg"] } },
      { parentUuid: actor.uuid },
    );
    runtime.seedDocument(
      "Attachment",
      { name: "Nested", preview: "art/nested.gif" },
      { parentUuid: item.uuid },
    );

    expect(unwrap(await service.referencesFind({ uuids: [actor.uuid] })).references).toEqual([
      { uuid: actor.uuid, jsonPath: "/img", imagePath: "tokens/hero.webp?cache=1" },
      { uuid: actor.uuid, jsonPath: "/system/portrait/path", imagePath: "art/portrait.png" },
      { uuid: item.uuid, jsonPath: "/system/cards/0", imagePath: "art/front.jpg" },
      { uuid: item.uuid, jsonPath: "/system/cards/1", imagePath: "art/back.jpeg" },
      {
        uuid: `${item.uuid}.Attachment.attachment-0001`,
        jsonPath: "/preview",
        imagePath: "art/nested.gif",
      },
    ]);
  });
});

describe("FoundryAssetService upload", () => {
  it("rejects traversal, absolute paths, MIME mismatches, oversize data, and read-only sources before writing", async () => {
    const { assets, service } = createService({ maxImageBytes: VALID_PNG.byteLength - 1 });
    const source = { kind: "base64" as const, data: encode(VALID_PNG), mimeType: "image/png" };
    for (const destinationPath of [
      "../escape.png",
      "/absolute.png",
      "C:\\escape.png",
      "art/%2e%2e/escape.png",
      "art/%252e%252e/escape.png",
    ]) {
      expect(await service.upload({ destinationPath, source })).toMatchObject({
        ok: false,
        error: { code: "INVALID_DATA" },
      });
    }
    expect(await service.upload({ destinationPath: "art/file.jpg", source })).toMatchObject({
      ok: false,
      error: { code: "INVALID_DATA" },
    });
    expect(await service.upload({ destinationPath: "art/file.png", source })).toMatchObject({
      ok: false,
      error: { code: "INVALID_DATA" },
    });
    expect(
      await service.upload({ sourceId: "public", destinationPath: "art/file.png", source }),
    ).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(assets.uploadCalls).toBe(0);
  });

  it("honors error, overwrite, rename, file, and generated sources and persists listings", async () => {
    const fileLoads: Array<[string, number]> = [];
    const { assets, service } = createService({
      loadLocalFile: (path, maxBytes) => {
        fileLoads.push([path, maxBytes]);
        return Promise.resolve({ bytes: VALID_PNG, mimeType: "image/png" });
      },
    });
    assets.seed("data", "art/token.png", VALID_PNG, "image/png");
    const base64 = { kind: "base64" as const, data: encode(VALID_PNG), mimeType: "image/png" };
    expect(
      await service.upload({ destinationPath: "art/token.png", source: base64 }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(
      unwrap(
        await service.upload({
          destinationPath: "art/token.png",
          source: base64,
          onCollision: "overwrite",
        }),
      ),
    ).toMatchObject({ assetPath: "art/token.png", collision: "overwritten" });
    expect(
      unwrap(
        await service.upload({
          destinationPath: "art/token.png",
          source: {
            kind: "generated",
            data: encode(VALID_PNG),
            mimeType: "image/png",
            provider: "test",
          },
          onCollision: "rename",
        }),
      ),
    ).toMatchObject({ assetPath: "art/token-1.png", collision: "renamed" });
    unwrap(
      await service.upload({
        destinationPath: "art/from-file.png",
        source: { kind: "file", path: "C:\\authorized\\input.png" },
      }),
    );
    expect(fileLoads).toEqual([["C:\\authorized\\input.png", 20 * 1024 * 1024]]);
    expect(unwrap(await service.list({ source: "data" })).items.map((item) => item.path)).toEqual([
      "art/from-file.png",
      "art/token-1.png",
      "art/token.png",
    ]);
  });
});

describe("FoundryAssetService attach", () => {
  it("attaches to runtime Actor/Item subtypes while preserving unknown system data and ownership", async () => {
    const { runtime, assets, documents, service } = createService();
    assets.seed("public", "icons/reference.webp", VALID_PNG, "image/webp");
    const actor = runtime.seedDocument("Actor", {
      name: "Hero",
      type: "stormborn",
      system: { unknownModuleData: { keep: true } },
      ownership: { default: 1, gm: 3 },
    });
    const item = runtime.seedDocument(
      "Item",
      {
        name: "Relic",
        type: "relic",
        system: { vendorSpecific: 42 },
        ownership: { default: 0 },
      },
      { parentUuid: actor.uuid },
    );
    const attachedActor = unwrap(
      await service.attach({
        documentUuid: actor.uuid,
        fieldPath: "img",
        asset: {
          kind: "upload",
          destinationPath: "tokens/hero.png",
          source: { kind: "base64", data: encode(VALID_PNG), mimeType: "image/png" },
        },
      }),
    );
    expect(attachedActor.document).toMatchObject({
      img: "tokens/hero.png",
      system: { unknownModuleData: { keep: true } },
      ownership: { default: 1, gm: 3 },
    });
    const attachedItem = unwrap(
      await service.attach({
        documentUuid: item.uuid,
        fieldPath: "system.art.icon",
        asset: { kind: "reference", sourceId: "public", path: "icons/reference.webp" },
      }),
    );
    expect(attachedItem.document).toMatchObject({
      system: { vendorSpecific: 42, art: { icon: "icons/reference.webp" } },
      ownership: { default: 0 },
    });
    expect(
      runtime.auditEvents.filter((event) => event.action === "asset.image.attach"),
    ).toHaveLength(2);
    expect(unwrap(await documents.get({ uuid: actor.uuid })).ownershipSummary).toEqual({
      default: 1,
      gm: 3,
    });
  });

  it("preflights both permissions and rolls an upload back when an optimistic Document update races", async () => {
    const runtime = createRichFakeRuntime();
    const assets = createFakeAssetRuntime();
    const documents = new FoundryDocumentService(runtime);
    const actor = runtime.seedDocument("Actor", {
      name: "Race",
      type: "clockwork",
      system: { keep: true },
    });
    const service = new FoundryAssetService(assets, documents, runtime, {
      loadLocalFile: async () => {
        await runtime.updateDocument(actor, { system: { raced: true } });
        return { bytes: VALID_PNG, mimeType: "image/png" };
      },
    });
    expect(
      await service.attach({
        documentUuid: actor.uuid,
        asset: {
          kind: "upload",
          destinationPath: "tokens/race.png",
          source: { kind: "file", path: "C:\\authorized\\race.png" },
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(assets.get("data", "tokens/race.png")).toBeUndefined();
    expect(unwrap(await documents.get({ uuid: actor.uuid })).data).toMatchObject({
      system: { keep: true, raced: true },
    });

    runtime.role = FakeRole.PLAYER;
    expect(
      await service.attach({
        documentUuid: actor.uuid,
        asset: {
          kind: "upload",
          destinationPath: "tokens/denied.png",
          source: { kind: "base64", data: encode(VALID_PNG), mimeType: "image/png" },
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(assets.get("data", "tokens/denied.png")).toBeUndefined();
  });

  it("routes URL attachments through the injected host-side guarded importer", async () => {
    const imports: Array<[string, number]> = [];
    const { runtime, assets, service } = createService({
      importUrl: (url, maxBytes) => {
        imports.push([url, maxBytes]);
        return Promise.resolve({ bytes: VALID_PNG, mimeType: "image/png" });
      },
    });
    const actor = runtime.seedDocument("Actor", { name: "Imported", type: "stormborn" });
    expect(
      unwrap(
        await service.attach({
          documentUuid: actor.uuid,
          asset: {
            kind: "url",
            url: "https://example.com/token.png",
            destinationPath: "tokens/imported.png",
          },
        }),
      ),
    ).toMatchObject({ assetPath: "tokens/imported.png", source: "data" });
    expect(imports).toEqual([["https://example.com/token.png", 20 * 1024 * 1024]]);
    expect(assets.get("data", "tokens/imported.png")).toBeDefined();
  });
});

describe("validateAssetPath", () => {
  it("allows a normalized relative Foundry asset path", () => {
    expect(validateAssetPath("worlds/campaign/art/token.png")).toBe(
      "worlds/campaign/art/token.png",
    );
  });
});
