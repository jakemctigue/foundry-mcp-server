import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "@foundry-mcp/host";
import {
  formatDoctorJson,
  formatDoctorText,
  runDoctor,
  type CheckResult,
  type DoctorOptions,
} from "../src/doctor.js";

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
      pipeProbe: async () => true,
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
      pipeProbe: async () => false,
      providerEnv: {},
    });
    const byId = index(results);
    expect(byId["bridge-endpoint"]?.status).toBe("FAIL");
    expect(byId["bridge-endpoint"]?.message).toMatch(/mixed content/i);
    expect(byId["origin-allowlist"]?.status).toBe("FAIL");
    expect(byId["origin-allowlist"]?.hint).toBeTruthy();
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
      pipeProbe: async () => true,
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
      pipeProbe: async () => false,
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
      pipeProbe: async () => false,
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
      pipeProbe: async () => false,
      providerEnv: {},
    });
    const configResult = results.find((result) => result.id === "config");
    expect(configResult?.status).toBe("FAIL");
    expect(configResult?.hint).toBeTruthy();
  });

  it.runIf(process.platform === "win32")(
    "never executes an icacls.exe planted in the working directory or PATH",
    async () => {
      const appDataDir = tmpDir("trusted-icacls-app-");
      const attackerDir = tmpDir("fake-icacls-");
      const markerPath = path.join(attackerDir, "fake-icacls-executed.txt");
      const configPath = path.join(attackerDir, "config.cjs");
      fs.copyFileSync(process.execPath, path.join(attackerDir, "icacls.exe"));
      fs.writeFileSync(
        configPath,
        `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed");`,
      );

      const originalCwd = process.cwd();
      const originalPath = process.env["PATH"];
      let results: CheckResult[];
      try {
        process.chdir(attackerDir);
        process.env["PATH"] = `${attackerDir}${path.delimiter}${originalPath ?? ""}`;
        results = await runDoctor({
          appDataDir,
          configPath,
          pipeProbe: async () => false,
          providerEnv: {},
        });
      } finally {
        process.chdir(originalCwd);
        if (originalPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = originalPath;
      }

      expect(fs.existsSync(markerPath)).toBe(false);
      expect(["OK", "WARN"]).toContain(index(results)["config-permissions"]?.status);
    },
  );

  it.runIf(process.platform === "win32")(
    "fails closed when the trusted System32 icacls.exe is unavailable",
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
          pipeProbe: async () => false,
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
      pipeProbe: async () => false,
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
      pipeProbe: async () => false,
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
