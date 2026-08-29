import { describe, expect, it } from "vitest";
import { parseCommandLine } from "../src/command-line.js";

describe("CLI argument parser", () => {
  it("parses every host scalar and preserves repeatable exact origins", () => {
    expect(
      parseCommandLine([
        "host",
        "--app-data",
        "C:/runtime",
        "--config",
        "C:/runtime/config.json",
        "--port",
        "3210",
        "--pipe-name",
        "desktop",
        "--log-level",
        "debug",
        "--allow-origin",
        "http://127.0.0.1:30000",
        "--allow-origin",
        "https://foundry.example.test",
      ]),
    ).toEqual({
      command: "host",
      options: {
        appDataDir: "C:/runtime",
        configPath: "C:/runtime/config.json",
        port: "3210",
        pipeName: "desktop",
        logLevel: "debug",
        allowedOrigins: ["http://127.0.0.1:30000", "https://foundry.example.test"],
      },
    });
  });

  it.each([
    [["host", "--unknown"], /unknown flag: --unknown/],
    [["host", "--port", "1", "--port", "2"], /--port may only be specified once/],
    [["host", "--port"], /--port requires a value/],
    [["host", "unexpected"], /unexpected positional argument/],
    [["doctor", "--json", "--json"], /--json may only be specified once/],
    [["build-module", "--version=1.0.0"], /unknown flag/],
  ])("rejects malformed invocation %j", (argv, expected) => {
    expect(() => parseCommandLine(argv as string[])).toThrow(expected as RegExp);
  });

  it("rejects mutually exclusive desktop and Docker doctor paths", () => {
    expect(() =>
      parseCommandLine([
        "doctor",
        "--foundry-data",
        "C:/Foundry",
        "--docker-data",
        "C:/DockerFoundry",
      ]),
    ).toThrow(/mutually exclusive/);
  });

  it("requires explicit capability targets without broad list filters", () => {
    expect(parseCommandLine(["capabilities", "list", "--connection-id", "world:user"])).toEqual({
      command: "capabilities",
      options: {
        action: "list",
        connectionId: "world:user",
        json: false,
      },
    });
    expect(() =>
      parseCommandLine(["capabilities", "grant", "--connection-id", "world:user"]),
    ).toThrow(/requires --role and --capability/);
    expect(() =>
      parseCommandLine([
        "capabilities",
        "list",
        "--connection-id",
        "world:user",
        "--role",
        "GAMEMASTER",
      ]),
    ).toThrow(/does not accept/);
  });

  it("accepts only provider actions that never take a secret flag", () => {
    expect(parseCommandLine(["provider", "configure", "--app-data", "C:/runtime"])).toEqual({
      command: "provider",
      options: { action: "configure", appDataDir: "C:/runtime", json: false },
    });
    expect(() =>
      parseCommandLine(["provider", "configure", "--api-key", "must-not-be-an-argument"]),
    ).toThrow(/unknown flag: --api-key/);
  });
});
