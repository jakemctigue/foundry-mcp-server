import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { openDatabase, runMigrations } from "../src/db/index.js";
import { FakeHookEventBridge, FakeHooks } from "../src/fake-foundry/hooks.js";
import { startFakeFoundryWsServer } from "../src/fake-foundry/ws-server.js";
import { HostEventStream } from "../src/intelligence/event-stream.js";
import { getTimeline } from "../src/intelligence/queries.js";
import { assertAllowedWebSocketOrigin } from "../src/bridge/websocket-origin.js";

describe("mocked Foundry event stream", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it("emits configured generic/special hooks while private chat is off by default", () => {
    const hooks = new FakeHooks();
    const events: unknown[] = [];
    const bridge = new FakeHookEventBridge(hooks, {
      categories: ["document.*", "journal.*", "chat.*"],
      now: () => new Date("2026-08-29T12:00:00.000Z"),
      onEvent: (event) => events.push(event),
    });
    hooks.callAll("createDocument", {
      documentName: "Actor",
      toObject: () => ({ _id: "a", name: "Hero" }),
    });
    hooks.callAll("updateJournalEntry", {
      toObject: () => ({ _id: "j", name: "Notes" }),
    });
    hooks.callAll("createChatMessage", { content: "table talk" });
    hooks.callAll("createChatMessage", { whisper: ["gm"], content: "secret" });
    hooks.callAll("updateScene", { toObject: () => ({ _id: "s" }) });
    expect(events).toMatchObject([
      { sequenceId: 1, category: "document.create.Actor" },
      { sequenceId: 2, category: "journal.update.JournalEntry" },
      { sequenceId: 3, category: "chat.public.create" },
    ]);
    bridge.close();
  });

  it("acks, resumes, and deduplicates events across WebSocket reconnects", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    const stream = new HostEventStream(db);
    const server = await startFakeFoundryWsServer({
      eventStream: stream,
      connectionId: "world-a",
      allowedOrigins: ["http://foundry.test"],
    });
    cleanups.push(server.close);

    const connect = async (): Promise<{ socket: WebSocket; messages: unknown[] }> => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`, {
        origin: "http://foundry.test",
      });
      const messages: unknown[] = [];
      socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as unknown));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      cleanups.push(() => socket.terminate());
      return { socket, messages };
    };
    const first = await connect();
    first.socket.send(
      JSON.stringify({
        type: "event",
        connectionId: "world-a",
        envelope: {
          sequenceId: 1,
          category: "scene.update",
          payload: { uuid: "Scene.s" },
          emittedAt: "2026-08-29T12:00:00.000Z",
        },
      }),
    );
    await vi.waitFor(() =>
      expect(first.messages).toContainEqual({
        type: "event.ack",
        connectionId: "world-a",
        acknowledgedSequenceId: 1,
        nextSequenceId: 2,
      }),
    );
    first.socket.close();

    const second = await connect();
    await vi.waitFor(() =>
      expect(second.messages).toContainEqual({
        type: "events.resume",
        connectionId: "world-a",
        nextSequenceId: 2,
      }),
    );
    second.socket.send(
      JSON.stringify({
        type: "event",
        connectionId: "world-a",
        envelope: {
          sequenceId: 1,
          category: "scene.update",
          payload: { duplicate: true },
          emittedAt: "2026-08-29T12:00:00.000Z",
        },
      }),
    );
    await vi.waitFor(() =>
      expect(getTimeline(db, { connectionId: "world-a" }).events).toHaveLength(1),
    );
    second.socket.close();
  });

  it("rejects wildcard and non-exact Origin policy", () => {
    expect(() => assertAllowedWebSocketOrigin("http://foundry.test", ["*"])).toThrow(
      "wildcard",
    );
    expect(() =>
      assertAllowedWebSocketOrigin("http://evil.test", ["http://foundry.test"]),
    ).toThrow("not allowed");
    expect(assertAllowedWebSocketOrigin("https://foundry.test", ["https://foundry.test"])).toBe(
      "https://foundry.test",
    );
  });
});
