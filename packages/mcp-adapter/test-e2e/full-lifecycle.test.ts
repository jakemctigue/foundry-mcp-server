import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  base32Encode,
  setCapabilityGrant,
  startDaemon,
  FakeHookEventBridge,
  FakeHooks,
  type Daemon,
} from "@foundry-mcp/host";
import {
  inspectImageBytes,
  type JsonValue,
  type RequestedCapability,
} from "@foundry-mcp/protocol";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";

import {
  CompanionBridgeClient,
  BrowserFoundryAssetRuntime,
  FoundryAssetService,
  FoundryCompanionHandlers,
  FoundryDocumentService,
  FoundrySessionService,
  createCompanionHello,
  type CompanionSocket,
  type CompanionStorage,
} from "../../foundry-module/src/index.js";
import {
  FakeRole,
  createRichFakeRuntime,
} from "../../foundry-module/test/fake-runtime/index.js";
import {
  VALID_PNG,
  createFakeAssetRuntime,
} from "../../foundry-module/test/fake-runtime/assets.js";
import { connectNegotiatedBridge, type BridgeConnection } from "../src/bridge-connection.js";
import { createFoundryMcpServer } from "../src/server.js";

const ORIGIN = "http://127.0.0.1:30000";
const CONNECTION_ID = "lifecycle-world:gm";
const PAIRING_SECRET = Buffer.alloc(32, 0x5a);
const PAIRING_SECRET_DISPLAY = base32Encode(PAIRING_SECRET);

interface MockImageBitmap {
  width: number;
  height: number;
  closed: boolean;
  close(): void;
}

class MockBrowserImageDecoder {
  readonly inputs: Blob[] = [];
  readonly bitmaps: MockImageBitmap[] = [];
  #nextFailure: Error | undefined;

  failNext(error = new Error("injected browser decoder failure")): void {
    this.#nextFailure = error;
  }

  readonly createImageBitmap = async (
    input: unknown,
  ): Promise<MockImageBitmap> => {
    if (!(input instanceof Blob)) {
      throw new TypeError("createImageBitmap requires a Blob");
    }
    this.inputs.push(input);
    if (this.#nextFailure) {
      const failure = this.#nextFailure;
      this.#nextFailure = undefined;
      throw failure;
    }
    const bytes = new Uint8Array(await input.arrayBuffer());
    const inspected = inspectImageBytes(bytes, {
      expectedMimeType: input.type,
      requireDimensions: true,
    });
    if (
      !inspected.ok ||
      inspected.value.width === undefined ||
      inspected.value.height === undefined
    ) {
      throw new Error("mock browser decoder rejected invalid image bytes");
    }
    const bitmap: MockImageBitmap = {
      width: inspected.value.width,
      height: inspected.value.height,
      closed: false,
      close() {
        this.closed = true;
      },
    };
    this.bitmaps.push(bitmap);
    return bitmap;
  };
}

class MemoryStorage implements CompanionStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class NodeCompanionSocket implements CompanionSocket {
  readonly #socket: WebSocket;

  constructor(url: string) {
    this.#socket = new WebSocket(url, { origin: ORIGIN });
    // CONNECTING sockets emit an error when a failed setup is torn down. The
    // companion client observes close/reconnect; the fixture must also consume
    // the ws-specific error event so cleanup never becomes an unhandled error.
    this.#socket.on("error", () => undefined);
  }

  get readyState(): number {
    return this.#socket.readyState;
  }

  send(data: string): void {
    this.#socket.send(data);
  }

  close(code?: number, reason?: string): void {
    if (this.#socket.readyState === WebSocket.CONNECTING) {
      this.#socket.terminate();
      return;
    }
    this.#socket.close(code, reason);
  }

  addEventListener(type: "open" | "close", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "open" | "close" | "message",
    listener: (() => void) | ((event: { data: unknown }) => void),
  ): void {
    if (type === "message") {
      this.#socket.on("message", (data) =>
        (listener as (event: { data: unknown }) => void)({ data: data.toString() }),
      );
      return;
    }
    this.#socket.on(type, listener as () => void);
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function required<T>(value: T, label: string): NonNullable<T> {
  if (value === undefined) throw new Error(`${label} was not initialized`);
  return value as NonNullable<T>;
}

async function createMcpClient(bridge: BridgeConnection): Promise<{
  client: Client;
  close(): Promise<void>;
}> {
  const server = createFoundryMcpServer({ bridge });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mocked-foundry-lifecycle", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "unknown MCP error";
    throw new Error(`${name}: ${text}`);
  }
  return result.structuredContent as Record<string, unknown>;
}

function createBrowserCompanion(
  endpoint: string,
  storage: CompanionStorage,
  handlers: FoundryCompanionHandlers,
): CompanionBridgeClient {
  return new CompanionBridgeClient({
    endpoint,
    pageOrigin: ORIGIN,
    allowedOrigins: [ORIGIN],
    connectionId: CONNECTION_ID,
    storage,
    reconnectDelayMs: 20,
    schedule: (callback, delay) => setTimeout(callback, delay),
    createSocket: (url) => new NodeCompanionSocket(url),
    handleRequest: async (method, params) =>
      JSON.parse(JSON.stringify(await handlers.handle(method, params))) as JsonValue,
    hello: createCompanionHello({
      connectionId: CONNECTION_ID,
      worldId: "lifecycle-world",
      worldTitle: "Mocked Foundry Lifecycle",
      foundryVersion: "14.0.0",
      foundryUserRole: "GAMEMASTER",
      currentUser: { id: "gm", name: "Lifecycle GM", role: "GAMEMASTER" },
      system: { id: "dnd5e", version: "5.1.0" },
      activeModules: [
        { id: "foundry-mcp", version: "0.1.0" },
        { id: "test-automation", version: "1.2.3" },
      ],
      moduleCapabilities: [
        "documents.read",
        "documents.write",
        "assets.read",
        "assets.write",
        "sessions.read",
        "sessions.write",
        "events.publish",
      ],
    }),
    pairingSecret: PAIRING_SECRET_DISPLAY,
  });
}

function grantMutations(daemon: Daemon): void {
  for (const requestedCapability of [
    "documents:create",
    "documents:update",
    "assets:upload",
    "assets:attach",
    "sessions:start",
    "sessions:append",
  ] satisfies RequestedCapability[]) {
    setCapabilityGrant(
      daemon.db,
      {
        connectionId: CONNECTION_ID,
        foundryUserRole: "GAMEMASTER",
        requestedCapability,
      },
      true,
    );
  }
}

describe("MOCKED FOUNDRY v14 full lifecycle E2E", () => {
  it(
    "survives host/browser/container restarts while covering documents, images, sessions, and intelligence",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-mcp-lifecycle-"));
      const pipeName = `lifecycle-${process.pid.toString()}-${randomUUID()}`;
      const runtime = createRichFakeRuntime(FakeRole.GAMEMASTER);
      const seededActor = runtime.seedDocument("Actor", {
        name: "Seeded Stormborn",
        type: "stormborn",
        img: "tokens/seeded.png",
        ownership: { default: 1, gm: 3 },
        system: { unknownRuntimeField: { preserved: true } },
      });
      runtime.seedDocument(
        "Item",
        { name: "Seeded Rune", type: "rune", system: { charge: 7 } },
        { parentUuid: seededActor.uuid },
      );
      for (const [type, name] of [
        ["Scene", "The Observatory"],
        ["RollTable", "Astral Encounters"],
        ["Playlist", "Clockwork Ambience"],
        ["Cards", "Fate Deck"],
        ["Macro", "Initiative Helper"],
      ] as const) {
        runtime.seedDocument(type, { name });
      }
      runtime.addCompendium({
        id: "world.bestarium",
        label: "Lifecycle Bestiary",
        type: "Actor",
        locked: true,
        documents: [
          { name: "Compendium Clockwork", type: "clockwork", system: { source: "pack" } },
        ],
      });

      const assetRuntime = createFakeAssetRuntime()
        .seed("data", "tokens/seeded.png", VALID_PNG, "image/png")
        .seed("public", "icons/core.png", VALID_PNG, "image/png");
      const imageDecoder = new MockBrowserImageDecoder();
      const browserAssetDecoder = new BrowserFoundryAssetRuntime({
        global: { Blob, createImageBitmap: imageDecoder.createImageBitmap },
      });
      assetRuntime.decodeImage = browserAssetDecoder.decodeImage.bind(browserAssetDecoder);
      const documents = new FoundryDocumentService(runtime);
      const assets = new FoundryAssetService(assetRuntime, documents, runtime);
      const sessions = new FoundrySessionService(documents, {
        idFactory: () => "lifecycle-session",
        now: () => new Date("2026-08-29T12:00:00.000Z"),
      });
      const handlers = new FoundryCompanionHandlers({ documents, assets, sessions });
      const storage = new MemoryStorage();
      const hooks = new FakeHooks();

      let daemon: Daemon | undefined;
      let bridge: BridgeConnection | undefined;
      let mcp: Awaited<ReturnType<typeof createMcpClient>> | undefined;
      let browser: CompanionBridgeClient | undefined;
      let hookBridge: FakeHookEventBridge | undefined;
      try {
        const startHost = async (): Promise<void> => {
          daemon = await startDaemon({
            appDataDir: root,
            companionPairingSecret: PAIRING_SECRET,
            cliConfig: {
              dbPath: "lifecycle.db",
              pipeName,
              port: 0,
              allowedOrigins: [ORIGIN],
              eventCategories: ["document.*", "journal.*", "scene.*", "combat.*", "chat.public"],
              capturePrivateContent: false,
            },
          });
          grantMutations(daemon);
          browser = createBrowserCompanion(daemon.companionEndpoint, storage, handlers);
          hookBridge = new FakeHookEventBridge(hooks, {
            categories: ["document.*", "journal.*", "scene.*", "combat.*", "chat.*"],
            capturePrivateContent: false,
            onEvent: (event) => browser?.publish(event),
          });
          browser.start();
          await waitFor(
            () => daemon?.companion.listConnections().length === 1,
            "mocked Foundry companion connection",
          );
          bridge = await connectNegotiatedBridge(daemon.pipePath);
          const activeMcp = await createMcpClient(bridge);
          mcp = activeMcp;
          await waitFor(
            async () => {
              const listed = await callTool(activeMcp.client, "foundry.connections.list", {});
              return (listed.connections as unknown[]).length === 1;
            },
            "authenticated companion registration through MCP",
          );
        };

        await startHost();
        const client = required(mcp, "MCP client").client;
        expect(await callTool(client, "foundry.connections.list", {})).toMatchObject({
          connections: [
            {
              connectionId: CONNECTION_ID,
              worldId: "lifecycle-world",
              currentUser: { id: "gm", name: "Lifecycle GM", role: "GAMEMASTER" },
              system: { id: "dnd5e", version: "5.1.0" },
              activeModules: [
                { id: "foundry-mcp", version: "0.1.0" },
                { id: "test-automation", version: "1.2.3" },
              ],
              moduleCapabilities: expect.arrayContaining([
                "documents.read",
                "assets.write",
                "sessions.write",
                "events.publish",
              ]),
            },
          ],
        });

        const types = (await callTool(client, "foundry.documents.types", {
          connectionId: CONNECTION_ID,
        })).types as Array<{ type: string; subtypes: Array<{ subtype: string }> }>;
        expect(
          types
            .find((entry) => entry.type === "Actor")
            ?.subtypes.map((entry) => entry.subtype)
            .sort(),
        ).toEqual(["clockwork", "stormborn"]);
        expect(
          types
            .find((entry) => entry.type === "Item")
            ?.subtypes.map((entry) => entry.subtype)
            .sort(),
        ).toEqual(["relic", "rune"]);

        const createdActorUuids: string[] = [];
        for (const subtype of ["stormborn", "clockwork"]) {
          const created = await callTool(client, "foundry.documents.create", {
            connectionId: CONNECTION_ID,
            type: "Actor",
            data: {
              name: `Created ${subtype}`,
              type: subtype,
              ownership: { default: 1, gm: 3 },
              system: { subtypeSpecific: { subtype, keepUnknown: true } },
            },
          });
          const results = created.results as Array<{
            status: string;
            document?: { uuid: string };
          }>;
          expect(results[0]?.status).toBe("created");
          createdActorUuids.push(results[0]?.document?.uuid as string);
        }
        const targetActor = createdActorUuids[1] as string;
        for (const [subtype, parentUuid] of [
          ["rune", undefined],
          ["relic", targetActor],
        ] as const) {
          const created = await callTool(client, "foundry.documents.create", {
            connectionId: CONNECTION_ID,
            type: "Item",
            ...(parentUuid ? { parentUuid } : {}),
            data: { name: `Created ${subtype}`, type: subtype, system: { keepUnknown: true } },
          });
          expect((created.results as Array<{ status: string }>)[0]?.status).toBe("created");
        }
        expect(
          (await callTool(client, "foundry.documents.embedded.list", {
            connectionId: CONNECTION_ID,
            parentUuid: targetActor,
            embeddedType: "Item",
          })).items,
        ).toHaveLength(1);

        const beforeUpdate = await callTool(client, "foundry.documents.get", {
          connectionId: CONNECTION_ID,
          uuid: targetActor,
        });
        const updated = await callTool(client, "foundry.documents.update", {
          connectionId: CONNECTION_ID,
          uuid: targetActor,
          expectedHash: beforeUpdate.sourceHash,
          data: { system: { updatedByLifecycle: true } },
        });
        expect(updated).toHaveProperty("document.data.system.subtypeSpecific.keepUnknown", true);
        expect(updated).toHaveProperty("document.data.system.updatedByLifecycle", true);
        expect(updated).toHaveProperty("document.data.ownership.gm", 3);

        expect(
          (await callTool(client, "foundry.compendiums.list", {
            connectionId: CONNECTION_ID,
          })).packs,
        ).toEqual([
          expect.objectContaining({ id: "world.bestarium", locked: true, documentCount: 1 }),
        ]);
        expect(
          (await callTool(client, "foundry.compendiums.documents.list", {
            connectionId: CONNECTION_ID,
            packId: "world.bestarium",
            hydrate: true,
          })).items,
        ).toHaveLength(1);
        for (const type of ["Scene", "RollTable", "Playlist", "Cards", "Macro"]) {
          expect(
            (await callTool(client, "foundry.documents.list", {
              connectionId: CONNECTION_ID,
              type,
            })).items,
          ).toHaveLength(1);
        }

        const imageListing = await callTool(client, "foundry.assets.images.list", {
          connectionId: CONNECTION_ID,
          maxDepth: 4,
        });
        expect(imageListing.sources).toEqual([
          { id: "data", writable: true },
          { id: "public", writable: false, reason: "Foundry core assets are read-only" },
        ]);
        const encodedPng = Buffer.from(VALID_PNG).toString("base64");
        expect(
          await callTool(client, "foundry.assets.images.upload", {
            connectionId: CONNECTION_ID,
            destinationPath: "tokens/uploaded.png",
            source: { kind: "base64", data: encodedPng, mimeType: "image/png" },
          }),
        ).toMatchObject({ assetPath: "tokens/uploaded.png", source: "data" });
        expect(imageDecoder.inputs).toHaveLength(1);
        expect(imageDecoder.inputs[0]).toBeInstanceOf(Blob);
        expect(imageDecoder.bitmaps).toEqual([
          expect.objectContaining({ closed: true }),
        ]);

        imageDecoder.failNext();
        await expect(
          callTool(client, "foundry.assets.images.upload", {
            connectionId: CONNECTION_ID,
            destinationPath: "tokens/decoder-failure.png",
            source: { kind: "base64", data: encodedPng, mimeType: "image/png" },
          }),
        ).rejects.toThrow(/decode/i);
        expect(assetRuntime.get("data", "tokens/decoder-failure.png")).toBeUndefined();
        expect(
          await callTool(client, "foundry.assets.images.generate", {
            connectionId: CONNECTION_ID,
            prompt: "a clockwork constellation token",
            destinationPath: "generated/clockwork.png",
          }),
        ).toMatchObject({
          assetPath: "generated/clockwork.png",
          provider: "deterministic",
        });
        expect(imageDecoder.inputs).toHaveLength(3);
        expect(imageDecoder.inputs.every((input) => input instanceof Blob)).toBe(true);
        expect(imageDecoder.bitmaps).toHaveLength(2);
        expect(imageDecoder.bitmaps.every((bitmap) => bitmap.closed)).toBe(true);
        const decodedBeforeReferenceAttach = imageDecoder.bitmaps.length;
        const attached = await callTool(client, "foundry.assets.images.attach", {
          connectionId: CONNECTION_ID,
          documentUuid: targetActor,
          asset: { kind: "reference", sourceId: "data", path: "generated/clockwork.png" },
        });
        expect(attached).toHaveProperty("assetPath", "generated/clockwork.png");
        expect(imageDecoder.bitmaps).toHaveLength(decodedBeforeReferenceAttach);
        expect(imageDecoder.bitmaps.every((bitmap) => bitmap.closed)).toBe(true);
        expect(
          await callTool(client, "foundry.documents.get", {
            connectionId: CONNECTION_ID,
            uuid: targetActor,
          }),
        ).toHaveProperty("data.img", "generated/clockwork.png");

        const started = await callTool(client, "foundry.sessions.start", {
          connectionId: CONNECTION_ID,
          title: "Lifecycle Session",
          purpose: "Exercise journal-backed MCP sessions",
          linkedUuids: [targetActor],
          idempotencyKey: "lifecycle-start-key",
        });
        const sessionId = (started.session as { sessionId: string }).sessionId;
        const appended = await callTool(client, "foundry.sessions.append", {
          connectionId: CONNECTION_ID,
          sessionId,
          kind: "decision",
          html: "<p>Keep the clockwork actor.</p>",
          attribution: "GM",
          linkedUuids: [targetActor],
          idempotencyKey: "lifecycle-append-key",
        });
        expect(appended).toHaveProperty("page.kind", "decision");
        expect(
          (await callTool(client, "foundry.sessions.get", {
            connectionId: CONNECTION_ID,
            sessionId,
          })).pages,
        ).toHaveLength(2);

        hooks.callAll("createDocument", {
          documentName: "Actor",
          uuid: targetActor,
          toObject: () => ({ name: "Created clockwork", type: "clockwork" }),
        });
        hooks.callAll("createChatMessage", {
          uuid: "ChatMessage.public-1",
          content: "Clockwork decision recorded",
          whisper: [],
          toObject: () => ({ content: "Clockwork decision recorded" }),
        });
        hooks.callAll("createChatMessage", {
          uuid: "ChatMessage.private-1",
          content: "must remain private",
          whisper: ["gm"],
          toObject: () => ({ content: "must remain private", whisper: ["gm"] }),
        });
        await waitFor(
          async () => {
            const timeline = await callTool(client, "foundry.intelligence.timeline", {
              connectionId: CONNECTION_ID,
              limit: 10,
            });
            return (timeline.events as unknown[]).length === 2;
          },
          "event ingestion",
        );
        expect(
          (await callTool(client, "foundry.intelligence.search", {
            connectionId: CONNECTION_ID,
            query: "clockwork",
          })).results,
        ).toHaveLength(4);

        const encodedConnectionId = encodeURIComponent(CONNECTION_ID);
        const encodedActorUuid = encodeURIComponent(targetActor);
        const encodedSessionId = encodeURIComponent(sessionId);
        const resourceUris = (await client.listResources()).resources.map(({ uri }) => uri);
        expect(resourceUris).toEqual(
          expect.arrayContaining([
            `foundry://world/${encodedConnectionId}`,
            `foundry://document/${encodedConnectionId}/${encodedActorUuid}`,
            `foundry://session/${encodedConnectionId}/${encodedSessionId}`,
            `foundry://intelligence/${encodedConnectionId}/latest`,
          ]),
        );
        const documentResource = await client.readResource({
          uri: `foundry://document/${encodedConnectionId}/${encodedActorUuid}`,
        });
        const sessionResource = await client.readResource({
          uri: `foundry://session/${encodedConnectionId}/${encodedSessionId}`,
        });
        const intelligenceResource = await client.readResource({
          uri: `foundry://intelligence/${encodedConnectionId}/latest`,
        });
        const parseResource = (resource: typeof documentResource): Record<string, unknown> => {
          const content = resource.contents[0];
          if (!content || !("text" in content)) throw new Error("expected JSON text resource");
          return JSON.parse(content.text) as Record<string, unknown>;
        };
        expect(parseResource(documentResource)).toMatchObject({ uuid: targetActor });
        expect(parseResource(sessionResource)).toMatchObject({
          session: { sessionId },
        });
        expect(parseResource(intelligenceResource)).toMatchObject({
          connection: { connectionId: CONNECTION_ID },
          timeline: { events: expect.any(Array) },
        });

        const replayRequestId = "lifecycle-idempotent-request";
        const replayInput = {
          connectionId: CONNECTION_ID,
          type: "Actor",
          data: { name: "Restart dedupe actor", type: "stormborn" },
        };
        const firstReplayResult = await required(daemon, "host daemon").companion.request(
          CONNECTION_ID,
          "documents.create",
          replayInput,
          replayRequestId,
        );
        const countBeforeRestart = (await documents.list({ type: "Actor" })).ok
          ? ((await documents.list({ type: "Actor" })) as { ok: true; value: { items: unknown[] } })
              .value.items.length
          : 0;

        const firstBrowser = required(browser, "browser companion");
        firstBrowser.stop();
        firstBrowser.publish({
          category: "scene.update",
          payload: { uuid: "Scene.scene-0001", name: "The Observatory" },
          emittedAt: "2026-08-29T12:01:00.000Z",
          worldId: "lifecycle-world",
        });
        required(hookBridge, "hook bridge").close();
        await required(mcp, "MCP client").close();
        await required(bridge, "pipe bridge").close();
        await required(daemon, "host daemon").shutdown();
        mcp = undefined;
        bridge = undefined;
        daemon = undefined;
        browser = undefined;
        hookBridge = undefined;

        await startHost();
        const restartedClient = required(
          mcp as Awaited<ReturnType<typeof createMcpClient>> | undefined,
          "restarted MCP client",
        ).client;
        await waitFor(
          async () => {
            const timeline = await callTool(restartedClient, "foundry.intelligence.timeline", {
              connectionId: CONNECTION_ID,
              limit: 10,
            });
            return (timeline.events as unknown[]).length === 3;
          },
          "durable resume after host/browser/container restart",
        );
        const secondReplayResult = await required(
          daemon as Daemon | undefined,
          "restarted host daemon",
        ).companion.request(
          CONNECTION_ID,
          "documents.create",
          replayInput,
          replayRequestId,
        );
        expect(secondReplayResult).toEqual(firstReplayResult);
        const afterRestart = await documents.list({ type: "Actor" });
        expect(afterRestart.ok && afterRestart.value.items.length).toBe(countBeforeRestart);

        expect(
          (await callTool(restartedClient, "foundry.intelligence.changed-since", {
            connectionId: CONNECTION_ID,
            afterSequenceId: 0,
          })).events,
        ).toHaveLength(3);
        const context = await callTool(restartedClient, "foundry.intelligence.context", {
          connectionId: CONNECTION_ID,
          query: "clockwork observatory",
          maxEvents: 10,
          maxBytes: 32_768,
        });
        expect(context).toMatchObject({ version: 1, connectionId: CONNECTION_ID });
        expect((context.sourceEventIds as unknown[]).length).toBeGreaterThan(0);
      } finally {
        hookBridge?.close();
        browser?.stop();
        await mcp?.close().catch(() => undefined);
        await bridge?.close().catch(() => undefined);
        await daemon?.shutdown().catch(() => undefined);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
