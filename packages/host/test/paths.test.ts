import { describe, expect, it } from "vitest";
import { resolveAppDataDir } from "../src/paths.js";

describe("resolveAppDataDir", () => {
  it("returns a path under LOCALAPPDATA on win32", () => {
    const result = resolveAppDataDir({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      homedir: () => "C:\\Users\\test",
    });
    expect(result).toContain("AppData");
    expect(result).toContain("foundry-mcp");
  });

  it("falls back to APPDATA on win32 when LOCALAPPDATA is unset", () => {
    const result = resolveAppDataDir({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
      homedir: () => "C:\\Users\\test",
    });
    expect(result).toContain("Roaming");
  });

  it("returns a documented non-Windows fallback under the home directory", () => {
    const result = resolveAppDataDir({
      platform: "linux",
      env: {},
      homedir: () => "/home/test",
    });
    expect(result).toContain("/home/test");
    expect(result).toContain("foundry-mcp");
  });

  it("respects XDG_DATA_HOME on linux when set", () => {
    const result = resolveAppDataDir({
      platform: "linux",
      env: { XDG_DATA_HOME: "/custom/data" },
      homedir: () => "/home/test",
    });
    expect(result).toBe("/custom/data/foundry-mcp");
  });

  it("returns a documented macOS fallback under Application Support", () => {
    const result = resolveAppDataDir({
      platform: "darwin",
      env: {},
      homedir: () => "/Users/test",
    });
    expect(result).toBe("/Users/test/Library/Application Support/foundry-mcp");
  });
});
