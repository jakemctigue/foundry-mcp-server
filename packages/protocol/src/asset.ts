import { z } from "zod";

import {
  ConnectionSelector,
  DocumentsListInput,
  JsonObjectSchema,
  MAX_PAGE_SIZE,
} from "./document.js";

/**
 * Extensions Foundry may expose as image assets. This list is intentionally broader than the
 * formats accepted by the upload decoder: enumeration must not hide an existing image merely
 * because this server will not rewrite that format safely.
 */
export const DEFAULT_IMAGE_EXTENSIONS = [
  ".png",
  ".apng",
  ".jpg",
  ".jpeg",
  ".jfif",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
  ".dib",
  ".heic",
  ".heif",
  ".ico",
  ".jxl",
  ".svg",
  ".tif",
  ".tiff",
] as const;
export const MAX_ASSET_DEPTH = 16;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_BASE64_CHARACTERS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 16;

export const AssetSourceCapability = z.object({
  id: z.string().min(1),
  writable: z.boolean(),
  reason: z.string().min(1).optional(),
});
export type AssetSourceCapability = z.infer<typeof AssetSourceCapability>;

export const ImageAsset = z.object({
  path: z.string().min(1),
  source: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
  mimeType: z.string().min(1).optional(),
  writable: z.boolean(),
  writeReason: z.string().min(1).optional(),
});
export type ImageAsset = z.infer<typeof ImageAsset>;

export const AssetsImagesListInput = ConnectionSelector.extend({
  source: z.string().min(1).optional(),
  pathPrefix: z.string().max(1000).default(""),
  extensions: z
    .array(z.string().regex(/^\.?[a-z0-9]+$/i))
    .min(1)
    .max(50)
    .default([...DEFAULT_IMAGE_EXTENSIONS]),
  cursor: z.string().min(1).max(4096).optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  maxDepth: z.number().int().min(0).max(MAX_ASSET_DEPTH).default(4),
}).strict();
export type AssetsImagesListInput = z.infer<typeof AssetsImagesListInput>;

export const AssetsImagesListOutput = z.object({
  items: z.array(ImageAsset),
  sources: z.array(AssetSourceCapability),
  nextCursor: z.string().min(1).optional(),
  truncated: z.boolean(),
  truncationReasons: z.array(z.string()),
});
export type AssetsImagesListOutput = z.infer<typeof AssetsImagesListOutput>;

const AssetReferencesByUuids = ConnectionSelector.extend({
  uuids: z.array(z.string().min(1)).min(1).max(500),
}).strict();

const AssetReferencesByQuery = ConnectionSelector.extend({
  query: DocumentsListInput.omit({ connectionId: true, cursor: true, pageSize: true }),
}).strict();

export const AssetsReferencesFindInput = z.union([AssetReferencesByUuids, AssetReferencesByQuery]);
export type AssetsReferencesFindInput = z.infer<typeof AssetsReferencesFindInput>;

export const ImageReference = z.object({
  uuid: z.string().min(1),
  jsonPath: z.string(),
  imagePath: z.string().min(1),
});
export type ImageReference = z.infer<typeof ImageReference>;

export const AssetsReferencesFindOutput = z.object({ references: z.array(ImageReference) });
export type AssetsReferencesFindOutput = z.infer<typeof AssetsReferencesFindOutput>;

export const AssetCollisionPolicy = z.enum(["error", "rename", "overwrite"]);
export type AssetCollisionPolicy = z.infer<typeof AssetCollisionPolicy>;

export const AssetUploadSource = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("file"),
      path: z.string().min(1).max(32_768),
      mimeType: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("base64"),
      data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARACTERS),
      mimeType: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("generated"),
      data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARACTERS),
      mimeType: z.string().min(1),
      provider: z.string().min(1).optional(),
    })
    .strict(),
]);
export type AssetUploadSource = z.infer<typeof AssetUploadSource>;

export const AssetsImagesUploadInput = ConnectionSelector.extend({
  sourceId: z.string().min(1).default("data"),
  destinationPath: z.string().min(1).max(1000),
  source: AssetUploadSource,
  onCollision: AssetCollisionPolicy.default("error"),
}).strict();
export type AssetsImagesUploadInput = z.infer<typeof AssetsImagesUploadInput>;

export const AssetsImagesUploadOutput = z.object({
  assetPath: z.string().min(1),
  source: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().positive(),
  collision: z.enum(["created", "renamed", "overwritten"]),
});
export type AssetsImagesUploadOutput = z.infer<typeof AssetsImagesUploadOutput>;

export const ImageGenerationOptions = z
  .object({
    size: z.string().min(1).max(50).optional(),
    quality: z.string().min(1).max(50).optional(),
    background: z.string().min(1).max(50).optional(),
    outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
  })
  .strict();
export type ImageGenerationOptions = z.infer<typeof ImageGenerationOptions>;

export const AssetsImagesGenerateInput = ConnectionSelector.extend({
  prompt: z.string().min(1).max(32_000),
  provider: z.string().min(1).default("deterministic"),
  options: ImageGenerationOptions.default({}),
  sourceId: z.string().min(1).default("data"),
  destinationPath: z.string().min(1).max(1000),
  onCollision: AssetCollisionPolicy.default("error"),
}).strict();
export type AssetsImagesGenerateInput = z.infer<typeof AssetsImagesGenerateInput>;

export const AssetsImagesGenerateOutput = AssetsImagesUploadOutput.extend({
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
});
export type AssetsImagesGenerateOutput = z.infer<typeof AssetsImagesGenerateOutput>;

const AssetAttachmentReference = z
  .object({
    kind: z.literal("reference"),
    sourceId: z.string().min(1),
    path: z.string().min(1).max(1000),
  })
  .strict();

const AssetAttachmentUpload = z
  .object({
    kind: z.literal("upload"),
    sourceId: z.string().min(1).default("data"),
    destinationPath: z.string().min(1).max(1000),
    source: AssetUploadSource,
    onCollision: AssetCollisionPolicy.default("error"),
  })
  .strict();

const AssetAttachmentUrl = z
  .object({
    kind: z.literal("url"),
    sourceId: z.string().min(1).default("data"),
    destinationPath: z.string().min(1).max(1000),
    url: z.string().url().max(4096),
    onCollision: AssetCollisionPolicy.default("error"),
  })
  .strict();

export const AssetsImagesAttachInput = ConnectionSelector.extend({
  documentUuid: z.string().min(1),
  fieldPath: z.string().min(1).max(500).default("img"),
  expectedHash: z.string().min(1).optional(),
  asset: z.discriminatedUnion("kind", [
    AssetAttachmentReference,
    AssetAttachmentUpload,
    AssetAttachmentUrl,
  ]),
}).strict();
export type AssetsImagesAttachInput = z.infer<typeof AssetsImagesAttachInput>;

export const AssetsImagesAttachOutput = z.object({
  documentUuid: z.string().min(1),
  fieldPath: z.string().min(1),
  assetPath: z.string().min(1),
  source: z.string().min(1),
  document: JsonObjectSchema,
});
export type AssetsImagesAttachOutput = z.infer<typeof AssetsImagesAttachOutput>;

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
  model?: string;
}

export interface ImageGenerationProvider {
  readonly id: string;
  /**
   * Explicitly false only for providers guaranteed to stay on this machine.
   * Hosts must conservatively treat an omitted value as requiring network
   * authorization before invoking the provider.
   */
  readonly requiresNetwork?: boolean;
  generate(
    prompt: string,
    options?: ImageGenerationOptions,
    signal?: AbortSignal,
  ): Promise<GeneratedImage>;
}

export interface ImageInspection {
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  extension: ".png" | ".jpg" | ".gif" | ".webp";
  width?: number;
  height?: number;
}

export type ImageInspectionResult =
  { ok: true; value: ImageInspection } | { ok: false; reason: string };

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = offset; index < offset + length; index += 1) {
    value += String.fromCharCode(bytes[index] as number);
  }
  return value;
}

function hasSignature(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function uint16BigEndian(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number);
}

function uint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] as number) * 0x1000000 +
      ((bytes[offset + 1] as number) << 16) +
      ((bytes[offset + 2] as number) << 8) +
      (bytes[offset + 3] as number)) >>>
    0
  );
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const length = uint16BigEndian(bytes, offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (startOfFrame.has(marker) && length >= 7) {
      return {
        height: uint16BigEndian(bytes, offset + 3),
        width: uint16BigEndian(bytes, offset + 5),
      };
    }
    offset += length;
  }
  return undefined;
}

export function inspectImageBytes(
  bytes: Uint8Array,
  options: {
    expectedExtension?: string;
    expectedMimeType?: string;
    maxBytes?: number;
    maxPixels?: number;
    requireDimensions?: boolean;
  } = {},
): ImageInspectionResult {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  if (bytes.byteLength === 0) return { ok: false, reason: "Image payload is empty" };
  if (bytes.byteLength > maxBytes)
    return { ok: false, reason: `Image exceeds the ${maxBytes.toString()} byte limit` };

  let value: ImageInspection | undefined;
  if (
    bytes.length >= 24 &&
    hasSignature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
    hasSignature(bytes, [0x49, 0x48, 0x44, 0x52], 12)
  ) {
    value = {
      mimeType: "image/png",
      extension: ".png",
      width: uint32BigEndian(bytes, 16),
      height: uint32BigEndian(bytes, 20),
    };
  } else if (
    bytes.length >= 10 &&
    (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")
  ) {
    value = {
      mimeType: "image/gif",
      extension: ".gif",
      width: (bytes[6] as number) | ((bytes[7] as number) << 8),
      height: (bytes[8] as number) | ((bytes[9] as number) << 8),
    };
  } else if (hasSignature(bytes, [0xff, 0xd8, 0xff])) {
    value = { mimeType: "image/jpeg", extension: ".jpg", ...jpegDimensions(bytes) };
  } else if (
    bytes.length >= 20 &&
    hasSignature(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    hasSignature(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    value = { mimeType: "image/webp", extension: ".webp" };
    if (ascii(bytes, 12, 4) === "VP8X" && bytes.length >= 30) {
      value.width =
        1 + (bytes[24] as number) + ((bytes[25] as number) << 8) + ((bytes[26] as number) << 16);
      value.height =
        1 + (bytes[27] as number) + ((bytes[28] as number) << 8) + ((bytes[29] as number) << 16);
    } else if (
      ascii(bytes, 12, 4) === "VP8 " &&
      bytes.length >= 30 &&
      hasSignature(bytes, [0x9d, 0x01, 0x2a], 23)
    ) {
      value.width = ((bytes[26] as number) | ((bytes[27] as number) << 8)) & 0x3fff;
      value.height = ((bytes[28] as number) | ((bytes[29] as number) << 8)) & 0x3fff;
    } else if (ascii(bytes, 12, 4) === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      value.width = 1 + (bytes[21] as number) + (((bytes[22] as number) & 0x3f) << 8);
      value.height =
        1 +
        ((bytes[22] as number) >> 6) +
        ((bytes[23] as number) << 2) +
        (((bytes[24] as number) & 0x0f) << 10);
    }
  }
  if (!value) return { ok: false, reason: "Payload is not a supported image format" };

  const expectedMime = options.expectedMimeType?.toLocaleLowerCase().split(";")[0]?.trim();
  if (expectedMime && expectedMime !== value.mimeType)
    return {
      ok: false,
      reason: `Declared MIME type ${expectedMime} does not match ${value.mimeType} magic bytes`,
    };

  const extension = options.expectedExtension?.toLocaleLowerCase();
  const allowedExtensions: Record<ImageInspection["mimeType"], string[]> = {
    "image/png": [".png"],
    "image/jpeg": [".jpg", ".jpeg"],
    "image/gif": [".gif"],
    "image/webp": [".webp"],
  };
  if (extension && !allowedExtensions[value.mimeType].includes(extension))
    return {
      ok: false,
      reason: `Destination extension ${extension} does not match ${value.mimeType} magic bytes`,
    };

  if (value.width !== undefined && value.height !== undefined) {
    if (value.width <= 0 || value.height <= 0)
      return { ok: false, reason: "Image dimensions must be positive" };
    const maxPixels = options.maxPixels ?? MAX_IMAGE_PIXELS;
    if (value.width * value.height > maxPixels)
      return { ok: false, reason: `Image exceeds the ${maxPixels.toString()} pixel limit` };
  } else if (options.requireDimensions) {
    return { ok: false, reason: "Image dimensions could not be determined safely" };
  }
  return { ok: true, value };
}
