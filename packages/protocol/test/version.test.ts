import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSIONS } from "../src/version.js";

describe("PROTOCOL_VERSION", () => {
  it("is pinned to the installed MCP SDK's LATEST_PROTOCOL_VERSION", () => {
    expect(PROTOCOL_VERSION).toBe("2025-11-25");
  });

  it("declares at least one legacy compatible version", () => {
    expect(LEGACY_PROTOCOL_VERSIONS.length).toBeGreaterThan(0);
    expect(LEGACY_PROTOCOL_VERSIONS).toContain("2025-06-18");
  });
});
