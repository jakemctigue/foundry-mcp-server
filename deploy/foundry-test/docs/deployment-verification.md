# Disposable host verification — 2026-09-04

This is a dated deployment snapshot, not ongoing monitoring or gameplay validation.
The owner authorized this on-demand Google VM, the public test hostname, runtime
credential retrieval from Secret Manager, and acceptance of the displayed Foundry
license agreement. The existing RackNerd server and production BossForge service
were not changed.

## Verified runtime

- Project `bossforgedev` (number `278230599227`), zone `us-central1-a`.
- Disposable `foundry-test` VM, instance ID `7129623805755333028`, Ubuntu 24.04,
  e2-small, 20 GB disposable standard boot disk, four-hour maximum run duration
  with stop action. A stopped VM still retains its billed disk; it is not teardown.
- Dedicated VPC/subnet and service account. Secret accessor grants are limited to
  the two pinned Foundry bootstrap/owner secret versions documented in the README.
- Only TCP 80/443 public. SSH is restricted to IAP. External checks could not
  connect to TCP 22, 30000, or 32145. No MCP host is running in this snapshot.
- Cloudflare `foundrytest` A record points to the test VM, DNS-only; no test AAAA
  record. `foundry.bossforge.dev` was not edited.
- Caddy obtained a trusted public certificate. Foundry listens on host loopback
  `127.0.0.1:30000`; only Caddy publishes public ports. Caddy administration is off.
- Foundry 14 Build 367 container healthy; license agreement accepted after the
  owner's confirmation. Setup administrator login succeeded through private IAP.
- Official Dungeons & Dragons Fifth Edition system **5.3.3** installed using its
  release manifest. No moving-branch update or premium package was installed.
- World **BossForge Disposable Validation**, data path `bossforge-validation`,
  created and opened User Management. Owner GM-password setup was pending at this
  snapshot; a launched authenticated GM session is not yet demonstrated here.

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
frame, WebSocket upgrade, or full GM-session check. Those remain integration
gates. `probe-setup.py` separately reports only loopback form/route metadata.

Offline checks: eight Compose/security assertions and seven owner-probe tests
passed locally. CI runs both suites. The probes are read-only; they do not accept
agreements, create accounts/worlds, or install packages.

## Outstanding gates

- Record image vulnerability scan results and triage before final host release.
- Finish secured GM login and world launch.
- Install/pair the reviewed private MCP host and companion, then test its actual
  authenticated document tools. Existing MCP does not execute D&D activities.
- Export and persist the canonical SRD catalog; hydrate fresh generated actors;
  execute their actual spell/attack/damage/save workflows and preserve evidence.
- Ship verified generator fixes and then stop/delete the disposable resources.
  No runtime validation or completed teardown is claimed by this host snapshot.
