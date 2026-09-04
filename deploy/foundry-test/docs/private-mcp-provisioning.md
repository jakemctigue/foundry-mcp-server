# Private MCP host and companion: first installation

This is an owner-operated, **first-install-only** scaffold for the approved
Ubuntu 24.04 disposable VM. It does not license Foundry, create a world, install
D&D, start a browser, export spells, execute activities, or connect BossForge.
The installer does not start or enable the MCP service, open a firewall, change
Caddy/Compose, stop Foundry, install dependencies, or fetch secrets.

Use this after the existing [Foundry host setup](../README.md) and before the
[private pairing/export steps](private-integration-notes.md). Do not run the
Windows installer on Linux. Treat the owner/root, the dedicated MCP account,
the owner-isolated GM browser, and the reviewed build producer as trusted principals.

## 1. Build and seal the exact reviewed revision on Linux

Use a clean, dedicated checkout of the reviewed **published GitHub commit**,
not a cached Archon worktree. Run the build as an unprivileged build user using
the same Node 22 patch version and architecture as the deployment. Keep Node 22
outside home directories on the VM; Foundry continues using its own Node 24
container. pnpm must be 9.15.0. Replace the revision placeholder with the full
40-character lowercase commit ID; do not use a movable branch/tag as a pin.

The owner must provision Ubuntu's `build-essential` and Python 3 before the
unprivileged build. On the reviewed Ubuntu 24.04 / Node 22.23.2 / Linux x64 build,
the scoped rebuild of `better-sqlite3` 13.0.3 invoked `node-gyp rebuild` and required
`make` and a C++ compiler; do not assume a Windows prebuild proves Linux readiness.
Review the installed native packages/build scripts before authorizing only the
two rebuild targets below. Keep the actual Node 22 and pnpm 9.15.0 executable
directories on `PATH` for child processes, not just as shell aliases. The workspace
`.bin` addition below also makes local build tools available to Turbo.

```sh
git rev-parse HEAD
node --version
pnpm --version
pnpm install --frozen-lockfile --ignore-scripts
export PATH="$PWD/node_modules/.bin:$PATH"
export npm_config_node_gyp="$PWD/node_modules/node-gyp/bin/node-gyp.js"
pnpm --recursive rebuild better-sqlite3 esbuild
pnpm exec turbo run build typecheck lint test --concurrency=1
node --test deploy/foundry-test/private-mcp.test.mjs
pnpm audit --prod
node packages/cli/dist/bin.js build-module \
  --output artifacts/private-integration-module --version 0.1.0 --json
node deploy/foundry-test/private-mcp-release.mjs \
  --commit REPLACE_WITH_FULL_REVIEWED_COMMIT \
  --module-relative artifacts/private-integration-module/foundry-mcp
```

The artifact output and `private-mcp-release.json` must be new. Review audit
findings and any native dependency build requirement; do not force audit fixes,
ignore failing tests, enable all dependency scripts, or copy Windows dependencies.
The sealing helper requires Linux, clean tracked source, and the exact commit.
It prints only the commit and manifest SHA-256. Record the hash through the
trusted build/review channel, independently of the copy being deployed.

The manifest covers root runtime metadata, Linux pairing helper, the five built
workspace packages, installed dependencies and their relative symlinks, and the
two-file companion. Extra/changed runtime files, escaping symlinks, redirected
ancestor directories, source maps in the companion, missing builds, and unexpected
module contents are refused. A checksum detects changes; it is **not** a signature,
proof of dependency trust, or proof that generated build outputs came from source.
Retain the reviewed clean-build/CI evidence alongside it.

Stage that reviewed Linux runtime at exactly:

```text
/opt/foundry-mcp/releases/FULL_REVIEWED_COMMIT/
```

The staged tree and all its ancestors must be root-owned with no group/world
write permission, no special mode bits, and no ancestor symlinks. Each regular
runtime file must have a single hard link. Runtime files must be world-readable
and runtime directories traversable (normally files `0644`, directories `0755`);
no secret material belongs in that tree. Preserve relative dependency symlinks,
but make independent copies of regular files: do not change ownership of a live
pnpm store or stage hardlinks back to a mutable build/cache tree. Only sealed
runtime files plus the manifest are required by the service; provisioning scripts
may be kept in a separately reviewed root-owned tooling directory. The Node 22
executable must likewise be root-owned, not group/world writable, and readable/
executable by the service account under `/opt` or `/usr`.

## 2. Stop Foundry explicitly and inspect the install plan

Through the owner's VM administration path, stop **only the test Foundry service**
gracefully. Keep Caddy's authenticated owner UI gateway configuration unchanged.
Coordinate exclusive installation: nobody should restart/replace Foundry or edit
its module directory during this operation. The installer checks the exact
`bossforge-foundry-test` / `foundry` Compose labels, a stopped container state,
and `/var/lib/foundry-test/data` bound to `/data`; it rechecks before/after copying.
It never stops a container on the caller's behalf.

From the reviewed tooling directory, run with the root-owned Node 22 binary:

```sh
sudo /opt/node22/bin/node deploy/foundry-test/provision-private-mcp.mjs \
  --release-dir /opt/foundry-mcp/releases/REPLACE_WITH_FULL_REVIEWED_COMMIT \
  --commit REPLACE_WITH_FULL_REVIEWED_COMMIT \
  --manifest-sha256 REPLACE_WITH_RECORDED_64_CHARACTER_SHA256 \
  --allow-owner-tunnel
```

`/opt/node22/bin/node` is an example: use the actual verified executable path.
Without `--apply`, this performs read-only checks and prints a sanitized plan.
It requires root even for inspection because Foundry data and existing private
directories are not public. `--allow-owner-tunnel` adds only the literal allowed
Origin `http://127.0.0.1:39000`; omit it for a VM-local browser on port 30000.
There are no arbitrary origin, public bind, socket port, or key-value options.

When the reviewed plan is correct, repeat the exact command with `--apply`.
It creates/validates the non-login, unprivileged `foundry-mcp` account and its
private directories, installs only `module.json` and `scripts/foundry-mcp.js`
under the test Foundry data (UID/GID `1000:1000`), writes
`/etc/systemd/system/foundry-mcp-host.service`, validates the unit, reloads systemd,
and verifies it remains inactive and not enabled. It grants no sudo/Docker groups.

Existing module/unit or nonempty application state is a refusal, not an upgrade.
Existing unexpected account permissions/groups are also refused. A failed apply
may leave a dedicated account, private directories, a partial new module, or a
stopped unit; inspect the exact paths before any retry. There is no automatic
deletion, rollback, overwrite, or key rotation. An interrupted install can also
leave `/run/foundry-mcp-provision.lock`; verify no installer is running before
an owner removes that single lock. Do not recursively delete the release/data tree.

## 3. Inject the persistent key privately, pair, then start deliberately

Scaffolding may succeed with the key absent because it never starts the host.
After the account exists, the separately approved secret hydrator must supply
`/run/foundry-mcp-credentials/storage-key`: exactly 32 raw bytes, owned by
`foundry-mcp`, mode `0400` or `0600`, single hard link, no symlink, in its `0700`
service-owned directory. The installer inspects metadata only; it never reads
the key. The key must be separately persisted and rehydrated after VM reboot.
Do not generate a different key each boot, put bytes in arguments/environment,
print them, or package them beside encrypted state. `/run` is required to be tmpfs.

Run the existing Linux pairing helper as `foundry-mcp`, with the host stopped,
using the exact release and environment shown in the integration notes. It writes
the code only to a new `0600` file in `/run/foundry-mcp-private`; it does not print
the code. Transfer it through the owner's protected input channel, without terminal
logging, screenshots, traces, or saving it into a source/artifact file. Delete
that one temporary code file after successful pairing. No GM browser is launched
or provisioned by this installer.

For the initial owner's trusted browser, establish both authenticated IAP/SSH
local forwards, each bound explicitly to `127.0.0.1` on the owner's machine:

| Owner loopback    | VM loopback       | Purpose                     |
| ----------------- | ----------------- | --------------------------- |
| `127.0.0.1:39000` | `127.0.0.1:30000` | Foundry GM page             |
| `127.0.0.1:32145` | `127.0.0.1:32145` | Private companion WebSocket |

Open `http://127.0.0.1:39000`, not the public HTTPS domain. Enable the companion
in the disposable world, set `ws://127.0.0.1:32145`, enter the private pairing
code, and keep the authenticated GM page open. Do not use `0.0.0.0`, SSH gateway
ports, public WSS proxying, browser security bypasses, or a remote debugging port.
The second forward exposes no VM public listener; the browser connects to its own
loopback, and the authenticated tunnel reaches the VM's loopback bridge.

The owner-approved disposable world's GM password is intentionally blank. The
strong public owner gateway and Foundry Setup administration password remain
separate controls. A blank GM password is not a public access boundary: keep the
GM page, local forwards, and browser profile owner-only, and do not change that
world setting or expose the Foundry backend directly as part of this installer.

After key injection/pairing readiness and the owner's explicit approval to start,
start the stopped host unit, then reload the GM world to connect. The adapter runs
on the VM as the same `foundry-mcp` user with the same key and `XDG_DATA_HOME`, using
stdio and its private `0600` Unix socket; it is **not** forwarded as a TCP endpoint.
Neither this companion tunnel nor the Foundry UI tunnel exposes an MCP HTTP API.

## Evidence and remaining gates

Before claiming integration, check the service is the expected unprivileged PID,
its TCP listener is only `127.0.0.1:32145`, the reported Unix socket is `0600`
inside the `0700` app-data directory, and an untrusted Origin/unauthenticated client
is rejected. Do not dump environment/config/key files or full browser traces.
The startup `host.ready` record reports endpoint and socket path without secrets.
Discover the actual connection/world/GM/system version via the MCP adapter;
container health alone is not a paired browser connection.

The generated unit uses a read-only filesystem except private application data,
no capabilities, no new privileges, and only Unix/IPv4 socket families. It relies
on the existing host's loopback-only binding, Origin checks, and HMAC transport;
these flags do not themselves implement a firewall. Do not add `PrivateNetwork`
(it would isolate loopback from the owner's tunnel) or disable the Node runtime's
JIT merely to increase a hardening score. See the upstream
[systemd execution controls](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml).

The focused tests run with `node --test deploy/foundry-test/private-mcp.test.mjs`;
POSIX filesystem cases must pass on Linux, not be inferred from Windows skips.
Actual root installation, systemd startup, ownership checks on this VM, authenticated
GM pairing, canonical export, and activity execution remain separate live gates.
The proposed activity-execution contract is not an implemented MCP capability.
Stop the browser, adapter, MCP host, and Foundry after the approved validation
campaign. No service in this slice is enabled for automatic restart or VM boot.
