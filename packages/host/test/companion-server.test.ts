import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  BRIDGE_PROTOCOL_VERSION,
  companionAuthPayload,
  companionAuthReadyPayload,
  type CompanionHelloMessage,
} from "@foundry-mcp/protocol";

import {
  startHostCompanionServer,
  type HostCompanionServer,
} from "../src/bridge/companion-server.js";
import { HostBridgeRouter } from "../src/bridge/router.js";
import { openDatabase, runMigrations } from "../src/db/index.js";
import { setCapabilityGrant } from "../src/security/policy.js";

const PAIRING_SECRET = Buffer.alloc(32, 7);

function hello(connectionId: string): CompanionHelloMessage {
  return {
    type: "hello",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    connectionId,
    worldId: connectionId,
    worldTitle: `${connectionId} World`,
    foundryVersion: "14.0",
    foundryUserRole: "GAMEMASTER",
  };
}

async function authenticate(socket: WebSocket, identity: CompanionHelloMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    let challenge: string | undefined;
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message["type"] === "auth.challenge" && typeof message["challenge"] === "string") {
        challenge = message["challenge"];
        socket.send(
          JSON.stringify({
            type: "auth.proof",
            hello: identity,
            proof: createHmac("sha256", PAIRING_SECRET)
              .update(companionAuthPayload(message["challenge"], identity), "utf8")
              .digest("base64url"),
          }),
        );
        return;
      }
      if (message["type"] === "auth.ready" && typeof message["proof"] === "string") {
        expect(message["connectionId"]).toBe(identity.connectionId);
        expect(message["proof"]).toBe(
          createHmac("sha256", PAIRING_SECRET)
            .update(companionAuthReadyPayload(challenge ?? "", identity), "utf8")
            .digest("base64url"),
        );
        ready = true;
        return;
      }
      if (message["type"] === "events.resume" && ready) {
        socket.off("message", onMessage);
        resolve();
      }
    };
    socket.on("message", onMessage);
    socket.once("error", reject);
  });
}

function waitForRequest(socket: WebSocket): Promise<{ id: string; method: string }> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as {
        type?: string;
        id?: string;
        method?: string;
      };
      if (message.type === "request" && message.id && message.method) {
        socket.off("message", onMessage);
        resolve({ id: message.id, method: message.method });
      }
    };
    socket.on("message", onMessage);
  });
}

describe("real browser companion host (mocked Foundry WebSocket)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it("routes companion requests, enforces policy, audits, and deduplicates request IDs", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    const server = await startHostCompanionServer({
      db,
      allowedOrigins: ["http://foundry.test"],
      requestTimeoutMs: 1_000,
      pairingSecret: PAIRING_SECRET,
    });
    cleanups.push(server.close);
    const socket = new WebSocket(server.address().endpoint, { origin: "http://foundry.test" });
    cleanups.push(() => socket.terminate());
    let requests = 0;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type?: string; id?: string };
      if (message.type !== "request" || !message.id) return;
      requests += 1;
      socket.send(
        JSON.stringify({
          type: "response",
          id: message.id,
          ok: true,
          value: {
            ok: true,
            value: {
              assetPath: "art/hero.png",
              source: "data",
              mimeType: "image/png",
              size: 100,
              collision: "created",
            },
          },
        }),
      );
    });
    await authenticate(socket, {
      ...hello("world-a"),
      worldId: "alpha",
      worldTitle: "Alpha World",
      foundryVersion: "13.351",
    });
    await vi.waitFor(() => expect(server.listConnections()).toHaveLength(1));
    const router = new HostBridgeRouter(db, server);
    expect(await router.dispatch("connections.list", {})).toMatchObject({
      connections: [{ connectionId: "world-a", worldTitle: "Alpha World" }],
    });

    const mutation = {
      method: "assets.images.upload",
      params: {
        connectionId: "world-a",
        source: { kind: "file", path: "C:\\api_key=never-log-this.png" },
      },
      authorization: {
        connectionId: "world-a",
        requestedCapability: "assets:upload",
        tool: "foundry.assets.images.upload",
        correlationId: "stable-request-1",
      },
    };
    await expect(router.dispatch("mutation.execute", mutation)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      missingCapability: "assets:upload",
    });
    expect(requests).toBe(0);
    setCapabilityGrant(
      db,
      {
        connectionId: "world-a",
        foundryUserRole: "GAMEMASTER",
        requestedCapability: "assets:upload",
      },
      true,
    );
    await expect(router.dispatch("mutation.execute", mutation)).resolves.toMatchObject({
      ok: true,
      value: { assetPath: "art/hero.png" },
    });
    await expect(router.dispatch("mutation.execute", mutation)).resolves.toMatchObject({
      ok: true,
      value: { assetPath: "art/hero.png" },
    });
    expect(requests).toBe(1);
    const audit = db
      .prepare("SELECT outcome, correlation_id, details_json FROM audit_log ORDER BY id")
      .all() as Array<{ outcome: string; correlation_id: string; details_json: string }>;
    expect(audit.map((row) => row.outcome)).toEqual(["denied", "success", "success"]);
    expect(audit.every((row) => row.correlation_id === "stable-request-1")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("never-log-this");
  });

  it("rejects direct mutation-method bypasses", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    const server = await startHostCompanionServer({
      db,
      allowedOrigins: ["http://foundry.test"],
      pairingSecret: PAIRING_SECRET,
    });
    cleanups.push(server.close);
    const router = new HostBridgeRouter(db, server);
    await expect(router.dispatch("documents.create", {})).resolves.toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    await expect(
      router.dispatch("intelligence.search", {
        connectionId: "world-a",
        query: "dragon",
        limit: 20,
      }),
    ).resolves.toEqual({ results: [] });
    await expect(
      router.dispatch("intelligence.timeline", { connectionId: "world-a", limit: 50 }),
    ).resolves.toEqual({ events: [] });
    await expect(
      router.dispatch("intelligence.changed-since", {
        connectionId: "world-a",
        afterSequenceId: 0,
        limit: 100,
      }),
    ).resolves.toEqual({ events: [] });
    await expect(
      router.dispatch("intelligence.context", {
        connectionId: "world-a",
        query: "dragon",
        maxEvents: 25,
        maxBytes: 65_536,
      }),
    ).resolves.toMatchObject({ source: "search", events: [] });
    await expect(router.dispatch("unknown.method", {})).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    await expect(
      router.dispatch("mutation.execute", {
        method: "documents.create",
        params: { connectionId: "world-a" },
        authorization: {
          connectionId: "world-a",
          requestedCapability: "assets:upload",
          tool: "foundry.documents.create",
          correlationId: "mismatch",
        },
      }),
    ).rejects.toThrow("capability mismatch");
  });

  it("requires a pairing proof before accepting a self-described companion identity", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    const server = await startHostCompanionServer({
      db,
      allowedOrigins: ["http://foundry.test"],
      pairingSecret: PAIRING_SECRET,
    });
    cleanups.push(server.close);
    const socket = new WebSocket(server.address().endpoint, { origin: "http://foundry.test" });
    cleanups.push(() => socket.terminate());
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.once("message", () => socket.send(JSON.stringify(hello("unproved-world"))));

    await closed;
    expect(server.listConnections()).toEqual([]);
  });

  it("rejects a companion proof made with a different pairing secret", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    const server = await startHostCompanionServer({
      db,
      allowedOrigins: ["http://foundry.test"],
      pairingSecret: PAIRING_SECRET,
    });
    cleanups.push(server.close);
    const socket = new WebSocket(server.address().endpoint, { origin: "http://foundry.test" });
    cleanups.push(() => socket.terminate());
    const identity = hello("wrong-secret-world");
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.once("message", (data) => {
      const challenge = (JSON.parse(data.toString()) as { challenge: string }).challenge;
      socket.send(
        JSON.stringify({
          type: "auth.proof",
          hello: identity,
          proof: createHmac("sha256", Buffer.alloc(32, 99))
            .update(companionAuthPayload(challenge, identity), "utf8")
            .digest("base64url"),
        }),
      );
    });

    await closed;
    expect(server.listConnections()).toEqual([]);
  });

  it("binds pending and completed request IDs to the authenticated connection", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    const server = await startHostCompanionServer({
      db,
      allowedOrigins: ["http://foundry.test"],
      requestTimeoutMs: 1_000,
      pairingSecret: PAIRING_SECRET,
    });
    cleanups.push(server.close);
    const socketA = new WebSocket(server.address().endpoint, { origin: "http://foundry.test" });
    const socketB = new WebSocket(server.address().endpoint, { origin: "http://foundry.test" });
    cleanups.push(() => socketA.terminate());
    cleanups.push(() => socketB.terminate());
    await Promise.all([
      authenticate(socketA, hello("world-a")),
      authenticate(socketB, hello("world-b")),
    ]);

    const requestOnA = waitForRequest(socketA);
    let settled = false;
    const resultA = server.request("world-a", "documents.get", {}, "shared-id").finally(() => {
      settled = true;
    });
    await requestOnA;
    socketB.send(JSON.stringify({ type: "response", id: "shared-id", ok: true, value: "wrong" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    socketA.send(JSON.stringify({ type: "response", id: "shared-id", ok: true, value: "right" }));
    await expect(resultA).resolves.toBe("right");

    const requestOnB = waitForRequest(socketB);
    const resultB = server.request("world-b", "documents.get", {}, "shared-id");
    await expect(requestOnB).resolves.toMatchObject({ id: "shared-id" });
    socketB.send(JSON.stringify({ type: "response", id: "shared-id", ok: true, value: "world-b" }));
    await expect(resultB).resolves.toBe("world-b");
  });

  it("requires upload as well as attach permission before an attachment can create an asset", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    const request = vi.fn(async () => ({ ok: true, value: { documentUuid: "Actor.a" } }));
    const companion: HostCompanionServer = {
      address: () => ({ host: "127.0.0.1", port: 1, endpoint: "ws://127.0.0.1:1" }),
      listConnections: () => [
        {
          ...hello("world-a"),
          status: "connected",
          lastSeenAt: "2026-08-29T12:00:00.000Z",
        },
      ],
      request,
      close: () => Promise.resolve(),
    };
    const router = new HostBridgeRouter(db, companion);
    const attachPolicy = {
      connectionId: "world-a",
      foundryUserRole: "GAMEMASTER" as const,
      requestedCapability: "assets:attach" as const,
    };
    setCapabilityGrant(db, attachPolicy, true);
    const mutation = {
      method: "assets.images.attach",
      params: {
        connectionId: "world-a",
        documentUuid: "Actor.a",
        fieldPath: "img",
        asset: {
          kind: "upload",
          sourceId: "data",
          destinationPath: "art/hero.png",
          onCollision: "error",
          source: { kind: "base64", data: "AA==", mimeType: "image/png" },
        },
      },
      authorization: {
        connectionId: "world-a",
        requestedCapability: "assets:attach",
        tool: "foundry.assets.images.attach",
        correlationId: "compound-attach",
      },
    };
    await expect(router.dispatch("mutation.execute", mutation)).rejects.toMatchObject({
      missingCapability: "assets:upload",
    });
    expect(request).not.toHaveBeenCalled();

    setCapabilityGrant(db, { ...attachPolicy, requestedCapability: "assets:upload" }, true);
    await expect(router.dispatch("mutation.execute", mutation)).resolves.toMatchObject({
      ok: true,
    });
    expect(request).toHaveBeenCalledOnce();
    expect(
      db
        .prepare("SELECT outcome FROM audit_log WHERE correlation_id = ? ORDER BY id")
        .all("compound-attach"),
    ).toEqual([{ outcome: "denied" }, { outcome: "success" }]);
  });
});
