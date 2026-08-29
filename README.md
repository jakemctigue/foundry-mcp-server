# Foundry MCP Server

A Windows-first Model Context Protocol server for Foundry Virtual Tabletop v14. It gives an MCP client a permissioned, multi-world view of Foundry through a local Windows host and a GM-authorized browser companion. Docker-hosted Foundry uses the same browser companion and Windows host; only the module-install path changes to the container's writable User Data bind mount.

## What it can do

| Area                    | MCP capabilities                                                                                                                                                                                                      | Important boundary                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Connections             | Enumerate connected worlds and require an explicit `connectionId` when more than one world is eligible.                                                                                                               | A successful empty list proves transport, not a live Foundry connection.                                                        |
| Objects                 | Discover document types and every runtime Actor/Item subtype; list, get, create, and update root or embedded documents; enumerate compendia, Scenes, RollTables, Playlists, Cards, Macros, and unknown system fields. | Foundry permissions and explicit host capability grants both apply.                                                             |
| Images/assets           | Enumerate FilePicker sources and image references; upload validated images; generate deterministic images or opt in to OpenAI Images; attach a writable asset to a document.                                          | Local files are denied until an absolute root is allowlisted. Remote imports are SSRF-filtered. There is no public delete tool. |
| Journal sessions        | Start, append to, list, and read idempotent JournalEntry/JournalEntryPage-backed sessions with links and attribution.                                                                                                 | Session mutations require separate grants.                                                                                      |
| Background intelligence | Capture permitted events, reconcile pre-existing world state, search/timeline/changed-since, build bounded context packs, and expose provenance/status.                                                               | Private-content capture defaults off; restricted Actor, Item, and Journal content is filtered by default.                       |
| MCP surface             | 26 tools, enumerable `foundry://` resources, and five bounded read-only prompts for campaign, recap, encounter, NPC, and change-review workflows.                                                                     | Prompt text grants no mutation authority. See the generated-surface reference for exact schemas.                                |

## Start here

- [Windows quick start](./docs/windows-quickstart.md) — build the module ZIP, install and pair it, run the host, grant capabilities, and configure an MCP client.
- [Docker-hosted Foundry](./docs/docker-foundry.md) — use a writable User Data bind mount with the checked-in Compose example or overlay.
- [Configuration, privacy, and providers](./docs/configuration.md) — typed settings, precedence, safe defaults, and opt-in provider setup.
- [Tools, resources, and prompts](./docs/tools-reference.md) — the exact public MCP surface.
- [Architecture and threat model](./docs/architecture.md) — trust boundaries and failure modes.
- [Validation matrix](./docs/validation-matrix.md) — deterministic evidence versus live/manual gaps.

## Runtime shape

```text
MCP client
  -> stdio adapter
  -> current-logon Windows named pipe
  -> local Windows host + SQLite intelligence store
  -> authenticated loopback ws:// bridge (or reviewed wss:// proxy)
  -> GM browser companion
  -> Foundry public APIs and FilePicker providers
```

The companion authenticates with a per-user DPAPI-protected pairing secret and an HMAC challenge. The host binds its browser bridge to loopback and checks the exact Foundry page Origin. Docker does not require the Docker socket and does not move desktop secrets into the container.

## Build from source

Requirements are Windows 10/11, Node.js 22+, pnpm 9.15.0, and PowerShell 7 (Windows PowerShell 5.1 is also exercised for the setup scripts).

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
```

The CLI package exposes the `foundry-mcp` executable when installed or linked. In a source checkout, create a session-local command after building:

```powershell
$FoundryMcpCli = (Resolve-Path -LiteralPath .\packages\cli\dist\bin.js).Path
function foundry-mcp { & node $FoundryMcpCli @args }
```

Then create the loadable Foundry module directory and versioned ZIP:

```powershell
foundry-mcp build-module --output .\release
```

The builder packages only `module.json` and the self-contained browser bundle. Continue with the [Windows](./docs/windows-quickstart.md) or [Docker](./docs/docker-foundry.md) guide instead of copying package build directories into Foundry by hand.

## Security and privacy defaults

- Configuration precedence is built-in defaults < JSON config < environment < CLI flags.
- The checked-in [config example](./config.example.json) uses a stable loopback port, exact Origins, 30-day event retention, private-content capture off, and an empty `localAssetRoots` denylist.
- Pairing and provider credentials are accepted outside command-line arguments and protected with current-user DPAPI on the Windows production path.
- Mutations are denied until explicitly granted per connection, Foundry role, and capability; denials and committed outcomes are audit logged with secret redaction.
- Deterministic image generation is local. OpenAI Images is optional, requires an explicit provider key and `ai:network` grant, and sends credentials only to the official HTTPS Images endpoint.

## Development

```powershell
pnpm test
pnpm test:e2e
```

Tests use fake Foundry globals, real local pipe/WebSocket transports where noted, and no redistributed Foundry code. A licensed Foundry desktop/container, real browser TLS route, external provider call, and cross-user Windows account test remain manual evidence boundaries; do not describe mock coverage as a live Foundry pass.
