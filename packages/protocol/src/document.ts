import { z } from "zod";

import { ErrorEnvelope } from "./error.js";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const MAX_BATCH_SIZE = 100;
export const MAX_EMBEDDED_DEPTH = 8;
export const MAX_SNAPSHOT_DEPTH = 12;
export const MAX_SNAPSHOT_BYTES = 2_000_000;
export const MAX_SNAPSHOT_ITEMS = 500;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;

export const ConnectionSelector = z.object({ connectionId: z.string().min(1).optional() }).strict();
export type ConnectionSelector = z.infer<typeof ConnectionSelector>;

export const DocumentPermissionCapability = z.object({
  readable: z.boolean(),
  creatable: z.boolean(),
  updatable: z.boolean(),
  reason: z.string().min(1).optional(),
});
export type DocumentPermissionCapability = z.infer<typeof DocumentPermissionCapability>;

export const DocumentSubtypeCapability = DocumentPermissionCapability.extend({
  subtype: z.string().min(1),
  label: z.string().min(1).optional(),
});
export type DocumentSubtypeCapability = z.infer<typeof DocumentSubtypeCapability>;

export const DocumentTypeCapability = DocumentPermissionCapability.extend({
  type: z.string().min(1),
  collection: z.string().min(1).optional(),
  embedded: z.boolean(),
  parentTypes: z.array(z.string().min(1)).default([]),
  schemaVersion: z.string().min(1).optional(),
  subtypes: z.array(DocumentSubtypeCapability).default([]),
});
export type DocumentTypeCapability = z.infer<typeof DocumentTypeCapability>;

export const DocumentsTypesInput = ConnectionSelector;
export type DocumentsTypesInput = z.infer<typeof DocumentsTypesInput>;

export const DocumentsTypesOutput = z.object({ types: z.array(DocumentTypeCapability) });
export type DocumentsTypesOutput = z.infer<typeof DocumentsTypesOutput>;

export const DocumentSort = z
  .object({
    field: z.enum(["id", "name"]).default("id"),
    direction: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();
export type DocumentSort = z.infer<typeof DocumentSort>;

export const DocumentsListInput = ConnectionSelector.extend({
  type: z.string().min(1),
  subtype: z.string().min(1).optional(),
  folder: z.string().min(1).nullable().optional(),
  nameFilter: z.string().min(1).max(200).optional(),
  fields: z.array(z.string().min(1).max(200)).max(100).optional(),
  cursor: z.string().min(1).max(4096).optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sort: DocumentSort.default({ field: "id", direction: "asc" }),
}).strict();
export type DocumentsListInput = z.infer<typeof DocumentsListInput>;

export const DocumentSummary = z.object({
  id: z.string().min(1),
  uuid: z.string().min(1),
  type: z.string().min(1),
  subtype: z.string().min(1).optional(),
  name: z.string().optional(),
  folder: z.string().nullable().optional(),
  parentUuid: z.string().min(1).optional(),
  packId: z.string().min(1).optional(),
  data: JsonObjectSchema.optional(),
  sourceHash: z.string().min(1),
  sourceVersion: z.union([z.string(), z.number()]),
});
export type DocumentSummary = z.infer<typeof DocumentSummary>;

export const DocumentsListOutput = z.object({
  items: z.array(DocumentSummary),
  nextCursor: z.string().min(1).optional(),
});
export type DocumentsListOutput = z.infer<typeof DocumentsListOutput>;

export const DocumentsGetInput = ConnectionSelector.extend({ uuid: z.string().min(1) }).strict();
export type DocumentsGetInput = z.infer<typeof DocumentsGetInput>;

export const DocumentView = DocumentSummary.extend({
  data: JsonObjectSchema,
  ownershipSummary: JsonObjectSchema,
  schemaVersion: z.string().min(1),
  parent: z
    .object({ uuid: z.string().min(1), type: z.string().min(1) })
    .strict()
    .optional(),
  pack: z
    .object({ id: z.string().min(1), label: z.string().optional(), locked: z.boolean() })
    .strict()
    .optional(),
});
export type DocumentView = z.infer<typeof DocumentView>;

export const DocumentsGetOutput = DocumentView;
export type DocumentsGetOutput = z.infer<typeof DocumentsGetOutput>;

export const DocumentCreateItem = z
  .object({
    type: z.string().min(1),
    data: JsonObjectSchema,
    parentUuid: z.string().min(1).optional(),
  })
  .strict();
export type DocumentCreateItem = z.infer<typeof DocumentCreateItem>;

const SingleDocumentCreateInput = ConnectionSelector.merge(DocumentCreateItem).extend({
  atomic: z.literal(false).optional(),
});
const BatchDocumentCreateInput = ConnectionSelector.extend({
  items: z.array(DocumentCreateItem).min(1).max(MAX_BATCH_SIZE),
  atomic: z.boolean().default(false),
}).strict();

export const DocumentsCreateInput = z.union([SingleDocumentCreateInput, BatchDocumentCreateInput]);
export type DocumentsCreateInput = z.infer<typeof DocumentsCreateInput>;

export const DocumentCreateResult = z.discriminatedUnion("status", [
  z.object({
    index: z.number().int().nonnegative(),
    status: z.literal("created"),
    document: DocumentView,
  }),
  z.object({
    index: z.number().int().nonnegative(),
    status: z.literal("error"),
    error: ErrorEnvelope,
  }),
  z.object({
    index: z.number().int().nonnegative(),
    status: z.literal("rolled_back"),
    error: ErrorEnvelope,
  }),
]);
export type DocumentCreateResult = z.infer<typeof DocumentCreateResult>;

export const DocumentsCreateOutput = z.object({
  atomic: z.boolean(),
  committed: z.boolean(),
  results: z.array(DocumentCreateResult),
});
export type DocumentsCreateOutput = z.infer<typeof DocumentsCreateOutput>;

export const DocumentsUpdateInput = ConnectionSelector.extend({
  uuid: z.string().min(1),
  data: JsonObjectSchema,
  expectedVersion: z.union([z.string(), z.number()]).optional(),
  expectedHash: z.string().min(1).optional(),
  forceOverwrite: z.boolean().default(false),
})
  .strict()
  .superRefine((input, context) => {
    if (
      !input.forceOverwrite &&
      input.expectedHash === undefined &&
      input.expectedVersion === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "expectedHash or expectedVersion is required unless forceOverwrite is true",
        path: ["expectedHash"],
      });
    }
  });
export type DocumentsUpdateInput = z.infer<typeof DocumentsUpdateInput>;

export const DocumentsUpdateOutput = z.object({
  uuid: z.string().min(1),
  sourceHash: z.string().min(1),
  sourceVersion: z.union([z.string(), z.number()]),
  forced: z.boolean(),
  document: DocumentView,
});
export type DocumentsUpdateOutput = z.infer<typeof DocumentsUpdateOutput>;

export const EmbeddedDocumentsListInput = ConnectionSelector.extend({
  parentUuid: z.string().min(1),
  embeddedType: z.string().min(1).optional(),
  recursive: z.boolean().default(false),
  maxDepth: z.number().int().min(1).max(MAX_EMBEDDED_DEPTH).default(1),
  cursor: z.string().min(1).max(4096).optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
}).strict();
export type EmbeddedDocumentsListInput = z.infer<typeof EmbeddedDocumentsListInput>;

export const EmbeddedDocumentSummary = DocumentSummary.extend({
  depth: z.number().int().positive(),
});
export type EmbeddedDocumentSummary = z.infer<typeof EmbeddedDocumentSummary>;

export const EmbeddedDocumentsListOutput = z.object({
  items: z.array(EmbeddedDocumentSummary),
  nextCursor: z.string().min(1).optional(),
  truncated: z.boolean(),
  truncationReason: z.string().min(1).optional(),
});
export type EmbeddedDocumentsListOutput = z.infer<typeof EmbeddedDocumentsListOutput>;

export const CompendiumsListInput = ConnectionSelector;
export type CompendiumsListInput = z.infer<typeof CompendiumsListInput>;

export const CompendiumSummary = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: z.string().min(1),
  documentCount: z.number().int().nonnegative(),
  locked: z.boolean(),
});
export type CompendiumSummary = z.infer<typeof CompendiumSummary>;

export const CompendiumsListOutput = z.object({ packs: z.array(CompendiumSummary) });
export type CompendiumsListOutput = z.infer<typeof CompendiumsListOutput>;

export const CompendiumDocumentsListInput = ConnectionSelector.extend({
  packId: z.string().min(1),
  hydrate: z.boolean().default(false),
  cursor: z.string().min(1).max(4096).optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sort: DocumentSort.default({ field: "id", direction: "asc" }),
}).strict();
export type CompendiumDocumentsListInput = z.infer<typeof CompendiumDocumentsListInput>;

export const CompendiumIndexEntry = z.object({
  id: z.string().min(1),
  uuid: z.string().min(1),
  name: z.string().optional(),
  type: z.string().min(1),
  subtype: z.string().min(1).optional(),
  img: z.string().optional(),
});
export type CompendiumIndexEntry = z.infer<typeof CompendiumIndexEntry>;

export const CompendiumDocumentsListOutput = z.object({
  packId: z.string().min(1),
  hydrated: z.boolean(),
  items: z.array(z.union([CompendiumIndexEntry, DocumentView])),
  nextCursor: z.string().min(1).optional(),
});
export type CompendiumDocumentsListOutput = z.infer<typeof CompendiumDocumentsListOutput>;

const SnapshotLimits = {
  maxDepth: z.number().int().min(1).max(MAX_SNAPSHOT_DEPTH).default(6),
  maxBytes: z.number().int().min(256).max(MAX_SNAPSHOT_BYTES).default(250_000),
  maxItems: z.number().int().min(1).max(MAX_SNAPSHOT_ITEMS).default(100),
  redactionPaths: z.array(z.string().min(1).max(500)).max(100).default([]),
};

const SnapshotByUuidInput = ConnectionSelector.extend({
  uuids: z.array(z.string().min(1)).min(1).max(MAX_SNAPSHOT_ITEMS),
  ...SnapshotLimits,
}).strict();

const SnapshotByQueryInput = ConnectionSelector.extend({
  query: DocumentsListInput.omit({ connectionId: true, cursor: true, pageSize: true }),
  ...SnapshotLimits,
}).strict();

export const DocumentsSnapshotInput = z.union([SnapshotByUuidInput, SnapshotByQueryInput]);
export type DocumentsSnapshotInput = z.infer<typeof DocumentsSnapshotInput>;

export const DocumentsSnapshotOutput = z.object({
  snapshot: z.array(JsonValueSchema),
  truncated: z.boolean(),
  truncationReasons: z.array(z.enum(["maxDepth", "maxBytes", "maxItems"])),
  redactedPaths: z.array(z.string()),
  itemCount: z.number().int().nonnegative(),
  byteCount: z.number().int().nonnegative(),
});
export type DocumentsSnapshotOutput = z.infer<typeof DocumentsSnapshotOutput>;

export type OperationResult<T> =
  { ok: true; value: T } | { ok: false; error: z.infer<typeof ErrorEnvelope> };
