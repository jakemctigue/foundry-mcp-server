import { z } from "zod";

import { JsonValueSchema } from "./document.js";
import { FoundryUserRoleSchema } from "./authorization.js";
import { BRIDGE_PROTOCOL_VERSION } from "./version.js";

export const CompanionHelloMessageSchema = z
  .object({
    type: z.literal("hello"),
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    connectionId: z.string().trim().min(1).max(512),
    worldId: z.string().trim().min(1).max(512),
    worldTitle: z.string().trim().min(1).max(512),
    foundryVersion: z.string().trim().min(1).max(100).optional(),
    foundryUserRole: FoundryUserRoleSchema,
  })
  .strict();
export type CompanionHelloMessage = z.infer<typeof CompanionHelloMessageSchema>;

export const EventEnvelopeSchema = z
  .object({
    sequenceId: z.number().int().safe().positive(),
    category: z.string().trim().min(1).max(512),
    payload: JsonValueSchema,
    emittedAt: z.iso.datetime({ offset: true }),
    sessionId: z.string().trim().min(1).max(512).optional(),
    worldId: z.string().trim().min(1).max(512).optional(),
    privateContent: z.boolean().default(false),
  })
  .strict();
export interface EventEnvelope {
  sequenceId: number;
  category: string;
  payload: unknown;
  emittedAt: string;
  sessionId?: string | undefined;
  worldId?: string | undefined;
  privateContent?: boolean | undefined;
}

export const EventResumeMessageSchema = z
  .object({
    type: z.literal("events.resume"),
    connectionId: z.string().trim().min(1).max(512),
    nextSequenceId: z.number().int().safe().positive(),
  })
  .strict();
export type EventResumeMessage = z.infer<typeof EventResumeMessageSchema>;

export const EventPublishMessageSchema = z
  .object({
    type: z.literal("event"),
    connectionId: z.string().trim().min(1).max(512),
    envelope: EventEnvelopeSchema,
  })
  .strict();
export type EventPublishMessage = z.infer<typeof EventPublishMessageSchema>;

export const EventAckMessageSchema = z
  .object({
    type: z.literal("event.ack"),
    connectionId: z.string().trim().min(1).max(512),
    acknowledgedSequenceId: z.number().int().safe().nonnegative(),
    nextSequenceId: z.number().int().safe().positive(),
  })
  .strict();
export type EventAckMessage = z.infer<typeof EventAckMessageSchema>;

export const CompanionRequestMessageSchema = z
  .object({
    type: z.literal("request"),
    id: z.string().trim().min(1).max(512),
    method: z.string().trim().min(1).max(512),
    params: z.record(z.string(), JsonValueSchema).default({}),
  })
  .strict();
export type CompanionRequestMessage = z.infer<typeof CompanionRequestMessageSchema>;

export const CompanionResponseMessageSchema = z
  .object({
    type: z.literal("response"),
    id: z.string().trim().min(1).max(512),
    ok: z.boolean(),
    value: JsonValueSchema.optional(),
    error: JsonValueSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ok && value.value === undefined) {
      context.addIssue({ code: "custom", message: "successful responses require value" });
    }
    if (!value.ok && value.error === undefined) {
      context.addIssue({ code: "custom", message: "failed responses require error" });
    }
  });
export type CompanionResponseMessage = z.infer<typeof CompanionResponseMessageSchema>;

export const CompanionWireMessageSchema = z.discriminatedUnion("type", [
  CompanionHelloMessageSchema,
  EventResumeMessageSchema,
  EventPublishMessageSchema,
  EventAckMessageSchema,
  CompanionRequestMessageSchema,
  CompanionResponseMessageSchema,
]);
export type CompanionWireMessage = z.infer<typeof CompanionWireMessageSchema>;
