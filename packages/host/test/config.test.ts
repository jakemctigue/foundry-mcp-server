import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig precedence", () => {
  it("CLI value wins over env and file", () => {
    const config = resolveConfig(
      { pipeName: "from-file" },
      { FOUNDRY_MCP_PIPE_NAME: "from-env" },
      { pipeName: "from-cli" },
    );
    expect(config.pipeName).toBe("from-cli");
  });

  it("env wins over file when no CLI value is set", () => {
    const config = resolveConfig(
      { pipeName: "from-file" },
      { FOUNDRY_MCP_PIPE_NAME: "from-env" },
      {},
    );
    expect(config.pipeName).toBe("from-env");
  });

  it("file wins over default when no CLI or env value is set", () => {
    const config = resolveConfig({ pipeName: "from-file" }, {}, {});
    expect(config.pipeName).toBe("from-file");
  });

  it("falls back to the built-in default", () => {
    const config = resolveConfig({}, {}, {});
    expect(config.pipeName).toBe("foundry-mcp");
    expect(config.capturePrivateContent).toBe(false);
    expect(config.eventRetentionDays).toBe(30);
    expect(config.eventCategories).toContain("chat.public");
    expect(config.eventCategories).not.toContain("chat.private");
    expect(config.localAssetRoots).toEqual([]);
  });

  it("parses event capture and retention environment settings", () => {
    const config = resolveConfig(
      {},
      {
        FOUNDRY_MCP_EVENT_CATEGORIES: "document.create, combat ,chat.private",
        FOUNDRY_MCP_CAPTURE_PRIVATE_CONTENT: "yes",
        FOUNDRY_MCP_EVENT_RETENTION_DAYS: "14",
      },
    );
    expect(config.eventCategories).toEqual(["document.create", "combat", "chat.private"]);
    expect(config.capturePrivateContent).toBe(true);
    expect(config.eventRetentionDays).toBe(14);
  });

  it("parses local asset roots without splitting Windows drive letters", () => {
    const config = resolveConfig(
      { localAssetRoots: ["C:/from-file"] },
      { FOUNDRY_MCP_LOCAL_ASSET_ROOTS: "C:/from-env;D:/also-env" },
      {},
    );
    expect(config.localAssetRoots).toEqual(["C:/from-env", "D:/also-env"]);
  });
});
