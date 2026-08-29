import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_PROTOCOL_VERSION, openDatabase, runMigrations } from "@foundry-mcp/host";
import {
  formatDoctorJson,
  formatDoctorText,
  probeDaemonPipe,
  runDoctor,
  sddlHasBroadAccess,
  type CheckResult,
  type DoctorPipeProbe,
  type DoctorOptions,
} from "../src/doctor.js";

const authenticatedPipeProbe: DoctorPipeProbe = async () => ({
  status: "authenticated",
  protocolVersion: BRIDGE_PROTOCOL_VERSION,
});
const offlinePipeProbe: DoctorPipeProbe = async () => ({ status: "offline" });

describe("doctor", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDir(suffix = ""): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fmcp-doctor-${suffix}`));
    dirs.push(dir);
    return dir;
  }

  function index(results: CheckResult[]): Record<string, CheckResult> {
    return Object.fromEntries(results.map((result) => [result.id, result]));
  }

  function initializeDatabase(databasePath: string): void {
    const db = openDatabase(databasePath);
    runMigrations(db);
    db.close();
  }

  it("detects broad allow ACEs from locale-independent SDDL trustees", () => {
    expect(sddlHasBroadAccess("O:SYG:SYD:(A;;FR;;;S-1-1-0)")).toBe(true);
    expect(sddlHasBroadAccess("O:SYG:SYD:(A;;FR;;;BU)")).toBe(true);
    expect(sddlHasBroadAccess("O:SYG:SYD:(A;;FR;;;AU)")).toBe(true);
    expect(sddlHasBroadAccess("O:SYG:SYD:(D;;FR;;;WD)(A;;FA;;;S-1-5-21-1-2-3-4)")).toBe(
      false,
    );
  });

  it("bounds authenticated protocol negotiation and closes an unresponsive client", async () => {
    let closed = false;
    const startedAt = Date.now();
    const outcome = await probeDaemonPipe("ignored", "ignored", {
      timeoutMs: 20,
      connect: async () => ({
        send: () => undefined,
        onMessage: () => undefined,
        onError: () => undefined,
        onClose: () => undefined,
        close: async () => {
          closed = true;
        },
      }),
    });

    expect(outcome).toEqual({ status: "rejected" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(closed).toBe(true);
  });

  it("closes a client that resolves after the authentication deadline", async () => {
    let closed = false;
    const outcome = await probeDaemonPipe("ignored", "ignored", {
      timeoutMs: 10,
      connect: () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                send: () => undefined,
                onMessage: () => undefined,
                onError: () => undefined,
                onClose: () => undefined,
                close: async () => {
                  closed = true;
                },
              }),
            30,
          );
        }),
    });

    expect(outcome).toEqual({ status: "rejected" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(true);
  });

  it("reports the full checklist healthy for an explicit Docker bind-mounted layout", async () => {
    const appDataDir = tmpDir("app-");
    const dockerUserDataPath = tmpDir("Foundry User Data Ω-");
    const databasePath = path.join(appDataDir, "doctor.db");
    initializeDatabase(databasePath);
    fs.writeFileSync(
      path.join(appDataDir, "status.json"),
      JSON.stringify({ activeConnections: 2 }),
    );

    const moduleDir = path.join(dockerUserDataPath, "Data", "modules", "foundry-mcp");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "module.json"),
      JSON.stringify({ id: "foundry-mcp", title: "Foundry MCP" }),
    );

    const configPath = path.join(appDataDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        dbPath: databasePath,
        dockerUserDataPath,
        bridgeUrl: "wss://bridge.example.test/foundry",
        foundryOrigin: "https://foundry.example.test",
        allowedOrigins: ["https://foundry.example.test"],
      }),
      { mode: 0o600 },
    );

    const results = await runDoctor({
      appDataDir,
      configPath,
      pipeProbe: authenticatedPipeProbe,
      providerEnv: { OPENAI_API_KEY: "configured-but-never-rendered" },
    });
    const byId = index(results);

    for (const id of [
      "config",
      "database",
      "migrations",
      "pipe",
      "active-connections",
      "docker-user-data",
      "foundry-module",
      "bridge-endpoint",
      "origin-allowlist",
      "provider",
    ]) {
      expect(byId[id]?.status, id).toBe("OK");
    }
    expect(["OK", "WARN"]).toContain(byId["config-permissions"]?.status);
  });

  it("detects HTTPS-to-ws mixed content and an origin missing from the allowlist", async () => {
    const appDataDir = tmpDir();
    const results = await runDoctor({
      appDataDir,
      databasePath: path.join(appDataDir, "missing.db"),
      bridgeUrl: "ws://127.0.0.1:3210/bridge",
      foundryOrigin: "https://foundry.example.test",
      allowedOrigins: ["https://other.example.test"],
      pipeProbe: offlinePipeProbe,
      providerEnv: {},
    });
    const byId = index(results);
    expect(byId["bridge-endpoint"]?.status).toBe("FAIL");
    expect(byId["bridge-endpoint"]?.message).toMatch(/mixed content/i);
    expect(byId["origin-allowlist"]?.status).toBe("FAIL");
    expect(byId["origin-allowlist"]?.hint).toBeTruthy();
  });

  it("uses the host env/config precedence for both the database and named pipe", async () => {
    const appDataDir = tmpDir("shared-host-config-");
    const fileDatabasePath = path.join(appDataDir, "file.db");
    const envDatabasePath = path.join(appDataDir, "env.db");
    initializeDatabase(envDatabasePath);
    const configPath = path.join(appDataDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ dbPath: fileDatabasePath, pipeName: "from-file" }),
      { mode: 0o600 },
    );
    let probedPipePath = "";

    const results = await runDoctor({
      appDataDir,
      configPath,
      pipeProbe: async (pipePath) => {
        probedPipePath = pipePath;
        return { status: "authenticated", protocolVersion: BRIDGE_PROTOCOL_VERSION };
      },
      providerEnv: {
        FOUNDRY_MCP_DB_PATH: envDatabasePath,
        FOUNDRY_MCP_PIPE_NAME: "from-env",
      },
    });

    expect(index(results)["database"]?.status).toBe("OK");
    expect(probedPipePath).toContain("foundry-mcp-");
    expect(probedPipePath).not.toContain("from-file");
    const defaultPipeResults = await runDoctor({
      appDataDir,
      databasePath: envDatabasePath,
      pipeProbe: async (pipePath) => {
        expect(pipePath).not.toBe(probedPipePath);
        return { status: "offline" };
      },
      providerEnv: {},
    });
    expect(index(defaultPipeResults)["pipe"]?.status).toBe("WARN");
  });

  it("inspects SQLite read-only and rejects unknown future migrations", async () => {
    const appDataDir = tmpDir("readonly-db-");
    const databasePath = path.join(appDataDir, "doctor.db");
    const db = openDatabase(databasePath);
    runMigrations(db);
    db.prepare("INSERT INTO schema_migrations (id, name) VALUES (?, ?)").run(
      999,
      "future-version",
    );
    db.pragma("journal_mode = DELETE");
    db.close();
    const headerBefore = fs.readFileSync(databasePath).subarray(18, 20);
    expect([...headerBefore]).toEqual([1, 1]);

    const results = await runDoctor({
      appDataDir,
      databasePath,
      pipeProbe: offlinePipeProbe,
      providerEnv: {},
    });

    expect(index(results)["database"]?.status).toBe("OK");
    expect(index(results)["migrations"]?.status).toBe("FAIL");
    expect(index(results)["migrations"]?.message).toMatch(/unknown|future/i);
    expect([...fs.readFileSync(databasePath).subarray(18, 20)]).toEqual([1, 1]);
    expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
  });

  it("rejects remote plaintext WebSockets and every invalid allowlist entry", async () => {
    const appDataDir = tmpDir("endpoint-hardening-");
    const remotePlaintext = index(
      await runDoctor({
        appDataDir,
        bridgeUrl: "ws://bridge.example.test/foundry",
        foundryOrigin: "http://foundry.example.test",
        allowedOrigins: ["http://foundry.example.test"],
        pipeProbe: offlinePipeProbe,
        providerEnv: {},
      }),
    );
    expect(remotePlaintext["bridge-endpoint"]?.status).toBe("FAIL");
    expect(remotePlaintext["bridge-endpoint"]?.message).toMatch(/plaintext|loopback|local/i);

    const invalidAllowlist = index(
      await runDoctor({
        appDataDir,
        bridgeUrl: "wss://bridge.example.test/foundry",
        foundryOrigin: "https://foundry.example.test",
        allowedOrigins: ["https://foundry.example.test", "*"],
        pipeProbe: offlinePipeProbe,
        providerEnv: {},
      }),
    );
    expect(invalidAllowlist["origin-allowlist"]?.status).toBe("FAIL");
    expect(invalidAllowlist["origin-allowlist"]?.message).toMatch(/invalid|wildcard/i);
  });

  it("reports a non-string config Origin as invalid instead of throwing", async () => {
    const appDataDir = tmpDir("invalid-origin-type-");
    const configPath = path.join(appDataDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        bridgeUrl: "wss://bridge.example.test/foundry",
        foundryOrigin: "https://foundry.example.test",
        allowedOrigins: ["https://foundry.example.test", 42],
      }),
    );

    const results = await runDoctor({
      appDataDir,
      configPath,
      pipeProbe: offlinePipeProbe,
      providerEnv: {},
    });

    expect(index(results)["origin-allowlist"]?.status).toBe("FAIL");
    expect(index(results)["origin-allowlist"]?.message).toMatch(/invalid/i);
  });

  it("does not treat a reachable pipe with a mismatched protocol as healthy", async () => {
    const appDataDir = tmpDir("pipe-version-");
    const results = await runDoctor({
      appDataDir,
      pipeProbe: async () => ({
        status: "authenticated",
        protocolVersion: "future-version",
      }),
      providerEnv: {},
    });

    expect(index(results)["pipe"]?.status).toBe("FAIL");
    expect(index(results)["pipe"]?.message).toMatch(/protocol|version/i);
  });

  it("reports failed migrations, malformed bridge status, module metadata, and Docker paths", async () => {
    const appDataDir = tmpDir("failures-");
    const databasePath = path.join(appDataDir, "unmigrated.db");
    const db = openDatabase(databasePath);
    db.exec("CREATE TABLE placeholder (id INTEGER PRIMARY KEY)");
    db.close();

    const foundryUserDataPath = tmpDir("invalid-module-");
    const moduleDir = path.join(foundryUserDataPath, "Data", "modules", "foundry-mcp");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, "module.json"), JSON.stringify({ id: "wrong-module" }));
    const statusPath = path.join(appDataDir, "status.json");
    fs.writeFileSync(statusPath, JSON.stringify({ activeConnections: "many" }));

    const results = await runDoctor({
      appDataDir,
      databasePath,
      foundryUserDataPath,
      bridgeUrl: "ws://127.0.0.1:3210/bridge",
      foundryOrigin: "http://127.0.0.1:30000",
      allowedOrigins: ["http://127.0.0.1:30000"],
      statusPath,
      pipeProbe: authenticatedPipeProbe,
      providerEnv: {},
    });
    const byId = index(results);
    expect(byId["database"]?.status).toBe("OK");
    for (const id of ["migrations", "active-connections", "foundry-module"]) {
      expect(byId[id]?.status, id).toBe("FAIL");
      expect(byId[id]?.hint, id).toBeTruthy();
    }
    expect(byId["bridge-endpoint"]?.status).toBe("OK");
    expect(byId["origin-allowlist"]?.status).toBe("OK");
    expect(byId["provider"]?.status).toBe("WARN");

    const missingDockerPath = path.join(appDataDir, "missing Docker bind path");
    const dockerResults = await runDoctor({
      appDataDir,
      dockerUserDataPath: missingDockerPath,
      pipeProbe: offlinePipeProbe,
      providerEnv: {},
    });
    const dockerCheck = index(dockerResults)["docker-user-data"];
    expect(dockerCheck?.status).toBe("FAIL");
    expect(dockerCheck?.hint).toMatch(/Docker need not be running|host-side/);
  });

  it("reports actionable warnings for an uninitialized offline installation", async () => {
    const appDataDir = tmpDir();
    const results = await runDoctor({
      appDataDir,
      pipeProbe: offlinePipeProbe,
      providerEnv: {},
    });
    const byId = index(results);
    for (const id of [
      "database",
      "migrations",
      "pipe",
      "active-connections",
      "foundry-module",
      "bridge-endpoint",
      "origin-allowlist",
      "provider",
    ]) {
      expect(byId[id]?.status, id).toBe("WARN");
      expect(byId[id]?.hint, id).toBeTruthy();
    }
  });

  it("reports a malformed config without throwing", async () => {
    const appDataDir = tmpDir();
    const configPath = path.join(appDataDir, "config.json");
    fs.writeFileSync(configPath, "{ this is not valid json");

    const results = await runDoctor({
      appDataDir,
      configPath,
      pipeProbe: offlinePipeProbe,
      providerEnv: {},
    });
    const configResult = results.find((result) => result.id === "config");
    expect(configResult?.status).toBe("FAIL");
    expect(configResult?.hint).toBeTruthy();
  });

  it.runIf(process.platform === "win32")(
    "never executes a PowerShell ACL inspector planted in the working directory or PATH",
    async () => {
      const appDataDir = tmpDir("trusted-acl-app-");
      const attackerDir = tmpDir("fake-powershell-");
      const markerPath = path.join(attackerDir, "fake-powershell-executed.txt");
      const preloadPath = path.join(attackerDir, "preload.cjs");
      const configPath = path.join(attackerDir, "config.json");
      fs.copyFileSync(process.execPath, path.join(attackerDir, "powershell.exe"));
      fs.writeFileSync(
        preloadPath,
        `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed");`,
      );
      fs.writeFileSync(configPath, JSON.stringify({ harmless: true }));

      const originalCwd = process.cwd();
      const originalPath = process.env["PATH"];
      const originalNodeOptions = process.env["NODE_OPTIONS"];
      let results: CheckResult[];
      try {
        process.chdir(attackerDir);
        process.env["PATH"] = `${attackerDir}${path.delimiter}${originalPath ?? ""}`;
        process.env["NODE_OPTIONS"] = `--require=${preloadPath}`;
        results = await runDoctor({
          appDataDir,
          configPath,
          pipeProbe: offlinePipeProbe,
          providerEnv: {},
        });
      } finally {
        process.chdir(originalCwd);
        if (originalPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = originalPath;
        if (originalNodeOptions === undefined) delete process.env["NODE_OPTIONS"];
        else process.env["NODE_OPTIONS"] = originalNodeOptions;
      }

      expect(fs.existsSync(markerPath)).toBe(false);
      expect(["OK", "WARN"]).toContain(index(results)["config-permissions"]?.status);
    },
  );

  it.runIf(process.platform === "win32")(
    "fails closed when the trusted System32 ACL inspector is unavailable",
    async () => {
      const appDataDir = tmpDir("missing-icacls-app-");
      const configPath = path.join(appDataDir, "config.json");
      fs.writeFileSync(configPath, JSON.stringify({ harmless: true }));

      const originalSystemRoot = process.env["SystemRoot"];
      let results: CheckResult[];
      try {
        process.env["SystemRoot"] = path.join(appDataDir, "missing-windows-root");
        results = await runDoctor({
          appDataDir,
          configPath,
          pipeProbe: offlinePipeProbe,
          providerEnv: {},
        });
      } finally {
        if (originalSystemRoot === undefined) delete process.env["SystemRoot"];
        else process.env["SystemRoot"] = originalSystemRoot;
      }

      const permissions = index(results)["config-permissions"];
      expect(permissions?.status).toBe("FAIL");
      expect(permissions?.message).toMatch(/trusted Windows ACL inspection tool is unavailable/i);
    },
  );

  it.runIf(process.platform === "win32")(
    "detects a broad ACL granted by well-known SID without localized principal names",
    async () => {
      const appDataDir = tmpDir("broad-sddl-app-");
      const configPath = path.join(appDataDir, "config.json");
      fs.writeFileSync(configPath, JSON.stringify({ harmless: true }));
      const systemRoot = process.env["SystemRoot"];
      if (!systemRoot) throw new Error("SystemRoot is unavailable");
      const icaclsPath = path.win32.join(systemRoot, "System32", "icacls.exe");
      const granted = spawnSync(icaclsPath, [configPath, "/grant", "*S-1-1-0:(R)"], {
        encoding: "utf8",
        timeout: 2_000,
        windowsHide: true,
      });
      expect(granted.status, granted.stderr).toBe(0);

      const results = await runDoctor({
        appDataDir,
        configPath,
        pipeProbe: offlinePipeProbe,
        providerEnv: {},
      });

      expect(index(results)["config-permissions"]?.status).toBe("WARN");
      expect(index(results)["config-permissions"]?.message).toMatch(/broad/i);
    },
  );

  it("never renders provider or URL credential secrets", async () => {
    const appDataDir = tmpDir();
    const configSecret = "config-secret-value";
    const envSecret = "provider-secret-value";
    const urlSecret = "url-password-value";
    const configPath = path.join(appDataDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ providerApiKey: configSecret, harmless: true }), {
      mode: 0o600,
    });

    const options: DoctorOptions = {
      appDataDir,
      configPath,
      bridgeUrl: `wss://user:${urlSecret}@bridge.example.test/bridge`,
      foundryOrigin: "https://foundry.example.test",
      allowedOrigins: ["https://foundry.example.test"],
      providerEnv: { OPENAI_API_KEY: envSecret },
      pipeProbe: offlinePipeProbe,
    };
    const results = await runDoctor(options);
    const output = `${formatDoctorText(results)}\n${formatDoctorJson(results)}`;
    expect(output).not.toContain(configSecret);
    expect(output).not.toContain(envSecret);
    expect(output).not.toContain(urlSecret);
    expect(output).toContain("values redacted");
  });

  it("formats fixed-width text tags and parseable JSON", async () => {
    const appDataDir = tmpDir();
    const results = await runDoctor({
      appDataDir,
      pipeProbe: offlinePipeProbe,
      providerEnv: {},
    });
    expect(formatDoctorText(results)).toMatch(/\[ OK \]|\[WARN\]|\[FAIL\]/);
    const parsed = JSON.parse(formatDoctorJson(results)) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(results.length);
    for (const item of parsed) {
      expect(typeof item["name"]).toBe("string");
      expect(typeof item["status"]).toBe("string");
      expect(typeof item["message"]).toBe("string");
    }
  });
});
