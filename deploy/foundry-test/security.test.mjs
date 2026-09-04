import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const composePath = fileURLToPath(new URL("./compose.yaml", import.meta.url));
const composeSource = readFileSync(composePath, "utf8");
const caddy = readFileSync(new URL("./Caddyfile", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");
// Compose performs the YAML parsing. This command does not contact the Docker
// daemon, start containers, resolve image tags, or read secret-file contents.
const config = JSON.parse(
  execFileSync(
    "docker",
    ["compose", "-f", composePath, "config", "--format", "json", "--no-path-resolution"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ),
);

test("only HTTPS gateway ports are public; Foundry is loopback-only and MCP is absent", () => {
  assert.deepEqual(Object.keys(config.services).sort(), ["caddy", "foundry"]);
  for (const service of Object.values(config.services)) {
    assert.equal(service.network_mode, undefined);
    assert.equal(service.privileged, undefined);
    assert.equal(service.build, undefined);
    assert.equal(service.env_file, undefined);
    assert.deepEqual(Object.keys(service.networks), ["foundry_web"]);
    assert.equal(service.restart, "no");
  }
  assert.deepEqual(config.services.foundry.ports, [
    { mode: "ingress", target: 30000, published: "30000", protocol: "tcp", host_ip: "127.0.0.1" },
  ]);
  assert.deepEqual(
    config.services.caddy.ports.map(({ target, published, protocol }) => ({
      target,
      published,
      protocol,
    })),
    [
      { target: 80, published: "80", protocol: "tcp" },
      { target: 443, published: "443", protocol: "tcp" },
    ],
  );
});

test("released images are fixed and Foundry has a stable license hostname", () => {
  assert.equal(config.services.foundry.image, "ghcr.io/felddy/foundryvtt:14.367.0");
  assert.equal(config.services.caddy.image, "caddy:2.11.4-alpine");
  assert.equal(config.services.foundry.hostname, "bossforge-foundry-test");
  const env = config.services.foundry.environment;
  assert.equal(env.FOUNDRY_HOSTNAME, "foundrytest.bossforge.dev");
  assert.equal(env.FOUNDRY_PROXY_SSL, "true");
  assert.equal(env.FOUNDRY_PROXY_PORT, "443");
  assert.equal(env.CONTAINER_PRESERVE_CONFIG, "true");
  assert.equal(env.FOUNDRY_UPNP, "false");
});

test("credentials are file-only and verbose logging is absent, not merely false", () => {
  assert.deepEqual(config.secrets, {
    foundry_runtime: {
      name: "bossforge-foundry-test_foundry_runtime",
      file: "/run/foundry-test/foundry-runtime.json",
    },
    owner_auth: {
      name: "bossforge-foundry-test_owner_auth",
      file: "/run/foundry-test/owner-auth.caddy",
    },
  });
  assert.deepEqual(config.services.foundry.secrets, [
    { source: "foundry_runtime", target: "config.json" },
  ]);
  assert.deepEqual(config.services.caddy.secrets, [
    { source: "owner_auth", target: "owner-auth.caddy" },
  ]);
  for (const service of Object.values(config.services)) {
    for (const key of Object.keys(service.environment ?? {})) {
      assert.doesNotMatch(
        key,
        /PASSWORD|USERNAME|LICENSE_KEY|ADMIN_KEY|SERVICE_KEY|CONTAINER_VERBOSE|RELEASE_URL/,
      );
    }
    for (const volume of service.volumes)
      assert.doesNotMatch(volume.source, /docker\.sock|\.ssh|gcloud/);
  }
});

test("test-only data survives container recreation without broad or automatic mounts", () => {
  const data = config.services.foundry.volumes.find((volume) => volume.target === "/data");
  assert.equal(data.type, "bind");
  assert.equal(data.source, "/var/lib/foundry-test/data");
  // Some Compose versions omit false-valued fields from their JSON output.
  // Check both the parsed value and the explicit source guard so omission of
  // create_host_path from the actual deployment cannot pass unnoticed.
  assert.equal(data.bind.create_host_path ?? false, false);
  assert.match(
    composeSource,
    /source: \/var\/lib\/foundry-test\/data\s+target: \/data\s+bind:\s+create_host_path: false/,
  );
  assert.equal(config.services.foundry.environment.CONTAINER_CACHE_SIZE, "1");
  assert.equal(config.services.foundry.environment.CONTAINER_UMASK, "0077");
  assert.equal(config.services.caddy.read_only, true);
  for (const service of Object.values(config.services)) {
    assert.ok(service.security_opt.includes("no-new-privileges:true"));
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.equal(service.logging.options["max-file"], "3");
  }
});

test("all Foundry routes require owner authentication before a single upstream", () => {
  assert.equal((caddy.match(/basic_auth\s*\{/g) ?? []).length, 1);
  assert.equal((caddy.match(/reverse_proxy/g) ?? []).length, 1);
  assert.match(
    caddy,
    /route\s*\{\s*basic_auth\s*\{\s*import \/run\/secrets\/owner-auth\.caddy\s*\}\s*reverse_proxy foundry:30000\s*\{/,
  );
  assert.match(caddy, /header_up -Authorization/);
  assert.match(caddy, /^foundrytest\.bossforge\.dev \{/m);
  assert.doesNotMatch(
    caddy,
    /handle|handle_path|forward_auth|file_server|respond|tls internal|auto_https off|log_credentials|debug/,
  );
  assert.doesNotMatch(caddy, /mcp|8787|30001|0\.0\.0\.0|localhost|127\.0\.0\.1/);
});

test("proxy administration is off and TLS/security headers do not add alternate origins", () => {
  assert.match(caddy, /admin off/);
  assert.match(caddy, /persist_config off/);
  assert.match(caddy, /strict_sni_host on/);
  assert.match(caddy, /protocols h1 h2/);
  assert.match(caddy, /Strict-Transport-Security/);
  assert.match(caddy, /X-Content-Type-Options nosniff/);
  assert.match(caddy, /frame-ancestors 'none'/);
});

const bootstrap = readFileSync(new URL("./bootstrap.sh", import.meta.url), "utf8");

test("bootstrap uses only version-pinned secret resources and ephemeral file hydration", () => {
  assert.equal(bootstrap.includes("\r"), false, "Linux bootstrap must use LF line endings");
  assert.match(bootstrap, /^set \+x$/m);
  assert.match(bootstrap, /^umask 077$/m);
  assert.match(bootstrap, /\$EUID -eq 0/);
  assert.match(bootstrap, /\$VERSION_ID == 24\.04/);
  assert.match(bootstrap, /docker\.io docker-compose-v2 python3 curl ca-certificates/);
  assert.match(bootstrap, /findmnt -n -o FSTYPE --target \/run\) == tmpfs/);
  assert.match(
    bootstrap,
    /projects\/bossforgedev\/secrets\/foundry-test-account-bootstrap\/versions\/1/,
  );
  assert.match(
    bootstrap,
    /projects\/bossforgedev\/secrets\/foundry-test-owner-access\/versions\/1/,
  );
  assert.doesNotMatch(
    bootstrap,
    /versions\/latest|gcloud auth|docker logs|compose.*logs|--plaintext|set -x|eval /,
  );
  assert.match(bootstrap, /Metadata-Flavor.*Google/);
  assert.match(bootstrap, /dataCrc32c/);
  assert.match(bootstrap, /os\.fchmod\(output\.fileno\(\), 0o400\)/);
  assert.match(
    bootstrap,
    /write_runtime\("foundry-runtime\.json", json\.dumps\(account\)\.encode\(\), 1000\)/,
  );
});

test("bootstrap hashes through stdin and gates Foundry startup on trusted HTTPS rejection", () => {
  assert.match(bootstrap, /"--network", "none", "--log-driver", "none"/);
  assert.match(bootstrap, /input=owner\["owner_password"\]\.encode\(\) \+ b"\\n"/);
  assert.match(bootstrap, /capture_output=True/);
  assert.match(bootstrap, /caddy validate --config \/etc\/caddy\/Caddyfile/);
  assert.match(bootstrap, /--resolve foundrytest\.bossforge\.dev:443:127\.0\.0\.1/);
  assert.match(bootstrap, /\[\[ \$code == 401 \]\]/);
  assert.doesNotMatch(bootstrap, /--insecure|--accept.*eula|--accept.*license/i);
  assert.ok(
    bootstrap.indexOf("phase=trusted-https-owner-gate") < bootstrap.indexOf("phase=foundry-start"),
  );
});
