import {
  SessionMetadata,
  SessionPage,
  SessionsAppendInput,
  SessionsGetInput,
  SessionsListInput,
  SessionsStartInput,
  SessionsStatusInput,
  makeError,
  type DocumentView,
  type ErrorEnvelope,
  type JsonObject,
  type OperationResult,
  type OperationExecutionOptions,
  type SessionsAppendOutput,
  type SessionsGetOutput,
  type SessionsListOutput,
  type SessionsStartOutput,
  type SessionsStatusOutput,
} from "@foundry-mcp/protocol";

import { FoundryDocumentService } from "./documents.js";

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function foundryMcpFlags(data: JsonObject): JsonObject {
  return record(record(data.flags).foundryMcp);
}

function metadataFromDocument(document: DocumentView): SessionMetadata | null {
  const parsed = SessionMetadata.safeParse(foundryMcpFlags(document.data).session);
  return parsed.success ? parsed.data : null;
}

function pageFromDocument(document: DocumentView): SessionPage | null {
  const parsed = SessionPage.safeParse(foundryMcpFlags(document.data).sessionPage);
  return parsed.success ? parsed.data : null;
}

function idempotencyKeys(document: DocumentView, category: "startKeys" | "statusKeys"): string[] {
  const value = record(foundryMcpFlags(document.data).idempotency)[category];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function sanitizeJournalHtml(value: string): string {
  const stripped = value
    .replace(/<\s*(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed)\b[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, 'href="#"');
  const allowed = new Set([
    "p",
    "br",
    "strong",
    "em",
    "b",
    "i",
    "ul",
    "ol",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "code",
    "pre",
    "a",
  ]);
  return stripped.replace(
    /<\s*(\/?)\s*([a-z][a-z0-9]*)\b([^>]*)>/gi,
    (_match: string, closing: string, rawTag: string, rawAttributes: string) => {
      const tag = rawTag.toLocaleLowerCase();
      if (!allowed.has(tag)) return "";
      if (closing) return tag === "br" ? "" : `</${tag}>`;
      if (tag === "br") return "<br>";
      if (tag !== "a") return `<${tag}>`;
      const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(rawAttributes);
      const href = hrefMatch?.[1] ?? hrefMatch?.[2];
      if (!href) return "<a>";
      const safe = /^(?:https?:\/\/|\/|#)/i.test(href) ? href : "#";
      const escaped = safe.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
      return `<a href="${escaped}" rel="noreferrer noopener">`;
    },
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

interface SessionListCursorPayload {
  kind: "list";
  updatedAt: string;
  sessionId: string;
  status: "open" | "ended" | null;
  query: string | null;
  connectionId: string | null;
}

interface SessionTimelineCursorPayload {
  kind: "timeline";
  timestamp: string;
  pageUuid: string;
  sessionId: string;
  connectionId: string | null;
}

type SessionCursorPayload = SessionListCursorPayload | SessionTimelineCursorPayload;

interface SessionCursorState {
  readonly entries: Map<string, SessionCursorPayload>;
  readonly order: string[];
}

const CURSOR_START = Symbol("session-cursor-start");
const BASE64_URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_ACTIVE_SESSION_CURSORS = 4096;

function cursorChecksum(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function base64UrlEncodeAscii(value: string): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < value.length; index += 1) {
    buffer = (buffer << 8) | value.charCodeAt(index);
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output += BASE64_URL_ALPHABET[(buffer >>> bits) & 0x3f];
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) output += BASE64_URL_ALPHABET[(buffer << (6 - bits)) & 0x3f];
  return output;
}

function secureCursorNonce(): string | null {
  const cryptoValue = (
    globalThis as unknown as {
      crypto?: { getRandomValues?: (values: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (!cryptoValue?.getRandomValues) return null;
  const bytes = cryptoValue.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return base64UrlEncodeAscii(binary);
}

function cursorEncode(state: SessionCursorState, payload: SessionCursorPayload): string | null {
  let nonce: string | null;
  let cursor: string;
  do {
    nonce = secureCursorNonce();
    if (!nonce) return null;
    cursor = `sc1.${nonce}.${cursorChecksum(nonce)}`;
  } while (state.entries.has(cursor));
  state.entries.set(cursor, payload);
  state.order.push(cursor);
  while (state.order.length > MAX_ACTIVE_SESSION_CURSORS) {
    const expired = state.order.shift();
    if (expired) state.entries.delete(expired);
  }
  return cursor;
}

function cursorDecode(
  state: SessionCursorState,
  value: string | undefined,
): SessionCursorPayload | typeof CURSOR_START | null {
  if (!value || value === "v1.0") return CURSOR_START;
  const match = /^sc1\.([A-Za-z0-9_-]+)\.([0-9a-f]{8})$/.exec(value);
  const nonce = match?.[1];
  const checksum = match?.[2];
  if (!nonce || !checksum || cursorChecksum(nonce) !== checksum) return null;
  return state.entries.get(value) ?? null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSessionOrder(
  left: Pick<SessionMetadata, "updatedAt" | "sessionId">,
  right: Pick<SessionMetadata, "updatedAt" | "sessionId">,
): number {
  return (
    compareText(right.updatedAt, left.updatedAt) || compareText(left.sessionId, right.sessionId)
  );
}

function compareTimelineOrder(
  left: Pick<SessionPage, "timestamp" | "uuid">,
  right: Pick<SessionPage, "timestamp" | "uuid">,
): number {
  return compareText(left.timestamp, right.timestamp) || compareText(left.uuid, right.uuid);
}

function failure<T>(error: ErrorEnvelope): OperationResult<T> {
  return { ok: false, error };
}

const sessionLocksByRuntime = new WeakMap<object, Map<string, Promise<void>>>();
const sessionCursorsByRuntime = new WeakMap<object, SessionCursorState>();

export interface FoundrySessionServiceOptions {
  now?: () => Date;
  idFactory?: () => string;
  journalFolderName?: string | null;
}

export class FoundrySessionService {
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #journalFolderName: string | null;
  readonly #locks: Map<string, Promise<void>>;
  readonly #cursors: SessionCursorState;

  constructor(
    readonly documents: FoundryDocumentService,
    options: FoundrySessionServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#idFactory =
      options.idFactory ??
      (() => {
        const cryptoValue = (globalThis as unknown as { crypto?: { randomUUID?: () => string } })
          .crypto;
        return (
          cryptoValue?.randomUUID?.() ??
          `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
        );
      });
    this.#journalFolderName = options.journalFolderName ?? "Foundry MCP Sessions";
    const runtimeKey = documents.runtime as object;
    const existingLocks = sessionLocksByRuntime.get(runtimeKey);
    this.#locks = existingLocks ?? new Map<string, Promise<void>>();
    if (!existingLocks) sessionLocksByRuntime.set(runtimeKey, this.#locks);
    const existingCursors = sessionCursorsByRuntime.get(runtimeKey);
    this.#cursors = existingCursors ?? { entries: new Map(), order: [] };
    if (!existingCursors) sessionCursorsByRuntime.set(runtimeKey, this.#cursors);
  }

  async start(
    input: unknown,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<SessionsStartOutput>> {
    this.#guard(operation);
    const parsed = SessionsStartInput.safeParse(input);
    if (!parsed.success)
      return failure(
        makeError("INVALID_DATA", "Input validation failed", false, {
          issues: parsed.error.issues,
        }),
      );
    return this.#withLock(
      `start:${parsed.data.idempotencyKey}`,
      () => this.#startUnlocked(parsed.data, operation),
      operation,
    );
  }

  async #startUnlocked(
    input: unknown,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<SessionsStartOutput>> {
    this.#guard(operation);
    const parsed = SessionsStartInput.safeParse(input);
    if (!parsed.success)
      return failure(
        makeError("INVALID_DATA", "Input validation failed", false, {
          issues: parsed.error.issues,
        }),
      );
    const existing = await this.#findByStartKey(parsed.data.idempotencyKey, operation);
    if (!existing.ok) return existing;
    if (existing.value) {
      const metadata = metadataFromDocument(existing.value);
      if (!metadata)
        return failure(makeError("FOUNDRY_ERROR", "Stored session metadata is invalid"));
      const repaired = await this.#repairJournalIdentity(existing.value, metadata, operation);
      if (!repaired.ok) return repaired;
      const page = await this.#ensureInitialPage(
        repaired.value.journal,
        repaired.value.metadata,
        parsed.data.idempotencyKey,
        parsed.data.initialHtml,
        operation,
      );
      if (!page.ok) return page;
      return {
        ok: true,
        value: { session: page.value.session, journal: page.value.journal, page: page.value.page },
      };
    }
    const now = this.#now().toISOString();
    const sessionId = this.#idFactory();
    let folder = parsed.data.folder;
    if (folder === undefined) {
      const requestedFolderName = parsed.data.folderName ?? this.#journalFolderName;
      if (requestedFolderName) {
        const ensuredFolder = await this.#ensureFolder(requestedFolderName, operation);
        if (!ensuredFolder.ok) return ensuredFolder;
        folder = ensuredFolder.value.uuid;
      }
    }
    const metadata: SessionMetadata = {
      sessionId,
      journalUuid: "pending",
      title: parsed.data.title,
      purpose: parsed.data.purpose,
      tags: parsed.data.tags,
      participants: parsed.data.participants,
      linkedUuids: parsed.data.linkedUuids,
      status: "open",
      startedAt: now,
      updatedAt: now,
      ...(typeof folder === "string" ? { folderUuid: folder } : {}),
    };
    const created = await this.documents.create(
      {
        type: "JournalEntry",
        data: {
          name: parsed.data.title,
          ...(folder !== undefined ? { folder } : {}),
          flags: {
            foundryMcp: {
              session: metadata,
              idempotency: { startKeys: [parsed.data.idempotencyKey], statusKeys: [] },
            },
          },
        },
      },
      operation,
    );
    if (!created.ok) return created;
    const result = created.value.results[0];
    if (!result || result.status !== "created") {
      return failure(
        (result?.status === "error" ? result.error : undefined) ??
          makeError("FOUNDRY_ERROR", "Foundry did not create the session journal"),
      );
    }
    const finalMetadata = { ...metadata, journalUuid: result.document.uuid };
    const updated = await this.documents.update(
      {
        uuid: result.document.uuid,
        data: { flags: { foundryMcp: { session: finalMetadata } } },
        expectedHash: result.document.sourceHash,
      },
      operation,
    );
    if (!updated.ok) return updated;
    const page = await this.#ensureInitialPage(
      updated.value.document,
      finalMetadata,
      parsed.data.idempotencyKey,
      parsed.data.initialHtml,
      operation,
    );
    if (!page.ok) return page;
    return {
      ok: true,
      value: { session: page.value.session, journal: page.value.journal, page: page.value.page },
    };
  }

  async append(
    input: unknown,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<SessionsAppendOutput>> {
    this.#guard(operation);
    const parsed = SessionsAppendInput.safeParse(input);
    if (!parsed.success)
      return failure(
        makeError("INVALID_DATA", "Input validation failed", false, {
          issues: parsed.error.issues,
        }),
      );
    return this.#withLock(
      `session:${parsed.data.sessionId}`,
      () => this.#appendUnlocked(parsed.data, operation),
      operation,
    );
  }

  async #appendUnlocked(
    input: unknown,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<SessionsAppendOutput>> {
    this.#guard(operation);
    const parsed = SessionsAppendInput.safeParse(input);
    if (!parsed.success)
      return failure(
        makeError("INVALID_DATA", "Input validation failed", false, {
          issues: parsed.error.issues,
        }),
      );
    const found = await this.#findSession(parsed.data.sessionId, operation);
    if (!found.ok) return found;
    const storedMetadata = metadataFromDocument(found.value);
    if (!storedMetadata)
      return failure(makeError("FOUNDRY_ERROR", "Stored session metadata is invalid"));
    const repaired = await this.#repairJournalIdentity(found.value, storedMetadata, operation);
    if (!repaired.ok) return repaired;
    const journal = repaired.value.journal;
    const metadata = repaired.value.metadata;
    if (metadata.status !== "open")
      return failure(makeError("CONFLICT", "Cannot append to an ended session"));
    const existingPages = await this.#allPages(journal.uuid, operation);
    if (!existingPages.ok) return existingPages;
    const duplicate = existingPages.value.find(
      (document) => foundryMcpFlags(document.data).idempotencyKey === parsed.data.idempotencyKey,
    );
    if (duplicate) {
      const page = pageFromDocument(duplicate);
      if (!page)
        return failure(makeError("FOUNDRY_ERROR", "Stored session page metadata is invalid"));
      return this.#completeExistingAppend(journal, metadata, duplicate, page, operation);
    }
    const timestamp = this.#now().toISOString();
    const pageMetadata: SessionPage = {
      uuid: "pending",
      timestamp,
      kind: parsed.data.kind,
      attribution: parsed.data.attribution,
      html: sanitizeJournalHtml(parsed.data.html),
      linkedUuids: parsed.data.linkedUuids,
      private: parsed.data.private,
    };
    const created = await this.documents.create(
      {
        type: "JournalEntryPage",
        parentUuid: journal.uuid,
        data: {
          name: `${timestamp} — ${parsed.data.kind}`,
          type: "text",
          text: { content: pageMetadata.html, format: 1 },
          flags: {
            foundryMcp: {
              sessionId: metadata.sessionId,
              sessionPage: pageMetadata,
              idempotencyKey: parsed.data.idempotencyKey,
              excludeFromIntelligence: parsed.data.private,
            },
          },
        },
      },
      operation,
    );
    if (!created.ok) return created;
    const result = created.value.results[0];
    if (!result || result.status !== "created")
      return failure(
        (result?.status === "error" ? result.error : undefined) ??
          makeError("FOUNDRY_ERROR", "Foundry did not create the session page"),
      );
    const finalPage = { ...pageMetadata, uuid: result.document.uuid };
    const pageUpdated = await this.documents.update(
      {
        uuid: result.document.uuid,
        data: { flags: { foundryMcp: { sessionPage: finalPage } } },
        expectedHash: result.document.sourceHash,
      },
      operation,
    );
    if (!pageUpdated.ok) return pageUpdated;
    const finalMetadata = { ...metadata, updatedAt: timestamp };
    const currentJournal = await this.documents.get({ uuid: journal.uuid }, operation);
    if (!currentJournal.ok) return currentJournal;
    const journalUpdated = await this.documents.update(
      {
        uuid: journal.uuid,
        data: { flags: { foundryMcp: { session: finalMetadata } } },
        expectedHash: currentJournal.value.sourceHash,
      },
      operation,
    );
    if (!journalUpdated.ok) return journalUpdated;
    return { ok: true, value: { session: finalMetadata, page: finalPage } };
  }

  async list(
    input: unknown = {},
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<SessionsListOutput>> {
    this.#guard(operation);
    const parsed = SessionsListInput.safeParse(input);
    if (!parsed.success)
      return failure(
        makeError("INVALID_DATA", "Input validation failed", false, {
          issues: parsed.error.issues,
        }),
      );
    const journals = await this.#allSessionJournals(operation);
    if (!journals.ok) return journals;
    const sessions = journals.value
      .flatMap((document) => {
        const metadata = metadataFromDocument(document);
        return metadata ? [metadata] : [];
      })
      .filter((session) => !parsed.data.status || session.status === parsed.data.status)
      .filter((session) => {
        if (!parsed.data.query) return true;
        const haystack =
          `${session.title}\n${session.purpose}\n${session.tags.join(" ")}`.toLocaleLowerCase();
        return haystack.includes(parsed.data.query.toLocaleLowerCase());
      })
      .sort(compareSessionOrder);
    const decodedCursor = cursorDecode(this.#cursors, parsed.data.cursor);
    if (
      decodedCursor === null ||
      (decodedCursor !== CURSOR_START &&
        (decodedCursor.kind !== "list" ||
          decodedCursor.status !== (parsed.data.status ?? null) ||
          decodedCursor.query !== (parsed.data.query ?? null) ||
          decodedCursor.connectionId !== (parsed.data.connectionId ?? null)))
    )
      return failure(
        makeError(
          "INVALID_DATA",
          "Session cursor is malformed, tampered, or does not match this request",
        ),
      );
    const remaining =
      decodedCursor === CURSOR_START
        ? sessions
        : sessions.filter((session) => compareSessionOrder(session, decodedCursor) > 0);
    const page = remaining.slice(0, parsed.data.pageSize);
    const output: SessionsListOutput = { sessions: page };
    const last = page.at(-1);
    if (last && page.length < remaining.length) {
      const nextCursor = cursorEncode(this.#cursors, {
        kind: "list",
        updatedAt: last.updatedAt,
        sessionId: last.sessionId,
        status: parsed.data.status ?? null,
        query: parsed.data.query ?? null,
        connectionId: parsed.data.connectionId ?? null,
      });
      if (!nextCursor)
        return failure(
          makeError("FOUNDRY_ERROR", "Secure session cursor generation is unavailable"),
        );
      output.nextCursor = nextCursor;
    }
    return { ok: true, value: output };
  }

  async get(
    input: unknown,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<SessionsGetOutput>> {
    this.#guard(operation);
    const parsed = SessionsGetInput.safeParse(input);
    if (!parsed.success)
      return failure(
        makeError("INVALID_DATA", "Input validation failed", false, {
          issues: parsed.error.issues,
        }),
      );
    const found = await this.#findSession(parsed.data.sessionId, operation);
    if (!found.ok) return found;
    const metadata = metadataFromDocument(found.value);
    if (!metadata) return failure(makeError("FOUNDRY_ERROR", "Stored session metadata is invalid"));
    const pageDocuments = await this.#allPages(found.value.uuid, operation);
    if (!pageDocuments.ok) return pageDocuments;
    const pages = pageDocuments.value
      .flatMap((document) => {
        const page = pageFromDocument(document);
        return page ? [page] : [];
      })
      .sort(compareTimelineOrder);
    const decodedCursor = cursorDecode(this.#cursors, parsed.data.cursor);
    if (
      decodedCursor === null ||
      (decodedCursor !== CURSOR_START &&
        (decodedCursor.kind !== "timeline" ||
          decodedCursor.sessionId !== parsed.data.sessionId ||
          decodedCursor.connectionId !== (parsed.data.connectionId ?? null)))
    )
      return failure(
        makeError(
          "INVALID_DATA",
          "Session cursor is malformed, tampered, or does not match this request",
        ),
      );
    const remaining =
      decodedCursor === CURSOR_START
        ? pages
        : pages.filter(
            (page) =>
              compareTimelineOrder(page, {
                timestamp: decodedCursor.timestamp,
                uuid: decodedCursor.pageUuid,
              }) > 0,
          );
    const page = remaining.slice(0, parsed.data.pageSize);
    const output: SessionsGetOutput = { session: metadata, pages: page };
    const last = page.at(-1);
    if (last && page.length < remaining.length) {
      const nextCursor = cursorEncode(this.#cursors, {
        kind: "timeline",
        timestamp: last.timestamp,
        pageUuid: last.uuid,
        sessionId: parsed.data.sessionId,
        connectionId: parsed.data.connectionId ?? null,
      });
      if (!nextCursor)
        return failure(
          makeError("FOUNDRY_ERROR", "Secure session cursor generation is unavailable"),
        );
      output.nextCursor = nextCursor;
    }
    return { ok: true, value: output };
  }

  async end(
    input: unknown,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<SessionsStatusOutput>> {
    return this.#setStatus(input, "ended", operation);
  }

  async reopen(
    input: unknown,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<SessionsStatusOutput>> {
    return this.#setStatus(input, "open", operation);
  }

  async #setStatus(
    input: unknown,
    status: "open" | "ended",
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<SessionsStatusOutput>> {
    const parsed = SessionsStatusInput.safeParse(input);
    if (!parsed.success)
      return failure(
        makeError("INVALID_DATA", "Input validation failed", false, {
          issues: parsed.error.issues,
        }),
      );
    return this.#withLock(
      `session:${parsed.data.sessionId}`,
      () => this.#setStatusUnlocked(parsed.data, status, operation),
      operation,
    );
  }

  async #setStatusUnlocked(
    input: unknown,
    status: "open" | "ended",
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<SessionsStatusOutput>> {
    const parsed = SessionsStatusInput.safeParse(input);
    if (!parsed.success)
      return failure(
        makeError("INVALID_DATA", "Input validation failed", false, {
          issues: parsed.error.issues,
        }),
      );
    this.#guard(operation);
    const found = await this.#findSession(parsed.data.sessionId, operation);
    if (!found.ok) return found;
    const storedMetadata = metadataFromDocument(found.value);
    if (!storedMetadata)
      return failure(makeError("FOUNDRY_ERROR", "Stored session metadata is invalid"));
    const repaired = await this.#repairJournalIdentity(found.value, storedMetadata, operation);
    if (!repaired.ok) return repaired;
    const journal = repaired.value.journal;
    const metadata = repaired.value.metadata;
    const priorKeys = idempotencyKeys(journal, "statusKeys");
    if (priorKeys.includes(parsed.data.idempotencyKey)) {
      return { ok: true, value: { session: metadata, journalData: journal.data } };
    }
    const timestamp = this.#now().toISOString();
    const nextMetadata: SessionMetadata = {
      ...metadata,
      status,
      updatedAt: timestamp,
      ...(status === "ended" ? { endedAt: timestamp } : {}),
    };
    if (status === "open") delete nextMetadata.endedAt;
    const updated = await this.documents.update(
      {
        uuid: journal.uuid,
        data: {
          flags: {
            foundryMcp: {
              session: nextMetadata,
              idempotency: {
                startKeys: idempotencyKeys(journal, "startKeys"),
                statusKeys: [...priorKeys, parsed.data.idempotencyKey],
              },
            },
          },
        },
        expectedHash: journal.sourceHash,
      },
      operation,
    );
    if (!updated.ok) return updated;
    return { ok: true, value: { session: nextMetadata, journalData: updated.value.document.data } };
  }

  async #repairJournalIdentity(
    journal: DocumentView,
    metadata: SessionMetadata,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<{ journal: DocumentView; metadata: SessionMetadata }>> {
    if (metadata.journalUuid === journal.uuid) return { ok: true, value: { journal, metadata } };
    const repairedMetadata: SessionMetadata = { ...metadata, journalUuid: journal.uuid };
    const updated = await this.documents.update(
      {
        uuid: journal.uuid,
        data: { flags: { foundryMcp: { session: repairedMetadata } } },
        expectedHash: journal.sourceHash,
      },
      operation,
    );
    if (!updated.ok) return updated;
    return {
      ok: true,
      value: { journal: updated.value.document, metadata: repairedMetadata },
    };
  }

  async #completeExistingAppend(
    journal: DocumentView,
    metadata: SessionMetadata,
    pageDocument: DocumentView,
    page: SessionPage,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<SessionsAppendOutput>> {
    let finalPage = page;
    if (page.uuid !== pageDocument.uuid) {
      finalPage = { ...page, uuid: pageDocument.uuid };
      const repairedPage = await this.documents.update(
        {
          uuid: pageDocument.uuid,
          data: { flags: { foundryMcp: { sessionPage: finalPage } } },
          expectedHash: pageDocument.sourceHash,
        },
        operation,
      );
      if (!repairedPage.ok) return repairedPage;
    }
    if (metadata.updatedAt.localeCompare(finalPage.timestamp) >= 0)
      return { ok: true, value: { session: metadata, page: finalPage } };
    const nextMetadata: SessionMetadata = { ...metadata, updatedAt: finalPage.timestamp };
    const currentJournal = await this.documents.get({ uuid: journal.uuid }, operation);
    if (!currentJournal.ok) return currentJournal;
    const updated = await this.documents.update(
      {
        uuid: journal.uuid,
        data: { flags: { foundryMcp: { session: nextMetadata } } },
        expectedHash: currentJournal.value.sourceHash,
      },
      operation,
    );
    if (!updated.ok) return updated;
    return { ok: true, value: { session: nextMetadata, page: finalPage } };
  }

  async #withLock<T>(
    key: string,
    task: () => Promise<T>,
    operation?: OperationExecutionOptions,
  ): Promise<T> {
    const previous = (this.#locks.get(key) ?? Promise.resolve()).catch(() => undefined);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#locks.set(key, tail);
    void tail.then(() => {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    });
    try {
      const signal = operation?.signal;
      if (signal) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            signal.removeEventListener("abort", onAbort);
            reject(new Error("Operation was cancelled while queued"));
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          void previous.then(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          });
        });
      } else {
        await previous;
      }
      this.#guard(operation);
      return await task();
    } finally {
      release();
    }
  }

  async #ensureFolder(
    name: string,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<{ uuid: string }>> {
    return this.#withLock(
      `folder:${name}`,
      () => this.#ensureFolderUnlocked(name, operation),
      operation,
    );
  }

  async #ensureFolderUnlocked(
    name: string,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<{ uuid: string }>> {
    let cursor: string | undefined;
    do {
      const listed = await this.documents.list(
        {
          type: "Folder",
          nameFilter: name,
          fields: ["name", "type"],
          pageSize: 200,
          ...(cursor ? { cursor } : {}),
        },
        operation,
      );
      if (!listed.ok) return listed;
      const existing = listed.value.items.find(
        (item) => item.name === name && item.data?.type === "JournalEntry",
      );
      if (existing) return { ok: true, value: { uuid: existing.uuid } };
      cursor = listed.value.nextCursor;
    } while (cursor);
    const created = await this.documents.create(
      {
        type: "Folder",
        data: { name, type: "JournalEntry", sorting: "a", folder: null },
      },
      operation,
    );
    if (!created.ok) return created;
    const result = created.value.results[0];
    if (!result || result.status !== "created")
      return failure(
        (result?.status === "error" ? result.error : undefined) ??
          makeError("FOUNDRY_ERROR", "Foundry did not create the session folder"),
      );
    return { ok: true, value: { uuid: result.document.uuid } };
  }

  async #ensureInitialPage(
    journal: DocumentView,
    metadata: SessionMetadata,
    idempotencyKey: string,
    initialHtml?: string,
    operation?: OperationExecutionOptions,
  ): Promise<
    OperationResult<{ session: SessionMetadata; journal: DocumentView; page: SessionPage }>
  > {
    const pages = await this.#allPages(journal.uuid, operation);
    if (!pages.ok) return pages;
    const existing = pages.value.find(
      (document) => foundryMcpFlags(document.data).sessionInitialPage === true,
    );
    if (existing) {
      let page = pageFromDocument(existing);
      if (!page)
        return failure(
          makeError("FOUNDRY_ERROR", "Stored initial session page metadata is invalid"),
        );
      if (page.uuid !== existing.uuid) {
        page = { ...page, uuid: existing.uuid };
        const repairedPage = await this.documents.update(
          {
            uuid: existing.uuid,
            data: { flags: { foundryMcp: { sessionPage: page } } },
            expectedHash: existing.sourceHash,
          },
          operation,
        );
        if (!repairedPage.ok) return repairedPage;
      }
      if (metadata.initialPageUuid === page.uuid)
        return { ok: true, value: { session: metadata, journal, page } };
      const nextMetadata: SessionMetadata = { ...metadata, initialPageUuid: page.uuid };
      const updated = await this.documents.update(
        {
          uuid: journal.uuid,
          data: { flags: { foundryMcp: { session: nextMetadata } } },
          expectedHash: journal.sourceHash,
        },
        operation,
      );
      if (!updated.ok) return updated;
      return {
        ok: true,
        value: { session: nextMetadata, journal: updated.value.document, page },
      };
    }

    const html = sanitizeJournalHtml(initialHtml ?? `<p>${escapeHtml(metadata.purpose)}</p>`);
    const pendingPage: SessionPage = {
      uuid: "pending",
      timestamp: metadata.startedAt,
      kind: "summary",
      attribution: "foundry-mcp",
      html,
      linkedUuids: metadata.linkedUuids,
      private: false,
    };
    const created = await this.documents.create(
      {
        type: "JournalEntryPage",
        parentUuid: journal.uuid,
        data: {
          name: "Session Overview",
          type: "text",
          text: { content: html, format: 1 },
          flags: {
            foundryMcp: {
              sessionId: metadata.sessionId,
              sessionPage: pendingPage,
              sessionInitialPage: true,
              idempotencyKey,
              excludeFromIntelligence: false,
            },
          },
        },
      },
      operation,
    );
    if (!created.ok) return created;
    const result = created.value.results[0];
    if (!result || result.status !== "created")
      return failure(
        (result?.status === "error" ? result.error : undefined) ??
          makeError("FOUNDRY_ERROR", "Foundry did not create the initial session page"),
      );
    const page: SessionPage = { ...pendingPage, uuid: result.document.uuid };
    const pageUpdated = await this.documents.update(
      {
        uuid: result.document.uuid,
        data: { flags: { foundryMcp: { sessionPage: page } } },
        expectedHash: result.document.sourceHash,
      },
      operation,
    );
    if (!pageUpdated.ok) return pageUpdated;
    const nextMetadata: SessionMetadata = { ...metadata, initialPageUuid: page.uuid };
    const currentJournal = await this.documents.get({ uuid: journal.uuid }, operation);
    if (!currentJournal.ok) return currentJournal;
    const journalUpdated = await this.documents.update(
      {
        uuid: journal.uuid,
        data: { flags: { foundryMcp: { session: nextMetadata } } },
        expectedHash: currentJournal.value.sourceHash,
      },
      operation,
    );
    if (!journalUpdated.ok) return journalUpdated;
    return {
      ok: true,
      value: { session: nextMetadata, journal: journalUpdated.value.document, page },
    };
  }

  async #allSessionJournals(
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<DocumentView[]>> {
    const documents: DocumentView[] = [];
    let cursor: string | undefined;
    do {
      this.#guard(operation);
      const listed = await this.documents.list(
        {
          type: "JournalEntry",
          fields: ["name", "flags.foundryMcp"],
          pageSize: 200,
          ...(cursor ? { cursor } : {}),
        },
        operation,
      );
      if (!listed.ok) return listed;
      for (const summary of listed.value.items) {
        if (!summary.data || !foundryMcpFlags(summary.data).session) continue;
        const view = await this.documents.get({ uuid: summary.uuid }, operation);
        if (!view.ok) return view;
        documents.push(view.value);
      }
      cursor = listed.value.nextCursor;
    } while (cursor);
    return { ok: true, value: documents };
  }

  async #allPages(
    journalUuid: string,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<DocumentView[]>> {
    const documents: DocumentView[] = [];
    let cursor: string | undefined;
    do {
      this.#guard(operation);
      const listed = await this.documents.embeddedList(
        {
          parentUuid: journalUuid,
          embeddedType: "JournalEntryPage",
          recursive: false,
          maxDepth: 1,
          pageSize: 200,
          ...(cursor ? { cursor } : {}),
        },
        operation,
      );
      if (!listed.ok) return listed;
      for (const summary of listed.value.items) {
        const view = await this.documents.get({ uuid: summary.uuid }, operation);
        if (!view.ok) return view;
        documents.push(view.value);
      }
      cursor = listed.value.nextCursor;
    } while (cursor);
    return { ok: true, value: documents };
  }

  async #findSession(
    sessionId: string,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<DocumentView>> {
    const journals = await this.#allSessionJournals(operation);
    if (!journals.ok) return journals;
    const found = journals.value.find(
      (document) => metadataFromDocument(document)?.sessionId === sessionId,
    );
    return found
      ? { ok: true, value: found }
      : failure(makeError("NOT_FOUND", `Session ${sessionId} was not found`));
  }

  async #findByStartKey(
    key: string,
    operation?: OperationExecutionOptions,
  ): Promise<OperationResult<DocumentView | null>> {
    const journals = await this.#allSessionJournals(operation);
    if (!journals.ok) return journals;
    return {
      ok: true,
      value:
        journals.value.find((document) => idempotencyKeys(document, "startKeys").includes(key)) ??
        null,
    };
  }

  #guard(operation?: OperationExecutionOptions): void {
    operation?.signal?.throwIfAborted();
    if (operation?.deadline !== undefined && Date.now() >= operation.deadline) {
      throw new Error("Operation deadline elapsed");
    }
  }
}

export { sanitizeJournalHtml };
