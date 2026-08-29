import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const FOUNDRY_MODULE_ID = "foundry-mcp";
export const FOUNDRY_MODULE_FILES = [
  "module.json",
  "scripts/foundry-mcp.js",
] as const;

export interface BuildModuleOptions {
  outputDir?: string;
  version?: string;
  bundlePath?: string;
}

export interface BuildModuleResult {
  moduleDir: string;
  zipPath: string;
  version: string;
  files: string[];
}

interface ZipEntry {
  name: string;
  bytes: Buffer;
}

function packageVersion(): string {
  const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : "0.1.0";
}

function validateVersion(value: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("module version must be a semantic version without path characters");
  }
  return value;
}

function defaultBundlePath(): string {
  const require = createRequire(import.meta.url);
  const packageEntry = require.resolve("@foundry-mcp/foundry-module");
  return path.join(path.dirname(packageEntry), "module", "foundry-mcp.js");
}

function loadBundle(bundlePath: string): Buffer {
  const stats = fs.lstatSync(bundlePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("Foundry module bundle must be a regular file, not a symlink");
  }
  const bytes = fs.readFileSync(bundlePath);
  if (bytes.byteLength === 0) throw new Error("Foundry module bundle is empty");
  const source = bytes.toString("utf8");
  if (/\b(?:from|import)\s*\(?\s*["']@foundry-mcp\//.test(source)) {
    throw new Error("Foundry module bundle is not self-contained");
  }
  if (/sourceMappingURL=/.test(source)) {
    throw new Error("Foundry module release bundle must not contain source-map references");
  }
  return bytes;
}

function moduleManifest(version: string): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        id: FOUNDRY_MODULE_ID,
        type: "module",
        title: "Foundry MCP Companion",
        description:
          "Browser companion for the local Foundry MCP host. It uses public Foundry APIs and never bundles Foundry VTT.",
        version,
        authors: [{ name: "Foundry MCP contributors" }],
        compatibility: { minimum: "14", verified: "14", maximum: "14" },
        esmodules: ["scripts/foundry-mcp.js"],
        socket: false,
        media: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name: Buffer, bytes: Buffer): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x21, 12);
  header.writeUInt32LE(crc32(bytes), 14);
  header.writeUInt32LE(bytes.byteLength, 18);
  header.writeUInt32LE(bytes.byteLength, 22);
  header.writeUInt16LE(name.byteLength, 26);
  return Buffer.concat([header, name, bytes]);
}

function centralHeader(name: Buffer, bytes: Buffer, offset: number): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x21, 14);
  header.writeUInt32LE(crc32(bytes), 16);
  header.writeUInt32LE(bytes.byteLength, 20);
  header.writeUInt32LE(bytes.byteLength, 24);
  header.writeUInt16LE(name.byteLength, 28);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}

function createZip(entries: readonly ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8");
    if (entry.name.startsWith("/") || entry.name.includes("..")) {
      throw new Error("ZIP entry names must remain inside the module directory");
    }
    const localEntry = localHeader(name, entry.bytes);
    local.push(localEntry);
    central.push(centralHeader(name, entry.bytes, offset));
    offset += localEntry.byteLength;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function assertUnused(target: string): void {
  if (fs.existsSync(target)) {
    throw new Error(`refusing to overwrite existing module artifact: ${target}`);
  }
}

export function buildFoundryModule(options: BuildModuleOptions = {}): BuildModuleResult {
  const version = validateVersion(options.version ?? packageVersion());
  const outputDir = path.resolve(options.outputDir ?? path.join(process.cwd(), "dist", "module"));
  fs.mkdirSync(outputDir, { recursive: true });
  const outputRoot = fs.realpathSync.native(outputDir);
  const moduleDir = path.join(outputRoot, FOUNDRY_MODULE_ID);
  const zipPath = path.join(outputRoot, `${FOUNDRY_MODULE_ID}-${version}.zip`);
  assertUnused(moduleDir);
  assertUnused(zipPath);

  const bundle = loadBundle(path.resolve(options.bundlePath ?? defaultBundlePath()));
  const manifest = moduleManifest(version);
  const staging = fs.mkdtempSync(path.join(outputRoot, ".foundry-mcp-build-"));
  const stagedModule = path.join(staging, FOUNDRY_MODULE_ID);
  try {
    fs.mkdirSync(path.join(stagedModule, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(stagedModule, "module.json"), manifest, { mode: 0o644 });
    fs.writeFileSync(path.join(stagedModule, "scripts", "foundry-mcp.js"), bundle, {
      mode: 0o644,
    });
    const zip = createZip([
      { name: `${FOUNDRY_MODULE_ID}/module.json`, bytes: manifest },
      { name: `${FOUNDRY_MODULE_ID}/scripts/foundry-mcp.js`, bytes: bundle },
    ]);
    const stagedZip = path.join(staging, path.basename(zipPath));
    fs.writeFileSync(stagedZip, zip, { mode: 0o644 });
    fs.renameSync(stagedModule, moduleDir);
    fs.renameSync(stagedZip, zipPath);
  } finally {
    const relative = path.relative(outputRoot, staging);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  return { moduleDir, zipPath, version, files: [...FOUNDRY_MODULE_FILES] };
}
