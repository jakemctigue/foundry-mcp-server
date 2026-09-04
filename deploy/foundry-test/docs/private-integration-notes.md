# Private MCP integration: supported contracts and remaining work

This is a source-verified implementation plan, not a claim that a licensed
Foundry/browser session has passed live validation. It supplements the
[disposable-host instructions](../README.md). The reviewed deployment checkout
was `f3a74ea72eddaacc4fd841e2b75e65f323dfadc0`; record the actual merged GitHub
commit and artifact hashes used when deploying. Do not deploy from an older
Archon cache or copy a Windows `node_modules` directory to Linux.

## Keep these boundaries

```text
Owner -> HTTPS Caddy password gate -> Foundry UI
                                     127.0.0.1:30000 on VM

Trusted VM-local GM browser -> ws://127.0.0.1:32145 -> MCP host
                                                       ^
Trusted VM-local runner -> MCP adapter stdio -> 0600 Unix socket
```

Only Caddy's 80/443 ports are public. There is no public MCP HTTP/SSE endpoint.
Do not copy the public WSS proxy example from `docs/docker-foundry.md` into this
deployment. A VM-local GM browser must open `http://127.0.0.1:30000`, not the HTTPS
domain. For the initial owner-browser path, the
[first-install provisioner](private-mcp-provisioning.md) has an explicit
`--allow-owner-tunnel` option that also allows only `http://127.0.0.1:39000`.
That path needs two authenticated IAP/SSH forwards, each bound to owner loopback:
39000 to VM loopback 30000, and 32145 to VM loopback 32145. Open the GM page at
`http://127.0.0.1:39000`; no public MCP listener is added. These local HTTP pages
avoid relying on browser-specific HTTPS-to-WS mixed-content exceptions.
Loopback refers to the browser's machine, so a browser on the owner's laptop
does not reach the VM's bridge through `127.0.0.1` without the second tunnel.

Use a dedicated unprivileged Linux account for host, adapter, pairing bootstrap,
and browser runner. Root and processes under that account are trusted. Keep the
browser profile, cookies, pairing value, identity credential, and any debugging
interface private. The companion's client-scoped pairing setting and reconnect
identity are persisted by the browser; do not upload its profile as an artifact.
The browser is an authenticated Game Master and therefore a privileged component.

The Foundry container remains on its pinned Node 24 image. Run MCP using Node 22
and pnpm 9.15.0, matching this repository's manifest and CI. No Windows broker or
DPAPI installation is required on Linux.

## Build the exact source revision

From the reviewed checkout, with Node 22, pnpm 9.15.0, Python 3, and Ubuntu
`build-essential` already provisioned. Node/pnpm executable directories must be
on `PATH` for Turbo's child processes. Review the installed native build scripts
before the explicitly scoped rebuild:

```sh
node --version
pnpm --version
git rev-parse HEAD
pnpm install --frozen-lockfile --ignore-scripts
export PATH="$PWD/node_modules/.bin:$PATH"
export npm_config_node_gyp="$PWD/node_modules/node-gyp/bin/node-gyp.js"
pnpm --recursive rebuild better-sqlite3 esbuild
pnpm exec turbo run build typecheck lint test --concurrency=1
node packages/cli/dist/bin.js build-module \
  --output artifacts/private-integration-module --version 0.1.0 --json
```

The artifact output must be fresh; `build-module` refuses to overwrite an existing
module directory or ZIP. Current package version is `0.1.0`, so also record the
source commit rather than using that version alone as freshness evidence.
Dependency lifecycle scripts stay disabled during the initial install. The
reviewed Ubuntu 24.04 / Node 22.23.2 / Linux x64 `better-sqlite3` 13.0.3 rebuild
invoked `node-gyp rebuild` and required `make` and a C++ compiler. Only the reviewed
`better-sqlite3` and `esbuild` rebuild targets are authorized here. If another
native module is unavailable on the target architecture, stop and review that
specific package/build step; do not blanket-enable dependency scripts.

The release builder produces only:

```text
artifacts/private-integration-module/foundry-mcp/module.json
artifacts/private-integration-module/foundry-mcp/scripts/foundry-mcp.js
artifacts/private-integration-module/foundry-mcp-0.1.0.zip
```

The manifest supports Foundry 14 and the browser bundle is self-contained. Through
the owner's administration path, install only the first two files under:

```text
/var/lib/foundry-test/data/Data/modules/foundry-mcp/module.json
/var/lib/foundry-test/data/Data/modules/foundry-mcp/scripts/foundry-mcp.js
```

Preserve the test-data bind's UID/GID `1000:1000`, stage installation while Foundry
is stopped, and do not overwrite an unverified existing module directory. The
Windows installer is not a supported Linux installer. Do not install the entire
`packages/foundry-module/dist` directory or host credentials into Foundry's data.

## Provision privately, pair, and start

The new [private host provisioner](private-mcp-provisioning.md) performs a
fail-closed first installation from a sealed Linux runtime and prebuilt companion.
It creates a stopped, not-enabled systemd unit; it does not perform the pairing
or browser steps below. Follow its read-only inspection and explicit apply gates.

The owner-controlled bootstrap must first provision:

- `/var/lib/foundry-mcp`: dedicated service account, mode `0700`, local POSIX disk.
- `/run/foundry-mcp-private`: same account, mode `0700`, private temporary output.
- `/run/foundry-mcp-credentials/storage-key`: exactly 32 raw random bytes, mode
  `0400` or `0600`, readable only by the intended account/root. Parent directories
  must satisfy the ownership, permission, and no-symlink requirements in
  [configuration](../../../docs/configuration.md#linux-protected-secret-storage-opt-in).

The storage key must come from a separately persisted secret source and be the
same across restarts. Do not print it, pass its bytes in environment/arguments,
generate a replacement every boot, or store it next to the ciphertext backup.

With the host stopped, run once as that account from the repository root:

```sh
export NODE_ENV=production
export XDG_DATA_HOME=/var/lib
export FOUNDRY_MCP_SECRET_KEY_FILE=/run/foundry-mcp-credentials/storage-key
node scripts/linux/pair.mjs \
  --app-data /var/lib/foundry-mcp \
  --output-file /run/foundry-mcp-private/pairing-code.txt
node packages/cli/dist/bin.js host \
  --app-data /var/lib/foundry-mcp \
  --port 32145 \
  --allow-origin http://127.0.0.1:30000
```

The code is written only to the new owner-only file, not stdout. Bootstrap refuses
to overwrite that file; another new output filename recovers the existing pairing
without rotating it. The host runs in the foreground and handles SIGINT/SIGTERM.
Its readiness message reports `companionEndpoint` and `pipePath`, not credentials.
Use these reported values; do not invent the username-hashed socket filename.

In the local browser's disposable world, enter the owner-approved GM account, enable
**Foundry MCP Companion**, then set:

- **Foundry MCP bridge endpoint**: `ws://127.0.0.1:32145` (world setting).
- **Foundry MCP pairing secret**: the private bootstrap value (client setting).

Transfer the value through a trusted local runner or owner-only UI channel without
logging inputs or recording screenshots/traces containing credentials. Reload the
world. Remove the temporary plaintext code file after successful pairing. The
companion starts on Foundry's `ready` hook only for an authenticated GM; a running
Foundry container without this browser does not provide a live MCP connection.

The trusted runner launches this as its MCP stdio child, with the same account and
the same three environment values above:

```sh
node packages/mcp-adapter/dist/cli.js
```

Do not configure an MCP client to launch the host command. The adapter resolves
`/var/lib/foundry-mcp` from `XDG_DATA_HOME`; it has no `--app-data` option and does
not load the host's JSON config. Keep the default pipe name. If changing it, give
host and adapter the same `FOUNDRY_MCP_PIPE_NAME` environment value.

There is a generated Linux host unit in the first-install provisioner, but no
production GM-browser launcher/login supervisor or `foundry-mcp call` CLI. A browser-runner implementation
must keep the authenticated page alive, handle restart/login/pairing securely,
detect the live world/system versions, and expose no public debugging port.
Do not bypass the browser sandbox or TLS validation to make this work.

## Existing MCP tools: export and actor inspection

Use the MCP client's `tools/call` mechanism, not a guessed HTTP route. First call
`foundry.connections.list` with `{}` and record the returned connection ID,
world ID, GM identity, Foundry version, game-system ID/version, and module list.
The browser constructs IDs as `<worldId>:<userId>`; discover the real value rather
than hard-coding `gm`. Refuse an unexpected world or system.

Call `foundry.compendiums.list` with the explicit connection ID. Confirm the
installed spell pack ID; this campaign expects `dnd5e.spells24`. Export with
`foundry.compendiums.documents.list` and these arguments, replacing the selector:

```json
{
  "connectionId": "REPLACE_WITH_DISCOVERED_CONNECTION_ID",
  "packId": "dnd5e.spells24",
  "hydrate": true,
  "pageSize": 50,
  "sort": { "field": "id", "direction": "asc" }
}
```

Read `structuredContent.items`; each hydrated item includes full `data`, UUID,
source hash/version, schema, ownership, and pack metadata. Continue using
`nextCursor` with the same query until absent. Defaults return only an index, so
`hydrate: true` is essential. The maximum page size is 200. Hydration currently
loads the full pack before slicing each response, so page size is not a bound on
browser memory. Verify counts, spell type, required fields, system version, SRD
provenance, and artwork references before the separate Firebase import. Neither
Firebase writes nor a catalog-format conversion are implemented by this MCP tool.

Reading does not need a mutation grant. To create/update generated actors, the
owner grants only these capabilities for the discovered test GM connection:

```sh
node packages/cli/dist/bin.js capabilities grant \
  --app-data /var/lib/foundry-mcp \
  --connection-id REPLACE_WITH_DISCOVERED_CONNECTION_ID \
  --role GAMEMASTER --capability documents:create
node packages/cli/dist/bin.js capabilities grant \
  --app-data /var/lib/foundry-mcp \
  --connection-id REPLACE_WITH_DISCOVERED_CONNECTION_ID \
  --role GAMEMASTER --capability documents:update
```

`foundry.documents.create` supports `type: "Actor"`, serialized actor `data`, and
`dryRun: true` before a real create. `foundry.documents.get` reads the resulting
actor; `foundry.documents.embedded.list` can inspect its Item documents.
`foundry.documents.update` requires a current source hash/version unless forced;
use the concurrency token rather than forced overwrite. A dry run is schema and
permission validation, not a gameplay test. Native Foundry permission checks still
apply. No `ai:network`, asset upload, or unrelated journal grants are needed for
canonical spell export and actor import. Revoke grants with the same command shape
and action `revoke` after the campaign.

## Missing capability: executing gameplay

The [restricted execution contract](activity-execution-contract.md) is a separate
proposal for review, not an available tool or permission to enable execution.

The implemented companion dispatcher has Document, compendium, asset, and journal
methods only. It does **not** expose spell casting, D&D activity use, attack/damage
rolls, saving throws, target selection, or a validation-report operation. Unknown
methods fail with `NOT_FOUND`. There is deliberately no public document-delete or
arbitrary-JavaScript/macro execution tool. Creating a Macro document does not run
it. Creating an actor or observing chat events is not proof its abilities work.

Before claiming the requested validation is complete, implement and review a
narrow system-specific execution slice against the installed D&D 5E 5.3.3 public
API, or drive actual activity controls through a trusted local UI test runner.
Do not guess method names or add an unrestricted evaluate/run-script endpoint.
For an MCP execution slice, the protocol schema, adapter registration, host
authorization/audit mapping, browser dispatcher/runtime, and tests all need to
agree. It needs explicit GM/test-world authorization, bounded actor/item/activity
selectors and targets, timeouts, resource-consumption policy, and sanitized
structured results. Duplicate/indeterminate mutations must be reconciled before
retrying. Required assertions include actual dice terms, split damage types,
spellcasting ability/modifier/attack bonus/save DC, activity DC versus description,
and failures/cancellations rather than only successful document serialization.

BossForge's server-to-runner job path is also a separate integration: the current
repository does not expose an authenticated private job API or a Firestore queue.
An owner-authorized outbound job-pull runner could avoid any additional VM ingress,
but is a proposal, not existing behavior. Do not connect browser JavaScript in
BossForge directly to MCP or grant end users VM/GM authority.

After live validation, preserve the approved canonical catalog and sanitized
regression evidence, ship source fixes and automated tests, and stop the browser,
adapter, MCP host, and Foundry in that order before the approved disposable-host
teardown. Do not remove production RackNerd resources or the persisted Firebase
catalog. Repeated tests reduce regressions; they do not prove all future generated
actors will be perfect.

## Source pointers

- `packages/cli/src/command-line.ts`, `build-module.ts`, `host-command.ts`, and
  `capability-command.ts`: supported CLI flags, artifacts, lifecycle, and grants.
- `packages/host/src/bridge/companion-server.ts`: loopback default, exact Origin
  and Host validation, HMAC handshake, authenticated connection metadata.
- `packages/host/src/bridge/pipe-server.ts`, `pipe-path.ts`, `bridge-auth.ts`:
  private Unix socket, account-derived path, authenticated adapter transport.
- `packages/mcp-adapter/src/cli.ts`: stdio lifecycle and environment-based lookup.
- `packages/foundry-module/src/module-entry.ts`, `companion-client.ts`: GM-only
  startup, actual setting names, browser persistence and reconnect behavior.
- `packages/protocol/src/document.ts` and
  `packages/foundry-module/src/documents.ts`: hydration/pagination/result contracts.
- `packages/foundry-module/src/companion-handlers.ts` and
  `packages/mcp-adapter/src/server.ts`: implemented method/tool families.
