import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  BRIDGE_PROTOCOL_VERSION,
  companionAuthPayload,
  type CompanionHelloMessage,
} from "@foundry-mcp/protocol";
import { startDaemon, type Daemon } from "../src/daemon.js";

const PAIRING_SECRET = Buffer.alloc(32, 23);

function readStatus(statusPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(statusPath, "utf8")) as Record<string, unknown>;
}

async function authenticate(socket: WebSocket, hello: CompanionHelloMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData): void => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message["type"] === "auth.challenge" && typeof message["challenge"] === "string") {
        socket.send(
          JSON.stringify({
            type: "auth.proof",
            hello,
            proof: createHmac("sha256", PAIRING_SECRET)
              .update(
                companionAuthPayload(message["challenge"], message["origin"] as string, hello),
                "utf8",
              )
              .digest("base64url"),
          }),
        );
      }
      if (message["type"] === "events.resume") {
        socket.off("message", onMessage);
        resolve();
      }
    };
    socket.on("message", onMessage);
    socket.once("error", reject);
  });
}

describe("daemon doctor status snapshot", () => {
  const tempDirs: string[] = [];
  let daemon: Daemon | undefined;
  let socket: WebSocket | undefined;
  let priorNodeEnv: string | undefined;

  afterEach(async () => {
    socket?.terminate();
    await daemon?.shutdown();
    daemon = undefined;
    socket = undefined;
    if (priorNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = priorNodeEnv;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("atomically reports start, authenticated connection changes, and graceful stop", async () => {
    priorNodeEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "test";
    const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-mcp-status-"));
    tempDirs.push(appDataDir);
    const pipeName = `status-${randomBytes(8).toString("hex")}`;
    const statusPath = path.join(appDataDir, "status.json");
    daemon = await startDaemon({
      appDataDir,
      companionPairingSecret: PAIRING_SECRET,
      cliConfig: {
        port: 0,
        pipeName,
        allowedOrigins: ["http://foundry.test"],
      },
    });

    expect(readStatus(statusPath)).toMatchObject({
      state: "running",
      activeConnections: 0,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    });
    socket = new WebSocket(daemon.companionEndpoint, { origin: "http://foundry.test" });
    await authenticate(socket, {
      type: "hello",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      connectionId: "status-world:gm",
      worldId: "status-world",
      worldTitle: "Status World",
      foundryVersion: "14.0",
      foundryUserRole: "GAMEMASTER",
    });
    await vi.waitFor(() => expect(readStatus(statusPath)["activeConnections"]).toBe(1));
    const serialized = fs.readFileSync(statusPath, "utf8");
    expect(serialized).not.toContain("Status World");
    expect(serialized).not.toContain("status-world:gm");

    socket.terminate();
    socket = undefined;
    await vi.waitFor(() => expect(readStatus(statusPath)["activeConnections"]).toBe(0));
    await daemon.shutdown();
    expect(readStatus(statusPath)).toMatchObject({ state: "stopped", activeConnections: 0 });
  });
});
