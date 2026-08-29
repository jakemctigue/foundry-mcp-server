import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCapabilityCommand } from "../src/capability-command.js";

describe("local capability administration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function appDataDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-mcp-capabilities-"));
    tempDirs.push(dir);
    return dir;
  }

  it("grants, lists, and revokes one explicit mutation capability", () => {
    const appData = appDataDir();
    const target = {
      appDataDir: appData,
      connectionId: "world-alpha:gm",
      role: "GAMEMASTER",
      capability: "documents:create",
      json: false,
    } as const;
    const granted = runCapabilityCommand(
      { ...target, action: "grant" },
      {},
      new Date("2026-08-29T15:00:00.000Z"),
    );
    expect(granted.changed).toEqual({
      role: "GAMEMASTER",
      capability: "documents:create",
      allowed: true,
      updatedAt: "2026-08-29T15:00:00.000Z",
    });
    expect(granted.grants).toEqual([granted.changed]);

    const listed = runCapabilityCommand(
      {
        action: "list",
        appDataDir: appData,
        connectionId: target.connectionId,
        json: true,
      },
      {},
    );
    expect(listed.grants).toEqual([granted.changed]);
    expect(listed.supportedCapabilities).not.toContain("read");

    const revoked = runCapabilityCommand(
      { ...target, action: "revoke" },
      {},
      new Date("2026-08-29T15:01:00.000Z"),
    );
    expect(revoked.changed).toMatchObject({ allowed: false });
    expect(revoked.grants).toEqual([revoked.changed]);
  });

  it("never broadens unknown, read-default, or role-restricted grants", () => {
    const appData = appDataDir();
    const base = {
      action: "grant" as const,
      appDataDir: appData,
      connectionId: "world-alpha:player",
      role: "PLAYER",
      json: false,
    };
    expect(() => runCapabilityCommand({ ...base, capability: "read" }, {})).toThrow(
      /--capability must be one of/,
    );
    expect(() => runCapabilityCommand({ ...base, capability: "shell:execute" }, {})).toThrow(
      /--capability must be one of/,
    );
    expect(() => runCapabilityCommand({ ...base, capability: "documents:create" }, {})).toThrow(
      /not supported for role PLAYER/,
    );
    expect(() =>
      runCapabilityCommand(
        {
          ...base,
          connectionId: "../all-connections",
          capability: "documents:create",
        },
        {},
      ),
    ).toThrow(/--connection-id/);
  });
});
