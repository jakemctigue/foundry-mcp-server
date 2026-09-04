# Host configuration, privacy, and providers

The host reads JSON. The checked-in [`config.example.json`](../config.example.json) is valid, non-secret input that can be passed directly with `foundry-mcp host --config .\config.example.json` or copied to `%LOCALAPPDATA%\foundry-mcp\config.json`.

## Precedence and types

Resolution order is built-in defaults < config file < environment < CLI. A later source replaces the whole value of the same field; arrays are not merged. `--config` must name an existing JSON file. Without it, the host uses `%LOCALAPPDATA%\foundry-mcp\config.json` when that file exists.

| JSON field              | Type and accepted values                                                                            | Environment variable                                             | Relevant host flag                |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------- |
| `port`                  | integer `0..65535`; `0` chooses a dynamic port, while the example uses stable loopback port `32145` | `FOUNDRY_MCP_PORT`                                               | `--port`                          |
| `pipeName`              | 1-64 letters, digits, dots, underscores, or hyphens                                                 | `FOUNDRY_MCP_PIPE_NAME`                                          | `--pipe-name`                     |
| `logLevel`              | `debug`, `info`, `warn`, or `error`                                                                 | `FOUNDRY_MCP_LOG_LEVEL`                                          | `--log-level`                     |
| `dbPath`                | non-empty path; relative paths resolve beneath the per-user app-data directory                      | `FOUNDRY_MCP_DB_PATH`                                            | none                              |
| `eventCategories`       | non-empty string array                                                                              | `FOUNDRY_MCP_EVENT_CATEGORIES` (comma-separated)                 | none                              |
| `capturePrivateContent` | boolean; default `false`                                                                            | `FOUNDRY_MCP_CAPTURE_PRIVATE_CONTENT`                            | none                              |
| `eventRetentionDays`    | integer `1..36500`; default `30`                                                                    | `FOUNDRY_MCP_EVENT_RETENTION_DAYS`                               | none                              |
| `allowedOrigins`        | non-empty array of exact HTTP(S) Origins with no path, credentials, query, fragment, or wildcard    | `FOUNDRY_MCP_ALLOWED_ORIGINS` (comma-separated)                  | repeat `--allow-origin`           |
| `localAssetRoots`       | array of absolute filesystem paths; default `[]` denies every local file                            | `FOUNDRY_MCP_LOCAL_ASSET_ROOTS` (semicolon-separated on Windows) | repeat `--allow-local-asset-root` |

An Origin is the Foundry page's browser Origin, not its world URL. For example, `http://127.0.0.1:30000` is valid, while `http://127.0.0.1:30000/game` and `*` are rejected. With the example's explicit port, the module bridge endpoint emitted by the host is `ws://127.0.0.1:32145`.

Keep `localAssetRoots` empty unless the AI must import a local file. If enabled, choose narrow dedicated directories; the loader resolves the final path, rejects symlinks/junctions and escapes, limits bytes, and validates image data before upload.

## Foundry non-core asset sources

A Game Master can authorize bounded write destinations for a non-core Foundry `FilePicker` source in
**Configure Settings → Module Settings → Foundry MCP non-core asset sources**. This is a world-scoped
String setting and requires a reload. Its value is a JSON object keyed by source ID. For example:

```json
{
  "s3": {
    "writable": true,
    "bucket": "campaign-bucket",
    "writablePathPrefixes": ["campaign/art", "campaign/maps"]
  },
  "forge": {
    "writable": false,
    "reason": "Managed by the hosting provider"
  }
}
```

Each entry requires the boolean `writable`. `bucket`, `writablePathPrefixes`, and `reason` are the
only optional fields. A writable non-core source must have at least one relative, traversal-safe
path prefix; `s3` also requires a bucket. The module accepts at most 16 sources, 32 prefixes per
source, and 16,384 total JSON characters. Invalid, oversized, incomplete, core-source, or
unknown-field configuration is ignored in full, leaving every non-core source read-only.

Do not put access keys, bearer tokens, passwords, endpoint URLs, or any other credential in this
setting. It does not configure provider authentication; Foundry's existing provider configuration
remains authoritative. The strict schema rejects credential fields rather than retaining them.

## Privacy and retention

`capturePrivateContent: false` is the safe default. The event/reconciliation layer suppresses private chat and restricted Journal, Actor, and Item content while retaining public-safe metadata needed for continuity. Enabling private capture is a deliberate policy change: use a private world, review who can query the MCP client, shorten retention where appropriate, and avoid sending captured context to a network provider unless everyone affected has agreed.

Retention runs against the local SQLite intelligence ledger. The default is 30 days. Deleting or shortening retained intelligence does not delete Foundry documents or Journal sessions.

## Image providers

Deterministic PNG generation is available without a credential or network. OpenAI Images is optional and disabled until configured. In a private PowerShell 7 terminal, send the key over stdin so it is not a CLI argument or shell-history token:

```powershell
Read-Host -MaskInput 'OpenAI Images API key' | foundry-mcp provider configure
foundry-mcp provider status
```

The Windows production path stores the value using current-user DPAPI. The command never returns the key. Grant `ai:network` only to the intended connected world/role, and revoke it when network generation is not needed. Remove the stored key with:

```powershell
foundry-mcp provider remove
```

The provider sends the bearer credential only to `https://api.openai.com/v1/images/generations`, bounds output bytes/pixels, validates returned image data, and records provider/model provenance. No live provider call or cost is claimed by the repository tests.

## Linux protected secret storage (opt-in)

Linux services can use an independently provisioned master key instead of the
development fallback. Set `FOUNDRY_MCP_SECRET_KEY_FILE` to an **absolute path to a
regular file containing exactly 32 raw cryptographically random bytes** (not a
hex string, Base64 text, password, or key derived from a username). The environment
contains only the file path, never the key. Leave `NODE_ENV=production` enabled.

Provision the key through the deployment's secret manager or credential injection
mechanism. It must survive a VM stop/restart through that separate secret manager;
do not generate a new master key on each boot. Mount/materialize the same key for
the host, adapter, pairing bootstrap, and provider commands, running as the same
dedicated service account. No cloud SDK, IAM grants, or key provisioning is
performed by this backend.

Requirements:

- Master-key file: mode `0400` or `0600`, owned by the service account (or root if
  the process can legitimately read it), no symlinks or hard links. Keep it outside
  the encrypted `secrets` directory and out of the same backup/archive.
- The encrypted `secrets` directory: owned by the service account, mode `0700`;
  ciphertext files are written with mode `0600`. Parent directories must be owned
  by root or that account and not group/world writable; root-owned sticky `/tmp`
  is permitted as an ancestor. Symlinked path segments are rejected.
- Use a local POSIX filesystem (for example ext4 on a persistent disk), not a
  network/object-store mount. Exclusive file creation has filesystem-specific
  semantics; see the [Node.js filesystem documentation](https://nodejs.org/docs/latest-v22.x/api/fs.html#file-system-flags).
- A missing, exposed, invalid, or wrong key fails closed. The versioned AES-256-GCM
  ciphertext authenticates the secret name as well as the contents. Existing
  DPAPI/development ciphertext is **not automatically migrated or reinterpreted**.
  Rotating the master key requires a separately reviewed re-encryption/re-pairing
  procedure; replacing the key alone makes existing credentials unreadable.

This is a secret-storage prerequisite, not certification of the entire Linux
deployment. It does not expose a new listener, change Origin policy, bypass
bridge HMAC authentication, or make the MCP transports public. Keep the companion
WebSocket on loopback, the adapter on local stdio, and the Unix socket private.
Only Foundry's owner-protected web interface should be reachable through the
`foundrytest.bossforge.dev` HTTPS proxy; never add an MCP proxy route or firewall
opening. Root and processes running as the same service account remain trusted.
Windows continues to use current-user DPAPI; configuring this Linux-only variable
on Windows is rejected rather than silently replacing DPAPI.

### Private Linux pairing bootstrap

The existing `scripts/windows/pair.ps1` is Windows-only. After building the
workspace, Linux uses `scripts/linux/pair.mjs`. Before running it, the deployment
must create the app-data directory and a private temporary output directory owned
by the service account, with mode `0700`, and provision the master key above.
Run bootstrap with the host stopped and only one setup process at a time.
For example, run the following **as that service account from the repository
root**, with those paths already provisioned:

```sh
export NODE_ENV=production
export XDG_DATA_HOME=/var/lib
export FOUNDRY_MCP_SECRET_KEY_FILE=/run/foundry-mcp-credentials/storage-key

node scripts/linux/pair.mjs \
  --app-data /var/lib/foundry-mcp \
  --output-file /run/foundry-mcp-private/pairing-code.txt

node packages/cli/dist/bin.js host --app-data /var/lib/foundry-mcp
```

The bootstrap writes the Base32 pairing code only to the explicitly requested,
new `0600` file. It never prints the code to stdout/stderr and refuses to overwrite
an existing output. Retrieve it through an owner-only administration channel or
let the trusted local browser runner read it, then remove that temporary plaintext
file after configuring the companion. It is not a build artifact or log attachment.
Re-running with a new output filename recovers the existing pairing code without
rotating it or disconnecting a paired world.

The adapter resolves app data from `XDG_DATA_HOME`; it does not use the host's
`--app-data` flag. Ensure it inherits the same three environment values above and
runs as the same account. `XDG_DATA_HOME=/var/lib` resolves to
`/var/lib/foundry-mcp` for the host, provider command, and adapter. Start the local
adapter with `node packages/mcp-adapter/dist/cli.js`; no public TCP endpoint is
required. Optional provider configure/status/remove commands automatically use
this same protected backend. Never put provider credentials or the master-key
bytes in command arguments, checked-in configuration, CI logs, or MCP responses.

Linux-only tests exercise actual filesystem permissions, link rejection, tamper
detection, provider/pairing persistence, and separate host/adapter bridge-key
loading. Those tests are skipped on Windows; a Windows-only pass does not establish
Linux readiness. The complete Linux CI suite must pass before using this in the lab.

## Developer notes

Use Node.js 22 and the pinned pnpm version. Keep adapter stdout protocol-only; diagnostics belong on stderr. Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm test:e2e` before release. Build a distributable companion with `foundry-mcp build-module`; do not install `packages\foundry-module\dist` directly. The release builder allowlists only the manifest and browser bundle and refuses to overwrite an existing artifact.
