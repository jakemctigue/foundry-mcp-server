import { describe, expect, it } from "vitest";
import { Connection, ConnectionsListOutput } from "../src/connection.js";
import { Capability, CapabilitiesGetOutput } from "../src/capability.js";

describe("Connection schema", () => {
  it("accepts a valid connection", () => {
    const result = Connection.safeParse({
      connectionId: "c1",
      worldId: "w1",
      worldTitle: "Test World",
      status: "connected",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid status", () => {
    const result = Connection.safeParse({
      connectionId: "c1",
      worldId: "w1",
      worldTitle: "Test World",
      status: "banana",
    });
    expect(result.success).toBe(false);
  });

  it("ConnectionsListOutput accepts an empty array", () => {
    const result = ConnectionsListOutput.safeParse({ connections: [] });
    expect(result.success).toBe(true);
  });
});

describe("Capability schema", () => {
  it("accepts a valid capability", () => {
    const result = Capability.safeParse({ name: "documents", version: "1.0.0", readOnly: true });
    expect(result.success).toBe(true);
  });

  it("CapabilitiesGetOutput requires protocolVersion", () => {
    const result = CapabilitiesGetOutput.safeParse({ capabilities: [] });
    expect(result.success).toBe(false);
  });
});
