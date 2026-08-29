import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  inspectImageBytes,
  type AssetSourceCapability,
} from "@foundry-mcp/protocol";

import { AssetPathValidationError, canonicalAssetPath } from "./asset-path.js";

export const MAX_RUNTIME_IMAGE_DIMENSION = 16_384;
export const MAX_ASSET_SOURCE_CAPABILITIES_SETTING_LENGTH = 16_384;

const MAX_CONFIGURED_ASSET_SOURCES = 16;
const MAX_WRITABLE_PATH_PREFIXES = 32;
const MAX_SOURCE_ID_LENGTH = 64;
const MAX_BUCKET_LENGTH = 255;
const MAX_PATH_PREFIX_LENGTH = 500;
const MAX_CAPABILITY_REASON_LENGTH = 500;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const BUCKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CAPABILITY_KEYS = new Set(["writable", "bucket", "writablePathPrefixes", "reason"]);
const FORBIDDEN_SOURCE_IDS = new Set(["__proto__", "constructor", "data", "prototype", "public"]);

export interface RuntimeAssetEntry {
  path: string;
  kind: "file" | "directory";
  size?: number;
  mimeType?: string;
}

export interface RuntimeAssetBrowseResult {
  entries: RuntimeAssetEntry[];
}

export interface RuntimeAssetUploadResult {
  path: string;
}

export interface RuntimeImageDecodeLimits {
  maxBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
}

export interface RuntimeDecodedImage {
  width: number;
  height: number;
}

export interface FoundryAssetRuntimeAdapter {
  isOnline(): boolean;
  listSources(): Promise<AssetSourceCapability[]>;
  /** Non-mutating, destination-aware write preflight. Production runtimes must fail closed. */
  getWriteCapability?(sourceId: string, destinationPath: string): Promise<AssetSourceCapability>;
  browse(sourceId: string, path: string, extensions?: string[]): Promise<RuntimeAssetBrowseResult>;
  exists(sourceId: string, path: string): Promise<boolean>;
  decodeImage(
    bytes: Uint8Array,
    mimeType: string,
    limits: RuntimeImageDecodeLimits,
  ): Promise<RuntimeDecodedImage>;
  upload(
    sourceId: string,
    path: string,
    bytes: Uint8Array,
    mimeType: string,
    options: { overwrite: boolean },
  ): Promise<RuntimeAssetUploadResult>;
  delete?(sourceId: string, path: string): Promise<void>;
  snapshotState?(): unknown | Promise<unknown>;
  restoreState?(snapshot: unknown): void | Promise<void>;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? (value as UnknownRecord)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function values(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value instanceof Map || value instanceof Set) return [...value.values()];
  return Object.values(record(value));
}

function filePickerConstructor(globalValue: UnknownRecord): UnknownRecord {
  const foundry = record(globalValue.foundry);
  const applications = record(foundry.applications);
  const apps = record(applications.apps);
  const candidate = apps.FilePicker ?? globalValue.FilePicker;
  if (typeof candidate !== "function") throw new Error("Foundry FilePicker is unavailable");
  return candidate as unknown as UnknownRecord;
}

function pickerSourceIds(FilePicker: UnknownRecord): string[] {
  const ids = new Set<string>();
  try {
    const instance = Reflect.construct(FilePicker as unknown as new () => object, [
      { type: "image" },
    ]);
    for (const id of Object.keys(record(record(instance).sources))) ids.add(id);
  } catch {
    // Static browse remains usable on versions where constructing a picker requires rendered UI.
  }
  ids.add("data");
  ids.add("public");
  if (values(FilePicker.S3_BUCKETS).length > 0) ids.add("s3");
  return [...ids];
}

function canUpload(globalValue: UnknownRecord): boolean {
  const user = record(record(globalValue.game).user);
  if (user.isGM === true) return true;
  const can = user.can;
  if (typeof can !== "function") return false;
  try {
    return can.call(user, "FILES_UPLOAD") === true;
  } catch {
    return false;
  }
}

function pathFromPickerEntry(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const entry = record(value);
  return stringValue(entry.path) ?? stringValue(entry.url) ?? stringValue(entry.name);
}

const ACTIVE_MARKUP_PREFIXES = ["<svg", "<script", "<!doctype", "<?xml"] as const;

function lowerAscii(byte: number): number {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

function containsActiveMarkup(bytes: Uint8Array): boolean {
  for (let offset = 0; offset < bytes.length; offset += 1) {
    if (bytes[offset] !== 0x3c) continue;
    for (const prefix of ACTIVE_MARKUP_PREFIXES) {
      if (offset + prefix.length > bytes.length) continue;
      let matches = true;
      for (let index = 0; index < prefix.length; index += 1) {
        if (lowerAscii(bytes[offset + index] as number) !== prefix.charCodeAt(index)) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
  }
  return false;
}

function decodedDimension(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Decoded image ${name} is invalid`);
  }
  return Number(value);
}

function boundedDecodeLimit(value: number, hardMaximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} is invalid`);
  return Math.min(value, hardMaximum);
}

export interface BrowserFoundryAssetSourceCapability {
  writable: boolean;
  reason?: string;
  /** Explicitly authorized destination prefixes for non-core providers. */
  writablePathPrefixes?: readonly string[];
  /** Required to substantiate access to an S3 provider destination. */
  bucket?: string;
}

export type BrowserFoundryAssetSourceCapabilities = Record<
  string,
  BrowserFoundryAssetSourceCapability
>;

export type AssetSourceCapabilitiesSettingResult =
  { ok: true; value: BrowserFoundryAssetSourceCapabilities } | { ok: false; error: string };

function invalidCapabilities(error: string): AssetSourceCapabilitiesSettingResult {
  return { ok: false, error };
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function parsePathPrefixes(
  sourceId: string,
  value: unknown,
): { ok: true; value?: string[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value) || value.length > MAX_WRITABLE_PATH_PREFIXES) {
    return {
      ok: false,
      error: `${sourceId}.writablePathPrefixes must be an array with at most ${MAX_WRITABLE_PATH_PREFIXES} entries`,
    };
  }
  const prefixes: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") {
      return { ok: false, error: `${sourceId}.writablePathPrefixes must contain only strings` };
    }
    let prefix: string;
    try {
      prefix = canonicalAssetPath(candidate);
    } catch (error) {
      if (!(error instanceof AssetPathValidationError)) throw error;
      return {
        ok: false,
        error: `${sourceId}.writablePathPrefixes contains an invalid relative Foundry path`,
      };
    }
    if (
      candidate.length > MAX_PATH_PREFIX_LENGTH ||
      prefix.length > MAX_PATH_PREFIX_LENGTH ||
      prefix.includes("#") ||
      containsControlCharacter(prefix)
    ) {
      return {
        ok: false,
        error: `${sourceId}.writablePathPrefixes contains an invalid relative Foundry path`,
      };
    }
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }
  return { ok: true, value: prefixes };
}

/** Parses the GM-controlled world setting without accepting credentials or unbounded input. */
export function parseAssetSourceCapabilitiesSetting(
  raw: unknown,
): AssetSourceCapabilitiesSettingResult {
  if (typeof raw !== "string") return invalidCapabilities("the setting must be a JSON string");
  const source = raw.trim();
  if (source.length === 0) return { ok: true, value: {} };
  if (source.length > MAX_ASSET_SOURCE_CAPABILITIES_SETTING_LENGTH) {
    return invalidCapabilities(
      `the setting exceeds ${MAX_ASSET_SOURCE_CAPABILITIES_SETTING_LENGTH} characters`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return invalidCapabilities("the setting is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalidCapabilities("the setting root must be an object keyed by Foundry source ID");
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_CONFIGURED_ASSET_SOURCES) {
    return invalidCapabilities(
      `the setting contains more than ${MAX_CONFIGURED_ASSET_SOURCES} asset sources`,
    );
  }
  const capabilities: BrowserFoundryAssetSourceCapabilities = Object.create(null) as Record<
    string,
    BrowserFoundryAssetSourceCapability
  >;
  for (const [sourceId, rawCapability] of entries) {
    if (
      sourceId.length === 0 ||
      sourceId.length > MAX_SOURCE_ID_LENGTH ||
      !SOURCE_ID_PATTERN.test(sourceId) ||
      FORBIDDEN_SOURCE_IDS.has(sourceId)
    ) {
      return invalidCapabilities(`asset source ID ${sourceId || "(empty)"} is not allowed`);
    }
    if (
      rawCapability === null ||
      typeof rawCapability !== "object" ||
      Array.isArray(rawCapability)
    ) {
      return invalidCapabilities(`${sourceId} must contain a capability object`);
    }
    const capability = rawCapability as Record<string, unknown>;
    const unknownKey = Object.keys(capability).find((key) => !CAPABILITY_KEYS.has(key));
    if (unknownKey) {
      return invalidCapabilities(
        `${sourceId} contains unsupported field ${unknownKey}; credentials are not accepted`,
      );
    }
    if (typeof capability.writable !== "boolean") {
      return invalidCapabilities(`${sourceId}.writable must be a boolean`);
    }

    const prefixes = parsePathPrefixes(sourceId, capability.writablePathPrefixes);
    if (!prefixes.ok) return invalidCapabilities(prefixes.error);
    if (capability.writable && (!prefixes.value || prefixes.value.length === 0)) {
      return invalidCapabilities(
        `${sourceId}.writablePathPrefixes must authorize at least one path when writable is true`,
      );
    }

    let bucket: string | undefined;
    if (capability.bucket !== undefined) {
      if (typeof capability.bucket !== "string") {
        return invalidCapabilities(`${sourceId}.bucket must be a string`);
      }
      bucket = capability.bucket.trim();
      if (
        bucket.length === 0 ||
        bucket.length > MAX_BUCKET_LENGTH ||
        !BUCKET_PATTERN.test(bucket)
      ) {
        return invalidCapabilities(`${sourceId}.bucket is invalid`);
      }
    }
    if (sourceId === "s3" && !bucket) {
      return invalidCapabilities("s3.bucket is required");
    }

    let reason: string | undefined;
    if (capability.reason !== undefined) {
      if (typeof capability.reason !== "string") {
        return invalidCapabilities(`${sourceId}.reason must be a string`);
      }
      reason = capability.reason.trim();
      if (reason.length === 0 || reason.length > MAX_CAPABILITY_REASON_LENGTH) {
        return invalidCapabilities(`${sourceId}.reason must contain 1 to 500 characters`);
      }
    }
    capabilities[sourceId] = {
      writable: capability.writable,
      ...(bucket ? { bucket } : {}),
      ...(prefixes.value ? { writablePathPrefixes: prefixes.value } : {}),
      ...(reason ? { reason } : {}),
    };
  }
  return { ok: true, value: capabilities };
}

export interface BrowserFoundryAssetRuntimeOptions {
  global?: unknown;
  sourceCapabilities?: BrowserFoundryAssetSourceCapabilities;
}

/** Uses only Foundry's public FilePicker surface; it never reads the browser host filesystem. */
export class BrowserFoundryAssetRuntime implements FoundryAssetRuntimeAdapter {
  readonly #global: UnknownRecord;
  readonly #configuredCapabilities: NonNullable<
    BrowserFoundryAssetRuntimeOptions["sourceCapabilities"]
  >;

  constructor(options: BrowserFoundryAssetRuntimeOptions = {}) {
    this.#global = record(options.global ?? globalThis);
    this.#configuredCapabilities = options.sourceCapabilities ?? {};
  }

  isOnline(): boolean {
    return record(this.#global.game).ready !== false;
  }

  async listSources(): Promise<AssetSourceCapability[]> {
    const FilePicker = filePickerConstructor(this.#global);
    const uploadAllowed = canUpload(this.#global);
    return pickerSourceIds(FilePicker).map((id) => {
      const configured = this.#configuredCapabilities[id];
      if (id === "public") {
        return {
          id,
          writable: false,
          reason: "Foundry core public assets are read-only",
        };
      }
      if (!uploadAllowed)
        return { id, writable: false, reason: "The connected Foundry user cannot upload files" };
      if (typeof FilePicker.upload !== "function")
        return { id, writable: false, reason: "Foundry FilePicker.upload() is unavailable" };
      if (configured) {
        if (!configured.writable) {
          return {
            id,
            writable: false,
            reason: configured.reason ?? `Asset source ${id} is configured read-only`,
          };
        }
        if (id !== "data" && !configured.writablePathPrefixes?.length) {
          return {
            id,
            writable: false,
            reason: `Foundry source ${id} requires at least one configured writable path`,
          };
        }
        if (id === "s3" && !configured.bucket) {
          return {
            id,
            writable: false,
            reason: "The S3 destination requires an explicitly configured bucket",
          };
        }
        return {
          id,
          writable: true,
        };
      }
      if (id !== "data") {
        return {
          id,
          writable: false,
          reason: `Foundry source ${id} requires explicit provider and destination configuration`,
        };
      }
      return { id, writable: true };
    });
  }

  async getWriteCapability(
    sourceId: string,
    destinationPath: string,
  ): Promise<AssetSourceCapability> {
    const FilePicker = filePickerConstructor(this.#global);
    if (!pickerSourceIds(FilePicker).includes(sourceId))
      return { id: sourceId, writable: false, reason: `Asset source ${sourceId} is unavailable` };
    if (sourceId === "public")
      return { id: sourceId, writable: false, reason: "Foundry core public assets are read-only" };
    if (!canUpload(this.#global))
      return {
        id: sourceId,
        writable: false,
        reason: "The connected Foundry user cannot upload files",
      };
    if (typeof FilePicker.upload !== "function")
      return {
        id: sourceId,
        writable: false,
        reason: "Foundry FilePicker.upload() is unavailable",
      };

    const configured = this.#configuredCapabilities[sourceId];
    if (configured?.writable === false)
      return {
        id: sourceId,
        writable: false,
        reason: configured.reason ?? `Asset source ${sourceId} is configured read-only`,
      };
    let normalizedPath: string;
    try {
      normalizedPath = canonicalAssetPath(destinationPath);
    } catch (error) {
      if (!(error instanceof AssetPathValidationError)) throw error;
      return {
        id: sourceId,
        writable: false,
        reason: `Destination ${destinationPath} is not a safe relative Foundry path`,
      };
    }
    const prefixes: string[] = [];
    for (const configuredPrefix of configured?.writablePathPrefixes ?? []) {
      try {
        prefixes.push(canonicalAssetPath(configuredPrefix));
      } catch (error) {
        if (!(error instanceof AssetPathValidationError)) throw error;
        return {
          id: sourceId,
          writable: false,
          reason: `Foundry source ${sourceId} contains an invalid configured writable path`,
        };
      }
    }
    if (sourceId !== "data" && configured?.writable === true && !prefixes?.length) {
      return {
        id: sourceId,
        writable: false,
        reason: `Foundry source ${sourceId} requires at least one configured writable path`,
      };
    }
    if (
      prefixes &&
      prefixes.length > 0 &&
      !prefixes.some(
        (prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`),
      )
    ) {
      return {
        id: sourceId,
        writable: false,
        reason: `Destination ${destinationPath} is outside the configured writable paths for ${sourceId}`,
      };
    }
    if (sourceId !== "data" && configured?.writable !== true) {
      return {
        id: sourceId,
        writable: false,
        reason: `Foundry source ${sourceId} requires explicit provider and destination configuration`,
      };
    }
    if (sourceId === "s3" && !configured?.bucket) {
      return {
        id: sourceId,
        writable: false,
        reason: "The S3 destination requires an explicitly configured bucket",
      };
    }

    const slash = normalizedPath.lastIndexOf("/");
    const directory = slash < 0 ? "" : normalizedPath.slice(0, slash);
    const browse = FilePicker.browse;
    if (typeof browse !== "function") {
      return {
        id: sourceId,
        writable: false,
        reason: "Foundry FilePicker.browse() is unavailable for destination validation",
      };
    }
    try {
      await browse.call(FilePicker, sourceId, directory, {
        ...(configured?.bucket ? { bucket: configured.bucket } : {}),
      });
    } catch {
      return {
        id: sourceId,
        writable: false,
        reason: `Destination directory ${directory || "/"} could not be accessed for ${sourceId}`,
      };
    }
    return { id: sourceId, writable: true };
  }

  async browse(
    sourceId: string,
    path: string,
    extensions?: string[],
  ): Promise<RuntimeAssetBrowseResult> {
    const FilePicker = filePickerConstructor(this.#global);
    const browse = FilePicker.browse;
    if (typeof browse !== "function") throw new Error("Foundry FilePicker.browse() is unavailable");
    const normalizedPath = canonicalAssetPath(path, { allowEmpty: true });
    const raw = record(
      await browse.call(FilePicker, sourceId, normalizedPath, {
        ...(extensions ? { extensions } : {}),
        ...(this.#configuredCapabilities[sourceId]?.bucket
          ? { bucket: this.#configuredCapabilities[sourceId]?.bucket }
          : {}),
      }),
    );
    const entries: RuntimeAssetEntry[] = [];
    for (const directory of values(raw.dirs ?? raw.directories)) {
      const entryPath = pathFromPickerEntry(directory);
      if (entryPath) entries.push({ path: entryPath, kind: "directory" });
    }
    for (const file of values(raw.files)) {
      const entryPath = pathFromPickerEntry(file);
      if (!entryPath) continue;
      const metadata = record(file);
      const size = typeof metadata.size === "number" ? metadata.size : undefined;
      const mimeType = stringValue(metadata.mimeType) ?? stringValue(metadata.type);
      entries.push({
        path: entryPath,
        kind: "file",
        ...(size !== undefined ? { size } : {}),
        ...(mimeType ? { mimeType } : {}),
      });
    }
    return { entries };
  }

  async exists(sourceId: string, path: string): Promise<boolean> {
    const normalizedPath = canonicalAssetPath(path);
    const slash = normalizedPath.lastIndexOf("/");
    const directory = slash < 0 ? "" : normalizedPath.slice(0, slash);
    const result = await this.browse(sourceId, directory);
    return result.entries.some((entry) => entry.kind === "file" && entry.path === normalizedPath);
  }

  async decodeImage(
    bytes: Uint8Array,
    mimeType: string,
    limits: RuntimeImageDecodeLimits,
  ): Promise<RuntimeDecodedImage> {
    const maxBytes = boundedDecodeLimit(limits.maxBytes, MAX_IMAGE_BYTES, "maxBytes");
    const maxWidth = boundedDecodeLimit(limits.maxWidth, MAX_RUNTIME_IMAGE_DIMENSION, "maxWidth");
    const maxHeight = boundedDecodeLimit(
      limits.maxHeight,
      MAX_RUNTIME_IMAGE_DIMENSION,
      "maxHeight",
    );
    const maxPixels = boundedDecodeLimit(limits.maxPixels, MAX_IMAGE_PIXELS, "maxPixels");
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes)
      throw new Error("Image byte length exceeds the decode limit");
    if (mimeType.toLowerCase().split(";", 1)[0]?.trim() === "image/svg+xml")
      throw new Error("SVG images are not accepted");
    if (containsActiveMarkup(bytes))
      throw new Error("Image payload contains active markup and is not accepted");
    const inspected = inspectImageBytes(bytes, {
      expectedMimeType: mimeType,
      maxBytes,
      maxPixels,
      requireDimensions: true,
    });
    if (!inspected.ok) throw new Error("Image headers are not valid for safe decoding");
    if (
      (inspected.value.width !== undefined && inspected.value.width > maxWidth) ||
      (inspected.value.height !== undefined && inspected.value.height > maxHeight)
    ) {
      throw new Error("Image header dimensions exceed the configured limit");
    }

    const BlobValue = this.#global.Blob;
    const createImageBitmapValue = this.#global.createImageBitmap;
    if (typeof BlobValue !== "function" || typeof createImageBitmapValue !== "function") {
      throw new Error("Browser-native safe image decoding is unavailable");
    }

    const blob = Reflect.construct(BlobValue as unknown as new () => object, [
      [Uint8Array.from(bytes).buffer],
      { type: mimeType },
    ]);
    let bitmap: unknown;
    try {
      bitmap = await createImageBitmapValue.call(this.#global, blob, {
        imageOrientation: "none",
      });
      const decoded = record(bitmap);
      const width = decodedDimension(decoded.width, "width");
      const height = decodedDimension(decoded.height, "height");
      if (width > maxWidth || height > maxHeight)
        throw new Error("Decoded image dimensions exceed the configured limit");
      if (width * height > maxPixels)
        throw new Error("Decoded image pixel count exceeds the configured limit");
      if (
        (inspected.value.width !== undefined && inspected.value.width !== width) ||
        (inspected.value.height !== undefined && inspected.value.height !== height)
      ) {
        throw new Error("Decoded image dimensions do not match its headers");
      }
      return { width, height };
    } catch {
      throw new Error("Image could not be decoded safely");
    } finally {
      const close = record(bitmap).close;
      if (typeof close === "function") close.call(bitmap);
    }
  }

  async upload(
    sourceId: string,
    path: string,
    bytes: Uint8Array,
    mimeType: string,
    options: { overwrite: boolean },
  ): Promise<RuntimeAssetUploadResult> {
    const FilePicker = filePickerConstructor(this.#global);
    const upload = FilePicker.upload;
    if (typeof upload !== "function") throw new Error("Foundry FilePicker.upload() is unavailable");
    const normalizedPath = canonicalAssetPath(path);
    const slash = normalizedPath.lastIndexOf("/");
    const directory = slash < 0 ? "" : normalizedPath.slice(0, slash);
    const name = slash < 0 ? normalizedPath : normalizedPath.slice(slash + 1);
    const FileValue = this.#global.File;
    if (typeof FileValue !== "function")
      throw new Error("The browser File constructor is unavailable");
    const file = Reflect.construct(FileValue as unknown as new () => object, [
      [bytes],
      name,
      { type: mimeType },
    ]);
    const response = record(
      await upload.call(
        FilePicker,
        sourceId,
        directory,
        file,
        {
          overwrite: options.overwrite,
          ...(this.#configuredCapabilities[sourceId]?.bucket
            ? { bucket: this.#configuredCapabilities[sourceId]?.bucket }
            : {}),
        },
        { notify: false },
      ),
    );
    return { path: stringValue(response.path) ?? normalizedPath };
  }
}
