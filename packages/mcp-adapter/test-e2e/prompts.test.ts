import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client, type JSONRPCMessage } from "@modelcontextprotocol/client";
import { LEGACY_MCP_PROTOCOL_VERSIONS, MCP_PROTOCOL_VERSION } from "@foundry-mcp/protocol";
import { CapturingChildStdioTransport } from "./child-stdio-transport.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(packageDir, "dist", "cli.js");
const responseTimeoutMs = process.platform === "win32" ? 15_000 : 5_000;
const promptNames = [
  "foundry.campaign.briefing",
  "foundry.session.recap",
  "foundry.encounter.preparation",
  "foundry.npc.consistency",
  "foundry.changes.review",
] as const;
const promptArgumentNames: Readonly<Record<(typeof promptNames)[number], readonly string[]>> = {
  "foundry.campaign.briefing": ["connectionId", "sessionId", "query"],
  "foundry.session.recap": ["connectionId", "sessionId", "query"],
  "foundry.encounter.preparation": ["connectionId", "sceneUuid", "query"],
  "foundry.npc.consistency": ["connectionId", "npcUuid", "query"],
  "foundry.changes.review": ["connectionId", "afterSequenceId", "sessionId", "query"],
};

function expectProtocolOnly(transport: CapturingChildStdioTransport): void {
  expect(transport.stdoutLines.length).toBeGreaterThan(0);
  expect(transport.protocolErrors).toEqual([]);
  expect(transport.stderrText).toBe("");
  for (const line of transport.stdoutLines) {
    expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
  }
}

function waitForResponse(
  transport: CapturingChildStdioTransport,
  id: number,
  timeoutMs = responseTimeoutMs,
): Promise<JSONRPCMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for JSON-RPC response ${id.toString()}`)),
      timeoutMs,
    );
    transport.onmessage = (message) => {
      if ("id" in message && message.id === id) {
        clearTimeout(timeout);
        resolve(message);
      }
    };
  });
}

describe("modern prompt surface against the built adapter", () => {
  let client: Client | undefined;
  let transport: CapturingChildStdioTransport | undefined;

  afterEach(async () => {
    await client?.close();
    await transport?.close();
    client = undefined;
    transport = undefined;
  });

  it("lists and gets five bounded read-only prompts with protocol-only stdout", async () => {
    transport = new CapturingChildStdioTransport(cliEntry, packageDir);
    client = new Client(
      { name: "foundry-mcp-modern-prompts", version: "0.0.1" },
      { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
    );
    await client.connect(transport);

    const listed = await client.listPrompts();
    expect(listed.prompts.map(({ name }) => name).sort()).toEqual([...promptNames].sort());
    for (const prompt of listed.prompts) {
      if (!(prompt.name in promptArgumentNames))
        throw new Error(`unexpected prompt ${prompt.name}`);
      expect(prompt.arguments?.map(({ name }) => name).sort()).toEqual(
        [...promptArgumentNames[prompt.name as (typeof promptNames)[number]]].sort(),
      );
      expect(prompt.arguments?.find(({ name }) => name === "connectionId")).toMatchObject({
        required: true,
      });
    }

    const connectionId = "world-a:gm";
    const cases = [
      { name: promptNames[0], arguments: { connectionId, sessionId: "session-12" } },
      { name: promptNames[1], arguments: { connectionId, sessionId: "session-12" } },
      { name: promptNames[2], arguments: { connectionId, sceneUuid: "Scene.s1" } },
      { name: promptNames[3], arguments: { connectionId, npcUuid: "Actor.a1" } },
      { name: promptNames[4], arguments: { connectionId, afterSequenceId: "120" } },
    ] as const;

    for (const promptCase of cases) {
      const result = await client.getPrompt(promptCase);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({ role: "user", content: { type: "text" } });
      const content = result.messages[0]?.content;
      if (!content || content.type !== "text") throw new Error("prompt did not return text");
      expect(content.text).toContain(JSON.stringify(connectionId));
      expect(content.text).toContain(`foundry://world/${encodeURIComponent(connectionId)}`);
      expect(content.text).toMatch(/read-only/i);
      expect(content.text).toMatch(/untrusted data/i);
      expect(content.text).toMatch(/provenance/i);
      expect(content.text).toMatch(/grants no authority to mutate/i);
      expect(content.text.length).toBeLessThan(8000);
    }

    await client.close();
    client = undefined;
    expect(await transport.waitForExit()).toEqual({ code: 0, signal: null });
    expectProtocolOnly(transport);
  }, 30000);
});

describe.each([...LEGACY_MCP_PROTOCOL_VERSIONS])(
  "legacy MCP prompt handling %s",
  (protocolVersion) => {
    it("lists prompts, gets a bounded prompt, and returns structured invalid-params errors", async () => {
      const transport = new CapturingChildStdioTransport(cliEntry, packageDir);
      await transport.start();

      try {
        const initialized = waitForResponse(transport, 1);
        await transport.send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: "foundry-mcp-legacy-prompts", version: "0.0.1" },
          },
        });
        const initializeResponse = await initialized;
        expect(initializeResponse).toMatchObject({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion, capabilities: { prompts: expect.any(Object) } },
        });

        await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });

        const listed = waitForResponse(transport, 2);
        await transport.send({ jsonrpc: "2.0", id: 2, method: "prompts/list", params: {} });
        const listResponse = await listed;
        if (!("result" in listResponse)) throw new Error("prompts/list did not return a result");
        const names = (listResponse.result as { prompts: Array<{ name: string }> }).prompts
          .map(({ name }) => name)
          .sort();
        expect(names).toEqual([...promptNames].sort());

        const retrieved = waitForResponse(transport, 3);
        await transport.send({
          jsonrpc: "2.0",
          id: 3,
          method: "prompts/get",
          params: {
            name: "foundry.campaign.briefing",
            arguments: { connectionId: "legacy-world:gm", query: "recent changes" },
          },
        });
        const getResponse = await retrieved;
        if (!("result" in getResponse)) throw new Error("prompts/get did not return a result");
        expect(getResponse.result).toMatchObject({
          messages: [{ role: "user", content: { type: "text" } }],
        });

        const rejected = waitForResponse(transport, 4);
        await transport.send({
          jsonrpc: "2.0",
          id: 4,
          method: "prompts/get",
          params: { name: "foundry.campaign.briefing", arguments: { query: "missing scope" } },
        });
        const errorResponse = await rejected;
        if (!("error" in errorResponse)) {
          throw new Error("invalid legacy prompts/get did not return a JSON-RPC error");
        }
        expect(errorResponse.error).toMatchObject({ code: -32602 });
        expect(errorResponse.error.message).toMatch(/invalid|argument/i);

        const invalidArguments = [
          { connectionId: "legacy-world:gm", query: "x".repeat(513) },
          { connectionId: "legacy-world:gm", unexpected: "not-allowed" },
        ];
        for (const [index, arguments_] of invalidArguments.entries()) {
          const id = index + 5;
          const invalid = waitForResponse(transport, id);
          await transport.send({
            jsonrpc: "2.0",
            id,
            method: "prompts/get",
            params: { name: "foundry.campaign.briefing", arguments: arguments_ },
          });
          const invalidResponse = await invalid;
          if (!("error" in invalidResponse)) {
            throw new Error("out-of-bounds legacy prompts/get did not return an error");
          }
          expect(invalidResponse.error).toMatchObject({ code: -32602 });
        }
      } finally {
        await transport.close();
      }

      expect(await transport.waitForExit()).toEqual({ code: 0, signal: null });
      expectProtocolOnly(transport);
    }, 30000);
  },
);
