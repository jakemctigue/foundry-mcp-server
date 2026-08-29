import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { BRIDGE_PROTOCOL_VERSION } from "@foundry-mcp/protocol";

import { startHostCompanionServer } from "../src/bridge/companion-server.js";
import { HostBridgeRouter } from "../src/bridge/router.js";
import { openDatabase, runMigrations } from "../src/db/index.js";
import { setCapabilityGrant } from "../src/security/policy.js";

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
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        connectionId: "world-a",
        worldId: "alpha",
        worldTitle: "Alpha World",
        foundryVersion: "13.351",
        foundryUserRole: "GAMEMASTER",
      }),
    );
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
});
