# Intent: BossForge Foundry validation backend

Status: user-confirmed requirements; implementation architecture awaits review.
Recorded: 2026-09-04.

## Outcome

BossForge.dev must export complete D&D 5E Foundry actors whose spells and supported abilities actually work. Ability icons should be flavorful, colorful artwork already included with the installed Foundry/D&D 5E content, not generic system SVGs or newly generated artwork.

## Confirmed requirements

- Build a private development and regression-testing backend, not a public gameplay service.
- Provide an internet-accessible HTTPS Foundry interface at `foundrytest.bossforge.dev` so the owner can enter the license, create a Game Master account, and install the D&D 5E system from a normal browser without a tunnel or VPN. Protect setup and administration with owner authentication; internet-accessible does not mean anonymous administration.
- Never expose MCP sockets to the internet, even behind authentication. Keep the MCP adapter, host bridge, and companion connection local/private and separate from Foundry's public browser traffic.
- Leave `foundry.bossforge.dev` and its existing RackNerd instance untouched.
- Let BossForge retrieve approved spell data and validate generated actors through Foundry MCP.
- Use Foundry's SRD 5.2 spell items as the source for persistent Firebase spell objects. When creating a spellcasting NPC, copy the selected canonical spells onto its sheet instead of generating their mechanics from scratch. Record the exact installed SRD patch and system version; do not silently substitute SRD 5.1.
- A requested spellcasting NPC must have at least the class- and level-appropriate minimum number of usable spells. Count cantrips separately and respect legal spell levels and class lists. Do not add prepared-spell management or require the owner to prepare a subset: every supplied spell must be usable from the NPC sheet, subject to slots or daily-use limits. Use class progression to determine the usable-spell allotment, not slot totals or a wizard's entire spellbook. Treat this as BossForge's product requirement rather than a claim that all published NPC statblocks follow player-character class progression.
- Every generated caster must have the class-appropriate spellcasting ability and consistent ability modifier, spell attack bonus, and spell save DC. Validate the values that Foundry actually uses, not only displayed prose, and preserve them through save/reload/export.
- Execute spells and abilities in a disposable test world. JSON/schema checks alone are insufficient.
- Check actor completeness, real rolls, resource consumption, and supported ability behavior.
- Monster attacks must roll the intended number and size of dice, with the correct modifiers and attack count. Preserve separate damage components when an ability appropriately deals multiple damage types; do not flatten them into one type or invent arbitrary mixed damage.
- Each ability's executed save DC and save ability must match its intended description and VTT automation data. Clean up supported actions, riders, targeting, effects, and resource behavior to match that intent, rather than merely changing the description to agree with faulty automation.
- Use initial testing to correct the generator, then retain regression tests for relevant code or system updates. Normal customer exports must not permanently depend on a live test server.
- Validation findings must become lasting BossForge source-code fixes with regression tests. Recreate fresh monsters using the corrected generator, validate their untouched exports in Foundry, publish the verified changes, then shut down the Foundry test server while preserving its configuration and the Firebase spell catalog. Hand-repaired test actors do not establish completion.
- Prefer the lowest practical Google Cloud cost. Cloud Run was the initial preference; other Google services are permitted when more suitable and economical.
- Permit stopping the backend between runs and waiting for startup. Preserve license, installed system, and test configuration across stops.
- Keep stored content small: the D&D 5E system, required runtime components, and disposable fixtures; no campaign library.

## Publication and troubleshooting policy

- GitHub `jakemctigue/foundry-mcp-server` is the published source of truth.
- Use pull requests for MCP changes, including access troubleshooting. Merge verified changes into `main` when needed; do not deploy unpublished Archon-only fixes.
- Compare GitHub refs, local worktrees, and the Archon bare cache before selecting a source tree. A branch name or apparent local `main` is not proof of freshness.
- Report source commit, artifact commit, and running commit separately. CI success does not establish real Foundry compatibility.
- Preserve unrelated local changes; never overwrite the user's dirty checkout to make it appear synchronized.

## Boundaries

No promise that a finite test suite proves all future generated actors correct. Define supported behavior, maintain representative regression fixtures, and report unsupported/manual behavior explicitly. Installing licensed content does not automatically authorize its redistribution through BossForge; use approved content and portable artwork references.

This phase authorizes investigation, planning, and publication checks. Cloud provisioning, DNS changes, production changes, and implementation of the proposed architecture remain a subsequent phase after plan review.

See [implementation plan](../../tasks/plan.md) and [task checklist](../../tasks/todo.md).
