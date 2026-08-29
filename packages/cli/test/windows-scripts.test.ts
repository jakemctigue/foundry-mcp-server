import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptsDir = path.join(repositoryRoot, "scripts", "windows");
const powershell = process.env["POWERSHELL_EXE"] ?? "pwsh.exe";

interface ScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScript(scriptName: string, args: string[]): ScriptResult {
  const result = spawnSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(scriptsDir, scriptName),
      ...args,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("Windows setup scripts (static safety)", () => {
  it("use literal paths, avoid HOME reassignment, and never invoke Docker", () => {
    for (const name of ["install.ps1", "pair.ps1", "uninstall.ps1"]) {
      const source = fs.readFileSync(path.join(scriptsDir, name), "utf8");
      expect(source, name).not.toMatch(/\$(?:HOME|home)\s*=/);
      expect(source, name).not.toMatch(/(?:&|Start-Process)\s+docker(?:\.exe)?\b/i);
      expect(source, name).not.toContain("docker.exe");
      expect(source, name).toContain("-LiteralPath");
    }
    expect(fs.readFileSync(path.join(scriptsDir, "install.ps1"), "utf8")).toContain(
      ".foundry-mcp-install-manifest.json",
    );
    expect(fs.readFileSync(path.join(scriptsDir, "uninstall.ps1"), "utf8")).toMatch(
      /Refusing to remove unrecognized module directory/,
    );
  });
});

describe.runIf(process.platform === "win32")("Windows setup scripts (process integration)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tmpDir(label: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fmcp-${label}-Ω-`));
    dirs.push(dir);
    return dir;
  }

  function moduleFixture(): string {
    const source = tmpDir("module-source");
    fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(source, "module.json"),
      JSON.stringify({ id: "foundry-mcp", title: "Foundry MCP", version: "0.1.0" }),
    );
    fs.writeFileSync(path.join(source, "scripts", "main.js"), "export const ready = true;\n");
    return source;
  }

  function createZip(source: string): string {
    const zipDir = tmpDir("zip-output");
    const zipPath = path.join(zipDir, "foundry-mcp.zip");
    const result = spawnSync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Compress-Archive -Path (Join-Path $env:FMCP_TEST_SOURCE '*') -DestinationPath $env:FMCP_TEST_ZIP -Force",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, FMCP_TEST_SOURCE: source, FMCP_TEST_ZIP: zipPath },
      },
    );
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);
    return zipPath;
  }

  it("installs a zip idempotently into a Docker bind path and preserves unowned files", () => {
    const source = moduleFixture();
    const zipPath = createZip(source);
    const userData = tmpDir("Foundry User Data");
    const args = [
      "-FoundryUserDataPath",
      userData,
      "-ModuleSourcePath",
      zipPath,
      "-Layout",
      "DockerBindMount",
    ];

    const first = runScript("install.ps1", args);
    expect(first.status, first.stderr).toBe(0);
    const second = runScript("install.ps1", args);
    expect(second.status, second.stderr).toBe(0);

    const target = path.join(userData, "Data", "modules", "foundry-mcp");
    const ownershipPath = path.join(target, ".foundry-mcp-install-manifest.json");
    const ownership = JSON.parse(fs.readFileSync(ownershipPath, "utf8")) as {
      layout: string;
      files: unknown[];
    };
    expect(ownership.layout).toBe("DockerBindMount");
    expect(ownership.files).toHaveLength(2);

    const unowned = path.join(target, "user-note.txt");
    fs.writeFileSync(unowned, "preserve me");
    const uninstall = runScript("uninstall.ps1", ["-FoundryUserDataPath", userData]);
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(fs.existsSync(path.join(target, "module.json"))).toBe(false);
    expect(fs.readFileSync(unowned, "utf8")).toBe("preserve me");
    expect(fs.existsSync(ownershipPath)).toBe(true);

    const repeated = runScript("uninstall.ps1", ["-FoundryUserDataPath", userData]);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(fs.readFileSync(unowned, "utf8")).toBe("preserve me");
  }, 30000);

  it("refuses unrecognized directories and hash-mismatched owned files", () => {
    const userData = tmpDir("uninstall-safety");
    const target = path.join(userData, "Data", "modules", "foundry-mcp");
    fs.mkdirSync(target, { recursive: true });
    const unowned = path.join(target, "world-data.txt");
    fs.writeFileSync(unowned, "never delete");

    const unknown = runScript("uninstall.ps1", ["-FoundryUserDataPath", userData]);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toMatch(/Refusing to remove unrecognized/);
    expect(fs.readFileSync(unowned, "utf8")).toBe("never delete");

    fs.rmSync(target, { recursive: true, force: true });
    const source = moduleFixture();
    const installed = runScript("install.ps1", [
      "-FoundryUserDataPath",
      userData,
      "-ModuleSourcePath",
      source,
    ]);
    expect(installed.status, installed.stderr).toBe(0);
    const mainFile = path.join(target, "scripts", "main.js");
    fs.writeFileSync(mainFile, "user modified content");
    const modified = runScript("uninstall.ps1", ["-FoundryUserDataPath", userData]);
    expect(modified.status).not.toBe(0);
    expect(modified.stderr).toMatch(/hash no longer matches/);
    expect(fs.readFileSync(mainFile, "utf8")).toBe("user modified content");
  }, 30000);

  it("rotates a DPAPI secret and prints a secret-free MCP configuration", () => {
    const appData = tmpDir("pairing");
    const args = [
      "-AppDataPath",
      appData,
      "-AdapterCommand",
      "node",
      "-AdapterArguments",
      "C:\\Tools Ω\\foundry-mcp-adapter.js",
    ];
    const first = runScript("pair.ps1", args);
    expect(first.status, first.stderr).toBe(0);
    const match = first.stdout.match(/Pairing secret \(shown once[^)]*\): ([A-Z2-7]+)/);
    expect(match).not.toBeNull();
    const displaySecret = match?.[1] ?? "";
    expect(displaySecret.length).toBeGreaterThan(40);
    expect(first.stdout.split(displaySecret)).toHaveLength(2);

    const jsonStart = first.stdout.indexOf("{");
    const config = JSON.parse(first.stdout.slice(jsonStart)) as {
      mcpServers: { "foundry-vtt": { command: string; args: string[] } };
    };
    expect(config.mcpServers["foundry-vtt"].command).toBe("node");
    expect(JSON.stringify(config)).not.toContain(displaySecret);

    const secretPath = path.join(appData, "secrets", "pairing.secret");
    const protectedBlob = fs.readFileSync(secretPath);
    expect(protectedBlob.includes(Buffer.from(displaySecret, "utf8"))).toBe(false);

    const second = runScript("pair.ps1", args);
    expect(second.status, second.stderr).toBe(0);
    const nextSecret = second.stdout.match(/Pairing secret \(shown once[^)]*\): ([A-Z2-7]+)/)?.[1];
    expect(nextSecret).toBeTruthy();
    expect(nextSecret).not.toBe(displaySecret);
  }, 30000);

  it("detects Windows without relying on the OS environment variable", () => {
    const appData = tmpDir("pairing-no-os-env");
    const previousOs = process.env["OS"];
    try {
      delete process.env["OS"];
      const result = runScript("pair.ps1", ["-AppDataPath", appData]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/Pairing secret \(shown once/);
    } finally {
      if (previousOs === undefined) delete process.env["OS"];
      else process.env["OS"] = previousOs;
    }
  }, 30000);
});
