import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import {
  createReleaseManifest,
  verifyReleaseManifest,
  validateRelativePath,
} from "./private-mcp-release.mjs";
import {
  parseProvisionArguments,
  renderHostUnit,
  assertStoppedFoundry,
  assertPrivateKeyMetadata,
  assertServiceIdentity,
  assertDirectoryChain,
} from "./provision-private-mcp.mjs";

const commit = "a".repeat(40);
const releaseDir = `/opt/foundry-mcp/releases/${commit}`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const args = ["--release-dir", releaseDir, "--commit", commit, "--manifest-sha256", "b".repeat(64)];

test("provisioning is inspection-only unless apply is explicit; fixed immutable release path", () => {
  assert.equal(parseProvisionArguments(args).apply, false);
  assert.equal(parseProvisionArguments([...args, "--apply"]).apply, true);
  assert.equal(parseProvisionArguments(args).allowOwnerTunnel, false);
  assert.equal(parseProvisionArguments([...args, "--allow-owner-tunnel"]).allowOwnerTunnel, true);
  for (const suffix of [
    ["--apply", "--apply"],
    ["--port", "0.0.0.0"],
    ["--key", "secret"],
  ]) {
    assert.throws(() => parseProvisionArguments([...args, ...suffix]));
  }
  assert.throws(() => parseProvisionArguments(["--release-dir", "/opt/other", ...args.slice(2)]));
  assert.throws(() => parseProvisionArguments([...args, "--commit", commit]));
  assert.throws(() => parseProvisionArguments(args.slice(0, -1)));
});

test("manifest paths cannot traverse, inject controls, or name an absolute path", () => {
  for (const input of [
    "../x",
    "/x",
    "C:/x",
    "x/../../y",
    "x\\y",
    "x//y",
    "./x",
    "x/../y",
    "x\nq",
    "x\0q",
    "",
  ]) {
    assert.throws(() => validateRelativePath(input));
  }
  assert.equal(
    validateRelativePath("node_modules/@scope/name/index.js"),
    "node_modules/@scope/name/index.js",
  );
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-release-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, text) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  };
  write(
    "package.json",
    JSON.stringify({ name: "foundry-mcp-server", packageManager: "pnpm@9.15.0" }),
  );
  write("pnpm-lock.yaml", "lockfileVersion: 9\n");
  write("pnpm-workspace.yaml", "packages: [packages/*]\n");
  write("scripts/linux/pair.mjs", "export const fixture = true;\n");
  write("node_modules/example/index.js", "export const fixture = true;\n");
  for (const name of ["cli", "host", "protocol", "foundry-module", "mcp-adapter"]) {
    write(
      `packages/${name}/package.json`,
      JSON.stringify({ name: `@foundry-mcp/${name}`, version: "0.1.0" }),
    );
    write(`packages/${name}/dist/index.js`, "export const fixture = true;\n");
    fs.mkdirSync(path.join(root, `packages/${name}/node_modules`));
  }
  write("packages/cli/dist/bin.js", "export const fixture = true;\n");
  write("packages/mcp-adapter/dist/cli.js", "export const fixture = true;\n");
  const moduleRelative = "artifacts/private-integration-module/foundry-mcp";
  write(
    `${moduleRelative}/module.json`,
    JSON.stringify({
      id: "foundry-mcp",
      type: "module",
      version: "0.1.0",
      compatibility: { minimum: "14", verified: "14", maximum: "14" },
      esmodules: ["scripts/foundry-mcp.js"],
      socket: false,
    }),
  );
  write(`${moduleRelative}/scripts/foundry-mcp.js`, "export const fixture = true;\n");
  return { root, write, moduleRelative };
}

test("release manifest pins runtime and module bytes; any extra or altered runtime file fails", (t) => {
  const f = fixture(t);
  const manifest = createReleaseManifest(f.root, {
    commit,
    moduleRelative: f.moduleRelative,
    platform: "linux",
    arch: "x64",
    nodeVersion: "22.23.2",
  });
  const bytes = Buffer.from(JSON.stringify(manifest));
  assert.equal(verifyReleaseManifest(f.root, bytes, hash(bytes), commit).commit, commit);
  f.write("node_modules/example/index.js", "tampered");
  assert.throws(() => verifyReleaseManifest(f.root, bytes, hash(bytes), commit));
  f.write("node_modules/example/index.js", "export const fixture = true;\n");
  f.write("node_modules/example/extra.js", "unsealed");
  assert.throws(() => verifyReleaseManifest(f.root, bytes, hash(bytes), commit));
});

test("manifest cannot attest another commit, wrong checksum, missing build, or extra companion file", (t) => {
  const f = fixture(t);
  const make = () =>
    createReleaseManifest(f.root, {
      commit,
      moduleRelative: f.moduleRelative,
      platform: "linux",
      arch: "x64",
      nodeVersion: "22.23.2",
    });
  const bytes = Buffer.from(JSON.stringify(make()));
  assert.throws(() => verifyReleaseManifest(f.root, bytes, "0".repeat(64), commit));
  assert.throws(() => verifyReleaseManifest(f.root, bytes, hash(bytes), "c".repeat(40)));
  f.write(`${f.moduleRelative}/not-allowed.txt`, "extra");
  assert.throws(make);
  fs.unlinkSync(path.join(f.root, `${f.moduleRelative}/not-allowed.txt`));
  fs.unlinkSync(path.join(f.root, "packages/cli/dist/bin.js"));
  assert.throws(make);
});

test(
  "POSIX symlinks must remain inside the sealed runtime and cannot point to keys",
  { skip: process.platform === "win32" },
  (t) => {
    const f = fixture(t);
    fs.symlinkSync("../packages/host", path.join(f.root, "node_modules/host"));
    const options = {
      commit,
      moduleRelative: f.moduleRelative,
      platform: "linux",
      arch: process.arch,
      nodeVersion: "22.23.2",
    };
    assert.ok(
      createReleaseManifest(f.root, options).entries.some(
        (e) => e.path === "node_modules/host" && e.kind === "symlink",
      ),
    );
    fs.symlinkSync(
      "/run/foundry-mcp-credentials/storage-key",
      path.join(f.root, "node_modules/key"),
    );
    assert.throws(() => createReleaseManifest(f.root, options));
  },
);

const stopped = [
  {
    Id: "d".repeat(64),
    State: { Status: "exited", Running: false, Paused: false, Restarting: false },
    Config: {
      Labels: {
        "com.docker.compose.project": "bossforge-foundry-test",
        "com.docker.compose.service": "foundry",
      },
    },
    Mounts: [{ Type: "bind", Source: "/var/lib/foundry-test/data", Destination: "/data" }],
  },
];
test("module install is gated on exact stopped container identity and data bind", () => {
  assert.equal(assertStoppedFoundry(stopped), "d".repeat(64));
  for (const mutation of [
    (v) => (v[0].State.Running = true),
    (v) => (v[0].State.Status = "restarting"),
    (v) => (v[0].Config.Labels["com.docker.compose.project"] = "other"),
    (v) => (v[0].Mounts[0].Source = "/production"),
  ]) {
    const bad = JSON.parse(JSON.stringify(stopped));
    mutation(bad);
    assert.throws(() => assertStoppedFoundry(bad));
  }
  assert.throws(() => assertStoppedFoundry([]));
  assert.throws(() => assertStoppedFoundry([...stopped, ...stopped]));
});

test("unit is unprivileged, loopback-only, no key bytes, and has no auto-enable or browser", () => {
  const unit = renderHostUnit({ releaseDir, nodePath: "/opt/node22/bin/node" });
  for (const line of [
    "User=foundry-mcp",
    "Group=foundry-mcp",
    "UMask=0077",
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "Restart=no",
    "Environment=NODE_ENV=production",
    "Environment=XDG_DATA_HOME=/var/lib",
    "Environment=FOUNDRY_MCP_SECRET_KEY_FILE=/run/foundry-mcp-credentials/storage-key",
  ])
    assert.ok(unit.includes(line));
  assert.match(unit, /--port 32145 --allow-origin http:\/\/127\.0\.0\.1:30000/);
  assert.match(unit, /RestrictAddressFamilies=AF_UNIX AF_INET/);
  assert.doesNotMatch(unit, /39000/);
  const ownerUnit = renderHostUnit({
    releaseDir,
    nodePath: "/opt/node22/bin/node",
    allowOwnerTunnel: true,
  });
  assert.match(
    ownerUnit,
    /--allow-origin http:\/\/127\.0\.0\.1:30000 --allow-origin http:\/\/127\.0\.0\.1:39000/,
  );
  assert.throws(() =>
    renderHostUnit({
      releaseDir,
      nodePath: "/opt/node22/bin/node",
      allowOwnerTunnel: "http://evil",
    }),
  );
  assert.doesNotMatch(
    unit,
    /\[Install\]|WantedBy=|0\.0\.0\.0|\[::\]|PrivateNetwork=|LoadCredential=|chromium|--no-sandbox|NODE_ENV=development/,
  );
  assert.throws(() =>
    renderHostUnit({
      releaseDir: releaseDir + "\nExecStart=/bin/sh",
      nodePath: "/opt/node22/bin/node",
    }),
  );
});

test("key checks inspect metadata only and reject public, linked, wrong-owner, or wrong-sized files", () => {
  const stat = { isFile: () => true, mode: 0o100400, uid: 999, nlink: 1, size: 32 };
  assertPrivateKeyMetadata(stat, 999);
  for (const bad of [
    { mode: 0o100644 },
    { uid: 0 },
    { nlink: 2 },
    { size: 64 },
    { isFile: () => false },
  ])
    assert.throws(() => assertPrivateKeyMetadata({ ...stat, ...bad }, 999));
});

test("an existing service account must not be root, an interactive user, or use another home", () => {
  assert.deepEqual(
    assertServiceIdentity("foundry-mcp:x:999:999::/var/lib/foundry-mcp:/usr/sbin/nologin"),
    { uid: 999, gid: 999 },
  );
  for (const row of [
    "foundry-mcp:x:0:0::/var/lib/foundry-mcp:/usr/sbin/nologin",
    "foundry-mcp:x:999:999::/home/owner:/usr/sbin/nologin",
    "foundry-mcp:x:999:999::/var/lib/foundry-mcp:/bin/bash",
  ])
    assert.throws(() => assertServiceIdentity(row));
});

test(
  "POSIX directory chain rejects writable parents and symlink redirects",
  { skip: process.platform === "win32" },
  (t) => {
    // /tmp itself is deliberately not a supported immutable release ancestor.
    const f = fixture(t);
    assert.throws(() => assertDirectoryChain(f.root, [process.getuid()]));
    assert.throws(() => assertDirectoryChain("/var/lib/../tmp", [process.getuid()]));
    const safeRoot = fs.mkdtempSync(path.join(os.homedir(), "mcp-chain-test-"));
    t.after(() => fs.rmSync(safeRoot, { recursive: true, force: true }));
    const allowed = [0, process.getuid()];
    assertDirectoryChain(safeRoot, allowed);
    const real = path.join(safeRoot, "real");
    fs.mkdirSync(real, { mode: 0o700 });
    assertDirectoryChain(real, allowed);
    assert.throws(() => assertDirectoryChain(real, allowed, true));
    fs.symlinkSync("real", path.join(safeRoot, "link"));
    assert.throws(() => assertDirectoryChain(path.join(safeRoot, "link"), allowed));
    fs.chmodSync(real, 0o777);
    assert.throws(() => assertDirectoryChain(real, allowed));
    assert.throws(() => assertDirectoryChain(safeRoot, [-1]));
  },
);

test("CLI refuses unsupported options without printing argument values or invoking an install", () => {
  for (const file of ["provision-private-mcp.mjs", "private-mcp-release.mjs"]) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(file, import.meta.url)), "--unsupported", "test-sensitive-marker"],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /test-sensitive-marker|Error:|\bat file:/);
  }
});

test(
  "POSIX sealing rejects redirected runtime and artifact ancestor directories before reading files",
  { skip: process.platform === "win32" },
  (t) => {
    const f = fixture(t);
    const options = {
      commit,
      moduleRelative: f.moduleRelative,
      platform: "linux",
      arch: process.arch,
      nodeVersion: "22.23.2",
    };
    fs.renameSync(path.join(f.root, "scripts"), path.join(f.root, "scripts-real"));
    fs.symlinkSync("scripts-real", path.join(f.root, "scripts"));
    assert.throws(() => createReleaseManifest(f.root, options));
    fs.unlinkSync(path.join(f.root, "scripts"));
    fs.renameSync(path.join(f.root, "scripts-real"), path.join(f.root, "scripts"));
    fs.renameSync(path.join(f.root, "artifacts"), path.join(f.root, "artifacts-real"));
    fs.symlinkSync("artifacts-real", path.join(f.root, "artifacts"));
    assert.throws(() => createReleaseManifest(f.root, options));
  },
);
