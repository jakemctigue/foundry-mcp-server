import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type ClientOptions } from "ws";
import {
  BRIDGE_PROTOCOL_VERSION,
  companionAuthPayload,
  companionAuthReadyPayload,
  companionIdentityAuthPayload,
  companionIdentityConfirmPayload,
  type CompanionHelloMessage,
} from "@foundry-mcp/protocol";

import {
  companionRequestIdentityDigest,
  startHostCompanionServer,
  type HostCompanionServer,
} from "../src/bridge/companion-server.js";
import { HostBridgeRouter } from "../src/bridge/router.js";
import { openDatabase, runMigrations } from "../src/db/index.js";
import { setCapabilityGrant } from "../src/security/policy.js";

const PAIRING_SECRET = Buffer.alloc(32, 7);
const identityCredentials = new Map<string, Buffer>();

function hello(connectionId: string): CompanionHelloMessage {
  return {
    type: "hello",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    connectionId,
    worldId: connectionId,
    worldTitle: `${connectionId} World`,
    foundryVersion: "14.0",
    foundryUserRole: "GAMEMASTER",
    currentUser: { id: "gm-a", name: "Game Master", role: "GAMEMASTER" },
    system: { id: "dnd5e", version: "5.1.0" },
    activeModules: [{ id: "foundry-mcp", version: "0.1.0" }],
    moduleCapabilities: [
      "documents.read",
      "documents.write",
      "assets.read",
      "assets.write",
      "sessions.read",
      "sessions.write",
      "events.publish",
    ],
  };
}

async function authenticate(socket: WebSocket, identity: CompanionHelloMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    let challenge: string | undefined;
    let origin: string | undefined;
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message["type"] === "auth.challenge" && typeof message["challenge"] === "string") {
        challenge = message["challenge"];
        origin = message["origin"] as string;
        expect(origin).toBe("http://foundry.test");
        socket.send(
          JSON.stringify({
            type: "auth.proof",
            hello: identity,
            proof: createHmac("sha256", PAIRING_SECRET)
              .update(companionAuthPayload(message["challenge"], origin, identity), "utf8")
              .digest("base64url"),
            ...(identityCredentials.has(identity.connectionId)
              ? {
                  identityProof: createHmac(
                    "sha256",
                    identityCredentials.get(identity.connectionId) as Buffer,
                  )
                    .update(
                      companionIdentityAuthPayload(message["challenge"], origin, identity),
                      "utf8",
                    )
                    .digest("base64url"),
                }
              : {}),
          }),
        );
        return;
      }
      if (message["type"] === "auth.ready" && typeof message["proof"] === "string") {
        expect(message["connectionId"]).toBe(identity.connectionId);
        expect(message["proof"]).toBe(
          createHmac("sha256", PAIRING_SECRET)
            .update(companionAuthReadyPayload(challenge ?? "", origin ?? "", identity), "utf8")
            .digest("base64url"),
        );
        if (typeof message["identityCredential"] === "string") {
          const credential = Buffer.from(message["identityCredential"], "base64url");
          identityCredentials.set(identity.connectionId, credential);
          socket.send(
            JSON.stringify({
              type: "auth.confirm",
              connectionId: identity.connectionId,
              proof: createHmac("sha256", credential)
                .update(
                  companionIdentityConfirmPayload(challenge ?? "", origin ?? "", identity),
                  "utf8",
                )
                .digest("base64url"),
            }),
          );
        } else {
          expect(identityCredentials.has(identity.connectionId)).toBe(true);
        }
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

async function receiveUnconfirmedCredential(
  socket: WebSocket,
  identity: CompanionHelloMessage,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let challenge = "";
    let origin = "";
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message["type"] === "auth.challenge" && typeof message["challenge"] === "string") {
        challenge = message["challenge"];
        origin = message["origin"] as string;
        socket.send(
          JSON.stringify({
            type: "auth.proof",
            hello: identity,
            proof: createHmac("sha256", PAIRING_SECRET)
              .update(companionAuthPayload(challenge, origin, identity), "utf8")
              .digest("base64url"),
          }),
        );
        return;
      }
      if (
        message["type"] === "auth.ready" &&
        typeof message["proof"] === "string" &&
        typeof message["identityCredential"] === "string"
      ) {
        expect(message["proof"]).toBe(
          createHmac("sha256", PAIRING_SECRET)
            .update(companionAuthReadyPayload(challenge, origin, identity), "utf8")
            .digest("base64url"),
        );
        socket.off("message", onMessage);
        resolve(message["identityCredential"]);
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

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function expectUpgradeRejected(endpoint: string, options: ClientOptions): Promise<void> {
  const socket = new WebSocket(endpoint, options);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => reject(new Error("WebSocket upgrade unexpectedly succeeded")));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve();
    });
    socket.once("error", () => undefined);
  });
  socket.terminate();
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
      connections: [
        {
          connectionId: "world-a",
          worldTitle: "Alpha World",
          currentUser: { id: "gm-a", name: "Game Master", role: "GAMEMASTER" },
          system: { id: "dnd5e", version: "5.1.0" },
          activeModules: [{ id: "foundry-mcp", version: "0.1.0" }],
          moduleCapabilities: expect.arrayContaining([
            "documents.read",
            "assets.write",
            "sessions.write",
            "events.publish",
          ]),
        },
      ],
    });

    const mutation = {
      method: "assets.images.upload",
      params: {
        connectionId: "world-a",
        source: { kind: "base64", data: "api_key=never-log-this" },
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
      const challengeMessage = JSON.parse(data.toString()) as {
        challenge: string;
        origin: string;
      };
      socket.send(
        JSON.stringify({
          type: "auth.proof",
          hello: identity,
          proof: createHmac("sha256", Buffer.alloc(32, 99))
            .update(
              companionAuthPayload(challengeMessage.challenge, challengeMessage.origin, identity),
              "utf8",
            )
            .digest("base64url"),
        }),
      );
    });

    await closed;
    expect(server.listConnections()).toEqual([]);
  });

  it("keeps an authenticated assistant read-only even when a mutation grant is present", async () => {
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
    const baseIdentity = hello("assistant-world");
    const identity = {
      ...baseIdentity,
      foundryUserRole: "ASSISTANT" as const,
      currentUser: { ...baseIdentity.currentUser, role: "ASSISTANT" as const },
    };
    await authenticate(socket, identity);
    const request = vi.fn();
    socket.on("message", (data) => {
      if ((JSON.parse(data.toString()) as { type?: string }).type === "request") request();
    });
    setCapabilityGrant(
      db,
      {
        connectionId: identity.connectionId,
        foundryUserRole: "ASSISTANT",
        requestedCapability: "documents:create",
      },
      true,
    );
    const router = new HostBridgeRouter(db, server);

    await expect(
      router.dispatch("mutation.execute", {
        method: "documents.create",
        params: { connectionId: identity.connectionId, documentType: "Actor", items: [] },
        authorization: {
          connectionId: identity.connectionId,
          requestedCapability: "documents:create",
          tool: "foundry.documents.create",
          correlationId: "assistant-denied",
        },
      }),
    ).rejects.toMatchObject({ missingCapability: "documents:create" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects mismatched Origin and Host headers before WebSocket admission", async () => {
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

    await expectUpgradeRejected(server.address().endpoint, { origin: "http://other.test" });
    await expectUpgradeRejected(server.address().endpoint, {
      origin: "http://foundry.test",
      headers: { Host: "attacker.test" },
    });
    expect(server.listConnections()).toEqual([]);
  });

  it("rejects an Origin-bound proof replayed for another allowed Origin", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    const server = await startHostCompanionServer({
      db,
      allowedOrigins: ["http://foundry.test", "http://other.test"],
      pairingSecret: PAIRING_SECRET,
    });
    cleanups.push(server.close);
    const socket = new WebSocket(server.address().endpoint, { origin: "http://other.test" });
    cleanups.push(() => socket.terminate());
    const identity = hello("origin-replay-world");
    const closed = waitForClose(socket);
    socket.once("message", (data) => {
      const challenge = (JSON.parse(data.toString()) as { challenge: string }).challenge;
      socket.send(
        JSON.stringify({
          type: "auth.proof",
          hello: identity,
          proof: createHmac("sha256", PAIRING_SECRET)
            .update(companionAuthPayload(challenge, "http://foundry.test", identity), "utf8")
            .digest("base64url"),
        }),
      );
    });

    await expect(closed).resolves.toMatchObject({ code: 1008 });
    expect(server.listConnections()).toEqual([]);
  });

  it("expires unauthenticated sockets", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    const server = await startHostCompanionServer({
      db,
      allowedOrigins: ["http://foundry.test"],
      pairingSecret: PAIRING_SECRET,
      authenticationTimeoutMs: 25,
    });
    cleanups.push(server.close);
    const socket = new WebSocket(server.address().endpoint, { origin: "http://foundry.test" });
    cleanups.push(() => socket.terminate());

    await expect(waitForClose(socket)).resolves.toMatchObject({
      code: 1008,
      reason: "companion authentication timed out",
    });
  });

  it("closes connections that exceed the frame-size or message-rate limits", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    const oversizedServer = await startHostCompanionServer({
      db,
      allowedOrigins: ["http://foundry.test"],
      pairingSecret: PAIRING_SECRET,
      maxPayloadBytes: 1_024,
    });
    cleanups.push(oversizedServer.close);
    const oversizedSocket = new WebSocket(oversizedServer.address().endpoint, {
      origin: "http://foundry.test",
    });
    cleanups.push(() => oversizedSocket.terminate());
    await authenticate(oversizedSocket, hello("oversized-world"));
    const oversizedClosed = waitForClose(oversizedSocket);
    oversizedSocket.send(JSON.stringify({ type: "hello", padding: "x".repeat(2_048) }));
    await expect(oversizedClosed).resolves.toMatchObject({ code: 1009 });

    const rateServer = await startHostCompanionServer({
      db,
      allowedOrigins: ["http://foundry.test"],
      pairingSecret: PAIRING_SECRET,
      maxMessagesPerConnection: 1,
    });
    cleanups.push(rateServer.close);
    const rateSocket = new WebSocket(rateServer.address().endpoint, {
      origin: "http://foundry.test",
    });
    cleanups.push(() => rateSocket.terminate());
    await authenticate(rateSocket, hello("rate-world"));
    const rateClosed = waitForClose(rateSocket);
    rateSocket.send(JSON.stringify(hello("ignored-extra-message")));
    await expect(rateClosed).resolves.toMatchObject({
      code: 1008,
      reason: "companion message rate limit exceeded",
    });
  });

  it("enforces a global message-rate limit across authenticated connections", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    const server = await startHostCompanionServer({
      db,
      allowedOrigins: ["http://foundry.test"],
      pairingSecret: PAIRING_SECRET,
      maxMessagesPerConnection: 10,
      maxMessagesGlobal: 2,
    });
    cleanups.push(server.close);
    const socketA = new WebSocket(server.address().endpoint, { origin: "http://foundry.test" });
    cleanups.push(() => socketA.terminate());
    await authenticate(socketA, hello("global-a"));
    const socketB = new WebSocket(server.address().endpoint, { origin: "http://foundry.test" });
    cleanups.push(() => socketB.terminate());
    await authenticate(socketB, hello("global-b"));
    const closed = waitForClose(socketA);
    socketA.send(JSON.stringify(hello("ignored-global-message")));

    await expect(closed).resolves.toMatchObject({
      code: 1008,
      reason: "companion message rate limit exceeded",
    });
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
    await expect(
      server.request("world-a", "documents.get", { uuid: "Actor.other" }, "shared-id"),
    ).rejects.toMatchObject({ envelope: { code: "CONFLICT", retryable: false } });
    socketB.send(JSON.stringify({ type: "response", id: "shared-id", ok: true, value: "wrong" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    socketA.send(JSON.stringify({ type: "response", id: "shared-id", ok: true, value: "right" }));
    await expect(resultA).resolves.toBe("right");
    await expect(
      server.request("world-a", "documents.get", { uuid: "Actor.other" }, "shared-id"),
    ).rejects.toMatchObject({ envelope: { code: "CONFLICT", retryable: false } });

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

  it("maps host progress callbacks to the companion request option", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    const request: HostCompanionServer["request"] = async (
      _connectionId,
      _method,
      _params,
      _requestId,
      options,
    ) => {
      await options?.onProgress?.({
        stage: "progress",
        progress: 450,
        total: 1_000,
        message: "reading documents",
      });
      return { ok: true, value: { uuid: "Actor.a" } };
    };
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
    const reportProgress = vi.fn();

    await new HostBridgeRouter(db, companion).dispatch(
      "documents.get",
      { connectionId: "world-a", uuid: "Actor.a" },
      {
        signal: new AbortController().signal,
        deadline: Date.now() + 1_000,
        correlationId: "read-progress",
        reportProgress,
      },
    );

    expect(reportProgress).toHaveBeenCalledWith(
      expect.objectContaining({ progress: 450, message: "reading documents" }),
    );
  });

  it("returns a successful mutation result when cancellation arrives after commit", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    let completeMutation: ((value: { ok: true; value: { uuid: string } }) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<{ ok: true; value: { uuid: string } }>((resolve) => {
          completeMutation = resolve;
        }),
    );
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
    setCapabilityGrant(
      db,
      {
        connectionId: "world-a",
        foundryUserRole: "GAMEMASTER",
        requestedCapability: "documents:create",
      },
      true,
    );
    const router = new HostBridgeRouter(db, companion);
    const respond = vi.fn();
    router.handle(
      {
        id: "post-commit",
        method: "mutation.execute",
        params: {
          method: "documents.create",
          params: { connectionId: "world-a", documentType: "Actor", data: { name: "Hero" } },
          authorization: {
            connectionId: "world-a",
            requestedCapability: "documents:create",
            tool: "foundry.documents.create",
            correlationId: "post-commit",
          },
        },
        control: {
          deadline: Date.now() + 1_000,
          correlationId: "post-commit",
          progress: false,
        },
      },
      respond,
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    router.handle(
      {
        type: "request.cancel",
        id: "post-commit",
        correlationId: "post-commit",
        reason: "cancelled",
      },
      respond,
    );
    completeMutation?.({ ok: true, value: { uuid: "Actor.created" } });

    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith({
        id: "post-commit",
        result: { ok: true, value: { uuid: "Actor.created" } },
      }),
    );
  });

  it("forwards progress and correlated cancellation over a real WebSocket without retrying", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    const server = await startHostCompanionServer({
      db,
      allowedOrigins: ["http://foundry.test"],
      requestTimeoutMs: 2_000,
      pairingSecret: PAIRING_SECRET,
    });
    cleanups.push(server.close);
    const socket = new WebSocket(server.address().endpoint, { origin: "http://foundry.test" });
    cleanups.push(() => socket.terminate());
    await authenticate(socket, hello("world-cancel"));

    let requests = 0;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        type?: string;
        id?: string;
        reason?: string;
      };
      if (message.type === "request" && message.id === "cancel-op") {
        requests += 1;
        socket.send(
          JSON.stringify({
            type: "request.progress",
            id: message.id,
            progress: {
              stage: "progress",
              progress: 350,
              total: 1_000,
              message: "snapshot traversal",
            },
          }),
        );
      }
      if (message.type === "request.cancel" && message.id === "cancel-op") {
        socket.send(
          JSON.stringify({
            type: "response",
            id: message.id,
            ok: false,
            error: {
              code: message.reason === "timeout" ? "TIMEOUT" : "CANCELLED",
              message: "operation stopped",
              retryable: false,
            },
          }),
        );
      }
    });
    const progress = vi.fn();
    const controller = new AbortController();
    const result = server.request("world-cancel", "documents.snapshot", {}, "cancel-op", {
      signal: controller.signal,
      deadline: Date.now() + 1_000,
      correlationId: "mcp-cancel-op",
      onProgress: progress,
    });
    await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce());
    controller.abort();
    await expect(result).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    await expect(
      server.request("world-cancel", "documents.snapshot", {}, "cancel-op", {
        correlationId: "mcp-cancel-op",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ progress: 350, message: "snapshot traversal" }),
    );
    expect(requests).toBe(1);

    vi.useFakeTimers();
    try {
      const mutationController = new AbortController();
      const requestReceived = waitForRequest(socket);
      const mutation = server.request(
        "world-cancel",
        "documents.update",
        { uuid: "Actor.a", data: { name: "Possibly updated" } },
        "mutation-no-ack",
        {
          signal: mutationController.signal,
          correlationId: "mutation-no-ack",
        },
      );
      await requestReceived;
      mutationController.abort();
      const rejection = expect(mutation).rejects.toMatchObject({
        envelope: {
          code: "INDETERMINATE_MUTATION",
          retryable: false,
          details: { indeterminate: true, reconciliationRequired: true },
        },
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects pre-dispatch aborts and deadlines, then times out offline work", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    const server = await startHostCompanionServer({
      db,
      allowedOrigins: ["http://foundry.test"],
      requestTimeoutMs: 10,
      pairingSecret: PAIRING_SECRET,
    });
    cleanups.push(server.close);

    const controller = new AbortController();
    controller.abort("caller cancelled");
    await expect(
      server.request("offline-world", "documents.snapshot", {}, "already-cancelled", {
        signal: controller.signal,
        correlationId: "pre-abort",
      }),
    ).rejects.toMatchObject({ envelope: { code: "CANCELLED" } });
    await expect(
      server.request("offline-world", "documents.snapshot", {}, "already-expired", {
        deadline: Date.now() - 1,
        correlationId: "pre-timeout",
      }),
    ).rejects.toMatchObject({ envelope: { code: "TIMEOUT" } });

    vi.useFakeTimers();
    try {
      const offline = server.request("offline-world", "documents.snapshot", {}, "offline-timeout", {
        correlationId: "offline-timeout",
      });
      const rejection = expect(offline).rejects.toMatchObject({
        envelope: {
          code: "TIMEOUT",
          details: { correlationId: "offline-timeout" },
        },
      });
      const mutation = server.request(
        "offline-world",
        "documents.create",
        { documentType: "Actor", data: { name: "Possibly created" } },
        "offline-mutation-timeout",
        { correlationId: "offline-mutation-timeout" },
      );
      const mutationRejection = expect(mutation).rejects.toMatchObject({
        envelope: {
          code: "TIMEOUT",
          retryable: false,
          details: {
            correlationId: "offline-mutation-timeout",
          },
        },
      });
      await vi.advanceTimersByTimeAsync(1_011);
      await Promise.all([rejection, mutationRejection]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks an offline mutation as indeterminate after reconnect dispatch and no cancel ack", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    cleanups.push(() => {
      db.close();
    });
    const server = await startHostCompanionServer({
      db,
      allowedOrigins: ["http://foundry.test"],
      requestTimeoutMs: 60_000,
      pairingSecret: PAIRING_SECRET,
    });
    cleanups.push(server.close);
    const controller = new AbortController();

    vi.useFakeTimers();
    try {
      const mutation = server.request(
        "world-reconnect",
        "documents.create",
        { documentType: "Actor", data: { name: "Possibly created" } },
        "offline-reconnect-mutation",
        { signal: controller.signal, correlationId: "offline-reconnect-mutation" },
      );
      const socket = new WebSocket(server.address().endpoint, { origin: "http://foundry.test" });
      cleanups.push(() => socket.terminate());
      const received = waitForRequest(socket);
      await authenticate(socket, hello("world-reconnect"));
      await received;
      controller.abort();
      const rejection = expect(mutation).rejects.toMatchObject({
        envelope: {
          code: "INDETERMINATE_MUTATION",
          retryable: false,
          details: { indeterminate: true, reconciliationRequired: true },
        },
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reissues a pending identity credential after lost auth.ready and confirms without grants", async () => {
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
    const identity = hello("pending-enrollment-world");
    identityCredentials.delete(identity.connectionId);
    setCapabilityGrant(
      db,
      {
        connectionId: identity.connectionId,
        foundryUserRole: "GAMEMASTER",
        requestedCapability: "documents:create",
      },
      true,
    );

    const first = new WebSocket(server.address().endpoint, { origin: "http://foundry.test" });
    cleanups.push(() => first.terminate());
    const firstCredential = await receiveUnconfirmedCredential(first, identity);
    expect(server.listConnections()).toEqual([]);
    expect(
      db
        .prepare("SELECT confirmed FROM companion_identities WHERE connection_id = ?")
        .get(identity.connectionId),
    ).toEqual({ confirmed: 0 });
    setCapabilityGrant(
      db,
      {
        connectionId: identity.connectionId,
        foundryUserRole: "GAMEMASTER",
        requestedCapability: "documents:create",
      },
      true,
    );
    const firstClosed = waitForClose(first);
    first.terminate();
    await firstClosed;

    const second = new WebSocket(server.address().endpoint, { origin: "http://foundry.test" });
    cleanups.push(() => second.terminate());
    await authenticate(second, identity);
    expect(identityCredentials.get(identity.connectionId)?.toString("base64url")).toBe(
      firstCredential,
    );
    expect(
      db
        .prepare("SELECT confirmed FROM companion_identities WHERE connection_id = ?")
        .get(identity.connectionId),
    ).toEqual({ confirmed: 1 });
    expect(
      db
        .prepare("SELECT allowed FROM capability_grants WHERE connection_id = ?")
        .all(identity.connectionId),
    ).toEqual([]);
    expect(server.listConnections()).toMatchObject([
      { connectionId: identity.connectionId, worldId: identity.worldId },
    ]);
  });

  it("rejects a paired client impersonating a bound connection without inheriting its grant", async () => {
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
    const legitimateIdentity = hello("bound-world");
    const legitimate = new WebSocket(server.address().endpoint, { origin: "http://foundry.test" });
    cleanups.push(() => legitimate.terminate());
    await authenticate(legitimate, legitimateIdentity);
    setCapabilityGrant(
      db,
      {
        connectionId: legitimateIdentity.connectionId,
        foundryUserRole: "GAMEMASTER",
        requestedCapability: "documents:create",
      },
      true,
    );

    const forgedIdentity: CompanionHelloMessage = {
      ...legitimateIdentity,
      worldId: "forged-world",
      currentUser: { id: "forged-gm", name: "Forged GM", role: "GAMEMASTER" },
    };
    const attacker = new WebSocket(server.address().endpoint, { origin: "http://foundry.test" });
    cleanups.push(() => attacker.terminate());
    const closed = waitForClose(attacker);
    attacker.on("message", (data) => {
      const challenge = JSON.parse(data.toString()) as Record<string, unknown>;
      if (challenge["type"] !== "auth.challenge") return;
      attacker.send(
        JSON.stringify({
          type: "auth.proof",
          hello: forgedIdentity,
          proof: createHmac("sha256", PAIRING_SECRET)
            .update(
              companionAuthPayload(
                challenge["challenge"] as string,
                challenge["origin"] as string,
                forgedIdentity,
              ),
              "utf8",
            )
            .digest("base64url"),
        }),
      );
    });
    await expect(closed).resolves.toMatchObject({ code: 1008 });
    expect(server.listConnections()).toMatchObject([
      { connectionId: "bound-world", worldId: "bound-world", currentUser: { id: "gm-a" } },
    ]);
    expect(
      db
        .prepare("SELECT allowed FROM capability_grants WHERE connection_id = ? AND capability = ?")
        .get("bound-world", "documents:create"),
    ).toEqual({ allowed: 1 });
  });

  it("marks a dispatched mutation indeterminate when the companion server shuts down", async () => {
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
    await authenticate(socket, hello("shutdown-mutation-world"));
    const received = waitForRequest(socket);
    const mutation = server.request(
      "shutdown-mutation-world",
      "documents.create",
      { documentType: "Actor", data: { name: "Possibly created" } },
      "shutdown-mutation",
      { correlationId: "shutdown-mutation" },
    );
    await received;
    const rejection = expect(mutation).rejects.toMatchObject({
      envelope: {
        code: "INDETERMINATE_MUTATION",
        retryable: false,
        details: {
          correlationId: "shutdown-mutation",
          indeterminate: true,
          reconciliationRequired: true,
        },
      },
    });

    await server.close();
    await rejection;
  });

  it("rejects requests synchronously once close begins and makes close idempotent", async () => {
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

    const pending = server.request("offline-world", "documents.get", {}, "close-pending");
    const pendingRejection = expect(pending).rejects.toMatchObject({
      envelope: { code: "OFFLINE_BRIDGE", retryable: false },
    });
    const firstClose = server.close();
    const secondClose = server.close();
    expect(secondClose).toBe(firstClose);
    await expect(
      server.request("offline-world", "documents.get", {}, "after-close", {
        correlationId: "after-close",
      }),
    ).rejects.toMatchObject({
      envelope: {
        code: "OFFLINE_BRIDGE",
        retryable: false,
        details: { correlationId: "after-close" },
      },
    });
    await Promise.all([pendingRejection, firstClose]);
  });

  it("uses fixed-size replay identities instead of retaining large request bodies", () => {
    const marker = "private-image-payload";
    const data = marker.repeat(800_000);
    const digest = companionRequestIdentityDigest(
      "assets.images.upload",
      { connectionId: "world-a", source: { kind: "base64", data } },
      "large-upload",
    );

    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(digest).not.toContain(marker);
    expect(digest.length).toBe(43);
  });
});
