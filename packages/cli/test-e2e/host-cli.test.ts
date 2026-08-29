import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const HOST_ENVIRONMENT_KEYS = [
  "FOUNDRY_MCP_PORT",
  "FOUNDRY_MCP_PIPE_NAME",
  "FOUNDRY_MCP_LOG_LEVEL",
  "FOUNDRY_MCP_DB_PATH",
  "FOUNDRY_MCP_EVENT_CATEGORIES",
  "FOUNDRY_MCP_CAPTURE_PRIVATE_CONTENT",
  "FOUNDRY_MCP_EVENT_RETENTION_DAYS",
  "FOUNDRY_MCP_ALLOWED_ORIGINS",
] as const;

function isolatedEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !HOST_ENVIRONMENT_KEYS.includes(key as (typeof HOST_ENVIRONMENT_KEYS)[number]),
      ),
    ),
    NODE_ENV: "test",
  };
}

function runCli(args: readonly string[], input?: string) {
  return spawnSync(
    process.execPath,
    [path.resolve(import.meta.dirname, "../dist/bin.js"), ...args],
    {
      encoding: "utf8",
      env: isolatedEnvironment(),
      ...(input === undefined ? {} : { input }),
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
      windowsHide: true,
    },
  );
}

describe("built host CLI child process", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed without a pairing secret and never writes host output to stdout", () => {
    const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-mcp-host-child-"));
    tempDirs.push(appDataDir);
    const result = runCli([
      "host",
      "--app-data",
      appDataDir,
      "--port",
      "0",
      "--allow-origin",
      "http://127.0.0.1:30000",
    ]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/companion pairing secret is missing/i);
    expect(result.stderr).not.toMatch(/[a-z2-7]{40,}/i);
  });

  it("rejects an unknown host flag before starting runtime state", () => {
    const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-mcp-host-parser-"));
    tempDirs.push(appDataDir);
    const result = runCli(["host", "--app-data", appDataDir, "--not-a-host-option", "value"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/unknown flag: --not-a-host-option/);
    expect(fs.readdirSync(appDataDir)).toEqual([]);
  });

  it("configures, reports, and removes the provider key through stdin without rendering it", () => {
    const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-mcp-provider-child-"));
    tempDirs.push(appDataDir);
    const secret = "sk-child-provider-value-that-never-renders";
    const common = ["--app-data", appDataDir] as const;
    const configured = runCli(["provider", "configure", ...common], `${secret}\n`);
    expect(configured.error).toBeUndefined();
    expect(configured.status).toBe(0);
    expect(`${configured.stdout}\n${configured.stderr}`).not.toContain(secret);
    expect(configured.stdout).toMatch(/configured/i);

    const status = runCli(["provider", "status", "--json", ...common]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      provider: "openai-images",
      configured: true,
    });
    expect(`${status.stdout}\n${status.stderr}`).not.toContain(secret);

    const removed = runCli(["provider", "remove", ...common]);
    expect(removed.status).toBe(0);
    expect(`${removed.stdout}\n${removed.stderr}`).not.toContain(secret);
    const after = runCli(["provider", "status", "--json", ...common]);
    expect(JSON.parse(after.stdout)).toMatchObject({ configured: false });
  });

  it("persists only one explicitly targeted mutation capability", () => {
    const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-mcp-capability-child-"));
    tempDirs.push(appDataDir);
    const connection = "child-world:gm";
    const target = ["--app-data", appDataDir, "--connection-id", connection] as const;
    const granted = runCli([
      "capabilities",
      "grant",
      ...target,
      "--role",
      "GAMEMASTER",
      "--capability",
      "assets:upload",
      "--json",
    ]);
    expect(granted.status).toBe(0);
    expect(JSON.parse(granted.stdout)).toMatchObject({
      connectionId: connection,
      changed: { capability: "assets:upload", allowed: true },
    });
    const listed = runCli(["capabilities", "list", ...target, "--json"]);
    const listResult = JSON.parse(listed.stdout) as { grants: unknown[] };
    expect(listResult.grants).toHaveLength(1);

    const deniedBroadening = runCli([
      "capabilities",
      "grant",
      ...target,
      "--role",
      "GAMEMASTER",
      "--capability",
      "read",
    ]);
    expect(deniedBroadening.status).toBe(1);
    expect(deniedBroadening.stderr).toMatch(/--capability must be one of/);
    const after = JSON.parse(runCli(["capabilities", "list", ...target, "--json"]).stdout) as {
      grants: unknown[];
    };
    expect(after.grants).toHaveLength(1);
  });
});
