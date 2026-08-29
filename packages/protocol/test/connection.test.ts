import { describe, expect, it } from "vitest";
import { Connection, ConnectionsListOutput } from "../src/connection.js";
import { Capability, CapabilitiesGetOutput } from "../src/capability.js";

const discovery = {
  currentUser: { id: "gm-a", name: "Game Master", role: "GAMEMASTER" as const },
  system: { id: "dnd5e", version: "5.1.0" },
  activeModules: [{ id: "foundry-mcp", version: "0.1.0" }],
  moduleCapabilities: ["documents.read", "documents.write"] as const,
};

describe("Connection schema", () => {
  it("accepts a valid connection", () => {
    const result = Connection.safeParse({
      connectionId: "c1",
      worldId: "w1",
      worldTitle: "Test World",
      status: "connected",
      ...discovery,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid status", () => {
    const result = Connection.safeParse({
      connectionId: "c1",
      worldId: "w1",
      worldTitle: "Test World",
      status: "banana",
      ...discovery,
    });
    expect(result.success).toBe(false);
  });

  it("strictly bounds and redacts discovery metadata", () => {
    expect(
      Connection.safeParse({
        connectionId: "c1",
        worldId: "w1",
        worldTitle: "Test World",
        status: "connected",
        ...discovery,
        currentUser: { ...discovery.currentUser, pairingSecret: "must-not-leak" },
      }).success,
    ).toBe(false);
    expect(
      Connection.safeParse({
        connectionId: "c1",
        worldId: "w1",
        worldTitle: "Test World",
        status: "connected",
        ...discovery,
        activeModules: [
          { id: "foundry-mcp", version: "0.1.0" },
          { id: "foundry-mcp", version: "0.2.0" },
        ],
      }).success,
    ).toBe(false);
    expect(
      Connection.safeParse({
        connectionId: "c1",
        worldId: "w1",
        worldTitle: "Test World",
        status: "connected",
        ...discovery,
        currentUser: { ...discovery.currentUser, name: "GM\nsecret" },
      }).success,
    ).toBe(false);
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
