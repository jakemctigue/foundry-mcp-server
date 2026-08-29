import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { FakeDocumentStore } from "../src/fake-foundry/documents.js";
import { FakeHooks } from "../src/fake-foundry/hooks.js";
import { startFakeFoundryWsServer } from "../src/fake-foundry/ws-server.js";

describe("fake Foundry runtime: documents", () => {
  it("creates documents with generated UUIDs and supports CRUD", () => {
    const store = new FakeDocumentStore();
    const created = store.create("Actor", { name: "Test NPC" });
    expect(created.uuid).toMatch(/^Actor\./);

    const read = store.read(created.uuid);
    expect(read?.data["name"]).toBe("Test NPC");

    const updated = store.update(created.uuid, { name: "Renamed NPC" });
    expect(updated?.data["name"]).toBe("Renamed NPC");

    expect(store.list("Actor").length).toBe(1);
  });

  it("fromUuid resolves created documents and returns undefined for unknown UUIDs", () => {
    const store = new FakeDocumentStore();
    const created = store.create("Item", { name: "Sword" });
    expect(store.fromUuid(created.uuid)?.uuid).toBe(created.uuid);
    expect(store.fromUuid("Item.does-not-exist")).toBeUndefined();
  });
});

describe("fake Foundry runtime: hooks", () => {
  it("subscribes and emits hook events", () => {
    const hooks = new FakeHooks();
    const calls: unknown[] = [];
    hooks.on("createActor", (...args) => calls.push(args));
    hooks.callAll("createActor", { name: "test" });
    expect(calls).toEqual([[{ name: "test" }]]);
  });

  it("off removes a listener", () => {
    const hooks = new FakeHooks();
    const calls: unknown[] = [];
    const cb = (): void => {
      calls.push(1);
    };
    hooks.on("updateActor", cb);
    hooks.off("updateActor", cb);
    hooks.callAll("updateActor");
    expect(calls.length).toBe(0);
  });
});

describe("fake Foundry runtime: WebSocket bridge", () => {
  it("accepts a client connection and round-trips a JSON message", async () => {
    const server = await startFakeFoundryWsServer();
    const { port } = server.address();

    server.onConnection((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        socket.send(JSON.stringify({ ack: msg["type"] }));
      });
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => client.once("open", resolve));

    const responsePromise = new Promise((resolve) => {
      client.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
    client.send(JSON.stringify({ type: "hello" }));

    const response = await responsePromise;
    expect(response).toEqual({ ack: "hello" });

    client.close();
    await server.close();
  });
});
