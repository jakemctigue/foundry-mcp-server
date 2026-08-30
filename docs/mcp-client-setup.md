# Install Foundry MCP in Claude Code, Codex, and Cursor

This walkthrough starts from a fresh source checkout, installs the Foundry v14 browser companion, pairs the current Windows user, runs the local host, and registers the stdio adapter in Claude Code, OpenAI Codex, or Cursor.

The supported production path is native Windows 10 or 11. Run the host, adapter, and MCP client as the same non-administrator Windows user. The adapter connects to a current-user Windows named pipe, so a client running inside WSL, a container, another Windows account, or an elevated session is not equivalent to the supported native-Windows path.

## Understand the three moving pieces

There are three cooperating processes:

1. **Foundry MCP Companion** runs in an authenticated GM browser tab and uses Foundry's public APIs.
2. **The Foundry MCP host** is a long-running Windows process. It owns pairing, policy, grants, the browser WebSocket bridge, and the local SQLite intelligence store.
3. **The stdio adapter** is started automatically by Claude Code, Codex, or Cursor. It translates MCP JSON-RPC on standard input/output into the host's current-user named pipe.

Do not configure the client to launch `foundry-mcp host`. Configure it to launch `packages\mcp-adapter\dist\cli.js`. Start the host separately before opening or refreshing the MCP client.

## 1. Install prerequisites and clone the repository

You need:

- Windows 10 or 11;
- a licensed Foundry Virtual Tabletop v14 installation and a disposable or backed-up test world;
- Git;
- Node.js 22 or newer;
- pnpm 9.15.0;
- PowerShell 7; and
- the CLI for each client you intend to configure.

The GitHub repository is private, so authenticate GitHub CLI first or use an already-authorized SSH key:

```powershell
gh auth login
gh repo clone jakemctigue/foundry-mcp-server
Set-Location .\foundry-mcp-server
```

Check the required tools:

```powershell
git --version
node --version
pnpm --version
pwsh --version
```

Build the entire workspace:

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
```

For this source checkout, define the `foundry-mcp` command in every PowerShell session where you need the administrative CLI:

```powershell
$RepositoryPath = (Resolve-Path -LiteralPath .).Path
$FoundryMcpCli = (Resolve-Path -LiteralPath .\packages\cli\dist\bin.js).Path
function foundry-mcp { & node $FoundryMcpCli @args }
```

This function is session-local. Opening another terminal does not preserve it.

## 2. Build and install the Foundry companion

The release builder refuses to overwrite an existing artifact, so use a fresh output directory:

```powershell
$ReleaseDirectory = Join-Path $RepositoryPath 'release'
$Release = foundry-mcp build-module --json --output $ReleaseDirectory | ConvertFrom-Json
$ModulePackage = $Release.zipPath
$Release
```

Set the exact User Data directory shown in Foundry's configuration. This is the directory that contains Foundry's `Data` directory, not the Foundry application directory.

```powershell
$FoundryUserData = 'D:\Foundry User Data'
```

Preview the install first:

```powershell
& .\scripts\windows\install.ps1 `
    -FoundryUserDataPath $FoundryUserData `
    -ModuleSourcePath $ModulePackage `
    -Layout Desktop `
    -WhatIf
```

If the preview names the correct destination, install it:

```powershell
& .\scripts\windows\install.ps1 `
    -FoundryUserDataPath $FoundryUserData `
    -ModuleSourcePath $ModulePackage `
    -Layout Desktop
```

The resulting manifest should exist here:

```powershell
Test-Path -LiteralPath (Join-Path $FoundryUserData 'Data\modules\foundry-mcp\module.json')
```

The expected result is `True`. For Docker-hosted Foundry, use the host-side writable User Data bind and `-Layout DockerBindMount`; see [Docker-hosted Foundry](./docker-foundry.md).

## 3. Pair the current Windows user

Resolve the exact executables and built adapter. These same two values are used in all three client configurations:

```powershell
$NodePath = (Get-Command node.exe).Source
$AdapterPath = (Resolve-Path -LiteralPath .\packages\mcp-adapter\dist\cli.js).Path

$NodePath
$AdapterPath
Test-Path -LiteralPath $AdapterPath
```

Preview pairing, then run it:

```powershell
& .\scripts\windows\pair.ps1 `
    -AdapterCommand $NodePath `
    -AdapterArguments @($AdapterPath) `
    -WhatIf

& .\scripts\windows\pair.ps1 `
    -AdapterCommand $NodePath `
    -AdapterArguments @($AdapterPath)
```

The real command displays a Base32 pairing value once and prints secret-free MCP client JSON. Paste the Base32 value only into the Foundry module's password setting. Do not put it in an MCP configuration, environment variable, screenshot, chat, or source control. The host copy is protected for the current Windows user with DPAPI.

Rerunning pairing rotates the secret and clears mutation grants for that connection. If you rotate it, update the Foundry module setting and grant only the capabilities you still intend to use.

## 4. Start the host and connect the Foundry world

The checked-in example expects Foundry to be opened at `http://127.0.0.1:30000` and binds the companion bridge to `ws://127.0.0.1:32145`. If your Foundry browser Origin differs, edit a copy of `config.example.json` before continuing. An Origin contains only scheme, host, and port—never a path such as `/game`.

In a dedicated foreground terminal, define the source-checkout function again and start the host:

```powershell
Set-Location $RepositoryPath
$FoundryMcpCli = (Resolve-Path -LiteralPath .\packages\cli\dist\bin.js).Path
function foundry-mcp { & node $FoundryMcpCli @args }

foundry-mcp host --config .\config.example.json
```

Leave this terminal open. The readiness record on stderr includes `companionEndpoint` and `pipePath`.

Then:

1. Start Foundry v14.
2. Open the intended world as an authenticated Game Master.
3. Enable **Foundry MCP Companion** for that world.
4. In the module's GM-only settings, set **Foundry MCP bridge endpoint** to the exact `companionEndpoint` emitted by the host.
5. Paste the one-time pairing value into **Foundry MCP pairing secret**.
6. Reload when Foundry requests it.

For the checked-in example, the endpoint is `ws://127.0.0.1:32145`. If Foundry itself is served over HTTPS, the browser will reject an insecure `ws://` bridge; use a browser-trusted `wss://` reverse proxy as described in [Docker-hosted Foundry](./docker-foundry.md#http-https-and-exact-origin).

## 5. Run the preflight doctor

In another PowerShell terminal:

```powershell
Set-Location $RepositoryPath
$FoundryMcpCli = (Resolve-Path -LiteralPath .\packages\cli\dist\bin.js).Path
function foundry-mcp { & node $FoundryMcpCli @args }

$FoundryOrigin = 'http://127.0.0.1:30000'
$BridgeUrl = 'ws://127.0.0.1:32145'

foundry-mcp doctor `
    --config .\config.example.json `
    --foundry-data $FoundryUserData `
    --bridge-url $BridgeUrl `
    --foundry-origin $FoundryOrigin `
    --allow-origin $FoundryOrigin
```

Fix every `FAIL`. A `WARN` can indicate that no world is connected yet or that an optional provider is disabled; read the remediation printed with it.

## 6A. Install in Claude Code

Claude Code supports local, project, and user MCP scopes. This server's configuration contains machine-specific absolute paths, so `local` is the safest default: it applies only to this project for your user and does not create a shared `.mcp.json` file.

Run this from the repository root:

```powershell
claude mcp add --scope local --transport stdio foundry-vtt -- $NodePath $AdapterPath
```

Verify the saved definition and connection health:

```powershell
claude mcp get foundry-vtt
claude mcp list
```

If you deliberately want the same configuration in every project on this Windows account, remove the local entry and add it with `--scope user`. Use `--scope project` only when you intend to create a team-shared `.mcp.json`; do not commit another person's absolute path.

Open or restart Claude Code in the repository. Run `/mcp` to inspect the server if needed, then ask Claude:

```text
Use foundry.connections.list with an empty object and show me the result.
```

To replace a stale entry:

```powershell
claude mcp remove foundry-vtt
claude mcp add --scope local --transport stdio foundry-vtt -- $NodePath $AdapterPath
```

Current Claude Code MCP reference: [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp).

## 6B. Install in OpenAI Codex

Codex CLI and the Codex app use the user configuration at `~/.codex/config.toml`. Add the local stdio server with the exact Windows executable and adapter paths:

```powershell
codex mcp add foundry-vtt -- $NodePath $AdapterPath
```

Verify it:

```powershell
codex mcp get foundry-vtt
codex mcp list
```

The equivalent TOML shape is shown below for reference. Prefer `codex mcp add`, which avoids manual quoting mistakes.

```toml
[mcp_servers.foundry-vtt]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\path\to\foundry-mcp-server\packages\mcp-adapter\dist\cli.js']
```

Restart the Codex CLI session or start a new Codex app task after changing MCP configuration. Then ask:

```text
Use foundry.connections.list with {} and report the connected Foundry worlds.
```

To replace a stale entry:

```powershell
codex mcp remove foundry-vtt
codex mcp add foundry-vtt -- $NodePath $AdapterPath
```

Current official OpenAI documentation: [Model Context Protocol in Codex](https://developers.openai.com/codex/mcp/).

## 6C. Install in Cursor

Cursor reads project MCP configuration from `.cursor\mcp.json`. It also supports a user-level file at `%USERPROFILE%\.cursor\mcp.json`. Project configuration is convenient for this checkout, but the absolute paths make it machine-specific; keep the file uncommitted unless every collaborator agrees on a portable wrapper.

Create `.cursor\mcp.json` with the following structure, replacing both example paths with the values printed by `$NodePath` and `$AdapterPath`. JSON requires doubled backslashes.

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

Alternatively, generate the file from the already-resolved paths so PowerShell handles JSON escaping:

```powershell
$CursorDirectory = Join-Path $RepositoryPath '.cursor'
$CursorConfigPath = Join-Path $CursorDirectory 'mcp.json'
New-Item -ItemType Directory -Path $CursorDirectory -Force | Out-Null

if (Test-Path -LiteralPath $CursorConfigPath) {
    throw "Cursor MCP configuration already exists at $CursorConfigPath. Merge the foundry-vtt entry instead of overwriting it."
}

$CursorConfig = @{
    mcpServers = @{
        'foundry-vtt' = @{
            command = $NodePath
            args = @($AdapterPath)
        }
    }
}

$CursorConfig | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $CursorConfigPath -Encoding utf8
Get-Content -LiteralPath $CursorConfigPath
```

Open the repository as a Cursor workspace, open Cursor Settings, find the MCP/Tools section, and confirm `foundry-vtt` is enabled. Reload the Cursor window after changing `mcp.json`. If the Cursor CLI is installed, it can also display configured server status:

```powershell
agent mcp list
```

In Cursor Agent, ask:

```text
Call foundry.connections.list with {}. Do not infer a connection if the returned list is empty.
```

Current Cursor MCP reference: [Model Context Protocol](https://cursor.com/docs/mcp).

## 7. Prove the full connection

The first MCP call should be:

```text
foundry.connections.list {}
```

Interpret the result carefully:

- `connections: []` proves that the client spawned the adapter and reached the host through the named pipe. It does **not** prove that Foundry or a world is connected.
- A live Foundry pass returns a non-empty record containing a stable `connectionId`, `worldId`, title, current user and role, system/version details, active modules, and module capabilities.
- If multiple eligible worlds are connected, every world-scoped call must use an explicit `connectionId`. Never let an agent guess which world to mutate.

Save the exact `connectionId`, then inspect the public surface or try a read-only operation before granting mutations. Read operations still obey Foundry's native permissions.

## 8. Grant narrowly scoped mutation capabilities

Mutation tools fail closed until the current Foundry role has an explicit host grant. In a terminal with the `foundry-mcp` function:

```powershell
$ConnectionId = 'replace-with-the-real-connection-id'

foundry-mcp capabilities list --connection-id $ConnectionId
foundry-mcp capabilities grant --connection-id $ConnectionId --role GAMEMASTER --capability documents:create
foundry-mcp capabilities grant --connection-id $ConnectionId --role GAMEMASTER --capability documents:update
```

Grant additional capabilities only when needed:

```powershell
foundry-mcp capabilities grant --connection-id $ConnectionId --role GAMEMASTER --capability assets:upload
foundry-mcp capabilities grant --connection-id $ConnectionId --role GAMEMASTER --capability assets:attach
foundry-mcp capabilities grant --connection-id $ConnectionId --role GAMEMASTER --capability sessions:start
foundry-mcp capabilities grant --connection-id $ConnectionId --role GAMEMASTER --capability sessions:append
```

Use the same command shape with `revoke` to remove access. Native Foundry permissions and the host policy can still deny an operation even when a capability is granted.

## 9. Optional: start the host at Windows logon

First prove that foreground hosting works. Then preview and register the repository's limited, per-user interactive-logon task:

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

The task is intentionally non-elevated and owned by the current user. Client applications can start and stop independently; their stdio adapters reconnect to the persistent host through the current-user pipe.

## Troubleshooting

| Symptom                                        | Most likely checks                                                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client says the command or file does not exist | Re-run `$NodePath` and `$AdapterPath`; use absolute paths; rebuild with `pnpm build`; double backslashes only in JSON, not PowerShell CLI arguments.                                   |
| MCP server disconnects immediately             | Start the host first; inspect the client's MCP log and adapter stderr; do not run the adapter with a non-Windows Node executable.                                                      |
| `connections: []`                              | Confirm the module is enabled in the intended world, the GM browser tab is open, the bridge endpoint is exact, the Origin is allowlisted, and the pairing secret has not been rotated. |
| Pairing secret missing                         | Run `pair.ps1` and the host as the same Windows user and with the same app-data location. Do not elevate only one component.                                                           |
| Browser reports mixed content                  | An HTTPS Foundry page cannot open `ws://`; terminate a trusted `wss://` proxy to the loopback bridge.                                                                                  |
| Mutation is denied                             | Check the exact `connectionId`, current Foundry role, explicit host capability grant, and the document's native Foundry permission.                                                    |
| Cursor shows no tools                          | Validate `.cursor\mcp.json`, reload the window, and enable the server in Cursor's MCP/Tools settings.                                                                                  |
| Claude Code shows pending approval             | Approve the project-scoped server in `/mcp`, or use local scope for the machine-specific entry.                                                                                        |
| Codex still shows the old path                 | Run `codex mcp get foundry-vtt`; remove and re-add the entry; then start a new task/session.                                                                                           |
| More than one world is connected               | Pass the intended stable `connectionId` on every world-scoped call.                                                                                                                    |

For deeper host, privacy, provider, and Origin settings, see [Host configuration, privacy, and providers](./configuration.md). For the exact tools, resources, and prompts exposed to clients, see [Tools, resources, and prompts](./tools-reference.md).
