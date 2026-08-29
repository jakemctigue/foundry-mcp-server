import { describe, expect, it } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  LEGACY_MCP_PROTOCOL_VERSIONS,
  MCP_PROTOCOL_VERSION,
} from "../src/version.js";

describe("protocol revisions", () => {
  it("pins the modern MCP wire revision", () => {
    expect(MCP_PROTOCOL_VERSION).toBe("2026-07-28");
  });

  it("declares the legacy MCP revisions covered by conformance tests", () => {
    expect(LEGACY_MCP_PROTOCOL_VERSIONS).toEqual([
      "2025-11-25",
      "2025-06-18",
      "2025-03-26",
      "2024-11-05",
      "2024-10-07",
    ]);
  });

  it("keeps the private bridge revision independent from MCP", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe("3");
    expect(BRIDGE_PROTOCOL_VERSION).not.toBe(MCP_PROTOCOL_VERSION);
    expect(LEGACY_MCP_PROTOCOL_VERSIONS).not.toContain(BRIDGE_PROTOCOL_VERSION);
  });
});
