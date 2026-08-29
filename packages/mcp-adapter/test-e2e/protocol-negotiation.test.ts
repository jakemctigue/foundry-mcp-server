import { describe, expect, it, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

// This test spawns the BUILT adapter as a real child process (not an
// in-memory transport) and drives the handshake with the SDK's own Client +
// StdioClientTransport, so it proves what the installed
// @modelcontextprotocol/sdk actually negotiates on the wire -- as opposed to
// asserting the PROTOCOL_VERSION constant in packages/protocol/src/version.ts,
// which governs the *private* host<->adapter bridge protocol, not the MCP
// wire protocol between this adapter and an MCP client.
const cliEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

describe("real MCP SDK protocol negotiation (child process)", () => {
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    transport = undefined;
  });

  it("negotiates a protocol version the SDK itself reports, captured from the raw initialize response", async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliEntry],
      stderr: "pipe",
    });

    let capturedFromWire: string | undefined;
    // Protocol.connect() (shared/protocol.js) wraps whatever onmessage handler
    // is already installed on the transport and still invokes it for every
    // inbound frame, so setting this before client.connect() lets us observe
    // the raw initialize response the SDK receives without hand-rolling the
    // JSON-RPC handshake ourselves.
    transport.onmessage = (message: JSONRPCMessage) => {
      if (
        "id" in message &&
        "result" in message &&
        message.result !== null &&
        typeof message.result === "object" &&
        "protocolVersion" in message.result
      ) {
        capturedFromWire = String((message.result as { protocolVersion: unknown }).protocolVersion);
      }
    };

    client = new Client({ name: "protocol-negotiation-e2e", version: "0.0.1" });

    await client.connect(transport);

    expect(capturedFromWire).toBeDefined();
    // Assert against the SDK's own negotiated value, never the bridge-side
    // PROTOCOL_VERSION constant -- that constant is a different protocol.
    expect(typeof capturedFromWire).toBe("string");
    expect(capturedFromWire).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 20000);

  it("fails loudly if the child process exits before completing the handshake", async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
      stderr: "pipe",
    });
    client = new Client({ name: "protocol-negotiation-e2e-failure", version: "0.0.1" });

    await expect(client.connect(transport)).rejects.toBeTruthy();
  }, 20000);
});
