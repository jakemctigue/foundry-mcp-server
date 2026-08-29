import type Database from "better-sqlite3";
import {
  EventPublishMessageSchema,
  type EventAckMessage,
  type EventResumeMessage,
} from "@foundry-mcp/protocol";

import {
  getEventResumePoint,
  ingestEventEnvelope,
  type EventCaptureOptions,
} from "./event-ledger.js";

/** Durable host-side event stream endpoint shared by real and fake transports. */
export class HostEventStream {
  constructor(
    readonly db: Database.Database,
    readonly capture: EventCaptureOptions = {},
  ) {}

  resume(connectionId: string): EventResumeMessage {
    const point = getEventResumePoint(this.db, connectionId);
    return { type: "events.resume", connectionId, nextSequenceId: point.nextSequenceId };
  }

  ingest(message: unknown): EventAckMessage {
    const parsed = EventPublishMessageSchema.parse(message);
    const result = ingestEventEnvelope(
      this.db,
      parsed.connectionId,
      parsed.envelope,
      this.capture,
    );
    return {
      type: "event.ack",
      connectionId: parsed.connectionId,
      acknowledgedSequenceId: result.acknowledgedSequenceId,
      nextSequenceId: result.nextSequenceId,
    };
  }
}
