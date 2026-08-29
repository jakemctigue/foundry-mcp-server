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
  return value
    .replace(/<\s*(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed)\b[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, 'href="#"');
}

function cursorEncode(offset: number): string {
  return `v1.${offset}`;
}

function cursorDecode(value: string | undefined): number | null {
  if (!value) return 0;
  const match = /^v1\.(\d+)$/.exec(value);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

function failure<T>(error: ErrorEnvelope): OperationResult<T> {
  return { ok: false, error };
}

export interface FoundrySessionServiceOptions {
  now?: () => Date;
  idFactory?: () => string;
}

export class FoundrySessionService {
  readonly #now: () => Date;
  readonly #idFactory: () => string;

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
  }

  async start(input: unknown): Promise<OperationResult<SessionsStartOutput>> {
    const parsed = SessionsStartInput.safeParse(input);
    if (!parsed.success)
      return failure(
        makeError("INVALID_DATA", "Input validation failed", false, {
          issues: parsed.error.issues,
        }),
      );
    const existing = await this.#findByStartKey(parsed.data.idempotencyKey);
    if (!existing.ok) return existing;
    if (existing.value) {
      const metadata = metadataFromDocument(existing.value);
      if (!metadata)
        return failure(makeError("FOUNDRY_ERROR", "Stored session metadata is invalid"));
      return { ok: true, value: { session: metadata, journal: existing.value } };
    }
    const now = this.#now().toISOString();
    const sessionId = this.#idFactory();
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
    };
    const created = await this.documents.create({
      type: "JournalEntry",
      data: {
        name: parsed.data.title,
        ...(parsed.data.folder !== undefined ? { folder: parsed.data.folder } : {}),
        flags: {
          foundryMcp: {
            session: metadata,
            idempotency: { startKeys: [parsed.data.idempotencyKey], statusKeys: [] },
          },
        },
      },
    });
    if (!created.ok) return created;
    const result = created.value.results[0];
    if (!result || result.status !== "created") {
      return failure(
        result?.error ?? makeError("FOUNDRY_ERROR", "Foundry did not create the session journal"),
      );
    }
    const finalMetadata = { ...metadata, journalUuid: result.document.uuid };
    const updated = await this.documents.update({
      uuid: result.document.uuid,
      data: { flags: { foundryMcp: { session: finalMetadata } } },
      expectedHash: result.document.sourceHash,
    });
    if (!updated.ok) return updated;
    return { ok: true, value: { session: finalMetadata, journal: updated.value.document } };
  }

  async append(input: unknown): Promise<OperationResult<SessionsAppendOutput>> {
    const parsed = SessionsAppendInput.safeParse(input);
    if (!parsed.success)
      return failure(
        makeError("INVALID_DATA", "Input validation failed", false, {
          issues: parsed.error.issues,
        }),
      );
    const found = await this.#findSession(parsed.data.sessionId);
    if (!found.ok) return found;
    const metadata = metadataFromDocument(found.value);
    if (!metadata) return failure(makeError("FOUNDRY_ERROR", "Stored session metadata is invalid"));
    if (metadata.status !== "open")
      return failure(makeError("CONFLICT", "Cannot append to an ended session"));
    const existingPages = await this.#allPages(found.value.uuid);
    if (!existingPages.ok) return existingPages;
    const duplicate = existingPages.value.find(
      (document) => foundryMcpFlags(document.data).idempotencyKey === parsed.data.idempotencyKey,
    );
    if (duplicate) {
      const page = pageFromDocument(duplicate);
      if (!page)
        return failure(makeError("FOUNDRY_ERROR", "Stored session page metadata is invalid"));
      return { ok: true, value: { session: metadata, page } };
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
    const created = await this.documents.create({
      type: "JournalEntryPage",
      parentUuid: found.value.uuid,
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
    });
    if (!created.ok) return created;
    const result = created.value.results[0];
    if (!result || result.status !== "created")
      return failure(
        result?.error ?? makeError("FOUNDRY_ERROR", "Foundry did not create the session page"),
      );
    const finalPage = { ...pageMetadata, uuid: result.document.uuid };
    const pageUpdated = await this.documents.update({
      uuid: result.document.uuid,
      data: { flags: { foundryMcp: { sessionPage: finalPage } } },
      expectedHash: result.document.sourceHash,
    });
    if (!pageUpdated.ok) return pageUpdated;
    const finalMetadata = { ...metadata, updatedAt: timestamp };
    const journalUpdated = await this.documents.update({
      uuid: found.value.uuid,
      data: { flags: { foundryMcp: { session: finalMetadata } } },
      expectedHash: found.value.sourceHash,
    });
    if (!journalUpdated.ok) return journalUpdated;
    return { ok: true, value: { session: finalMetadata, page: finalPage } };
  }

  async list(input: unknown = {}): Promise<OperationResult<SessionsListOutput>> {
    const parsed = SessionsListInput.safeParse(input);
    if (!parsed.success)
      return failure(
        makeError("INVALID_DATA", "Input validation failed", false, {
          issues: parsed.error.issues,
        }),
      );
    const journals = await this.#allSessionJournals();
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
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.sessionId.localeCompare(right.sessionId),
      );
    const offset = cursorDecode(parsed.data.cursor);
    if (offset === null) return failure(makeError("INVALID_DATA", "Session cursor is malformed"));
    const page = sessions.slice(offset, offset + parsed.data.pageSize);
    const output: SessionsListOutput = { sessions: page };
    if (offset + page.length < sessions.length)
      output.nextCursor = cursorEncode(offset + page.length);
    return { ok: true, value: output };
  }

  async get(input: unknown): Promise<OperationResult<SessionsGetOutput>> {
    const parsed = SessionsGetInput.safeParse(input);
    if (!parsed.success)
      return failure(
        makeError("INVALID_DATA", "Input validation failed", false, {
          issues: parsed.error.issues,
        }),
      );
    const found = await this.#findSession(parsed.data.sessionId);
    if (!found.ok) return found;
    const metadata = metadataFromDocument(found.value);
    if (!metadata) return failure(makeError("FOUNDRY_ERROR", "Stored session metadata is invalid"));
    const pageDocuments = await this.#allPages(found.value.uuid);
    if (!pageDocuments.ok) return pageDocuments;
    const pages = pageDocuments.value
      .flatMap((document) => {
        const page = pageFromDocument(document);
        return page ? [page] : [];
      })
      .sort(
        (left, right) =>
          left.timestamp.localeCompare(right.timestamp) || left.uuid.localeCompare(right.uuid),
      );
    const offset = cursorDecode(parsed.data.cursor);
    if (offset === null) return failure(makeError("INVALID_DATA", "Session cursor is malformed"));
    const page = pages.slice(offset, offset + parsed.data.pageSize);
    const output: SessionsGetOutput = { session: metadata, pages: page };
    if (offset + page.length < pages.length) output.nextCursor = cursorEncode(offset + page.length);
    return { ok: true, value: output };
  }

  async end(input: unknown): Promise<OperationResult<SessionsStatusOutput>> {
    return this.#setStatus(input, "ended");
  }

  async reopen(input: unknown): Promise<OperationResult<SessionsStatusOutput>> {
    return this.#setStatus(input, "open");
  }

  async #setStatus(
    input: unknown,
    status: "open" | "ended",
  ): Promise<OperationResult<SessionsStatusOutput>> {
    const parsed = SessionsStatusInput.safeParse(input);
    if (!parsed.success)
      return failure(
        makeError("INVALID_DATA", "Input validation failed", false, {
          issues: parsed.error.issues,
        }),
      );
    const found = await this.#findSession(parsed.data.sessionId);
    if (!found.ok) return found;
    const metadata = metadataFromDocument(found.value);
    if (!metadata) return failure(makeError("FOUNDRY_ERROR", "Stored session metadata is invalid"));
    const priorKeys = idempotencyKeys(found.value, "statusKeys");
    if (priorKeys.includes(parsed.data.idempotencyKey)) {
      return { ok: true, value: { session: metadata, journalData: found.value.data } };
    }
    const timestamp = this.#now().toISOString();
    const nextMetadata: SessionMetadata = {
      ...metadata,
      status,
      updatedAt: timestamp,
      ...(status === "ended" ? { endedAt: timestamp } : {}),
    };
    if (status === "open") delete nextMetadata.endedAt;
    const updated = await this.documents.update({
      uuid: found.value.uuid,
      data: {
        flags: {
          foundryMcp: {
            session: nextMetadata,
            idempotency: {
              startKeys: idempotencyKeys(found.value, "startKeys"),
              statusKeys: [...priorKeys, parsed.data.idempotencyKey],
            },
          },
        },
      },
      expectedHash: found.value.sourceHash,
    });
    if (!updated.ok) return updated;
    return { ok: true, value: { session: nextMetadata, journalData: updated.value.document.data } };
  }

  async #allSessionJournals(): Promise<OperationResult<DocumentView[]>> {
    const documents: DocumentView[] = [];
    let cursor: string | undefined;
    do {
      const listed = await this.documents.list({
        type: "JournalEntry",
        fields: ["name", "flags.foundryMcp"],
        pageSize: 200,
        ...(cursor ? { cursor } : {}),
      });
      if (!listed.ok) return listed;
      for (const summary of listed.value.items) {
        if (!summary.data || !foundryMcpFlags(summary.data).session) continue;
        const view = await this.documents.get({ uuid: summary.uuid });
        if (!view.ok) return view;
        documents.push(view.value);
      }
      cursor = listed.value.nextCursor;
    } while (cursor);
    return { ok: true, value: documents };
  }

  async #allPages(journalUuid: string): Promise<OperationResult<DocumentView[]>> {
    const documents: DocumentView[] = [];
    let cursor: string | undefined;
    do {
      const listed = await this.documents.embeddedList({
        parentUuid: journalUuid,
        embeddedType: "JournalEntryPage",
        recursive: false,
        maxDepth: 1,
        pageSize: 200,
        ...(cursor ? { cursor } : {}),
      });
      if (!listed.ok) return listed;
      for (const summary of listed.value.items) {
        const view = await this.documents.get({ uuid: summary.uuid });
        if (!view.ok) return view;
        documents.push(view.value);
      }
      cursor = listed.value.nextCursor;
    } while (cursor);
    return { ok: true, value: documents };
  }

  async #findSession(sessionId: string): Promise<OperationResult<DocumentView>> {
    const journals = await this.#allSessionJournals();
    if (!journals.ok) return journals;
    const found = journals.value.find(
      (document) => metadataFromDocument(document)?.sessionId === sessionId,
    );
    return found
      ? { ok: true, value: found }
      : failure(makeError("NOT_FOUND", `Session ${sessionId} was not found`));
  }

  async #findByStartKey(key: string): Promise<OperationResult<DocumentView | null>> {
    const journals = await this.#allSessionJournals();
    if (!journals.ok) return journals;
    return {
      ok: true,
      value:
        journals.value.find((document) => idempotencyKeys(document, "startKeys").includes(key)) ??
        null,
    };
  }
}

export { sanitizeJournalHtml };
