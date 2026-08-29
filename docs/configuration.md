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

## Developer notes

Use Node.js 22 and the pinned pnpm version. Keep adapter stdout protocol-only; diagnostics belong on stderr. Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm test:e2e` before release. Build a distributable companion with `foundry-mcp build-module`; do not install `packages\foundry-module\dist` directly. The release builder allowlists only the manifest and browser bundle and refuses to overwrite an existing artifact.
