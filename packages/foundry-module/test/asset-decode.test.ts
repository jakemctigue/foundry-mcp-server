import { describe, expect, it, vi } from "vitest";

import {
  BrowserFoundryAssetRuntime,
  MAX_ASSET_SOURCE_CAPABILITIES_SETTING_LENGTH,
  MAX_RUNTIME_IMAGE_DIMENSION,
  parseAssetSourceCapabilitiesSetting,
  type RuntimeImageDecodeLimits,
} from "../src/asset-runtime.js";
import { VALID_PNG } from "./fake-runtime/assets.js";

const LIMITS: RuntimeImageDecodeLimits = {
  maxBytes: 1024,
  maxWidth: 1024,
  maxHeight: 1024,
  maxPixels: 1024 * 1024,
};

function runtimeWithDecoder(
  createImageBitmap: (blob: Blob) => Promise<unknown>,
): BrowserFoundryAssetRuntime {
  return new BrowserFoundryAssetRuntime({
    global: { Blob, createImageBitmap },
  });
}

describe("BrowserFoundryAssetRuntime safe image decoding", () => {
  it("uses the browser decoder and always closes a valid bitmap", async () => {
    const close = vi.fn();
    const createImageBitmap = vi.fn(async (_blob: Blob) => ({ width: 1, height: 1, close }));
    const runtime = runtimeWithDecoder(createImageBitmap);

    await expect(runtime.decodeImage(VALID_PNG, "image/png", LIMITS)).resolves.toEqual({
      width: 1,
      height: 1,
    });
    expect(createImageBitmap).toHaveBeenCalledOnce();
    const blob = createImageBitmap.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob).toMatchObject({ size: VALID_PNG.byteLength, type: "image/png" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects SVG and active-markup polyglots before invoking the decoder", async () => {
    const createImageBitmap = vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }));
    const runtime = runtimeWithDecoder(createImageBitmap);
    const activeMarkup = new TextEncoder().encode("<svg><script>alert(1)</script></svg>");
    const polyglot = new Uint8Array(VALID_PNG.byteLength + activeMarkup.byteLength);
    polyglot.set(VALID_PNG);
    polyglot.set(activeMarkup, VALID_PNG.byteLength);

    await expect(runtime.decodeImage(VALID_PNG, "image/svg+xml", LIMITS)).rejects.toThrow(/SVG/);
    await expect(runtime.decodeImage(polyglot, "image/png", LIMITS)).rejects.toThrow(
      /active markup/,
    );
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("fails closed when browser-native decoding is unavailable or throws", async () => {
    const unavailable = new BrowserFoundryAssetRuntime({ global: { Blob } });
    await expect(unavailable.decodeImage(VALID_PNG, "image/png", LIMITS)).rejects.toThrow(
      /unavailable/,
    );

    const failedDecoder = vi.fn(async () => Promise.reject(new Error("decoder internals")));
    await expect(
      runtimeWithDecoder(failedDecoder).decodeImage(VALID_PNG, "image/png", LIMITS),
    ).rejects.toThrow(/could not be decoded safely/);
  });

  it("enforces byte, dimension, and pixel limits and closes rejected bitmaps", async () => {
    const neverCalled = vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }));
    await expect(
      runtimeWithDecoder(neverCalled).decodeImage(VALID_PNG, "image/png", {
        ...LIMITS,
        maxBytes: VALID_PNG.byteLength - 1,
      }),
    ).rejects.toThrow(/byte length/);
    expect(neverCalled).not.toHaveBeenCalled();

    const closeWide = vi.fn();
    const wide = runtimeWithDecoder(
      vi.fn(async () => ({ width: LIMITS.maxWidth + 1, height: 1, close: closeWide })),
    );
    await expect(wide.decodeImage(VALID_PNG, "image/png", LIMITS)).rejects.toThrow(
      /could not be decoded safely/,
    );
    expect(closeWide).toHaveBeenCalledOnce();

    const closePixels = vi.fn();
    const tooManyPixels = runtimeWithDecoder(
      vi.fn(async () => ({ width: 1024, height: 1024, close: closePixels })),
    );
    await expect(
      tooManyPixels.decodeImage(VALID_PNG, "image/png", { ...LIMITS, maxPixels: 100 }),
    ).rejects.toThrow(/could not be decoded safely/);
    expect(closePixels).toHaveBeenCalledOnce();

    const closeHardLimit = vi.fn();
    const hardLimit = runtimeWithDecoder(
      vi.fn(async () => ({
        width: MAX_RUNTIME_IMAGE_DIMENSION + 1,
        height: 1,
        close: closeHardLimit,
      })),
    );
    await expect(
      hardLimit.decodeImage(VALID_PNG, "image/png", {
        ...LIMITS,
        maxWidth: MAX_RUNTIME_IMAGE_DIMENSION * 2,
      }),
    ).rejects.toThrow(/could not be decoded safely/);
    expect(closeHardLimit).toHaveBeenCalledOnce();
  });
});

describe("BrowserFoundryAssetRuntime destination writability", () => {
  function foundryGlobal() {
    class FilePicker {
      static S3_BUCKETS = ["campaign-bucket"];
      static browse = vi.fn(async () => ({ dirs: [], files: [] }));
      static upload = vi.fn(async () => ({ path: "stored.png" }));
      sources = { data: {}, public: {}, s3: {} };
    }
    return {
      FilePicker,
      game: { ready: true, user: { isGM: true } },
    };
  }

  it("probes a data destination and fails closed for unconfigured providers", async () => {
    const global = foundryGlobal();
    const runtime = new BrowserFoundryAssetRuntime({ global });

    await expect(
      runtime.getWriteCapability("data", "worlds/campaign/art/token.png"),
    ).resolves.toEqual({ id: "data", writable: true });
    await expect(runtime.getWriteCapability("public", "icons/token.svg")).resolves.toMatchObject({
      writable: false,
      reason: expect.stringContaining("read-only"),
    });
    await expect(runtime.getWriteCapability("s3", "art/token.png")).resolves.toMatchObject({
      writable: false,
      reason: expect.stringContaining("explicit provider"),
    });
  });

  it("binds an explicitly configured provider to its bucket and writable path prefixes", async () => {
    const global = foundryGlobal();
    const runtime = new BrowserFoundryAssetRuntime({
      global,
      sourceCapabilities: {
        s3: {
          writable: true,
          bucket: "campaign-bucket",
          writablePathPrefixes: ["campaign/art"],
        },
      },
    });

    await expect(runtime.getWriteCapability("s3", "other/token.png")).resolves.toMatchObject({
      writable: false,
      reason: expect.stringContaining("outside"),
    });
    await expect(runtime.getWriteCapability("s3", "campaign/art/token.png")).resolves.toEqual({
      id: "s3",
      writable: true,
    });
    expect(global.FilePicker.browse).toHaveBeenCalledWith("s3", "campaign/art", {
      bucket: "campaign-bucket",
    });
  });

  it.each([
    "campaign/art/.. /outside.png",
    "campaign/art/%2e%2e%20/outside.png",
    "campaign/art/CON.png",
    "campaign/art/%43%4f%4e.png",
  ])("rejects unsafe destination %s before a writable-prefix probe", async (destinationPath) => {
    const global = foundryGlobal();
    const runtime = new BrowserFoundryAssetRuntime({
      global,
      sourceCapabilities: {
        s3: {
          writable: true,
          bucket: "campaign-bucket",
          writablePathPrefixes: ["campaign/art"],
        },
      },
    });

    await expect(runtime.getWriteCapability("s3", destinationPath)).resolves.toMatchObject({
      writable: false,
      reason: expect.stringContaining("safe relative Foundry path"),
    });
    expect(global.FilePicker.browse).not.toHaveBeenCalled();
    await expect(
      runtime.upload("s3", destinationPath, VALID_PNG, "image/png", { overwrite: false }),
    ).rejects.toThrow();
    expect(global.FilePicker.upload).not.toHaveBeenCalled();
  });

  it("canonicalizes encoded valid paths before checking their writable prefix", async () => {
    const global = foundryGlobal();
    const runtime = new BrowserFoundryAssetRuntime({
      global,
      sourceCapabilities: {
        s3: {
          writable: true,
          bucket: "campaign-bucket",
          writablePathPrefixes: ["campaign/Café art"],
        },
      },
    });

    await expect(
      runtime.getWriteCapability("s3", "campaign/Caf%C3%A9%20art/token%20one.png"),
    ).resolves.toEqual({ id: "s3", writable: true });
    expect(global.FilePicker.browse).toHaveBeenCalledWith("s3", "campaign/Café art", {
      bucket: "campaign-bucket",
    });
  });

  it("fails closed when programmatic non-core configuration omits its path bound", async () => {
    const global = foundryGlobal();
    const runtime = new BrowserFoundryAssetRuntime({
      global,
      sourceCapabilities: {
        s3: { writable: true, bucket: "campaign-bucket" },
      },
    });

    await expect(runtime.listSources()).resolves.toContainEqual({
      id: "s3",
      writable: false,
      reason: expect.stringContaining("writable path"),
    });
    await expect(runtime.getWriteCapability("s3", "campaign/art/token.png")).resolves.toEqual({
      id: "s3",
      writable: false,
      reason: expect.stringContaining("writable path"),
    });
    expect(global.FilePicker.browse).not.toHaveBeenCalled();
  });

  it("does not claim a destination whose directory probe fails", async () => {
    const global = foundryGlobal();
    global.FilePicker.browse.mockRejectedValueOnce(new Error("not found"));
    const runtime = new BrowserFoundryAssetRuntime({ global });

    await expect(runtime.getWriteCapability("data", "missing/token.png")).resolves.toMatchObject({
      writable: false,
      reason: expect.stringContaining("could not be accessed"),
    });
  });
});

describe("Foundry module asset-source capability setting", () => {
  it("accepts only bounded non-core capabilities and normalizes their values", () => {
    const parsed = parseAssetSourceCapabilitiesSetting(`{
      "s3": {
        "writable": true,
        "bucket": "campaign-bucket",
        "writablePathPrefixes": ["campaign/art", "campaign%2Fart"]
      },
      "forge": {
        "writable": false,
        "reason": "Managed by the hosting provider"
      }
    }`);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect({ ...parsed.value }).toEqual({
      s3: {
        writable: true,
        bucket: "campaign-bucket",
        writablePathPrefixes: ["campaign/art"],
      },
      forge: {
        writable: false,
        reason: "Managed by the hosting provider",
      },
    });
  });

  it("rejects credentials, core overrides, traversal, and incomplete writable providers", () => {
    for (const [raw, error] of [
      [
        '{"s3":{"writable":true,"bucket":"campaign","writablePathPrefixes":["art"],"accessKey":"not-accepted"}}',
        "credentials are not accepted",
      ],
      ['{"data":{"writable":false}}', "not allowed"],
      [
        '{"forge":{"writable":true,"writablePathPrefixes":["../outside"]}}',
        "invalid relative Foundry path",
      ],
      [
        '{"forge":{"writable":true,"writablePathPrefixes":["safe/.. "]}}',
        "invalid relative Foundry path",
      ],
      [
        '{"forge":{"writable":true,"writablePathPrefixes":["safe/%43%4f%4e"]}}',
        "invalid relative Foundry path",
      ],
      ['{"forge":{"writable":true}}', "must authorize at least one path"],
      ['{"s3":{"writable":false}}', "s3.bucket is required"],
    ] as const) {
      expect(parseAssetSourceCapabilitiesSetting(raw)).toEqual({
        ok: false,
        error: expect.stringContaining(error),
      });
    }
  });

  it("bounds the full JSON document and number of configured sources", () => {
    expect(
      parseAssetSourceCapabilitiesSetting(
        "x".repeat(MAX_ASSET_SOURCE_CAPABILITIES_SETTING_LENGTH + 1),
      ),
    ).toEqual({ ok: false, error: expect.stringContaining("exceeds") });
    const tooManySources = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`source-${index}`, { writable: false }]),
    );
    expect(parseAssetSourceCapabilitiesSetting(JSON.stringify(tooManySources))).toEqual({
      ok: false,
      error: expect.stringContaining("more than 16"),
    });
  });
});
