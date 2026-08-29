import { describe, expect, it } from "vitest";

import {
  BRIDGE_PROTOCOL_VERSION,
  CompanionWireMessageSchema,
  EventEnvelopeSchema,
  IntelligenceChangedSinceInput,
  IntelligenceContextInput,
  companionAuthPayload,
  type CompanionHelloMessage,
} from "../src/index.js";

describe("event and intelligence protocol schemas", () => {
  it("validates the shared ordered event envelope and rejects non-JSON payloads", () => {
    expect(
      EventEnvelopeSchema.parse({
        sequenceId: 1,
        category: "document.create.Actor",
        payload: { uuid: "Actor.a" },
        emittedAt: "2026-08-29T12:00:00.000Z",
      }),
    ).toMatchObject({ sequenceId: 1, privateContent: false });
    expect(
      EventEnvelopeSchema.safeParse({
        sequenceId: 0,
        category: "document.create.Actor",
        payload: {},
        emittedAt: "not-a-timestamp",
      }).success,
    ).toBe(false);
    expect(
      EventEnvelopeSchema.safeParse({
        sequenceId: 1,
        category: "document.create.Actor",
        payload: { bad: undefined },
        emittedAt: "2026-08-29T12:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("shares resume, ack, and request-response wire validation", () => {
    expect(
      CompanionWireMessageSchema.safeParse({
        type: "event.ack",
        connectionId: "world-a",
        acknowledgedSequenceId: 4,
        nextSequenceId: 5,
      }).success,
    ).toBe(true);
    expect(
      CompanionWireMessageSchema.safeParse({
        type: "response",
        id: "request-1",
        ok: false,
      }).success,
    ).toBe(false);
  });

  it("validates challenge proofs and canonicalizes every asserted hello identity field", () => {
    const challenge = "A".repeat(43);
    const hello: CompanionHelloMessage = {
      type: "hello" as const,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      connectionId: "world-a:user-a",
      worldId: "world-a",
      worldTitle: "Alpha",
      foundryVersion: "14.0",
      foundryUserRole: "GAMEMASTER" as const,
      currentUser: { id: "user-a", name: "Game Master", role: "GAMEMASTER" as const },
      system: { id: "dnd5e", version: "5.1.0" },
      activeModules: [{ id: "foundry-mcp", version: "0.1.0" }],
      moduleCapabilities: ["documents.read", "documents.write"],
    };
    expect(
      CompanionWireMessageSchema.safeParse({
        type: "auth.challenge",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        challenge,
        origin: "https://foundry.test",
      }).success,
    ).toBe(true);
    expect(
      CompanionWireMessageSchema.safeParse({
        type: "auth.proof",
        hello,
        proof: "B".repeat(43),
      }).success,
    ).toBe(true);
    expect(
      CompanionWireMessageSchema.safeParse({
        type: "auth.ready",
        connectionId: hello.connectionId,
        proof: "C".repeat(43),
      }).success,
    ).toBe(true);
    const alphaPayload = companionAuthPayload(challenge, "https://foundry.test", hello);
    const betaPayload = companionAuthPayload(challenge, "https://other-foundry.test", hello);
    expect(alphaPayload).toContain("world-a:user-a");
    expect(alphaPayload).toContain("foundry-mcp-companion-auth-v3");
    expect(alphaPayload).not.toBe(betaPayload);
    expect(
      CompanionWireMessageSchema.safeParse({
        type: "auth.proof",
        hello: {
          ...hello,
          currentUser: { ...hello.currentUser, role: "ASSISTANT" },
        },
        proof: "B".repeat(43),
      }).success,
    ).toBe(false);
    expect(companionAuthPayload(challenge, "https://foundry.test", hello)).not.toBe(
      companionAuthPayload(challenge, "https://foundry.test", {
        ...hello,
        activeModules: [{ id: "foundry-mcp", version: "0.2.0" }],
      }),
    );
    expect(() =>
      companionAuthPayload("not-canonical-base64url", "https://foundry.test", hello),
    ).toThrow();
    expect(() => companionAuthPayload(challenge, "https://foundry.test/path", hello)).toThrow();
  });

  it("requires exactly one changed-since cursor and bounds context packs", () => {
    expect(
      IntelligenceChangedSinceInput.safeParse({
        connectionId: "world-a",
        afterSequenceId: 0,
      }).success,
    ).toBe(true);
    expect(IntelligenceChangedSinceInput.safeParse({ connectionId: "world-a" }).success).toBe(
      false,
    );
    expect(
      IntelligenceContextInput.safeParse({ connectionId: "world-a", maxEvents: 101 }).success,
    ).toBe(false);
  });
});
