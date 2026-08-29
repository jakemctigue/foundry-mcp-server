import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptsDir = path.join(repositoryRoot, "scripts", "windows");
const powershell = process.env["POWERSHELL_EXE"] ?? "pwsh.exe";
const windowsPowerShell = path.win32.join(
  process.env["SystemRoot"] ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const requiredWindowsShells = [
  { label: "PowerShell 7", executable: "pwsh.exe" },
  { label: "Windows PowerShell 5.1", executable: windowsPowerShell },
] as const;

interface ScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface RawZipEntry {
  name: string;
  data?: Buffer | string;
  compression?: "store" | "deflate";
  declaredUncompressedSize?: number;
  externalAttributes?: number;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createRawZip(entries: RawZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data =
      typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : (entry.data ?? Buffer.alloc(0));
    const method = entry.compression === "deflate" ? 8 : 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const uncompressedSize = entry.declaredUncompressedSize ?? data.length;
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(entry.externalAttributes ?? ((0o100644 << 16) >>> 0), 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function runScriptWith(executable: string, scriptName: string, args: string[]): ScriptResult {
  const result = spawnSync(
    executable,
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

function runScript(scriptName: string, args: string[]): ScriptResult {
  return runScriptWith(powershell, scriptName, args);
}

function runPowerShellFile(
  executable: string,
  scriptPath: string,
  env: NodeJS.ProcessEnv,
): ScriptResult {
  const result = spawnSync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ],
    { encoding: "utf8", env, windowsHide: true },
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

describe.runIf(process.platform === "win32")(
  "Windows setup scripts (PS7 and PS5.1 hardening)",
  () => {
    for (const shell of requiredWindowsShells) {
      describe(shell.label, () => {
        const dirs: string[] = [];

        afterEach(() => {
          for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
        });

        function tmpDir(label: string): string {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fmcp-${label}-Ω-`));
          dirs.push(dir);
          return dir;
        }

        function moduleFixture(label: string, version: string, body: string): string {
          const source = tmpDir(label);
          fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
          fs.writeFileSync(
            path.join(source, "module.json"),
            JSON.stringify({ id: "foundry-mcp", title: "Foundry MCP", version }),
          );
          fs.writeFileSync(path.join(source, "scripts", "main.js"), body);
          return source;
        }

        it("makes WhatIf explicit without expansion, persistence, mutation, or success claims", () => {
          const userData = tmpDir("whatif-user-data");
          const invalidZip = path.join(tmpDir("whatif-zip"), "invalid.zip");
          fs.writeFileSync(invalidZip, "not a zip archive");
          const installWhatIf = runScriptWith(shell.executable, "install.ps1", [
            "-FoundryUserDataPath",
            userData,
            "-ModuleSourcePath",
            invalidZip,
            "-WhatIf",
          ]);
          expect(installWhatIf.status, installWhatIf.stderr).toBe(0);
          expect(`${installWhatIf.stdout}\n${installWhatIf.stderr}`).toMatch(/planned|what if/i);
          expect(installWhatIf.stdout).not.toMatch(/Installed module/i);
          expect(fs.existsSync(path.join(userData, "Data", "modules", "foundry-mcp"))).toBe(
            false,
          );

          const appData = path.join(tmpDir("whatif-pair-parent"), "app-data");
          const pairWhatIf = runScriptWith(shell.executable, "pair.ps1", [
            "-AppDataPath",
            appData,
            "-WhatIf",
          ]);
          expect(pairWhatIf.status, pairWhatIf.stderr).toBe(0);
          expect(`${pairWhatIf.stdout}\n${pairWhatIf.stderr}`).toMatch(/planned|what if/i);
          expect(pairWhatIf.stdout).not.toMatch(/Pairing secret|MCP client configuration/i);
          expect(fs.existsSync(path.join(appData, "secrets"))).toBe(false);

          const source = moduleFixture("whatif-uninstall-source", "1.0.0", "old-version\n");
          const installed = runScriptWith(shell.executable, "install.ps1", [
            "-FoundryUserDataPath",
            userData,
            "-ModuleSourcePath",
            source,
          ]);
          expect(installed.status, installed.stderr).toBe(0);
          const moduleFile = path.join(
            userData,
            "Data",
            "modules",
            "foundry-mcp",
            "scripts",
            "main.js",
          );
          const uninstallWhatIf = runScriptWith(shell.executable, "uninstall.ps1", [
            "-FoundryUserDataPath",
            userData,
            "-WhatIf",
          ]);
          expect(uninstallWhatIf.status, uninstallWhatIf.stderr).toBe(0);
          expect(`${uninstallWhatIf.stdout}\n${uninstallWhatIf.stderr}`).toMatch(/planned|what if/i);
          expect(uninstallWhatIf.stdout).not.toMatch(/Uninstalled owned files/i);
          expect(fs.readFileSync(moduleFile, "utf8")).toBe("old-version\n");
        }, 60000);

        it("rejects junction components before install, uninstall, or pairing mutation", () => {
          const source = moduleFixture("junction-source", "1.0.0", "safe\n");
          const userData = tmpDir("junction-user-data");
          const modulesRoot = path.join(userData, "Data", "modules");
          fs.mkdirSync(modulesRoot, { recursive: true });
          const outsideModule = tmpDir("junction-outside-module");
          const marker = path.join(outsideModule, "outside.txt");
          fs.writeFileSync(marker, "never mutate");
          fs.symlinkSync(outsideModule, path.join(modulesRoot, "foundry-mcp"), "junction");

          const install = runScriptWith(shell.executable, "install.ps1", [
            "-FoundryUserDataPath",
            userData,
            "-ModuleSourcePath",
            source,
          ]);
          expect(install.status).not.toBe(0);
          expect(install.stderr).toMatch(/reparse|junction/i);
          expect(fs.readFileSync(marker, "utf8")).toBe("never mutate");

          const uninstall = runScriptWith(shell.executable, "uninstall.ps1", [
            "-FoundryUserDataPath",
            userData,
          ]);
          expect(uninstall.status).not.toBe(0);
          expect(uninstall.stderr).toMatch(/reparse|junction/i);
          expect(fs.readFileSync(marker, "utf8")).toBe("never mutate");

          const appData = tmpDir("junction-pair-app-data");
          const outsideSecrets = tmpDir("junction-outside-secrets");
          fs.symlinkSync(outsideSecrets, path.join(appData, "secrets"), "junction");
          const pair = runScriptWith(shell.executable, "pair.ps1", [
            "-AppDataPath",
            appData,
          ]);
          expect(pair.status).not.toBe(0);
          expect(pair.stderr).toMatch(/reparse|junction/i);
          expect(fs.readdirSync(outsideSecrets)).toHaveLength(0);
        }, 60000);

        it("rejects hostile ZIP metadata before extraction and leaves the live module untouched", () => {
          const userData = tmpDir("zip-preflight-user-data");
          const oldSource = moduleFixture("zip-preflight-old", "1.0.0", "old-version\n");
          const initial = runScriptWith(shell.executable, "install.ps1", [
            "-FoundryUserDataPath",
            userData,
            "-ModuleSourcePath",
            oldSource,
          ]);
          expect(initial.status, initial.stderr).toBe(0);
          const target = path.join(userData, "Data", "modules", "foundry-mcp");
          const modulesRoot = path.dirname(target);
          const absoluteGuard = path.join(tmpDir("zip-absolute-guard"), "absolute.txt");
          const validEntries = (): RawZipEntry[] => [
            {
              name: "module.json",
              data: JSON.stringify({ id: "foundry-mcp", title: "Foundry MCP", version: "2.0.0" }),
            },
            { name: "scripts/main.js", data: "new-version\n" },
          ];
          const excessEntries = [
            ...validEntries(),
            ...Array.from({ length: 4095 }, (_, index) => ({
              name: `filler/${index.toString().padStart(4, "0")}.txt`,
            })),
          ];
          const totalDeclaredEntries = [
            ...validEntries(),
            ...Array.from({ length: 5 }, (_, index) => ({
              name: `declared/${index}.bin`,
              data: Buffer.alloc(700_000),
              declaredUncompressedSize: 60 * 1024 * 1024,
            })),
          ];
          const cases: Array<{ name: string; entries: RawZipEntry[]; expected: RegExp }> = [
            {
              name: "traversal",
              entries: [...validEntries(), { name: "../escape.txt", data: "escape" }],
              expected: /traversal|parent segment/i,
            },
            {
              name: "absolute",
              entries: [
                ...validEntries(),
                { name: absoluteGuard.replaceAll("\\", "/"), data: "escape" },
              ],
              expected: /absolute/i,
            },
            {
              name: "alternate-data-stream",
              entries: [...validEntries(), { name: "module.json:payload", data: "stream" }],
              expected: /alternate data stream|colon/i,
            },
            {
              name: "symbolic-link",
              entries: [
                ...validEntries(),
                {
                  name: "link-to-outside",
                  data: "../outside",
                  externalAttributes: (0xa1ff << 16) >>> 0,
                },
              ],
              expected: /symbolic link|reparse/i,
            },
            {
              name: "reparse-point",
              entries: [
                ...validEntries(),
                {
                  name: "reparse.bin",
                  data: "reparse",
                  externalAttributes: (((0o100644 << 16) >>> 0) | 0x400) >>> 0,
                },
              ],
              expected: /reparse/i,
            },
            {
              name: "nested-archive",
              entries: [...validEntries(), { name: "payload.zip", data: "PK" }],
              expected: /nested archive/i,
            },
            {
              name: "entry-count",
              entries: excessEntries,
              expected: /entry count|too many entries/i,
            },
            {
              name: "path-depth",
              entries: [
                ...validEntries(),
                {
                  name: `${Array.from({ length: 25 }, (_, index) => `d${index}`).join("/")}/file.txt`,
                  data: "deep",
                },
              ],
              expected: /depth/i,
            },
            {
              name: "single-declared-size",
              entries: [
                ...validEntries(),
                {
                  name: "oversized.bin",
                  declaredUncompressedSize: 64 * 1024 * 1024 + 1,
                },
              ],
              expected: /declared|uncompressed.*limit|entry.*size/i,
            },
            {
              name: "total-declared-size",
              entries: totalDeclaredEntries,
              expected: /total.*declared|expanded.*limit|archive.*size/i,
            },
            {
              name: "compression-ratio",
              entries: [
                ...validEntries(),
                {
                  name: "compressed-bomb.bin",
                  data: Buffer.alloc(1024 * 1024),
                  compression: "deflate",
                },
              ],
              expected: /compression ratio/i,
            },
            {
              name: "expanded-size-mismatch",
              entries: [
                ...validEntries(),
                {
                  name: "lying-expanded-size.bin",
                  data: Buffer.alloc(1024, 0x41),
                  declaredUncompressedSize: 2048,
                },
              ],
              expected: /actual expanded byte count does not match its declaration/i,
            },
          ];
          const wrapper = path.join(tmpDir("zip-preflight-wrapper"), "guard-extraction.ps1");
          fs.writeFileSync(
            wrapper,
            [
              "$ErrorActionPreference = 'Stop'",
              "function global:Expand-Archive {",
              "  [CmdletBinding()] param([string]$LiteralPath, [string]$DestinationPath, [switch]$Force)",
              "  [IO.File]::WriteAllText($env:FMCP_EXPANSION_MARKER, 'called')",
              "  throw 'Unsafe extraction was attempted before ZIP preflight'",
              "}",
              "& $env:FMCP_INSTALL_SCRIPT -FoundryUserDataPath $env:FMCP_USER_DATA -ModuleSourcePath $env:FMCP_ZIP_PATH",
            ].join("\r\n"),
          );

          const validZipPath = path.join(tmpDir("zip-valid"), "valid.zip");
          fs.writeFileSync(validZipPath, createRawZip(validEntries()));
          const validInstall = runScriptWith(shell.executable, "install.ps1", [
            "-FoundryUserDataPath",
            userData,
            "-ModuleSourcePath",
            validZipPath,
          ]);
          expect(validInstall.status, validInstall.stderr).toBe(0);
          expect(fs.readFileSync(path.join(target, "scripts", "main.js"), "utf8")).toBe(
            "new-version\n",
          );
          const restoreOld = runScriptWith(shell.executable, "install.ps1", [
            "-FoundryUserDataPath",
            userData,
            "-ModuleSourcePath",
            oldSource,
          ]);
          expect(restoreOld.status, restoreOld.stderr).toBe(0);

          for (const testCase of cases) {
            const zipPath = path.join(tmpDir(`zip-${testCase.name}`), `${testCase.name}.zip`);
            const expansionMarker = path.join(
              tmpDir(`zip-marker-${testCase.name}`),
              "expanded.txt",
            );
            fs.writeFileSync(zipPath, createRawZip(testCase.entries));
            const result = runPowerShellFile(shell.executable, wrapper, {
              ...process.env,
              FMCP_EXPANSION_MARKER: expansionMarker,
              FMCP_INSTALL_SCRIPT: path.join(scriptsDir, "install.ps1"),
              FMCP_USER_DATA: userData,
              FMCP_ZIP_PATH: zipPath,
            });
            expect(result.status, `${testCase.name}: ${result.stderr}`).not.toBe(0);
            expect(result.stderr, testCase.name).toMatch(testCase.expected);
            expect(fs.existsSync(expansionMarker), testCase.name).toBe(false);
            expect(
              fs.readFileSync(path.join(target, "scripts", "main.js"), "utf8"),
              testCase.name,
            ).toBe("old-version\n");
            expect(
              fs
                .readdirSync(modulesRoot)
                .filter((name) => name.startsWith(".foundry-mcp.")),
              testCase.name,
            ).toEqual([]);
            expect(fs.existsSync(absoluteGuard), testCase.name).toBe(false);
          }
        }, 180000);

        it("leaves the previous complete module untouched when staging copy is injected to fail", () => {
          const userData = tmpDir("copy-failure-user-data");
          const oldSource = moduleFixture("copy-failure-old", "1.0.0", "old-version\n");
          const newSource = moduleFixture("copy-failure-new", "2.0.0", "new-version\n");
          const first = runScriptWith(shell.executable, "install.ps1", [
            "-FoundryUserDataPath",
            userData,
            "-ModuleSourcePath",
            oldSource,
          ]);
          expect(first.status, first.stderr).toBe(0);
          const target = path.join(userData, "Data", "modules", "foundry-mcp");
          const wrapper = path.join(tmpDir("copy-failure-wrapper"), "inject-copy-failure.ps1");
          fs.writeFileSync(
            wrapper,
            [
              "$ErrorActionPreference = 'Stop'",
              "function global:Copy-Item {",
              "  [CmdletBinding()] param([string]$LiteralPath, [string]$Destination, [switch]$Recurse, [switch]$Force)",
              "  if ($LiteralPath.StartsWith($env:FMCP_NEW_SOURCE, [StringComparison]::OrdinalIgnoreCase)) { throw 'Injected staging copy failure' }",
              "  Microsoft.PowerShell.Management\\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Recurse:$Recurse -Force:$Force",
              "}",
              "& $env:FMCP_INSTALL_SCRIPT -FoundryUserDataPath $env:FMCP_USER_DATA -ModuleSourcePath $env:FMCP_NEW_SOURCE",
            ].join("\r\n"),
          );
          const failed = runPowerShellFile(shell.executable, wrapper, {
            ...process.env,
            FMCP_INSTALL_SCRIPT: path.join(scriptsDir, "install.ps1"),
            FMCP_USER_DATA: userData,
            FMCP_NEW_SOURCE: newSource,
          });
          expect(failed.status).not.toBe(0);
          expect(failed.stderr).toMatch(/Injected staging copy failure/);
          expect(fs.readFileSync(path.join(target, "scripts", "main.js"), "utf8")).toBe(
            "old-version\n",
          );
          expect(
            fs.readdirSync(path.dirname(target)).filter((name) => name.includes(".stage-")),
          ).toEqual([]);
        }, 60000);

        it("restores the previous complete module when stage activation is injected to fail", () => {
          const userData = tmpDir("rollback-user-data");
          const oldSource = moduleFixture("rollback-old", "1.0.0", "old-version\n");
          const newSource = moduleFixture("rollback-new", "2.0.0", "new-version\n");
          const first = runScriptWith(shell.executable, "install.ps1", [
            "-FoundryUserDataPath",
            userData,
            "-ModuleSourcePath",
            oldSource,
          ]);
          expect(first.status, first.stderr).toBe(0);
          const target = path.join(userData, "Data", "modules", "foundry-mcp");
          const wrapper = path.join(tmpDir("rollback-wrapper"), "inject-swap-failure.ps1");
          fs.writeFileSync(
            wrapper,
            [
              "$ErrorActionPreference = 'Stop'",
              "function global:Move-Item {",
              "  [CmdletBinding()] param([string]$LiteralPath, [string]$Destination, [switch]$Force)",
              "  if (($Destination -eq $env:FMCP_TEST_TARGET) -and ($LiteralPath -like '*.stage-*')) { throw 'Injected stage activation failure' }",
              "  Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force",
              "}",
              "& $env:FMCP_INSTALL_SCRIPT -FoundryUserDataPath $env:FMCP_USER_DATA -ModuleSourcePath $env:FMCP_NEW_SOURCE",
            ].join("\r\n"),
          );
          const failed = runPowerShellFile(shell.executable, wrapper, {
            ...process.env,
            FMCP_INSTALL_SCRIPT: path.join(scriptsDir, "install.ps1"),
            FMCP_USER_DATA: userData,
            FMCP_NEW_SOURCE: newSource,
            FMCP_TEST_TARGET: target,
          });
          expect(failed.status).not.toBe(0);
          expect(failed.stderr).toMatch(/Injected stage activation failure/);
          expect(fs.readFileSync(path.join(target, "scripts", "main.js"), "utf8")).toBe(
            "old-version\n",
          );
          const manifest = JSON.parse(
            fs.readFileSync(path.join(target, ".foundry-mcp-install-manifest.json"), "utf8"),
          ) as { files: Array<{ relativePath: string }> };
          expect(manifest.files.map((entry) => entry.relativePath).sort()).toEqual([
            "module.json",
            path.join("scripts", "main.js"),
          ]);
        }, 60000);
      });
    }
  },
);
