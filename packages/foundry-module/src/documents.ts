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
  MAX_PAGE_SIZE,
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
  type OperationExecutionOptions,
} from "@foundry-mcp/protocol";

import type {
  FoundryRuntimeAdapter,
  RuntimeCompendium,
  RuntimeCompendiumIndexEntry,
  RuntimeDocument,
  RuntimeDocumentRegistration,
  RuntimeDocumentValidation,
} from "./runtime.js";

export type DocumentOperationOptions = OperationExecutionOptions;

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

const POISON_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_SNAPSHOT_SOURCE_DEPTH = 64;
const MAX_SNAPSHOT_WORK_NODES = 50_000;
const MAX_SNAPSHOT_SOURCE_BYTES = 8_000_000;

interface SnapshotSourceWork {
  nodes: number;
  bytes: number;
}

interface SnapshotCloneBudget {
  nodes: number;
  bytes: number;
  maxBytes: number;
  reasons: Set<"maxDepth" | "maxBytes" | "maxItems">;
}

function utf8LengthAtMost(value: string, maximum: number): number | undefined {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > maximum) return undefined;
  }
  return bytes;
}

function safePathSegments(path: string): string[] {
  const segments = path
    .replace(/^\//, "")
    .split(path.startsWith("/") ? "/" : ".")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .filter(Boolean);
  const unsafe = segments.find((segment) => POISON_PATH_SEGMENTS.has(segment));
  if (unsafe) operationError("INVALID_DATA", `Unsafe path segment ${unsafe}`);
  return segments;
}

function consumeSourceBytes(work: SnapshotSourceWork, value: string): void {
  const remaining = MAX_SNAPSHOT_SOURCE_BYTES - work.bytes;
  const bytes = utf8LengthAtMost(value, remaining);
  if (bytes === undefined) {
    operationError("INVALID_DATA", "Snapshot source exceeds the byte safety limit");
  }
  work.bytes += bytes;
}

/**
 * Iterative, fail-closed preflight over raw Foundry data. It stops before
 * recursive cloning/UUID expansion can consume unbounded stack, memory, or
 * accessor work.
 */
function assertSnapshotSourceBounded(value: unknown, work: SnapshotSourceWork): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    work.nodes += 1;
    if (work.nodes > MAX_SNAPSHOT_WORK_NODES) {
      operationError("INVALID_DATA", "Snapshot source exceeds the node safety limit");
    }
    if (next.depth > MAX_SNAPSHOT_SOURCE_DEPTH) {
      operationError("INVALID_DATA", "Snapshot source exceeds the depth safety limit");
    }

    const current = next.value;
    if (typeof current === "string") {
      consumeSourceBytes(work, current);
      continue;
    }
    if (typeof current === "number" || typeof current === "bigint") {
      consumeSourceBytes(work, String(current));
      continue;
    }
    if (current instanceof Date) {
      consumeSourceBytes(work, current.toISOString());
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      if (current.length + work.nodes + stack.length > MAX_SNAPSHOT_WORK_NODES) {
        operationError("INVALID_DATA", "Snapshot source exceeds the node safety limit");
      }
      for (let index = 0; index < current.length; index += 1) {
        if (Object.hasOwn(current, index)) {
          stack.push({ value: current[index], depth: next.depth + 1 });
        }
      }
      continue;
    }

    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue;
      if (POISON_PATH_SEGMENTS.has(key)) {
        operationError("INVALID_DATA", `Snapshot source contains unsafe key ${key}`);
      }
      consumeSourceBytes(work, key);
      if (work.nodes + stack.length >= MAX_SNAPSHOT_WORK_NODES) {
        operationError("INVALID_DATA", "Snapshot source exceeds the node safety limit");
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor) continue;
      if (descriptor.get || descriptor.set) {
        operationError("INVALID_DATA", "Snapshot source contains an accessor property");
      }
      stack.push({ value: descriptor.value, depth: next.depth + 1 });
    }
  }
}

function reserveSnapshotBytes(budget: SnapshotCloneBudget, value: string): boolean {
  const remaining = budget.maxBytes - budget.bytes;
  const bytes = utf8LengthAtMost(value, remaining);
  if (bytes === undefined) {
    budget.reasons.add("maxBytes");
    return false;
  }
  budget.bytes += bytes;
  return true;
}

function isHtmlWhitespace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\f" ||
    character === "\r"
  );
}

function hasSecretHtmlClass(attributes: string): boolean {
  let cursor = 0;
  while (cursor < attributes.length) {
    while (isHtmlWhitespace(attributes[cursor]) || attributes[cursor] === "/") cursor += 1;
    const nameStart = cursor;
    while (
      cursor < attributes.length &&
      !isHtmlWhitespace(attributes[cursor]) &&
      attributes[cursor] !== "=" &&
      attributes[cursor] !== "/"
    ) {
      cursor += 1;
    }
    if (cursor === nameStart) {
      cursor += 1;
      continue;
    }
    const name = attributes.slice(nameStart, cursor).toLowerCase();
    while (isHtmlWhitespace(attributes[cursor])) cursor += 1;
    if (attributes[cursor] !== "=") continue;
    cursor += 1;
    while (isHtmlWhitespace(attributes[cursor])) cursor += 1;

    let attributeValue: string;
    const quote = attributes[cursor];
    if (quote === '"' || quote === "'") {
      cursor += 1;
      const valueStart = cursor;
      while (cursor < attributes.length && attributes[cursor] !== quote) cursor += 1;
      attributeValue = attributes.slice(valueStart, cursor);
      if (cursor < attributes.length) cursor += 1;
    } else {
      const valueStart = cursor;
      while (
        cursor < attributes.length &&
        !isHtmlWhitespace(attributes[cursor]) &&
        attributes[cursor] !== "/"
      ) {
        cursor += 1;
      }
      attributeValue = attributes.slice(valueStart, cursor);
    }

    if (
      name === "class" &&
      attributeValue.split(/[\t\n\f\r ]+/).some((className) => className.toLowerCase() === "secret")
    ) {
      return true;
    }
  }
  return false;
}

interface HtmlTag {
  closing: boolean;
  end: number;
  name: string;
  secret: boolean;
  selfClosing: boolean;
}

function readHtmlTag(value: string, start: number): HtmlTag | undefined {
  let cursor = start + 1;
  while (isHtmlWhitespace(value[cursor])) cursor += 1;
  const closing = value[cursor] === "/";
  if (closing) {
    cursor += 1;
    while (isHtmlWhitespace(value[cursor])) cursor += 1;
  }
  const nameStart = cursor;
  if (!/[A-Za-z]/.test(value[cursor] ?? "")) return undefined;
  cursor += 1;
  while (cursor < value.length && /[A-Za-z0-9:-]/.test(value[cursor] ?? "")) cursor += 1;
  const name = value.slice(nameStart, cursor).toLowerCase();
  if (!isHtmlWhitespace(value[cursor]) && value[cursor] !== "/" && value[cursor] !== ">") {
    return undefined;
  }

  const attributesStart = cursor;
  let quote: '"' | "'" | undefined;
  while (cursor < value.length) {
    const character = value[cursor];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      const attributes = value.slice(attributesStart, cursor);
      return {
        closing,
        end: cursor + 1,
        name,
        secret: name === "section" && !closing && hasSecretHtmlClass(attributes),
        selfClosing: !closing && /\/\s*$/.test(attributes),
      };
    }
    cursor += 1;
  }
  return undefined;
}

/** Remove Foundry's native GM-only secret sections without requiring DOM APIs. */
function redactFoundrySecretHtml(value: string): string {
  let cursor = 0;
  let copyFrom = 0;
  let openSections = 0;
  let secretParentDepth: number | undefined;
  let secretStart: number | undefined;
  let output = "";

  while (cursor < value.length) {
    const tagStart = value.indexOf("<", cursor);
    if (tagStart < 0) break;
    if (value.startsWith("<!--", tagStart)) {
      const commentEnd = value.indexOf("-->", tagStart + 4);
      cursor = commentEnd < 0 ? value.length : commentEnd + 3;
      continue;
    }
    const tag = readHtmlTag(value, tagStart);
    if (!tag) {
      cursor = tagStart + 1;
      continue;
    }
    cursor = tag.end;
    if (tag.name !== "section") continue;

    if (tag.closing) {
      if (openSections === 0) continue;
      openSections -= 1;
      if (secretStart !== undefined && openSections === secretParentDepth) {
        output += value.slice(copyFrom, secretStart);
        copyFrom = tag.end;
        secretParentDepth = undefined;
        secretStart = undefined;
      }
      continue;
    }

    if (tag.selfClosing) {
      if (tag.secret && secretStart === undefined) {
        output += value.slice(copyFrom, tagStart);
        copyFrom = tag.end;
      }
      continue;
    }

    if (tag.secret && secretStart === undefined) {
      secretStart = tagStart;
      secretParentDepth = openSections;
    }
    openSections += 1;
  }

  if (secretStart !== undefined) {
    output += value.slice(copyFrom, secretStart);
    return output;
  }
  if (copyFrom === 0) return value;
  return output + value.slice(copyFrom);
}

function cloneSnapshotValue(
  value: unknown,
  budget: SnapshotCloneBudget,
  depth: number,
  maxDepth: number,
  seen = new WeakSet<object>(),
): JsonValue | undefined {
  budget.nodes += 1;
  if (budget.nodes > MAX_SNAPSHOT_WORK_NODES) {
    operationError("INVALID_DATA", "Snapshot expansion exceeds the node safety limit");
  }
  if (value === null || typeof value === "boolean") {
    reserveSnapshotBytes(budget, String(value));
    return value;
  }
  if (typeof value === "string") {
    const redacted = redactFoundrySecretHtml(value);
    return reserveSnapshotBytes(budget, redacted) ? redacted : "[Truncated:maxBytes]";
  }
  if (typeof value === "number") {
    const normalized = Number.isFinite(value) ? value : String(value);
    reserveSnapshotBytes(budget, String(normalized));
    return normalized;
  }
  if (typeof value === "bigint") {
    const normalized = value.toString();
    reserveSnapshotBytes(budget, normalized);
    return normalized;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value instanceof Date) {
    const normalized = value.toISOString();
    return reserveSnapshotBytes(budget, normalized) ? normalized : "[Truncated:maxBytes]";
  }
  if (depth >= maxDepth) {
    budget.reasons.add("maxDepth");
    return { $truncated: "maxDepth" };
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) continue;
        if (budget.bytes >= budget.maxBytes) {
          budget.reasons.add("maxBytes");
          output.push("[Truncated:maxBytes]");
          break;
        }
        const cloned = cloneSnapshotValue(value[index], budget, depth + 1, maxDepth, seen);
        if (cloned !== undefined) output.push(cloned);
      }
      return output;
    }

    const output = Object.create(null) as JsonObject;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (POISON_PATH_SEGMENTS.has(key)) {
        operationError("INVALID_DATA", `Snapshot source contains unsafe key ${key}`);
      }
      if (!reserveSnapshotBytes(budget, key)) {
        output.$truncated = "maxBytes";
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      const cloned = cloneSnapshotValue(descriptor.value, budget, depth + 1, maxDepth, seen);
      if (cloned !== undefined) output[key] = cloned;
      if (budget.bytes >= budget.maxBytes) {
        budget.reasons.add("maxBytes");
        break;
      }
    }
    return output;
  } finally {
    seen.delete(value);
  }
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
    if (POISON_PATH_SEGMENTS.has(key)) continue;
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

const SHA256_INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

/** Browser-safe synchronous SHA-256 for deterministic optimistic-concurrency tokens. */
function sha256Hex(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = input.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const state = new Uint32Array(SHA256_INITIAL_STATE);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const prior15 = words[index - 15] ?? 0;
      const prior2 = words[index - 2] ?? 0;
      const sigma0 = rotateRight(prior15, 7) ^ rotateRight(prior15, 18) ^ (prior15 >>> 3);
      const sigma1 = rotateRight(prior2, 17) ^ rotateRight(prior2, 19) ^ (prior2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }

    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    let f = state[5] ?? 0;
    let g = state[6] ?? 0;
    let h = state[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const upperSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 =
        (h + upperSigma1 + choose + (SHA256_ROUND_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>>
        0;
      const upperSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (upperSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }

  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}

export function sourceHash(data: JsonObject): string {
  return `fmcp-v2-${sha256Hex(canonicalJson(data))}`;
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
  for (const segment of safePathSegments(path)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    const next: JsonValue | undefined = current[segment];
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

function setPath(target: JsonObject, path: string, value: JsonValue): void {
  const segments = safePathSegments(path);
  if (segments.length === 0) return;
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = Object.hasOwn(current, segment) ? current[segment] : undefined;
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      current[segment] = Object.create(null) as JsonObject;
    }
    current = current[segment] as JsonObject;
  }
  const last = segments.at(-1);
  if (last) current[last] = value;
}

function projectedData(data: JsonObject, fields: string[] | undefined): JsonObject | undefined {
  if (!fields) return undefined;
  const projected = Object.create(null) as JsonObject;
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

interface ValidatedCreate {
  ok: true;
  item: DocumentCreateItem;
  parent?: RuntimeDocument;
  pack?: RuntimeCompendium;
  schemaValidation: RuntimeDocumentValidation;
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
      await this.#progress(options, 250, `Enumerated ${documents.length.toString()} Documents`);
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
      const dryRun = parsed.dryRun;
      const snapshotState = this.runtime.snapshotState?.bind(this.runtime);
      const restoreState = this.runtime.restoreState?.bind(this.runtime);
      if (atomic && !dryRun && (!snapshotState || !restoreState)) {
        operationError(
          "UNSUPPORTED_TYPE",
          "Atomic batch creation requires runtime snapshot and restore capability",
        );
      }
      const items: DocumentCreateItem[] =
        "items" in parsed
          ? parsed.items
          : [
              {
                type: parsed.type,
                data: parsed.data,
                ...(parsed.parentUuid ? { parentUuid: parsed.parentUuid } : {}),
                ...(parsed.packId ? { packId: parsed.packId } : {}),
              },
            ];
      const validations = await Promise.all(
        items.map((item) => this.#validateCreate(item, dryRun)),
      );
      if (dryRun) {
        const results: DocumentCreateResult[] = validations.map((validation, index) =>
          validation.ok
            ? {
                index,
                status: "validated",
                validation: this.#createValidation(validation),
              }
            : { index, status: "error", error: validation.error },
        );
        return { atomic, committed: false, dryRun: true, results };
      }
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
        return { atomic: true, committed: false, dryRun: false, results };
      }

      const snapshot = atomic ? await snapshotState?.() : undefined;
      const results: DocumentCreateResult[] = [];
      for (const [index, validation] of validations.entries()) {
        this.#guard(options);
        if (!validation.ok) {
          results.push({ index, status: "error", error: validation.error });
          continue;
        }
        try {
          const document = validation.pack
            ? await validation.pack.createDocument(validation.item.data)
            : await this.runtime.createDocument(
                validation.item.type,
                validation.item.data,
                validation.parent,
              );
          options?.markCommitted?.(`created document batch item ${index.toString()}`);
          results.push({ index, status: "created", document: this.#view(document) });
        } catch (error) {
          const envelope = toErrorEnvelope(error);
          results.push({ index, status: "error", error: envelope });
          if (!atomic) continue;
          try {
            await restoreState?.(snapshot);
          } catch (rollbackError) {
            operationError("FOUNDRY_ERROR", "Atomic batch rollback failed", {
              partialSideEffectsPossible: true,
              createdIndexes: results
                .filter((result) => result.status === "created")
                .map((result) => result.index),
              createError: envelope,
              rollbackError: toErrorEnvelope(rollbackError),
            });
          }
          return {
            atomic: true,
            committed: false,
            dryRun: false,
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
      return {
        atomic,
        committed: results.every((result) => result.status === "created"),
        dryRun: false,
        results,
      };
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
      if (document.pack) {
        await this.#writablePack(document.pack);
      }
      const before = cloneJsonObject(document.toObject());
      const actualHash = sourceHash(before);
      const actualVersion = sourceVersion(document, before);
      if (!parsed.forceOverwrite) {
        if (parsed.expectedHash !== undefined && parsed.expectedHash !== actualHash) {
          operationError("CONFLICT", "Document source hash does not match", {
            expected: parsed.expectedHash,
            actual: actualHash,
            ...(parsed.expectedHash.startsWith("fmcp-v1-")
              ? { reason: "hash_algorithm_upgraded" }
              : {}),
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
      }
      if (parsed.dryRun) {
        const runtimeValidation = await this.#validateUpdateSchema(document, parsed.data);
        const view = this.#view(document);
        return {
          uuid: view.uuid,
          sourceHash: view.sourceHash,
          sourceVersion: view.sourceVersion,
          forced: parsed.forceOverwrite,
          dryRun: true,
          committed: false,
          validation: {
            valid: true,
            operation: "update",
            target: document.pack ? "compendium" : document.parent ? "embedded" : "world",
            type: document.documentName,
            ...(document.subtype ? { subtype: document.subtype } : {}),
            ...(document.parent ? { parentUuid: document.parent.uuid } : {}),
            ...(document.pack ? { packId: document.pack } : {}),
            permissionValidated: true,
            schemaValidated: runtimeValidation.schemaValidated,
            warnings: this.#boundedWarnings(runtimeValidation.warnings),
          },
          document: view,
        };
      }
      if (parsed.forceOverwrite) {
        await this.runtime.audit({ action: "document.update", uuid: document.uuid, forced: true });
      }
      const updated = await this.runtime.updateDocument(document, parsed.data);
      options?.markCommitted?.(`updated ${document.uuid}`);
      const view = this.#view(updated);
      return {
        uuid: view.uuid,
        sourceHash: view.sourceHash,
        sourceVersion: view.sourceVersion,
        forced: parsed.forceOverwrite,
        dryRun: false,
        committed: true,
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
        if (all.length % 25 === 0) {
          await this.#progress(
            options,
            Math.min(900, 100 + all.length),
            `Traversed ${all.length.toString()} embedded Documents`,
          );
        }
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
        .filter((pack) => pack.accessible)
        .map((pack) => ({
          id: pack.id,
          label: pack.label,
          type: pack.type,
          documentCount: pack.documentCount,
          locked: pack.locked,
          writable: pack.writable,
          ...(pack.writeReason ? { writeReason: pack.writeReason } : {}),
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
      if (!pack.accessible)
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
          items: page.map((document) => ({
            ...this.#view(document),
            pack: { id: pack.id, label: pack.label, locked: pack.locked },
          })),
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
      let queryHasMore = false;
      if ("uuids" in parsed) {
        uuids = [...parsed.uuids];
      } else {
        uuids = [];
        let cursor: string | undefined;
        do {
          const remaining = parsed.maxItems - uuids.length;
          const listed = await this.list(
            {
              ...parsed.query,
              pageSize: Math.min(MAX_PAGE_SIZE, remaining),
              ...(cursor ? { cursor } : {}),
            },
            options,
          );
          if (!listed.ok) throw new DocumentOperationError(listed.error);
          uuids.push(...listed.value.items.map((item) => item.uuid));
          cursor = listed.value.nextCursor;
        } while (cursor && uuids.length < parsed.maxItems);
        queryHasMore = Boolean(cursor);
      }
      const reasons = new Set<"maxDepth" | "maxBytes" | "maxItems">();
      if (queryHasMore) reasons.add("maxItems");
      const redactedPaths: string[] = [];
      const state = { itemCount: 0 };
      const sourceWork: SnapshotSourceWork = { nodes: 0, bytes: 0 };
      const cloneBudget: SnapshotCloneBudget = {
        nodes: 0,
        bytes: 0,
        maxBytes: parsed.maxBytes,
        reasons,
      };
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
            sourceWork,
            cloneBudget,
          ),
        );
        await this.#progress(
          options,
          Math.min(900, Math.round((snapshot.length / Math.max(1, uuids.length)) * 900)),
          `Snapshotted ${snapshot.length.toString()} of ${uuids.length.toString()} Documents`,
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
          if (byteCount > parsed.maxBytes) {
            snapshot[0] = { $truncated: "maxBytes" };
            byteCount = utf8Length(JSON.stringify(snapshot));
          }
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

  async #progress(
    options: DocumentOperationOptions | undefined,
    progress: number,
    message: string,
  ): Promise<void> {
    if (!options?.reportProgress) return;
    await options.reportProgress({ stage: "progress", progress, total: 1_000, message });
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
    validateSchema: boolean,
  ): Promise<ValidatedCreate | { ok: false; error: ErrorEnvelope }> {
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
      let pack: RuntimeCompendium | undefined;
      if (item.packId) {
        pack = await this.#writablePack(item.packId);
        if (pack.type !== item.type) {
          operationError(
            "UNSUPPORTED_TYPE",
            `Compendium ${pack.id} stores ${pack.type}, not ${item.type}`,
          );
        }
      }
      if (parent?.pack) await this.#writablePack(parent.pack);
      const schemaValidation = validateSchema
        ? await this.#validateCreateSchema(item, parent, pack)
        : { schemaValidated: false, warnings: [] };
      return {
        ok: true,
        item,
        ...(parent ? { parent } : {}),
        ...(pack ? { pack } : {}),
        schemaValidation,
      };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  }

  async #writablePack(packId: string): Promise<RuntimeCompendium> {
    const pack = await this.runtime.getCompendium(packId);
    if (!pack) operationError("NOT_FOUND", `Compendium ${packId} was not found`);
    if (!pack.accessible)
      operationError("PERMISSION_DENIED", `Compendium ${packId} is not accessible`, { packId });
    if (pack.locked)
      operationError("PERMISSION_DENIED", `Compendium ${packId} is locked`, {
        packId,
        locked: true,
      });
    if (!pack.writable)
      operationError(
        "PERMISSION_DENIED",
        pack.writeReason ?? `Compendium ${packId} is not writable`,
        { packId, locked: false },
      );
    return pack;
  }

  async #validateCreateSchema(
    item: DocumentCreateItem,
    parent: RuntimeDocument | undefined,
    pack: RuntimeCompendium | undefined,
  ): Promise<RuntimeDocumentValidation> {
    if (!this.runtime.validateDocumentCreate) {
      return {
        schemaValidated: false,
        warnings: ["The Foundry runtime exposes no side-effect-free create schema validator"],
      };
    }
    try {
      return await this.runtime.validateDocumentCreate(item.type, item.data, parent, pack);
    } catch (error) {
      operationError("INVALID_DATA", "Foundry create schema validation failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #validateUpdateSchema(
    document: RuntimeDocument,
    data: JsonObject,
  ): Promise<RuntimeDocumentValidation> {
    if (!this.runtime.validateDocumentUpdate) {
      return {
        schemaValidated: false,
        warnings: ["The Foundry runtime exposes no side-effect-free update schema validator"],
      };
    }
    try {
      return await this.runtime.validateDocumentUpdate(document, data);
    } catch (error) {
      operationError("INVALID_DATA", "Foundry update schema validation failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #createValidation(
    validation: ValidatedCreate,
  ): Extract<DocumentCreateResult, { status: "validated" }>["validation"] {
    const subtype =
      typeof validation.item.data.type === "string" ? validation.item.data.type : undefined;
    return {
      valid: true,
      operation: "create",
      target: validation.pack ? "compendium" : validation.parent ? "embedded" : "world",
      type: validation.item.type,
      ...(subtype ? { subtype } : {}),
      ...(validation.parent ? { parentUuid: validation.parent.uuid } : {}),
      ...(validation.pack ? { packId: validation.pack.id } : {}),
      permissionValidated: true,
      schemaValidated: validation.schemaValidation.schemaValidated,
      warnings: this.#boundedWarnings(validation.schemaValidation.warnings),
    };
  }

  #boundedWarnings(warnings: readonly string[]): string[] {
    return warnings
      .filter((warning) => warning.trim().length > 0)
      .slice(0, 20)
      .map((warning) => warning.trim().slice(0, 500));
  }

  #redact(data: JsonObject, paths: readonly string[], uuid: string, reported: string[]): void {
    for (const configuredPath of paths) {
      const segments = safePathSegments(configuredPath);
      if (segments.length === 0) continue;
      let current: JsonObject = data;
      for (const segment of segments.slice(0, -1)) {
        const child = Object.hasOwn(current, segment) ? current[segment] : undefined;
        if (!child || typeof child !== "object" || Array.isArray(child)) {
          current = Object.create(null) as JsonObject;
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
    sourceWork: SnapshotSourceWork,
    cloneBudget: SnapshotCloneBudget,
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
    const source = document.toObject();
    assertSnapshotSourceBounded(source, sourceWork);
    const cloned = cloneSnapshotValue(source, cloneBudget, depth, maxDepth);
    const data =
      cloned && typeof cloned === "object" && !Array.isArray(cloned)
        ? cloned
        : (Object.create(null) as JsonObject);
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
              sourceWork,
              cloneBudget,
            ),
          };
        } catch {
          return value;
        }
      }
      if (Array.isArray(value)) {
        if (currentDepth >= maxDepth) {
          reasons.add("maxDepth");
          return { $truncated: "maxDepth" };
        }
        return Promise.all(value.map((entry) => expandValue(entry, currentDepth + 1)));
      }
      if (value && typeof value === "object") {
        if (currentDepth >= maxDepth) {
          reasons.add("maxDepth");
          return { $truncated: "maxDepth" };
        }
        const output = Object.create(null) as JsonObject;
        for (const [key, entry] of Object.entries(value))
          output[key] = await expandValue(entry, currentDepth + 1);
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
