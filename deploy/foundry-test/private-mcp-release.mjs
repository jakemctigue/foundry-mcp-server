import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const PACKAGES = ["cli", "host", "protocol", "foundry-module", "mcp-adapter"];
const ROOT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/linux/pair.mjs",
];
const REQUIRED_BUILDS = [
  "packages/cli/dist/bin.js",
  "packages/host/dist/index.js",
  "packages/protocol/dist/index.js",
  "packages/mcp-adapter/dist/cli.js",
];
const MODULE_FILES = ["module.json", "scripts/foundry-mcp.js"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = () => {
  throw new Error(
    "Release validation failed; inspect non-secret build inputs and expected revision.",
  );
};

function hasControlCharacter(value) {
  return [...value].some(
    (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
  );
}

export function validateRelativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    /[:\\]/u.test(value) ||
    hasControlCharacter(value) ||
    value.startsWith("/") ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  )
    fail();
  return value;
}

function runtimePath(relative) {
  return (
    ROOT_FILES.includes(relative) ||
    relative === "node_modules" ||
    relative.startsWith("node_modules/") ||
    PACKAGES.some(
      (name) =>
        relative === `packages/${name}` ||
        relative === `packages/${name}/package.json` ||
        relative === `packages/${name}/dist` ||
        relative.startsWith(`packages/${name}/dist/`) ||
        relative === `packages/${name}/node_modules` ||
        relative.startsWith(`packages/${name}/node_modules/`),
    )
  );
}

function regularBytes(file, maximum = 64 * 1024 * 1024) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) fail();
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    fail();
  return bytes;
}

function moduleEntries(root, relative) {
  validateRelativePath(relative);
  if (!relative.startsWith("artifacts/")) fail();
  const directory = path.join(root, relative);
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) fail();
  if (
    JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(["module.json", "scripts"])
  )
    fail();
  const scripts = path.join(directory, "scripts");
  if (
    !fs.lstatSync(scripts).isDirectory() ||
    fs.lstatSync(scripts).isSymbolicLink() ||
    JSON.stringify(fs.readdirSync(scripts)) !== JSON.stringify(["foundry-mcp.js"])
  )
    fail();
  const manifest = JSON.parse(regularBytes(path.join(directory, "module.json"), 64 * 1024));
  if (
    manifest.id !== "foundry-mcp" ||
    manifest.type !== "module" ||
    manifest.version !== "0.1.0" ||
    manifest.socket !== false ||
    JSON.stringify(manifest.esmodules) !== JSON.stringify(["scripts/foundry-mcp.js"]) ||
    ["minimum", "verified", "maximum"].some((key) => manifest.compatibility?.[key] !== "14")
  )
    fail();
  const bundle = regularBytes(path.join(scripts, "foundry-mcp.js"));
  if (
    !bundle.length ||
    /sourceMappingURL=|\b(?:from|import)\s*\(?\s*["']@foundry-mcp\//u.test(bundle.toString("utf8"))
  )
    fail();
  return MODULE_FILES.map((file) => `${relative}/${file}`);
}

/** Inventory only runtime/build outputs. Do not traverse .git, credentials, or Foundry data. */
export function createReleaseManifest(root, metadata) {
  if (
    !/^[a-f0-9]{40}$/u.test(metadata.commit) ||
    metadata.platform !== "linux" ||
    !["x64", "arm64"].includes(metadata.arch) ||
    !/^22\.\d+\.\d+$/u.test(metadata.nodeVersion)
  )
    fail();
  const sourceRoot = fs.realpathSync(root);
  const entries = [];
  let bytesTotal = 0;
  function walk(relative, allowLinks = true) {
    validateRelativePath(relative);
    if (entries.length >= 50_000) fail();
    const file = path.join(sourceRoot, relative);
    let parent = path.dirname(file);
    while (parent !== sourceRoot) {
      const parentStat = fs.lstatSync(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail();
      parent = path.dirname(parent);
    }
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      if (!allowLinks) fail();
      const target = fs.readlinkSync(file);
      if (path.isAbsolute(target) || target.includes("\\") || hasControlCharacter(target)) fail();
      const resolved = path.relative(sourceRoot, fs.realpathSync(file)).split(path.sep).join("/");
      validateRelativePath(resolved);
      if (!runtimePath(resolved)) fail();
      entries.push({ path: relative, kind: "symlink", target });
    } else if (stat.isDirectory()) {
      entries.push({ path: relative, kind: "directory" });
      for (const name of fs.readdirSync(file).sort()) walk(`${relative}/${name}`, allowLinks);
    } else if (stat.isFile()) {
      const bytes = regularBytes(file);
      bytesTotal += bytes.length;
      if (bytesTotal > 2 * 1024 * 1024 * 1024) fail();
      entries.push({ path: relative, kind: "file", size: bytes.length, sha256: sha256(bytes) });
    } else fail();
  }
  for (const file of ROOT_FILES) walk(file, false);
  walk("node_modules");
  for (const name of PACKAGES) {
    walk(`packages/${name}/package.json`, false);
    walk(`packages/${name}/dist`, false);
    walk(`packages/${name}/node_modules`);
  }
  for (const file of REQUIRED_BUILDS)
    if (!entries.some((e) => e.path === file && e.kind === "file")) fail();
  validateRelativePath(metadata.moduleRelative);
  let moduleParent = path.dirname(path.join(sourceRoot, metadata.moduleRelative));
  while (moduleParent !== sourceRoot) {
    const stat = fs.lstatSync(moduleParent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    moduleParent = path.dirname(moduleParent);
  }
  for (const file of moduleEntries(sourceRoot, metadata.moduleRelative)) walk(file, false);
  entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (new Set(entries.map((e) => e.path)).size !== entries.length) fail();
  const pkg = JSON.parse(regularBytes(path.join(sourceRoot, "package.json"), 64 * 1024));
  if (pkg.name !== "foundry-mcp-server" || pkg.packageManager !== "pnpm@9.15.0") fail();
  return {
    format: 1,
    commit: metadata.commit,
    platform: metadata.platform,
    arch: metadata.arch,
    nodeVersion: metadata.nodeVersion,
    moduleRelative: metadata.moduleRelative,
    entries,
  };
}

export function verifyReleaseManifest(root, bytes, expectedHash, expectedCommit) {
  if (
    !/^[a-f0-9]{64}$/u.test(expectedHash) ||
    bytes.length > 32 * 1024 * 1024 ||
    sha256(bytes) !== expectedHash
  )
    fail();
  const parsed = JSON.parse(bytes);
  if (parsed.format !== 1 || parsed.commit !== expectedCommit) fail();
  const actual = createReleaseManifest(root, parsed);
  if (JSON.stringify(parsed) !== JSON.stringify(actual)) fail();
  return actual;
}

/** Seal after the reviewed Linux build/tests. This checksum is not a signature or CI attestation. */
function main(args) {
  if (process.platform !== "linux" || !process.versions.node.startsWith("22.")) fail();
  if (args.length !== 4 || args[0] !== "--commit" || args[2] !== "--module-relative") fail();
  const commit = args[1];
  if (!/^[a-f0-9]{40}$/u.test(commit)) fail();
  const git = (command) =>
    execFileSync("/usr/bin/git", command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
  if (
    git(["rev-parse", "HEAD"]) !== commit ||
    git(["status", "--porcelain", "--untracked-files=no"])
  )
    fail();
  const manifest = createReleaseManifest(process.cwd(), {
    commit,
    moduleRelative: args[3],
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
  });
  const bytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync("private-mcp-release.json", bytes, { flag: "wx", mode: 0o644 });
  process.stdout.write(`Release manifest SHA-256: ${sha256(bytes)}\nSource commit: ${commit}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch {
    process.stderr.write(
      "Release sealing failed. Verify Linux Node 22, clean pinned source, prebuilt artifacts and fresh output. No secret data was printed.\n",
    );
    process.exitCode = 1;
  }
}
