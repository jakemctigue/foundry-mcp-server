# Implementation checklist

Status: not started. See [plan](plan.md). Each task is a separate reviewable slice; split further if it exceeds five files. Proposed new paths are illustrative, not existing code claims. All MCP code changes go through PRs and verified merges to GitHub `main`.

## 1. Establish compatibility and deployment contract

- [ ] Record supported Foundry/dnd5e/rules versions, licensed content scope, and test-world identity.
- [ ] Obtain approval for VM/tunnel architecture and budget; verify project/DNS access without changing production.
- Verification: review manifests and official compatibility docs; owner reviews recorded decisions.
- Dependencies: none. Scope: small, 1-2 files.
- Likely files: `tasks/plan.md`, `docs/validation-compatibility.md` (new).

## 2. Preserve BossForge casting data

- [ ] Add failing regression tests for dropped casting ability, caster level, DC, slots, effects, and flags; fix normalization using supported typed fields.
- [ ] Keep valid activities and embedded effect references intact across normalization.
- Verification: focused normalizer tests, `npm run lint`, `npm test`, `npm run build` in BossForge.
- Dependencies: 1. Scope: medium, 3 files.
- Likely files: BossForge `src/lib/normalizeMonsterActor.ts`, `src/types.ts`, a focused normalizer test.

## Checkpoint A

- [ ] Review compatibility decisions and regression evidence; no cloud resources created yet.

## 3. Support production Linux secrets

- [ ] Implement protected secret injection/backend with narrow IAM and no development fallback.
- [ ] Preserve Windows DPAPI behavior; test missing/denied secrets and log redaction.
- Verification: host secret tests, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`; PR CI including Linux coverage.
- Dependencies: 1. Scope: medium, up to 5 files.
- Likely files: host `secrets/storage.ts`, `daemon.ts`, a new backend, focused tests, CI workflow.

## 4. Prove Linux bridge startup

- [ ] Verify Unix socket ownership/permissions and authenticated stdio-to-host negotiation under the production service identity.
- [ ] Confirm an unauthorized local identity and bad HMAC cannot issue requests.
- Verification: isolated Linux integration tests and unchanged Windows CI; merge access fixes through a PR.
- Dependencies: 3. Scope: medium, up to 4 files.
- Likely files: host `bridge/pipe-server.ts`, `bridge/acl.ts`, Linux integration tests, deployment smoke script (new).

## 5. Provision the private test host after approval

- [ ] Define VM, small persistent disk, scoped identity, private ingress, and owner domain/tunnel setup as reproducible configuration.
- [ ] Owner can install license and dnd5e; stop/start preserves setup. RackNerd/DNS production records remain unchanged.
- Verification: infrastructure plan review, private-access denial test, owner setup walkthrough, stop/start test, cost estimate.
- Dependencies: 1, 4. Scope: medium, up to 5 new deployment/runbook files.
- Likely files: `deploy/gcp/` infrastructure definitions, service configuration, and `docs/gcp-test-host.md`.

## Checkpoint B

- [ ] Real GM browser connects through the companion to the published MCP build; record exact versions and artifacts before adding execution tools.

## 6. Add bounded activity execution

- [ ] Implement a narrowly typed activity-use request/result with test-world allowlist, mutation authorization, timeout, and audit ID.
- [ ] Reject arbitrary code, foreign worlds, unauthorized users, and duplicate mutating retries.
- Verification: protocol/security tests and one real canonical spell execution; `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.
- Dependencies: 5. Scope: medium, up to 5 files; split adapter exposure into a follow-up PR if required.
- Likely files: protocol execution contract (new), companion execution handler (new), companion dispatcher, host routing/policy, focused tests.

## 7. Expose and exercise the MCP tool

- [ ] Add adapter tool schemas and an unattended authenticated GM browser smoke runner.
- [ ] Prove the tool invokes the real activity and reports observed rolls and resource changes, not just a chat card.
- Verification: adapter contract tests, published-build handshake, live test-world cantrip and slot-spell cases.
- Dependencies: 6. Scope: medium, up to 5 files.
- Likely files: adapter execution tool (new), adapter server registration, browser smoke runner (new), tests, tools reference.

## Checkpoint C

- [ ] Merge verified MCP PRs; install merged artifacts, prove runtime SHA and one end-to-end spell. Stop if compatibility remains unresolved.

## 8. Extract the SRD 5.2 spell and icon catalog

- [ ] Read SRD 5.2 canonical items through supported Foundry APIs; verify exact pack/patch version and retain source identity, effects, and actual installed image paths.
- [ ] Validate portable asset references and distribution rights; exclude unauthorized premium data.
- Verification: fixture snapshots, missing-asset checks, deterministic catalog build, licensing review.
- Dependencies: 5. Scope: medium, up to 4 new extractor/catalog/test files.
- Likely files: `scripts/export-dnd5e-catalog.*`, catalog schema, tests, content provenance manifest.

## 8b. Persist canonical spells in Firebase

- [ ] Import one complete serialized item per Firestore document with searchable metadata, immutable catalog versions, checksums, and attribution; enforce payload size limits.
- [ ] Restrict writes to the trusted importer, test idempotency/partial failures, and promote the active version only after validation; retain rollback data.
- Verification: Firestore emulator import/read/authorization tests, JSON round-trip equivalence, payload/index-size checks, and cold-read availability with Foundry stopped.
- Dependencies: 8. Scope: medium, up to 5 files.
- Likely files: BossForge catalog repository (new), import script (new), Firestore rule/index configuration, focused tests.

## Checkpoint: Catalog persistence

- [ ] SRD 5.2 content and portable icons round-trip through Firebase without changing the canonical item payload; ordinary clients cannot modify the catalog.

## 9. Use canonical Firebase spell records in BossForge

- [ ] Replace invented SRD 5.1 spell payloads with selected SRD 5.2 Firebase records, safely remapping IDs/references and configuring casting resources on independent NPC copies.
- [ ] Preserve activity activation/DC semantics; reject unsupported or unresolved selections explicitly.
- Verification: canonical spell contract tests plus BossForge lint/test/build; live attack/save/heal/innate/upcast cases.
- Dependencies: 2, 7, 8b. Scope: medium, up to 5 files.
- Likely files: BossForge `server/routes.ts`, spell resolver (new), `src/types.ts`, focused tests, catalog integration.

## 10. Assign artwork and correct export serialization

- [ ] Replace SVG-only prompt policy with deterministic verified thematic mappings and canonical spell images.
- [ ] Preserve actor/item effects, use accurate version metadata, and test exact exported JSON through import and reload.
- Verification: export unit tests, installed icon resolution, visual review in Foundry, BossForge lint/test/build.
- Dependencies: 8, 9. Scope: medium, up to 5 files.
- Likely files: BossForge `server/routes.ts`, `src/App.tsx`, icon resolver (new), export helper (new), focused tests.

## 10b. Enforce minimum class spell loadouts

- [ ] Derive minimum cantrip and usable-spell allotments, legal spell levels, and resource progression from versioned SRD 5.2 class rules using explicit caster class and level, not CR. No prepared-spell management or separate spellbook requirement.
- [ ] Fill missing legal spells from Firebase and make every supplied spell usable without owner preparation, preserving slot/daily costs. Duplicates cannot inflate counts; fail clearly if approved content is insufficient.
- [ ] Preserve selected class/level and catalog provenance through creation/save/export without silently changing existing actors.
- Verification: table-driven class/level-boundary tests, wizard usable-allotment case, pact/half-caster cases, insufficient-catalog test, and live casting without preparation while resources are consumed; BossForge lint/test/build.
- Dependencies: 9. Scope: medium, up to 5 files.
- Likely files: BossForge class progression table (new), loadout validator (new), `server/routes.ts`, caster metadata types, focused tests.

## 10c. Set and preserve spellcasting ability and derived values

- [ ] Assign the class-appropriate casting ability; derive modifier, spell attack bonus, and save DC from its score and the NPC's effective proficiency, without conflating caster level with CR.
- [ ] Preserve canonical spell calculation modes through normalization/save/export and isolate non-spell global/custom DC overrides. Spellcasting trait text matches actual values.
- Verification: class/ability-score/proficiency-boundary tests, caster-level-vs-CR case, changed-score recalculation, and actual Foundry attack modifier/save DC assertions; BossForge lint/test/build.
- Dependencies: 2, 9. Scope: medium, up to 5 files.
- Likely files: BossForge `server/routes.ts`, `src/types.ts`, `src/lib/normalizeMonsterActor.ts`, casting helper (new), focused tests.

## Checkpoint D: Caster completeness

- [ ] Review a representative exported caster, class spell-count minimums, and custom abilities in real Foundry. Confirm no billing/export-access changes.

## 11. Add disposable-world regression lifecycle

- [ ] Implement stopped-world reset with exact path/world guards and a single-run lock.
- [ ] Run the agreed fixture corpus with deterministic targets and bounded dialogs; report unsupported/manual behavior separately.
- Verification: full runtime corpus, cross-run contamination test, crash/reconnect/duplicate-request tests, cleanup-boundary tests.
- Dependencies: 7, 10, 10b, 10c. Scope: medium, up to 5 new runner/fixture/test files; split corpus expansion into additional small PRs.
- Likely files: `tests/live/` runner, lifecycle helper, fixture definitions, report schema, lifecycle tests.

## 12. Connect an owner-only BossForge validation job

- [ ] Authenticate job submission server-side, start the test backend with narrow permissions, and display a durable versioned report.
- [ ] Keep normal generation/download independent of the backend; reject other users and arbitrary world/command inputs.
- Verification: owner/unauthorized integration tests, cold-start end-to-end job, lab-offline customer-export test, BossForge lint/test/build.
- Dependencies: 11. Scope: medium, up to 5 files.
- Likely files: BossForge validation route (new), job service (new), server route registration, owner UI component (new), tests.

## 13. Enforce shutdown and retention

- [ ] Save reports before clean shutdown; add an independent runtime watchdog and bounded artifact/log retention.
- [ ] Recover from runner death without indefinite compute usage; measure actual memory, disk, and billable runtime.
- Verification: kill-runner exercise, timeout stop, persistence restart, least-privilege denial tests, updated cost estimate.
- Dependencies: 5, 12. Scope: medium, up to 4 lifecycle/deployment/test files.
- Likely files: VM lifecycle controller, watchdog definition, report retention configuration, failure tests.

## Checkpoint E / release gate

- [ ] Relevant tests, lint, typecheck, build, CI, and real Foundry regressions pass for merged GitHub SHAs.
- [ ] Published source, packaged artifacts, installed runtime, and catalog versions are recorded; no completed fixes exist only in Archon.
- [ ] Document install/update/rollback for Claude Code, Codex, Cursor, and the cloud runner using the final transport, without claiming current stdio clients already support a remote URL.
- [ ] Owner verifies `foundrytest.bossforge.dev`, retained setup, costs, and complete actor behavior. Existing RackNerd Foundry and normal customer exports remain unaffected.
- [ ] Review controlled BossForge rollout and rollback before changing production.
