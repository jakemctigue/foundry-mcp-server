# Plan: BossForge spellcasting and private Foundry validation

Date: 2026-09-04. Status: proposed; no services provisioned or application fixes implemented.
Requirements: [confirmed intent](../docs/intent/bossforge-foundry-validation.md).
Tasks: [implementation checklist](todo.md).

## Verified repository baseline

GitHub `main` and the clean implementation worktree both resolved to `fa3e2422db900dfcde7bf1fc5386b8f43bc388db` before this documentation change. Their ahead/behind count was `0/0`. There were no open GitHub PRs. The Archon bare cache contained only older branch tips (`7b7d2ca` and `798083b`). The original local checkout's `main` was also old (`798083b`), with unrelated `.gitignore` and `.turbo/` changes preserved.

[CI run 33298368776](https://github.com/jakemctigue/foundry-mcp-server/actions/runs/33298368776) passed for `fa3e2422`. Its Foundry module and Windows broker artifacts were present and unexpired when checked. No GitHub releases were listed. This establishes published source/artifact parity, not installed client versions or a working live Foundry connection.

BossForge was inspected at local `main` commit `da0dbf24d5efdcacb17accc21a437a4a2f40bd7e`; existing local package/configuration changes were not modified. No production bundle or live Foundry instance was inspected in this phase. Source findings below must be reproduced against the chosen live test versions before claiming the reported production symptom is fixed.

## Investigation findings

Paths prefixed `BossForge:` are relative to `C:/Users/Jake/bossforge.dev`; other paths refer to this MCP repository at the baseline above.

| Finding                                   | Evidence                                                                                                                                                                  | Consequence                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Normalization drops casting state         | `BossForge:src/lib/normalizeMonsterActor.ts:38-105` reconstructs `system` without `attributes.spellcasting`, `details.spellLevel`, `details.globalDc`, or `system.spells` | Correct generated/imported casting data can be lost before export                                                                          |
| Item effects and flags are dropped        | Same file, lines 108-114, copies only ID, name, type, image, and system                                                                                                   | Effect references may remain without their effect documents                                                                                |
| Generic icons are explicitly required     | `BossForge:server/routes.ts:567` restricts item artwork to built-in generic SVGs; normalizer line 112 adds `icons/svg/star.svg`                                           | This is a generation policy problem, not just a failed image download                                                                      |
| Fallback automation guesses from prose    | `BossForge:src/types.ts:539-655` chooses save, weapon attack, or utility; rewrites activation and save DCs                                                                | Filling missing fields does not reconstruct canonical spell behavior; existing activity overrides can also be changed                      |
| Export metadata is hard-coded             | `BossForge:src/App.tsx:432-493` labels exports Foundry `13.351` / dnd5e `5.3.3`, clears actor effects, and calls the fallback builder                                     | Version metadata and runtime compatibility need an explicit contract                                                                       |
| MCP is a browser-mediated document bridge | `packages/foundry-module/src/companion-handlers.ts` dispatches document/asset/session methods; `docs/architecture.md` describes the GM browser dependency                 | There is no existing activity-execution tool; an unattended browser session and narrow execution API are needed                            |
| Linux production secrets are unsupported  | `packages/host/src/secrets/storage.ts:86-101` refuses the development fallback in production; `packages/host/src/daemon.ts:80-87` selects this storage                    | Merely containerizing the current host will not produce a secure Linux deployment                                                          |
| Local transport already has protections   | `packages/host/src/bridge/pipe-server.ts` uses HMAC and chmod `0600` on Unix sockets; the CLI uses stdio                                                                  | Preserve these controls; audit parent-directory ownership and Linux identity handling rather than describing the socket as unauthenticated |

Read-only reproduction executed the existing normalizer through the installed TypeScript runtime. Input included casting ability `int`, caster level `5`, global DC `15`, first-level slots `4/4`, item effects, and item flags. Output omitted all six fields, assigned `icons/svg/star.svg`, and synthesized a utility activity. No application files were changed. This proves the normalization defect, not every possible cause of failed spellcasting.

## Proposed architecture

Use one on-demand Linux Compute Engine VM for Foundry, the hardened MCP host/stdio adapter, and an automated GM browser. Keep the active databases on persistent block storage. Begin benchmarking with an `e2-medium` (4 GiB) and approximately 20 GiB total disk, including OS/runtime overhead. Try a smaller VM only after the full browser-plus-Foundry workload passes memory and latency checks.

This is a recommendation, not an already approved deployment choice. Cloud Run can host containers and WebSockets, but an active Foundry world needs durable database semantics and a live browser connection. Google documents missing file locking for Cloud Storage FUSE and time-limited WebSocket requests. Do not mount the live world database on a bucket and assume it behaves like local disk. An alternative Cloud Run design would need an explicit, measured persistence/session solution; it is not ruled out categorically. [Cloud Run storage](https://docs.cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts), [WebSockets](https://docs.cloud.google.com/run/docs/triggering/websockets).

Foundry's dedicated-server minimum is 2 GB RAM, with 4 GB recommended; the browser and MCP require additional headroom. A free-tier-sized VM must not be assumed sufficient. [Foundry requirements](https://foundryvtt.com/article/requirements/).

### Private administration and domain

Lowest-fixed-cost proposal: owner-authenticated IAP TCP forwarding to a TLS proxy on the VM, with `foundrytest.bossforge.dev` resolved locally to the forwarded endpoint. The normal browser can then show Foundry's license/setup interface, but the owner must start the tunnel first. Use a valid certificate for that hostname and correct WebSocket/origin settings. DNS ownership and a narrowly scoped certificate issuance method must be established before implementation.

Do not open Foundry's setup page, MCP socket, or GM session to the internet. Allow inbound administrative traffic only through the approved tunnel. An ephemeral public IP may supply outbound installation access while the VM runs without allowing public inbound traffic. If a normal no-tunnel domain is required, revisit authenticated reverse-proxy options and their costs before provisioning. No changes to `foundry.bossforge.dev` are permitted. [IAP TCP forwarding command](https://docs.cloud.google.com/sdk/gcloud/reference/compute/start-iap-tunnel).

### BossForge interaction

Keep normal generation/export independent of test-server availability. Add an owner-only validation action or CI command that submits a bounded job through an authenticated control channel, starts the VM, and retrieves a durable report. Prefer existing project services for job records; verify actual project access/configuration before choosing them. Do not expose raw MCP as a public unauthenticated endpoint.

The VM runner receives a job and invokes the local MCP adapter. It boots a dedicated test-GM browser, proves the companion handshake, verifies the exact world ID and software versions, imports the actor, executes allowed activities, and records before/after state. A browser-dependent tool cannot be considered ready merely because its TCP port responds.

Extract an approved, versioned spell/icon catalog through Foundry's supported document APIs. Canonical spell items should be selected by stable identity, with controlled adjustments to casting/uses and regenerated embedded IDs/references. The generator chooses spells; it does not invent their schemas. Preserve existing valid activities, effects, and consumption instead of reconstructing them from prose. Artwork selection must use verified installed paths, with provenance and an explicit thematic mapping for custom abilities. Do not put private test-server image URLs into customer exports.

The publicly available system is not equivalent to ownership of all D&D premium content. Review source licenses before redistributing spell text or artwork; prefer approved SRD data and references to installed assets. The Foundry FAQ permits multiple installations under conditions limiting player access; validate the private test use against the current license rather than exposing a second gameplay server. [Foundry FAQ](https://foundryvtt.com/article/faq/).

### Firebase spell catalog: user-selected direction

Use Firebase Cloud Firestore as the persistent canonical spell catalog. The intended flow is:

`Foundry SRD 5.2 compendium -> versioned Firestore catalog -> NPC-specific embedded spell copies -> Foundry regression test`

Verify the installed pack identity and exact SRD patch version before extraction. The existing BossForge prompt explicitly requests SRD 5.1 (`server/routes.ts:551`); change that instruction and its selection tests to SRD 5.2 rather than mixing editions. The system's release history includes SRD 5.2 content, but this does not establish the version installed on the user's server. [Official dnd5e releases](https://github.com/foundryvtt/dnd5e/releases).

Proposed storage layout: `foundrySpellCatalogs/{catalogVersion}/spells/{stableSpellId}`, with an active-catalog pointer separate from immutable imports. Store searchable name, level, school, source UUID, pack ID, SRD version, Foundry/system versions, checksum, provenance, and portable image path. Store the complete serialized Foundry item as an unindexed `payloadJson` string, then parse/validate it on the server. This preserves the original JSON shape without asking Firestore to interpret every deeply nested game-system field. Validate document/field size before upload; Firestore's document ceiling is 1 MiB. Never combine the whole spell catalog in one document. [Firestore limits](https://firebase.google.com/docs/firestore/quotas).

Use a trusted import process with narrowly scoped IAM. Deny direct client catalog writes and keep selection/attachment server-side; Firebase client rules do not constrain Admin SDK access. Import idempotently into a new catalog version, verify record counts/checksums and smoke fixtures, then atomically promote its pointer. Retain the prior version for rollback. Cache immutable records server-side to reduce repeat reads, and measure Firestore usage separately from the VM budget. [Server access and rules](https://firebase.google.com/docs/firestore/manage-data/move-data).

NPC creation selects stable spell IDs from allowed records, deep-copies the chosen payloads, assigns fresh embedded IDs while remapping internal references, and applies only validated NPC-specific casting and usage settings. The shared catalog never stores an NPC's spent slots or mutated effects. Saved actors retain their embedded spell copies and catalog provenance; catalog updates must not silently alter existing NPCs. Creation/export remains available with Foundry shut down because the source objects persist in Firebase.

Keep SRD attribution with the catalog and relevant distribution surfaces. SRD 5.2 is CC BY 4.0, but separately verify licenses for Foundry-specific representation and artwork; the SRD license does not automatically cover every bundled asset. [Official SRD 5.2 legal notice](https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.pdf).

### Class-appropriate spell-loadout minimums

For the Spellcasting NPC option, select an explicit caster class and caster level and apply the corresponding SRD 5.2 class progression. These are not interchangeable with monster CR or hit dice. Persist the selected class/level so the generator, editor, saved actor, and export validator use the same rule inputs.

Build a versioned, tested rules table from the selected SRD class spellcasting progression. Derive separate requirements for cantrips, the class/level usable-spell allotment, maximum accessible spell level, and slot/pact-magic progression. User clarification: do not implement prepared-spell management. If a class table uses a prepared-spell allowance, use that allowance only to determine the number of usable spells to supply; configure every supplied spell to be usable without a separate preparation step. Do not substitute a wizard's total spellbook count for the castable allotment. Preserve slot costs and daily limits rather than making all spells at-will. Include supported class/subclass grants according to their counting rules. Innate-only casting is a separate mode, not an excuse to underfill a requested class caster.

The generator chooses thematic legal spell IDs from Firebase, then a deterministic validator deduplicates and checks the resulting loadout. Fill shortfalls from eligible catalog entries before finalizing; never invent spell data or duplicate a spell to inflate the count. If the approved SRD catalog cannot satisfy a class/subclass requirement, return an explicit unsupported/incomplete result rather than silently substitute another class or claim completeness. Store sufficient class-list eligibility metadata or a separately versioned rules mapping with the catalog.

Acceptance tests must include low and high caster levels, progression boundaries, a wizard usable-allotment case, pact magic where supported, a half-caster, cantrip counts, duplicate selections, illegal spell levels, and a deliberately insufficient catalog. Every supplied spell must be available without owner preparation while still consuming its expected resource. Exact counts are derived from the pinned source, not a universal hard-coded minimum or spell-slot totals. Existing saved NPCs are not silently rewritten by this new creation requirement. [SRD 5.2 class rules](https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.pdf).

### Casting ability, attack bonus, and save DC

Assign the class-appropriate ability key to `system.attributes.spellcasting` and retain that ability score through every transformation. Baseline calculations are ability modifier `floor((score - 10) / 2)`, spell attack bonus `ability modifier + effective proficiency bonus`, and spell save DC `8 + ability modifier + effective proficiency bonus`. Resolve proficiency from the actual supported NPC actor configuration (normally CR-derived), not by silently treating caster level as NPC proficiency level. Class/level controls the spell loadout; the actor's effective proficiency controls its base attack/DC calculations. Apply legitimate explicit bonuses once, if supported.

Use the installed dnd5e spellcasting calculation modes so canonical attack/save activities resolve the actor's ability and effective proficiency. Do not relabel spell attacks as Strength-based weapon attacks. Scope the current generic global-DC override carefully: it must not replace ability-derived spell DCs or erase a canonical calculation mode. Preserve intentionally custom non-spell ability DCs separately. Update spellcasting trait text from the same computed values so sheet data, descriptions, and executed rolls agree.

Test several classes, odd/even ability scores, proficiency/CR boundaries, and caster levels that differ from monster CR. Assert save/reload/export preservation, an actual spell attack roll's modifier, and an actual save spell's DC after import. Changing the casting ability score must update the relevant modifier/DC without double-counting proficiency or leaving stale custom formulas. Include a regression specifically covering `ensureFoundryAutomationData` and its current global-DC rewriting behavior.

### Safety and lifecycle implementation

- One active test run at a time. Keep a clean, versioned world template; create/reset disposable worlds only while Foundry is stopped, within a validated test-world directory.
- Add only a narrow, schema-validated activity-use capability. Require the test-world allowlist, authenticated GM, mutation permission, bounded timeout, and audit IDs. Never add arbitrary JavaScript execution or broad filesystem deletion.
- Provide a supported Linux secret backend, using narrowly scoped Secret Manager access or protected injected secrets. Keep `NODE_ENV=production`; do not enable the development fallback to get past startup errors.
- Use short-lived workload credentials, separate control-plane/runtime privileges, log redaction, and capped report retention. No license keys or content archives in GitHub artifacts.
- Shutdown sequence: finish/fail job, save report, close browser, stop Foundry cleanly, then stop VM. Preserve disk and setup state. Add an independent timeout watchdog so runner failures cannot leave the VM running indefinitely.
- Stopped VMs stop accruing normal compute charges, but disk and other retained resources still cost money. Prefer stop over suspend and avoid retaining an unnecessary static external IP. [VM lifecycle](https://docs.cloud.google.com/compute/docs/instances/stop-start-instance).

## Indicative cost, not a quote

USD list-price baseline, Iowa/us-central1, checked 2026-09-04; no committed-use discounts or free-tier credits assumed. Confirm region/SKUs and runtime measurements before provisioning.

| Component                       | Budget calculation                    |
| ------------------------------- | ------------------------------------- |
| e2-medium while running         | About $0.03351/hour                   |
| External IPv4 while running     | About $0.005/hour                     |
| 20 GiB standard persistent disk | About $0.80/month, even while stopped |
| 10 runtime hours/month          | About $1.19/month subtotal            |
| 40 runtime hours/month          | About $2.34/month subtotal            |
| Accidental 730-hour operation   | About $28.91/month subtotal           |

Formula: `0.80 + hours * (0.03350571 + 0.005)`. Subtotals exclude traffic, report/snapshot storage, secret operations, logging, DNS/certificate infrastructure, existing BossForge costs, and any additional control-plane service. Free quotas are shared and not guaranteed. Small standard disks may have poor database I/O; benchmark and reprice balanced disk if needed. Avoid always-on load balancers, NAT gateways, or Filestore unless measurements establish a need. A budget alert is not a spending cap.

Sources: [VM pricing](https://cloud.google.com/products/compute/pricing/general-purpose), [IPv4 pricing](https://cloud.google.com/vpc/network-pricing), [block storage pricing](https://cloud.google.com/products/block-storage?hl=en).

## Acceptance and test strategy

Pin a mutually supported Foundry version, dnd5e version, and rules/content version before fixtures are built. BossForge currently exports 13.351/5.3.3 metadata while the published MCP artifact is labeled v14; do not assume compatibility or silently upgrade the RackNerd server.

Use canonical fixtures covering a cantrip attack, save/damage spell, healing, prepared slots, upcasting, innate daily uses, concentration/effects, a weapon attack, recharge, and bonus/reaction/legendary actions. Execute the installed system's actual activity API and inspect its hooks, rolls, chat outputs, and state transitions. Handle target selection/dialogs deterministically. A chat card alone is not a successful spell test. [dnd5e activities](https://github.com/foundryvtt/dnd5e/wiki/Activities), [activity hooks](https://github.com/foundryvtt/dnd5e/wiki/Hooks).

Every supported fixture must import without schema errors; resolve all artwork and embedded references; preserve casting data; perform expected rolls; and consume the expected slots/charges exactly once. Test retry idempotency, reconnects, invalid world IDs, unauthorized callers, resource exhaustion, and process crashes. Distinguish automatic behavior from actions requiring GM adjudication in the base system. Additional modules such as MIDI-QOL are not an implicit requirement.

Run fast unit/contract tests on code changes. Run real Foundry regressions for relevant generator/export/MCP changes and pinned-version upgrades, not for every customer download. Retain a compact report identifying both repository SHAs, artifact digest, Foundry/system versions, fixture identity, and observed results.

## Publication, rollback, and review gates

Each implementation slice uses a short-lived `codex/` branch and PR. Fetch GitHub before branching; inspect Archon refs and dirty worktrees; do not mistake the local `origin` cache for GitHub. Run relevant tests, lint/typecheck/build, and inspect CI before merging. Never bypass a failing check merely to troubleshoot access.

After merge, build/install the exact merged GitHub SHA and record its artifact digest. Confirm runtime version and an authenticated MCP handshake; for execution changes, also pass the real disposable-world regression. Experimental PR builds may be used in the private lab, but are labeled unpublished until merged. Recheck that no intended completed changes remain only in Archon. Preserve uncommitted user edits and identify them explicitly rather than publishing them without review.

Release BossForge changes separately behind a controlled rollout. Preserve billing, owner verification, and export entitlements. Roll back code and catalog together to their last known-good versions. Do not make production service availability depend on the lab.

Before implementation, review the proposed VM architecture, tunnel-based domain access, and cost assumptions. Before deployment, verify Google project/billing/IAM, DNS ownership, Foundry license access, compatible versions, and the desired supported fixture corpus. These are explicit gates, not permission to guess credentials or modify the live server.
