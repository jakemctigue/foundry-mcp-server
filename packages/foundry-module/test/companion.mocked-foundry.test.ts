import { describe, expect, it, vi } from "vitest";

import type { JsonValue } from "@foundry-mcp/protocol";
import {
  CompanionBridgeClient,
  FoundryEventHooks,
  validateCompanionEndpoint,
  type CompanionSocket,
  type CompanionStorage,
} from "../src/index.js";

class MemoryStorage implements CompanionStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class MockSocket implements CompanionSocket {
  readyState = 1;
  readonly sent: unknown[] = [];
  readonly listeners = new Map<string, Array<(event?: { data: unknown }) => void>>();

  send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown);
  }
  close(): void {
    this.readyState = 3;
  }
  addEventListener(type: "open" | "close", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "open" | "close" | "message",
    listener: (() => void) | ((event: { data: unknown }) => void),
  ): void {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(listener as (event?: { data: unknown }) => void);
    this.listeners.set(type, callbacks);
  }
  emit(type: "open" | "close"): void;
  emit(type: "message", data: unknown): void;
  emit(type: "open" | "close" | "message", data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(type === "message" ? { data: JSON.stringify(data) } : undefined);
    }
  }
}

describe("browser companion (mocked Foundry global)", () => {
  it("replays only from the host resume point and keeps sequence state across restart", () => {
    const storage = new MemoryStorage();
    const sockets: MockSocket[] = [];
    const create = (): MockSocket => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    };
    const client = new CompanionBridgeClient({
      endpoint: "wss://bridge.test/foundry",
      allowedOrigins: ["https://foundry.test"],
      pageOrigin: "https://foundry.test",
      connectionId: "world-a",
      storage,
      createSocket: create,
      handleRequest: async () => null,
    });
    client.start();
    const first = sockets[0] as MockSocket;
    client.publish({
      category: "scene.update",
      payload: { uuid: "Scene.a" },
      emittedAt: "2026-08-29T12:00:00.000Z",
    });
    expect(first.sent).toEqual([]);
    first.emit("message", { type: "events.resume", connectionId: "world-a", nextSequenceId: 1 });
    expect(first.sent).toMatchObject([{ type: "event", envelope: { sequenceId: 1 } }]);
    first.emit("message", {
      type: "event.ack",
      connectionId: "world-a",
      acknowledgedSequenceId: 1,
      nextSequenceId: 2,
    });

    const restarted = new CompanionBridgeClient({
      endpoint: "wss://bridge.test/foundry",
      allowedOrigins: ["https://foundry.test"],
      pageOrigin: "https://foundry.test",
      connectionId: "world-a",
      storage,
      createSocket: create,
      handleRequest: async () => null,
    });
    restarted.start();
    const second = sockets[1] as MockSocket;
    second.emit("message", { type: "events.resume", connectionId: "world-a", nextSequenceId: 2 });
    expect(second.sent).toEqual([]);
    expect(
      restarted.publish({
        category: "combat.update",
        payload: { round: 2 },
        emittedAt: "2026-08-29T12:01:00.000Z",
      }).sequenceId,
    ).toBe(2);
  });

  it("persists completed request IDs so reconnect/restart does not duplicate side effects", async () => {
    const storage = new MemoryStorage();
    const firstSocket = new MockSocket();
    const handler = vi.fn(async (): Promise<JsonValue> => ({ created: "Actor.a" }));
    const options = {
      endpoint: "ws://127.0.0.1:3210",
      allowedOrigins: ["http://localhost:30000"],
      pageOrigin: "http://localhost:30000",
      connectionId: "world-a",
      storage,
      handleRequest: handler,
    };
    const first = new CompanionBridgeClient({ ...options, createSocket: () => firstSocket });
    first.start();
    firstSocket.emit("message", {
      type: "request",
      id: "mutation-1",
      method: "documents.create",
      params: { type: "Actor", data: { name: "Hero" } },
    });
    await vi.waitFor(() => expect(firstSocket.sent).toHaveLength(1));
    first.stop();

    const secondSocket = new MockSocket();
    const second = new CompanionBridgeClient({ ...options, createSocket: () => secondSocket });
    second.start();
    secondSocket.emit("message", {
      type: "request",
      id: "mutation-1",
      method: "documents.create",
      params: { type: "Actor", data: { name: "Hero" } },
    });
    await vi.waitFor(() => expect(secondSocket.sent).toHaveLength(1));
    expect(handler).toHaveBeenCalledOnce();
    expect(secondSocket.sent[0]).toMatchObject({ id: "mutation-1", ok: true });
  });

  it("coalesces duplicate pending request IDs before the first side effect completes", async () => {
    const socket = new MockSocket();
    let finish: ((value: JsonValue) => void) | undefined;
    const handler = vi.fn(
      () =>
        new Promise<JsonValue>((resolve) => {
          finish = resolve;
        }),
    );
    const client = new CompanionBridgeClient({
      endpoint: "ws://127.0.0.1:3210",
      allowedOrigins: ["http://localhost:30000"],
      pageOrigin: "http://localhost:30000",
      connectionId: "world-a",
      storage: new MemoryStorage(),
      createSocket: () => socket,
      handleRequest: handler,
    });
    client.start();
    const request = {
      type: "request",
      id: "pending-mutation",
      method: "documents.update",
      params: { uuid: "Actor.a" },
    };
    socket.emit("message", request);
    socket.emit("message", request);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    finish?.({ updated: "Actor.a" });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(socket.sent).toEqual([
      expect.objectContaining({ id: "pending-mutation", ok: true }),
      expect.objectContaining({ id: "pending-mutation", ok: true }),
    ]);
  });

  it("registers runtime document hooks and excludes private chat by default", () => {
    const callbacks = new Map<string, (...args: unknown[]) => void>();
    const hooks = {
      on: (event: string, callback: (...args: unknown[]) => void) => callbacks.set(event, callback),
      off: (event: string) => callbacks.delete(event),
    };
    const published: Array<{ category: string }> = [];
    const bridge = new FoundryEventHooks(hooks, {
      documentTypes: ["Actor", "JournalEntry", "Scene", "Combat", "ChatMessage"],
      publish: (event) => published.push(event),
      now: () => new Date("2026-08-29T12:00:00.000Z"),
    });
    callbacks.get("createActor")?.({ toObject: () => ({ _id: "a" }) });
    callbacks.get("updateJournalEntry")?.({ toObject: () => ({ _id: "j" }) }, { name: "New" });
    callbacks.get("updateScene")?.({ toObject: () => ({ _id: "s" }) });
    callbacks.get("updateCombat")?.({ toObject: () => ({ _id: "c" }) });
    callbacks.get("createChatMessage")?.({ content: "public" });
    callbacks.get("createChatMessage")?.({ whisper: ["gm"], content: "private" });
    expect(published.map((event) => event.category)).toEqual([
      "document.create.Actor",
      "journal.update.JournalEntry",
      "scene.update",
      "combat.update",
      "chat.public.create",
    ]);
    bridge.close();
    expect(callbacks.size).toBe(0);
  });

  it("requires strict ws/wss endpoints and exact page Origin allowlists", () => {
    expect(validateCompanionEndpoint("wss://bridge.test/socket")).toBe(
      "wss://bridge.test/socket",
    );
    expect(() => validateCompanionEndpoint("https://bridge.test/socket")).toThrow("ws://");
    expect(
      () =>
        new CompanionBridgeClient({
          endpoint: "wss://bridge.test/socket",
          allowedOrigins: ["*"],
          pageOrigin: "https://foundry.test",
          connectionId: "world-a",
          storage: new MemoryStorage(),
          createSocket: () => new MockSocket(),
          handleRequest: async () => null,
        }),
    ).toThrow("no wildcard");
  });
});
