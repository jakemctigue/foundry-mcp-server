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
  });
});
