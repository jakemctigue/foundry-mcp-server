# Reusable Foundry test-server runbook

Use this runbook to create a short-lived BossForge validation environment at
`foundrytest.bossforge.dev`. It records the working Foundry 14, D&D 5E, private
MCP, catalog, gameplay-test, restart, and teardown sequence. It does not change
the production RackNerd server at `foundry.bossforge.dev`.
The checked-in [host contract](../README.md),
[private MCP installer](private-mcp-provisioning.md), and
[private integration notes](private-integration-notes.md) remain authoritative
for exact security checks and commands. The
[dated verification report](deployment-verification.md) is evidence from one
completed campaign, not a template to edit for each new VM.

## Identities and credential boundaries

Use the following names consistently. Never put a credential value, license,
pairing code, cookie, or MCP storage key in Git, an image, instance metadata,
shell history, logs, screenshots, or a command-line argument.

| Purpose                              | Stable identity or field                            | Password or secret behavior                                                                                                                   |
| ------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundry account download             | Secret JSON field `foundry_username`                | Its companion field is `foundry_password`; the actual account username and password exist only in Secret Manager and the runtime secret file. |
| Public test-site gate                | Username **`owner`**                                | `owner_password` is unique, nonblank, and used only by Caddy.                                                                                 |
| Foundry Setup administration         | No username; secret field `foundry_admin_key`       | This protects `/setup` after activation. It is not a world-user password.                                                                     |
| Disposable world                     | Existing user **`Gamemaster`**, role **Gamemaster** | Leave its password **blank**, then choose **Save and Continue**.                                                                              |
| Private MCP operating-system account | **`foundry-mcp`**                                   | Non-login, unprivileged service account; no reusable login password.                                                                          |
| MCP pairing                          | Client-scoped pairing value                         | Transfer once through the owner-only channel, then delete the temporary plaintext file.                                                       |
| MCP encrypted state                  | Exactly 32 raw random bytes                         | Rehydrate the same storage key after a restart; a replacement key cannot decrypt the existing state.                                          |

The blank `Gamemaster` password is intentional for this disposable, owner-only
world. It is safe only because the public Caddy gate remains active, Foundry
itself is bound to VM loopback, and the private browser tunnels are owner-only.
Do not blank `owner_password` or confuse the world user with Foundry's separate
Setup administrator key.

## 1. Pin the campaign inputs

Before creating cloud resources, record these reviewed inputs in the campaign
notes:

- Google Cloud project `bossforgedev`, region `us-central1`, and zone
  `us-central1-a`.
- A full, published GitHub commit from `foundry-mcp-server/main`. Verify that no
  local or Archon worktree is ahead before building the host and companion.
- Foundry image `ghcr.io/felddy/foundryvtt:14.367.0` and Caddy
  `2.11.4-alpine`, using the immutable digests in `compose.yaml`.
- Foundry 14 Build 367 and D&D 5E system 5.3.3.
- World name `BossForge Disposable Validation` and data path
  `bossforge-validation`.
- A short maximum run duration with automatic **STOP** as a cost guard. A stopped
  VM still has a billed disk and is not teardown.
  The previously validated low-cost shape was an `e2-small` VM with a 20 GB
  standard disposable boot disk. Measure the next workload before downsizing: the
  Foundry container, build, and browser session can overlap.

## 2. Prepare Secret Manager without copying values

Keep the reusable account credential in this pinned secret version:

```text
projects/bossforgedev/secrets/foundry-test-account-bootstrap/versions/1
```

Its payload must be one JSON object with exactly these nonempty string fields:

```json
{
  "foundry_username": "REDACTED_IN_DOCUMENTATION",
  "foundry_password": "REDACTED_IN_DOCUMENTATION"
}
```

Create a campaign-specific `foundry-test-owner-access` secret with exactly:

```json
{
  "foundry_admin_key": "REDACTED_IN_DOCUMENTATION",
  "owner_password": "REDACTED_IN_DOCUMENTATION"
}
```

The bootstrap rejects reused passwords. `owner_password` must be 20–72 UTF-8
bytes for the reviewed bcrypt path, and `foundry_admin_key` must be at least 20
characters. Give the dedicated VM service account access only to the exact
secret versions it needs. Attach the `cloud-platform` access scope so IAM can
authorize the Secret Manager API call. `bootstrap.sh` obtains a short-lived token
from the VM metadata service, checks the secret version's CRC32C, and constructs
the runtime files in `/run`; it never needs a service-account key file.
Create a campaign-specific restricted Secret Manager secret containing exactly
32 raw random bytes for the MCP storage key. Hydrate those same bytes into the
protected `/run/foundry-mcp-credentials` location at every boot. Keep this key
separate from the account and owner-access JSON, and grant the VM service account
access only to the pinned campaign version.
Do not create a new key after a restart and write it over existing encrypted MCP
state. Either restore the original key or begin with a new, explicitly clean
disposable MCP data directory.

## 3. Create the disposable cloud boundary

Create only these dedicated resources, using the campaign's current reviewed
infrastructure workflow:

- VPC `foundry-test` and subnet `foundry-test-us-central1`.
- VM service account
  `foundry-test-host@bossforgedev.iam.gserviceaccount.com`.
- VM `foundry-test`, Ubuntu 24.04, disposable auto-delete boot disk, and no
  production disk or network attachment.
- Firewall rule `foundry-test-web` allowing public TCP 80/443 only.
- Firewall rule `foundry-test-iap-ssh` allowing SSH only from Google's IAP TCP
  forwarding range. Do not expose TCP 22 generally.
  The VM needs outbound HTTPS for Foundry download, license verification, D&D 5E
  installation, image pulls, and Secret Manager. It must not have public ingress on
  30000, 32145, browser debugging ports, MCP, or an adapter socket.
  Create a DNS-only Cloudflare A record for `foundrytest.bossforge.dev` pointing to
  the current ephemeral VM address. Do not create a test AAAA record. Verify the
  exact test name before every change and never edit `foundry.bossforge.dev`.
  Because the address can change after a stop/start, update and reverify the A
  record before resuming public tests.

## 4. Bootstrap the Foundry and Caddy containers

Copy the reviewed `bootstrap.sh`, `compose.yaml`, and `Caddyfile` to the approved
Ubuntu VM. Run the bootstrap as root from the deployed bundle:

```sh
sudo bash /opt/foundry-test/bootstrap.sh
```

The script installs Docker Engine and Compose, prepares the bind directories,
pulls the digest-pinned images, hydrates runtime secrets, hashes the owner
password through stdin, validates Caddy, and proves `/`, `/setup`, `/join`, and
`/socket.io/` return 401 before starting Foundry. It then starts Foundry with the
only host binding at `127.0.0.1:30000`.
Before opening Setup, verify all of the following:

- Trusted HTTPS works at `https://foundrytest.bossforge.dev`.
- Every route and websocket handshake asks for Caddy user `owner`.
- An authenticated request reaches Foundry and Caddy removes the Authorization
  header before proxying.
- External TCP 22, 30000, and 32145 are closed; only 80/443 are public.
- Compose reports the pinned Foundry and Caddy images, not moving tags.

## 5. Activate Foundry and create the blank-password world

Open the public URL and sign in to the Caddy gate as `owner`. The container uses
the Secret Manager account fields to download Foundry and select an available
license. Do not place account credentials into a Dockerfile or environment
variable.
When the Foundry license agreement is visibly displayed, stop and obtain the
owner's explicit confirmation for that displayed agreement. Only then choose
**AGREE**. This runbook records authorization procedure; it is not standing
permission to accept a future or changed agreement.
Use `foundry_admin_key` when Foundry requests the Setup administrator password.
Then:

1. Open **Game Systems → Install System**.
2. Install the released D&D 5E 5.3.3 manifest:
   ```text
   https://github.com/foundryvtt/dnd5e/releases/download/release-5.3.3/system.json
   ```
3. Verify the installed ID/version is `dnd5e` / `5.3.3`. Do not use **Update
   All** during the campaign.
4. Create **BossForge Disposable Validation** with data path
   `bossforge-validation`. Select the D&D 5E system tile before continuing.
5. On **User Management**, keep the existing user named **Gamemaster**, select
   the **Gamemaster** role, leave its password fields empty, and choose **Save and
   Continue**.
6. Launch the world and verify the top-level UI identifies the user as
   **Gamemaster [GM]**.
   `Config/admin.txt` stores the Setup administrator credential; world user data
   stores the blank Gamemaster password. They are independent. Do not delete or
   blank the Setup file while the live campaign still needs `/setup` access.

## 6. Install and pair the private MCP path

Build and seal the exact published MCP commit on Linux with Node 22 and pnpm
9.15.0, then follow the inspection and apply gates in
[private-mcp-provisioning.md](private-mcp-provisioning.md). Install the companion
while Foundry is stopped. The provisioner creates the non-login `foundry-mcp`
account and a stopped, disabled systemd service; it does not start the host or
open a port.

Restart Foundry after the companion files are installed and wait for the world
to become available:

```sh
cd /opt/foundry-test
sudo docker compose up -d foundry
```

Hydrate the chosen storage key to:

```text
/run/foundry-mcp-credentials/storage-key
```

It must be exactly 32 raw bytes, owned by `foundry-mcp`, mode `0400` or `0600`,
with protected nonsymlink parent directories. Run the Linux pairing helper as
that account and send its one-time output file through the owner-only channel.
For an owner browser on another machine, establish authenticated IAP/SSH forwards
bound only to owner loopback:

| Owner machine     | Test VM           | Purpose                     |
| ----------------- | ----------------- | --------------------------- |
| `127.0.0.1:39000` | `127.0.0.1:30000` | Foundry GM page             |
| `127.0.0.1:32145` | `127.0.0.1:32145` | Private companion websocket |

Open `http://127.0.0.1:39000`, select the blank-password **Gamemaster** user,
enable **Foundry MCP Companion**, set its endpoint to
`ws://127.0.0.1:32145`, and enter the pairing value.

Start the deliberately disabled host only after key injection and pairing
readiness, verify that it is active and listening only on VM loopback, then
reload the GM world:

```sh
sudo systemctl start foundry-mcp-host.service
```

After the companion reports a live connection, delete the temporary plaintext
pairing-code file.

The trusted VM-local runner launches `node packages/mcp-adapter/dist/cli.js` as
`foundry-mcp`, from the sealed release, with the same storage-key file and
`XDG_DATA_HOME` values. Follow the exact environment and stdio invocation in
[private-integration-notes.md](private-integration-notes.md); the adapter is not
a TCP service.

Keep the host listener on VM `127.0.0.1:32145`. The MCP adapter uses stdio and a
mode-`0600` Unix socket inside the private application directory. Do not add a
Caddy MCP route, public websocket, public HTTP/SSE service, remote-debugging
port, or frontend-embedded credential. BossForge may communicate only through a
private authenticated server-side runner.

## 7. Export and persist the canonical spell catalog

Discover the live connection and verify Foundry 14.367, world
`bossforge-validation`, GM role, D&D system 5.3.3, and enabled companion. Then:

1. List compendia and require pack `dnd5e.spells24`.
2. Read documents with `hydrate: true`, stable ID sorting, and cursor pagination.
3. Expect 340 spell documents. Exclude the separate Magical Berries consumable.
4. Validate system version/provenance, canonical activities/effects, source
   hashes, descriptions, class lists, and relative artwork references before any
   write.
5. Import an immutable, versioned revision into Firestore/Firebase and perform a
   full readback/integrity reconstruction.
6. Configure BossForge with that exact `FOUNDRY_SPELL_CATALOG_REVISION`; do not
   depend on a mutable active pointer or the temporary VM.
   Retain the immutable catalog during teardown. It may store canonical document
   data and installed relative artwork references, but never copy the licensed
   Foundry distribution or account credentials into Firebase.

## 8. Validate generated actors in native Foundry

Source/schema audits and successful imports are necessary but are not gameplay
tests. Generate and import separate examples for Wizard, Bard, Cleric, Druid,
Sorcerer, Warlock, Ranger, and Paladin. For every actor, verify:

- Minimum spell acquisition follows that class's chronological level progression
  without replacement; spell levels are not filled from only the highest tier.
- Spellcasting ability, proficiency, attack modifier, save DC, slot capacities,
  pact/arcanum or free-use resources, and rest recovery are internally consistent.
- Canonical spell items use the installed colorful Foundry/D&D artwork paths.
- Attacks roll the described number and size of dice, including multiple attacks
  or beams where applicable.
- Damage components remain separated when the ability describes distinct damage
  types, rather than collapsing them into one roll/type.
- Activity DC, ability, damage, save behavior, half/no-damage result, duration,
  concentration, effects, targets/regions, and resource consumption match the
  actor description and VTT automation data.
- At least one real target save and HP/effect application is observed for target
  workflows; chat-card creation alone is insufficient.
  Use normal Foundry activity controls in the trusted GM UI when MCP has no narrow
  execution tool. Capture only sanitized receipts and independently recompute roll
  totals from evaluated dice terms. Record untested behavior and known limitations;
  representative passes do not prove every ability or future actor is correct.
  After application fixes merge, generate a fresh production export from the newly
  deployed BossForge revision. Do not relabel an older export or earlier messages
  as evidence for a later release.

## 9. Restart and recovery rule

The Compose data bind persists while the disposable disk exists, but `/run` is
tmpfs. After a VM restart:

1. With the Compose stack stopped, re-run the reviewed Foundry bootstrap. It
   recreates `foundry-runtime.json` and `owner-auth.caddy` from Secret Manager,
   validates Caddy, and starts the Foundry and Caddy containers; do not start the
   stack separately first.
2. Rehydrate the **same** MCP storage key before starting the host and adapter.
3. Re-establish both owner-loopback tunnels and reopen the authenticated GM page.
4. Confirm the world, system, companion, host connection, and gateway again.
   If the persisted MCP storage key is unavailable or corrupt, the prior encrypted
   state is unrecoverable. Do not guess, derive it from pairing, or overwrite the
   data with a replacement key. Finish any safe native-UI checks, or start a
   deliberately new MCP state and pair it as a new campaign.

## 10. Preserve results, then tear down

Before deletion, preserve only:

- The verified immutable Firebase catalog and revision identifier.
- Sanitized test receipts, hashes, source commits, image digests, and explicit
  limitations.
- The reusable `foundry-test-account-bootstrap` secret for future test-server
  launches.
- Merged application/MCP source and documentation through reviewed PRs.
  Then stop in this order: owner browser, adapter, MCP host, Foundry, and the Compose
  stack. Verify the exact resource names and delete only the disposable targets:
- Cloudflare A record `foundrytest.bossforge.dev`.
- VM `foundry-test` and its auto-delete boot disk.
- Firewall rules `foundry-test-iap-ssh` and `foundry-test-web`.
- Subnet `foundry-test-us-central1`, VPC `foundry-test`, and the dedicated VM
  service account.
- Campaign-specific `foundry-test-owner-access` and MCP storage-key secrets.
- Local private owner, pairing, tunnel, and temporary credential files.
  Confirm with a filtered cloud inventory and DNS lookup that nothing disposable
  remains. Do not delete the retained account-bootstrap secret, Firebase catalog,
  production BossForge resources, or anything on the RackNerd Foundry server.

## Fast repeat checklist

- [ ] Pin published MCP commit, image digests, versions, world name, and run limit.
- [ ] Verify reusable account-bootstrap JSON; create temporary owner-access JSON.
- [ ] Decide whether the MCP storage key must survive a VM restart.
- [ ] Create dedicated VPC, subnet, service account, firewalls, VM, and DNS-only A
      record.
- [ ] Run `bootstrap.sh`; verify HTTPS owner gate and closed private ports.
- [ ] Obtain confirmation on the displayed license agreement, then accept it.
- [ ] Install D&D 5E 5.3.3 and create the blank-password `Gamemaster` world.
- [ ] Install the exact published MCP build, hydrate key, tunnel, and pair.
- [ ] Export/validate 340 spells; persist and read back the immutable catalog.
- [ ] Generate fresh actors and execute the eight-class native test matrix.
- [ ] Merge fixes through PRs, redeploy when runtime code changes, and retest fresh
      outputs.
- [ ] Preserve sanitized evidence and the catalog; stop and delete every temporary
      cloud/DNS/private-file resource.
