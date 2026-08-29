import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  BRIDGE_PROTOCOL_VERSION,
  companionAuthReadyPayload,
  type CompanionHelloMessage,
  type JsonValue,
} from "@foundry-mcp/protocol";
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
  readonly listeners = new Map<string, Array<(event?: { data: unknown }) => unknown>>();

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
    callbacks.push(listener as (event?: { data: unknown }) => unknown);
    this.listeners.set(type, callbacks);
  }
  emit(type: "open" | "close"): void;
  emit(type: "message", data: unknown): void;
  emit(type: "open" | "close" | "message", data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(type === "message" ? { data: JSON.stringify(data) } : undefined);
    }
  }
  async emitMessage(data: unknown): Promise<void> {
    for (const listener of this.listeners.get("message") ?? []) {
      await listener({ data: JSON.stringify(data) });
    }
  }
}

const PAIRING_SECRET = new Uint8Array(32).fill(7);
const AUTH_CHALLENGE = "A".repeat(43);

function companionHello(connectionId = "world-a"): CompanionHelloMessage {
  return {
    type: "hello",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    connectionId,
    worldId: connectionId,
    worldTitle: "Test World",
    foundryUserRole: "GAMEMASTER",
  };
}

function pairedOptions(connectionId = "world-a") {
  return {
    connectionId,
    pairingSecret: PAIRING_SECRET,
    hello: companionHello(connectionId),
  };
}

async function authenticate(socket: MockSocket, connectionId = "world-a"): Promise<void> {
  const hello = companionHello(connectionId);
  await socket.emitMessage({
    type: "auth.challenge",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    challenge: AUTH_CHALLENGE,
  });
  await vi.waitFor(() =>
    expect(socket.sent).toEqual([expect.objectContaining({ type: "auth.proof", hello })]),
  );
  await socket.emitMessage({
    type: "auth.ready",
    connectionId,
    proof: createHmac("sha256", PAIRING_SECRET)
      .update(companionAuthReadyPayload(AUTH_CHALLENGE, hello), "utf8")
      .digest("base64url"),
  });
  socket.sent.length = 0;
}

describe("browser companion (mocked Foundry global)", () => {
  it("replays only from the host resume point and keeps sequence state across restart", async () => {
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
      ...pairedOptions(),
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
    await authenticate(first);
    await first.emitMessage({
      type: "events.resume",
      connectionId: "world-a",
      nextSequenceId: 1,
    });
    expect(first.sent).toMatchObject([{ type: "event", envelope: { sequenceId: 1 } }]);
    await first.emitMessage({
      type: "event.ack",
      connectionId: "world-a",
      acknowledgedSequenceId: 1,
      nextSequenceId: 2,
    });

    const restarted = new CompanionBridgeClient({
      endpoint: "wss://bridge.test/foundry",
      allowedOrigins: ["https://foundry.test"],
      pageOrigin: "https://foundry.test",
      ...pairedOptions(),
      storage,
      createSocket: create,
      handleRequest: async () => null,
    });
    restarted.start();
    const second = sockets[1] as MockSocket;
    await authenticate(second);
    await second.emitMessage({
      type: "events.resume",
      connectionId: "world-a",
      nextSequenceId: 2,
    });
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
      ...pairedOptions(),
      storage,
      handleRequest: handler,
    };
    const first = new CompanionBridgeClient({ ...options, createSocket: () => firstSocket });
    first.start();
    await authenticate(firstSocket);
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
    await authenticate(secondSocket);
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
      ...pairedOptions(),
      storage: new MemoryStorage(),
      createSocket: () => socket,
      handleRequest: handler,
    });
    client.start();
    await authenticate(socket);
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

  it("advances to the durable host sequence and prunes stale pending events on resume", async () => {
    const storage = new MemoryStorage();
    const socket = new MockSocket();
    const client = new CompanionBridgeClient({
      endpoint: "ws://127.0.0.1:3210",
      allowedOrigins: ["http://localhost:30000"],
      pageOrigin: "http://localhost:30000",
      ...pairedOptions(),
      storage,
      createSocket: () => socket,
      handleRequest: async () => null,
      maxPendingEvents: 2,
    });
    client.start();
    client.publish({
      category: "scene.update",
      payload: { stale: 1 },
      emittedAt: "2026-08-29T12:00:00.000Z",
    });
    client.publish({
      category: "scene.update",
      payload: { stale: 2 },
      emittedAt: "2026-08-29T12:00:01.000Z",
    });
    await authenticate(socket);
    await socket.emitMessage({
      type: "events.resume",
      connectionId: "world-a",
      nextSequenceId: 101,
    });

    expect(
      client.publish({
        category: "scene.update",
        payload: { current: true },
        emittedAt: "2026-08-29T12:00:02.000Z",
      }).sequenceId,
    ).toBe(101);
    expect(JSON.parse(storage.getItem("foundry-mcp:world-a:bridge-state") ?? "null")).toMatchObject(
      {
        nextSequenceId: 102,
        pendingEvents: [{ envelope: { sequenceId: 101 } }],
      },
    );
  });

  it("returns an indeterminate result after restart instead of replaying an in-flight mutation", async () => {
    const storage = new MemoryStorage();
    const firstSocket = new MockSocket();
    const sideEffect = vi.fn();
    const neverCompletes = new Promise<JsonValue>(() => undefined);
    const first = new CompanionBridgeClient({
      endpoint: "ws://127.0.0.1:3210",
      allowedOrigins: ["http://localhost:30000"],
      pageOrigin: "http://localhost:30000",
      ...pairedOptions(),
      storage,
      createSocket: () => firstSocket,
      handleRequest: () => {
        sideEffect();
        return neverCompletes;
      },
    });
    first.start();
    await authenticate(firstSocket);
    const request = {
      type: "request",
      id: "possibly-committed",
      method: "documents.create",
      params: { type: "Actor", data: { name: "Hero" } },
    };
    firstSocket.emit("message", request);
    await vi.waitFor(() => expect(sideEffect).toHaveBeenCalledOnce());

    const secondSocket = new MockSocket();
    const second = new CompanionBridgeClient({
      endpoint: "ws://127.0.0.1:3210",
      allowedOrigins: ["http://localhost:30000"],
      pageOrigin: "http://localhost:30000",
      ...pairedOptions(),
      storage,
      createSocket: () => secondSocket,
      handleRequest: async () => {
        sideEffect();
        return { created: true };
      },
    });
    second.start();
    await authenticate(secondSocket);
    secondSocket.emit("message", request);
    await vi.waitFor(() => expect(secondSocket.sent).toHaveLength(1));
    expect(sideEffect).toHaveBeenCalledOnce();
    expect(secondSocket.sent[0]).toMatchObject({
      id: "possibly-committed",
      ok: false,
      error: { code: "INDETERMINATE_MUTATION" },
    });
  });

  it("rejects host traffic until the reciprocal pairing proof is valid", async () => {
    const socket = new MockSocket();
    const handler = vi.fn(async () => ({ changed: true }));
    const client = new CompanionBridgeClient({
      endpoint: "ws://127.0.0.1:3210",
      allowedOrigins: ["http://localhost:30000"],
      pageOrigin: "http://localhost:30000",
      ...pairedOptions(),
      storage: new MemoryStorage(),
      createSocket: () => socket,
      handleRequest: handler,
    });
    client.start();
    await socket.emitMessage({
      type: "auth.challenge",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      challenge: AUTH_CHALLENGE,
    });
    await socket.emitMessage({
      type: "auth.ready",
      connectionId: "world-a",
      proof: "Z".repeat(43),
    });
    expect(socket.readyState).toBe(3);
    expect(handler).not.toHaveBeenCalled();
  });

  it("serializes back-to-back auth-ready and resume frames", async () => {
    const socket = new MockSocket();
    const hello = companionHello();
    const client = new CompanionBridgeClient({
      endpoint: "ws://127.0.0.1:3210",
      allowedOrigins: ["http://localhost:30000"],
      pageOrigin: "http://localhost:30000",
      ...pairedOptions(),
      storage: new MemoryStorage(),
      createSocket: () => socket,
      handleRequest: async () => null,
    });
    client.start();
    client.publish({
      category: "scene.update",
      payload: { uuid: "Scene.a" },
      emittedAt: "2026-08-29T12:00:00.000Z",
    });
    socket.emit("message", {
      type: "auth.challenge",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      challenge: AUTH_CHALLENGE,
    });
    await vi.waitFor(() =>
      expect(socket.sent).toEqual([expect.objectContaining({ type: "auth.proof", hello })]),
    );
    socket.sent.length = 0;

    socket.emit("message", {
      type: "auth.ready",
      connectionId: "world-a",
      proof: createHmac("sha256", PAIRING_SECRET)
        .update(companionAuthReadyPayload(AUTH_CHALLENGE, hello), "utf8")
        .digest("base64url"),
    });
    socket.emit("message", {
      type: "events.resume",
      connectionId: "world-a",
      nextSequenceId: 1,
    });

    await vi.waitFor(() =>
      expect(socket.sent).toMatchObject([{ type: "event", envelope: { sequenceId: 1 } }]),
    );
    expect(socket.readyState).toBe(1);
  });

  it("captures public-safe metadata and excludes restricted documents and private chat by default", () => {
    const callbacks = new Map<string, (...args: unknown[]) => void>();
    const hooks = {
      on: (event: string, callback: (...args: unknown[]) => void) => callbacks.set(event, callback),
      off: (event: string) => callbacks.delete(event),
    };
    const published: Array<{ category: string; payload: unknown }> = [];
    const bridge = new FoundryEventHooks(hooks, {
      documentTypes: ["Actor", "Item", "JournalEntry", "Scene", "Combat", "ChatMessage"],
      publish: (event) => published.push(event),
      now: () => new Date("2026-08-29T12:00:00.000Z"),
    });
    callbacks.get("createActor")?.({
      uuid: "Actor.a",
      name: "Public Hero",
      ownership: { default: 2 },
      toObject: () => ({ _id: "a", biography: "not copied by default" }),
    });
    callbacks.get("updateJournalEntry")?.(
      {
        uuid: "JournalEntry.j",
        name: "Public Notes",
        ownership: { default: 2 },
        toObject: () => ({ _id: "j", content: "not copied by default" }),
      },
      { name: "New", content: "changed private-shaped value" },
    );
    callbacks.get("createActor")?.({
      ownership: { default: 0 },
      toObject: () => ({ _id: "hidden-a", biography: "hidden actor content" }),
    });
    callbacks.get("createItem")?.({
      ownership: { default: 0 },
      toObject: () => ({ _id: "hidden-i", description: "hidden item content" }),
    });
    callbacks.get("updateJournalEntry")?.({
      ownership: { default: 0 },
      toObject: () => ({ _id: "hidden-j", content: "hidden journal content" }),
    });
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
    expect(JSON.stringify(published)).not.toContain("not copied by default");
    expect(JSON.stringify(published)).not.toContain("changed private-shaped value");
    expect(JSON.stringify(published)).not.toContain("hidden actor content");
    expect(JSON.stringify(published)).not.toContain("hidden item content");
    expect(JSON.stringify(published)).not.toContain("hidden journal content");
    expect(published[0]?.payload).toEqual({
      document: { documentType: "Actor", uuid: "Actor.a", name: "Public Hero" },
      changedFields: [],
    });
    bridge.close();
    expect(callbacks.size).toBe(0);
  });

  it("captures restricted document content only with explicit private-content opt-in", () => {
    const callbacks = new Map<string, (...args: unknown[]) => void>();
    const published: Array<{ privateContent?: boolean | undefined; payload: unknown }> = [];
    const bridge = new FoundryEventHooks(
      {
        on: (event, callback) => callbacks.set(event, callback),
        off: (event) => callbacks.delete(event),
      },
      {
        documentTypes: ["JournalEntry"],
        capturePrivateContent: true,
        publish: (event) => published.push(event),
      },
    );
    callbacks.get("updateJournalEntry")?.({
      ownership: { default: 0 },
      toObject: () => ({ _id: "private-j", content: "opted-in journal content" }),
    });
    expect(published).toHaveLength(1);
    expect(published[0]?.privateContent).toBe(true);
    expect(JSON.stringify(published[0]?.payload)).toContain("opted-in journal content");
    bridge.close();
  });

  it("requires strict ws/wss endpoints and exact page Origin allowlists", () => {
    expect(validateCompanionEndpoint("wss://bridge.test/socket")).toBe("wss://bridge.test/socket");
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
