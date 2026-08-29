import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  type ImageGenerationProvider,
  type JsonValue,
} from "@foundry-mcp/protocol";

import { createLocalImageLoader, type LocalImageLoader } from "../src/assets/local-file.js";
import type { HostCompanionServer } from "../src/bridge/companion-server.js";
import { HostBridgeRouter } from "../src/bridge/router.js";
import { openDatabase, runMigrations } from "../src/db/index.js";
import { ImageProviderRegistry } from "../src/providers/images.js";
import { setCapabilityGrant, type RequestedCapability } from "../src/security/policy.js";

const CONNECTION_ID = "local-assets:gm";
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

interface RouterResponse {
  id?: string;
  result: {
    ok: boolean;
    error?: { code: string; message: string; details?: Record<string, unknown> };
    value?: unknown;
  };
}

interface Harness {
  db: ReturnType<typeof openDatabase>;
  request: ReturnType<typeof vi.fn>;
  router: HostBridgeRouter;
}

function createHarness(
  localImageLoader?: LocalImageLoader,
  imageProviders?: ImageProviderRegistry,
  urlImporter?: ConstructorParameters<typeof HostBridgeRouter>[3],
): Harness {
  const db = openDatabase(":memory:");
  runMigrations(db);
  const request = vi.fn(async (): Promise<JsonValue> => ({
    ok: true,
    value: {
      assetPath: "art/accepted.png",
      source: "data",
      mimeType: "image/png",
      size: PNG_BYTES.length,
      collision: "created",
    },
  }));
  const companion = {
    address: () => ({ host: "127.0.0.1", port: 1, endpoint: "ws://127.0.0.1:1" }),
    listConnections: () => [
      {
        type: "hello" as const,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        connectionId: CONNECTION_ID,
        worldId: "local-assets",
        worldTitle: "Local Assets",
        foundryVersion: "14.0",
        foundryUserRole: "GAMEMASTER" as const,
        currentUser: { id: "gm-a", name: "Game Master", role: "GAMEMASTER" as const },
        system: { id: "dnd5e", version: "5.1.0" },
        activeModules: [{ id: "foundry-mcp", version: "0.1.0" }],
        moduleCapabilities: ["assets.read", "assets.write"],
        status: "connected" as const,
        lastSeenAt: "2026-08-29T00:00:00.000Z",
      },
    ],
    request,
    close: async () => undefined,
  } as HostCompanionServer;
  return {
    db,
    request,
    router: new HostBridgeRouter(
      db,
      companion,
      imageProviders,
      urlImporter,
      undefined,
      localImageLoader,
    ),
  };
}

function grant(db: Harness["db"], ...capabilities: RequestedCapability[]): void {
  for (const requestedCapability of capabilities) {
    setCapabilityGrant(
      db,
      {
        connectionId: CONNECTION_ID,
        foundryUserRole: "GAMEMASTER",
        requestedCapability,
      },
      true,
    );
  }
}

function mutation(
  method: "assets.images.upload" | "assets.images.attach" | "assets.images.generate",
  requestedCapability: "assets:upload" | "assets:attach",
  params: Record<string, unknown>,
): Record<string, unknown> {
  return {
    method,
    params: { connectionId: CONNECTION_ID, ...params },
    authorization: {
      connectionId: CONNECTION_ID,
      requestedCapability,
      tool: `foundry.${method}`,
      correlationId: `test-${method}`,
    },
  };
}

async function handleMutation(
  router: HostBridgeRouter,
  params: Record<string, unknown>,
): Promise<RouterResponse> {
  return new Promise((resolve) => {
    router.handle({ id: "request-1", method: "mutation.execute", params }, (response) => {
      resolve(response as RouterResponse);
    });
  });
}

function auditJson(db: Harness["db"]): string {
  const row = db.prepare("SELECT details_json FROM audit_log ORDER BY id DESC LIMIT 1").get() as
    { details_json: string } | undefined;
  return row?.details_json ?? "";
}

describe("host-local image routing", () => {
  const tempDirs: string[] = [];
  const databases: Harness["db"][] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function tempDir(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(directory);
    return directory;
  }

  function harness(
    loader?: LocalImageLoader,
    imageProviders?: ImageProviderRegistry,
    urlImporter?: ConstructorParameters<typeof HostBridgeRouter>[3],
  ): Harness {
    const value = createHarness(loader, imageProviders, urlImporter);
    databases.push(value.db);
    return value;
  }

  function writePng(directory: string, name = "image.png"): string {
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, PNG_BYTES);
    return filePath;
  }

  it("denies file sources by default without reading or forwarding the local path", async () => {
    const root = tempDir("foundry-mcp-local-deny-");
    const filePath = writePng(root);
    const runtime = harness();
    grant(runtime.db, "assets:upload");

    const response = await handleMutation(
      runtime.router,
      mutation("assets.images.upload", "assets:upload", {
        sourceId: "data",
        destinationPath: "art/denied.png",
        onCollision: "error",
        source: { kind: "file", path: filePath },
      }),
    );

    expect(response.result).toMatchObject({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        details: { localFileCode: "DISABLED" },
      },
    });
    expect(runtime.request).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain(filePath);
    expect(auditJson(runtime.db)).not.toContain(filePath);
  });

  it("reads a valid image inside an allowed root and forwards only base64 bytes", async () => {
    const root = tempDir("foundry-mcp-local-success-");
    const filePath = writePng(root);
    const runtime = harness(createLocalImageLoader({ allowedRoots: [root] }));
    grant(runtime.db, "assets:upload");

    const response = await handleMutation(
      runtime.router,
      mutation("assets.images.upload", "assets:upload", {
        sourceId: "data",
        destinationPath: "art/accepted.png",
        onCollision: "error",
        source: { kind: "file", path: filePath, mimeType: "image/png" },
      }),
    );

    expect(response.result.ok).toBe(true);
    expect(runtime.request).toHaveBeenCalledOnce();
    const [, method, forwarded] = runtime.request.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(method).toBe("assets.images.upload");
    expect(forwarded["source"]).toEqual({
      kind: "base64",
      data: PNG_BYTES.toString("base64"),
      mimeType: "image/png",
    });
    expect(JSON.stringify(forwarded)).not.toContain(filePath);
    const audit = auditJson(runtime.db);
    expect(audit).not.toContain(filePath);
    expect(audit).not.toContain(PNG_BYTES.toString("base64"));
  });

  it("rejects a path outside every allowed root with a path-free structured error", async () => {
    const root = tempDir("foundry-mcp-local-root-");
    const outside = tempDir("foundry-mcp-local-outside-");
    const filePath = writePng(outside);
    const runtime = harness(createLocalImageLoader({ allowedRoots: [root] }));
    grant(runtime.db, "assets:upload");

    const response = await handleMutation(
      runtime.router,
      mutation("assets.images.upload", "assets:upload", {
        destinationPath: "art/outside.png",
        source: { kind: "file", path: filePath },
      }),
    );

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: "INVALID_DATA", details: { localFileCode: "OUTSIDE_ROOT" } },
    });
    expect(runtime.request).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain(filePath);
    expect(auditJson(runtime.db)).not.toContain(filePath);
  });

  it("rejects a symbolic link or Windows junction before reading its target", async () => {
    const root = tempDir("foundry-mcp-local-link-root-");
    const outside = tempDir("foundry-mcp-local-link-target-");
    writePng(outside);
    const linkPath = path.join(root, "linked");
    fs.symlinkSync(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
    const filePath = path.join(linkPath, "image.png");
    const runtime = harness(createLocalImageLoader({ allowedRoots: [root] }));
    grant(runtime.db, "assets:upload");

    const response = await handleMutation(
      runtime.router,
      mutation("assets.images.upload", "assets:upload", {
        destinationPath: "art/link.png",
        source: { kind: "file", path: filePath },
      }),
    );

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: "INVALID_DATA", details: { localFileCode: "REPARSE_POINT" } },
    });
    expect(runtime.request).not.toHaveBeenCalled();
  });

  it("rejects a file that is exactly one byte above the configured limit", async () => {
    const root = tempDir("foundry-mcp-local-size-");
    const filePath = writePng(root);
    const runtime = harness(
      createLocalImageLoader({ allowedRoots: [root], maxBytes: PNG_BYTES.length - 1 }),
    );
    grant(runtime.db, "assets:upload");

    const response = await handleMutation(
      runtime.router,
      mutation("assets.images.upload", "assets:upload", {
        destinationPath: "art/large.png",
        source: { kind: "file", path: filePath },
      }),
    );

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: "INVALID_DATA", details: { localFileCode: "SIZE_LIMIT" } },
    });
    expect(runtime.request).not.toHaveBeenCalled();
  });

  it("rejects a declared MIME type that disagrees with image magic bytes", async () => {
    const root = tempDir("foundry-mcp-local-mime-");
    const filePath = writePng(root);
    const runtime = harness(createLocalImageLoader({ allowedRoots: [root] }));
    grant(runtime.db, "assets:upload");

    const response = await handleMutation(
      runtime.router,
      mutation("assets.images.upload", "assets:upload", {
        destinationPath: "art/mismatch.png",
        source: { kind: "file", path: filePath, mimeType: "image/jpeg" },
      }),
    );

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: "INVALID_DATA", details: { localFileCode: "MIME_MISMATCH" } },
    });
    expect(runtime.request).not.toHaveBeenCalled();
  });

  it("resolves nested attach uploads on the host before forwarding to Foundry", async () => {
    const root = tempDir("foundry-mcp-local-attach-");
    const filePath = writePng(root);
    const runtime = harness(createLocalImageLoader({ allowedRoots: [root] }));
    grant(runtime.db, "assets:attach", "assets:upload");

    const response = await handleMutation(
      runtime.router,
      mutation("assets.images.attach", "assets:attach", {
        documentUuid: "Actor.hero",
        fieldPath: "img",
        asset: {
          kind: "upload",
          sourceId: "data",
          destinationPath: "art/hero.png",
          onCollision: "error",
          source: { kind: "file", path: filePath },
        },
      }),
    );

    expect(response.result.ok).toBe(true);
    const [, method, forwarded] = runtime.request.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(method).toBe("assets.images.attach");
    expect(forwarded).toMatchObject({
      asset: {
        kind: "upload",
        source: {
          kind: "base64",
          data: PNG_BYTES.toString("base64"),
          mimeType: "image/png",
        },
      },
    });
    expect(JSON.stringify(forwarded)).not.toContain(filePath);
    expect(auditJson(runtime.db)).not.toContain(filePath);
  });

  it("does not read an allowed local file before capability authorization succeeds", async () => {
    const loader = vi.fn<LocalImageLoader>(async () => ({
      bytes: PNG_BYTES,
      mimeType: "image/png",
    }));
    const runtime = harness(loader);

    const response = await handleMutation(
      runtime.router,
      mutation("assets.images.upload", "assets:upload", {
        destinationPath: "art/no-grant.png",
        source: { kind: "file", path: "C:/sensitive/image.png" },
      }),
    );

    expect(response.result.error?.code).toBe("PERMISSION_DENIED");
    expect(loader).not.toHaveBeenCalled();
    expect(runtime.request).not.toHaveBeenCalled();
    expect(auditJson(runtime.db)).not.toContain("C:/sensitive/image.png");
  });

  it("requires upload and network grants before importing a URL attachment", async () => {
    const urlImporter = vi.fn<NonNullable<ConstructorParameters<typeof HostBridgeRouter>[3]>>(
      async (url) => ({
        bytes: PNG_BYTES,
        mimeType: "image/png",
        finalUrl: url,
      }),
    );
    const runtime = harness(undefined, undefined, urlImporter);
    grant(runtime.db, "assets:attach", "assets:upload");
    const request = mutation("assets.images.attach", "assets:attach", {
      documentUuid: "Actor.hero",
      fieldPath: "img",
      asset: {
        kind: "url",
        url: "https://example.test/hero.png",
        sourceId: "data",
        destinationPath: "art/hero.png",
        onCollision: "error",
      },
    });

    const denied = await handleMutation(runtime.router, request);

    expect(denied.result).toMatchObject({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        details: { missingCapability: "ai:network", connectionId: CONNECTION_ID },
      },
    });
    expect(urlImporter).not.toHaveBeenCalled();
    expect(runtime.request).not.toHaveBeenCalled();

    grant(runtime.db, "ai:network");
    const allowed = await handleMutation(runtime.router, request);

    expect(allowed.result.ok).toBe(true);
    expect(urlImporter).toHaveBeenCalledOnce();
    expect(runtime.request).toHaveBeenCalledOnce();
    expect(runtime.request.mock.calls[0]?.[2]).toMatchObject({
      asset: {
        kind: "upload",
        source: { kind: "base64", data: PNG_BYTES.toString("base64"), mimeType: "image/png" },
      },
    });
  });

  it("requires ai:network before invoking a network image provider", async () => {
    const generate = vi.fn<ImageGenerationProvider["generate"]>(async () => ({
      bytes: PNG_BYTES,
      mimeType: "image/png",
      model: "network-test-v1",
    }));
    const providers = new ImageProviderRegistry().register({
      id: "network-test",
      requiresNetwork: true,
      generate,
    });
    const runtime = harness(undefined, providers);
    grant(runtime.db, "assets:upload");

    const denied = await handleMutation(
      runtime.router,
      mutation("assets.images.generate", "assets:upload", {
        prompt: "Do not send this prompt",
        provider: "network-test",
        options: {},
        sourceId: "data",
        destinationPath: "art/network.png",
        onCollision: "error",
      }),
    );

    expect(denied.result).toMatchObject({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        details: { missingCapability: "ai:network", connectionId: CONNECTION_ID },
      },
    });
    expect(generate).not.toHaveBeenCalled();
    expect(runtime.request).not.toHaveBeenCalled();

    grant(runtime.db, "ai:network");
    const allowed = await handleMutation(
      runtime.router,
      mutation("assets.images.generate", "assets:upload", {
        prompt: "An authorized network prompt",
        provider: "network-test",
        options: {},
        sourceId: "data",
        destinationPath: "art/network.png",
        onCollision: "error",
      }),
    );
    expect(allowed.result.ok).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    expect(runtime.request).toHaveBeenCalledOnce();
  });

  it("keeps deterministic local generation behind assets:upload without ai:network", async () => {
    const runtime = harness();
    grant(runtime.db, "assets:upload");

    const response = await handleMutation(
      runtime.router,
      mutation("assets.images.generate", "assets:upload", {
        prompt: "A deterministic local rune",
        provider: "deterministic",
        options: {},
        sourceId: "data",
        destinationPath: "art/local.png",
        onCollision: "error",
      }),
    );

    expect(response.result.ok).toBe(true);
    expect(runtime.request).toHaveBeenCalledOnce();
    expect(runtime.request.mock.calls[0]?.[1]).toBe("assets.images.upload");
  });

  it("passes cancellation into a pending local image read", async () => {
    let observedSignal: AbortSignal | undefined;
    const loader = vi.fn<LocalImageLoader>(
      (_path, _requestedMaxBytes, signal) =>
        new Promise((_resolve, reject) => {
          observedSignal = signal;
          signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("cancelled local read"), { name: "AbortError" })),
            { once: true },
          );
        }),
    );
    const runtime = harness(loader);
    grant(runtime.db, "assets:upload");
    const respond = vi.fn();
    runtime.router.handle(
      {
        id: "cancel-local-read",
        method: "mutation.execute",
        params: mutation("assets.images.upload", "assets:upload", {
          destinationPath: "art/cancelled.png",
          source: { kind: "file", path: "C:/allowed/pending.png" },
        }),
      },
      respond,
    );
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    expect(observedSignal).toBeInstanceOf(AbortSignal);

    runtime.router.handle(
      {
        type: "request.cancel",
        id: "cancel-local-read",
        correlationId: "test-assets.images.upload",
        reason: "cancelled",
      },
      respond,
    );

    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith({
        id: "cancel-local-read",
        result: expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: "CANCELLED" }),
        }),
      }),
    );
    expect(observedSignal?.aborted).toBe(true);
    expect(runtime.request).not.toHaveBeenCalled();
  });
});
