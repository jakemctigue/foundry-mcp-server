import { describe, expect, it, vi } from "vitest";

import type { OperationResult } from "@foundry-mcp/protocol";
import type { FoundryAssetRuntimeAdapter } from "../src/asset-runtime.js";
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

function uploadSource(bytes: Uint8Array, mimeType: string) {
  return { kind: "base64" as const, data: encode(bytes), mimeType };
}

const CORRUPT_HEADER_PNG = VALID_PNG.slice(0, 33);
const CORRUPT_HEADER_JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02,
  0x11, 0x00, 0x03, 0x11, 0x00,
]);
const CORRUPT_HEADER_WEBP = (() => {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  bytes.set(new TextEncoder().encode("VP8X"), 12);
  return bytes;
})();

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
      system: {
        portrait: { path: "art/portrait.png" },
        vector: "art/map.svg#layer-1",
        nextGeneration: "art/portrait.avif",
        notImage: "notes.txt",
      },
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
      {
        uuid: actor.uuid,
        jsonPath: "/system/nextGeneration",
        imagePath: "art/portrait.avif",
      },
      { uuid: actor.uuid, jsonPath: "/system/portrait/path", imagePath: "art/portrait.png" },
      { uuid: actor.uuid, jsonPath: "/system/vector", imagePath: "art/map.svg#layer-1" },
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

  it("honors destination-aware writability before decoding or uploading", async () => {
    const { assets, service } = createService();
    const preflight = vi
      .spyOn(assets, "getWriteCapability")
      .mockImplementation(async (sourceId, destinationPath) =>
        destinationPath.startsWith("worlds/allowed/")
          ? { id: sourceId, writable: true }
          : {
              id: sourceId,
              writable: false,
              reason: "Destination is outside the configured writable world path",
            },
      );

    expect(
      await service.upload({
        destinationPath: "worlds/denied/token.png",
        source: uploadSource(VALID_PNG, "image/png"),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED", message: expect.stringContaining("writable world path") },
    });
    expect(preflight).toHaveBeenCalledWith("data", "worlds/denied/token.png");
    expect(assets.decodeCalls).toBe(0);
    expect(assets.uploadCalls).toBe(0);
  });

  it.each([
    ["truncated PNG", "image/png", "art/corrupt.png", CORRUPT_HEADER_PNG],
    ["truncated JPEG", "image/jpeg", "art/corrupt.jpg", CORRUPT_HEADER_JPEG],
    ["truncated WebP", "image/webp", "art/corrupt.webp", CORRUPT_HEADER_WEBP],
  ])("rejects a header-valid but undecodable %s", async (_label, mimeType, path, bytes) => {
    const { assets, service } = createService();
    expect(
      await service.upload({ destinationPath: path, source: uploadSource(bytes, mimeType) }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_DATA", message: "Image could not be decoded safely" },
    });
    expect(assets.decodeCalls).toBe(1);
    expect(assets.uploadCalls).toBe(0);
  });

  it("rejects image/active-markup polyglots even when the header remains valid", async () => {
    const markup = new TextEncoder().encode("<svg><script>alert(1)</script></svg>");
    const polyglot = new Uint8Array(VALID_PNG.byteLength + markup.byteLength);
    polyglot.set(VALID_PNG);
    polyglot.set(markup, VALID_PNG.byteLength);
    const { assets, service } = createService();

    expect(
      await service.upload({
        destinationPath: "art/polyglot.png",
        source: uploadSource(polyglot, "image/png"),
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_DATA" } });
    expect(assets.uploadCalls).toBe(0);
  });

  it("fails closed on decoder errors, missing decoders, and decoded dimension limits", async () => {
    const failed = createService();
    vi.spyOn(failed.assets, "decodeImage").mockRejectedValue(new Error("decoder failure"));
    expect(
      await failed.service.upload({
        destinationPath: "art/decoder-failure.png",
        source: uploadSource(VALID_PNG, "image/png"),
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_DATA" } });
    expect(failed.assets.uploadCalls).toBe(0);
    expect(
      await failed.service.upload({
        destinationPath: "art/generated-decoder-failure.png",
        source: {
          kind: "generated",
          data: encode(VALID_PNG),
          mimeType: "image/png",
          provider: "test",
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_DATA" } });
    expect(failed.assets.uploadCalls).toBe(0);

    const missingRuntime = createFakeAssetRuntime();
    const missingDecoder = {
      isOnline: () => missingRuntime.isOnline(),
      listSources: () => missingRuntime.listSources(),
      browse: (sourceId: string, path: string, extensions?: string[]) =>
        missingRuntime.browse(sourceId, path, extensions),
      exists: (sourceId: string, path: string) => missingRuntime.exists(sourceId, path),
      decodeImage: undefined,
      upload: (
        sourceId: string,
        path: string,
        bytes: Uint8Array,
        mimeType: string,
        options: { overwrite: boolean },
      ) => missingRuntime.upload(sourceId, path, bytes, mimeType, options),
    } as unknown as FoundryAssetRuntimeAdapter;
    const documentRuntime = createRichFakeRuntime();
    const withoutDecoder = new FoundryAssetService(
      missingDecoder,
      new FoundryDocumentService(documentRuntime),
      documentRuntime,
    );
    expect(
      await withoutDecoder.upload({
        destinationPath: "art/no-decoder.png",
        source: uploadSource(VALID_PNG, "image/png"),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_DATA", message: "Safe image decoding is unavailable" },
    });

    const dimensions = createService({ maxImageWidth: 100, maxImagePixels: 10_000 });
    const decodeImage = vi
      .spyOn(dimensions.assets, "decodeImage")
      .mockResolvedValue({ width: 101, height: 1 });
    const wideHeader = Uint8Array.from(VALID_PNG);
    wideHeader[19] = 101;
    expect(
      await dimensions.service.upload({
        destinationPath: "art/header-too-wide.png",
        source: uploadSource(wideHeader, "image/png"),
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_DATA" } });
    expect(decodeImage).not.toHaveBeenCalled();

    expect(
      await dimensions.service.upload({
        destinationPath: "art/too-wide.png",
        source: uploadSource(VALID_PNG, "image/png"),
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_DATA" } });
    expect(dimensions.assets.uploadCalls).toBe(0);

    decodeImage.mockResolvedValue({ width: 100, height: 101 });
    expect(
      await dimensions.service.upload({
        destinationPath: "art/too-many-pixels.png",
        source: uploadSource(VALID_PNG, "image/png"),
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_DATA" } });
    expect(dimensions.assets.uploadCalls).toBe(0);
  });

  it("decodes host-rewritten base64 bytes without attempting to re-read a host path", async () => {
    const loadLocalFile = vi.fn(async () => ({ bytes: VALID_PNG, mimeType: "image/png" }));
    const { assets, service } = createService({ loadLocalFile });
    expect(
      unwrap(
        await service.upload({
          destinationPath: "art/host-rewritten.png",
          source: uploadSource(VALID_PNG, "image/png"),
        }),
      ),
    ).toMatchObject({ assetPath: "art/host-rewritten.png" });
    expect(loadLocalFile).not.toHaveBeenCalled();
    expect(assets.decodeCalls).toBe(1);
    expect(assets.uploadCalls).toBe(1);
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
    expect(assets.decodeCalls).toBe(3);
    expect(unwrap(await service.list({ source: "data" })).items.map((item) => item.path)).toEqual([
      "art/from-file.png",
      "art/token-1.png",
      "art/token.png",
    ]);
  });
});

describe("FoundryAssetService attach", () => {
  it("rejects undecodable URL and upload attachment bytes before asset or Document mutation", async () => {
    const { runtime, assets, documents, service } = createService({
      importUrl: async () => ({ bytes: CORRUPT_HEADER_PNG, mimeType: "image/png" }),
    });
    const actor = runtime.seedDocument("Actor", { name: "Decode Guard", type: "stormborn" });
    expect(
      await service.attach({
        documentUuid: actor.uuid,
        asset: {
          kind: "url",
          url: "https://example.test/corrupt.png",
          destinationPath: "tokens/corrupt-url.png",
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_DATA" } });
    expect(
      await service.attach({
        documentUuid: actor.uuid,
        asset: {
          kind: "upload",
          destinationPath: "tokens/corrupt-upload.png",
          source: uploadSource(CORRUPT_HEADER_PNG, "image/png"),
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_DATA" } });
    expect(assets.decodeCalls).toBe(2);
    expect(assets.uploadCalls).toBe(0);
    expect(unwrap(await documents.get({ uuid: actor.uuid })).data.img).toBeUndefined();
  });

  it("fails before upload or Document mutation when audit recording fails", async () => {
    const { runtime, assets, documents, service } = createService();
    const actor = runtime.seedDocument("Actor", { name: "Audit Guard", type: "stormborn" });
    vi.spyOn(runtime, "audit").mockImplementation(() => {
      throw new Error("Injected audit failure");
    });

    expect(
      await service.attach({
        documentUuid: actor.uuid,
        asset: {
          kind: "upload",
          destinationPath: "tokens/audit-guard.png",
          source: { kind: "base64", data: encode(VALID_PNG), mimeType: "image/png" },
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "FOUNDRY_ERROR" } });
    expect(assets.uploadCalls).toBe(0);
    expect(assets.get("data", "tokens/audit-guard.png")).toBeUndefined();
    expect(unwrap(await documents.get({ uuid: actor.uuid })).data.img).toBeUndefined();
  });

  it("refuses combined upload before side effects when the runtime cannot compensate", async () => {
    const runtime = createRichFakeRuntime();
    const backing = createFakeAssetRuntime();
    const assets: FoundryAssetRuntimeAdapter = {
      isOnline: () => backing.isOnline(),
      listSources: () => backing.listSources(),
      browse: (sourceId, path, extensions) => backing.browse(sourceId, path, extensions),
      exists: (sourceId, path) => backing.exists(sourceId, path),
      decodeImage: (bytes, mimeType, limits) => backing.decodeImage(bytes, mimeType, limits),
      upload: (sourceId, path, bytes, mimeType, options) =>
        backing.upload(sourceId, path, bytes, mimeType, options),
    };
    const documents = new FoundryDocumentService(runtime);
    const service = new FoundryAssetService(assets, documents, runtime);
    const actor = runtime.seedDocument("Actor", { name: "No Rollback", type: "stormborn" });

    expect(
      await service.attach({
        documentUuid: actor.uuid,
        asset: {
          kind: "upload",
          destinationPath: "tokens/no-rollback.png",
          source: { kind: "base64", data: encode(VALID_PNG), mimeType: "image/png" },
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "FOUNDRY_ERROR", message: expect.stringContaining("upload first") },
    });
    expect(backing.uploadCalls).toBe(0);
    expect(unwrap(await documents.get({ uuid: actor.uuid })).data.img).toBeUndefined();
  });

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

  it("restores overwritten bytes when the Document update loses an optimistic race", async () => {
    const runtime = createRichFakeRuntime();
    const assets = createFakeAssetRuntime();
    const documents = new FoundryDocumentService(runtime);
    const actor = runtime.seedDocument("Actor", { name: "Overwrite Race", type: "clockwork" });
    const original = Uint8Array.from(VALID_PNG);
    original[original.length - 1] = 0x83;
    assets.seed("data", "tokens/existing.png", original, "image/png");
    const upload = assets.upload.bind(assets);
    vi.spyOn(assets, "upload").mockImplementation(async (...args) => {
      const stored = await upload(...args);
      await runtime.updateDocument(actor, { system: { raced: true } });
      return stored;
    });
    const service = new FoundryAssetService(assets, documents, runtime);

    expect(
      await service.attach({
        documentUuid: actor.uuid,
        asset: {
          kind: "upload",
          destinationPath: "tokens/existing.png",
          onCollision: "overwrite",
          source: { kind: "base64", data: encode(VALID_PNG), mimeType: "image/png" },
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(assets.get("data", "tokens/existing.png")?.bytes).toEqual(original);
    expect(unwrap(await documents.get({ uuid: actor.uuid })).data.img).toBeUndefined();
  });

  it("does not upload into a missing path already referenced by another Document", async () => {
    const { runtime, assets, service } = createService();
    runtime.seedDocument("Actor", {
      name: "Existing Reference",
      type: "stormborn",
      img: "tokens/referenced.png",
    });
    const target = runtime.seedDocument("Actor", { name: "Target", type: "clockwork" });

    expect(
      await service.attach({
        documentUuid: target.uuid,
        asset: {
          kind: "upload",
          destinationPath: "tokens/referenced.png",
          source: { kind: "base64", data: encode(VALID_PNG), mimeType: "image/png" },
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(assets.uploadCalls).toBe(0);
    expect(assets.get("data", "tokens/referenced.png")).toBeUndefined();
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
    expect(assets.decodeCalls).toBe(1);
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
