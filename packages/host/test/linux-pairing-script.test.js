import { describe, expect, it } from "vitest";
import { parsePairingArguments } from "../../../scripts/linux/pair.mjs";

describe("Linux pairing bootstrap arguments", () => {
  it("requires explicit input and private output locations", () => {
    expect(
      parsePairingArguments([
        "--app-data",
        "/var/lib/foundry-mcp",
        "--output-file",
        "/run/private/pairing-code",
      ]),
    ).toEqual({
      appDataDir: "/var/lib/foundry-mcp",
      outputFile: "/run/private/pairing-code",
    });
  });

  it.each([
    [],
    ["--app-data", "/var/lib/foundry-mcp"],
    ["--output-file", "/run/private/code"],
    ["--app-data", "/x", "--app-data", "/y"],
    ["--show-secret"],
    ["--app-data", "--output-file", "/x"],
    ["--key", "never-accept-secret-arguments"],
  ])("rejects missing/duplicate options and secret-printing flags", (args) => {
    expect(() => parsePairingArguments(args)).toThrow();
  });
});
