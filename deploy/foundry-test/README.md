# Disposable Foundry validation host

This Linux Docker Compose bundle exposes **only the owner-protected Foundry UI**
at `https://foundrytest.bossforge.dev`. It does not deploy MCP, a browser worker,
Firebase, Cloud Run, DNS, or cloud firewall rules. Those are separate integration
steps. It must not change the existing `foundry.bossforge.dev` RackNerd server.

The Foundry container and a future local validation browser need more resources
than a bare server; measure the actual workload before selecting the smallest VM.
Keep data only for the test campaign. After successful validation and verified
Firebase catalog persistence, delete the disposable VM and its test disk.

## Boundaries and pinned versions

| Boundary                          | Enforcement                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Internet to Foundry               | Caddy HTTPS and an owner-only password on every page and websocket handshake                     |
| Internet to MCP                   | No MCP service, route, socket, or published port in this bundle                                  |
| VM-local GM browser to Foundry    | HTTP on `127.0.0.1:30000` only; trusted host processes bypass the public password gate           |
| Gateway password to Foundry       | Authorization header removed before proxying                                                     |
| Download credentials to container | Separate runtime file mounted at `/run/secrets/config.json`; no credential environment variables |
| Container restart to test data    | Stable container hostname and test-only `/data` bind mount, with configuration preservation      |

Image versions are `ghcr.io/felddy/foundryvtt:14.367.0` (Foundry 14.367, Node 24)
and `caddy:2.11.4-alpine`. These are exact released tags, not immutable digest
pins. Review image scan results and record pulled digests before deployment;
updates require review. The target D&D system release is **5.3.3**. Do not silently
substitute a development branch or migrate production worlds into this host.

## Bootstrap gates

`bootstrap.sh` performs the local installation, runtime-secret hydration, and
gateway-first startup below without operator-supplied secret command arguments.
Upload it together with the reviewed `compose.yaml` and `Caddyfile`, then run it
as root on the approved Ubuntu 24.04 test VM. It installs Ubuntu's `docker.io`
and `docker-compose-v2` packages and copies the configuration to
`/opt/foundry-test`. The VM identity needs the `cloud-platform` access scope and
Secret Manager accessor permission on **only these two secrets** in `bossforgedev`:

- `foundry-test-account-bootstrap/versions/1`: JSON fields `foundry_username` and
  `foundry_password`.
- `foundry-test-owner-access/versions/1`: JSON fields `foundry_admin_key` and
  `owner_password`. These must be different from each other and the account
  password; use at least 20 characters and at most 72 UTF-8 bytes for the gateway
  password. The gateway login username is `owner`.

```sh
sudo bash /opt/foundry-test/bootstrap.sh
```

The script uses the VM metadata token only in memory, verifies the secret payload
checksums, generates the Caddy hash through stdin, and writes only the protected
runtime files. It suppresses secret/error details and prints container status,
not logs. It validates Caddy and requires trusted HTTPS to return 401 before it
starts Foundry. Configure DNS, firewall, and secret permissions first; if these
checks fail, Foundry remains stopped. A rerun gracefully stops this test stack
before refreshing the runtime files. No other stack or cloud resource is changed.
The following list documents the deployment contract and manual recovery gates;
it is not a requirement to repeat the automated file preparation.

1. Use a dedicated Linux host with Docker Engine and Compose. Keep public ingress
   to TCP 80 and 443 only; use the separately approved private admin-access path.
   Deny all other public ingress, including port 30000, MCP and browser-debugging ports.
   Do not depend on UFW alone to restrict Docker-published ports. Point only
   `foundrytest.bossforge.dev` to this host, including checking for stale AAAA records.
2. Prepare `/var/lib/foundry-test/data`, owned by UID/GID `1000:1000`, mode `0700`.
   The felddy image runs as the non-root `node` user and cannot fix ownership.
   Prepare `/var/lib/foundry-test/caddy-data` and `caddy-config`, owned by root,
   mode `0700`. These directories are on the disposable test disk, not a permanent
   shared disk. Missing bind directories deliberately cause startup to fail.
3. The authorized Foundry account username/password are cached in **Google Secret
   Manager**, not in this checkout. A separately reviewed host bootstrap step
   reads the named secret using least-privilege VM identity and constructs
   `/run/foundry-test/foundry-runtime.json` without printing its contents. Verify
   `/run` is tmpfs; use a root-owned `0700` directory and a `1000:1000`, `0400` file.
   JSON keys are `foundry_username`, `foundry_password`, and `foundry_admin_key`.
   The admin key must be a separate strong password, not the account password.
   Never use command-line password arguments, shell tracing, a Dockerfile,
   environment variables, or repository files to supply these values.
4. Supply `/run/foundry-test/owner-auth.caddy`, root-owned mode `0400`, containing
   exactly one line: an owner username, one space, and a bcrypt password hash.
   Generate the hash using Caddy's interactive `hash-password` command and store
   it via the approved secret workflow. Use a unique high-entropy gateway password.
   Do not reuse the Foundry account or GM password. No example working password is
   included. A missing file makes Caddy fail closed; an empty or malformed file
   must be rejected during validation. Local Compose secrets are read-only file
   bind mounts, **not** encrypted Swarm secrets, so host file permissions matter.
5. Account authentication in felddy **automatically selects and installs a license**;
   if several licenses exist it can select one randomly. The owner has authorized
   this behavior for this private test instance. This bundle does **not** accept
   the Foundry EULA. The owner has explicitly authorized agent-assisted acceptance
   and setup through the protected UI. Confirm the intended license, accept the
   displayed agreement, create the disposable world, secure its GM account, and
   install D&D 5E. Keep access owner-only; do not invite players to this backend.

Never set `CONTAINER_VERBOSE`, even to `false`: parts of the upstream startup code
test whether it exists. Do not enable proxy credential logging or print expanded
secret contents. Once the initial download is cached, a controlled secret refresh
can omit `foundry_username` and `foundry_password` from the runtime JSON while
retaining the admin key; the account credentials can remain in Secret Manager.
Recreate the container to replace an existing bind-mounted secret. No need to
download the distribution repeatedly. Do not store the licensed distribution in
GitHub, a public image, or the Firebase spell catalog.

## Validate, then start

Run from this directory after the bootstrap gates above. Node is used only for
the static test; Docker must have the Compose plugin. The test parses Compose but
does not start a server or inspect real secrets.

```sh
node --test security.test.mjs
docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml pull
docker compose -f compose.yaml run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose -f compose.yaml up --detach caddy
```

Before starting Foundry, confirm HTTPS presents a trusted certificate and an
unauthenticated request to `/`, `/setup`, `/join`, and `/socket.io/` returns 401.
An authenticated request may return 502 while Foundry is intentionally not started.
Verify the owner hash file is exactly the one-line format above, not a Caddy snippet
containing routes. The only direct Foundry binding must be `127.0.0.1:30000`;
never `0.0.0.0`, an external address, or an IPv6 wildcard. Then:

```sh
docker compose -f compose.yaml up --detach foundry
docker compose -f compose.yaml ps
```

Open the HTTPS address in an ordinary browser, authenticate through the gateway,
and complete the Foundry setup. A container health indicator alone does not prove
that license, game system, world, or websocket authentication works. Test the UI
and live gateway after every relevant configuration change. Verify from an
external network that non-HTTP(S) ports are closed. This bundle has no automatic
startup after a host reboot: rehydrate the ephemeral runtime secret files and
repeat the gates before starting it again.

Do not add public healthcheck exemptions or MCP reverse-proxy routes. Standard
Caddy basic authentication does not supply application-level rate limiting or
MFA; keep this short-lived, use a strong unique password, and add a reviewed
owner-IP restriction or identity-aware gateway if required. The minimal CSP
protects against framing without inventing a policy that breaks Foundry modules.

## Integration and completion

For the authorized first-run UI setup, follow the actual controls displayed by
Foundry rather than inventing setup HTTP payloads. After license/EULA activation,
unlock Setup with the separate Foundry administrator password. Choose **Game
Systems > Install System**, paste this version-specific manifest, and install:

```text
https://github.com/foundryvtt/dnd5e/releases/download/release-5.3.3/system.json
```

Verify the installed system is `dnd5e` version `5.3.3` (the released manifest is
verified for Foundry 14). Do not use Update All during the validation campaign:
the installed manifest's update pointer targets the moving `master` branch.
From **Game Worlds > Create World**, create a new disposable world with a simple
hyphenated data path and choose Dungeons & Dragons Fifth Edition as its system.
Launch the world and select the initial Gamemaster. A new world's default GM has
no password; leave the field empty for this first login, then immediately use
**Game Settings > User Management** to assign a unique GM password and save.
That world password is distinct from the gateway and Setup administrator passwords.
No premium adventure/world package is required for the system's SRD compendia.
These UI instructions follow the official knowledge base; exact button placement
must be checked against the running 14.367 interface.

The eventual GM browser worker runs on the host and uses `http://127.0.0.1:30000`
so its private loopback MCP websocket is not blocked as mixed content from a
public HTTPS origin. Its debugging interface and MCP listeners must remain
host-local. The host itself is a trust boundary: do not permit untrusted shell
users or containers to access the Foundry bridge or loopback binding. This bundle
deliberately does not guess the MCP/browser startup or pairing contracts. BossForge should
call an authenticated private server-side integration, never public MCP sockets
or a secret embedded in frontend JavaScript.

Export canonical spell documents from the installed `dnd5e.spells24` compendium
and persist verified, versioned objects in Firebase before removing the test
host. Store artwork references, not a copy of the licensed Foundry distribution.
Complete live spell/actor execution checks, capture sanitized results, and ship
the generator fixes. Finishing a few tests does not establish that all future
inputs are perfect; retain automated regression tests in the application.

For a temporary pause, preserve test data and stop cleanly:

```sh
docker compose -f compose.yaml stop --timeout 60
```

When validation, Firebase persistence, and delivery are verified, stop the
containers and let the approved cloud teardown delete **only** the identified
disposable host, its test disk, and its dedicated temporary network/DNS resources.
Confirm resource identities and delete or release leftover billed resources.
Do not touch RackNerd or production BossForge/Firebase. No destructive teardown
command is included here: cloud resource IDs must first be verified. Test-world
data and the cached Foundry archive will be unrecoverable after disk deletion;
preserve only the approved non-secret results beforehand. Keep the authorized
account credential cache in Secret Manager unless the owner requests its removal.

## Source contracts

- [felddy released configuration and secrets](https://github.com/felddy/foundryvtt-docker/blob/v14.367.0/README.md)
- [Released startup and automatic licensing](https://github.com/felddy/foundryvtt-docker/blob/v14.367.0/src/entrypoint.sh)
- [Released Node 24 image](https://github.com/felddy/foundryvtt-docker/blob/v14.367.0/Dockerfile)
- [Foundry 14.367 container release](https://github.com/felddy/foundryvtt-docker/releases/tag/v14.367.0)
- [Caddy 2.11.4 release](https://github.com/caddyserver/caddy/releases/tag/v2.11.4)
- [Caddy password authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth)
- [Caddy required-file imports](https://caddyserver.com/docs/caddyfile/directives/import)
- [Docker Compose secret mounts](https://docs.docker.com/compose/how-tos/use-secrets/)
- [Ubuntu 24.04 Docker Engine package](https://packages.ubuntu.com/noble/docker.io)
- [Ubuntu 24.04 Compose package](https://packages.ubuntu.com/noble/docker-compose-v2)
- [GCE metadata access tokens](https://docs.cloud.google.com/compute/docs/access/authenticate-workloads)
- [Secret Manager version access](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets.versions/access)
- [Caddy stdin password hashing](https://caddyserver.com/docs/command-line#caddy-hash-password)
- [Official Foundry activation flow](https://foundryvtt.com/article/installation/)
- [Official system/world setup tutorial](https://foundryvtt.com/article/tutorial/)
- [World-specific user management](https://foundryvtt.com/article/users/)
- [D&D 5E 5.3.3 release and pinned manifest](https://github.com/foundryvtt/dnd5e/releases/tag/release-5.3.3)
