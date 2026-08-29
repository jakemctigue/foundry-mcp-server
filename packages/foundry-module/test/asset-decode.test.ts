import { describe, expect, it, vi } from "vitest";

import {
  BrowserFoundryAssetRuntime,
  MAX_RUNTIME_IMAGE_DIMENSION,
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
