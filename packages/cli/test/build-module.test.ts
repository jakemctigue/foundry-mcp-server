import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildFoundryModule,
  FOUNDRY_MODULE_FILES,
  FOUNDRY_MODULE_ID,
} from "../src/build-module.js";

function zipEntries(zipPath: string): string[] {
  const bytes = fs.readFileSync(zipPath);
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const end = bytes.lastIndexOf(endSignature);
  if (end < 0) throw new Error("ZIP end record is missing");
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP directory is malformed");
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    entries.push(bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe("build-module release artifact", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-mcp-module-build-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  it("creates an allowlisted Foundry v14 directory and versioned ZIP for desktop or Docker", () => {
    const root = temporaryDirectory();
    const bundle = path.join(root, "browser-bundle.js");
    fs.writeFileSync(bundle, "globalThis.foundryMcpRelease = true;\n");
    for (const planted of [".env", "foundry-mcp.db", "debug.log", "dev-fixture.json"]) {
      fs.writeFileSync(path.join(root, planted), `must-not-package:${planted}`);
    }

    const result = buildFoundryModule({
      outputDir: path.join(root, "release"),
      version: "1.2.3",
      bundlePath: bundle,
    });
    expect(result.version).toBe("1.2.3");
    expect(result.files).toEqual(FOUNDRY_MODULE_FILES);
    expect(
      fs
        .readdirSync(result.moduleDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          path
            .relative(result.moduleDir, path.join(entry.parentPath, entry.name))
            .replaceAll(path.sep, "/"),
        )
        .sort(),
    ).toEqual([...FOUNDRY_MODULE_FILES].sort());

    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.moduleDir, "module.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: FOUNDRY_MODULE_ID,
      type: "module",
      version: "1.2.3",
      compatibility: { minimum: "14", verified: "14", maximum: "14" },
      esmodules: ["scripts/foundry-mcp.js"],
    });
    expect(zipEntries(result.zipPath).sort()).toEqual([
      "foundry-mcp/module.json",
      "foundry-mcp/scripts/foundry-mcp.js",
    ]);
    const zipText = fs.readFileSync(result.zipPath).toString("latin1");
    for (const excluded of [".env", ".db", ".log", "dev-fixture"]) {
      expect(zipText).not.toContain(excluded);
    }

    for (const layout of ["desktop", "docker-bind-mount"]) {
      const destination = path.join(root, layout, "Data", "modules", FOUNDRY_MODULE_ID);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(result.moduleDir, destination, { recursive: true, errorOnExist: true });
      expect(
        JSON.parse(fs.readFileSync(path.join(destination, "module.json"), "utf8")),
      ).toMatchObject({ id: FOUNDRY_MODULE_ID });
    }
  });

  it("refuses unsafe versions, source symlinks, and overwriting prior artifacts", () => {
    const root = temporaryDirectory();
    const bundle = path.join(root, "bundle.js");
    fs.writeFileSync(bundle, "globalThis.safeBundle = true;\n");
    expect(() =>
      buildFoundryModule({ outputDir: root, version: "../../escape", bundlePath: bundle }),
    ).toThrow("semantic version");
    buildFoundryModule({ outputDir: root, version: "2.0.0", bundlePath: bundle });
    expect(() =>
      buildFoundryModule({ outputDir: root, version: "2.0.0", bundlePath: bundle }),
    ).toThrow("refusing to overwrite");
  });

  it.runIf(process.platform !== "win32")("refuses a symlinked release bundle", () => {
    const root = temporaryDirectory();
    const target = path.join(root, "target.js");
    const link = path.join(root, "linked.js");
    fs.writeFileSync(target, "globalThis.safeBundle = true;\n");
    fs.symlinkSync(target, link);
    expect(() =>
      buildFoundryModule({ outputDir: path.join(root, "out"), bundlePath: link }),
    ).toThrow("not a symlink");
  });
});
