# Foundry MCP Server — Completion — Product Requirements

## Overview

**Problem**: `docs/PRD.md` defines a Windows-first MCP server that lets an AI client safely inspect and operate a live Foundry VTT v14 world. Sprint 1 delivered the monorepo scaffold, protocol schemas, host daemon, mcp-adapter, a fake Foundry runtime, CLI doctor, and CI — but adversarial review of that sprint found the MCP protocol version negotiation untested against the real MCP SDK, and the Windows named-pipe ACL is entirely mocked (`defaultAclCheck` always resolves `true`). None of the generic-document, asset, journal, or background-intelligence capabilities required by the PRD exist yet; only two placeholder tools (`foundry.connections.list`, `foundry.capabilities.get`) are registered.

**Solution**: Repair the two Sprint 1 defects first (real MCP wire negotiation, real Windows pipe ACL), then implement every remaining capability in `docs/PRD.md` — generic Document/compendium CRUD, image assets, journal sessions, background intelligence/event ledger, permissions/audit, the real Foundry companion module, Windows install/pair/doctor/package tooling, documentation, and the full validation matrix — story by story against the existing monorepo layout, until the PRD's Definition of Done (§12) is satisfied.

**Branch**: `archon/task-feat-windows-foundry-mcp` (already checked out; continue on it)

---

## Goals & Success

### Primary Goal
Every required capability in `docs/PRD.md` (§§3–11) has a real implementation with automated evidence (unit, contract, fake-runtime, MCP child-process, security, and E2E tests), and the repo satisfies the Definition of Done in §12.

### Success Metrics
| Metric | Target | How Measured |
|--------|--------|--------------|
| PRD version-negotiation gap | Closed | Child-process test proves `@modelcontextprotocol/sdk` (installed: `^1.30.0`) either speaks a real negotiated version and legacy fallback, or `PROTOCOL_VERSION`/`LEGACY_PROTOCOL_VERSIONS` in `packages/protocol/src/version.ts` are corrected to values the SDK actually negotiates, with a test asserting the negotiated value |
| Pipe ACL gap | Closed | `packages/host/src/bridge/acl.ts` performs a real Windows DACL/token check (or an equally strong verified alternative) instead of `Promise.resolve(true)`; Windows-only test proves a non-owning-SID client is rejected |
| PRD capability coverage | 100% of §§4–9 tools/resources/prompts implemented against the fake runtime | `pnpm test` + `pnpm test:e2e` pass; tool list matches PRD §§4,5,6,7 tool tables |
| No placeholder production paths | 0 | Grep for TODO/mock in non-test `src/` finds nothing load-bearing |
| CI green on Windows + 1 non-Windows runner | Pass | `.github/workflows/ci.yml` matrix passes |
| Definition of Done (PRD §12) | All 5 items satisfied | Final report cites exact commands/outcomes per item |

### Non-Goals (Out of Scope)
- Live validation against a real, licensed Foundry VTT install — a proprietary installation is not available in this environment; provide deterministic fake-runtime evidence plus an exact manual smoke procedure instead (PRD §10, last paragraph).
- Any MCP capability the installed SDK/client matrix cannot pass conformance tests for (PRD §3) — do not advertise it.
- Non-Windows first-class support beyond "remains portable, CI-tested on one extra runner" (PRD §1).
- Administrator-rights install paths, Windows Services, firewall rules, UPnP, or LAN exposure (PRD §9).

---

## User & Context

### Target User
- **Who**: A Foundry VTT v14 Game Master running Windows who wants an MCP-capable AI client (Claude Desktop, Codex) to inspect/operate their live world without granting the AI unrestricted machine access.
- **Role**: Runs `foundry-mcp` CLI (doctor/pair/install), configures their MCP client to spawn the stdio adapter, and grants scoped permissions from inside Foundry.
- **Current Pain**: Sprint 1 only proves the daemon/pipe/CLI scaffold works; there is no way yet to actually list, create, or update Foundry Documents, manage images, run journal sessions, or get background campaign context — and the two security-critical pieces (protocol negotiation, pipe ACL) are unverified or fake.

### User Journey
1. **Trigger**: GM has Foundry v14 running with the companion module installed and paired; they open Claude Desktop/Codex configured to spawn `foundry-mcp-adapter`.
2. **Action**: The AI calls `foundry.connections.list` → `foundry.documents.list`/`get`/`create` → optionally uploads/generates an image, starts a journal session, and pulls a background-intelligence context pack.
3. **Outcome**: Every call is authenticated end-to-end (pipe ACL + bridge handshake), permission-checked against the connected Foundry user's role, and returns bounded, structured, MCP-conformant results.

---

## UX Requirements

### Interaction Model
- MCP tools/resources/prompts over stdio (primary) as defined in PRD §8, using one shared registry builder so stdio and optional HTTP cannot drift.
- `foundry-mcp` CLI commands: `doctor`, `pair`, `install`, `build-module`, `uninstall`, plus PowerShell wrappers under `scripts/windows/`.
- Foundry-side: a companion module settings panel for entering the pairing secret (GM-only visibility).

### States to Handle
| State | Description | Behavior |
|-------|-------------|----------|
| Empty | No paired connections | `foundry.connections.list` returns `[]`; tools requiring a connection return a structured `NOT_FOUND`/ambiguous-connection error, not a crash |
| Loading | Long scan/generation/upload/indexing op | MCP progress notifications + cancellation (PRD §8); one correlation ID/deadline carried through pipe → bridge → provider → audit |
| Error | Offline bridge, ambiguous connection, unsupported type, invalid data, permission denied, not found, conflict, timeout, cancelled, Foundry-side failure | Structured error envelope via `makeError` (see `packages/protocol/src/error.ts`), never a raw thrown exception across the MCP boundary |
| Success | Read/write/asset/journal/intelligence op completes | Structured content validated against the matching Zod output schema, plus a text fallback summary |

---

## Technical Context

### Patterns to Follow
- **Tool registration**: `packages/mcp-adapter/src/server.ts:36-105` — every new tool follows the `registerTool(name, {title, description, inputSchema}, handler)` shape, parses the bridge response through a protocol Zod schema (`safeParse`), and returns `{content, structuredContent}` or `errorContent(code, message)` on failure. `PermissiveNoArgs = z.looseObject({})` (`server.ts:16`) is the pattern for no-arg tools; use `z.object({...})` for real inputs.
- **Protocol contracts**: `packages/protocol/src/contract.ts:1-28` defines `ToolContract`/`ResourceContract`/`PromptContract`/`defineTool` — new capabilities should get a typed contract plus paired Zod input/output schemas alongside `connection.ts`/`error.ts`/`capability.ts` in `packages/protocol/src/`.
- **Bridge framing**: `packages/host/src/bridge/pipe-server.ts:8-35` (`encodeFrame`/`FrameDecoder`) is the length-prefixed JSON framing already used over the named pipe; new request/response types are added as protocol schemas, not new wire formats.
- **ACL injection point**: `packages/host/src/bridge/acl.ts:3,12` — `AclCheck` is already a function type injected into `startPipeServer` (`pipe-server.ts:40,51,53`) specifically so tests can simulate pass/fail. Implement the real Windows check here; do not change the injection seam.
- **Protocol version negotiation**: `packages/protocol/src/version.ts:1-2` (`PROTOCOL_VERSION = "2026-07-28"`, `LEGACY_PROTOCOL_VERSIONS = ["2025-06-18"]`) is consumed by `negotiateProtocolVersion` in `packages/mcp-adapter/src/bridge-connection.ts` and reported by the `foundry.capabilities.get` tool (`server.ts:84-101`). Installed SDK is `@modelcontextprotocol/sdk@^1.30.0` (`packages/mcp-adapter/package.json`) — verify what that SDK actually negotiates via `server.connect(transport)` (`cli.ts:26-27`) before trusting the hardcoded constants.
- **Fake Foundry runtime**: `packages/host/src/fake-foundry/{documents,hooks,index,ws-server}.ts` is the deterministic test double all new document/asset/journal/event capabilities must be validated against; production code must not import it (PRD §10).
- **Test pattern**: Vitest per package (`packages/*/vitest.config.ts`, `packages/*/test/*.test.ts`); `packages/mcp-adapter/test-e2e/smoke.test.ts` is the child-process/E2E harness to extend for new tools; `packages/mcp-adapter/test/daemon-integration.test.ts` shows daemon+adapter integration style.
- **CLI pattern**: `packages/cli/src/doctor.ts` + `packages/cli/test/doctor.test.ts` is the model for adding `pair`/`install`/`build-module`/`uninstall` subcommands.

### Types & Interfaces
```typescript
// packages/protocol/src/contract.ts
export interface ToolContract<InputSchema extends z.ZodTypeAny, OutputSchema extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
}
export interface ResourceContract { uriPattern: string; description: string }
export interface PromptContract<ArgsSchema extends z.ZodTypeAny> { name: string; description: string; argsSchema: ArgsSchema }

// packages/host/src/bridge/acl.ts
export type AclCheck = (pipePath: string) => Promise<boolean>;

// packages/protocol/src/version.ts
export const PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSIONS = ["2025-06-18"] as const;
```

### Architecture Notes
- Do not confuse the **private bridge protocol version** (host ⟷ mcp-adapter over the named pipe, defined in `packages/protocol`) with the **MCP wire protocol version** (mcp-adapter ⟷ MCP client, negotiated by `@modelcontextprotocol/sdk`). The Sprint 1 defect is specifically that `PROTOCOL_VERSION` is asserted as the MCP wire version without a test proving the installed SDK actually negotiates it.
- The real Windows pipe ACL work should land as a small, testable module behind the existing `AclCheck` seam; PRD allows "a self-contained Windows pipe broker/sidecar" or "an equally strong verified implementation" — pick whichever keeps `startPipeServer`'s signature unchanged.
- All new capabilities are additive tool registrations in `createFoundryMcpServer` (`server.ts`) plus new protocol schemas — no restructuring of the existing stdio/bridge plumbing is required to add documents/assets/journals/intelligence.
- `packages/foundry-module/src/{handshake.ts,index.ts}` currently only implements the pairing handshake; all real Foundry-side document/asset/event operations (PRD §§4,5,7) still need to be built there and streamed to the host over the module's WebSocket bridge (`packages/host/src/fake-foundry/ws-server.ts` shows the fake counterpart).
- SQLite layer (`packages/host/src/db/{index,migrations}.ts`) exists for config/pairing state; the event ledger and intelligence index (PRD §7) extend it with new migrations, not a new store.

---

## Implementation Summary

### Story Overview
| ID | Title | Priority | Dependencies |
|----|-------|----------|--------------|
| US-001 | Verify real MCP SDK protocol negotiation | 1 | — |
| US-002 | Correct/confirm PROTOCOL_VERSION + legacy compatibility | 2 | US-001 |
| US-003 | Dual-era stdio adapter child-process tests | 3 | US-002 |
| US-004 | Real Windows pipe ACL (current-logon-SID DACL) | 4 | — |
| US-005 | Pipe server rejects remote/non-owning clients + descriptor/token verification | 5 | US-004 |
| US-006 | Retain HMAC bridge auth alongside ACL, fail-closed tests | 6 | US-005 |
| US-007 | Package win-x64/win-arm64 broker artifacts | 7 | US-006 |
| US-008 | Document type discovery (`foundry.documents.types`) | 8 | US-003 |
| US-009 | Root document listing with cursor pagination | 9 | US-008 |
| US-010 | Document get via UUID resolution | 10 | US-008 |
| US-011 | Document create (root + embedded, batch) | 11 | US-010 |
| US-012 | Document update with optimistic precondition | 12 | US-011 |
| US-013 | Embedded document listing | 13 | US-010 |
| US-014 | Compendium pack + document listing | 14 | US-008 |
| US-015 | Bounded snapshot/export with cycle detection & redaction | 15 | US-010 |
| US-016 | Structured document-op error taxonomy | 16 | US-011,US-012 |
| US-017 | Image asset listing across sources | 17 | US-003 |
| US-018 | Image reference discovery in documents | 18 | US-010,US-017 |
| US-019 | Image upload with path/MIME/size validation | 19 | US-017 |
| US-020 | Deterministic local image-generation test provider | 20 | US-019 |
| US-021 | Opt-in real image-generation provider (OpenAI Images) | 21 | US-020 |
| US-022 | Image attach + SSRF-safe URL import guard | 22 | US-019 |
| US-023 | Journal session start/append on real Document types | 23 | US-011 |
| US-024 | Journal list/get/end/reopen + idempotency keys | 24 | US-023 |
| US-025 | Event ledger schema + SQLite migrations | 25 | — |
| US-026 | Companion module event envelope emission | 26 | US-025 |
| US-027 | Local intelligence: changed-since, full-text search, timeline | 27 | US-026 |
| US-028 | Context pack export tool + `foundry://` resources | 28 | US-027 |
| US-029 | Optional provider-based summarization with provenance | 29 | US-027 |
| US-030 | Permission policy engine + structured permission errors | 30 | US-012 |
| US-031 | Audit log for mutations | 31 | US-030 |
| US-032 | Real Foundry companion module: document/asset operations | 32 | US-011,US-019,US-030 |
| US-033 | PowerShell install/pair/uninstall scripts | 33 | US-006 |
| US-034 | Extend `doctor` CLI for full PRD §8 checklist | 34 | US-025,US-032 |
| US-035 | Foundry module zip packaging (v14 `module.json`) | 35 | US-032 |
| US-036 | E2E lifecycle test against fake runtime | 36 | US-028,US-029,US-032 |
| US-037 | Security test suite (traversal, replay, oversized, wrong-world, non-GM) | 37 | US-036 |
| US-038 | Documentation set + validation matrix | 38 | US-037 |

### Dependency Graph
```
US-001 → US-002 → US-003 ─────────────────────────────┐
US-004 → US-005 → US-006 → US-007                     │
                                                        ↓
                    US-008 → US-009/US-010/US-014      │
                              US-010 → US-011 → US-012  │
                                    → US-013            │
                    US-010 → US-015; US-011/012 → US-016│
                    US-003 → US-017 → US-018/US-019     │
                              US-019 → US-020 → US-021  │
                              US-019 → US-022           │
                    US-011 → US-023 → US-024            │
                    US-025 → US-026 → US-027 → US-028/029
                    US-012 → US-030 → US-031            │
        US-011,US-019,US-030 → US-032 → US-034/035      │
                    US-006 → US-033                      │
        US-028,US-029,US-032 → US-036 → US-037 → US-038
```

---

## Validation Requirements

Every story must pass:
- [ ] Type-check: `pnpm typecheck` (Turborepo across all packages)
- [ ] Lint: `pnpm lint`
- [ ] Tests: `pnpm test` (and `pnpm test:e2e` for stories touching mcp-adapter/E2E)
- [ ] Story-specific acceptance criteria (see `prd.json`)

CI reference: `.github/workflows/ci.yml` (Windows + non-Windows matrix per PRD §10).

---

## Validation Matrix Discipline

Per `docs/PRD.md` §10/§12: every story's automated evidence must state plainly whether it ran against the deterministic fake Foundry runtime (`packages/host/src/fake-foundry/`) or a real licensed Foundry v14 install. No proprietary Foundry installation is available in this environment — do not fabricate live-Foundry evidence. US-038 must produce the explicit validation matrix and a manual smoke-test procedure for a user who does have a real install.

---

*Generated: 2026-08-29*
