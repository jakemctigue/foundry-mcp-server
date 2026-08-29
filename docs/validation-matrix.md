# Validation matrix

This matrix separates deterministic repository evidence from manual evidence that requires proprietary Foundry software, a user-managed container, a browser, an MCP desktop client, or provider credentials. A fake Foundry runtime is useful evidence, but it is never labeled as live Foundry validation.

Status terms:

- **Automated pass:** the command completed successfully in this Windows worktree during the documentation pass.
- **Available, not live:** automated evidence exists, but it does not cross the proprietary/live boundary.
- **Unavailable / not available in this environment:** no qualifying evidence was produced; this is not a failure disguised as “not applicable.” Every live-Foundry row marked Unavailable has this meaning.
- **Manual required:** the user must run and record the bounded checklist with their own licensed/configured system.

## Evidence snapshot

| Capability or boundary                    | Evidence type                                                       | Command or procedure                                                                                      | Status in this documentation pass                                                            | What the evidence does and does not prove                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace dependency resolution           | Repository automation                                               | `pnpm install --frozen-lockfile`                                                                          | **Automated pass, 2026-08-29**                                                               | Proves the lockfile resolves on this machine; does not prove a clean machine or package registry availability.                                                                                                         |
| Monorepo build                            | Repository automation                                               | `pnpm build`                                                                                              | **Automated pass, 2026-08-29**                                                               | Compiles packages; does not create or load a licensed Foundry instance.                                                                                                                                                |
| Type safety                               | Repository automation                                               | `pnpm typecheck`                                                                                          | **Automated pass, 2026-08-29**                                                               | Checks TypeScript; does not validate browser/runtime behavior.                                                                                                                                                         |
| Lint                                      | Repository automation                                               | `pnpm lint`                                                                                               | **Automated pass, 2026-08-29**                                                               | Checks configured static rules only.                                                                                                                                                                                   |
| Automated package tests                   | Repository automation                                               | `pnpm test`                                                                                               | **Automated pass, 2026-08-29; totals intentionally omitted pending the final release rerun** | Covers unit/fake/integration fixtures selected by each package; inspect failures and coverage rather than treating the command name as live evidence.                                                                  |
| MCP/adapter end-to-end tests              | Repository automation                                               | `pnpm test:e2e`                                                                                           | **Automated pass, 2026-08-29; totals intentionally omitted pending the final release rerun** | Can prove MCP initialization/tool calls and process framing; fake/in-memory transport remains non-live unless a test explicitly records otherwise.                                                                     |
| First `foundry.connections.list` call     | Real local host/pipe plus non-live MCP harness                      | `pnpm --filter @foundry-mcp/mcp-adapter test:e2e`                                                         | **Automated pass, 2026-08-29**                                                               | A successful empty list proves the protocol/adapter/broker route; it does not prove a paired Foundry world.                                                                                                            |
| Windows install/pair/uninstall            | PowerShell process integration with fixture module and Unicode path | `pnpm --filter @foundry-mcp/cli test`                                                                     | **Automated pass, 2026-08-29 under PowerShell 7 and Windows PowerShell 5.1**                 | Proves literal-path, transactional swap/rollback, ownership/hash refusal, DPAPI rotation, secret-free client JSON, reparse defense, archive preflight, `-WhatIf`, and a Docker-bind fixture. It does not load Foundry. |
| Doctor checks and redaction               | Unit/process test plus built CLI smoke                              | `pnpm --filter @foundry-mcp/cli test`; `node packages/cli/dist/bin.js doctor ...`                         | **Automated pass, 2026-08-29**                                                               | Proves migration/module/status/provider/origin/mixed-content decisions and output redaction against fixtures. It does not validate a live certificate, port, Docker daemon, or world.                                  |
| Local host launcher lifecycle             | Real Windows host process and native named-pipe broker              | `foundry-mcp host`; `scripts/windows/start-host.ps1`; CLI host E2E                                        | **Automated pass, 2026-08-29: readiness and graceful shutdown observed**                     | Proves this worktree can start/stop the current host, loopback companion listener, and native broker. It does not prove a real browser companion.                                                                      |
| Compose example rendering                 | Docker Compose model validation only                                | `docker compose -f compose.foundry-mcp.example.yaml config` with non-secret substitutions                 | **Automated pass, 2026-08-29; no pull or start performed**                                   | Proves the checked-in YAML/interpolation/model renders; does not pull or start an image.                                                                                                                               |
| Fake Foundry Documents/Actors/Items       | Deterministic fake runtime                                          | Package tests under `@foundry-mcp/foundry-module`                                                         | **Automated pass, 2026-08-29; available, not live**                                          | Can prove generic schemas, runtime subtype preservation, pagination, embedded items, and fixture permissions; cannot prove a particular live game system.                                                              |
| Fake assets/journals/intelligence         | Deterministic fake/runtime-provider tests                           | Passing host, adapter, and Foundry-module package suites                                                  | **Automated pass, 2026-08-29: fake/provider fixtures only; available, not live**             | Must not be extrapolated to FilePicker providers, live Journal secrecy, provider billing, or browser behavior.                                                                                                         |
| Loadable Foundry v14 module directory/ZIP | Release artifact automation                                         | `foundry-mcp build-module`; `packages/cli/test/build-module.test.ts`                                      | **Automated pass, 2026-08-29; loadable structure available, live enable still manual**       | Proves an allowlisted v14 `module.json` plus self-contained browser bundle in a versioned ZIP and desktop/Docker directory layouts. It does not prove Foundry loads it.                                                |
| Background reconciliation and restart     | SQLite plus mocked Foundry and real local transports                | `packages/host/test/reconciliation.test.ts`; adapter full-lifecycle E2E                                   | **Automated pass, 2026-08-29; available, not live**                                          | Proves bounded pre-pair indexing, private filtering, durable resume, gap reporting, retention, and duplicate suppression across simulated restarts. It is not a licensed container/browser restart.                    |
| MCP prompts and multi-world resources     | Modern/legacy child stdio and in-memory integration                 | adapter prompts E2E; `integration-tools-resources.test.ts`                                                | **Automated pass, 2026-08-29; available, not live**                                          | Proves five bounded read-only prompts and collision-free percent-encoded world/document/session/intelligence URIs. It does not prove a desktop client's UI.                                                            |
| Browser image decode gate                 | Real PNG bytes through the browser-decoder contract                 | `packages/foundry-module/test/asset-decode.test.ts`; adapter full-lifecycle E2E                           | **Automated pass, 2026-08-29; mocked `createImageBitmap`, not a live browser**               | Proves byte/MIME/active-markup/dimension/pixel checks, decoder failure handling, and bitmap cleanup before upload. It does not prove a specific browser codec implementation.                                          |
| Live Windows desktop Foundry connection   | Proprietary/manual                                                  | [Windows quick start](./windows-quickstart.md), through a non-empty real-world `foundry.connections.list` | **Unavailable; manual required**                                                             | Requires licensed Foundry v14, a loadable module, a browser bridge, and recorded redacted evidence.                                                                                                                    |
| Live licensed Docker Foundry connection   | Proprietary/manual                                                  | [Docker smoke checklist](./docker-foundry.md#opt-in-licensed-container-smoke-checklist)                   | **Unavailable; manual required**                                                             | No licensed image was pulled or started for this pass.                                                                                                                                                                 |
| Real HTTP `ws://` browser bridge          | Browser/manual                                                      | Pair from an HTTP test origin; reject wrong Origin/token                                                  | **Unavailable; manual required**                                                             | Unit tests cannot prove browser networking, proxy headers, or live module registration.                                                                                                                                |
| Real HTTPS `wss://` and reverse proxy     | Browser/TLS/manual                                                  | Trusted certificate, WebSocket upgrade, exact Origin, wrong-Origin rejection                              | **Unavailable; manual required**                                                             | Syntax checks cannot prove certificate trust, proxy behavior, or DNS-rebinding resistance.                                                                                                                             |
| Container/browser/broker restart recovery | Licensed/manual                                                     | Three separate restart runs with sequence/event reconciliation                                            | **Unavailable; manual required**                                                             | Simulated reconnect is not a real container/browser lifecycle.                                                                                                                                                         |
| Codex/Claude Desktop-compatible client UI | External client/manual                                              | Load emitted generic stdio configuration and call the tool                                                | **Unavailable; manual required**                                                             | Child-process MCP tests do not prove any particular client's config path or UI behavior.                                                                                                                               |
| External image/LLM provider               | Credentialed/manual                                                 | Explicit opt-in, bounded request, redacted logs, cost/provenance record                                   | **Unavailable; manual required**                                                             | No live provider call or charge is claimed.                                                                                                                                                                            |
| Cross-user Windows named-pipe denial      | Multi-account Windows/manual security test                          | Attempt access from a different user/logon session                                                        | **Unavailable; manual required**                                                             | Same-process and mocked identity tests cannot replace a real cross-account attempt.                                                                                                                                    |
| Windows DPAPI host/provider storage       | Real current-user DPAPI round trip plus CLI/unit flows              | host secret-storage test; `pair.ps1`; provider configure/status/remove tests                              | **Automated pass, 2026-08-29 on this Windows user**                                          | Proves production storage selects current-user DPAPI and the host/provider consume the same abstraction without echoing values. It does not replace a second-account denial test.                                      |
| Adversarial archive extraction            | PowerShell 7/5.1 process integration                                | `packages/cli/test/windows-scripts.test.ts`                                                               | **Automated pass, 2026-08-29**                                                               | Proves preflight/cleanup refusal for traversal, duplicate/type-conflict entries, nested archives, symlink/reparse metadata, entry/depth/expanded-byte/ratio limits, junction paths, and activation rollback.           |

The final release gate totals are intentionally omitted until the final serial rerun. Capability-specific rows above name the committed targeted evidence. Live/manual rows remain unavailable as stated.

## Fake and mocked evidence boundary

Automated fake-runtime tests may legitimately demonstrate:

- versioned schema acceptance/rejection;
- deterministic cursor ordering and bounds;
- preservation of unknown system fields;
- policy results for Player, Trusted, Assistant, and GM fixtures;
- idempotency/replay and optimistic-conflict behavior;
- collision/path/MIME/size decisions;
- event ordering, duplicate suppression, and simulated reconnect; and
- MCP framing, negotiated versions, protocol-only stdout, and clean teardown.

They do not demonstrate:

- that Foundry v14 loads the built module;
- that runtime APIs match the fake for every game system/module combination;
- browser CSP, mixed-content, Origin, certificate, or extension behavior;
- Docker image configuration, licensing, health, bind ownership, or remote routing;
- secrecy of real worlds, Journal pages, compendia, chats, or FilePicker sources;
- a real provider's availability, retention, safety, output format, or cost; or
- correct installation/configuration in a specific MCP desktop client.

## Manual live Foundry evidence record

Use a private disposable or backed-up world. Start read-only and redact all captured output.

Record:

- date/time and commit hash;
- Windows, Node, Foundry, browser, game-system, and module versions;
- desktop or Docker layout; for Docker, image reference/digest without credentials;
- exact non-secret commands and configuration paths;
- proxy hostname/scheme and certificate issuer, never private keys;
- connected `worldId`/`connectionId` using a non-sensitive test title if screenshots are retained;
- pass/fail for wrong Origin, rotated secret, wrong world, unauthorized user, and oversized/malformed message; and
- shutdown/restart observations with event sequence counts.

Minimum non-destructive desktop run:

1. Back up or create a disposable world.
2. Install the verified module artifact into the exact User Data path.
3. Enable it as GM, pair, and run doctor.
4. Call `foundry.connections.list`; verify a real non-empty record for the intended world.
5. Call only read-only capability/type/list operations first.
6. Verify a lower-privilege fixture user cannot see hidden content.
7. Rotate the pairing secret and prove the previous value fails.
8. Restart Foundry, browser, and broker separately; verify reconnect/reconciliation.
9. Uninstall and prove unrelated module/world files remain.

The Docker-specific additions are in [docker-foundry.md](./docker-foundry.md).

## Release interpretation

Do not convert an **Unavailable** row to pass because a nearby unit test is green. Attach the real command output or a redacted manual record that crosses the named boundary. Conversely, a missing proprietary environment should remain an explicit evidence gap rather than blocking deterministic repository tests or encouraging anyone to redistribute Foundry.
