import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { verifyReleaseManifest } from "./private-mcp-release.mjs";

const ACCOUNT = "foundry-mcp";
const APP_DATA = "/var/lib/foundry-mcp";
const PRIVATE_DIRS = [APP_DATA, "/run/foundry-mcp-private", "/run/foundry-mcp-credentials"];
const KEY_FILE = "/run/foundry-mcp-credentials/storage-key";
const MODULE_PARENT = "/var/lib/foundry-test/data/Data/modules";
const MODULE_TARGET = `${MODULE_PARENT}/foundry-mcp`;
const UNIT_FILE = "/etc/systemd/system/foundry-mcp-host.service";
const fail = (phase) => {
  throw new Error(`Private MCP provisioning refused: ${phase}.`);
};

function safeAbsolute(value) {
  if (
    typeof value !== "string" ||
    !/^\/[a-zA-Z0-9._/-]+$/u.test(value) ||
    value
      .split("/")
      .slice(1)
      .some((p) => !p || p === "." || p === "..")
  )
    fail("unsafe path");
  return value;
}

export function parseProvisionArguments(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (values.has(key)) fail("duplicate option");
    if (["--apply", "--allow-owner-tunnel"].includes(key)) values.set(key, true);
    else if (["--release-dir", "--commit", "--manifest-sha256"].includes(key)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) fail("missing option value");
      values.set(key, value);
    } else fail("unknown option");
  }
  const commit = values.get("--commit");
  const manifestSha256 = values.get("--manifest-sha256");
  const releaseDir = values.get("--release-dir");
  if (
    !/^[a-f0-9]{40}$/u.test(commit ?? "") ||
    !/^[a-f0-9]{64}$/u.test(manifestSha256 ?? "") ||
    releaseDir !== `/opt/foundry-mcp/releases/${commit}`
  )
    fail("invalid pinned release");
  return {
    releaseDir,
    commit,
    manifestSha256,
    apply: values.has("--apply"),
    allowOwnerTunnel: values.has("--allow-owner-tunnel"),
  };
}

export function renderHostUnit({ releaseDir, nodePath, allowOwnerTunnel = false }) {
  safeAbsolute(nodePath);
  if (
    !/^\/opt\/foundry-mcp\/releases\/[a-f0-9]{40}$/u.test(releaseDir) ||
    typeof allowOwnerTunnel !== "boolean"
  )
    fail("unsafe unit input");
  return `[Unit]
Description=Private Foundry MCP validation host
After=network.target

[Service]
Type=simple
User=${ACCOUNT}
Group=${ACCOUNT}
UMask=0077
WorkingDirectory=${releaseDir}
Environment=NODE_ENV=production
Environment=XDG_DATA_HOME=/var/lib
Environment=FOUNDRY_MCP_SECRET_KEY_FILE=${KEY_FILE}
ExecStart=${nodePath} ${releaseDir}/packages/cli/dist/bin.js host --app-data ${APP_DATA} --port 32145 --allow-origin http://127.0.0.1:30000${allowOwnerTunnel ? " --allow-origin http://127.0.0.1:39000" : ""}
Restart=no
TimeoutStopSec=60
KillSignal=SIGTERM
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET
ReadWritePaths=${APP_DATA}
`;
}

export function assertStoppedFoundry(containers) {
  if (!Array.isArray(containers) || containers.length !== 1)
    fail("expected one test Foundry container");
  const c = containers[0];
  if (
    !/^[a-f0-9]{64}$/u.test(c?.Id ?? "") ||
    !["exited", "created"].includes(c.State?.Status) ||
    c.State.Running !== false ||
    c.State.Paused !== false ||
    c.State.Restarting !== false ||
    c.Config?.Labels?.["com.docker.compose.project"] !== "bossforge-foundry-test" ||
    c.Config.Labels["com.docker.compose.service"] !== "foundry"
  )
    fail("test Foundry is not stopped");
  const mounts = c.Mounts?.filter((m) => m.Destination === "/data");
  if (
    mounts?.length !== 1 ||
    mounts[0].Type !== "bind" ||
    mounts[0].Source !== "/var/lib/foundry-test/data"
  )
    fail("unexpected Foundry data bind");
  return c.Id;
}

export function assertPrivateKeyMetadata(stat, uid) {
  if (
    !stat.isFile() ||
    stat.uid !== uid ||
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    ![0o400, 0o600].includes(stat.mode & 0o7777) ||
    stat.nlink !== 1 ||
    stat.size !== 32
  )
    fail("unsafe key metadata");
}

export function assertServiceIdentity(row) {
  const fields = row.trim().split(":");
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (
    fields.length !== 7 ||
    fields[0] !== ACCOUNT ||
    !/^\d+$/u.test(fields[2]) ||
    !/^\d+$/u.test(fields[3]) ||
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(gid) ||
    uid <= 0 ||
    gid <= 0 ||
    fields[5] !== APP_DATA ||
    fields[6] !== "/usr/sbin/nologin"
  )
    fail("unexpected service account");
  return { uid, gid };
}

/** Check every ancestor without following symlinks. Root and the named service are trusted. */
export function assertDirectoryChain(directory, allowedUids = [0], publicTraversal = false) {
  safeAbsolute(directory);
  let current = "/";
  for (const part of ["", ...directory.split("/").slice(1)]) {
    if (part) current = path.posix.join(current, part);
    const stat = fs.lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !allowedUids.includes(stat.uid) ||
      (stat.mode & 0o022) !== 0 ||
      (stat.mode & 0o7000) !== 0 ||
      (publicTraversal && (stat.mode & 0o001) !== 0o001)
    )
      fail("unsafe directory ownership or mode");
  }
}

export function assertImmutableRelease(root, manifest) {
  assertDirectoryChain(root, [0], true);
  const checked = new Set();
  for (const relative of ["private-mcp-release.json", ...manifest.entries.map((e) => e.path)]) {
    const file = path.join(root, relative);
    const parent = path.dirname(file);
    if (!checked.has(parent)) {
      assertDirectoryChain(parent, [0], true);
      checked.add(parent);
    }
    const stat = fs.lstatSync(file);
    if (stat.uid !== 0) fail("release must be root-owned");
    if (stat.isSymbolicLink()) {
      // verifyReleaseManifest already bounds relative symlink targets to the runtime.
      const target = fs.realpathSync(file);
      if (target !== root && !target.startsWith(`${root}/`)) fail("release symlink escaped");
      assertDirectoryChain(
        fs.statSync(target).isDirectory() ? target : path.dirname(target),
        [0],
        true,
      );
      const targetStat = fs.statSync(target);
      if (
        targetStat.uid !== 0 ||
        (targetStat.mode & 0o022) !== 0 ||
        (targetStat.mode & 0o004) !== 0o004
      )
        fail("mutable or unreadable symlink target");
    } else if (
      (stat.mode & 0o022) !== 0 ||
      (stat.mode & 0o7000) !== 0 ||
      (stat.mode & 0o004) !== 0o004 ||
      (stat.isDirectory() && (stat.mode & 0o001) !== 0o001) ||
      (!stat.isFile() && !stat.isDirectory()) ||
      (stat.isFile() && stat.nlink !== 1)
    )
      fail("mutable, unreadable, or linked release file");
  }
}

function command(binary, args, allowedCodes = [0]) {
  try {
    return execFileSync(binary, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
    }).trim();
  } catch (error) {
    if (allowedCodes.includes(error.status)) return String(error.stdout ?? "").trim();
    // Never forward child output (for example Docker metadata) to a log.
    fail("required local command failed");
  }
}

function serviceIdentity() {
  const row = command("/usr/bin/getent", ["passwd", ACCOUNT], [0, 2]);
  if (!row) return null;
  const identity = assertServiceIdentity(row);
  const group = command("/usr/bin/getent", ["group", ACCOUNT]).split(":");
  const groups = command("/usr/bin/id", ["-G", ACCOUNT]).split(/\s+/u);
  if (
    group.length !== 4 ||
    group[0] !== ACCOUNT ||
    Number(group[2]) !== identity.gid ||
    group[3] !== "" ||
    groups.length !== 1 ||
    Number(groups[0]) !== identity.gid
  )
    fail("unexpected service groups");
  return identity;
}

function inspectFoundry() {
  const ids = command("/usr/bin/docker", [
    "ps",
    "--all",
    "--quiet",
    "--no-trunc",
    "--filter",
    "label=com.docker.compose.project=bossforge-foundry-test",
    "--filter",
    "label=com.docker.compose.service=foundry",
  ]);
  if (!/^[a-f0-9]{64}$/u.test(ids)) fail("expected one test Foundry container");
  // Deliberately select no environment, command, labels beyond identity, or other secret-bearing data.
  const format =
    '{"Id":{{json .Id}},"State":{{json .State}},"Config":{"Labels":{"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},"com.docker.compose.service":{{json (index .Config.Labels "com.docker.compose.service")}}}},"Mounts":{{json .Mounts}}}';
  return assertStoppedFoundry([
    JSON.parse(command("/usr/bin/docker", ["inspect", "--format", format, ids])),
  ]);
}

function absent(file) {
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

function assertPrivateDirectory(directory, identity) {
  assertDirectoryChain(directory, [0, identity.uid]);
  const stat = fs.lstatSync(directory);
  if (stat.uid !== identity.uid || stat.gid !== identity.gid || (stat.mode & 0o7777) !== 0o700)
    fail("unsafe private directory");
}

function keyReady(identity) {
  if (absent(KEY_FILE)) return false;
  if (!identity) fail("key exists before service account");
  assertPrivateDirectory(path.dirname(KEY_FILE), identity);
  assertPrivateKeyMetadata(fs.lstatSync(KEY_FILE), identity.uid);
  return true;
}

function assertFirstInstall(identity) {
  if (!absent(UNIT_FILE) || !absent(MODULE_TARGET))
    fail("existing unit or module requires owner review");
  const loadState = command(
    "/usr/bin/systemctl",
    ["show", "--property=LoadState", "--value", "foundry-mcp-host.service"],
    [0, 4],
  );
  if (loadState !== "not-found") fail("a host unit already exists");
  assertDirectoryChain("/etc/systemd/system");
  assertDirectoryChain(MODULE_PARENT, [0, 1000]);
  if (fs.lstatSync("/var/lib/foundry-test/data").uid !== 1000) fail("unexpected test data owner");
  for (const directory of PRIVATE_DIRS) {
    assertDirectoryChain(path.dirname(directory));
    if (absent(directory)) continue;
    if (!identity) fail("private directory exists before service account");
    assertPrivateDirectory(directory, identity);
    const allowed = directory === path.dirname(KEY_FILE) ? ["storage-key"] : [];
    if (fs.readdirSync(directory).some((name) => !allowed.includes(name)))
      fail("existing private state requires owner review");
  }
  if (
    identity &&
    command("/usr/bin/ps", ["--no-headers", "-o", "pid=", "-u", String(identity.uid)], [0, 1])
  )
    fail("service account has running processes");
}

function verifiedRelease(options) {
  assertDirectoryChain(options.releaseDir);
  const file = `${options.releaseDir}/private-mcp-release.json`;
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    (stat.mode & 0o022) !== 0 ||
    stat.nlink !== 1 ||
    stat.size > 32 * 1024 * 1024
  )
    fail("unsafe release manifest");
  const manifest = verifyReleaseManifest(
    options.releaseDir,
    fs.readFileSync(file),
    options.manifestSha256,
    options.commit,
  );
  if (manifest.arch !== process.arch || manifest.nodeVersion !== process.versions.node)
    fail("release runtime mismatch");
  assertImmutableRelease(options.releaseDir, manifest);
  return manifest;
}

function installModule(releaseDir, moduleRelative, expectedContainer) {
  if (inspectFoundry() !== expectedContainer) fail("test container changed during provisioning");
  assertDirectoryChain(MODULE_PARENT, [0, 1000]);
  // Exclusive creation never replaces another installed module. A failure deliberately
  // leaves a root-owned partial module for owner inspection, rather than deleting data.
  fs.mkdirSync(MODULE_TARGET, { mode: 0o700 });
  const scripts = `${MODULE_TARGET}/scripts`;
  fs.mkdirSync(scripts, { mode: 0o700 });
  for (const relative of ["module.json", "scripts/foundry-mcp.js"]) {
    const output = `${MODULE_TARGET}/${relative}`;
    fs.copyFileSync(
      `${releaseDir}/${moduleRelative}/${relative}`,
      output,
      fs.constants.COPYFILE_EXCL,
    );
    fs.chmodSync(output, 0o644);
  }
  if (inspectFoundry() !== expectedContainer) fail("test container changed during module copy");
  for (const relative of ["module.json", "scripts/foundry-mcp.js"])
    fs.chownSync(`${MODULE_TARGET}/${relative}`, 1000, 1000);
  fs.chmodSync(scripts, 0o755);
  fs.chownSync(scripts, 1000, 1000);
  fs.chmodSync(MODULE_TARGET, 0o755);
  fs.chownSync(MODULE_TARGET, 1000, 1000);
}

function main(args) {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 0 ||
    !process.versions.node.startsWith("22.")
  )
    fail("Linux root with Node 22 required");
  const options = parseProvisionArguments(args);
  const osRelease = fs.readFileSync("/etc/os-release", "utf8");
  if (!/^ID=ubuntu$/mu.test(osRelease) || !/^VERSION_ID="?24\.04"?$/mu.test(osRelease))
    fail("Ubuntu 24.04 required");
  if (command("/usr/bin/findmnt", ["-n", "-o", "FSTYPE", "--target", "/run"]) !== "tmpfs")
    fail("private runtime must use tmpfs");
  const nodePath = fs.realpathSync(process.execPath);
  if (!nodePath.startsWith("/opt/") && !nodePath.startsWith("/usr/"))
    fail("Node must live outside protected homes");
  safeAbsolute(nodePath);
  assertDirectoryChain(path.dirname(nodePath), [0], true);
  const nodeStat = fs.lstatSync(nodePath);
  if (
    !nodeStat.isFile() ||
    nodeStat.uid !== 0 ||
    nodeStat.nlink !== 1 ||
    (nodeStat.mode & 0o022) !== 0 ||
    (nodeStat.mode & 0o7000) !== 0 ||
    (nodeStat.mode & 0o005) !== 0o005
  )
    fail("unsafe Node executable");
  const manifest = verifiedRelease(options);
  const container = inspectFoundry();
  let identity = serviceIdentity();
  assertFirstInstall(identity);
  const keyPresent = keyReady(identity);
  const unit = renderHostUnit({ ...options, nodePath });
  const evidence = {
    mode: options.apply ? "installed-stopped" : "inspection-only",
    commit: options.commit,
    manifestSha256: options.manifestSha256,
    companionEndpoint: "ws://127.0.0.1:32145",
    origins: [
      "http://127.0.0.1:30000",
      ...(options.allowOwnerTunnel ? ["http://127.0.0.1:39000"] : []),
    ],
    adapterTransport: "private 0600 Unix socket under /var/lib/foundry-mcp",
    keyMetadata: keyPresent ? "ready" : "missing; inject externally before pairing/start",
    pairing: "not performed; secured GM browser required",
    started: false,
    enabled: false,
  };
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    return;
  }
  const lock = "/run/foundry-mcp-provision.lock";
  const lockFd = fs.openSync(lock, "wx", 0o600);
  try {
    // Recheck after acquiring the installer lock. Operators must also keep Foundry
    // stopped and avoid modifying/restarting it throughout installation.
    assertFirstInstall(identity);
    if (inspectFoundry() !== container) fail("test container changed before apply");
    if (!identity) {
      command("/usr/sbin/useradd", [
        "--system",
        "--user-group",
        "--home-dir",
        APP_DATA,
        "--no-create-home",
        "--shell",
        "/usr/sbin/nologin",
        ACCOUNT,
      ]);
      identity = serviceIdentity();
      if (!identity) fail("service account creation did not verify");
    }
    for (const directory of PRIVATE_DIRS) {
      if (absent(directory)) {
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.chownSync(directory, identity.uid, identity.gid);
      }
      assertPrivateDirectory(directory, identity);
    }
    keyReady(identity);
    installModule(options.releaseDir, manifest.moduleRelative, container);
    fs.writeFileSync(UNIT_FILE, unit, { flag: "wx", mode: 0o644 });
    command("/usr/bin/systemd-analyze", ["verify", UNIT_FILE]);
    command("/usr/bin/systemctl", ["daemon-reload"]);
    const state = command("/usr/bin/systemctl", [
      "show",
      "--property=ActiveState",
      "--value",
      "foundry-mcp-host.service",
    ]);
    const enabled = command(
      "/usr/bin/systemctl",
      ["is-enabled", "foundry-mcp-host.service"],
      [0, 1],
    );
    if (state !== "inactive" || !["static", "disabled"].includes(enabled))
      fail("host must remain stopped and not enabled");
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally {
    const owned = fs.fstatSync(lockFd);
    fs.closeSync(lockFd);
    const current = fs.lstatSync(lock);
    if (current.ino === owned.ino && current.dev === owned.dev) fs.unlinkSync(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const known =
      error instanceof Error && error.message.startsWith("Private MCP provisioning refused:");
    process.stderr.write(
      `${known ? error.message : "Private MCP provisioning failed; local error details suppressed."} No service was intentionally started. Partial first-install files may need owner review.\n`,
    );
    process.exitCode = 1;
  }
}
