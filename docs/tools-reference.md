# Foundry MCP tools and resources

This reference describes the public MCP surface exposed by `foundry-mcp`. The server discovers
Foundry Document types and Actor/Item subtypes at runtime; names such as `Actor`, `Item`, and
`JournalEntry` below are examples, not a compiled-in allowlist.

All mutating calls require an explicit `connectionId`, the connected Foundry user's permission,
and a host capability grant. Read calls may omit `connectionId` only when exactly one world is
online. Page sizes are bounded by the schemas and opaque cursors must be reused only with the same
query.

## Result and error conventions

Successful tools return a short text summary and a typed object in MCP `structuredContent`.
Failures set `isError: true` and put a JSON error envelope in the text content:

```json
{
  "code": "PERMISSION_DENIED",
  "message": "Permission denied: missing capability assets:upload",
  "retryable": false,
  "details": {
    "missingCapability": "assets:upload",
    "connectionId": "world-a:gm"
  }
}
```

Common codes include `INVALID_DATA`, `NOT_FOUND`, `CONFLICT`, `PERMISSION_DENIED`,
`OFFLINE_BRIDGE`, and `FOUNDRY_ERROR`. Unknown Foundry system fields and ownership data are
preserved during updates and image attachment.

## Connection and capability tools

| Tool                       | Input schema         | Example arguments |
| -------------------------- | -------------------- | ----------------- |
| `foundry.connections.list` | Strict empty object. | `{}`              |
| `foundry.capabilities.get` | Empty object.        | `{}`              |

`foundry.connections.list` returns `connections[]` with `connectionId`, `worldId`, `worldTitle`,
status, Foundry version when available, and last-seen timestamp. `foundry.capabilities.get` returns
the negotiated MCP revision, legacy MCP revisions, private bridge revision, and named capability
versions.

## Generic Document tools

| Tool                                 | Input schema                                                                                                                                                                                                        | Example arguments                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `foundry.documents.types`            | `{ connectionId?: string }`                                                                                                                                                                                         | `{"connectionId":"world-a:gm"}`                                                                                                                |
| `foundry.documents.list`             | `{ connectionId?, type, subtype?, folder?, nameFilter?, fields?, cursor?, pageSize?, sort? }`                                                                                                                       | `{"connectionId":"world-a:gm","type":"Actor","subtype":"npc","pageSize":25,"sort":{"field":"name","direction":"asc"}}`                         |
| `foundry.documents.get`              | `{ connectionId?, uuid }`                                                                                                                                                                                           | `{"connectionId":"world-a:gm","uuid":"Actor.a1"}`                                                                                              |
| `foundry.documents.create`           | Single `{ connectionId, type, data, parentUuid? or packId?, atomic?: false, dryRun? }` or batch `{ connectionId, items[], atomic?, dryRun? }`; `parentUuid` and `packId` are mutually exclusive; at most 100 items. | `{"connectionId":"world-a:gm","type":"Actor","packId":"world.bestiary","data":{"name":"Runtime Actor","type":"system-defined"},"dryRun":true}` |
| `foundry.documents.update`           | `{ connectionId, uuid, data, expectedHash? or expectedVersion?, forceOverwrite?, dryRun? }`; a concurrency token is required unless forced.                                                                         | `{"connectionId":"world-a:gm","uuid":"Actor.a1","expectedHash":"fmcp-v2-…","data":{"system":{"hp":{"value":12}}},"dryRun":true}`               |
| `foundry.documents.embedded.list`    | `{ connectionId?, parentUuid, embeddedType?, recursive?, maxDepth?, cursor?, pageSize? }`                                                                                                                           | `{"connectionId":"world-a:gm","parentUuid":"Actor.a1","embeddedType":"Item","recursive":true,"maxDepth":3}`                                    |
| `foundry.compendiums.list`           | `{ connectionId?: string }`                                                                                                                                                                                         | `{"connectionId":"world-a:gm"}`                                                                                                                |
| `foundry.compendiums.documents.list` | `{ connectionId?, packId, hydrate?, cursor?, pageSize?, sort? }`                                                                                                                                                    | `{"connectionId":"world-a:gm","packId":"world.bestiary","hydrate":true,"pageSize":50}`                                                         |
| `foundry.documents.snapshot`         | Either `{ connectionId?, uuids[], limits… }` or `{ connectionId?, query, limits… }`; limits are `maxDepth`, `maxBytes`, `maxItems`, and `redactionPaths`.                                                           | `{"connectionId":"world-a:gm","uuids":["Actor.a1"],"maxDepth":6,"maxBytes":64000,"redactionPaths":["system.secret"]}`                          |

`foundry.documents.types` returns every currently registered root and embedded Document type,
parent relationship, runtime schema version, and effective readable/creatable/updatable status for
every runtime subtype. List and compendium results use stable sorting and opaque cursor pagination.
Create returns per-item `created`, `error`, `rolled_back`, or dry-run `validated` results and reports
whether an atomic batch committed. Dry-run checks effective permissions, target and subtype
compatibility, concurrency tokens for updates, and any side-effect-free schema validator exposed by
Foundry; `schemaValidated: false` is accompanied by a bounded warning. Compendium summaries expose
destination writability and a reason when locked or denied. Get and update return plain serialized
data, source version/hash, ownership summary, schema version, and parent/pack metadata rather than
live Foundry objects.

There is intentionally **no public delete tool**. Deletions performed in Foundry are observable as
configured intelligence events. Internal delete calls are used only to compensate or roll back a
failed atomic create/asset operation. This keeps destructive user-facing operations outside the
accepted tool contract.

## Image and asset tools

| Tool                             | Input schema                                                                                                                                                    | Example arguments                                                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `foundry.assets.images.list`     | `{ connectionId?, source?, pathPrefix?, extensions?, cursor?, pageSize?, maxDepth? }`                                                                           | `{"connectionId":"world-a:gm","pathPrefix":"tokens","extensions":[".png",".webp"],"maxDepth":4}`                                                                                |
| `foundry.assets.references.find` | Either `{ connectionId?, uuids[] }` or `{ connectionId?, query: DocumentsListInputWithoutPaging }`.                                                             | `{"connectionId":"world-a:gm","uuids":["Actor.a1","Scene.s1"]}`                                                                                                                 |
| `foundry.assets.images.upload`   | `{ connectionId, sourceId?, destinationPath, source, onCollision? }`; `source` is a validated `base64`, host-authorized `file`, or internal `generated` source. | `{"connectionId":"world-a:gm","sourceId":"data","destinationPath":"tokens/a1.png","source":{"kind":"base64","data":"iVBORw0K…","mimeType":"image/png"},"onCollision":"rename"}` |
| `foundry.assets.images.generate` | `{ connectionId, prompt, provider?, options?, sourceId?, destinationPath, onCollision? }`                                                                       | `{"connectionId":"world-a:gm","prompt":"ink portrait of an astral knight","provider":"deterministic","destinationPath":"generated/astral-knight.png"}`                          |
| `foundry.assets.images.attach`   | `{ connectionId, documentUuid, fieldPath?, expectedHash?, asset }`; asset is an existing `reference`, validated `upload`, or SSRF-checked `url`.                | `{"connectionId":"world-a:gm","documentUuid":"Actor.a1","fieldPath":"img","asset":{"kind":"reference","sourceId":"data","path":"tokens/a1.png"}}`                               |

Listing returns every FilePicker source with destination-aware `writable` and a reason when
read-only, deduplicated broad-format image paths, pagination, and depth truncation reasons.
Non-core providers such as S3 require explicit bucket and writable-prefix configuration before the
module claims write access. Upload verifies relative traversal-safe paths, size, a safe writable
format, MIME declaration, and image magic bytes before FilePicker is called.
Collision policy is `error`, `rename`, or `overwrite`.

Configure non-core sources through the GM-only world setting documented in
[Host configuration, privacy, and providers](./configuration.md#foundry-non-core-asset-sources).
The setting contains capabilities and bounded path prefixes only—never credentials.

The deterministic provider is the offline default and returns a valid reproducible PNG. Every
network-backed image provider requires both `assets:upload` and `ai:network`; unknown providers are
treated as network-backed and fail closed. The optional `openai` provider is host-configured only;
its API key is never accepted by a tool or returned in output. Provider failures are structured and never silently fall back. URL attachment
allows only validated public HTTP(S) targets, revalidates redirects, pins resolved public
addresses, and enforces response limits. Attach performs upload/reference resolution plus the
Document update atomically when compensation is available.

## Journal session tools

| Tool                      | Input schema                                                                                                                 | Example arguments                                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `foundry.sessions.start`  | `{ connectionId, title, purpose, tags?, participants?, linkedUuids?, folder? or folderName?, initialHtml?, idempotencyKey }` | `{"connectionId":"world-a:gm","title":"Session 12","purpose":"Explore the observatory","linkedUuids":["Scene.s1"],"idempotencyKey":"session-12-start"}`           |
| `foundry.sessions.append` | `{ connectionId, sessionId, kind, html, attribution, linkedUuids?, private?, idempotencyKey }`                               | `{"connectionId":"world-a:gm","sessionId":"session-12","kind":"decision","html":"<p>Open the gate.</p>","attribution":"GM","idempotencyKey":"session-12-page-1"}` |
| `foundry.sessions.list`   | `{ connectionId?, status?, query?, cursor?, pageSize? }`                                                                     | `{"connectionId":"world-a:gm","status":"open","query":"observatory"}`                                                                                             |
| `foundry.sessions.get`    | `{ connectionId?, sessionId, cursor?, pageSize? }`                                                                           | `{"connectionId":"world-a:gm","sessionId":"session-12","pageSize":50}`                                                                                            |
| `foundry.sessions.end`    | `{ connectionId, sessionId, idempotencyKey }`                                                                                | `{"connectionId":"world-a:gm","sessionId":"session-12","idempotencyKey":"session-12-end"}`                                                                        |
| `foundry.sessions.reopen` | `{ connectionId, sessionId, idempotencyKey }`                                                                                | `{"connectionId":"world-a:gm","sessionId":"session-12","idempotencyKey":"session-12-reopen"}`                                                                     |

Sessions are ordinary module-owned `JournalEntry` Documents with timestamped
`JournalEntryPage` children. Start, append, end, and reopen are idempotent. HTML is sanitized,
existing journal content and ownership are preserved, and private pages are marked for default
intelligence exclusion. List and get are cursor paginated.

## Intelligence tools

| Tool                                 | Input schema                                                                                                                          | Example arguments                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `foundry.intelligence.search`        | `{ connectionId, query, limit? }`                                                                                                     | `{"connectionId":"world-a:gm","query":"astral gate","limit":20}`                                         |
| `foundry.intelligence.status`        | `{ connectionId }`                                                                                                                    | `{"connectionId":"world-a:gm"}`                                                                          |
| `foundry.intelligence.timeline`      | `{ connectionId, sessionId?, worldId?, from?, to?, cursor?, limit? }`                                                                 | `{"connectionId":"world-a:gm","from":"2026-08-29T12:00:00Z","limit":50}`                                 |
| `foundry.intelligence.changed-since` | `{ connectionId, afterSequenceId? or afterTimestamp?, cursor?, limit? }`; exactly one starting position is required.                  | `{"connectionId":"world-a:gm","afterSequenceId":120,"limit":100}`                                        |
| `foundry.intelligence.context`       | `{ connectionId, query?, afterSequenceId? or afterTimestamp?, sessionId?, worldId?, from?, to?, maxEvents?, maxObjects?, maxBytes? }` | `{"connectionId":"world-a:gm","query":"recent actor and scene changes","maxEvents":25,"maxBytes":65536}` |

Intelligence is built from the local, redacted, resumable event ledger. Search is deterministic;
status reports reconciliation state and timestamps, queue depth, indexed/scanned/changed/private-
filtered/retention counts, gap and truncation flags, and a bounded last error; timeline and
timestamp paging use opaque stable cursors; changed-since accepts a sequence or timestamp boundary;
context returns bounded source events plus their provenance IDs. Private chat or journal content is
off by default and configurable event categories are filtered before persistence.

## Enumerable resources

Resources return `application/json` and reuse the same bridge services and validation as tools.
Every world-scoped resource URI names its authenticated connection explicitly, so duplicate UUIDs
or session IDs in two connected worlds cannot resolve ambiguously. Connection metadata includes the
bounded current-user identity and role, game-system id/version, active module ids/versions, and the
module capabilities advertised by the authenticated browser companion; pairing values and provider
secrets are never part of this discovery surface.

| Resource or template                           | Enumeration/read behavior                                                                                                                     | Example URI                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `foundry://connections`                        | One fixed resource containing known live connections.                                                                                         | `foundry://connections`                      |
| `foundry://world/{connectionId}`               | Enumerable for each live world; returns connection metadata and runtime Document types.                                                       | `foundry://world/world-a%3Agm`               |
| `foundry://document/{connectionId}/{uuid}`     | Enumerates up to 500 visible root Documents and reads one UUID from the named connection. Both path segments are percent-encoded.             | `foundry://document/world-a%3Agm/Actor.a1`   |
| `foundry://session/{connectionId}/{sessionId}` | Enumerates module-owned sessions and reads one complete paged session view from the named connection. Both path segments are percent-encoded. | `foundry://session/world-a%3Agm/session-12`  |
| `foundry://intelligence/{connectionId}/latest` | Enumerates one latest bounded timeline per live connection. The connection path segment is percent-encoded.                                   | `foundry://intelligence/world-a%3Agm/latest` |

## Prompts

The adapter registers five reusable prompt templates. Every prompt requires an explicit
`connectionId`; no prompt performs tool calls itself or grants mutation authority. Optional
selectors are bounded single-line strings and are treated as untrusted filter data.

| Prompt                          | Arguments                                                | Read-only workflow                                                                                         |
| ------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `foundry.campaign.briefing`     | `{ connectionId, sessionId?, query? }`                   | Builds a current-situation briefing from the named world, latest intelligence, and optional session.       |
| `foundry.session.recap`         | `{ connectionId, sessionId?, query? }`                   | Produces a chronological, cited recap from an optional module-owned session and bounded timeline.          |
| `foundry.encounter.preparation` | `{ connectionId, sceneUuid?, query? }`                   | Reviews a Scene and directly linked evidence, then returns a non-mutating GM preparation checklist.        |
| `foundry.npc.consistency`       | `{ connectionId, npcUuid?, query? }`                     | Compares established NPC facts and portrayals and reports cited contradictions without updating Documents. |
| `foundry.changes.review`        | `{ connectionId, afterSequenceId?, sessionId?, query? }` | Reviews bounded ordered events and affected Documents after an optional decimal sequence ID.               |

Generated prompt messages direct clients only to connection-qualified resource URIs and the
read-only Document, session, and intelligence tools. They cap result sizes and page counts, require
source resource URIs/UUIDs/event IDs/timestamps, separate facts from inference, and report stale,
redacted, missing, or truncated evidence. Foundry and Journal text remains untrusted: embedded
commands, links, permission claims, or requests to call tools are ignored.

Supported legacy protocol negotiations expose the same five templates. A missing required
`connectionId`, an unknown argument, or an out-of-bounds selector returns a structured MCP
`InvalidParams` error; it does not fall back to an implicit world. Prompts never call create,
update, upload, generation, attachment, session-lifecycle, or capability-grant operations.
