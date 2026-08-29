# Windows quick start

This guide builds a loadable Foundry v14 module, installs it transactionally, pairs the current Windows user, starts the local host, and reaches the first MCP call. A successful `foundry.connections.list` with `connections: []` proves the adapter/pipe path only; a live pass requires a non-empty record from your licensed test world.

The exact automated/manual boundary is in [validation-matrix.md](./validation-matrix.md).

## Prerequisites

- Windows 10 or 11; no administrator shell is required or recommended.
- Node.js 22+, pnpm 9.15.0, Git, and PowerShell 7.
- A licensed Foundry v14 installation and a disposable or backed-up test world for live validation.

```powershell
node --version
pnpm --version
pwsh --version
```

## 1. Build the workspace and source-checkout CLI

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
```

An installed release exposes `foundry-mcp` directly. In this source checkout, define the same command for the current PowerShell session:

```powershell
$FoundryMcpCli = (Resolve-Path -LiteralPath .\packages\cli\dist\bin.js).Path
function foundry-mcp { & node $FoundryMcpCli @args }
```

The examples use [`config.example.json`](../config.example.json): exact Foundry Origin `http://127.0.0.1:30000`, stable loopback bridge port `32145`, private capture off, 30-day retention, and local-file import denied. Edit the exact Origin before continuing if your browser opens Foundry at another scheme, host, or port. See [configuration.md](./configuration.md) for types and precedence.

## 2. Build and transactionally install the companion

Choose a fresh output directory because the release builder refuses to overwrite an existing artifact:

```powershell
$Release = foundry-mcp build-module --json --output .\release | ConvertFrom-Json
$ModulePackage = $Release.zipPath
$Release
```

The ZIP contains only `foundry-mcp/module.json` and `foundry-mcp/scripts/foundry-mcp.js`. It is the same artifact for desktop Foundry and a Docker User Data bind mount.

Set the exact User Data directory selected in Foundry, then preview and run the installer:

```powershell
$FoundryUserData = 'D:\Foundry User Data'

& .\scripts\windows\install.ps1 `
    -FoundryUserDataPath $FoundryUserData `
    -ModuleSourcePath $ModulePackage `
    -Layout Desktop `
    -WhatIf

& .\scripts\windows\install.ps1 `
    -FoundryUserDataPath $FoundryUserData `
    -ModuleSourcePath $ModulePackage `
    -Layout Desktop
```

Installation validates the archive before extraction, rejects traversal/reparse/special-file/decompression abuse, stages beside the target, and swaps atomically with rollback. A rerun upgrades only an owned module directory and preserves unrelated files.

Expected manifest:

```text
<FoundryUserData>\Data\modules\foundry-mcp\module.json
```

## 3. Pair this Windows user

Pairing creates a 32-byte secret, stores the host copy under current-user DPAPI, and displays a Base32 value once for the module's password field. Preview mode creates no secret. On the first authenticated bridge connection, the host also enrolls a browser-local, connection-scoped identity credential. Later reconnects must prove that identity before the host will reuse the connection or its grants.

```powershell
$AdapterPath = (Resolve-Path -LiteralPath .\packages\mcp-adapter\dist\cli.js).Path
$NodePath = (Get-Command node.exe).Source

& .\scripts\windows\pair.ps1 `
    -AdapterCommand $NodePath `
    -AdapterArguments @($AdapterPath) `
    -WhatIf

& .\scripts\windows\pair.ps1 `
    -AdapterCommand $NodePath `
    -AdapterArguments @($AdapterPath)
```

Keep the displayed secret out of configuration files, environment variables, command history, screenshots, chat, and source control. Save the secret-free MCP client JSON printed by the script. Rerunning the command rotates the secret; update the module afterward and confirm the old value no longer connects.

## 4. Start the host and configure the real module endpoint

Run the host in a dedicated foreground terminal:

```powershell
foundry-mcp host --config .\config.example.json
```

On readiness, stderr prints a JSON record containing `companionEndpoint` and `pipePath`. With the checked-in explicit port, the endpoint is:

```text
ws://127.0.0.1:32145
```

Now start Foundry, open the intended test world as an authenticated GM, enable **Foundry MCP Companion**, and reload. In the module's GM-only settings:

1. set **Foundry MCP bridge endpoint** to the exact emitted endpoint, with no invented path;
2. paste the one-time pairing value into **Foundry MCP pairing secret**; and
3. reload when Foundry requests it.

The browser page's exact Origin must also appear in `allowedOrigins`. An HTTP Foundry page can use loopback `ws://`. An HTTPS Foundry page must use a browser-trusted `wss://` reverse proxy; do not disable mixed-content or Origin checks.

Press Ctrl+C to shut the foreground host down cleanly.

## 5. Run doctor

In a second terminal with the same session-local function:

```powershell
$FoundryOrigin = 'http://127.0.0.1:30000'
$BridgeUrl = 'ws://127.0.0.1:32145'

foundry-mcp doctor `
    --config .\config.example.json `
    --foundry-data $FoundryUserData `
    --bridge-url $BridgeUrl `
    --foundry-origin $FoundryOrigin `
    --allow-origin $FoundryOrigin
```

Fix every `FAIL`. A `WARN` may mean no active world, optional provider, or status snapshot; read its remediation. Doctor validates local state and URL policy, not a live browser certificate, Docker daemon, or Foundry API.

## 6. Connect the MCP client and discover the world

Copy the secret-free `mcpServers.foundry-vtt` object printed by `pair.ps1` into the configuration supported by your MCP desktop client. It should use absolute paths and contain no pairing or provider secret:

```json
{
  "mcpServers": {
    "foundry-vtt": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\foundry-mcp-server\\packages\\mcp-adapter\\dist\\cli.js"]
    }
  }
}
```

Reload that client and call `foundry.connections.list` with `{}`. A paired world returns a stable `connectionId`, `worldId`, title, current user/role, system/version, active modules, and module capabilities. Save the exact `connectionId`; every world-scoped call must select it.

## 7. Grant only intended mutations

Read tools work without mutation grants and are still limited by Foundry permissions. List current grants:

```powershell
$ConnectionId = 'your-real-connection-id'
foundry-mcp capabilities list --connection-id $ConnectionId
```

Grant one capability at a time to the connected Foundry role:

```powershell
foundry-mcp capabilities grant --connection-id $ConnectionId --role GAMEMASTER --capability documents:create
foundry-mcp capabilities grant --connection-id $ConnectionId --role GAMEMASTER --capability documents:update
foundry-mcp capabilities grant --connection-id $ConnectionId --role GAMEMASTER --capability assets:upload
foundry-mcp capabilities grant --connection-id $ConnectionId --role GAMEMASTER --capability assets:attach
foundry-mcp capabilities grant --connection-id $ConnectionId --role GAMEMASTER --capability sessions:start
foundry-mcp capabilities grant --connection-id $ConnectionId --role GAMEMASTER --capability sessions:append
```

Use the same syntax with `revoke`. Valid roles are `PLAYER`, `TRUSTED`, `ASSISTANT`, and `GAMEMASTER`; the policy layer can still refuse a grant or operation above that role's ceiling. OpenAI generation additionally requires `ai:network`.

Rotating the pairing secret or enrolling a new identity deliberately clears mutation grants for that connection. Re-run only the grants you still intend. If browser storage containing the connection credential is lost, rotate and re-pair instead of weakening identity checks.

## 8. Optional OpenAI Images provider

Deterministic local image generation needs no key. To opt in to OpenAI Images, pass the key over stdin in a private PowerShell 7 terminal:

```powershell
Read-Host -MaskInput 'OpenAI Images API key' | foundry-mcp provider configure
foundry-mcp provider status
foundry-mcp capabilities grant --connection-id $ConnectionId --role GAMEMASTER --capability ai:network
```

The production Windows path stores the key with current-user DPAPI and never echoes it. Revoke `ai:network` and run `foundry-mcp provider remove` to disable it. No external provider call is required for deterministic generation or repository tests.

## 9. Foreground and logon launchers

`foundry-mcp host` is the full foreground CLI. The checked-in PowerShell launcher offers the same bounded Windows source-checkout path and supports `-WhatIf`:

```powershell
$RepositoryPath = (Resolve-Path -LiteralPath .).Path

& .\scripts\windows\start-host.ps1 `
    -RepositoryPath $RepositoryPath `
    -NodePath $NodePath `
    -AllowedOriginsCsv $FoundryOrigin `
    -CompanionPort 32145 `
    -WhatIf
```

Remove `-WhatIf` to run it in the foreground. To start at this user's interactive logon with a limited principal, first preview and then register the owned task:

```powershell
& .\scripts\windows\install-logon-task.ps1 `
    -RepositoryPath $RepositoryPath `
    -NodePath $NodePath `
    -AllowedOrigin @($FoundryOrigin) `
    -CompanionPort 32145 `
    -WhatIf

& .\scripts\windows\install-logon-task.ps1 `
    -RepositoryPath $RepositoryPath `
    -NodePath $NodePath `
    -AllowedOrigin @($FoundryOrigin) `
    -CompanionPort 32145
```

The task is per-user, interactive-logon only, limited (not elevated), and refuses to replace or remove an unowned task. Remove it with:

```powershell
& .\scripts\windows\remove-logon-task.ps1 -RepositoryPath $RepositoryPath -WhatIf
& .\scripts\windows\remove-logon-task.ps1 -RepositoryPath $RepositoryPath
```

The task launcher intentionally exposes only host/port/pipe/log/origin/app-data controls. Use `foundry-mcp host --config ...` when you need custom retention, event categories, or local asset roots.

## Troubleshooting

| Symptom                             | Check                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `connections: []`                   | Host is running, module is enabled in the intended world, endpoint is exact, pairing values match, and browser Origin is allowlisted. |
| Browser mixed-content error         | HTTPS Foundry cannot open `ws://`; use a trusted `wss://` reverse proxy to the loopback host.                                         |
| Host says pairing secret is missing | Run `pair.ps1` as the same Windows user and with the same app-data path before starting the host.                                     |
| Module is absent                    | Check `<FoundryUserData>\Data\modules\foundry-mcp\module.json` and restart/reload Foundry's package list.                             |
| Mutation is denied                  | Confirm the selected `connectionId`, current Foundry role, explicit capability grant, and native Document permission.                 |
| Local image import is denied        | `localAssetRoots` defaults to `[]`; add only an absolute dedicated directory and restart the host.                                    |
| MCP client shows malformed protocol | Adapter stdout must remain JSON-RPC only; inspect stderr for diagnostics.                                                             |

## Safe removal

Disable the module and stop the host. Preview and run the ownership-aware uninstaller:

```powershell
& .\scripts\windows\uninstall.ps1 -FoundryUserDataPath $FoundryUserData -WhatIf
& .\scripts\windows\uninstall.ps1 -FoundryUserDataPath $FoundryUserData
```

It removes only manifest-owned files whose hashes still match, preserves unrelated files, and never deletes worlds or the User Data root. Provider and pairing secrets remain in the per-user app-data directory until deliberately rotated/removed.
