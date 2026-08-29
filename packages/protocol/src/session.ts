import { z } from "zod";

import { ConnectionSelector, DocumentView, JsonObjectSchema, MAX_PAGE_SIZE } from "./document.js";

export const SessionStatus = z.enum(["open", "ended"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionMetadata = z.object({
  sessionId: z.string().min(1),
  journalUuid: z.string().min(1),
  title: z.string().min(1),
  purpose: z.string().min(1),
  tags: z.array(z.string()),
  participants: z.array(z.string()),
  linkedUuids: z.array(z.string()),
  status: SessionStatus,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
  folderUuid: z.string().min(1).optional(),
  initialPageUuid: z.string().min(1).optional(),
});
export type SessionMetadata = z.infer<typeof SessionMetadata>;

export const SessionPage = z.object({
  uuid: z.string().min(1),
  timestamp: z.string().datetime(),
  kind: z.enum(["note", "observation", "decision", "todo", "summary", "link"]),
  attribution: z.string().min(1),
  html: z.string(),
  linkedUuids: z.array(z.string()),
  private: z.boolean(),
});
export type SessionPage = z.infer<typeof SessionPage>;

export const SessionsStartInput = ConnectionSelector.extend({
  title: z.string().min(1).max(200),
  purpose: z.string().min(1).max(2000),
  tags: z.array(z.string().min(1).max(100)).max(50).default([]),
  participants: z.array(z.string().min(1).max(200)).max(100).default([]),
  linkedUuids: z.array(z.string().min(1)).max(100).default([]),
  folder: z.string().min(1).nullable().optional(),
  folderName: z.string().min(1).max(200).optional(),
  initialHtml: z.string().min(1).max(100_000).optional(),
  idempotencyKey: z.string().min(8).max(200),
})
  .strict()
  .superRefine((input, context) => {
    if (input.folder !== undefined && input.folderName !== undefined) {
      context.addIssue({
        code: "custom",
        message: "folder and folderName are mutually exclusive",
        path: ["folderName"],
      });
    }
  });
export type SessionsStartInput = z.infer<typeof SessionsStartInput>;

export const SessionsStartOutput = z.object({
  session: SessionMetadata,
  journal: DocumentView,
  page: SessionPage,
});
export type SessionsStartOutput = z.infer<typeof SessionsStartOutput>;

export const SessionsAppendInput = ConnectionSelector.extend({
  sessionId: z.string().min(1),
  kind: SessionPage.shape.kind,
  html: z.string().min(1).max(100_000),
  attribution: z.string().min(1).max(200),
  linkedUuids: z.array(z.string().min(1)).max(100).default([]),
  private: z.boolean().default(false),
  idempotencyKey: z.string().min(8).max(200),
}).strict();
export type SessionsAppendInput = z.infer<typeof SessionsAppendInput>;

export const SessionsAppendOutput = z.object({ session: SessionMetadata, page: SessionPage });
export type SessionsAppendOutput = z.infer<typeof SessionsAppendOutput>;

/**
 * An opaque, request-bound keyset cursor. Clients must pass this value back
 * unchanged and must not derive offsets or ordering keys from it. `v1.0` is
 * retained only as a safe legacy alias for the beginning of a result set;
 * non-zero legacy offsets are intentionally rejected because concurrent
 * changes can make them skip or duplicate records.
 */
export const SessionCursor = z
  .string()
  .min(1)
  .max(4096)
  .regex(
    /^(?:v1\.0|sc1\.[A-Za-z0-9_-]+\.[0-9a-f]{8})$/,
    "Session cursor must be an opaque cursor returned by this server",
  );
export type SessionCursor = z.infer<typeof SessionCursor>;

export const SessionsListInput = ConnectionSelector.extend({
  status: SessionStatus.optional(),
  query: z.string().min(1).max(200).optional(),
  cursor: SessionCursor.optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
}).strict();
export type SessionsListInput = z.infer<typeof SessionsListInput>;

export const SessionsListOutput = z.object({
  sessions: z.array(SessionMetadata),
  nextCursor: SessionCursor.optional(),
});
export type SessionsListOutput = z.infer<typeof SessionsListOutput>;

export const SessionsGetInput = ConnectionSelector.extend({
  sessionId: z.string().min(1),
  cursor: SessionCursor.optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
}).strict();
export type SessionsGetInput = z.infer<typeof SessionsGetInput>;

export const SessionsGetOutput = z.object({
  session: SessionMetadata,
  pages: z.array(SessionPage),
  nextCursor: SessionCursor.optional(),
});
export type SessionsGetOutput = z.infer<typeof SessionsGetOutput>;

export const SessionsStatusInput = ConnectionSelector.extend({
  sessionId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(200),
}).strict();
export type SessionsStatusInput = z.infer<typeof SessionsStatusInput>;

export const SessionsStatusOutput = z.object({
  session: SessionMetadata,
  journalData: JsonObjectSchema,
});
export type SessionsStatusOutput = z.infer<typeof SessionsStatusOutput>;
