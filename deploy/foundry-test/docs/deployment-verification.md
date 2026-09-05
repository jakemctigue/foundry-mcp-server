# Disposable host verification — 2026-09-04

This is a dated deployment and representative gameplay-test snapshot, not ongoing
monitoring or proof that every ability or future generated actor is correct.
The owner authorized this on-demand Google VM, the public test hostname, runtime
credential retrieval from Secret Manager, and acceptance of the displayed Foundry
license agreement. The existing RackNerd server was not changed. The subsequent
BossForge production release is recorded separately below.

## Current delivery snapshot

Evidence cutoff: **2026-09-04 19:20 UTC**. The earlier deployment and fixture
results below are retained as history, not relabeled as tests of later releases.

- BossForge production commit `e30de6212f29db83af181775467abbf560d93836`
  is deployed as `boss-forge-00035-pkb`, with 100% of traffic and the immutable
  340-spell Firebase catalog configured. Exact release evidence is below.
- All eight requested class examples have been imported as separate production
  actors. Native receipts have independently verified selected Wizard, Bard,
  Druid, Ranger, Sorcerer, Paladin, Cleric, and Warlock workflows. Saved receipts
  contain **58 unique messages / 35 evaluated rolls**. A final root-observed
  Contact Patron card adds one message and no roll, for a campaign total of
  **59 / 35**; its evidence level is explicitly distinguished below. Several
  feature-specific behaviors remain pending, and successful source audits and
  imports are not gameplay passes.
- Published MCP `main` contains every deployed runtime fix. The Archon copies
  checked have no ahead-of-GitHub commits or unpublished tracked changes.
- The Foundry stack was shut down gracefully and the disposable Google Cloud
  compute/network resources were deleted. Post-delete inventory found none of
  the targeted Google Cloud resources. The Firebase catalog and account-bootstrap secret
  were intentionally retained. The now-stale `foundrytest` DNS record remains
  pending because its deletion requires confirmation at action time.

## Verified runtime

- Project `bossforgedev` (number `278230599227`), zone `us-central1-a`.
- Disposable `foundry-test` VM, instance ID `7129623805755333028`, Ubuntu 24.04,
  e2-small, 20 GB disposable standard boot disk. Its initial four-hour run stopped
  automatically at approximately 15:34 UTC. The preserved test session was
  restarted with a one-hour maximum run duration and stop action for remaining
  functional checks. A later restart at 16:48:35 UTC used a two-hour stop limit
  (nominal automatic stop 18:48:35 UTC if unchanged). An automatic-stop schedule
  is not evidence that the VM has stopped. A stopped VM still retains its billed
  disk; it is not teardown.
- Dedicated VPC/subnet and service account. Secret accessor grants are limited to
  the two pinned Foundry bootstrap/owner secret versions documented in the README.
- Only TCP 80/443 was public. SSH was restricted to IAP. External checks could not
  connect to TCP 22, 30000, or 32145. The private MCP host ran on loopback;
  no public MCP listener or route was added.
- Cloudflare `foundrytest` initially pointed to the test VM, DNS-only, with no
  test AAAA record. Following the later restart, the hostname was reverified
  against the new ephemeral address; an unauthenticated HTTPS request returned
  the expected 401 owner-gateway response. Private IAP access continued to work.
  `foundry.bossforge.dev` was not edited.
- Caddy obtained a trusted public certificate. Foundry listened on host loopback
  `127.0.0.1:30000`; only Caddy published public ports. Caddy administration was off.
- Foundry 14 Build 367 container was healthy; license agreement accepted after the
  owner's confirmation. Setup administrator login succeeded through private IAP.
- Official Dungeons & Dragons Fifth Edition system **5.3.3** installed using its
  release manifest. No moving-branch update or premium package was installed.
- World **BossForge Disposable Validation**, data path `bossforge-validation`,
  created and launched. At the owner's explicit request, the existing world
  **Gamemaster** account was saved with its already-blank password and Gamemaster
  role. A private IAP owner-browser session was verified in the full game UI as
  **Gamemaster [GM]**, with the companion paired to the private host. At this
  stage, the public owner gateway and separate Foundry Setup administrator
  password remained protected. This is an interactive owner session, not an
  unattended VM browser worker or restart/login supervisor.

The running images were pulled and their RepoDigests recorded. Compose now pins
those identical artifacts explicitly; a digest pin does not itself establish a
clean vulnerability scan.

| Image                                | Verified digest                                                           |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `ghcr.io/felddy/foundryvtt:14.367.0` | `sha256:5004a67fbbef8e3f5f82afb01c8dbe06626c57519cad541a59b1bdce3c2a97ac` |
| `caddy:2.11.4-alpine`                | `sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648` |

## Owner gateway evidence

The read-only `probe-gateway.py` ran on the test VM against the public HTTPS
hostname using the existing owner credential from its pinned Secret Manager
version. TLS verification stays on; redirects/proxies are disabled. Secret
identity and CRC32C are checked. Only statuses are printed, never passwords,
tokens, cookies, response bodies, or raw exception details.

| Route                                 | Without credentials | With owner credentials |
| ------------------------------------- | ------------------- | ---------------------- |
| `/`                                   | 401                 | 302                    |
| `/setup`                              | 401                 | 302                    |
| `/join`                               | 401                 | 200                    |
| `/socket.io/?EIO=4&transport=polling` | 401                 | 200                    |

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

The staged host runtime was `9af72c54cdee3fd40bbbae3d5576743e8d7a0cee`.
The companion used for the initial canonical export was built from
`537eb226ec1bd35c0545374c440ea3a7a24b868b`, including canonical source
serialization and GM-setting visibility fixes. That browser bundle's
SHA-256 was `3431dca4e9f08e38097662bc4931a784c65c492fde4ab05129af590db02e3e80`.
The companion installed for the later checks was built from
`8eca828ce2a2b5aa8826ef21655e4602257be8ea`; its 966,019-byte installed bundle
SHA-256 is `5c9576d0b5dc5c8f9c9426ce05503a2967638b9f18a2c93d4a3bb18ba13d642c`.
That response-cache fix was published through
[PR #8](https://github.com/jakemctigue/foundry-mcp-server/pull/8), merged as
`04c1c73681ffddffe22848799babb25cbe7780d4`.
Do not describe these as a single identical host/companion revision.

### Published-source and Archon comparison

GitHub's branch and ref endpoints both identified published `main` as
`d41ff5c5a43719ec84992e721da5eba5c142e4e9`, the merge of
[PR #3](https://github.com/jakemctigue/foundry-mcp-server/pull/3). A stale local
remote-tracking ref still showed the earlier PR #8 merge; it was not evidence
that GitHub lacked the later commit.

The comparison from host `9af72c5` to published `d41ff5c` changes runtime code
only in the companion: canonical source serialization, ready-time GM setting
visibility, and bounded response-cache persistence. Those fixes are all in the
installed companion `8eca828`. The comparison from that companion commit to
`d41ff5c` contains no package/runtime changes. The recorded split host/companion
deployment therefore contains all published runtime fixes, without claiming
that either artifact was built from the later documentation merge.

The local root and Archon bare `main` at `798083b`, the Archon bare feature branch
at `7b7d2ca`, and the actual Archon worktree at `a80b919` were each ancestors of
published `main`, with no ahead commits. The actual Archon worktree had no tracked
or untracked changes. Unrelated local root worktree changes were preserved;
this comparison did not reset or overwrite them.

### Catalog and live connection

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

## Earlier fixture-native gameplay evidence

These are the five authored test fixtures, not the subsequently downloaded
production-generated class examples.

The first readback contained 21 unique chat messages (13 evaluated rolls). The
second contained 36 unique messages (25 evaluated rolls) and all five actors.
Every evaluated die count, active result, numeric modifier, and roll total was
independently checked against the saved message terms. The private raw receipts
are not published because they contain world document and user identifiers.

| Fixture and workflow                  | Observed native result                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Wizard 5, Fire Bolt                   | `1d20 + 4 + 3` attack = 26; `2d10` fire = 11                                                         |
| Wizard 5, Fireball                    | DC 15 Dexterity card; `8d6` fire = 30, with half-on-save metadata                                    |
| Wizard 5, Magic Missile               | Card shows three darts; observed per-dart `1d4 + 1` force = 5                                        |
| Cleric 5, Cure Wounds                 | Level 1: `2d8 + 4` healing = 12; level 2: `4d8 + 4` = 15                                             |
| Warlock 11, Eldritch Blast            | Card shows three beams; three separate +8 attacks = 11/18/24, each followed by `1d10` force = 6/10/4 |
| Warlock 11, Mystic Arcanum            | Circle of Death: DC 16 Constitution; `8d8` necrotic = 28, with half-on-save metadata                 |
| Warlock 11, Hex                       | Level-5 casting card; one aggregate pact-slot reduction during the warlock sequence                  |
| Monster, Venomous Bite                | +7 attack = 22; separate `2d6 + 4` piercing = 10 and `1d6` poison = 6                                |
| Monster, Venom Burst                  | Description/card DC 15 Constitution; `2d6` poison = 4, with half-on-save metadata                    |
| Monster, standalone Constitution save | `1d20 + 1` = 10; this separate roll has no bound DC or target application                            |
| Sorcerer 5, Fire Bolt                 | +7 attack = 26; `2d10` fire = 11                                                                     |

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

| Actor    | Dexterity save | Applied fire damage | HP before → after |
| -------- | -------------- | ------------------- | ----------------- |
| Monster  | 18             | 15, half            | 500 → 485         |
| Sorcerer | 17             | 15, half            | 100 → 85          |
| Wizard   | 4              | 30, full            | 100 → 70          |
| Cleric   | 3              | 30, full            | 100 → 70          |
| Warlock  | 2              | 30, full            | 100 → 70          |

This establishes native save rolling and operator-selected damage application,
not unattended save adjudication. The saved activity cards still have empty
target arrays; do not infer targeting or hit adjudication from them. Three
applied Magic Missile darts, target healing, rest recovery, Hex effect transfer
and remaining duration, and every other class feature were not established by
these captures. Live inspection found the canonical pact Hex duration remained
one hour. At that earlier fixture stage, a narrowly scoped generator correction
had local regression coverage but no refreshed live proof. The later production
campaign independently verified the 86,400-second duration; curse transfer and
remaining-time preservation remain pending.
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

Cloud Run revision `boss-forge-00031-zxh` initially served 100% of traffic. Its
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
`2026-09-04T15:41:22.533150Z`; revision `boss-forge-00032-67s` subsequently served
100% of traffic with image digest
`sha256:a95d4be2cb6f74360c9027040af6abe7ac4a33743780dca700cc9e8e79c80d6e`.
The exact catalog revision above was reverified on the deployed revision.
Those release checks did not establish that a production-generated actor had
passed its JSON audit, Foundry import, or native activity execution.

### Chronological spell acquisition and complete-response acceptance

[BossForge PR #126](https://github.com/jakemctigue/bossforge.dev/pull/126) merged
as `f98cef4b8fc05177d06d1f49642626f354e6c2be`. It replaces highest-tier stacking
with chronological class-level acquisition and records `class-acquisition-v2`
provenance. The wizard baseline is six level-1 spellbook entries plus two spells
for each subsequent wizard level; additional copied spells are not assumed.
Separately granted/free-use copies do not count toward the base allowance.

The no-replacement, highest-eligible-tier-at-acquisition policy is a generator
baseline, not a restriction imposed by the SRD on legal spell choices, swaps, or
preparation. In accordance with the requested behavior, the generator includes
the class allowance without reducing it to a daily prepared subset. The detailed
policy is published in
[BossForge's spell progression documentation](https://github.com/jakemctigue/bossforge.dev/blob/f98cef4b8fc05177d06d1f49642626f354e6c2be/docs/spellcasting-progression.md).

| Example                  | Base spell count | Spell-level distribution |
| ------------------------ | ---------------: | ------------------------ |
| Wizard 5                 |               14 | 8 / 4 / 2                |
| Bard, Cleric, or Druid 5 |                9 | 5 / 2 / 2                |
| Sorcerer 5               |                9 | 4 / 3 / 2                |
| Paladin or Ranger 5      |                6 | 5 / 1                    |
| Warlock 11               |               11 | 3 / 2 / 2 / 2 / 2        |

These are distinct base spells per spell level, not spell-slot counts. The
immutable 340-spell catalog passed an independent source/hydration audit over
160 supported class/level combinations with three preference cases each:
**480 policy scenarios**. This is not 480 native gameplay tests.

A later custom-warlock export under the preceding release had a correct spell
subsection but malformed non-spell items and output-limit markers. The whole
actor audit failed, and it was not imported or counted as a successful warlock.
Correct spells do not make a partly invalid actor acceptable. No malformed raw
model text is reproduced in this report.

[BossForge PR #128](https://github.com/jakemctigue/bossforge.dev/pull/128) merged
as `845eca5de9823d6c596aa617d3f19d3d5817ff11`. It rejects `MAX_TOKENS` before
reading/repairing the generated JSON, postprocessing, or spell hydration;
validates the NPC and item containers, allowed item types, descriptions, and
bounded names; and retains the existing generation-error/refund flow. It no
longer returns a fabricated fallback actor for an incomplete response. Explicit
structured-output property ordering and type enums were also added. Supported
`anyOf` schemas were retained; the provider's degenerate output was not proven
to have been caused by `anyOf` or by property order.

The PR #128 release verification passed **752 tests** (728 Vitest and 24 Node),
type checking, and independent review. These tests and the separate 480 policy
scenarios do not substitute for the native checks below.

### Complete-response release

The build of commit `845eca5de9823d6c596aa617d3f19d3d5817ff11` completed at
**2026-09-04 16:47:29 UTC**. Cloud Run revision **`boss-forge-00034-fjn`** was
verified serving 100% of traffic with image digest
**`sha256:ac71c2da90daee1421ad0dc2be29c9990794deeecf31d5bfb1f839c835fca07f`**.
It retains catalog revision
`a88a57bc0b1dfdad3548665ab42ad712af7c0c9377ad45e30d180d0a4b072fc8`.

### Current Contact Patron release

[BossForge PR #129](https://github.com/jakemctigue/bossforge.dev/pull/129) merged
as `e30de6212f29db83af181775467abbf560d93836`. Only the canonical free Contact
Patron copy is adapted into a utility activity that automatically succeeds,
without the ordinary Contact Other Plane spell's Intelligence save or failure
damage. The ordinary pact copy remains unchanged, and hydration fails closed if
the pinned canonical activity shape drifts. Verification passed 202 focused
hydration tests, **729 Vitest tests plus 24 Node tests**, type checking, and diff
checks.

Cloud Run revision **`boss-forge-00035-pkb`** was verified serving 100% of
traffic with image digest
**`sha256:e9a18398174a8466178ac23497bbccd55822b0f9bfd68a4c2223945d0e6546e7`**.
It retains the same immutable catalog revision.

Generation start/finish times and serving revisions were not captured for every
download. Earlier production exports and roll messages must not be relabeled as
newly generated by either later release merely because their tests occurred
after deployment.

## Actual production-generated actor campaign

These actors were generated in the production BossForge UI and downloaded using
its Foundry export. They are separate from the five earlier fixtures. Source
audits, import/readback, and native execution are different acceptance checks.
All eight class examples were imported; a fresh valid warlock replaced the
rejected custom export for this campaign, without counting that failure as a pass.

The source/import checks confirmed the catalog and acquisition provenance for
the reviewed examples. Level-5 casters use their class's INT, WIS, or CHA 18,
proficiency +3, spell attack +7, and save DC 15. Full casters have 4/3/2 slot
capacities; paladin/ranger have 4/2, with unsupported higher slots zero. Canonical
spell item artwork references the colorful installed core assets. Canonical
activity-level SVG/null icons are a separate cosmetic detail and were not
silently rewritten. The fresh warlock independently passed its source audit with
11 base spells distributed 3/2/2/2/2, four cantrips, and 18 spell items covering
17 distinct identifiers. It also contains Multiattack, Venom Blade, and Toxic
Burst; it is not spell-only. The raw download's SHA-256 is
`fa64a74710aac5c335221aff765c3196d9e8573822ce5d2da2d13fd02425eb18`.
That source pass and hash are not substitutes for native execution evidence.

### Independently reviewed native receipts through 18:20 UTC

| Production actor              | Verified native workflow                                                                                                                                                                                                                                                                                                                                  | Verified resource/effect change                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wizard 5                      | Fire Bolt attacks `1d20 + 4 + 3` = 11 and 24; normal `2d10` fire = 17. Fireball `8d6` fire = 27; DC 15 Dexterity card, half-on-save metadata.                                                                                                                                                                                                             | Fireball consumed one level-3 slot, leaving 1/2; Fire Bolt cards had no actor resource delta.                                                                                                                                                                                                                                         |
| Bard 5                        | Shatter `3d8` thunder = 14, DC 15 Constitution, half-on-save. Healing Word `2d4 + 4` healing = 9.                                                                                                                                                                                                                                                         | One level-2 and one level-1 slot consumed; final values/capacities 3/4, 2/3, 2/2.                                                                                                                                                                                                                                                     |
| Druid 5                       | Moonbeam `2d10` radiant = 12, DC 15 Constitution, half-on-save.                                                                                                                                                                                                                                                                                           | One level-2 slot consumed, leaving 2/3; concentrating effect with Moonbeam origin and 60-second duration present.                                                                                                                                                                                                                     |
| Ranger 5                      | Free Hunter's Mark activation; rider `1d6` force = 2. Spike Growth `2d4` piercing = 6.                                                                                                                                                                                                                                                                    | Mark spent one of three free uses and no slot; rider consumed no extra use. Growth consumed one level-2 slot, leaving 1/2, and replaced Mark concentration with Growth concentration.                                                                                                                                                 |
| Sorcerer 5                    | One Scorching Ray card produced three +7 attacks = 25, 21, 19, and three separate `2d6` fire damage rolls = 8, 5, 12.                                                                                                                                                                                                                                     | The whole three-ray cast consumed one level-2 slot, leaving 2/3; it did not consume a slot per ray.                                                                                                                                                                                                                                   |
| Paladin 5                     | Free Divine Smite `2d8` radiant = 11; free Find Steed summon activity completed.                                                                                                                                                                                                                                                                          | Each free feature spent its own one-per-long-rest use and no slot. The linked steed's scaling/current-HP limitation is documented below.                                                                                                                                                                                              |
| Cleric 5                      | Spirit Guardians card DC 15 Wisdom and `3d8` radiant = 14, half-on-save; level-2 Cure Wounds `4d8 + 4` healing = 24.                                                                                                                                                                                                                                      | Guardians consumed one level-3 slot while the separate emanation save consumed none; Cure Wounds consumed one level-2 slot.                                                                                                                                                                                                           |
| Fresh Warlock 11, target side | Toxic Burst produced an actual steed Constitution save `1d20 + 2` = 12 against DC 16 and an 11-HP reduction. A 10-foot-radius region has the exact Toxic Burst activity origin.                                                                                                                                                                           | The recipient's Hexed Strength effect is active for 86,400 seconds with Strength-check disadvantage. This target-state capture is paired with the later caster receipt below.                                                                                                                                                         |
| Fresh Warlock 11, caster side | Two Venom Blade attacks were +8 = 26/26; each split `2d6 + 4` piercing = 14 from separate `1d6` poison = 3/4. Toxic Burst was `2d6` poison = 11. Eldritch Blast produced three +8 attacks = 14/14/9 and three separate `1d10` force rolls = 8/5/8. Blight at pact level 5 was `9d8` necrotic = 46, DC 16; Circle of Death was `8d8` necrotic = 33, DC 16. | Hex consumed one pact slot, created 86,400-second caster/recipient effects, and its `1d6` necrotic rider = 5 consumed no resource. Blight consumed one pact slot. Circle of Death spent its own Arcanum use. Short rest restored pact 1/3→3/3 without restoring Arcanum; long rest restored Arcanum 1/1→0/1 while pact remained full. |

The target-side and caster-side rows are chronological evidence slices for the
same production Warlock; the earlier row's pending fields are resolved only to
the extent stated by the later receipt.

The saved, independently reviewed production receipts contain **58 unique
messages / 35 evaluated rolls**. Repeated history in later Warlock snapshots is
counted once.
The roll totals reported above were independently recomputed from the evaluated
terms. The two Wizard attack messages were created at 16:39 and 16:43
UTC, before revision `00034-fjn` was deployed. Other captured workflows occurred
later, but this does not establish the serving revision that generated each actor.

| Sanitized receipt                    | Capture time UTC  | Messages / evaluated rolls | SHA-256                                                            |
| ------------------------------------ | ----------------- | -------------------------- | ------------------------------------------------------------------ |
| Production Wizard, phase 1           | 17:22:26–17:22:27 | 7 / 4                      | `59794528347e27f4d6b6a0f1fca895e55e8f6e87ac50ce1adf543e931794f9d2` |
| Production Bard, phase 1             | 17:23:47–17:23:48 | 4 / 2                      | `b593b59cc04d9f1084346d66f7801232d85103f4e0023690ec3b1391bf70bd13` |
| Production Druid, phase 1            | 17:26:05–17:26:06 | 2 / 1                      | `0eb990519167ca0f90597cdf813ab8f337de5930758d0aef6c134fcbc7af3c70` |
| Production Ranger, phase 1           | 17:31:24–17:31:25 | 5 / 2                      | `f6c1a4e3f9755b83f5e6792cc394d2c88d545c85eee34cc6971c3174b885ead6` |
| Production Paladin, phase 1          | 17:38:53–17:38:54 | 3 / 1                      | `b4ba924a3845a1891237111eceb58673db701630f5cb086814dbe571bd6caa5f` |
| Production Sorcerer, phase 1         | 17:47:32–17:47:33 | 7 / 6                      | `f8f2e77295f33509b7e66e285b5e23de636a33d67e0a082c16cd4e00137d59cc` |
| Production Cleric, phase 1           | 17:57:32–17:57:33 | 5 / 2                      | `5a8b7ad61db796e4cca89bca42fe47a4670fc8974e6f54ed3f6544bbed602007` |
| Placed steed, phase 1                | 17:52:32–17:52:33 | supporting state only      | `8a2bc4b8a8595ab5592b0a35db65d0a5235578622e2114519c0b845ed74d20ef` |
| Placed steed, phase 2                | 17:57:19–17:57:20 | supporting state only      | `4cacad7959e6056b73edd907e01583ad8cecf0cfd6580e3c7d891b41d88be06b` |
| Warlock target side / steed, phase 3 | 18:07:25–18:07:26 | 1 / 1                      | `6a8f0b5539e63c0d5b74fdbeadbf202e81ec8494a21f2bac3c04d2de717977c6` |
| Production Warlock, phase 1          | 18:15:12–18:15:17 | 22 / 16                    | `84af8761f57ba795a1bce6301bd6fb26dafe0000b1e3e48e7240886ffa2a1b5f` |
| Production Warlock, phase 2          | 18:17:13–18:17:15 | 1 new / 0 new              | `459483617f6c5ad42f69511d4d20d428d6b307a41b8bc5233cfcdb55abbf98d3` |
| Production Warlock, phase 3          | 18:20:08–18:20:11 | 1 new / 0 new              | `7e4999d958626c99dbcfd03d1e17aed00d4aa54865bf237c79e53f0e22edd81b` |

The Find Steed readback establishes a narrower limitation. Its token is linked
to the official Celestial base actor and has no actor delta. Four active summon
effects correctly provide proficiency +3, AC +2, two additional Hit Dice, and
maximum HP +20, but the HP effect does not update current HP. The initial summon
therefore appeared at **5/25 HP**, not full health. A later legitimate Cure Wounds
application changed it to 25/25; that healing is not an initialization repair.
No MCP, BossForge, or vendor-source change was made for this behavior, and no
steed attack was rolled.

The Warlock's Multiattack card remained descriptive: it did not automatically
sequence the two Venom Blade attacks. Eldritch Blast damage was manually rolled
for all three beams, including the natural-1 attack; this is not evidence that
all three hit or applied damage. The Toxic Burst region and originating activity
were verified, but automatic area-entry damage was not. Hex's duration and
no-cost rider were verified, but hit triggering, curse transfer, remaining-time
preservation, concentration checks, and target effect state after a rest were
not. Blight and Circle of Death have no target save/HP-application evidence. The
ordinary spell-slot sources correctly remained zero throughout.

### Post-restart Contact Patron UI evidence

After PR #129 reached production, a separate fresh production Warlock export had
SHA-256 `222cda3bf0d5784a5168a4b34a691578582502810d55bbc56a35d80437f1c524`;
the imported payload's separately computed SHA-256 was
`87455690630cfbe0b66548af392191fa85f41ef15d5331cc1804006e8fe28ecb`.
The actor used Charisma 18, spell attack +8, and save DC 16.

In the authenticated owner browser, direct UI observation showed the free Contact
Patron row as a utility activity with no roll, DC, or damage. Native use posted
its automatic-success card, consumed its own one-per-long-rest resource (leaving
0/1), and exposed the normal Refund Resource control. The ordinary pact Contact
Other Plane copy remained distinct:
Intelligence save DC 15, `6d6` psychic failure damage, and configuration to
consume a level-5 pact slot. This final check contributes one chat card and no
evaluated roll,
bringing the combined campaign observation to **59 messages / 35 rolls**.

This last card is direct owner UI evidence, not an MCP JSONL receipt. The
campaign's 32-byte storage key had intentionally been generated only in `/run`
for the disposable session and was not persisted externally. The deliberate VM
stop/start cleared it, so the existing encrypted MCP state could not be reopened
for another readback. The key was never printed, packaged, or derivable from the
pairing state, and no different key was written over the existing data. Earlier
receipt files and their hashes remain valid; only this final observation has the
lower UI-only evidence level.

Raw receipts remain private; this report omits user/world document identifiers
and raw SRD payloads. Other than the specific Warlock target-side and steed
healing evidence above, the other production receipts have no target saves or
applied damage/healing evidence. Moonbeam's recurring area behavior,
Hunter's Mark hit-trigger/transfer behavior, Spike Growth movement triggers,
concentration checks/expiration, and long-rest recovery are not established by
these observations. `runtimeValidated` remains false: specific successful
workflows are not blanket actor or future-generator validation.

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

## Teardown evidence

After the deliberate final restart, the temporary persistent `Config/admin.txt`
file was explicitly removed before its disk was deleted with the test VM. That
Setup credential file was separate from the blank world Gamemaster password.
The Foundry Compose stack was stopped gracefully before infrastructure deletion.
The `foundry-test` GCE instance (ID `7129623805755333028`) and its auto-delete
boot disk were deleted. The two dedicated firewall rules
`foundry-test-iap-ssh` and `foundry-test-web`, subnet
`foundry-test-us-central1`, dedicated VPC (ID `5629033911242135724`), host service
account, and `foundry-test-owner-access` secret were also deleted. Local private
owner and pairing files were removed and verified absent.

A filtered post-delete inventory returned no disposable test resources and only
the reusable `foundry-test-account-bootstrap` secret, intentionally retained.
The immutable Firebase spell catalog was also retained. The existing RackNerd
Foundry server and production BossForge resources were not teardown targets.

The Cloudflare `foundrytest` A record still points to the former ephemeral
address, but there is no longer a test server behind it. Deleting that record is
the sole remaining infrastructure cleanup action and requires the owner's
confirmation at action time.

## Outstanding gates

- Keep the remaining feature limits explicit: Multiattack is descriptive;
  automatic area/target adjudication was not established generally; Hex transfer,
  remaining-duration preservation, concentration checks, and post-rest target
  effect state remain untested; the Contact Patron recovery path was not tested.
  Keep per-export serving-revision uncertainty and the final UI-only evidence
  distinction explicit.
- Retain explicit limits for unexecuted feature/target interactions and the
  linked Find Steed 5/25-current-HP initialization result. Existing MCP does not
  expose an activity-execution tool; the demonstrated rolls used the trusted
  native UI, with MCP used for document operations and evidence readback.
- Delete the stale `foundrytest` DNS A record after the required action-time
  confirmation. Google Cloud teardown is complete; do not delete the retained
  Firebase catalog or `foundry-test-account-bootstrap` secret.

The representative tests above are not a blanket validation pass or a promise
that every future generated actor will be correct.
