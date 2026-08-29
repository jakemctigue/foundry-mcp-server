import {
  CompendiumDocumentsListInput,
  CompendiumsListInput,
  DocumentsCreateInput,
  DocumentsGetInput,
  DocumentsListInput,
  DocumentsSnapshotInput,
  DocumentsTypesInput,
  DocumentsUpdateInput,
  EmbeddedDocumentsListInput,
  makeError,
  type CompendiumDocumentsListOutput,
  type CompendiumsListOutput,
  type DocumentCreateItem,
  type DocumentCreateResult,
  type DocumentSummary,
  type DocumentView,
  type DocumentsCreateOutput,
  type DocumentsListOutput,
  type DocumentsSnapshotOutput,
  type DocumentsTypesOutput,
  type DocumentsUpdateOutput,
  type EmbeddedDocumentSummary,
  type EmbeddedDocumentsListOutput,
  type ErrorCode,
  type ErrorEnvelope,
  type JsonObject,
  type JsonValue,
  type OperationResult,
} from "@foundry-mcp/protocol";

import type {
  FoundryRuntimeAdapter,
  RuntimeCompendiumIndexEntry,
  RuntimeDocument,
  RuntimeDocumentRegistration,
} from "./runtime.js";

export interface DocumentOperationOptions {
  signal?: AbortSignal;
  deadline?: number;
}

class DocumentOperationError extends Error {
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
  throw new DocumentOperationError(makeError(code, message, retryable, details));
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function cloneJsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol")
    return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const array = value.flatMap((entry) => {
      const cloned = cloneJsonValue(entry, seen);
      return cloned === undefined ? [] : [cloned];
    });
    seen.delete(value);
    return array;
  }
  const output: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const cloned = cloneJsonValue(entry, seen);
    if (cloned !== undefined) output[key] = cloned;
  }
  seen.delete(value);
  return output;
}

function cloneJsonObject(value: unknown): JsonObject {
  const cloned = cloneJsonValue(value);
  if (!cloned || Array.isArray(cloned) || typeof cloned !== "object") return {};
  return cloned;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

export function sourceHash(data: JsonObject): string {
  const value = canonicalJson(data);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fmcp-v1-${hash.toString(16).padStart(8, "0")}`;
}

function sourceVersion(document: RuntimeDocument, data: JsonObject): number | string {
  if (document.revision !== undefined) return document.revision;
  const stats = data._stats;
  if (stats && typeof stats === "object" && !Array.isArray(stats)) {
    const modifiedTime = stats.modifiedTime;
    if (typeof modifiedTime === "number" || typeof modifiedTime === "string") return modifiedTime;
  }
  return sourceHash(data);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface CursorValue {
  kind: string;
  field: "id" | "name" | "uuid";
  direction: "asc" | "desc";
  value: string;
  id: string;
}

function encodeCursor(cursor: CursorValue): string {
  return `v1.${encodeURIComponent(JSON.stringify(cursor))}`;
}

function decodeCursor(value: string | undefined, expectedKind: string): CursorValue | undefined {
  if (!value) return undefined;
  try {
    if (!value.startsWith("v1.")) operationError("INVALID_DATA", "Unsupported cursor version");
    const parsed = JSON.parse(decodeURIComponent(value.slice(3))) as Partial<CursorValue>;
    if (
      parsed.kind !== expectedKind ||
      (parsed.field !== "id" && parsed.field !== "name" && parsed.field !== "uuid") ||
      (parsed.direction !== "asc" && parsed.direction !== "desc") ||
      typeof parsed.value !== "string" ||
      typeof parsed.id !== "string"
    ) {
      operationError("INVALID_DATA", "Cursor does not match this operation");
    }
    return parsed as CursorValue;
  } catch (error) {
    if (error instanceof DocumentOperationError) throw error;
    operationError("INVALID_DATA", "Cursor is malformed");
  }
}

function getPath(source: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue = source;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    const next: JsonValue | undefined = current[segment];
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

function setPath(target: JsonObject, path: string, value: JsonValue): void {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return;
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) current[segment] = {};
    current = current[segment] as JsonObject;
  }
  const last = segments.at(-1);
  if (last) current[last] = value;
}

function projectedData(data: JsonObject, fields: string[] | undefined): JsonObject | undefined {
  if (!fields) return undefined;
  const projected: JsonObject = {};
  for (const field of fields) {
    const value = getPath(data, field);
    if (value !== undefined) setPath(projected, field, value);
  }
  return projected;
}

function folderId(data: JsonObject): string | null | undefined {
  const folder = data.folder;
  if (typeof folder === "string") return folder;
  if (folder === null) return null;
  if (
    folder &&
    typeof folder === "object" &&
    !Array.isArray(folder) &&
    typeof folder.id === "string"
  )
    return folder.id;
  return undefined;
}

function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof DocumentOperationError) return error.envelope;
  const message = error instanceof Error ? error.message : String(error);
  return makeError("FOUNDRY_ERROR", message, false);
}

function errorResult<T>(error: unknown): OperationResult<T> {
  return { ok: false, error: toErrorEnvelope(error) };
}

export class FoundryDocumentService {
  constructor(
    readonly runtime: FoundryRuntimeAdapter,
    readonly defaultRedactionPaths: readonly string[] = [],
  ) {}

  async types(
    input: unknown = {},
    options?: DocumentOperationOptions,
  ): Promise<OperationResult<DocumentsTypesOutput>> {
    return this.#run(async () => {
      this.#parse(DocumentsTypesInput, input);
      this.#guard(options);
      const registrations = await this.runtime.listDocumentRegistrations();
      return {
        types: registrations
          .map((registration) => ({
            type: registration.type,
            ...(registration.collection ? { collection: registration.collection } : {}),
            embedded: registration.embedded,
            parentTypes: [...registration.parentTypes].sort(compareText),
            ...(registration.schemaVersion ? { schemaVersion: registration.schemaVersion } : {}),
            readable: registration.readable,
            creatable: registration.creatable,
            updatable: registration.updatable,
            ...(registration.reason ? { reason: registration.reason } : {}),
            subtypes: registration.subtypes
              .map((subtype) => ({ ...subtype }))
              .sort((left, right) => compareText(left.subtype, right.subtype)),
          }))
          .sort((left, right) => compareText(left.type, right.type)),
      };
    });
  }

  async list(
    input: unknown,
    options?: DocumentOperationOptions,
  ): Promise<OperationResult<DocumentsListOutput>> {
    return this.#run(async () => {
      const parsed = this.#parse(DocumentsListInput, input);
      this.#guard(options);
      const registration = await this.#registration(parsed.type);
      if (!registration.readable)
        operationError(
          "PERMISSION_DENIED",
          registration.reason ?? `${parsed.type} is not readable`,
        );
      const documents = (await this.runtime.listRootDocuments(parsed.type)).filter((document) =>
        this.runtime.canRead(document),
      );
      const filtered = documents.filter((document) => {
        const data = cloneJsonObject(document.toObject());
        if (parsed.subtype && document.subtype !== parsed.subtype && data.type !== parsed.subtype)
          return false;
        if (parsed.folder !== undefined && folderId(data) !== parsed.folder) return false;
        const name = typeof data.name === "string" ? data.name : "";
        return (
          !parsed.nameFilter ||
          name.toLocaleLowerCase().includes(parsed.nameFilter.toLocaleLowerCase())
        );
      });
      const cursorKind = `documents:${parsed.type}`;
      const cursor = decodeCursor(parsed.cursor, cursorKind);
      if (
        cursor &&
        (cursor.field !== parsed.sort.field || cursor.direction !== parsed.sort.direction)
      ) {
        operationError("INVALID_DATA", "Cursor sort does not match the requested sort");
      }
      const sorted = filtered.sort((left, right) =>
        this.#compareDocuments(left, right, parsed.sort.field, parsed.sort.direction),
      );
      const afterCursor = cursor
        ? sorted.filter((document) => this.#compareDocumentToCursor(document, cursor) > 0)
        : sorted;
      const page = afterCursor.slice(0, parsed.pageSize);
      const items = page.map((document) => this.#summary(document, parsed.fields));
      const last = page.at(-1);
      const output: DocumentsListOutput = { items };
      if (last && afterCursor.length > page.length) {
        output.nextCursor = encodeCursor({
          kind: cursorKind,
          field: parsed.sort.field,
          direction: parsed.sort.direction,
          value: this.#sortValue(last, parsed.sort.field),
          id: last.id,
        });
      }
      return output;
    });
  }

  async get(
    input: unknown,
    options?: DocumentOperationOptions,
  ): Promise<OperationResult<DocumentView>> {
    return this.#run(async () => {
      const parsed = this.#parse(DocumentsGetInput, input);
      this.#guard(options);
      return this.#getView(parsed.uuid);
    });
  }

  async create(
    input: unknown,
    options?: DocumentOperationOptions,
  ): Promise<OperationResult<DocumentsCreateOutput>> {
    return this.#run(async () => {
      const parsed = this.#parse(DocumentsCreateInput, input);
      this.#guard(options);
      const atomic = "items" in parsed ? parsed.atomic : false;
      const items: DocumentCreateItem[] =
        "items" in parsed
          ? parsed.items
          : [
              {
                type: parsed.type,
                data: parsed.data,
                ...(parsed.parentUuid ? { parentUuid: parsed.parentUuid } : {}),
              },
            ];
      const validations = await Promise.all(items.map((item) => this.#validateCreate(item)));
      if (atomic && validations.some((validation) => !validation.ok)) {
        const results: DocumentCreateResult[] = validations.map((validation, index) =>
          validation.ok
            ? {
                index,
                status: "rolled_back",
                error: makeError(
                  "INVALID_DATA",
                  "Atomic batch was not attempted because another item failed validation",
                ),
              }
            : { index, status: "error", error: validation.error },
        );
        return { atomic: true, committed: false, results };
      }

      const snapshot =
        atomic && this.runtime.snapshotState ? await this.runtime.snapshotState() : undefined;
      const created: RuntimeDocument[] = [];
      const results: DocumentCreateResult[] = [];
      for (const [index, validation] of validations.entries()) {
        this.#guard(options);
        if (!validation.ok) {
          results.push({ index, status: "error", error: validation.error });
          continue;
        }
        try {
          const document = await this.runtime.createDocument(
            validation.item.type,
            validation.item.data,
            validation.parent,
          );
          created.push(document);
          results.push({ index, status: "created", document: this.#view(document) });
        } catch (error) {
          const envelope = toErrorEnvelope(error);
          results.push({ index, status: "error", error: envelope });
          if (!atomic) continue;
          await this.#rollback(created, snapshot);
          return {
            atomic: true,
            committed: false,
            results: results.map((result) =>
              result.status === "created"
                ? {
                    index: result.index,
                    status: "rolled_back",
                    error: makeError(
                      "FOUNDRY_ERROR",
                      "Atomic batch was rolled back after a create failure",
                    ),
                  }
                : result,
            ),
          };
        }
      }
      return { atomic, committed: results.every((result) => result.status === "created"), results };
    });
  }

  async update(
    input: unknown,
    options?: DocumentOperationOptions,
  ): Promise<OperationResult<DocumentsUpdateOutput>> {
    return this.#run(async () => {
      const parsed = this.#parse(DocumentsUpdateInput, input);
      this.#guard(options);
      const document = await this.#resolve(parsed.uuid);
      if (!this.runtime.canRead(document))
        operationError("PERMISSION_DENIED", "The connected user cannot read this Document");
      const permission = this.runtime.canUpdate(document);
      if (!permission.allowed)
        operationError(
          "PERMISSION_DENIED",
          permission.reason ?? "The connected user cannot update this Document",
        );
      const before = cloneJsonObject(document.toObject());
      const actualHash = sourceHash(before);
      const actualVersion = sourceVersion(document, before);
      if (!parsed.forceOverwrite) {
        if (parsed.expectedHash !== undefined && parsed.expectedHash !== actualHash) {
          operationError("CONFLICT", "Document source hash does not match", {
            expected: parsed.expectedHash,
            actual: actualHash,
          });
        }
        if (
          parsed.expectedVersion !== undefined &&
          String(parsed.expectedVersion) !== String(actualVersion)
        ) {
          operationError("CONFLICT", "Document source version does not match", {
            expected: parsed.expectedVersion,
            actual: actualVersion,
          });
        }
      } else {
        await this.runtime.audit({ action: "document.update", uuid: document.uuid, forced: true });
      }
      const updated = await this.runtime.updateDocument(document, parsed.data);
      const view = this.#view(updated);
      return {
        uuid: view.uuid,
        sourceHash: view.sourceHash,
        sourceVersion: view.sourceVersion,
        forced: parsed.forceOverwrite,
        document: view,
      };
    });
  }

  async embeddedList(
    input: unknown,
    options?: DocumentOperationOptions,
  ): Promise<OperationResult<EmbeddedDocumentsListOutput>> {
    return this.#run(async () => {
      const parsed = this.#parse(EmbeddedDocumentsListInput, input);
      this.#guard(options);
      const parent = await this.#resolve(parsed.parentUuid);
      if (!this.runtime.canRead(parent))
        operationError("PERMISSION_DENIED", "The connected user cannot read the parent Document");
      const queue: Array<{ document: RuntimeDocument; depth: number }> = (
        await this.runtime.listEmbeddedDocuments(parent, parsed.embeddedType)
      ).map((document) => ({ document, depth: 1 }));
      const all: EmbeddedDocumentSummary[] = [];
      let truncated = false;
      while (queue.length > 0) {
        this.#guard(options);
        const next = queue.shift();
        if (!next) break;
        if (!this.runtime.canRead(next.document)) continue;
        all.push({ ...this.#summary(next.document), depth: next.depth });
        if (!parsed.recursive) continue;
        const children = await this.runtime.listEmbeddedDocuments(
          next.document,
          parsed.embeddedType,
        );
        if (next.depth >= parsed.maxDepth) {
          if (children.some((child) => this.runtime.canRead(child))) truncated = true;
          continue;
        }
        queue.push(...children.map((document) => ({ document, depth: next.depth + 1 })));
      }
      all.sort((left, right) => compareText(left.uuid, right.uuid));
      const cursor = decodeCursor(parsed.cursor, `embedded:${parsed.parentUuid}`);
      const after = cursor ? all.filter((item) => compareText(item.uuid, cursor.value) > 0) : all;
      const page = after.slice(0, parsed.pageSize);
      const output: EmbeddedDocumentsListOutput = { items: page, truncated };
      if (truncated) output.truncationReason = `Traversal reached maxDepth ${parsed.maxDepth}`;
      const last = page.at(-1);
      if (last && after.length > page.length) {
        output.nextCursor = encodeCursor({
          kind: `embedded:${parsed.parentUuid}`,
          field: "uuid",
          direction: "asc",
          value: last.uuid,
          id: last.id,
        });
      }
      return output;
    });
  }

  async compendiumsList(
    input: unknown = {},
    options?: DocumentOperationOptions,
  ): Promise<OperationResult<CompendiumsListOutput>> {
    return this.#run(async () => {
      this.#parse(CompendiumsListInput, input);
      this.#guard(options);
      const packs = (await this.runtime.listCompendiums())
        .filter((pack) => pack.accessible && !pack.locked)
        .map((pack) => ({
          id: pack.id,
          label: pack.label,
          type: pack.type,
          documentCount: pack.documentCount,
          locked: pack.locked,
        }))
        .sort((left, right) => compareText(left.id, right.id));
      return { packs };
    });
  }

  async compendiumDocumentsList(
    input: unknown,
    options?: DocumentOperationOptions,
  ): Promise<OperationResult<CompendiumDocumentsListOutput>> {
    return this.#run(async () => {
      const parsed = this.#parse(CompendiumDocumentsListInput, input);
      this.#guard(options);
      const pack = await this.runtime.getCompendium(parsed.packId);
      if (!pack) operationError("NOT_FOUND", `Compendium ${parsed.packId} was not found`);
      if (!pack.accessible || pack.locked)
        operationError("PERMISSION_DENIED", `Compendium ${parsed.packId} is not accessible`);
      const cursorKind = `compendium:${parsed.packId}:${parsed.hydrate ? "hydrated" : "index"}`;
      const cursor = decodeCursor(parsed.cursor, cursorKind);
      if (
        cursor &&
        (cursor.field !== parsed.sort.field || cursor.direction !== parsed.sort.direction)
      ) {
        operationError("INVALID_DATA", "Cursor sort does not match the requested sort");
      }
      if (parsed.hydrate) {
        const documents = (await pack.getDocuments()).filter((document) =>
          this.runtime.canRead(document),
        );
        documents.sort((left, right) =>
          this.#compareDocuments(left, right, parsed.sort.field, parsed.sort.direction),
        );
        const after = cursor
          ? documents.filter((document) => this.#compareDocumentToCursor(document, cursor) > 0)
          : documents;
        const page = after.slice(0, parsed.pageSize);
        const output: CompendiumDocumentsListOutput = {
          packId: pack.id,
          hydrated: true,
          items: page.map((document) => this.#view(document)),
        };
        const last = page.at(-1);
        if (last && after.length > page.length) {
          output.nextCursor = encodeCursor({
            kind: cursorKind,
            field: parsed.sort.field,
            direction: parsed.sort.direction,
            value: this.#sortValue(last, parsed.sort.field),
            id: last.id,
          });
        }
        return output;
      }
      const index = await pack.getIndex();
      index.sort((left, right) =>
        this.#compareIndex(left, right, parsed.sort.field, parsed.sort.direction),
      );
      const after = cursor
        ? index.filter((entry) => this.#compareIndexToCursor(entry, cursor) > 0)
        : index;
      const page = after.slice(0, parsed.pageSize);
      const output: CompendiumDocumentsListOutput = {
        packId: pack.id,
        hydrated: false,
        items: page,
      };
      const last = page.at(-1);
      if (last && after.length > page.length) {
        output.nextCursor = encodeCursor({
          kind: cursorKind,
          field: parsed.sort.field,
          direction: parsed.sort.direction,
          value: parsed.sort.field === "name" ? (last.name ?? "") : last.id,
          id: last.id,
        });
      }
      return output;
    });
  }

  async snapshot(
    input: unknown,
    options?: DocumentOperationOptions,
  ): Promise<OperationResult<DocumentsSnapshotOutput>> {
    return this.#run(async () => {
      const parsed = this.#parse(DocumentsSnapshotInput, input);
      this.#guard(options);
      let uuids: string[];
      if ("uuids" in parsed) {
        uuids = [...parsed.uuids];
      } else {
        const listed = await this.list({ ...parsed.query, pageSize: parsed.maxItems }, options);
        if (!listed.ok) throw new DocumentOperationError(listed.error);
        uuids = listed.value.items.map((item) => item.uuid);
      }
      const reasons = new Set<"maxDepth" | "maxBytes" | "maxItems">();
      const redactedPaths: string[] = [];
      const state = { itemCount: 0 };
      const redactions = [...this.defaultRedactionPaths, ...parsed.redactionPaths];
      const snapshot: JsonValue[] = [];
      for (const uuid of uuids) {
        this.#guard(options);
        if (state.itemCount >= parsed.maxItems) {
          reasons.add("maxItems");
          break;
        }
        snapshot.push(
          await this.#expandSnapshot(
            uuid,
            0,
            new Set<string>(),
            parsed.maxDepth,
            parsed.maxItems,
            state,
            reasons,
            redactions,
            redactedPaths,
          ),
        );
      }
      let byteCount = utf8Length(JSON.stringify(snapshot));
      if (byteCount > parsed.maxBytes) {
        reasons.add("maxBytes");
        while (snapshot.length > 1 && byteCount > parsed.maxBytes) {
          snapshot.pop();
          byteCount = utf8Length(JSON.stringify(snapshot));
        }
        if (byteCount > parsed.maxBytes && snapshot.length === 1) {
          const first = cloneJsonObject(snapshot[0]);
          const uuid = typeof first.uuid === "string" ? first.uuid : "unknown";
          snapshot[0] = { uuid, $truncated: "maxBytes" };
          byteCount = utf8Length(JSON.stringify(snapshot));
        }
      }
      return {
        snapshot,
        truncated: reasons.size > 0,
        truncationReasons: [...reasons],
        redactedPaths: [...new Set(redactedPaths)].sort(compareText),
        itemCount: state.itemCount,
        byteCount,
      };
    });
  }

  async #run<T>(operation: () => Promise<T>): Promise<OperationResult<T>> {
    try {
      if (!this.runtime.isOnline())
        operationError("OFFLINE_BRIDGE", "The Foundry runtime is offline", undefined, true);
      return { ok: true, value: await operation() };
    } catch (error) {
      return errorResult<T>(error);
    }
  }

  #parse<T>(
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false; error: { issues: unknown } };
    },
    input: unknown,
  ): T {
    const result = schema.safeParse(input);
    if (!result.success)
      operationError("INVALID_DATA", "Input validation failed", { issues: result.error.issues });
    return result.data;
  }

  #guard(options?: DocumentOperationOptions): void {
    if (options?.signal?.aborted) operationError("CANCELLED", "Operation was cancelled");
    if (options?.deadline !== undefined && Date.now() > options.deadline)
      operationError("TIMEOUT", "Operation deadline elapsed", undefined, true);
  }

  async #registration(type: string): Promise<RuntimeDocumentRegistration> {
    const registration = (await this.runtime.listDocumentRegistrations()).find(
      (candidate) => candidate.type === type,
    );
    if (!registration)
      operationError("UNSUPPORTED_TYPE", `Document type ${type} is not registered`);
    return registration;
  }

  async #resolve(uuid: string): Promise<RuntimeDocument> {
    try {
      await this.runtime.parseUuid(uuid);
    } catch {
      operationError("INVALID_DATA", `UUID ${uuid} is malformed`);
    }
    const document = await this.runtime.fromUuid(uuid);
    if (!document) operationError("NOT_FOUND", `Document ${uuid} was not found`);
    return document;
  }

  async #getView(uuid: string): Promise<DocumentView> {
    const document = await this.#resolve(uuid);
    if (!this.runtime.canRead(document))
      operationError("PERMISSION_DENIED", "The connected user cannot read this Document");
    return this.#view(document);
  }

  #summary(document: RuntimeDocument, fields?: string[]): DocumentSummary {
    const data = cloneJsonObject(document.toObject());
    const name = typeof data.name === "string" ? data.name : undefined;
    const folder = folderId(data);
    const subtype = document.subtype ?? (typeof data.type === "string" ? data.type : undefined);
    const projection = projectedData(data, fields);
    return {
      id: document.id,
      uuid: document.uuid,
      type: document.documentName,
      ...(subtype ? { subtype } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(folder !== undefined ? { folder } : {}),
      ...(document.parent ? { parentUuid: document.parent.uuid } : {}),
      ...(document.pack ? { packId: document.pack } : {}),
      ...(projection ? { data: projection } : {}),
      sourceHash: sourceHash(data),
      sourceVersion: sourceVersion(document, data),
    };
  }

  #view(document: RuntimeDocument): DocumentView {
    const data = cloneJsonObject(document.toObject());
    const summary = this.#summary(document);
    const ownership = cloneJsonObject(document.ownership ?? data.ownership ?? {});
    return {
      ...summary,
      data,
      ownershipSummary: ownership,
      schemaVersion: document.schemaVersion ?? "unknown",
      ...(document.parent
        ? { parent: { uuid: document.parent.uuid, type: document.parent.documentName } }
        : {}),
      ...(document.pack ? { pack: { id: document.pack, locked: false } } : {}),
    };
  }

  #sortValue(document: RuntimeDocument, field: "id" | "name"): string {
    if (field === "id") return document.id;
    const data = cloneJsonObject(document.toObject());
    return typeof data.name === "string" ? data.name : "";
  }

  #compareDocuments(
    left: RuntimeDocument,
    right: RuntimeDocument,
    field: "id" | "name",
    direction: "asc" | "desc",
  ): number {
    const primary = compareText(this.#sortValue(left, field), this.#sortValue(right, field));
    const result = primary === 0 ? compareText(left.id, right.id) : primary;
    return direction === "asc" ? result : -result;
  }

  #compareDocumentToCursor(document: RuntimeDocument, cursor: CursorValue): number {
    const value = cursor.field === "uuid" ? document.uuid : this.#sortValue(document, cursor.field);
    const primary = compareText(value, cursor.value);
    const result = primary === 0 ? compareText(document.id, cursor.id) : primary;
    return cursor.direction === "asc" ? result : -result;
  }

  #compareIndex(
    left: RuntimeCompendiumIndexEntry,
    right: RuntimeCompendiumIndexEntry,
    field: "id" | "name",
    direction: "asc" | "desc",
  ): number {
    const leftValue = field === "name" ? (left.name ?? "") : left.id;
    const rightValue = field === "name" ? (right.name ?? "") : right.id;
    const primary = compareText(leftValue, rightValue);
    const result = primary === 0 ? compareText(left.id, right.id) : primary;
    return direction === "asc" ? result : -result;
  }

  #compareIndexToCursor(entry: RuntimeCompendiumIndexEntry, cursor: CursorValue): number {
    const value = cursor.field === "name" ? (entry.name ?? "") : entry.id;
    const primary = compareText(value, cursor.value);
    const result = primary === 0 ? compareText(entry.id, cursor.id) : primary;
    return cursor.direction === "asc" ? result : -result;
  }

  async #validateCreate(
    item: DocumentCreateItem,
  ): Promise<
    | { ok: true; item: DocumentCreateItem; parent?: RuntimeDocument }
    | { ok: false; error: ErrorEnvelope }
  > {
    try {
      const registration = await this.#registration(item.type);
      const subtype = typeof item.data.type === "string" ? item.data.type : undefined;
      if (subtype && registration.subtypes.length > 0) {
        const subtypeRegistration = registration.subtypes.find(
          (candidate) => candidate.subtype === subtype,
        );
        if (!subtypeRegistration)
          operationError(
            "UNSUPPORTED_TYPE",
            `Subtype ${subtype} is not registered for ${item.type}`,
          );
        if (!subtypeRegistration.creatable)
          operationError(
            "PERMISSION_DENIED",
            subtypeRegistration.reason ?? `${item.type}.${subtype} is not creatable`,
          );
      }
      const parent = item.parentUuid ? await this.#resolve(item.parentUuid) : undefined;
      if (parent && !registration.parentTypes.includes(parent.documentName)) {
        operationError(
          "UNSUPPORTED_TYPE",
          `${item.type} cannot be embedded in ${parent.documentName}`,
        );
      }
      const permission = this.runtime.canCreate(item.type, subtype, parent);
      if (!permission.allowed)
        operationError("PERMISSION_DENIED", permission.reason ?? `${item.type} is not creatable`);
      return { ok: true, item, ...(parent ? { parent } : {}) };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  }

  async #rollback(created: RuntimeDocument[], snapshot: unknown): Promise<void> {
    if (snapshot !== undefined && this.runtime.restoreState) {
      await this.runtime.restoreState(snapshot);
      return;
    }
    for (const document of [...created].reverse()) await this.runtime.deleteDocument(document);
  }

  #redact(data: JsonObject, paths: readonly string[], uuid: string, reported: string[]): void {
    for (const configuredPath of paths) {
      const segments = configuredPath
        .replace(/^\//, "")
        .split(configuredPath.startsWith("/") ? "/" : ".")
        .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
        .filter(Boolean);
      if (segments.length === 0) continue;
      let current: JsonObject = data;
      for (const segment of segments.slice(0, -1)) {
        const child = current[segment];
        if (!child || typeof child !== "object" || Array.isArray(child)) {
          current = {};
          break;
        }
        current = child;
      }
      const last = segments.at(-1);
      if (last && Object.hasOwn(current, last)) {
        Reflect.deleteProperty(current, last);
        reported.push(`${uuid}:${configuredPath}`);
      }
    }
  }

  async #expandSnapshot(
    uuid: string,
    depth: number,
    ancestry: Set<string>,
    maxDepth: number,
    maxItems: number,
    state: { itemCount: number },
    reasons: Set<"maxDepth" | "maxBytes" | "maxItems">,
    redactions: readonly string[],
    redactedPaths: string[],
  ): Promise<JsonValue> {
    if (ancestry.has(uuid)) return { $ref: uuid, $cycle: true };
    if (depth >= maxDepth) {
      reasons.add("maxDepth");
      return { $ref: uuid, $truncated: "maxDepth" };
    }
    if (state.itemCount >= maxItems) {
      reasons.add("maxItems");
      return { $ref: uuid, $truncated: "maxItems" };
    }
    const document = await this.#resolve(uuid);
    if (!this.runtime.canRead(document)) return { $ref: uuid, $redacted: "permission" };
    state.itemCount += 1;
    const data = cloneJsonObject(document.toObject());
    this.#redact(data, redactions, uuid, redactedPaths);
    const nextAncestry = new Set(ancestry).add(uuid);
    const expandValue = async (value: JsonValue, currentDepth: number): Promise<JsonValue> => {
      if (typeof value === "string") {
        try {
          await this.runtime.parseUuid(value);
          const referenced = await this.runtime.fromUuid(value);
          if (!referenced) return value;
          if (nextAncestry.has(value)) return { $ref: value, $cycle: true };
          return {
            $ref: value,
            document: await this.#expandSnapshot(
              value,
              currentDepth + 1,
              nextAncestry,
              maxDepth,
              maxItems,
              state,
              reasons,
              redactions,
              redactedPaths,
            ),
          };
        } catch {
          return value;
        }
      }
      if (Array.isArray(value))
        return Promise.all(value.map((entry) => expandValue(entry, currentDepth)));
      if (value && typeof value === "object") {
        const output: JsonObject = {};
        for (const [key, entry] of Object.entries(value))
          output[key] = await expandValue(entry, currentDepth);
        return output;
      }
      return value;
    };
    return {
      uuid,
      type: document.documentName,
      ...(document.subtype ? { subtype: document.subtype } : {}),
      data: await expandValue(data, depth),
    };
  }
}
