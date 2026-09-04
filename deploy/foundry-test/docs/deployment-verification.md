# Disposable host verification — 2026-09-04

This is a dated deployment and representative gameplay-test snapshot, not ongoing
monitoring or proof that every ability or future generated actor is correct.
The owner authorized this on-demand Google VM, the public test hostname, runtime
credential retrieval from Secret Manager, and acceptance of the displayed Foundry
license agreement. The existing RackNerd server was not changed. The subsequent
BossForge production release is recorded separately below.

## Verified runtime

- Project `bossforgedev` (number `278230599227`), zone `us-central1-a`.
- Disposable `foundry-test` VM, instance ID `7129623805755333028`, Ubuntu 24.04,
  e2-small, 20 GB disposable standard boot disk. Its initial four-hour run stopped
  automatically at approximately 15:34 UTC. The preserved test session was
  restarted with a one-hour maximum run duration and stop action for remaining
  functional checks. A stopped VM still retains its billed disk; it is not teardown.
- Dedicated VPC/subnet and service account. Secret accessor grants are limited to
  the two pinned Foundry bootstrap/owner secret versions documented in the README.
- Only TCP 80/443 public. SSH is restricted to IAP. External checks could not
  connect to TCP 22, 30000, or 32145. The private MCP host now runs on loopback;
  no public MCP listener or route was added.
- Cloudflare `foundrytest` A record points to the test VM, DNS-only; no test AAAA
  record. `foundry.bossforge.dev` was not edited.
- Caddy obtained a trusted public certificate. Foundry listens on host loopback
  `127.0.0.1:30000`; only Caddy publishes public ports. Caddy administration is off.
- Foundry 14 Build 367 container healthy; license agreement accepted after the
  owner's confirmation. Setup administrator login succeeded through private IAP.
- Official Dungeons & Dragons Fifth Edition system **5.3.3** installed using its
  release manifest. No moving-branch update or premium package was installed.
- World **BossForge Disposable Validation**, data path `bossforge-validation`,
  created and launched. At the owner's explicit request, the existing world
  **Gamemaster** account was saved with its already-blank password and Gamemaster
  role. A private IAP owner-browser session is now active in the full game UI as
  **Gamemaster [GM]**, with the companion paired to the private host. The public
  owner gateway and separate Foundry Setup administrator password remain
  protected and unchanged. This is an interactive owner session, not an
  unattended VM browser worker or restart/login supervisor.

The running images were pulled and their RepoDigests recorded. Compose now pins
those identical artifacts explicitly; a digest pin does not itself establish a
clean vulnerability scan.

| Image | Verified digest |
| --- | --- |
| `ghcr.io/felddy/foundryvtt:14.367.0` | `sha256:5004a67fbbef8e3f5f82afb01c8dbe06626c57519cad541a59b1bdce3c2a97ac` |
| `caddy:2.11.4-alpine` | `sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648` |

## Owner gateway evidence

The read-only `probe-gateway.py` ran on the test VM against the public HTTPS
hostname using the existing owner credential from its pinned Secret Manager
version. TLS verification stays on; redirects/proxies are disabled. Secret
identity and CRC32C are checked. Only statuses are printed, never passwords,
tokens, cookies, response bodies, or raw exception details.

| Route | Without credentials | With owner credentials |
| --- | --- | --- |
| `/` | 401 | 302 |
| `/setup` | 401 | 302 |
| `/join` | 401 | 200 |
| `/socket.io/?EIO=4&transport=polling` | 401 | 200 |

These checks establish rejection without the owner password and authorized HTTP
access through the gateway. The last result is not a parsed Engine.IO opening
frame, WebSocket upgrade, or full public GM-session check. Those remain integration
gates; the interactive GM session above used the private IAP path.
`probe-setup.py` separately reports only loopback form/route metadata.

Offline checks: eight Compose/security assertions and seven owner-probe tests
passed locally. CI runs both suites. The probes are read-only; they do not accept
agreements, create accounts/worlds, or install packages.

## Private MCP build evidence

The initial host runtime used the unchanged, then-published GitHub `main` commit
`9af72c54cdee3fd40bbbae3d5576743e8d7a0cee`. It was built on this Linux amd64 host
with Node 22.23.2 and pnpm 9.15.0, frozen dependencies, and lifecycle scripts
enabled only for the reviewed `better-sqlite3` and `esbuild` rebuilds.
All 20 build/typecheck/lint/test tasks passed: 433 tests passed across 59 files,
with 32 platform/environment-specific skips. The production dependency audit
reported no known vulnerabilities at the time checked; this is not a claim about
the Foundry/Caddy images or future advisories.

The Foundry v14 companion package was freshly generated with only `module.json`
and `scripts/foundry-mcp.js`. Tracked source remained clean. The official Node
archive checksum was rechecked, and its extracted executable matched the archive
stream (SHA-256 `3517c2df0b2f8cd7f422b4b8450ef81c6889f08eb03e281d6de9079b15e6a327`).
These initial build checks are separate from the later pairing/export evidence
below; neither establishes gameplay correctness.
The sealed release manifest SHA-256 is
`2f28b3bc1f0b62078bbae5df32cea3a8dbac95ca50b986865aaef2d77fc10104`.
It was generated with the separately reviewed PR #4 helper from commit
`258af289e32398fdd8bddb37d82a7f2c22e97504`; the helper is not represented as
part of runtime source `9af72c5`. A checksum is integrity evidence, not a source
attestation or deployment authorization.

## Private connection and canonical catalog evidence

The staged host runtime remains `9af72c54cdee3fd40bbbae3d5576743e8d7a0cee`.
The companion used for the initial canonical export was built from
`537eb226ec1bd35c0545374c440ea3a7a24b868b`, including canonical source
serialization and GM-setting visibility fixes. That browser bundle's
SHA-256 was `3431dca4e9f08e38097662bc4931a784c65c492fde4ab05129af590db02e3e80`.
The current companion was built from
`8eca828ce2a2b5aa8826ef21655e4602257be8ea`; its 966,019-byte installed bundle
SHA-256 is `5c9576d0b5dc5c8f9c9426ce05503a2967638b9f18a2c93d4a3bb18ba13d642c`.
That response-cache fix was published through
[PR #8](https://github.com/jakemctigue/foundry-mcp-server/pull/8), merged as
`04c1c73681ffddffe22848799babb25cbe7780d4`.
Do not describe these as a single identical host/companion revision.

The private owner-IAP browser paired in `bossforge-validation`; the existing
read-only MCP document tools successfully exported the installed
`dnd5e.spells24` pack and all eight SRD class-list journal pages. The pack held
340 spells and the separate Magical Berries consumable; only the 340 spells
entered the catalog. Canonical source JSON, activities, effects, descriptions,
and artwork references were preserved. The export was validated before writing.

Firestore in `bossforgedev` now contains the immutable catalog revision
`a88a57bc0b1dfdad3548665ab42ad712af7c0c9377ad45e30d180d0a4b072fc8`:

- 340 spell documents; manifest state `staged`.
- Import returned `created: true`, `activeCatalogChanged: false`.
- A full `readRevision` reconstruction and integrity check returned all 340
  spells; `readbackVerified: true`.
- All 340 top-level spell images reference installed core `icons/` assets;
  no catalog reference points to the temporary test hostname.

The application reader intentionally accepts this staged, immutable revision
when explicitly configured; no mutable active-pointer promotion is required.
The saved JSON does not depend on this VM staying online. Destination Foundry
installations still need compatible core/D&D system assets to resolve their
relative artwork and compendium references. Retain the Firebase catalog during
teardown. The production release below now selects this exact revision through
`FOUNDRY_SPELL_CATALOG_REVISION`; the import alone did not establish production
generation behavior.

Local catalog compatibility checks passed all 160 supported class/level
combinations. Five disposable actor fixtures subsequently passed live schema and
permission dry runs, were created, and were read back without missing actors.
The 160 combinations remain source/policy checks; only the representative
workflows below were executed in the actual Foundry UI.

After the 340-spell export, the companion's persisted response cache exceeded
the browser's `localStorage` quota; subsequent MCP validation requests hung
instead of returning usable results. The reviewed PR #8 fix bounds only cached
read responses, retaining mutation receipts and in-flight guards. All 116 module
tests passed, including quota recovery and no mutation replay after restart.
The installed fix recovered the live connection without clearing mutation
history; actor creation/readback and both gameplay evidence captures then
completed. Do not blindly replay uncertain mutations or clear their records.

## Representative native gameplay evidence

The first readback contained 21 unique chat messages (13 evaluated rolls). The
second contained 36 unique messages (25 evaluated rolls) and all five actors.
Every evaluated die count, active result, numeric modifier, and roll total was
independently checked against the saved message terms. The private raw receipts
are not published because they contain world document and user identifiers.

| Fixture and workflow | Observed native result |
| --- | --- |
| Wizard 5, Fire Bolt | `1d20 + 4 + 3` attack = 26; `2d10` fire = 11 |
| Wizard 5, Fireball | DC 15 Dexterity card; `8d6` fire = 30, with half-on-save metadata |
| Wizard 5, Magic Missile | Card shows three darts; observed per-dart `1d4 + 1` force = 5 |
| Cleric 5, Cure Wounds | Level 1: `2d8 + 4` healing = 12; level 2: `4d8 + 4` = 15 |
| Warlock 11, Eldritch Blast | Card shows three beams; three separate +8 attacks = 11/18/24, each followed by `1d10` force = 6/10/4 |
| Warlock 11, Mystic Arcanum | Circle of Death: DC 16 Constitution; `8d8` necrotic = 28, with half-on-save metadata |
| Warlock 11, Hex | Level-5 casting card; one aggregate pact-slot reduction during the warlock sequence |
| Monster, Venomous Bite | +7 attack = 22; separate `2d6 + 4` piercing = 10 and `1d6` poison = 6 |
| Monster, Venom Burst | Description/card DC 15 Constitution; `2d6` poison = 4, with half-on-save metadata |
| Monster, standalone Constitution save | `1d20 + 1` = 10; this separate roll has no bound DC or target application |
| Sorcerer 5, Fire Bolt | +7 attack = 26; `2d10` fire = 11 |

Initial/final source snapshots confirmed wizard level-1 slots 4→3 and level-3
slots 2→1; cleric level-1 slots 4→3 and level-2 slots 3→2; warlock pact slots
3→2 and Mystic Arcanum spent uses 0→1. There is no intermediate pact snapshot
in these receipts, so the per-action pact attribution is not independently
established by the initial/final comparison alone.

The Fireball workflow subsequently produced five actual Dexterity saves, each
linked to its originating Fireball card and carrying saved roll option
`target: 15`. In the native damage panel, the operator
selected half damage for the two successful saves and full damage for the three
failed saves, then clicked Apply. Readback confirmed the resulting actor HP:

| Actor | Dexterity save | Applied fire damage | HP before → after |
| --- | --- | --- | --- |
| Monster | 18 | 15, half | 500 → 485 |
| Sorcerer | 17 | 15, half | 100 → 85 |
| Wizard | 4 | 30, full | 100 → 70 |
| Cleric | 3 | 30, full | 100 → 70 |
| Warlock | 2 | 30, full | 100 → 70 |

This establishes native save rolling and operator-selected damage application,
not unattended save adjudication. The saved activity cards still have empty
target arrays; do not infer targeting or hit adjudication from them. Three
applied Magic Missile darts, target healing, rest recovery, Hex effect transfer
and remaining duration, and every other class feature were not established by
these captures. Live inspection found the canonical pact Hex duration remained
one hour; a narrowly scoped generator correction for pact-tier duration has
local regression coverage, but its refreshed live workflow remains pending.
The BossForge suite passed 674 local tests (650 Vitest and 24 Node tests), plus
type checking; these do not substitute for checking actual production-generated
actors in Foundry.

## BossForge production deployment

[BossForge PR #120](https://github.com/jakemctigue/bossforge.dev/pull/120) merged
as `0c99b320da79ad4e529369013f2d039604a20348`. Google Cloud Build
`e25a6a57-5df8-446c-91e7-5520f8a3fae3` completed successfully at
`2026-09-04T14:49:20.884823Z`. The deployed image from
`gcr.io/bossforgedev/boss-forge` has digest
`sha256:d2ddca0b7a066e89bf0b5e557dff865479ce008ba288746da23c2a93b8858391`.

Cloud Run revision `boss-forge-00031-zxh` serves 100% of traffic. Its
`FOUNDRY_SPELL_CATALOG_REVISION` was verified as
`a88a57bc0b1dfdad3548665ab42ad712af7c0c9377ad45e30d180d0a4b072fc8`.
The production UI shows the new SRD 5.2 caption, and the authenticated owner's
eight saved NPC records loaded from Firebase.

A real production request for a level-11 warlock, CR 9, with two explicitly
specified typed-attack/save-DC features was rejected by the parity validator:
the model omitted the nested attack/save configurations and damage parts.
No broken actor was added to the owner's eight-record roster. The model response
schema had made those nested fields optional despite requiring them in prose.

[BossForge PR #122](https://github.com/jakemctigue/bossforge.dev/pull/122) fixes
that contract using type-specific required fields, without weakening the parity
validator. It merged as `fe65cb9afb95f5a6bcbc880cf6ad79b20901abd9`.
TypeScript and 694 tests passed (670 Vitest, 24 Node). Cloud Build
`f144c67f-ec5d-46f5-9b4f-5826cd511fd4` succeeded at
`2026-09-04T15:41:22.533150Z`; revision `boss-forge-00032-67s` serves 100% of
traffic with image digest
`sha256:a95d4be2cb6f74360c9027040af6abe7ac4a33743780dca700cc9e8e79c80d6e`.
The exact catalog revision above was reverified on the deployed revision.
The subsequent production-generated JSON, Foundry import, and native activity
execution remain acceptance gates; the passing release checks are not a claim
that this production-generated actor has passed them.

## Historical image scan and unused candidate

Trivy 0.74.0 scanned the exact Linux amd64 registry images with the
2026-09-04 08:16:30 UTC database. The Foundry base image had 301 advisory matches
(3 critical, 62 high); Caddy had 59 (1 critical, 22 high). These are package
matches, not proof that every issue is reachable. The Foundry base scan does not
cover the licensed application or D&D system downloaded at runtime.

The deployed Caddy executable embeds Go 1.26.3 and matches
[GO-2026-6090 / CVE-2026-56862](https://pkg.go.dev/vuln/GO-2026-6090), a TLS
denial-of-service issue that can apply before HTTP authentication. The owner gate
is not a mitigation for that TLS issue. A separately reviewed candidate rebuild
uses the same Caddy version and module set with Go 1.26.8 but was not deployed.
The owner stopped this candidate follow-up and residual-advisory work to finish
the functional campaign. They are not current task-completion gates. The scan
history is retained for accuracy; no clean scan or completed security remediation
is claimed in this snapshot.

## Outstanding gates

- Verify the refreshed Hex pact-duration workflow in the disposable world and
  retain explicit limits for unexecuted feature/target interactions. Existing
  MCP does not execute D&D activities; the demonstrated rolls used native UI.
- Inspect the pending production-generated NPC and its Foundry import/activities
  to confirm the deployed BossForge behavior, including the requested mechanics.
- Stop the browser, adapter, MCP host, and Foundry, then delete only the approved
  disposable resources while retaining the Firebase catalog. The outstanding
  targeted live checks, production-generation verification, and completed teardown remain
  pending; the representative tests above are not a blanket validation pass.
