import {
  AssetsImagesAttachInput,
  AssetsImagesListInput,
  AssetsImagesUploadInput,
  AssetsReferencesFindInput,
  DEFAULT_IMAGE_EXTENSIONS,
  MAX_EMBEDDED_DEPTH,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  inspectImageBytes,
  makeError,
  type AssetCollisionPolicy,
  type AssetSourceCapability,
  type AssetUploadSource,
  type AssetsImagesAttachOutput,
  type AssetsImagesListOutput,
  type AssetsImagesUploadOutput,
  type AssetsReferencesFindOutput,
  type ErrorCode,
  type ErrorEnvelope,
  type ImageReference,
  type JsonObject,
  type JsonValue,
  type OperationResult,
  type OperationExecutionOptions,
} from "@foundry-mcp/protocol";

import { MAX_RUNTIME_IMAGE_DIMENSION, type FoundryAssetRuntimeAdapter } from "./asset-runtime.js";
import { FoundryDocumentService } from "./documents.js";
import type { FoundryRuntimeAdapter } from "./runtime.js";

export interface AssetPayload {
  bytes: Uint8Array;
  mimeType?: string;
}

export interface FoundryAssetServiceOptions {
  loadLocalFile?: (path: string, maxBytes: number, signal?: AbortSignal) => Promise<AssetPayload>;
  importUrl?: (url: string, maxBytes: number, signal?: AbortSignal) => Promise<AssetPayload>;
  maxImageBytes?: number;
  maxImageWidth?: number;
  maxImageHeight?: number;
  maxImagePixels?: number;
}

class AssetOperationError extends Error {
  constructor(readonly envelope: ErrorEnvelope) {
    super(envelope.message);
  }
}

function operationError(
  code: ErrorCode,
  message: string,
  details?: unknown,
  retryable = false,
): never {
  throw new AssetOperationError(makeError(code, message, retryable, details));
}

function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof AssetOperationError) return error.envelope;
  return makeError("FOUNDRY_ERROR", error instanceof Error ? error.message : String(error));
}

function normalizeExtension(value: string): string {
  const extension = value.toLocaleLowerCase();
  return extension.startsWith(".") ? extension : `.${extension}`;
}

function extensionOf(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot < 0 ? "" : file.slice(dot).toLocaleLowerCase();
}

function normalizedRuntimePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

function positiveImageLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function boundedImageLimit(value: number, hardMaximum: number, label: string): number {
  const validated = positiveImageLimit(value, label);
  if (validated > hardMaximum)
    throw new Error(`${label} cannot exceed the ${hardMaximum.toString()} hard limit`);
  return validated;
}

export function validateAssetPath(path: string, options: { allowEmpty?: boolean } = {}): string {
  if (path.length === 0 && options.allowEmpty) return "";
  if (path.length === 0) operationError("INVALID_DATA", "Asset path is required");
  if (path.includes("\0") || path.includes("\\"))
    operationError("INVALID_DATA", "Asset paths must use relative forward-slash paths");
  if (/^(?:[a-z]:|\/|\\|[a-z][a-z0-9+.-]*:)/i.test(path))
    operationError(
      "INVALID_DATA",
      "Absolute, drive-letter, UNC, and URL asset paths are forbidden",
    );
  let decoded = path;
  try {
    for (let pass = 0; pass < 4; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    operationError("INVALID_DATA", "Asset path contains malformed percent encoding");
  }
  if (/%[0-9a-f]{2}/i.test(decoded))
    operationError("INVALID_DATA", "Asset path contains excessive nested percent encoding");
  if (decoded.includes("\\") || decoded.startsWith("/"))
    operationError("INVALID_DATA", "Encoded absolute or backslash asset paths are forbidden");
  const segments = decoded.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".."))
    operationError("INVALID_DATA", "Asset path traversal and empty segments are forbidden");
  if (
    segments.some(
      (segment) =>
        /[<>:"|?*]/.test(segment) ||
        [...segment].some((character) => (character.codePointAt(0) ?? 0) < 0x20),
    )
  )
    operationError("INVALID_DATA", "Asset path contains characters unsafe on Windows");
  return decoded;
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  const normalized = value.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized))
    operationError("INVALID_DATA", "Image source is not valid base64");
  if (Math.floor((normalized.length * 3) / 4) > maxBytes)
    operationError("INVALID_DATA", `Image exceeds the ${maxBytes.toString()} byte limit`);
  try {
    const binary = globalThis.atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    operationError("INVALID_DATA", "Image source is not valid base64");
  }
}

function cursorFingerprint(input: {
  source?: string;
  pathPrefix: string;
  extensions: string[];
  maxDepth: number;
}): string {
  return JSON.stringify({
    source: input.source ?? null,
    pathPrefix: input.pathPrefix,
    extensions: input.extensions.map(normalizeExtension).sort(),
    maxDepth: input.maxDepth,
  });
}

function encodeCursor(fingerprint: string, path: string): string {
  return `v1.${encodeURIComponent(JSON.stringify({ fingerprint, path }))}`;
}

function decodeCursor(value: string | undefined, fingerprint: string): string | undefined {
  if (!value) return undefined;
  try {
    if (!value.startsWith("v1."))
      operationError("INVALID_DATA", "Unsupported asset cursor version");
    const parsed = JSON.parse(decodeURIComponent(value.slice(3))) as {
      fingerprint?: unknown;
      path?: unknown;
    };
    if (parsed.fingerprint !== fingerprint || typeof parsed.path !== "string")
      operationError("INVALID_DATA", "Asset cursor does not match this listing request");
    return parsed.path;
  } catch (error) {
    if (error instanceof AssetOperationError) throw error;
    operationError("INVALID_DATA", "Asset cursor is malformed");
  }
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function looksLikeImagePath(value: string): boolean {
  // Foundry commonly appends cache-busting query/fragment text to an ordinary image path.
  const withoutQuery = value.split(/[?#]/, 1)[0]?.toLocaleLowerCase() ?? "";
  return DEFAULT_IMAGE_EXTENSIONS.some((extension) => withoutQuery.endsWith(extension));
}

function findImageReferences(
  uuid: string,
  value: JsonValue,
  pointer = "",
  output: ImageReference[] = [],
): ImageReference[] {
  if (typeof value === "string") {
    if (looksLikeImagePath(value)) output.push({ uuid, jsonPath: pointer, imagePath: value });
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      findImageReferences(uuid, entry, `${pointer}/${index.toString()}`, output),
    );
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, entry] of Object.entries(value))
    findImageReferences(uuid, entry, `${pointer}/${pointerSegment(key)}`, output);
  return output;
}

function fieldPatch(path: string, value: string): JsonObject {
  const segments = path.split(".");
  if (
    segments.some(
      (segment) =>
        !/^[A-Za-z0-9_-]+$/.test(segment) ||
        segment === "__proto__" ||
        segment === "prototype" ||
        segment === "constructor",
    )
  )
    operationError("INVALID_DATA", "Document image field path is unsafe");
  const output: JsonObject = {};
  let current = output;
  for (const segment of segments.slice(0, -1)) {
    current[segment] = {};
    current = current[segment] as JsonObject;
  }
  const last = segments.at(-1);
  if (!last) operationError("INVALID_DATA", "Document image field path is required");
  current[last] = value;
  return output;
}

interface PreparedUpload {
  sourceId: string;
  targetPath: string;
  bytes: Uint8Array;
  mimeType: string;
  overwrite: boolean;
  collision: "created" | "renamed" | "overwritten";
}

type UploadCompensation = { kind: "delete" } | { kind: "restore"; snapshot: unknown };

export class FoundryAssetService {
  readonly #maxImageBytes: number;
  readonly #maxImageWidth: number;
  readonly #maxImageHeight: number;
  readonly #maxImagePixels: number;

  constructor(
    readonly assets: FoundryAssetRuntimeAdapter,
    readonly documents: FoundryDocumentService,
    readonly documentRuntime: FoundryRuntimeAdapter,
    readonly options: FoundryAssetServiceOptions = {},
  ) {
    this.#maxImageBytes = boundedImageLimit(
      options.maxImageBytes ?? MAX_IMAGE_BYTES,
      MAX_IMAGE_BYTES,
      "maxImageBytes",
    );
    this.#maxImageWidth = boundedImageLimit(
      options.maxImageWidth ?? MAX_RUNTIME_IMAGE_DIMENSION,
      MAX_RUNTIME_IMAGE_DIMENSION,
      "maxImageWidth",
    );
    this.#maxImageHeight = boundedImageLimit(
      options.maxImageHeight ?? MAX_RUNTIME_IMAGE_DIMENSION,
      MAX_RUNTIME_IMAGE_DIMENSION,
      "maxImageHeight",
    );
    this.#maxImagePixels = boundedImageLimit(
      options.maxImagePixels ?? MAX_IMAGE_PIXELS,
      MAX_IMAGE_PIXELS,
      "maxImagePixels",
    );
  }

  async list(
    input: unknown = {},
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<AssetsImagesListOutput>> {
    return this.#run(async () => {
      this.#guard(operation);
      const parsed = AssetsImagesListInput.safeParse(input);
      if (!parsed.success)
        operationError("INVALID_DATA", "Input validation failed", { issues: parsed.error.issues });
      const pathPrefix = validateAssetPath(parsed.data.pathPrefix, { allowEmpty: true });
      const extensions = parsed.data.extensions.map(normalizeExtension);
      const allSources = await this.assets.listSources();
      const selectedSources = parsed.data.source
        ? allSources.filter((source) => source.id === parsed.data.source)
        : allSources;
      if (parsed.data.source && selectedSources.length === 0)
        operationError("NOT_FOUND", `Asset source ${parsed.data.source} was not found`);
      const deduplicated = new Map<string, AssetsImagesListOutput["items"][number]>();
      const truncationReasons = new Set<string>();
      for (const source of selectedSources) {
        const queue: Array<{ path: string; depth: number }> = [{ path: pathPrefix, depth: 0 }];
        const visited = new Set<string>();
        while (queue.length > 0) {
          this.#guard(operation);
          const current = queue.shift();
          if (!current || visited.has(current.path)) continue;
          visited.add(current.path);
          const browsed = await this.assets.browse(source.id, current.path, extensions);
          await this.#progress(
            operation,
            Math.min(900, 100 + visited.size),
            `Scanned ${visited.size.toString()} asset folders`,
          );
          for (const entry of browsed.entries) {
            const entryPath = normalizedRuntimePath(entry.path);
            if (entry.kind === "directory") {
              if (current.depth >= parsed.data.maxDepth) {
                truncationReasons.add(
                  `${source.id}:${entryPath} was not traversed because maxDepth ${parsed.data.maxDepth.toString()} was reached`,
                );
              } else {
                queue.push({ path: entryPath, depth: current.depth + 1 });
              }
              continue;
            }
            // FilePicker source order is authoritative: the first source exposing a path wins.
            if (!extensions.includes(extensionOf(entryPath)) || deduplicated.has(entryPath))
              continue;
            deduplicated.set(entryPath, {
              path: entryPath,
              source: source.id,
              ...(entry.size !== undefined ? { size: entry.size } : {}),
              ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
              writable: source.writable,
              ...(!source.writable && source.reason ? { writeReason: source.reason } : {}),
            });
          }
        }
      }
      const items = [...deduplicated.values()].sort(
        (left, right) =>
          left.path.localeCompare(right.path) || left.source.localeCompare(right.source),
      );
      const fingerprint = cursorFingerprint({
        ...(parsed.data.source ? { source: parsed.data.source } : {}),
        pathPrefix,
        extensions,
        maxDepth: parsed.data.maxDepth,
      });
      const cursor = decodeCursor(parsed.data.cursor, fingerprint);
      const after = cursor ? items.filter((item) => item.path.localeCompare(cursor) > 0) : items;
      const page = after.slice(0, parsed.data.pageSize);
      const output: AssetsImagesListOutput = {
        items: page,
        sources: allSources,
        truncated: truncationReasons.size > 0,
        truncationReasons: [...truncationReasons].sort(),
      };
      const last = page.at(-1);
      if (last && after.length > page.length)
        output.nextCursor = encodeCursor(fingerprint, last.path);
      return output;
    });
  }

  async referencesFind(
    input: unknown,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<AssetsReferencesFindOutput>> {
    return this.#run(async () => {
      this.#guard(operation);
      const parsed = AssetsReferencesFindInput.safeParse(input);
      if (!parsed.success)
        operationError("INVALID_DATA", "Input validation failed", { issues: parsed.error.issues });
      const roots: string[] = [];
      if ("uuids" in parsed.data) roots.push(...parsed.data.uuids);
      else {
        let cursor: string | undefined;
        do {
          const listed = await this.documents.list(
            {
              ...parsed.data.query,
              pageSize: 200,
              ...(cursor ? { cursor } : {}),
            },
            operation,
          );
          if (!listed.ok) throw new AssetOperationError(listed.error);
          roots.push(...listed.value.items.map((item) => item.uuid));
          cursor = listed.value.nextCursor;
        } while (cursor);
      }
      const uuids = new Set<string>();
      for (const rootUuid of roots) {
        this.#guard(operation);
        uuids.add(rootUuid);
        let cursor: string | undefined;
        do {
          const embedded = await this.documents.embeddedList(
            {
              parentUuid: rootUuid,
              recursive: true,
              maxDepth: MAX_EMBEDDED_DEPTH,
              pageSize: 200,
              ...(cursor ? { cursor } : {}),
            },
            operation,
          );
          if (!embedded.ok) throw new AssetOperationError(embedded.error);
          embedded.value.items.forEach((item) => uuids.add(item.uuid));
          cursor = embedded.value.nextCursor;
        } while (cursor);
      }
      const references: ImageReference[] = [];
      for (const uuid of uuids) {
        this.#guard(operation);
        const document = await this.documents.get({ uuid }, operation);
        if (!document.ok) throw new AssetOperationError(document.error);
        findImageReferences(uuid, document.value.data, "", references);
      }
      references.sort(
        (left, right) =>
          left.uuid.localeCompare(right.uuid) ||
          left.jsonPath.localeCompare(right.jsonPath) ||
          left.imagePath.localeCompare(right.imagePath),
      );
      return { references };
    });
  }

  async upload(
    input: unknown,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<AssetsImagesUploadOutput>> {
    return this.#run(async () => {
      this.#guard(operation);
      const parsed = AssetsImagesUploadInput.safeParse(input);
      if (!parsed.success)
        operationError("INVALID_DATA", "Input validation failed", { issues: parsed.error.issues });
      const prepared = await this.#prepareUpload(
        parsed.data.sourceId,
        parsed.data.destinationPath,
        parsed.data.source,
        parsed.data.onCollision,
        operation,
      );
      return this.#commitUpload(prepared, operation);
    });
  }

  async attach(
    input: unknown,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<AssetsImagesAttachOutput>> {
    return this.#run(async () => {
      this.#guard(operation);
      const parsed = AssetsImagesAttachInput.safeParse(input);
      if (!parsed.success)
        operationError("INVALID_DATA", "Input validation failed", { issues: parsed.error.issues });
      try {
        await this.documentRuntime.parseUuid(parsed.data.documentUuid);
      } catch {
        operationError("INVALID_DATA", `UUID ${parsed.data.documentUuid} is malformed`);
      }
      const runtimeDocument = await this.documentRuntime.fromUuid(parsed.data.documentUuid);
      if (!runtimeDocument)
        operationError("NOT_FOUND", `Document ${parsed.data.documentUuid} was not found`);
      const permission = this.documentRuntime.canUpdate(runtimeDocument);
      if (!permission.allowed)
        operationError(
          "PERMISSION_DENIED",
          permission.reason ?? "The connected user cannot update this Document",
        );
      const before = await this.documents.get({ uuid: parsed.data.documentUuid }, operation);
      if (!before.ok) throw new AssetOperationError(before.error);
      if (parsed.data.expectedHash && parsed.data.expectedHash !== before.value.sourceHash)
        operationError("CONFLICT", "Document source hash does not match", {
          expected: parsed.data.expectedHash,
          actual: before.value.sourceHash,
        });

      let prepared: PreparedUpload | undefined;
      let sourceId: string;
      let assetPath: string;
      if (parsed.data.asset.kind === "reference") {
        sourceId = parsed.data.asset.sourceId;
        assetPath = validateAssetPath(parsed.data.asset.path);
        if (!(await this.assets.exists(sourceId, assetPath)))
          operationError("NOT_FOUND", `Asset ${sourceId}:${assetPath} was not found`);
      } else {
        sourceId = parsed.data.asset.sourceId;
        const source: AssetUploadSource =
          parsed.data.asset.kind === "url"
            ? await this.#urlSource(parsed.data.asset.url, operation)
            : parsed.data.asset.source;
        prepared = await this.#prepareUpload(
          sourceId,
          parsed.data.asset.destinationPath,
          source,
          parsed.data.asset.onCollision,
          operation,
        );
        assetPath = prepared.targetPath;
      }

      const compensation = prepared ? await this.#prepareCompensation(prepared) : undefined;
      let uploaded: AssetsImagesUploadOutput | undefined;
      let documentCommitted = false;
      try {
        await this.documentRuntime.audit({
          action: "asset.image.attach",
          uuid: parsed.data.documentUuid,
          details: {
            phase: "attempt",
            fieldPath: parsed.data.fieldPath,
            assetPath,
            source: sourceId,
            uploaded: prepared !== undefined,
          },
        });
        if (prepared) {
          uploaded = await this.#commitUpload(prepared, operation);
          assetPath = uploaded.assetPath;
        }
        this.#guard(operation);
        const updated = await this.documents.update(
          {
            uuid: parsed.data.documentUuid,
            data: fieldPatch(parsed.data.fieldPath, assetPath),
            expectedHash: before.value.sourceHash,
          },
          operation,
        );
        if (!updated.ok) throw new AssetOperationError(updated.error);
        documentCommitted = true;
        return {
          documentUuid: parsed.data.documentUuid,
          fieldPath: parsed.data.fieldPath,
          assetPath,
          source: sourceId,
          document: updated.value.document.data,
        };
      } catch (error) {
        if (prepared && compensation && !documentCommitted) {
          try {
            await this.#compensateUpload(prepared, uploaded, compensation);
          } catch (rollbackError) {
            operationError("FOUNDRY_ERROR", "Image attachment and its asset rollback both failed", {
              attachError: error instanceof Error ? error.message : String(error),
              rollbackError:
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
          }
        }
        throw error;
      }
    });
  }

  async #prepareCompensation(prepared: PreparedUpload): Promise<UploadCompensation> {
    if (prepared.collision === "overwritten") {
      if (!this.assets.snapshotState || !this.assets.restoreState)
        operationError(
          "FOUNDRY_ERROR",
          "Atomic overwrite attachment is unavailable; upload first, then attach by reference",
        );
      return { kind: "restore", snapshot: await this.assets.snapshotState() };
    }
    if (!this.assets.delete)
      operationError(
        "FOUNDRY_ERROR",
        "Atomic upload attachment is unavailable; upload first, then attach by reference",
      );
    if (await this.#assetIsReferenced(prepared.targetPath))
      operationError(
        "CONFLICT",
        `Asset path ${prepared.targetPath} is already referenced and cannot be safely compensated`,
      );
    return { kind: "delete" };
  }

  async #compensateUpload(
    prepared: PreparedUpload,
    uploaded: AssetsImagesUploadOutput | undefined,
    compensation: UploadCompensation,
  ): Promise<void> {
    if (compensation.kind === "restore") {
      const restoreState = this.assets.restoreState;
      if (!restoreState) throw new Error("Asset restore capability disappeared during rollback");
      await restoreState.call(this.assets, compensation.snapshot);
      return;
    }
    const path = uploaded?.assetPath ?? prepared.targetPath;
    if (!(await this.assets.exists(prepared.sourceId, path))) return;
    // A different operation may have begun referencing the just-created path.
    // Preserve it rather than turning a failed attachment into broken content.
    if (await this.#assetIsReferenced(path)) return;
    const deleteAsset = this.assets.delete;
    if (!deleteAsset) throw new Error("Asset delete capability disappeared during rollback");
    await deleteAsset.call(this.assets, prepared.sourceId, path);
  }

  async #assetIsReferenced(assetPath: string): Promise<boolean> {
    const normalized = normalizedRuntimePath(assetPath);
    const types = await this.documents.types({});
    if (!types.ok)
      operationError("FOUNDRY_ERROR", "Could not enumerate Document types before compensation", {
        cause: types.error,
      });
    for (const type of types.value.types) {
      if (type.embedded) continue;
      // An unreadable root type means absence of references cannot be proven.
      if (!type.readable) return true;
      const found = await this.referencesFind({ query: { type: type.type } });
      if (!found.ok)
        operationError("FOUNDRY_ERROR", "Could not verify asset references before compensation", {
          type: type.type,
          cause: found.error,
        });
      if (
        found.value.references.some((reference) => {
          const referencedPath = reference.imagePath.split(/[?#]/, 1)[0] ?? "";
          return normalizedRuntimePath(referencedPath) === normalized;
        })
      )
        return true;
    }
    return false;
  }

  async #urlSource(url: string, operation?: OperationExecutionOptions): Promise<AssetUploadSource> {
    if (!this.options.importUrl)
      operationError("INVALID_DATA", "URL import is unavailable on this host");
    const payload = await this.options.importUrl(url, this.#maxImageBytes, operation?.signal);
    this.#guard(operation);
    let binary = "";
    for (const byte of payload.bytes) binary += String.fromCharCode(byte);
    return {
      kind: "base64",
      data: globalThis.btoa(binary),
      ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
    };
  }

  async #prepareUpload(
    sourceId: string,
    destinationPath: string,
    source: AssetUploadSource,
    collisionPolicy: AssetCollisionPolicy,
    operation?: OperationExecutionOptions,
  ): Promise<PreparedUpload> {
    this.#guard(operation);
    const target = validateAssetPath(destinationPath);
    const extension = extensionOf(target);
    if (!DEFAULT_IMAGE_EXTENSIONS.includes(extension as (typeof DEFAULT_IMAGE_EXTENSIONS)[number]))
      operationError(
        "INVALID_DATA",
        `Destination extension ${extension || "(none)"} is unsupported`,
      );
    const capability = await this.#writableSource(sourceId);
    let targetPath = target;
    const exists = await this.assets.exists(sourceId, targetPath);
    let collision: PreparedUpload["collision"] = "created";
    let overwrite = false;
    if (exists) {
      if (collisionPolicy === "error")
        operationError("CONFLICT", `Asset ${sourceId}:${targetPath} already exists`);
      if (collisionPolicy === "overwrite") {
        overwrite = true;
        collision = "overwritten";
      } else {
        const dot = target.lastIndexOf(".");
        const stem = dot < 0 ? target : target.slice(0, dot);
        const suffix = dot < 0 ? "" : target.slice(dot);
        let counter = 1;
        do {
          targetPath = `${stem}-${counter.toString()}${suffix}`;
          counter += 1;
        } while ((await this.assets.exists(sourceId, targetPath)) && counter <= 10_000);
        if (counter > 10_000)
          operationError("CONFLICT", "Could not find a collision-safe asset filename");
        collision = "renamed";
      }
    }
    const payload = await this.#resolvePayload(source, operation);
    this.#guard(operation);
    const inspected = inspectImageBytes(payload.bytes, {
      expectedExtension: extensionOf(targetPath),
      ...(payload.mimeType ? { expectedMimeType: payload.mimeType } : {}),
      maxBytes: this.#maxImageBytes,
      maxPixels: this.#maxImagePixels,
      requireDimensions: true,
    });
    if (!inspected.ok) operationError("INVALID_DATA", inspected.reason);
    if (
      (inspected.value.width !== undefined && inspected.value.width > this.#maxImageWidth) ||
      (inspected.value.height !== undefined && inspected.value.height > this.#maxImageHeight)
    ) {
      operationError("INVALID_DATA", "Image header dimensions exceed the configured limits");
    }
    const decodeImage = this.assets.decodeImage;
    if (typeof decodeImage !== "function")
      operationError("INVALID_DATA", "Safe image decoding is unavailable");
    let decoded: { width: number; height: number };
    try {
      decoded = await decodeImage.call(this.assets, payload.bytes, inspected.value.mimeType, {
        maxBytes: this.#maxImageBytes,
        maxWidth: this.#maxImageWidth,
        maxHeight: this.#maxImageHeight,
        maxPixels: this.#maxImagePixels,
      });
    } catch {
      operationError("INVALID_DATA", "Image could not be decoded safely");
    }
    if (
      !Number.isSafeInteger(decoded.width) ||
      !Number.isSafeInteger(decoded.height) ||
      decoded.width <= 0 ||
      decoded.height <= 0 ||
      decoded.width > this.#maxImageWidth ||
      decoded.height > this.#maxImageHeight ||
      decoded.width * decoded.height > this.#maxImagePixels
    ) {
      operationError("INVALID_DATA", "Decoded image dimensions exceed the configured limits");
    }
    if (
      (inspected.value.width !== undefined && inspected.value.width !== decoded.width) ||
      (inspected.value.height !== undefined && inspected.value.height !== decoded.height)
    ) {
      operationError("INVALID_DATA", "Decoded image dimensions do not match its image headers");
    }
    void capability;
    return {
      sourceId,
      targetPath,
      bytes: payload.bytes,
      mimeType: inspected.value.mimeType,
      overwrite,
      collision,
    };
  }

  async #resolvePayload(
    source: AssetUploadSource,
    operation?: OperationExecutionOptions,
  ): Promise<AssetPayload> {
    if (source.kind === "file") {
      if (!this.options.loadLocalFile)
        operationError("INVALID_DATA", "Local file loading is unavailable on this host");
      const payload = await this.options.loadLocalFile(
        source.path,
        this.#maxImageBytes,
        operation?.signal,
      );
      this.#guard(operation);
      const mimeType = source.mimeType ?? payload.mimeType;
      return { bytes: payload.bytes, ...(mimeType ? { mimeType } : {}) };
    }
    return {
      bytes: decodeBase64(source.data, this.#maxImageBytes),
      ...(source.mimeType ? { mimeType: source.mimeType } : {}),
    };
  }

  async #writableSource(sourceId: string): Promise<AssetSourceCapability> {
    const source = (await this.assets.listSources()).find((candidate) => candidate.id === sourceId);
    if (!source) operationError("NOT_FOUND", `Asset source ${sourceId} was not found`);
    if (!source.writable)
      operationError("PERMISSION_DENIED", source.reason ?? `Asset source ${sourceId} is read-only`);
    return source;
  }

  async #commitUpload(
    prepared: PreparedUpload,
    operation?: OperationExecutionOptions,
  ): Promise<AssetsImagesUploadOutput> {
    this.#guard(operation);
    const stored = await this.assets.upload(
      prepared.sourceId,
      prepared.targetPath,
      prepared.bytes,
      prepared.mimeType,
      { overwrite: prepared.overwrite },
    );
    operation?.markCommitted?.(`stored asset ${prepared.sourceId}:${prepared.targetPath}`);
    return {
      assetPath: normalizedRuntimePath(stored.path),
      source: prepared.sourceId,
      mimeType: prepared.mimeType,
      size: prepared.bytes.byteLength,
      collision: prepared.collision,
    };
  }

  async #run<T>(operation: () => Promise<T>): Promise<OperationResult<T>> {
    try {
      if (!this.assets.isOnline())
        operationError("OFFLINE_BRIDGE", "The Foundry asset runtime is offline", undefined, true);
      return { ok: true, value: await operation() };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  }

  #guard(operation?: OperationExecutionOptions): void {
    if (operation?.signal?.aborted) operationError("CANCELLED", "Operation was cancelled");
    if (operation?.deadline !== undefined && Date.now() >= operation.deadline) {
      operationError("TIMEOUT", "Operation deadline elapsed", undefined, true);
    }
  }

  async #progress(
    operation: OperationExecutionOptions | undefined,
    progress: number,
    message: string,
  ): Promise<void> {
    await operation?.reportProgress?.({ stage: "progress", progress, total: 1_000, message });
  }
}

export { findImageReferences };
