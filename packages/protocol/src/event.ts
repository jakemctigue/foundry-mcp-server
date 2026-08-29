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

const CompanionAuthValueSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const CompanionOriginSchema = z
  .string()
  .max(2_048)
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return (
          (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value
        );
      } catch {
        return false;
      }
    },
    { message: "companion Origin must be an exact http(s) origin" },
  );

export const CompanionAuthChallengeMessageSchema = z
  .object({
    type: z.literal("auth.challenge"),
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    challenge: CompanionAuthValueSchema,
    origin: CompanionOriginSchema,
  })
  .strict();
export type CompanionAuthChallengeMessage = z.infer<typeof CompanionAuthChallengeMessageSchema>;

export const CompanionAuthProofMessageSchema = z
  .object({
    type: z.literal("auth.proof"),
    hello: CompanionHelloMessageSchema,
    proof: CompanionAuthValueSchema,
  })
  .strict();
export type CompanionAuthProofMessage = z.infer<typeof CompanionAuthProofMessageSchema>;

export const CompanionAuthReadyMessageSchema = z
  .object({
    type: z.literal("auth.ready"),
    connectionId: z.string().trim().min(1).max(512),
    proof: CompanionAuthValueSchema,
  })
  .strict();
export type CompanionAuthReadyMessage = z.infer<typeof CompanionAuthReadyMessageSchema>;

/** Stable, domain-separated payload authenticated by the companion pairing secret. */
export function companionAuthPayload(
  challenge: string,
  origin: string,
  hello: CompanionHelloMessage,
): string {
  const parsedChallenge = CompanionAuthValueSchema.parse(challenge);
  const parsedOrigin = CompanionOriginSchema.parse(origin);
  const parsedHello = CompanionHelloMessageSchema.parse(hello);
  return JSON.stringify([
    "foundry-mcp-companion-auth-v2",
    parsedChallenge,
    parsedOrigin,
    parsedHello.protocolVersion,
    parsedHello.connectionId,
    parsedHello.worldId,
    parsedHello.worldTitle,
    parsedHello.foundryVersion ?? "",
    parsedHello.foundryUserRole,
  ]);
}

/** Server proof binds the ready signal to the same challenge and authenticated identity. */
export function companionAuthReadyPayload(
  challenge: string,
  origin: string,
  hello: CompanionHelloMessage,
): string {
  return `${companionAuthPayload(challenge, origin, hello)}\nserver-ready`;
}

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
  CompanionAuthChallengeMessageSchema,
  CompanionAuthProofMessageSchema,
  CompanionAuthReadyMessageSchema,
  CompanionHelloMessageSchema,
  EventResumeMessageSchema,
  EventPublishMessageSchema,
  EventAckMessageSchema,
  CompanionRequestMessageSchema,
  CompanionResponseMessageSchema,
]);
export type CompanionWireMessage = z.infer<typeof CompanionWireMessageSchema>;
