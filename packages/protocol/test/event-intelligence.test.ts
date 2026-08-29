import { describe, expect, it } from "vitest";

import {
  CompanionWireMessageSchema,
  EventEnvelopeSchema,
  IntelligenceChangedSinceInput,
  IntelligenceContextInput,
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

  it("requires exactly one changed-since cursor and bounds context packs", () => {
    expect(
      IntelligenceChangedSinceInput.safeParse({
        connectionId: "world-a",
        afterSequenceId: 0,
      }).success,
    ).toBe(true);
    expect(
      IntelligenceChangedSinceInput.safeParse({ connectionId: "world-a" }).success,
    ).toBe(false);
    expect(
      IntelligenceContextInput.safeParse({ connectionId: "world-a", maxEvents: 101 }).success,
    ).toBe(false);
  });
});
