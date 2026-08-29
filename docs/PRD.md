# Foundry MCP Server — Product Requirements

Status: implementation contract

## 1. Objective

Build a production-quality, Windows-first Model Context Protocol (MCP) integration for Foundry Virtual Tabletop (Foundry VTT). The product must let an MCP-capable AI inspect and safely operate a live Foundry world through supported Foundry APIs, manage image assets and campaign journals, and maintain useful background context as the world changes.

The first supported target is Windows 10/11 with Foundry VTT v14 stable. The code should remain portable Node.js/TypeScript where practical, but Windows installation, paths, scripts, documentation, and smoke tests are release blockers.

This is a greenfield repository. There must be no placeholder tools, TODO-only implementations, mocked production paths, or claims of live Foundry validation without evidence.

Normative scope definitions:

- **Any object** means every runtime-registered Foundry root or embedded `Document` visible to the paired user, including accessible compendium Documents. It does not include the JavaScript heap, DOM, functions, prototypes, runtime globals, credentials, or arbitrary files.
- **Create any object** means every runtime-reported Document type which is creatable for the paired principal and valid under Foundry's runtime schema. Derived, locked, or permission-forbidden types report `creatable: false` and a reason.
- **Any image** means image assets visible through authorized Foundry FilePicker sources plus image references in visible Documents. It does not include arbitrary Windows files or protected assets that Foundry does not expose.
- **Create images** includes safe upload/import, genuine generation through an explicitly configured provider, and attachment to a Foundry Document. Upload alone must not be described as generation.
- **Background intelligence** includes local incremental indexing/retrieval by default and optional scheduled model analysis which produces cited drafts. It never grants a model authority to bypass policy or mutate the world autonomously.

## 2. Product shape

Implement a small monorepo with these independently testable parts:

1. **Local host/daemon** — a persistent per-user Node.js TypeScript broker that owns configuration, the authenticated local bridge, SQLite state/indexing, background jobs, approvals, audit records, and provider credentials. It binds to loopback by default and remains useful for cached indexing/jobs when no MCP client is attached.
2. **MCP adapter** — a thin process exposes the broker through stdio for Windows desktop MCP clients and delegates through a current-user-only Windows named pipe. An optional authenticated loopback Streamable HTTP mode may expose the same registry, but stdio is the required first-class runtime. Stdout in stdio mode is protocol-only; logs go to stderr/files.
3. **Foundry companion module** — a distributable Foundry v14 module which runs in an authenticated active Foundry client, executes operations through public Foundry APIs under the connected user's permissions, and streams relevant hooks/events to the local host.
4. **Shared protocol package** — versioned request, response, event, error, and capability schemas used by both sides.
5. **Windows tooling** — PowerShell install/update/uninstall/status scripts or equivalent CLI commands for installing the companion module into a chosen Foundry User Data directory and configuring MCP clients.

Use Node.js 22 LTS or newer, TypeScript strict mode, the stable MCP TypeScript SDK v2 packages and MCP `2026-07-28` protocol (with tested legacy-era compatibility where supported), Zod 4 validation, a maintained WebSocket implementation, and SQLite with migrations. Keep one MCP registry builder for stdio and HTTP so capabilities cannot drift. Pin deliberate dependency versions; do not advertise experimental MCP extensions which the selected SDK/client matrix cannot pass in conformance tests.

## 3. Trust and connection model

- The Node host must listen on `127.0.0.1`/`::1` by default and must not expose an unauthenticated LAN service.
- Pairing uses a cryptographically random secret generated locally, stored outside source control, shown once or explicitly rotated, and entered into a Foundry module setting visible only to an authorized GM.
- Authenticate every bridge message or authenticated session with a nonce-based, replay-resistant handshake bound to the world and Foundry origin; validate origin/host where applicable; enforce maximum message/upload sizes, deadlines, rate limits, schema validation, request IDs, and idempotency keys.
- Protect the local daemon pipe with an ACL for the current Windows SID. Store long-term pairing/provider secrets using Windows Credential Manager or DPAPI where available, with a documented file-permission fallback for development.
- Support multiple connected worlds/clients without silently targeting the wrong world. Tools accept a connection/world selector; implicit selection is allowed only when exactly one eligible connection exists.
- Mutations execute with the connected Foundry user's permissions and are re-authorized inside the module. Default policy is read-only until the owner grants scoped create/update/asset/AI-network permissions; generic writes require an eligible local GM connection. Permission failures must be explicit and structured.
- Do not bypass Foundry licensing, permissions, package signatures, encryption, or protected content. Never copy or exfiltrate arbitrary host files. Use only content exposed by normal Foundry APIs and configured asset sources.
- Destructive operations are disabled by default. If delete is implemented, it requires an explicit configuration opt-in plus a short-lived confirmation token/dry-run preview. The user's required capability is enumeration and creation; safe update support is desirable.
- No world content leaves the machine by default. External image/LLM providers are opt-in; credentials stay in the local host and are never sent to the Foundry module, MCP responses, logs, or repository.
- Treat all campaign text and image metadata as untrusted input. Prompt or document content cannot expand tool scopes, change provider routing, authorize a write, or override redaction/retention policy.

## 4. Generic Foundry object capability

“Object” means any Foundry Document reachable through public world collection, compendium, UUID, or embedded-document APIs. The implementation must not hard-code only Actors/Items/Scenes.

Required operations:

- Discover connected world metadata, current user/role, system/module versions, supported document types, world collections, compendium packs, and module capabilities.
- Enumerate root world Documents of any registered type with cursor pagination, deterministic ordering, field projection, folder/type/name query filters, ownership visibility, and bounded page size.
- Enumerate compendium indexes and documents for any accessible pack, with an explicit choice between index-only and hydrated results.
- Enumerate embedded Documents recursively or by parent UUID/embedded type without unbounded traversal.
- Resolve and read an arbitrary Document with async `fromUuid` and `foundry.utils.parseUuid`, returning a JSON-safe representation with UUID, type, parent/pack provenance, ownership summary, and schema/version metadata. Do not manually parse UUID strings or expose live object prototypes.
- Create any supported root or embedded Document from caller-supplied JSON data, using Foundry's generic document APIs and returning the created UUID/document. Support batch create with per-item results and no partial-success ambiguity.
- Update documents by UUID with a required optimistic source-hash/version precondition unless explicitly waived, and dry-run validation when Foundry exposes enough information. Preserve unknown system-specific fields.
- Export a bounded snapshot of selected objects for AI context. Detect cycles, cap depth/bytes/items, redact configured paths, and report truncation.
- Surface structured errors for offline bridge, ambiguous connection, unsupported type, invalid data, permission denied, not found, conflict, timeout, cancellation, and Foundry-side failure.

Suggested MCP tools (names may change only for a clearer consistent namespace):

- `foundry.connections.list`
- `foundry.capabilities.get`
- `foundry.documents.types`
- `foundry.documents.list`
- `foundry.documents.get`
- `foundry.documents.create`
- `foundry.documents.update`
- `foundry.documents.embedded.list`
- `foundry.compendiums.list`
- `foundry.compendiums.documents.list`

## 5. Asset and image capability

Required operations:

- Enumerate image assets recursively through Foundry's supported file browsing APIs across configured/available sources (`data`, `public`, and optional S3 when exposed), with source/path filters, image-extension filters, cursor pagination, bounded recursion, deduplication, and metadata available without downloading every file.
- Find image references embedded in selected Foundry Documents by recursively inspecting JSON-safe document data. Return the owning UUID and JSON path for each reference.
- Upload/create an image asset into an allowed Foundry data path from a local file, base64 payload, or generated result. Normalize names, reject traversal/absolute destination paths, enforce MIME/extension/size policy, handle collisions explicitly, and return the Foundry asset path.
- Create or update a Foundry Document which references an uploaded image as a single auditable operation where requested.
- Provide an image generation tool with a provider interface. Include at least one genuinely usable production provider path (for example OpenAI Images or a documented local ComfyUI endpoint) plus a deterministic local test provider. External providers are disabled until explicitly configured. Generation supports prompt, optional negative prompt/provider options, aspect/size, destination, filename, and attach-to-document behavior. The generated binary is MIME-sniffed, pixel/byte bounded, unsafe SVG is rejected or rasterized, and the image is decoded before upload.
- URL import, if implemented, blocks loopback, link-local, private-network, credential-bearing, redirect-chain, and oversized responses by default to prevent SSRF.
- Never expose provider keys. Report provider/destination/cost-relevant metadata where available without logging sensitive request content by default.

Suggested tools:

- `foundry.assets.images.list`
- `foundry.assets.references.find`
- `foundry.assets.images.upload`
- `foundry.assets.images.generate`
- `foundry.assets.images.attach`

## 6. Journal sessions

Implement campaign/AI working sessions backed by real Foundry JournalEntry and JournalEntryPage Documents so they remain visible and editable in Foundry.

Required operations:

- Start a session with title, purpose, tags, participants, and optional linked Document UUIDs. Create or use a configurable journal folder and return stable session/journal/page UUIDs.
- Append timestamped notes, observations, decisions, TODOs, generated summaries, and links to Foundry UUIDs. Sanitize journal HTML and preserve caller attribution.
- List/search sessions and read a session timeline with pagination.
- End/reopen a session, recording status and end time without destroying prior content.
- Make retries idempotent through request/idempotency keys so a network retry does not duplicate pages or entries.
- Keep a machine-readable metadata block/flags owned by this module and human-readable journal pages. Do not overwrite unrelated user journal content.
- Preserve Foundry ownership and page-level secrecy. Whispers, secret journal blocks, and private user notes are excluded from intelligence/provider input by default.

Suggested tools:

- `foundry.sessions.start`
- `foundry.sessions.append`
- `foundry.sessions.list`
- `foundry.sessions.get`
- `foundry.sessions.end`
- `foundry.sessions.reopen`

## 7. Background intelligence

“Background intelligence” means the host continuously maintains useful, bounded AI context while it is running; it does not mean autonomous unreviewed world mutation.

- The companion module emits ordered, permission-aware event envelopes with sequence IDs for generic create/update/delete hooks and useful world activity such as journal, scene, combat, and chat changes. Event categories are configurable; private chat/content capture is off by default. Broker acknowledgements support resume and duplicate suppression.
- The host persists an append-only event ledger and a latest-object snapshot/index in SQLite. Include migrations, retention controls, WAL/busy-timeout handling, crash recovery, and redaction rules.
- Provide deterministic local intelligence without any external model: changed-since queries, relevant-object retrieval, full-text search, session/world timelines, relationship/link extraction, and bounded context packs suitable for an AI prompt.
- Optionally summarize or classify event batches using a configured provider or MCP sampling when a compatible client is connected. Provider failure must not stop ingestion/indexing. Generated intelligence records provenance, model/provider, source event IDs, timestamp, and status.
- Never mutate Foundry automatically from background analysis. Proposed actions are returned as suggestions and require an explicit MCP tool call.
- Expose resource/list change notifications or equivalent MCP notifications where supported, plus health/queue/last-sync observability.
- Perform an initial snapshot and bounded periodic/on-reconnect reconciliation so missed client hooks cannot leave the index silently stale.

Suggested tools/resources/prompts:

- `foundry.intelligence.search`
- `foundry.intelligence.context`
- `foundry.intelligence.timeline`
- `foundry.intelligence.summarize`
- `foundry.intelligence.status`
- resources such as `foundry://connections`, `foundry://world/{connectionId}`, `foundry://document/{uuid}`, `foundry://session/{uuid}`, and `foundry://intelligence/latest`
- prompts for campaign briefing, session recap, encounter preparation, NPC consistency, and change review

## 8. MCP behavior

- Implement tools with strict input schemas, useful descriptions, stable structured outputs, text fallbacks, annotations where supported, and cursor pagination.
- Expose read-only information as MCP resources and reusable workflows as prompts; do not model every read as a side-effecting tool.
- Support progress notifications and cancellation for recursive scans, generation, upload, indexing, and summary operations. Carry one correlation ID and deadline through MCP, named-pipe, bridge, provider, and audit events; state clearly when cancellation occurs after a side effect has already committed.
- Bound all outputs. Large results return summaries plus cursors/resource URIs or artifact references rather than overflowing client context.
- Stdio must never write logs to stdout. Graceful shutdown closes transports, bridge sockets, timers, workers, and SQLite cleanly.
- Optional Streamable HTTP binds to loopback unless explicitly configured and includes current host-header/origin protections and authentication. Do not add deprecated HTTP+SSE as the primary path.
- Maintain durable internal jobs for background work. Do not claim MCP Tasks, sampling, or logging support merely because an SDK contains partial/legacy APIs; advertise only capabilities covered by conformance and host tests.
- Include a `doctor` command which checks config permissions, database migrations, bridge/MCP ports, Foundry module installation, active connections, provider configuration (without printing secrets), and Windows path/runtime issues.

## 9. Configuration and Windows UX

- Provide a checked-in `.env.example` or typed config example with no secrets, plus precedence rules for CLI flags, environment variables, and config file.
- Store runtime data under an appropriate Windows per-user application data directory by default, not the repository.
- Provide commands/scripts to build a versioned Foundry module zip, install it to a user-selected Foundry User Data directory, generate/rotate pairing credentials, print MCP client JSON snippets, start the host, run doctor, and uninstall only files owned by this product.
- PowerShell scripts use literal paths, quote paths with spaces, avoid `$HOME`/`$home` reassignment, are idempotent, and refuse unsafe recursive deletion targets.
- Document setup for Codex/Claude Desktop-compatible stdio configuration generically without requiring either client for tests.
- Include troubleshooting for no active GM, mixed-content/WebSocket restrictions, wrong Foundry data directory, port conflict, pairing failure, provider failure, permissions, and protocol/log corruption.
- Provide an opt-in per-user Scheduled Task/logon launcher for the broker; do not require administrator rights, a Windows Service, firewall rules, UPnP, or LAN exposure.
- Support install paths and Foundry User Data paths containing spaces and Unicode. Never assume the default Foundry data path when a user selected a custom one.

## 10. Testing and release gates

All commands must work from a fresh Windows checkout using documented prerequisites.

Required automated coverage:

- Unit tests for schemas, pagination/cursors, path safety, redaction, permission/policy decisions, idempotency, event coalescing, retry/timeout/cancellation, image validation, journal transforms, and config precedence.
- Shared-protocol contract tests between Node host and companion module.
- A deterministic fake Foundry runtime/bridge exercising generic world, compendium, embedded document, asset, upload, hook event, and journal behavior. Production code must not silently use the fake.
- MCP in-process or child-process tests which list tools/resources/prompts and call representative read, create, image, session, and intelligence operations over stdio without stdout corruption.
- MCP protocol/conformance tests for the declared `2026-07-28` surface and any advertised legacy compatibility.
- End-to-end test: fake Foundry connects and pairs; MCP client enumerates types/documents/images; creates a root and embedded object; uploads or locally generates an image and attaches it; starts/appends/ends a journal session; emits a world event; waits for indexing; retrieves a context pack; verifies persisted state after restart.
- Security tests for bad/expired token, origin/host failure, path traversal, oversized payload, schema abuse, wrong-world targeting, replay/idempotency, non-GM mutation, secret redaction, and external-provider-disabled defaults.
- Permission fixtures for Player, Trusted, Assistant, and GM must prove hidden Documents/pages remain hidden and unauthorized writes leave identical before/after state.
- Restart/recovery tests interrupt the broker, module bridge, MCP adapter, image job, and queued mutation; recovery must not duplicate documents, session entries, events, or charges.
- Build/typecheck/lint/test commands and coverage thresholds run in CI on `windows-latest` and at least one non-Windows runner for portability.
- Build a loadable Foundry module directory and zip with a valid `module.json` for Foundry v14.
- Run `npm pack --dry-run` or equivalent package-content validation so secrets, databases, logs, fixtures with sensitive content, and development artifacts are excluded.

If a real local Foundry v14 installation is available, provide an opt-in non-destructive smoke-test checklist/script. Never manufacture a claim that proprietary Foundry was launched or validated when only the fake runtime was used.

## 11. Documentation deliverables

- Architecture and threat model with data-flow diagram.
- Tool/resource/prompt reference with schemas and examples.
- Windows quick start from clone through first successful `foundry.connections.list`.
- Foundry module install/enable/pair guide.
- Image provider configuration and privacy/cost notes.
- Journal session and background intelligence behavior.
- Developer guide for build, tests, module packaging, migrations, and adding document/image providers.
- Explicit validation matrix distinguishing automated fake-runtime evidence from any real Foundry evidence.
- Threat model covering DNS rebinding, CSRF/origin, named-pipe ACLs, token theft/replay, prompt injection, SSRF, traversal, decompression bombs, malicious SVG, private-content leakage, and malicious module-socket messages.

## 12. Definition of done

The work is done only when:

1. Every required capability above has real implementation and automated evidence.
2. Fresh install/build/typecheck/lint/test/package workflows pass.
3. The Foundry module zip and Windows setup path are produced and documented.
4. No high/critical findings remain after adversarial security and correctness review.
5. The feature branch contains coherent commits and the final report lists exact commands and outcomes, known limitations, and what still requires a user's live Foundry/provider credentials.

Do not stop at planning, scaffolding, or a demo. Continue until the implementation, tests, docs, and release artifacts satisfy this contract.
