import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BridgeAuthenticator,
  HostBridgeRouter,
  PermissionDeniedError,
  assertAllowedWebSocketOrigin,
  openDatabase,
  runAuthorizedOperation,
  runMigrations,
  setCapabilityGrant,
  type HostCompanionServer,
} from "@foundry-mcp/host";
import { createLocalImageLoader } from "@foundry-mcp/host/assets/local-file";
import {
  UrlImportError,
  importImageUrl,
} from "@foundry-mcp/host/assets/url-import";
import {
  ImageProviderError,
  ImageProviderRegistry,
} from "@foundry-mcp/host/providers/images";
import { BRIDGE_PROTOCOL_VERSION, type JsonValue } from "@foundry-mcp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FoundryAssetService,
  FoundryDocumentService,
  validateCompanionEndpoint,
} from "../../foundry-module/src/index.js";
import {
  FakeFoundryRuntime,
  FakeRole,
  createRichFakeRuntime,
} from "../../foundry-module/test/fake-runtime/index.js";
import {
  VALID_PNG,
  createFakeAssetRuntime,
} from "../../foundry-module/test/fake-runtime/assets.js";

function encoded(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function companionFixture(options: {
  connectionId: string;
  role: "PLAYER" | "GAMEMASTER";
  request: ReturnType<typeof vi.fn>;
}): HostCompanionServer {
  return {
    address: () => ({ host: "127.0.0.1", port: 0, endpoint: "ws://127.0.0.1:0" }),
    listConnections: () => [
      {
        type: "hello",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        connectionId: options.connectionId,
        worldId: options.connectionId,
        worldTitle: options.connectionId,
        foundryVersion: "14.0.0",
        foundryUserRole: options.role,
        status: "connected",
        lastSeenAt: "2026-08-29T12:00:00.000Z",
      },
    ],
    request: options.request as HostCompanionServer["request"],
    close: () => Promise.resolve(),
  };
}

async function routed(
  router: HostBridgeRouter,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) =>
    router.handle({ id: "security-request", method, params }, (response) => {
      resolve(response as Record<string, unknown>);
    }),
  );
}

describe("MOCKED FOUNDRY security E2E: filesystem and image validation", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects traversal, oversized data, malicious SVG, and archive/decompression payloads with no upload", async () => {
    const runtime = createRichFakeRuntime();
    const assets = createFakeAssetRuntime();
    const documents = new FoundryDocumentService(runtime);
    const service = new FoundryAssetService(assets, documents, runtime, {
      maxImageBytes: VALID_PNG.byteLength - 1,
    });
    for (const [destinationPath, bytes, mimeType] of [
      ["../escape.png", VALID_PNG, "image/png"],
      ["tokens/oversized.png", VALID_PNG, "image/png"],
      ["tokens/script.png", Buffer.from('<svg onload="fetch(\'/secret\')"></svg>'), "image/svg+xml"],
      ["tokens/archive.png", Buffer.from("PK\u0003\u0004decompression-bomb"), "application/zip"],
    ] as const) {
      await expect(
        service.upload({
          destinationPath,
          source: { kind: "base64", data: encoded(bytes), mimeType },
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_DATA" } });
    }
    expect(assets.uploadCalls).toBe(0);
  });

  it("rejects symlink and junction escapes before reading a local image", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-mcp-security-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-mcp-security-outside-"));
    temporaryDirectories.push(root, outside);
    fs.writeFileSync(path.join(outside, "outside.png"), VALID_PNG);
    const link = path.join(root, "linked-outside");
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    const loader = createLocalImageLoader({ allowedRoots: [root] });

    await expect(loader(path.join(link, "outside.png"))).rejects.toThrow(
      /symbolic link|junction|outside configured roots/i,
    );
  });

  it("blocks SSRF before a fetch and keeps the provider-off path explicit with no fallback", async () => {
    const fetch = vi.fn();
    await expect(
      importImageUrl("http://127.0.0.1/private.png", {
        fetch,
        resolve: () => Promise.resolve(["127.0.0.1"]),
      }),
    ).rejects.toMatchObject({ code: "SSRF_BLOCKED" } satisfies Partial<UrlImportError>);
    expect(fetch).not.toHaveBeenCalled();

    const registry = new ImageProviderRegistry().markUnavailable(
      "openai",
      "OpenAI Images is disabled in this security fixture",
    );
    await expect(registry.generate("must not fall back", {}, "openai")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    } satisfies Partial<ImageProviderError>);
    expect(registry.list()).toEqual([
      {
        id: "openai",
        available: false,
        reason: "OpenAI Images is disabled in this security fixture",
      },
    ]);
  });
});

describe("MOCKED FOUNDRY security E2E: transport, replay, and origin", () => {
  it("rejects replayed and oversized authenticated messages before dispatch", () => {
    const key = crypto.randomBytes(32);
    const session = crypto.randomBytes(32);
    const signer = new BridgeAuthenticator(key, {
      session,
      signDirection: "client-to-server",
      verifyDirection: "server-to-client",
    });
    const verifier = new BridgeAuthenticator(key, {
      session,
      signDirection: "server-to-client",
      verifyDirection: "client-to-server",
    });
    const envelope = signer.sign({ method: "documents.list", params: {} });
    expect(verifier.verify(envelope)).toMatchObject({ ok: true });
    expect(verifier.verify(envelope)).toEqual({
      ok: false,
      reason: "replayed authenticated bridge envelope",
    });
    expect(() => signer.sign({ payload: "x".repeat(16 * 1024 * 1024 + 1) })).toThrow(
      "authenticated payload limit",
    );
  });

  it("requires a strict ws/wss endpoint and an exact non-wildcard module Origin", () => {
    expect(validateCompanionEndpoint("ws://127.0.0.1:31337")).toBe(
      "ws://127.0.0.1:31337/",
    );
    for (const endpoint of [
      "http://127.0.0.1:31337",
      "ws://user:password@127.0.0.1:31337",
      "ws://127.0.0.1:31337/#fragment",
    ]) {
      expect(() => validateCompanionEndpoint(endpoint)).toThrow();
    }
    expect(() => assertAllowedWebSocketOrigin(undefined, ["http://127.0.0.1:30000"])).toThrow(
      "required",
    );
    expect(() => assertAllowedWebSocketOrigin("http://evil.invalid", ["*"])).toThrow(
      "wildcard",
    );
    expect(() =>
      assertAllowedWebSocketOrigin("http://evil.invalid", ["http://127.0.0.1:30000"]),
    ).toThrow("not allowed");
  });
});

describe("MOCKED FOUNDRY security E2E: world, role, permission, and secrets", () => {
  const databases: Array<ReturnType<typeof openDatabase>> = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function database() {
    const db = openDatabase(":memory:");
    runMigrations(db);
    databases.push(db);
    return db;
  }

  it("rejects a wrong-world mutation without calling the Foundry companion", async () => {
    const request = vi.fn<HostCompanionServer["request"]>();
    const router = new HostBridgeRouter(
      database(),
      companionFixture({ connectionId: "world-a", role: "GAMEMASTER", request }),
    );
    const response = await routed(router, "mutation.execute", {
      method: "documents.create",
      params: { connectionId: "world-a", type: "Actor", data: { name: "No side effect" } },
      authorization: {
        connectionId: "world-b",
        requestedCapability: "documents:create",
        tool: "foundry.documents.create",
        correlationId: "wrong-world-correlation",
      },
    });
    expect(response).toMatchObject({
      result: { ok: false, error: { code: "FOUNDRY_ERROR", message: expect.stringContaining("world-b") } },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("enforces both host role ceilings and Foundry Document permissions with no create", async () => {
    const db = database();
    const request = vi.fn<HostCompanionServer["request"]>();
    setCapabilityGrant(
      db,
      {
        connectionId: "player-world",
        foundryUserRole: "PLAYER",
        requestedCapability: "documents:create",
      },
      true,
    );
    const router = new HostBridgeRouter(
      db,
      companionFixture({ connectionId: "player-world", role: "PLAYER", request }),
    );
    const response = await routed(router, "mutation.execute", {
      method: "documents.create",
      params: { connectionId: "player-world", type: "Actor", data: { name: "Forbidden" } },
      authorization: {
        connectionId: "player-world",
        requestedCapability: "documents:create",
        tool: "foundry.documents.create",
        correlationId: "player-role-correlation",
      },
    });
    expect(response).toMatchObject({
      result: { ok: false, error: { code: "PERMISSION_DENIED" } },
    });
    expect(request).not.toHaveBeenCalled();

    const runtime = new FakeFoundryRuntime(FakeRole.PLAYER).registerDocumentType("Actor", {
      collection: "actors",
      minCreateRole: FakeRole.GAMEMASTER,
      subtypes: { hero: {} },
    });
    const service = new FoundryDocumentService(runtime);
    await expect(
      service.create({ type: "Actor", data: { name: "Still forbidden", type: "hero" } }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        committed: false,
        results: [{ status: "error", error: { code: "PERMISSION_DENIED" } }],
      },
    });
    await expect(service.list({ type: "Actor" })).resolves.toMatchObject({
      ok: true,
      value: { items: [] },
    });
  });

  it("redacts secrets from a structured denial audit and never invokes the operation", async () => {
    const db = database();
    const operation = vi.fn<() => Promise<JsonValue>>();
    await expect(
      runAuthorizedOperation(
        db,
        {
          connectionId: "ungranted-world",
          foundryUserRole: "GAMEMASTER",
          requestedCapability: "assets:upload",
          tool: "foundry.assets.images.upload",
          correlationId: "secret-redaction-correlation",
          auditDetails: {
            apiKey: "sk-must-not-leak",
            authorization: "Bearer must-not-leak",
          },
        },
        operation,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(operation).not.toHaveBeenCalled();
    const audit = db
      .prepare("SELECT outcome, details_json FROM audit_log WHERE correlation_id = ?")
      .get("secret-redaction-correlation") as { outcome: string; details_json: string };
    expect(audit.outcome).toBe("denied");
    expect(audit.details_json).not.toContain("sk-must-not-leak");
    expect(audit.details_json).not.toContain("Bearer must-not-leak");
    expect(audit.details_json).toContain("[REDACTED]");
  });
});
