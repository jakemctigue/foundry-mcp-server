import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSIONS } from "../src/version.js";

describe("PROTOCOL_VERSION", () => {
  it("is pinned to 2026-07-28", () => {
    expect(PROTOCOL_VERSION).toBe("2026-07-28");
  });

  it("declares at least one legacy compatible version", () => {
    expect(LEGACY_PROTOCOL_VERSIONS.length).toBeGreaterThan(0);
    expect(LEGACY_PROTOCOL_VERSIONS).toContain("2025-06-18");
  });
});
