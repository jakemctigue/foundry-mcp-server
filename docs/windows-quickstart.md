# Windows quick start

This guide goes from a fresh clone to a successful `foundry.connections.list` MCP call on Windows. A successful call with `connections: []` proves the client, stdio adapter, and local broker path; it does **not** prove that a live Foundry world is paired. A live connection requires a loadable companion-module artifact, a Foundry v14 world, and the browser bridge.

The current evidence boundary is documented in [validation-matrix.md](./validation-matrix.md).

## Prerequisites

- Windows 10 or 11.
- Git.
- Node.js 22 or newer.
- pnpm 9.15.0 (the version pinned by `packageManager`).
- PowerShell 7 recommended. Windows PowerShell 5.1 is covered by the script tests.
- A licensed Foundry v14 installation and a private test world only for the live-world portion.
- No administrator shell is required or recommended.

Verify the local tools:

```powershell
node --version
pnpm --version
pwsh --version
```

## 1. Clone and build

Substitute the repository URL supplied by the project owner:

```powershell
git clone <REPOSITORY-URL> foundry-mcp-server
Set-Location -LiteralPath .\foundry-mcp-server
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
```

`<REPOSITORY-URL>` is intentionally a placeholder; this checkout's `origin` is an Archon-local path and is not a distributable clone URL.

Run the unlicensed adapter smoke test before involving Foundry:

```powershell
pnpm --filter @foundry-mcp/mcp-adapter test:e2e
```

The smoke test calls `foundry.connections.list`. An empty array is expected when no real world is connected.

## 2. Prepare the companion module

Choose the exact Foundry User Data directory selected in Foundry's configuration. Do not assume the default if you chose a custom path.

```powershell
$FoundryUserData = 'D:\Foundry User Data'
if (-not (Test-Path -LiteralPath $FoundryUserData -PathType Container)) {
    throw "Foundry User Data directory not found: $FoundryUserData"
}
```

Set `$ModulePackage` to a trusted versioned ZIP or module directory whose root contains `module.json` with ID `foundry-mcp`:

```powershell
$ModulePackage = 'C:\Downloads\foundry-mcp-module.zip'
if (-not (Test-Path -LiteralPath $ModulePackage)) {
    throw "Module package not found: $ModulePackage"
}
```

`pnpm build` alone must not be assumed to produce a loadable module ZIP. At the time of this documentation pass, this checkout did not contain a versioned ZIP or a built `module.json`; live installation is therefore marked unavailable in the validation matrix. Do not manufacture a manifest around `packages\foundry-module\dist` and call it a release artifact.

Install only after a valid artifact exists:

```powershell
& .\scripts\windows\install.ps1 `
    -FoundryUserDataPath $FoundryUserData `
    -ModuleSourcePath $ModulePackage `
    -Layout Desktop
```

The installer uses literal paths, records owned file hashes, is rerunnable, and refuses to overwrite an unowned module directory.

Launch Foundry, open a non-production test world as an authorized GM, enable the `foundry-mcp` module, and reload the world. If the module does not expose the documented GM-only pairing and bridge settings, stop: the live bridge path is not complete in that artifact.

## 3. Generate or rotate the pairing secret

Resolve the built adapter and run the pairing script:

```powershell
$AdapterPath = (Resolve-Path -LiteralPath .\packages\mcp-adapter\dist\cli.js).Path
$NodePath = (Get-Command node.exe).Source
& .\scripts\windows\pair.ps1 `
    -AdapterCommand $NodePath `
    -AdapterArguments @($AdapterPath)
```

The script:

- generates a cryptographically random value;
- protects the local copy with current-user DPAPI;
- displays the pairing secret once for entry into the module's GM-only setting; and
- prints MCP client JSON that contains the adapter command and **does not contain the secret**.

Paste the one-time secret into the module setting, save it, and clear the terminal if its scrollback is not private. Do not put the secret in MCP client JSON, command history, an environment file, chat, or source control. Run the script again to rotate a suspected secret, then replace the value in the module.

## 4. Start the local host

Until a packaged launcher is available, use a dedicated PowerShell terminal from the repository root:

```powershell
node --input-type=module -e "const { startDaemon } = await import('./packages/host/dist/index.js'); const daemon = await startDaemon(); console.error('foundry-mcp host ready at ' + daemon.pipePath); const stop = async () => { await daemon.shutdown(); process.exit(0); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); await new Promise(() => {});"
```

Leave this terminal open. Press Ctrl+C for a graceful shutdown. The host writes diagnostics to stderr; MCP stdio stdout remains protocol-only.

The module's browser bridge URL is a separate setting from the named pipe. Use the endpoint supplied by the broker deployment:

- an HTTP Foundry page may use `ws://`;
- an HTTPS Foundry page must use `wss://` with a certificate trusted by the browser; and
- the exact Foundry origin (`scheme://host:port`, no path) must be allowlisted.

Do not invent a bridge port or expose an unauthenticated listener on `0.0.0.0`. The current implementation snapshot has no recorded live browser-bridge endpoint, so this part requires a completed broker artifact and manual validation.

## 5. Run doctor

In a second terminal:

```powershell
node .\packages\cli\dist\bin.js doctor --foundry-data $FoundryUserData
```

For an explicitly configured browser bridge, add the real values:

```powershell
$BridgeUrl = 'wss://broker.example.test/foundry-mcp'
$FoundryOrigin = 'https://foundry.example.test'
node .\packages\cli\dist\bin.js doctor `
    --foundry-data $FoundryUserData `
    --bridge-url $BridgeUrl `
    --foundry-origin $FoundryOrigin `
    --allow-origin $FoundryOrigin
```

`FAIL` rows must be fixed before a live test. `WARN` may mean an optional provider is disabled, no status snapshot exists, or no active world is connected; read the remediation beside each warning rather than ignoring it.

## 6. Configure the MCP client

Copy the `mcpServers.foundry-vtt` object printed by `pair.ps1` into the MCP configuration supported by your desktop client. Configuration-file location and reload behavior are client-specific; use that client's current documentation. The shape is generic:

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

Use absolute paths. Restart or reload the MCP client after editing its configuration. Do not add the pairing secret to this JSON.

## 7. Make the first call

In the MCP client's tool picker, call:

- tool: `foundry.connections.list`
- arguments: `{}`

A successful transport-only response has this structure:

```json
{
  "connections": []
}
```

That result is a valid first MCP call but is not live Foundry evidence. A genuinely paired world returns at least one connection record with a stable `connectionId`, `worldId`, `worldTitle`, and `status`. Record the `connectionId`; later calls must use an explicit selector whenever more than one eligible world is present.

Do not report the quick start as live-complete unless all of the following are observed together:

1. the module is enabled in the intended Foundry v14 world;
2. doctor reports the expected module and bridge state;
3. `foundry.connections.list` returns that world's real ID/title as connected; and
4. Foundry and browser logs show no pairing, Origin, mixed-content, or protocol error.

## Troubleshooting

| Symptom                           | Check                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client cannot start adapter       | Use absolute `command` and `args` paths; rebuild; confirm Node 22+; inspect client stderr, never stdout.                                                            |
| `connections: []`                 | Confirm host is running, module is enabled in the correct world, the secret matches, bridge URL is reachable from the browser, and the exact Origin is allowlisted. |
| Browser reports mixed content     | An HTTPS Foundry page cannot open `ws://`; use a browser-trusted `wss://` endpoint.                                                                                 |
| Module not found                  | Confirm `$FoundryUserData\Data\modules\foundry-mcp\module.json`; a custom User Data path is a common source of mistakes.                                            |
| Pairing fails after rotation      | Update the module with the newly displayed secret and reconnect; old values must stop working.                                                                      |
| Doctor reports pending migrations | Stop the host, back up its application-data directory, run the supported migration/start path, then rerun doctor.                                                   |
| Provider warning                  | Providers are optional and disabled by default. Configure one only after reviewing privacy and cost policy.                                                         |
| MCP JSON is corrupted             | Ensure nothing writes logs or banners to adapter stdout. Diagnostics belong on stderr.                                                                              |

## Safe removal

Stop the host and disable the module in Foundry. Then run:

```powershell
& .\scripts\windows\uninstall.ps1 -FoundryUserDataPath $FoundryUserData
```

The uninstaller removes only manifest-owned files whose hashes still match. It refuses an unrecognized directory, refuses modified owned files, and preserves unrelated files. It does not delete worlds, Foundry User Data, or application data.
