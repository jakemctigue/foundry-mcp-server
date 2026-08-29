# Docker-hosted Foundry

This guide covers a user-managed, licensed Foundry v14 container. This repository does not include, build, redistribute, or authenticate to a Foundry image. Substitute only an image and credentials you are authorized to use.

No live licensed container was started for this documentation pass. See [validation-matrix.md](./validation-matrix.md) for the exact evidence boundary.

## Deployment boundary

There are three distinct paths:

1. **Host bind mount:** a Windows or remote-host directory is mounted at the container's Foundry User Data path. Module install/remove targets the host-side directory explicitly.
2. **Browser bridge:** the companion module runs in the authenticated GM's browser, not in the Docker daemon. Its `ws://` or `wss://` URL must be reachable from that browser.
3. **Desktop MCP path:** the MCP client, stdio adapter, named pipe, broker, SQLite store, and secrets normally remain on the GM's Windows desktop.

The tooling never needs the Docker socket and does not edit the Foundry database or unrelated container data.

## Compose example without a bundled image

The following is a standalone example or overlay template. It references a user-supplied image and explicit bind paths through required environment variables. Save it beside your own Compose file if it matches your deployment:

```yaml
name: foundry-mcp-example

services:
  foundry:
    image: "${FOUNDRY_IMAGE:?Set FOUNDRY_IMAGE to an image you are licensed to use}"
    restart: unless-stopped
    ports:
      - "${FOUNDRY_HTTP_BIND:-127.0.0.1:30000}:${FOUNDRY_CONTAINER_PORT:-30000}"
    volumes:
      - type: bind
        source: "${FOUNDRY_USER_DATA:?Set FOUNDRY_USER_DATA to an absolute host path}"
        target: "${FOUNDRY_CONTAINER_USER_DATA:?Set the User Data path expected by your image}"
```

This example deliberately does not prescribe an image name, license key, administrator password, container User Data path, or non-default internal port. Those are image-specific. Keep secrets out of Compose YAML and source control.

Set non-secret substitutions in the current PowerShell session and render the merged model before starting anything:

```powershell
$env:FOUNDRY_IMAGE = 'your-authorized-registry/foundry:your-pinned-version'
$env:FOUNDRY_USER_DATA = 'D:\Foundry Docker Data'
$env:FOUNDRY_CONTAINER_USER_DATA = '/path/required/by/your/image'
$env:FOUNDRY_HTTP_BIND = '127.0.0.1:30000'
$env:FOUNDRY_CONTAINER_PORT = '30000'
docker compose -f .\compose.foundry-mcp.example.yaml config
```

`docker compose config` renders configuration; it does not prove the image is licensed, present, loadable, or compatible. Review the output for the exact host source and container target before `up`.

If this is an overlay on an existing service, keep the service name identical and use both files:

```powershell
docker compose -f .\compose.yaml -f .\compose.foundry-mcp.override.yaml config
```

Compose merges service volume entries by their container target, with the later file winning for the same target. Inspect the rendered `volumes` list for an unintended target or a bind that replaced a volume you meant to keep.

## Install into an explicit bind mount

Run installation on the machine that owns the host-side bind directory. For Docker Desktop on Windows:

```powershell
$FoundryUserData = 'D:\Foundry Docker Data'
$ModulePackage = 'C:\Downloads\foundry-mcp-module.zip'

if (-not ([System.IO.Path]::IsPathRooted($FoundryUserData))) {
    throw 'Foundry User Data must be an absolute host path.'
}
if (-not (Test-Path -LiteralPath $FoundryUserData -PathType Container)) {
    throw "Bind-mounted User Data directory not found: $FoundryUserData"
}

& .\scripts\windows\install.ps1 `
    -FoundryUserDataPath $FoundryUserData `
    -ModuleSourcePath $ModulePackage `
    -Layout DockerBindMount
```

The expected host-side destination is:

```text
<FoundryUserData>\Data\modules\foundry-mcp\module.json
```

Use the host-side path, not `/data`, a container ID, or a path inside Docker Desktop's VM. The script does not invoke Docker. It writes an ownership manifest inside its module directory and refuses an unowned existing directory.

Restart the Foundry service only after reviewing the correct Compose project/service:

```powershell
docker compose -f .\compose.yaml restart foundry
```

The restart command above is a manual licensed-container step and was not run as evidence for this repository.

## Docker Desktop and remote-host layouts

| Layout                                               | Module files                        | Broker address seen by the browser                             | Important boundary                                                                                                                            |
| ---------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker Desktop, browser on same Windows desktop      | Explicit Windows bind directory     | Usually a loopback broker URL on the Windows desktop           | `127.0.0.1` means the browser's Windows host, not the container. `host.docker.internal` is normally unnecessary for browser-side module code. |
| Remote Foundry server, GM browser on Windows desktop | Bind directory on the remote server | The URL configured in that GM's browser/module                 | `127.0.0.1` still means the GM desktop. Install module files on the remote bind owner, but keep desktop secrets local.                        |
| Remote browser/VDI session                           | Bind directory on the Foundry host  | Broker reachable from the machine running that browser session | Do not assume the MCP client desktop and browser share loopback. Configure and authenticate the actual route.                                 |

For a remote non-Windows bind owner, the checked-in PowerShell scripts require a compatible PowerShell runtime and have not been claimed as a supported Linux installer. Use a reviewed equivalent that preserves the ownership-manifest rules, or copy a verified module artifact through the host's normal administration process. Never mutate an opaque Docker volume by guessing its engine-internal path.

## `ws://` versus `wss://`

Browser mixed-content rules determine the scheme:

| Foundry page                   | Module bridge                         | Result                                                                                                     |
| ------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `http://foundry.example:30000` | `ws://127.0.0.1:<broker-port>/<path>` | Allowed by scheme; still requires authentication and exact Origin allowlisting.                            |
| `https://foundry.example`      | `ws://...`                            | Blocked as mixed content.                                                                                  |
| `https://foundry.example`      | `wss://broker.example/<path>`         | Correct when the certificate is trusted and the proxy preserves WebSocket upgrade and the original Origin. |

Do not downgrade an HTTPS Foundry deployment to solve a WebSocket error. Terminate TLS at a reviewed reverse proxy and proxy only to a loopback broker listener. A minimal conceptual Caddy route is:

```caddyfile
broker.example.test {
    reverse_proxy 127.0.0.1:<BROKER_PORT>
}
```

`<BROKER_PORT>` is a deployment placeholder, not a documented current default. The production broker must exist and be configured before using this route. The certificate name must match the browser URL and be trusted by the browser. The proxy must not replace an untrusted Origin with an allowed one, and the upstream must still authenticate the session and messages.

For remote access, do not expose an unauthenticated broker by binding it broadly. Prefer a narrowly routed TLS endpoint with authentication, firewall restrictions appropriate to the deployment, strict Host/Origin validation, and no access to host administration paths.

## Strict Foundry Origin allowlist

An Origin is exactly `scheme://host:port` (the default port may be omitted). It has no path, query, fragment, wildcard, or credentials.

Examples:

```text
https://foundry.example.test
http://127.0.0.1:30000
```

These are not safe allowlist entries:

```text
*
https://*.example.test
https://foundry.example.test/some/world
```

Configure the same real value in the module/broker settings and doctor:

```powershell
$FoundryOrigin = 'https://foundry.example.test'
$BridgeUrl = 'wss://broker.example.test/foundry-mcp'
node .\packages\cli\dist\bin.js doctor `
    --docker-data $FoundryUserData `
    --bridge-url $BridgeUrl `
    --foundry-origin $FoundryOrigin `
    --allow-origin $FoundryOrigin
```

Doctor validates syntax, scheme compatibility, exact allowlist membership, and local bind-path access. It does not contact Docker, validate a live certificate chain, or prove that reverse-proxy headers are correct.

## Broker discovery

There is no safe assumption that a browser can discover the correct broker across Docker Desktop, a remote host, VPN, VDI, or several GM desktops. Configure an explicit bridge URL in the module's GM-only settings. Discovery metadata, if added later, must be authenticated and cannot widen the Origin allowlist.

Use these diagnostics from the browser machine:

1. confirm the Foundry page's exact origin in browser developer tools;
2. confirm the bridge URL uses `ws` for HTTP or `wss` for HTTPS;
3. inspect certificate and WebSocket upgrade errors without copying secrets;
4. run doctor with the same origin and bridge URL; and
5. call `foundry.connections.list` and match `worldId`, not only the title.

The current validation snapshot has no live browser-broker discovery evidence. Treat an absent module bridge setting or production WebSocket listener as an implementation gap, not a networking problem to work around by disabling security.

## Restart and reconnect

Expected behavior after a container, browser, or broker restart is authenticated reconnect followed by bounded reconciliation; events must resume from acknowledged sequence state and duplicates must be suppressed. A connection must not silently target a different world.

Manual restart checklist:

1. Record the connected `connectionId`, `worldId`, last-sync marker, and current event count.
2. Restart only the Foundry service: `docker compose -f .\compose.yaml restart foundry`.
3. Wait for the world and module to become ready; do not infer readiness from container state alone.
4. Confirm the same world reconnects and that `foundry.connections.list` does not retain a false connected state.
5. Make one harmless, identifiable change in the test world.
6. Verify reconciliation observes it exactly once and reports any gap/truncation.
7. Repeat separately for browser reload and broker restart.

No real container restart/reconnect run is claimed in this repository snapshot.

## Safe removal

Disable the module in the world and stop the local broker before removal. On the bind owner:

```powershell
& .\scripts\windows\uninstall.ps1 -FoundryUserDataPath $FoundryUserData
```

The uninstaller verifies its ownership manifest and current file hashes. It refuses an unrecognized directory or a modified owned file and preserves unrelated files. It never recursively deletes the bind root, worlds, configuration, or unrelated module data. Restart Foundry after safe removal if you need the package list refreshed.

## Opt-in licensed-container smoke checklist

Run this only with your licensed image and a disposable or backed-up test world:

- [ ] `docker compose config` resolves the intended image and exact bind source/target.
- [ ] The container becomes healthy and the Foundry v14 setup/world page is reachable.
- [ ] `Data/modules/foundry-mcp/module.json` is visible through the bind mount and Foundry lists the module.
- [ ] An authorized GM enables and pairs the module without exposing the secret in logs.
- [ ] The browser accepts the `wss` certificate when Foundry is HTTPS.
- [ ] A wrong Origin and an expired/rotated secret both fail closed.
- [ ] `foundry.connections.list` reports the intended real `worldId`.
- [ ] A read-only enumeration observes only content visible to that user.
- [ ] Container, browser, and broker restarts reconnect and reconcile without duplicate events.
- [ ] Uninstall removes only manifest-owned files and Foundry continues to load the test world.

Record image reference/digest, Foundry version, game system, browser, proxy, commands, timestamps, and redacted logs. Do not commit license keys, cookies, provider keys, world data, or proprietary image layers.
