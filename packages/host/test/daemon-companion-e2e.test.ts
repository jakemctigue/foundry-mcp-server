import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  BRIDGE_PROTOCOL_VERSION,
  companionAuthPayload,
  companionAuthReadyPayload,
  companionIdentityConfirmPayload,
  type CompanionHelloMessage,
} from "@foundry-mcp/protocol";

import { connectPipeClient, type PipeClient } from "../src/bridge/pipe-client.js";
import { startDaemon, type Daemon } from "../src/daemon.js";
import { getIntelligenceStatus } from "../src/intelligence/reconciliation.js";
import { setCapabilityGrant } from "../src/security/policy.js";

const PAIRING_SECRET = Buffer.alloc(32, 11);

async function authenticate(socket: WebSocket, hello: CompanionHelloMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let challenge: string | undefined;
    let origin: string | undefined;
    let ready = false;
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message["type"] === "auth.challenge" && typeof message["challenge"] === "string") {
        challenge = message["challenge"];
        origin = message["origin"] as string;
        socket.send(
          JSON.stringify({
            type: "auth.proof",
            hello,
            proof: createHmac("sha256", PAIRING_SECRET)
              .update(companionAuthPayload(challenge, origin, hello), "utf8")
              .digest("base64url"),
          }),
        );
        return;
      }
      if (message["type"] === "auth.ready" && typeof message["proof"] === "string") {
        expect(message["proof"]).toBe(
          createHmac("sha256", PAIRING_SECRET)
            .update(companionAuthReadyPayload(challenge ?? "", origin ?? "", hello), "utf8")
            .digest("base64url"),
        );
        if (typeof message["identityCredential"] === "string") {
          const credential = Buffer.from(message["identityCredential"], "base64url");
          socket.send(
            JSON.stringify({
              type: "auth.confirm",
              connectionId: hello.connectionId,
              proof: createHmac("sha256", credential)
                .update(
                  companionIdentityConfirmPayload(challenge ?? "", origin ?? "", hello),
                  "utf8",
                )
                .digest("base64url"),
            }),
          );
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

describe("daemon to mocked browser companion end-to-end", () => {
  let daemon: Daemon | undefined;
  let socket: WebSocket | undefined;
  let pipe: PipeClient | undefined;
  let appDataDir: string | undefined;

  afterEach(async () => {
    await pipe?.close();
    socket?.terminate();
    await daemon?.shutdown();
    if (appDataDir) fs.rmSync(appDataDir, { recursive: true, force: true });
  });

  it("routes reads and authorized mutations across pipe and WebSocket with real envelopes", async () => {
    appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-mcp-daemon-companion-"));
    daemon = await startDaemon({
      appDataDir,
      companionPairingSecret: PAIRING_SECRET,
      cliConfig: {
        port: 0,
        pipeName: `e2e-${process.pid.toString()}-${Date.now().toString(36)}`,
        allowedOrigins: ["http://foundry.test"],
      },
    });
    expect(daemon.pipe.ready).toBe(true);
    socket = new WebSocket(daemon.companionEndpoint, { origin: "http://foundry.test" });
    let companionRequests = 0;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        type?: string;
        id?: string;
        method?: string;
      };
      if (message.type !== "request" || !message.id) return;
      companionRequests += 1;
      const value =
        message.method === "documents.types"
          ? { ok: true, value: { types: [] } }
          : message.method === "compendiums.list"
            ? { ok: true, value: { packs: [] } }
            : message.method === "documents.update"
              ? {
                  ok: false,
                  error: {
                    code: "FOUNDRY_ERROR",
                    message: "mocked Foundry update failed",
                    retryable: false,
                  },
                }
              : {
                  ok: true,
                  value: {
                    assetPath: "art/hero.png",
                    source: "data",
                    mimeType: "image/png",
                    size: 100,
                    collision: "created",
                  },
                };
      socket?.send(JSON.stringify({ type: "response", id: message.id, ok: true, value }));
    });
    await authenticate(socket, {
      type: "hello",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      connectionId: "world-a",
      worldId: "alpha",
      worldTitle: "Alpha World",
      foundryVersion: "13.351",
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
    });
    await vi.waitFor(() => expect(daemon?.companion.listConnections()).toHaveLength(1));
    await vi.waitFor(() =>
      expect(getIntelligenceStatus(daemon?.db as Daemon["db"], "world-a")).toMatchObject({
        status: "complete",
        gap: false,
        truncated: false,
      }),
    );
    const backgroundRequests = companionRequests;

    pipe = await connectPipeClient(daemon.pipePath, { appDataDir });
    const responses = new Map<string, unknown>();
    pipe.onMessage((message) => {
      const response = message as { id?: string };
      if (response.id) responses.set(response.id, message);
    });
    const request = async (id: string, method: string, params: Record<string, unknown> = {}) => {
      pipe?.send({ id, method, params });
      await vi.waitFor(() => expect(responses.has(id)).toBe(true));
      return responses.get(id) as { result: unknown };
    };

    await expect(request("init", "initialize")).resolves.toMatchObject({
      result: { protocolVersion: BRIDGE_PROTOCOL_VERSION },
    });
    await expect(request("connections", "connections.list")).resolves.toMatchObject({
      result: {
        connections: [
          {
            connectionId: "world-a",
            status: "connected",
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
      },
    });
    await expect(
      request("types", "documents.types", { connectionId: "world-a" }),
    ).resolves.toMatchObject({ result: { ok: true, value: { types: [] } } });

    setCapabilityGrant(
      daemon.db,
      {
        connectionId: "world-a",
        foundryUserRole: "GAMEMASTER",
        requestedCapability: "assets:upload",
      },
      true,
    );
    await expect(
      request("mutation", "mutation.execute", {
        method: "assets.images.upload",
        params: {
          connectionId: "world-a",
          source: { kind: "base64", data: "safe-test-data" },
        },
        authorization: {
          connectionId: "world-a",
          requestedCapability: "assets:upload",
          tool: "foundry.assets.images.upload",
          correlationId: "daemon-e2e-1",
        },
      }),
    ).resolves.toMatchObject({
      result: { ok: true, value: { assetPath: "art/hero.png" } },
    });
    setCapabilityGrant(
      daemon.db,
      {
        connectionId: "world-a",
        foundryUserRole: "GAMEMASTER",
        requestedCapability: "documents:update",
      },
      true,
    );
    await expect(
      request("failed-mutation", "mutation.execute", {
        method: "documents.update",
        params: { connectionId: "world-a", uuid: "Actor.missing", patch: { name: "Nope" } },
        authorization: {
          connectionId: "world-a",
          requestedCapability: "documents:update",
          tool: "foundry.documents.update",
          correlationId: "daemon-e2e-2",
        },
      }),
    ).resolves.toMatchObject({
      result: {
        ok: false,
        error: { code: "FOUNDRY_ERROR", message: "mocked Foundry update failed" },
      },
    });
    await expect(
      request("generate", "mutation.execute", {
        method: "assets.images.generate",
        params: {
          connectionId: "world-a",
          prompt: "A brass dragon token",
          provider: "deterministic",
          options: {},
          sourceId: "data",
          destinationPath: "art/generated.png",
          onCollision: "error",
        },
        authorization: {
          connectionId: "world-a",
          requestedCapability: "assets:upload",
          tool: "foundry.assets.images.generate",
          correlationId: "daemon-e2e-3",
        },
      }),
    ).resolves.toMatchObject({
      result: {
        ok: true,
        value: {
          assetPath: "art/hero.png",
          provider: "deterministic",
          model: "deterministic-sha256-v1",
        },
      },
    });
    setCapabilityGrant(
      daemon.db,
      {
        connectionId: "world-a",
        foundryUserRole: "GAMEMASTER",
        requestedCapability: "ai:network",
      },
      true,
    );
    await expect(
      request("unavailable-provider", "mutation.execute", {
        method: "assets.images.generate",
        params: {
          connectionId: "world-a",
          prompt: "No network fallback",
          provider: "openai",
          options: {},
          sourceId: "data",
          destinationPath: "art/not-created.png",
          onCollision: "error",
        },
        authorization: {
          connectionId: "world-a",
          requestedCapability: "assets:upload",
          tool: "foundry.assets.images.generate",
          correlationId: "daemon-e2e-4",
        },
      }),
    ).resolves.toMatchObject({
      result: {
        ok: false,
        error: {
          code: "FOUNDRY_ERROR",
          details: { providerCode: "PROVIDER_UNAVAILABLE" },
        },
      },
    });
    setCapabilityGrant(
      daemon.db,
      {
        connectionId: "world-a",
        foundryUserRole: "GAMEMASTER",
        requestedCapability: "assets:attach",
      },
      true,
    );
    await expect(
      request("blocked-url", "mutation.execute", {
        method: "assets.images.attach",
        params: {
          connectionId: "world-a",
          documentUuid: "Actor.hero",
          fieldPath: "img",
          asset: {
            kind: "url",
            sourceId: "data",
            destinationPath: "art/private.png",
            url: "http://127.0.0.1/private.png",
            onCollision: "error",
          },
        },
        authorization: {
          connectionId: "world-a",
          requestedCapability: "assets:attach",
          tool: "foundry.assets.images.attach",
          correlationId: "daemon-e2e-5",
        },
      }),
    ).resolves.toMatchObject({
      result: {
        ok: false,
        error: {
          code: "FOUNDRY_ERROR",
          details: { urlImportCode: "SSRF_BLOCKED" },
        },
      },
    });
    expect(backgroundRequests).toBeGreaterThanOrEqual(2);
    expect(companionRequests).toBe(backgroundRequests + 4);
    expect(daemon.db.prepare("SELECT outcome, tool, correlation_id FROM audit_log").all()).toEqual([
      {
        outcome: "success",
        tool: "foundry.assets.images.upload",
        correlation_id: "daemon-e2e-1",
      },
      {
        outcome: "error",
        tool: "foundry.documents.update",
        correlation_id: "daemon-e2e-2",
      },
      {
        outcome: "success",
        tool: "foundry.assets.images.generate",
        correlation_id: "daemon-e2e-3",
      },
      {
        outcome: "error",
        tool: "foundry.assets.images.generate",
        correlation_id: "daemon-e2e-4",
      },
      {
        outcome: "error",
        tool: "foundry.assets.images.attach",
        correlation_id: "daemon-e2e-5",
      },
    ]);
  }, 20_000);
});
