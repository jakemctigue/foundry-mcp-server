# Restricted D&D activity execution contract — proposal

Status: **for owner/root review; not implemented or enabled**. This extends the
[private integration plan](private-integration-notes.md), not the public network
surface. Target only Foundry 14.367 with D&D 5E 5.3.3 and the reviewed companion.
No tool below exists yet. A license/setup page or successful actor import is not
evidence that these execution semantics have passed in a real world.

## Verified upstream constraints

The pinned D&D implementation has public `activity.use(usage, dialog, message)`,
`activity.rollAttack(config, dialog, message)` for attacks, and
`activity.rollDamage(config, dialog, message)`. Saving throws use the target
actor's `rollSavingThrow`, not an invented `activity.rollSave` method.

Important distinctions from the 5.3.3 source:

- `use()` rejects unembedded/compendium/unowned/unusable Items, clones the Item,
  configures/scales the activity, consumes resources, handles concentration,
  creates the usage message, and finalizes usage. It does not atomically commit
  those effects. Hooks may stop the process, including after consumption.
- `use()` starts subsequent attack/damage actions without awaiting their result.
  Therefore `await use()` is not evidence that dice rolled successfully.
- `dialog.configure: false` suppresses configuration UI; `message.create: false`
  suppresses a chat message, not resource/effect changes. Neither means dry-run.
- Explicit roll methods must be awaited. Missing/empty/canceled rolls are not
  success. A damage roll does not apply damage to a target's HP.
- `message.system.activity` resolves the live source activity, not the scaled,
  consumed clone used by native chat actions. Native chat handling reconstructs
  a clone with scaling and consumed-resource flags. Naively using that getter
  for the next roll can lose upcasting or mishandle ammunition consumption.

Sources: pinned [activity implementation](https://github.com/foundryvtt/dnd5e/blob/release-5.3.3/module/documents/activity/mixin.mjs),
[configuration/result types](https://github.com/foundryvtt/dnd5e/blob/release-5.3.3/module/documents/activity/_types.mjs),
[attack activity](https://github.com/foundryvtt/dnd5e/blob/release-5.3.3/module/documents/activity/attack.mjs),
[save activity](https://github.com/foundryvtt/dnd5e/blob/release-5.3.3/module/documents/activity/save.mjs),
and [chat association lookup](https://github.com/foundryvtt/dnd5e/blob/release-5.3.3/module/documents/chat-message.mjs).
Generic Foundry documentation is not a substitute for these pinned system APIs.

## Proposed scope and authority

Add one mutation capability, `dnd5e:execute`, and advertise a versioned
`dnd5e.execution` capability only when supported. Existing `documents:create` and
`documents:update` grants do not imply execution permission. Keep the current
central mutation authorization/audit path; direct bridge dispatch is denied.

Both host and companion must independently verify, immediately before dispatch:

1. The connection's authenticated role/current user is the explicitly enrolled GM;
   never trust a role, world name, or authorization flag supplied in tool arguments.
2. An owner-provisioned host campaign record allowlists the exact world ID, GM user
   ID, system version, companion revision, and test-run ID. It is disabled by
   default and cannot be created or changed through MCP. A world-name prefix or
   client-controlled `isDisposable` flag is not authorization.
3. Actors, embedded Items, targets, and any consumption-linked documents belong to
   the campaign's host-registered fixture set in that world. Reject compendium,
   cross-world, unregistered, or unresolved references. Fixture flags alone are
   not sufficient because generic document tools can write flags.
4. Only the reviewed active modules are enabled; fail closed on an unexpected
   module/version, activity type, custom execution hook, or unsupported mechanic.
   A finite built-in method allowlist is required; never use caller-controlled
   property lookup, JavaScript, macros, arbitrary formulas, URLs, or class objects.
5. Current actor/item source hashes match the caller's expected hashes before a
   new execution claim. Serialize execution per test world because resources,
   targets, chat, and concentration can involve more than one document.

The owner-provisioned campaign also sets an expiry, a finite execution budget,
maximum pending jobs, and a bounded per-operation deadline within the existing
five-minute bridge ceiling. Count each newly claimed intent against that budget;
replaying its saved result does not execute again. Refuse additional work at a
limit rather than letting model-supplied requests create an unbounded test loop.

Owner controls remain outside the web client. No public sockets, job endpoint,
capability-grant tool, or browser-debugging route is introduced by this proposal.

## Proposed tool interfaces

`foundry.dnd5e.activities.execute` uses this strict, bounded input shape. These
types specify domain intent; they are not arbitrary arguments forwarded to D&D.

```ts
interface ActivityExecutionInput {
  connectionId: string;
  testRunId: string;
  idempotencyKey: string; // 1–128 safe characters; stable for one intent
  actorUuid: string; // a registered root Actor in this world
  itemId: string; // an embedded Item on that actor
  activityId: string; // an activity on that Item
  expectedActorHash: string;
  expectedItemHash: string;
  action: "activate" | "attackRoll" | "damageRoll" | "savingThrow";
  activationExecutionId?: string; // server-recorded prior activation context
  spellSlot?:
    | "pact"
    | "spell1"
    | "spell2"
    | "spell3"
    | "spell4"
    | "spell5"
    | "spell6"
    | "spell7"
    | "spell8"
    | "spell9";
  targetActorUuid?: string; // required only for a saving throw
  saveAbility?: "str" | "dex" | "con" | "int" | "wis" | "cha";
}
```

Unknown keys are rejected. Bound all IDs/UUIDs to the existing protocol's limits;
do not accept whole actor data, arbitrary usage/message options, consumption
overrides, `evaluate:false`, or a caller-selected method name. Save ability must
be allowed by the actual activity; multiple choices require an explicit selection.
The target DC is derived from the prepared activity, never supplied by the caller.
Slot selection is checked against the actual actor's slot data and casting method.
Input `spellSlot` is a symbolic key because 5.3.3 implementation uses keys such as
`spell1`/`pact`, despite an imprecise numeric annotation in its type comments.

The first slice should allow only reviewed attack/save/damage activity types.
Add healing/utility/summoning/transform/enchant and other special workflows only
after their public APIs and additional effects are reviewed. Unsupported cases
return `UNSUPPORTED_TYPE` before resource consumption; they are reported as
coverage gaps, never passed tests.

For `activate`, internally force `subsequentActions:false`, suppress only the
configuration dialog, and retain normal resource-consumption semantics. Refuse
unsupported placement/selection requirements instead of silently suppressing a
mechanic and calling the whole ability functional. Existing concentration must
belong to the fixture set; replacing it is a recorded effect, not invisible cleanup.

For follow-up rolls, bind `activationExecutionId` to the same run, actor, item,
activity and immutable activation parameters. Before supporting upcasts or ammo,
prove context reconstruction with public `Item.clone` and `createConsumedFlag`
matches native chat behavior, including scaling and already-consumed resources.
Do not invoke private chat handlers or blindly reuse `message.system.activity`.
Until that parity gate passes, reject affected workflows rather than invent a
fallback. A standalone roll can be an explicit mechanics test but must be labeled
as such; it is not evidence of casting/resource consumption.

Every action, including rolls which write messages/flags or consume ammunition,
is treated as a mutation. Use the pinned public roll methods with evaluated,
no-dialog behavior; private roll display is chosen by the implementation, not
the caller. Damage rolling does not claim HP/effect application. Those require
separate verified public-API steps and result fields before end-to-end claims.

`foundry.dnd5e.activities.execution.get` is a read-only lookup by
`{connectionId, testRunId, idempotencyKey}`. It uses the same campaign/GM boundary
and never triggers, retries, resumes, refunds, or deletes an operation.

## Durable idempotency and unknown outcomes

Do not equate correlation/request IDs with intent IDs. The existing companion
response cache is bounded to 500 request IDs; it is not durable per-intent
idempotency across arbitrary client retries and host/browser restarts.

Use a host SQLite journal with a unique key on `(testRunId, idempotencyKey)` and a
canonical hash of the validated input excluding attempt-specific deadlines and
transport IDs. Claim it atomically before sending a mutation to Foundry. Persist
its operation ID and state before dispatch. Retain terminal records/tombstones
for the complete test campaign and any allowed job replay period; no eviction
while a job can be redelivered. A closed campaign rejects new executions/replays
that would require missing state. A full journal fails closed, not by eviction.

```text
CLAIMED -> DISPATCHED -> COMPLETED
   |           +-----> FAILED_WITH_EVIDENCE
   |           +-----> INDETERMINATE
   +-----------------> CANCELLED_BEFORE_DISPATCH
```

- Same key/different canonical input: `CONFLICT`, no dispatch.
- Same key/terminal record: return the stored result/error, not a fresh roll.
- Same key/in flight: `CONFLICT` with pending operation ID; poll the read-only
  lookup. A timed-out lease never gives another worker permission to execute it.
- Lost response, browser/host restart, late completion, or timeout after dispatch:
  `INDETERMINATE_MUTATION`, `retryable:false`, with known side-effect evidence.
  Keep accepting a late result into the journal, but do not dispatch again.
- `use()` returning void or a hook canceling does not prove no changes occurred.
  Compare before/after state and messages; do not classify it as safe-to-retry.
- An AbortSignal does not undo Foundry's awaited calls. A cancellation stops future
  steps where possible, retains the world lock until the actual execution settles,
  and reports unknown if outcome is uncertain. Preserve execution options through
  `module-entry` into the handler; do not drop deadline/commit callbacks.
- Do not promise exactly-once effects across the SQLite/Foundry boundary. A crash
  can leave an unknown outcome. Reconciliation is owner-controlled and evidence-
  based; never automatically refund resources, delete messages, or recast.

Before each actual public method invocation, persist a browser-side dispatch
receipt tied to the stable operation ID; register this method in the companion's
mutation/cancellation machinery. Host state alone must never authorize blind
redelivery after an acknowledged dispatch. Require durable local receipt writes
to succeed before executing. Both journals record sanitized outcomes, not secrets.

## Typed evidence, not a blanket success boolean

Use the existing MCP text summary plus `structuredContent` and existing error
envelope. Proposed execution results include:

```ts
interface ActivityExecutionEvidence {
  executionId: string;
  testRunId: string;
  state:
    | "COMPLETED"
    | "FAILED_WITH_EVIDENCE"
    | "INDETERMINATE"
    | "CANCELLED_BEFORE_DISPATCH"
    | "PENDING";
  scope: "ACTIVATION" | "ROLL_MECHANICS" | "ACTIVATION_FOLLOWUP";
  source: {
    worldId: string;
    actorUuid: string;
    itemUuid: string;
    activityId: string;
    foundryVersion: string;
    systemVersion: string;
  };
  observed: {
    spellcastingAbility?: string;
    abilityModifier?: number;
    proficiencyBonus?: number;
    attackBonus?: number;
    saveDC?: number;
    saveAbility?: string;
  };
  rolls: Array<{
    kind: "attack" | "damage" | "save";
    formula: string;
    total: number;
    damageType?: string;
    dice: Array<{
      count: number;
      faces: number;
      results: Array<{ value: number; active: boolean }>;
    }>;
  }>;
  resources: Array<{
    documentUuid: string;
    path: string;
    before: number | null;
    after: number | null;
    delta: number | null;
  }>;
  createdMessageUuids: string[];
  createdEffectUuids: string[];
  removedEffectUuids: string[];
  createdTemplateUuids: string[];
  beforeHashes: Record<string, string>;
  afterHashes: Record<string, string>;
  warnings: string[];
  reconciliationRequired: boolean;
}
```

Read formulas, evaluated terms/results, type selections, prepared DCs and resources
from actual system results/documents. Preserve each damage roll/type separately;
do not collapse mixed damage into one formula or confuse discarded dice with active
dice. Serialize only allowlisted fields, with bounded strings/arrays/depth and a
256 KiB result ceiling. Exceeding limits after dispatch is a partial-evidence
failure, not successful full validation and not permission to reroll.

Use fixed safe resource paths derived from the supported system schema (slots,
uses, ammunition/quantity, and supported actor resources), not arbitrary paths
from the caller. Capture extra affected document IDs even when a numerical delta
cannot be represented. Keep chat HTML, cookies, pairing values, account details,
and raw errors/stacks out of results and logs.

The runner compares evidence with the canonical spell/monster description and
expected fixture. `COMPLETED` means this action completed, not that every ability,
target interaction, HP change, or all future generated actors have been validated.

## Implementation/release gates after approval

1. Add strict protocol schemas, capability/version advertisement, host policy and
   durable journal migration, then adapter/browser registrations. Exercise denied
   cases before implementing side effects; no transport/authentication bypass.
2. Add public-API runtime tests for no-dialog use/roll completion, cancellation
   after consumption, mixed damage, computed/fixed DC, invalid targets, and hooks.
3. Test duplicate concurrent requests, different-input key reuse, response loss,
   process/browser restart, journal failure, late results, and cache exhaustion.
   Assert no automatic second cast/roll and no automatic resource refund.
4. In the licensed disposable world, compare native UI with the tool for base and
   upcast spells, slot/pact consumption, limited uses, ammunition, concentration,
   attack/save/damage outcomes, and then any separately supported activity types.
   Never call unsupported work a passing test. Keep screenshots/traces secret-free.
5. Run Linux/Windows protocol, host, adapter and companion tests and full CI; deploy
   only the reviewed merged revision. This proposal does not authorize enabling it.
