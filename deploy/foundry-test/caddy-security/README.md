# Caddy 2.11.4: bounded Go-runtime security rebuild

This is a **candidate build recipe**, not a deployment change. No image has been built or deployed by the local static checks. The GitHub candidate workflow is the separate build-and-scan evidence gate; inspect its actual run result before claiming a successful build. Static tests cannot prove a Docker build, a clean vulnerability scan, or live Foundry compatibility.

## Scope and evidence

The scanned official `caddy:2.11.4-alpine` digest contains Go 1.26.3. **CVE-2026-56862** affects TLS processing before HTTP authentication and is fixed in Go 1.26.6 on this branch. The reviewed official builder below contains Go 1.26.8 and xcaddy 0.4.5. Rebuilding the same Caddy release addresses that compiler/runtime mismatch without adding plugins. [Official Go advisory](https://pkg.go.dev/vuln/GO-2026-6090).

| Input | Immutable image digest | Linux amd64 child manifest |
| --- | --- | --- |
| `caddy:2.11.4-builder-alpine` (Go 1.26.8) | `sha256:1a1689db91cfb390b2d856a1b3774e796852822cd723fa54c475b272f82bb4b7` | `sha256:8c78bf0a666541cd56e36ea40d02f1c84847a2b4fd490f600aa38f7221d73c67` |
| `caddy:2.11.4-alpine` runtime filesystem | `sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648` | `sha256:98eb57d882ccd5213d1688764db10c1ca2c58a1ca3a6717a3411ad798f7a423a` |

Builder configuration and both manifests were reviewed on 2026-09-04. `GOTOOLCHAIN=local` plus an exact `go env GOVERSION` check prevents silently downloading a different compiler. The recipe pins Caddy `v2.11.4`, uses the public Go checksum database, compares the old/new registered module lists, and records actual Go build information and module versions. The runtime inherits the original image's command, volumes, ports, and user; only its Caddy executable and non-secret build evidence are copied in.

The build follows [Caddy's official multi-stage pattern](https://caddyserver.com/docs/build#docker) and [xcaddy 0.4.5's explicit-version syntax](https://github.com/caddyserver/xcaddy/blob/v0.4.5/README.md#custom-builds). There are no `--with`, `--replace`, or extra imports in this first slice. Ordinary Go dependencies are not Caddy plugins; using `--with` for them can add inappropriate blank imports. A later dependency patch must review exact replacement versions and their resolved module graph separately.

## Remaining security work — not vulnerability-free

The baseline scan reported 59 package/advisory matches (1 critical, 22 high, 21 medium, 12 low, 3 unknown), with duplicates across packages and aliases. This Go-only rebuild is **not vulnerability-free** and does not upgrade Alpine packages or deliberately change Caddy's module dependency versions. Preserve the full final scan; do not suppress findings to make a release appear clean.

Baseline module fixes still requiring a separately reviewed dependency slice include `golang.org/x/crypto v0.52.0 -> v0.55.0` (SSH-specific CVE-2026-56854), `x/net v0.55.0 -> v0.56.0`, `x/text v0.37.0 -> v0.39.0`, and `google.golang.org/grpc v1.81.0 -> v1.83.1`. These are scanner-reported fixed versions, not compatibility approval. Their presence is not proof that all affected functions are reachable. The final module inventory, not an assumption about xcaddy resolution, determines remaining work. In particular, do not force individual scanner fix floors with replacements that undercut another module's newer dependency requirements; review a coherent Go module graph instead.

Baseline Alpine fixes include `c-ares 1.34.6-r0 -> 1.34.8-r0`, `curl/libcurl 8.19.0-r0 -> 8.20.0-r0`, and `libcrypto3/libssl3 3.5.7-r0 -> 3.5.8-r0`. This recipe does not run an unbounded `apk upgrade`. A separately reviewed OS update must pin the actual resulting input and retain its scan evidence. Updating Alpine alone cannot repair Go libraries embedded in the executable.

## Local static check

From the repository root (Node 22, no dependency installation needed):

```sh
node --test deploy/foundry-test/caddy-security/recipe.test.mjs
```

## Approved disposable builder only

### GitHub-hosted candidate flow (preferred)

`.github/workflows/caddy-security-candidate.yml` runs on relevant pull requests and manual dispatch using a GitHub-hosted Ubuntu runner. It checks out the exact pull-request head SHA (not an implicit merge revision), runs Node 22 static checks, and explicitly selects the legacy Docker backend with hard 2 GiB memory/no-extra-swap and one-CPU quotas. Unsupported limits fail the job; there is no unbounded backend fallback. This keeps compilation off the Foundry VM. The workflow has read-only repository permissions, receives no deployment secrets, does not log in to a registry, and does not publish or deploy an image.

The artifact `caddy-security-candidate-<headSHA>` is retained for 14 days and includes `image.tar`, image/source/run identity, build information, full Trivy JSON, scanner/database versions, remaining critical/high matches, logs, and SHA256 checksums. Trivy 0.74.0's official Linux download is checksum-pinned; it scans the exact saved image and verifies image identity, Go 1.26.8, and absence of CVE-2026-56862. Other findings remain visible for manual triage, not automatically waived or hidden. Failed runs may retain partial evidence; artifact presence alone is not a passing gate. Approving a candidate build does not authorize deployment.

### Separately authorized local alternative

The following are handoff commands, **not instructions to run on the live Foundry service**. Build only after review and authorization, on the approved disposable Linux amd64 worker. Set a hard worker/container cgroup memory limit and CPU limit before starting. One compiler process and `GOMEMLIMIT=512MiB` reduce pressure, but that setting is **not a hard container memory limit**: compiler subprocesses, linking, module downloads, and the builder itself also consume memory. Do not compile beside a memory-constrained running Foundry instance; do not add swap or resize a VM without separate authorization. If the approved limit is insufficient, stop and report the failure instead of changing the live workload.

Build from this small directory only. `.dockerignore` excludes every context file, and the Dockerfile copies solely from pinned stages. No Node runtime, Foundry distribution, license, owner credentials, private MCP files, or production configuration is required or sent to the builder.

```sh
docker build --platform linux/amd64 --pull --progress=plain \
  --tag bossforge-caddy:2.11.4-go1.26.8-candidate \
  deploy/foundry-test/caddy-security
```

Do not push, retag a production image, or replace a live service from this recipe. Capture the built image ID/digest and build log in the private audit directory. The build must fail if the Go version differs, Caddy version changes, or the registered module list differs. Inspect the resulting binary without networking or production mounts:

```sh
docker run --rm --network none --read-only --entrypoint caddy \
  bossforge-caddy:2.11.4-go1.26.8-candidate version
docker run --rm --network none --read-only --entrypoint caddy \
  bossforge-caddy:2.11.4-go1.26.8-candidate list-modules --packages --versions
docker run --rm --network none --read-only --entrypoint cat \
  bossforge-caddy:2.11.4-go1.26.8-candidate \
  /usr/local/share/caddy-security/go-buildinfo.txt
```

Verify `go1.26.8`, core Caddy `v2.11.4`, and no added/removed modules. Preserve the full embedded dependency inventory for review.

## Required final scan

Use an approved current scanner and freshly updated database against the **built candidate image**, not either upstream tag. For example, with Trivy available on the disposable worker:

```sh
trivy image --image-src docker --platform linux/amd64 --scanners vuln \
  --disable-telemetry --format json --output caddy-candidate-scan.json \
  bossforge-caddy:2.11.4-go1.26.8-candidate
```

Require scan completion and absence of **CVE-2026-56862** in the candidate results. Investigate any retained Go-runtime finding; never blanket-ignore findings or equate exit code 0 with zero vulnerabilities. Reconcile all remaining critical/high findings by exact package/version and applicability. A compiler rebuild alone is not permission to waive the other findings. Record scanner version, database timestamp, platform, candidate digest, full report, and review decision before publication or deployment.

## Private validation and separately approved rollout

Before deployment, run `caddy validate` against the existing reviewed Caddyfile with **no networking**, ephemeral writable directories, and read-only configuration mounts. The reviewed Caddyfile imports `/run/secrets/owner-auth.caddy`; its separate owner-authentication file is required for a valid check. Substitute real absolute paths only in the private execution environment; never copy either file into the build context or publish its contents. Supply any required environment privately without shell-tracing or printing credentials. Missing imports must fail validation rather than removing the owner gateway for the test.

```sh
docker run --rm --network none --read-only \
  --tmpfs /config --tmpfs /data --tmpfs /tmp \
  --mount type=bind,source=/ABSOLUTE/PRIVATE/reviewed-Caddyfile,target=/etc/caddy/Caddyfile,readonly \
  --mount type=bind,source=/ABSOLUTE/PRIVATE/owner-auth.caddy,target=/run/secrets/owner-auth.caddy,readonly \
  --entrypoint caddy bossforge-caddy:2.11.4-go1.26.8-candidate \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

If offline validation needs external certificate provisioning, stop and investigate that dependency; do not bypass validation or give this check production storage. Only after a separately approved, reversible rollout should the owner verify the existing **owner 401** gateway for unauthenticated access, authenticated owner access, GM login, normal game/world loading, and WebSocket/session parity. Retain the original digest/configuration and a reviewed **rollback** procedure, noting that rollback restores the known vulnerable binary and is recovery, not security remediation. No MCP sockets or additional public ports may be exposed by this image change.
