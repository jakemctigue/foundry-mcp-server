# Docker-hosted Foundry

Foundry MCP supports a user-managed, licensed Foundry v14 container without embedding Foundry, choosing an image, handling its license, or touching the Docker socket. The companion runs in the authenticated GM's browser and connects to the same local Windows host used for desktop Foundry.

No licensed container was started for this repository pass. The loadable module, bind-mount installer, Compose rendering, real local transports, and mocked Foundry lifecycle are automated; image-specific configuration and the live browser/container boundary remain manual in [validation-matrix.md](./validation-matrix.md).

## Deployment boundary

```text
MCP desktop client -> Windows stdio adapter -> current-user pipe -> Windows host
                                                             ^
                                                             | authenticated ws/wss
Docker Foundry -> GM browser -> foundry-mcp browser companion -+
      |
      +-> writable host User Data bind/Data/modules/foundry-mcp
```

Keep the SQLite database, pairing secret, provider key, and MCP client configuration on the Windows desktop. Only the allowlisted companion files go into Foundry's writable User Data bind. The browser—not the Docker container—opens the bridge URL.

## Checked-in Compose templates

This repository includes two image-neutral files:

- [`compose.foundry-mcp.example.yaml`](../compose.foundry-mcp.example.yaml) is a complete single-service example.
- [`compose.foundry-mcp.override.yaml`](../compose.foundry-mcp.override.yaml) adds/replaces the writable User Data bind on an existing service named `foundry`.

Both require a user-supplied authorized image and explicit host/container paths. Neither contains a license key, administrator password, token, or opinionated image-specific path.

Render the standalone example before starting anything:

```powershell
$env:FOUNDRY_IMAGE = 'your-authorized-registry/foundry:your-pinned-version'
$env:FOUNDRY_USER_DATA = 'D:\Foundry Docker Data'
$env:FOUNDRY_CONTAINER_USER_DATA = '/path/required/by/your/image'
$env:FOUNDRY_HTTP_BIND = '127.0.0.1:30000'
$env:FOUNDRY_CONTAINER_PORT = '30000'

docker compose -f .\compose.foundry-mcp.example.yaml config
```

For an existing Compose project whose service is named `foundry`, render both files in the same order you will run them:

```powershell
docker compose `
    -f .\compose.yaml `
    -f .\compose.foundry-mcp.override.yaml `
    config
```

Inspect the rendered image, port mapping, and `volumes` target. The later file wins when two volume entries use the same container target. `docker compose config` proves interpolation/model validity only; it does not pull, license, start, or health-check Foundry.

## Build and install the same browser companion

Build the workspace and define the source-checkout CLI as described in [Windows quick start](./windows-quickstart.md#1-build-the-workspace-and-source-checkout-cli), then create a fresh module artifact:

```powershell
$Release = foundry-mcp build-module --json --output .\release | ConvertFrom-Json
$ModulePackage = $Release.zipPath
```

Run installation on the machine that owns the host-side bind directory. For Docker Desktop on Windows:

```powershell
$FoundryUserData = 'D:\Foundry Docker Data'

& .\scripts\windows\install.ps1 `
    -FoundryUserDataPath $FoundryUserData `
    -ModuleSourcePath $ModulePackage `
    -Layout DockerBindMount `
    -WhatIf

& .\scripts\windows\install.ps1 `
    -FoundryUserDataPath $FoundryUserData `
    -ModuleSourcePath $ModulePackage `
    -Layout DockerBindMount
```

The expected host-side file is:

```text
D:\Foundry Docker Data\Data\modules\foundry-mcp\module.json
```

Use the host-side bind path, not `/data`, a container ID, or a Docker Desktop VM-internal path. The installer does not invoke Docker. It validates the archive, stages and atomically swaps the owned module, rolls back activation failures, and preserves unrelated files.

For a remote Linux bind owner, the Windows scripts are not claimed as a first-class installer. Copy the verified module directory/ZIP through your normal administration workflow while preserving the exact `Data/modules/foundry-mcp` destination. Do not guess an opaque Docker volume's engine-internal path.

## Pair and run the Windows host

Pair the Windows user once, exactly as for desktop Foundry:

```powershell
$AdapterPath = (Resolve-Path -LiteralPath .\packages\mcp-adapter\dist\cli.js).Path
$NodePath = (Get-Command node.exe).Source
& .\scripts\windows\pair.ps1 -AdapterCommand $NodePath -AdapterArguments @($AdapterPath)
```

Use a stable explicit loopback port and the exact Origin at which the browser opens containerized Foundry. The checked-in config is correct only when that Origin is `http://127.0.0.1:30000`:

```powershell
foundry-mcp host --config .\config.example.json
```

With that config, the host emits this module endpoint:

```text
ws://127.0.0.1:32145
```

Start/restart your licensed service only after verifying the Compose project and bind:

```powershell
docker compose -f .\compose.yaml restart foundry
```

Open the world as GM in the browser, enable **Foundry MCP Companion**, set its bridge endpoint to the exact value emitted by the host, paste the one-time pairing secret into the password field, and reload. The endpoint belongs to the browser machine:

| Layout                                          | What loopback means                                        | Module files live at                                                            |
| ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Docker Desktop; browser on same Windows desktop | `127.0.0.1` is the Windows browser/host, not the container | Explicit Windows User Data bind                                                 |
| Remote Foundry; browser on Windows desktop      | `127.0.0.1` is still the GM desktop                        | Bind directory on the remote Foundry host                                       |
| Browser in remote VDI                           | Loopback is the VDI browser machine                        | Bind directory on the Foundry host; route the bridge to the VDI host explicitly |

`host.docker.internal` is normally unnecessary because the browser companion is not making a request from inside the container.

## HTTP, HTTPS, and exact Origin

The host accepts an Origin only when it exactly matches `scheme://host:port` (with a default port optionally omitted). It rejects wildcards, paths, queries, fragments, and credentials.

```text
valid:   http://127.0.0.1:30000
valid:   https://foundry.example.test
invalid: https://*.example.test
invalid: https://foundry.example.test/game
```

An HTTP Foundry page can open the loopback `ws://` endpoint. An HTTPS Foundry page cannot: mixed-content rules require a browser-trusted `wss://` endpoint. Terminate TLS at a reviewed reverse proxy and forward only to the loopback host, preserving the browser's Origin:

```caddyfile
broker.example.test {
    reverse_proxy 127.0.0.1:32145
}
```

Configure `https://foundry.example.test` in `allowedOrigins` and `wss://broker.example.test` in the module. Do not bind the host broadly, rewrite an untrusted Origin into an allowed one, or disable certificate validation.

Run doctor with the Docker bind and the same real values:

```powershell
$FoundryOrigin = 'http://127.0.0.1:30000'
$BridgeUrl = 'ws://127.0.0.1:32145'

foundry-mcp doctor `
    --config .\config.example.json `
    --docker-data $FoundryUserData `
    --bridge-url $BridgeUrl `
    --foundry-origin $FoundryOrigin `
    --allow-origin $FoundryOrigin
```

Doctor checks local bind/module/config/status and scheme/Origin consistency. It does not inspect Docker health, contact Foundry, or prove a live proxy certificate.

## Reconnect expectations

Container, browser, and host restarts are separate events. The companion authenticates again, resumes from acknowledged sequence state, suppresses duplicates, and the background reconciler compares permitted world state. A connection never silently selects another world.

Manual restart record:

1. Record the connected `connectionId`, `worldId`, last sequence, reconciliation status, and event count.
2. Restart only the Foundry service and wait for the world/module—not merely the container—to become ready.
3. Confirm the same world reconnects; make one harmless identifiable test-world change and observe it once.
4. Repeat separately for a browser reload and a Windows-host restart.
5. Record any reported gap/truncation instead of treating stale state as complete.

Repository tests exercise this sequence with mocked Foundry and real local pipe/WebSocket transport. A real licensed container/browser restart remains manual evidence.

## Safe removal

Disable the module in the world, stop the Windows host, and preview the ownership-aware removal on the bind owner:

```powershell
& .\scripts\windows\uninstall.ps1 -FoundryUserDataPath $FoundryUserData -WhatIf
& .\scripts\windows\uninstall.ps1 -FoundryUserDataPath $FoundryUserData
```

The uninstaller refuses unrecognized or modified owned files, preserves unrelated files, and never recursively deletes the bind root, worlds, configuration, or unrelated module data. Restart Foundry afterward only after checking the correct Compose project/service.

## Opt-in licensed-container smoke checklist

- [ ] The rendered Compose model uses the intended authorized image and exact writable bind source/target.
- [ ] Foundry v14 reaches the setup/world page and lists `foundry-mcp` from the bind.
- [ ] A GM enables the module and pairs without exposing the secret in logs or screenshots.
- [ ] The browser opens the exact `ws://` endpoint for HTTP or trusts the reviewed `wss://` certificate for HTTPS.
- [ ] Wrong Origin and the rotated old secret fail closed.
- [ ] `foundry.connections.list` returns the intended real `worldId` and `connectionId`.
- [ ] Read-only enumeration shows only content visible to that Foundry user.
- [ ] Explicit grants permit only the intended document/asset/session mutations.
- [ ] Container, browser, and host restarts reconnect/reconcile without duplicate events.
- [ ] Uninstall removes only manifest-owned files and the test world still loads.

Record image reference/digest, Foundry/browser/system/module versions, commands, timestamps, and redacted logs. Never commit license keys, cookies, provider keys, world data, or proprietary image layers.
