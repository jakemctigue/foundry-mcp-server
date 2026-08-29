import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@foundry-mcp/protocol";
import { createHelloMessage, isCompatibleHello } from "../src/handshake.js";

describe("module handshake hello message", () => {
  it("stamps the current protocol version", () => {
    const hello = createHelloMessage("world-1");
    expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(hello.worldId).toBe("world-1");
  });

  it("accepts a hello with the matching protocol version", () => {
    expect(isCompatibleHello(createHelloMessage("world-1"))).toBe(true);
  });

  it("rejects a hello with a mismatched protocol version", () => {
    expect(
      isCompatibleHello({ type: "hello", protocolVersion: "2020-01-01", worldId: "world-1" }),
    ).toBe(false);
  });
});
