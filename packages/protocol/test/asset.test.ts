import { describe, expect, it } from "vitest";

import {
  AssetsImagesAttachInput,
  AssetsImagesListInput,
  AssetsImagesUploadInput,
  inspectImageBytes,
} from "../src/asset.js";

const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
]);

describe("asset protocol", () => {
  it("applies bounded listing defaults", () => {
    expect(AssetsImagesListInput.parse({})).toMatchObject({
      pathPrefix: "",
      pageSize: 50,
      maxDepth: 4,
    });
  });

  it("accepts each upload source and collision policy", () => {
    expect(
      AssetsImagesUploadInput.parse({
        destinationPath: "art/token.png",
        source: { kind: "base64", data: "iVBORw0KGgo=" },
        onCollision: "rename",
      }),
    ).toMatchObject({ sourceId: "data", onCollision: "rename" });
  });

  it("models reference, upload, and guarded URL attachments", () => {
    expect(
      AssetsImagesAttachInput.parse({
        documentUuid: "Actor.a",
        asset: { kind: "reference", sourceId: "public", path: "icons/a.webp" },
      }).fieldPath,
    ).toBe("img");
    expect(
      AssetsImagesAttachInput.safeParse({
        documentUuid: "Actor.a",
        asset: { kind: "url", destinationPath: "art/a.png", url: "not-a-url" },
      }).success,
    ).toBe(false);
  });
});

describe("inspectImageBytes", () => {
  it("sniffs image magic and dimensions", () => {
    expect(inspectImageBytes(png, { expectedExtension: ".png", requireDimensions: true })).toEqual({
      ok: true,
      value: { mimeType: "image/png", extension: ".png", width: 2, height: 3 },
    });
  });

  it("rejects extension, MIME, byte, and pixel mismatches", () => {
    expect(inspectImageBytes(png, { expectedExtension: ".jpg" })).toMatchObject({ ok: false });
    expect(inspectImageBytes(png, { expectedMimeType: "image/jpeg" })).toMatchObject({ ok: false });
    expect(inspectImageBytes(png, { maxBytes: 10 })).toMatchObject({ ok: false });
    expect(inspectImageBytes(png, { maxPixels: 5 })).toMatchObject({ ok: false });
  });

  it("recognizes GIF87a/GIF89a, JPEG SOF, and extended WebP dimensions", () => {
    const gif87 = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 2, 0, 3, 0]);
    const gif89 = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 2, 0, 3, 0]);
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x03, 0x00, 0x02,
    ]);
    const webp = new Uint8Array(30);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    webp.set([0x56, 0x50, 0x38, 0x58], 12);
    webp[24] = 1;
    webp[27] = 2;
    for (const gif of [gif87, gif89])
      expect(
        inspectImageBytes(gif, { expectedExtension: ".gif", requireDimensions: true }),
      ).toMatchObject({
        ok: true,
        value: { mimeType: "image/gif", width: 2, height: 3 },
      });
    expect(
      inspectImageBytes(jpeg, {
        expectedExtension: ".jpeg",
        expectedMimeType: "IMAGE/JPEG; charset=binary",
        requireDimensions: true,
      }),
    ).toMatchObject({ ok: true, value: { width: 2, height: 3 } });
    expect(
      inspectImageBytes(webp, { expectedExtension: ".webp", requireDimensions: true }),
    ).toMatchObject({
      ok: true,
      value: { mimeType: "image/webp", width: 2, height: 3 },
    });
    const lossyWebp = webp.slice();
    lossyWebp.set([0x56, 0x50, 0x38, 0x20], 12);
    lossyWebp.set([0x9d, 0x01, 0x2a], 23);
    lossyWebp[26] = 2;
    lossyWebp[27] = 0;
    lossyWebp[28] = 3;
    expect(inspectImageBytes(lossyWebp, { requireDimensions: true })).toMatchObject({
      ok: true,
      value: { width: 2, height: 3 },
    });
    const losslessWebp = new Uint8Array(25);
    losslessWebp.set([0x52, 0x49, 0x46, 0x46], 0);
    losslessWebp.set([0x57, 0x45, 0x42, 0x50], 8);
    losslessWebp.set([0x56, 0x50, 0x38, 0x4c], 12);
    losslessWebp[20] = 0x2f;
    losslessWebp[21] = 1;
    losslessWebp[22] = 0x80;
    expect(inspectImageBytes(losslessWebp, { requireDimensions: true })).toMatchObject({
      ok: true,
      value: { width: 2, height: 3 },
    });
  });

  it("rejects empty, unsupported, zero-dimensional, and dimensionless required images", () => {
    expect(inspectImageBytes(new Uint8Array())).toMatchObject({
      ok: false,
      reason: expect.stringContaining("empty"),
    });
    expect(inspectImageBytes(Uint8Array.from([1, 2, 3, 4]))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("supported"),
    });
    const zeroPng = png.slice();
    zeroPng.fill(0, 16, 24);
    expect(inspectImageBytes(zeroPng)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("positive"),
    });
    const dimensionlessJpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0]);
    expect(inspectImageBytes(dimensionlessJpeg)).toMatchObject({ ok: true });
    expect(inspectImageBytes(dimensionlessJpeg, { requireDimensions: true })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("dimensions"),
    });
    const dimensionlessWebp = new Uint8Array(20);
    dimensionlessWebp.set([0x52, 0x49, 0x46, 0x46], 0);
    dimensionlessWebp.set([0x57, 0x45, 0x42, 0x50], 8);
    dimensionlessWebp.set([0x56, 0x50, 0x38, 0x20], 12);
    expect(inspectImageBytes(dimensionlessWebp, { requireDimensions: true })).toMatchObject({
      ok: false,
    });
  });

  it("handles malformed JPEG marker sequences without unsafe reads", () => {
    const withNoise = Uint8Array.from([
      0xff, 0xd8, 0x01, 0xff, 0xff, 0xd0, 0xff, 0xe0, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(inspectImageBytes(withNoise, { requireDimensions: true })).toMatchObject({ ok: false });
  });
});
