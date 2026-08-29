import { z } from "zod";

import { JsonValueSchema } from "./document.js";

export const IntelligenceEvent = z
  .object({
    id: z.number().int().positive(),
    connectionId: z.string().min(1),
    sequenceId: z.number().int().safe().positive(),
    category: z.string().min(1),
    payload: JsonValueSchema,
    emittedAt: z.iso.datetime({ offset: true }),
    receivedAt: z.iso.datetime({ offset: true }),
    sessionId: z.string().min(1).optional(),
    worldId: z.string().min(1).optional(),
  })
  .strict();
export type IntelligenceEvent = z.infer<typeof IntelligenceEvent>;

export const IntelligenceSearchInput = z
  .object({
    connectionId: z.string().min(1),
    query: z.string().trim().min(1).max(4_096),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export const IntelligenceSearchOutput = z.object({
  results: z.array(IntelligenceEvent.extend({ score: z.number().nonnegative() })),
});

export const IntelligenceTimelineInput = z
  .object({
    connectionId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    worldId: z.string().min(1).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().min(1).max(4_096).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export const IntelligenceTimelineOutput = z.object({
  events: z.array(IntelligenceEvent),
  nextCursor: z.string().min(1).optional(),
});

export const IntelligenceChangedSinceInput = z
  .object({
    connectionId: z.string().min(1),
    afterSequenceId: z.number().int().safe().nonnegative().optional(),
    afterTimestamp: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().min(1).max(4_096).optional(),
    limit: z.number().int().min(1).max(100).default(100),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.afterSequenceId === undefined) === (value.afterTimestamp === undefined)) {
      context.addIssue({
        code: "custom",
        message: "provide exactly one of afterSequenceId or afterTimestamp",
      });
    }
  });
export const IntelligenceChangedSinceOutput = z.object({
  events: z.array(IntelligenceEvent),
  nextCursor: z.string().min(1).optional(),
});

export const IntelligenceContextInput = z
  .object({
    connectionId: z.string().min(1),
    query: z.string().trim().min(1).max(4_096).optional(),
    afterSequenceId: z.number().int().safe().nonnegative().optional(),
    afterTimestamp: z.iso.datetime({ offset: true }).optional(),
    sessionId: z.string().min(1).optional(),
    worldId: z.string().min(1).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    maxEvents: z.number().int().min(1).max(100).default(25),
    maxBytes: z.number().int().min(1_024).max(512 * 1_024).default(64 * 1_024),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.afterSequenceId !== undefined && value.afterTimestamp !== undefined) {
      context.addIssue({
        code: "custom",
        message: "afterSequenceId and afterTimestamp are mutually exclusive",
      });
    }
  });

export const IntelligenceContextOutput = z
  .object({
    version: z.literal(1),
    connectionId: z.string().min(1),
    generatedAt: z.iso.datetime({ offset: true }),
    source: z.enum(["search", "changed-since", "timeline"]),
    events: z.array(IntelligenceEvent),
    sourceEventIds: z.array(z.number().int().positive()),
    truncated: z.boolean(),
    limits: z.object({ maxEvents: z.number().int().positive(), maxBytes: z.number().int().positive() }),
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

export type IntelligenceSearchInput = z.infer<typeof IntelligenceSearchInput>;
export type IntelligenceSearchOutput = z.infer<typeof IntelligenceSearchOutput>;
export type IntelligenceTimelineInput = z.infer<typeof IntelligenceTimelineInput>;
export type IntelligenceTimelineOutput = z.infer<typeof IntelligenceTimelineOutput>;
export type IntelligenceChangedSinceInput = z.infer<typeof IntelligenceChangedSinceInput>;
export type IntelligenceChangedSinceOutput = z.infer<typeof IntelligenceChangedSinceOutput>;
export type IntelligenceContextInput = z.infer<typeof IntelligenceContextInput>;
export type IntelligenceContextOutput = z.infer<typeof IntelligenceContextOutput>;
