import { describe, expect, it } from "vitest";

import type { OperationResult } from "@foundry-mcp/protocol";
import { FoundryDocumentService } from "../src/documents.js";
import { FoundrySessionService, sanitizeJournalHtml } from "../src/sessions.js";
import { createRichFakeRuntime } from "./fake-runtime/index.js";

function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

describe("FoundrySessionService", () => {
  it("backs idempotent start/append/end/reopen operations with JournalEntry/Page Documents", async () => {
    const runtime = createRichFakeRuntime();
    const documents = new FoundryDocumentService(runtime);
    const timestamps = [
      "2026-08-29T10:00:00.000Z",
      "2026-08-29T10:01:00.000Z",
      "2026-08-29T10:02:00.000Z",
      "2026-08-29T10:03:00.000Z",
    ];
    const fallbackTimestamp = timestamps[0] ?? "2026-08-29T10:00:00.000Z";
    let timestampIndex = 0;
    const sessions = new FoundrySessionService(documents, {
      now: () =>
        new Date(
          timestamps[Math.min(timestampIndex++, timestamps.length - 1)] ?? fallbackTimestamp,
        ),
      idFactory: () => "session-fixed",
    });
    const startInput = {
      title: "Session Zero",
      purpose: "Establish the campaign",
      tags: ["setup"],
      participants: ["GM", "Player"],
      linkedUuids: [],
      idempotencyKey: "start-key-0001",
    };
    const started = unwrap(await sessions.start(startInput));
    const duplicateStart = unwrap(await sessions.start(startInput));
    expect(duplicateStart.session.sessionId).toBe(started.session.sessionId);
    expect(unwrap(await documents.list({ type: "JournalEntry" })).items).toHaveLength(1);
    expect(duplicateStart.page.uuid).toBe(started.page.uuid);
    expect(unwrap(await documents.list({ type: "Folder" })).items).toHaveLength(1);
    expect(started.session.folderUuid).toBeDefined();
    expect(started.session.initialPageUuid).toBe(started.page.uuid);

    const appendInput = {
      sessionId: started.session.sessionId,
      kind: "decision" as const,
      html: '<p onclick="steal()">Keep this</p><script>alert(1)</script>',
      attribution: "GM",
      linkedUuids: [],
      private: false,
      idempotencyKey: "append-key-0001",
    };
    const appended = unwrap(await sessions.append(appendInput));
    const duplicateAppend = unwrap(await sessions.append(appendInput));
    expect(duplicateAppend.page.uuid).toBe(appended.page.uuid);
    expect(appended.page.html).toContain("Keep this");
    expect(appended.page.html).not.toMatch(/script|onclick/i);
    expect(
      unwrap(
        await documents.embeddedList({
          parentUuid: started.journal.uuid,
          embeddedType: "JournalEntryPage",
          maxDepth: 1,
        }),
      ).items,
    ).toHaveLength(2);

    const statusInput = { sessionId: started.session.sessionId, idempotencyKey: "status-key-0001" };
    const ended = unwrap(await sessions.end(statusInput));
    expect(ended.session.status).toBe("ended");
    expect(unwrap(await sessions.end(statusInput)).session.endedAt).toBe(ended.session.endedAt);
    expect(
      await sessions.append({ ...appendInput, idempotencyKey: "append-key-0002" }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    const reopened = unwrap(
      await sessions.reopen({
        sessionId: started.session.sessionId,
        idempotencyKey: "status-key-0002",
      }),
    );
    expect(reopened.session.status).toBe("open");
    expect(reopened.session.endedAt).toBeUndefined();

    const listed = unwrap(await sessions.list({ query: "campaign", pageSize: 1 }));
    expect(listed.sessions).toHaveLength(1);
    const timeline = unwrap(
      await sessions.get({ sessionId: started.session.sessionId, pageSize: 1 }),
    );
    expect(timeline.pages).toEqual([started.page]);
    expect(timeline.nextCursor).toBeDefined();
  });

  it("marks private pages for default intelligence exclusion without changing journal ownership", async () => {
    const runtime = createRichFakeRuntime();
    const documents = new FoundryDocumentService(runtime);
    const sessions = new FoundrySessionService(documents, {
      now: () => new Date("2026-08-29T12:00:00.000Z"),
      idFactory: () => "private-session",
    });
    const started = unwrap(
      await sessions.start({
        title: "Private Notes",
        purpose: "Test secrecy",
        idempotencyKey: "private-start-key",
      }),
    );
    const appended = unwrap(
      await sessions.append({
        sessionId: started.session.sessionId,
        kind: "note",
        html: "Secret",
        attribution: "GM",
        private: true,
        idempotencyKey: "private-append-key",
      }),
    );
    const page = unwrap(await documents.get({ uuid: appended.page.uuid }));
    expect(page.data.flags).toHaveProperty("foundryMcp.excludeFromIntelligence", true);
    expect(started.journal.ownershipSummary).toEqual({ default: 1 });
  });

  it("reuses a configured JournalEntry folder and preserves unrelated journal content", async () => {
    const runtime = createRichFakeRuntime();
    const documents = new FoundryDocumentService(runtime);
    const existingFolder = runtime.seedDocument("Folder", {
      name: "Campaign Logs",
      type: "JournalEntry",
      flags: { anotherModule: { keep: true } },
    });
    const sessions = new FoundrySessionService(documents, {
      now: () => new Date("2026-08-29T13:00:00.000Z"),
      idFactory: () => "folder-session",
      journalFolderName: "Campaign Logs",
    });
    const started = unwrap(
      await sessions.start({
        title: "Folder-backed Session",
        purpose: "Preserve world-authored content",
        initialHtml: '<h2>Overview</h2><form action="evil"><p>Safe</p></form>',
        idempotencyKey: "folder-start-key",
      }),
    );
    expect(started.session.folderUuid).toBe(existingFolder.uuid);
    expect(started.page.html).toBe("<h2>Overview</h2><p>Safe</p>");
    const beforeAppend = unwrap(await documents.get({ uuid: started.journal.uuid }));
    const external = unwrap(
      await documents.update({
        uuid: started.journal.uuid,
        data: {
          content: "Unrelated human-authored content",
          flags: { anotherModule: { untouched: true } },
        },
        expectedHash: beforeAppend.sourceHash,
      }),
    );
    unwrap(
      await sessions.append({
        sessionId: started.session.sessionId,
        kind: "note",
        html: "New note",
        attribution: "GM",
        idempotencyKey: "folder-append-key",
      }),
    );
    expect(unwrap(await documents.get({ uuid: started.journal.uuid })).data).toMatchObject({
      content: "Unrelated human-authored content",
      flags: {
        anotherModule: { untouched: true },
        foundryMcp: { session: { sessionId: "folder-session" } },
      },
    });
    expect(external.document.data.flags).toHaveProperty("anotherModule.untouched", true);
  });

  it("sanitizes unsafe active content", () => {
    expect(
      sanitizeJournalHtml(
        '<style>body{display:none}</style><p onmouseover="x()"><a href="javascript:evil()">Safe text</a></p>',
      ),
    ).toBe('<p><a href="#" rel="noreferrer noopener">Safe text</a></p>');
  });
});
