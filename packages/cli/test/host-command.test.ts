import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Daemon, StartDaemonOptions } from "@foundry-mcp/host";
import { resolveHostLaunch, runHostCommand } from "../src/host-command.js";

function signalHarness(): {
  source: {
    once: (event: "SIGINT" | "SIGTERM", listener: () => void) => void;
    removeListener: (event: "SIGINT" | "SIGTERM", listener: () => void) => void;
  };
  emit: (event: "SIGINT" | "SIGTERM") => void;
} {
  const listeners = new Map<string, () => void>();
  return {
    source: {
      once: (event, listener) => {
        listeners.set(event, listener);
      },
      removeListener: (event, listener) => {
        if (listeners.get(event) === listener) listeners.delete(event);
      },
    },
    emit: (event) => {
      const listener = listeners.get(event);
      listeners.delete(event);
      listener?.();
    },
  };
}

describe("host command", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-mcp-host-command-"));
    tempDirs.push(dir);
    return dir;
  }

  it("applies config file then environment then CLI precedence", () => {
    const appDataDir = tempDir();
    const fileAssetRoot = path.join(appDataDir, "file-assets");
    const envAssetRoot = path.join(appDataDir, "env-assets");
    const cliAssetRoot = path.join(appDataDir, "cli-assets");
    const configPath = path.join(appDataDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        port: 3101,
        pipeName: "from-file",
        logLevel: "warn",
        allowedOrigins: ["https://file.example.test"],
        localAssetRoots: [fileAssetRoot],
      }),
    );

    const launch = resolveHostLaunch(
      {
        appDataDir,
        port: "3103",
        logLevel: "debug",
        allowedOrigins: ["https://cli.example.test", "https://cli.example.test/"],
        localAssetRoots: [cliAssetRoot, cliAssetRoot],
      },
      {
        FOUNDRY_MCP_PORT: "3102",
        FOUNDRY_MCP_PIPE_NAME: "from-env",
        FOUNDRY_MCP_LOG_LEVEL: "error",
        FOUNDRY_MCP_ALLOWED_ORIGINS: "https://env.example.test",
        FOUNDRY_MCP_LOCAL_ASSET_ROOTS: envAssetRoot,
      },
    );

    expect(launch).toMatchObject({ appDataDir, configPath });
    expect(launch.config).toMatchObject({
      port: 3103,
      pipeName: "from-env",
      logLevel: "debug",
      allowedOrigins: ["https://cli.example.test"],
      localAssetRoots: [cliAssetRoot],
    });
  });

  it("uses safe defaults when the app-data config file is absent", () => {
    const launch = resolveHostLaunch({ appDataDir: tempDir(), allowedOrigins: [] }, {});
    expect(launch.config.port).toBe(0);
    expect(launch.config.capturePrivateContent).toBe(false);
    expect(launch.config.allowedOrigins).toEqual([
      "http://localhost:30000",
      "http://127.0.0.1:30000",
    ]);
    expect(launch.config.localAssetRoots).toEqual([]);
    expect(launch.configPath).toBeUndefined();
  });

  it.each([
    [{ port: "65536", allowedOrigins: [] }, {}, /--port.*0 through 65535/],
    [{ pipeName: "../escape", allowedOrigins: [] }, {}, /--pipe-name/],
    [
      { allowedOrigins: ["https://foundry.example.test/world"] },
      {},
      /scheme, host, and optional port/,
    ],
    [{ allowedOrigins: [] }, { FOUNDRY_MCP_PORT: "3.5" }, /FOUNDRY_MCP_PORT.*integer/],
    [
      { allowedOrigins: [] },
      { FOUNDRY_MCP_ALLOWED_ORIGINS: "https://good.example.test,*" },
      /FOUNDRY_MCP_ALLOWED_ORIGINS.*exact http/,
    ],
    [
      { allowedOrigins: [], localAssetRoots: ["relative/assets"] },
      {},
      /--allow-local-asset-root.*absolute filesystem path/,
    ],
    [
      { allowedOrigins: [] },
      { FOUNDRY_MCP_LOCAL_ASSET_ROOTS: "relative/assets" },
      /FOUNDRY_MCP_LOCAL_ASSET_ROOTS.*absolute filesystem path/,
    ],
  ])("rejects invalid CLI or environment host configuration", (options, env, expected) => {
    expect(() => resolveHostLaunch({ appDataDir: tempDir(), ...options }, env)).toThrow(
      expected as RegExp,
    );
  });

  it("rejects invalid typed file values even when a higher-precedence source exists", () => {
    const appDataDir = tempDir();
    fs.writeFileSync(path.join(appDataDir, "config.json"), JSON.stringify({ port: "3100" }));
    expect(() => resolveHostLaunch({ appDataDir, port: "3200", allowedOrigins: [] }, {})).toThrow(
      /host config file\.port.*integer/,
    );
  });

  it("rejects relative local asset roots from the config file", () => {
    const appDataDir = tempDir();
    fs.writeFileSync(
      path.join(appDataDir, "config.json"),
      JSON.stringify({ localAssetRoots: ["relative/assets"] }),
    );
    expect(() => resolveHostLaunch({ appDataDir, allowedOrigins: [] }, {})).toThrow(
      /host config file\.localAssetRoots.*absolute filesystem path/,
    );
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "shuts the daemon down exactly once on %s and keeps readiness on stderr",
    async (signal) => {
      const appDataDir = tempDir();
      const signals = signalHarness();
      let received: StartDaemonOptions | undefined;
      let shutdownCount = 0;
      let notifyStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const stderr: string[] = [];
      const daemon = {
        companionEndpoint: "ws://127.0.0.1:3210",
        pipePath: "named-pipe-test",
        shutdown: async () => {
          shutdownCount += 1;
        },
      } as unknown as Daemon;

      const running = runHostCommand(
        { appDataDir, allowedOrigins: ["http://127.0.0.1:30000"] },
        {
          env: {},
          signalSource: signals.source,
          writeStderr: (line) => stderr.push(line),
          start: async (options) => {
            received = options;
            notifyStarted?.();
            return daemon;
          },
        },
      );
      await started;
      signals.emit(signal);
      signals.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
      await running;

      expect(shutdownCount).toBe(1);
      expect(received?.appDataDir).toBe(appDataDir);
      expect(received?.cliConfig?.allowedOrigins).toEqual(["http://127.0.0.1:30000"]);
      expect(stderr.join("")).toMatch(/"event":"host\.ready"/);
      expect(stderr.join("")).toContain("named-pipe-test");
    },
  );

  it("surfaces graceful shutdown failure as a host error", async () => {
    const signals = signalHarness();
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const running = runHostCommand(
      { appDataDir: tempDir(), allowedOrigins: [] },
      {
        env: {},
        signalSource: signals.source,
        writeStderr: () => undefined,
        start: async () => {
          notifyStarted?.();
          return {
            companionEndpoint: "ws://127.0.0.1:3210",
            pipePath: "named-pipe-test",
            shutdown: async () => {
              throw new Error("close failed");
            },
          } as unknown as Daemon;
        },
      },
    );
    await started;
    signals.emit("SIGINT");
    await expect(running).rejects.toThrow(/host shutdown failed: close failed/);
  });
});
