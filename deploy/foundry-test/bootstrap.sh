#!/usr/bin/env bash
# Run only on the approved disposable Ubuntu 24.04 GCE host, as root.
set +x
set -euo pipefail
umask 077
phase=preflight
trap 'printf "Foundry bootstrap failed during %s; secret output suppressed.\n" "$phase" >&2' ERR
[[ $EUID -eq 0 ]] || { printf 'Run bootstrap as root.\n' >&2; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { printf 'Ubuntu 24.04 required.\n' >&2; exit 1; }
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
for dir in /opt/foundry-test /var/lib/foundry-test /run/foundry-test; do
  [[ ! -L "$dir" ]] || { printf 'Refusing a symlink deployment directory.\n' >&2; exit 1; }
done
install -d -o root -g root -m 0755 /opt/foundry-test
for file in compose.yaml Caddyfile; do
  [[ -f "$source_dir/$file" && ! -L "$source_dir/$file" && ! -L "/opt/foundry-test/$file" ]]
  if [[ $source_dir != /opt/foundry-test ]]; then
    install -o root -g root -m 0644 "$source_dir/$file" "/opt/foundry-test/$file"
  else
    chown root:root "/opt/foundry-test/$file"
    chmod 0644 "/opt/foundry-test/$file"
  fi
done
[[ $(findmnt -n -o FSTYPE --target /run) == tmpfs ]]
phase=ubuntu-packages
apt-get update -qq >/dev/null 2>&1
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  docker.io docker-compose-v2 python3 curl ca-certificates >/dev/null 2>&1
systemctl enable --now docker >/dev/null 2>&1
phase=test-directories
install -d -o root -g root -m 0700 /var/lib/foundry-test /run/foundry-test
for dir in data caddy-data caddy-config; do
  [[ ! -L "/var/lib/foundry-test/$dir" ]]
done
install -d -o 1000 -g 1000 -m 0700 /var/lib/foundry-test/data
install -d -o root -g root -m 0700 /var/lib/foundry-test/caddy-data /var/lib/foundry-test/caddy-config
compose=(docker compose --project-directory /opt/foundry-test -f /opt/foundry-test/compose.yaml)
phase=images-and-graceful-restart
"${compose[@]}" config --quiet >/dev/null 2>&1
"${compose[@]}" pull >/dev/null 2>&1
"${compose[@]}" stop --timeout 60 >/dev/null 2>&1
phase=metadata-and-secret-hydration
python3 - <<'PY'
import base64, json, os, re, subprocess, tempfile, urllib.request

stage = "metadata access"
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Redirect forbidden")
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
def read_json(url, headers):
    with opener.open(urllib.request.Request(url, headers=headers), timeout=20) as response:
        raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError("Response too large")
        return json.loads(raw)
def access_secret(resource, token, expected):
    response = read_json("https://secretmanager.googleapis.com/v1/" + resource + ":access",
                         {"Authorization": "Bearer " + token})
    raw = base64.b64decode(response["payload"]["data"], validate=True)
    if len(raw) > 8192:
        raise ValueError("Secret too large")
    crc = 0xffffffff
    for byte in raw:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0x82f63b78 if crc & 1 else 0)
    if int(response["payload"]["dataCrc32c"]) != (crc ^ 0xffffffff):
        raise ValueError("Checksum mismatch")
    value = json.loads(raw)
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError("Unexpected secret fields")
    if any(not isinstance(v, str) or not v or len(v) > 1024 or any(c in v for c in "\r\n\0") for v in value.values()):
        raise ValueError("Invalid secret values")
    return value
def write_runtime(name, content, uid):
    fd, pending = tempfile.mkstemp(prefix=".pending-", dir="/run/foundry-test")
    try:
        with os.fdopen(fd, "wb") as output:
            os.fchown(output.fileno(), uid, uid)
            os.fchmod(output.fileno(), 0o400)
            output.write(content)
        os.replace(pending, "/run/foundry-test/" + name)
    finally:
        if os.path.exists(pending):
            os.unlink(pending)
try:
    metadata = read_json("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
                         {"Metadata-Flavor": "Google"})
    token = metadata["access_token"]
    if metadata.get("token_type") != "Bearer" or int(metadata["expires_in"]) < 60 or not re.fullmatch(r"[A-Za-z0-9._~+/-]+=*", token):
        raise ValueError("Invalid metadata token")
    stage = "pinned Secret Manager versions or JSON validation"
    account = access_secret("projects/bossforgedev/secrets/foundry-test-account-bootstrap/versions/1", token,
                            {"foundry_username", "foundry_password"})
    owner = access_secret("projects/bossforgedev/secrets/foundry-test-owner-access/versions/1", token,
                          {"foundry_admin_key", "owner_password"})
    if not 20 <= len(owner["owner_password"].encode()) <= 72 or len(owner["foundry_admin_key"]) < 20:
        raise ValueError("Owner passwords too short or too long for bcrypt")
    if len({owner["owner_password"], owner["foundry_admin_key"], account["foundry_password"]}) != 3:
        raise ValueError("Separate passwords required")
    stage = "owner password hashing"
    hashed = subprocess.run(["docker", "run", "--rm", "-i", "--network", "none", "--log-driver", "none",
                             "--read-only", "--cap-drop", "ALL", "--cap-add", "NET_BIND_SERVICE", "--security-opt", "no-new-privileges:true",
                             "caddy:2.11.4-alpine", "caddy", "hash-password", "--algorithm", "bcrypt", "--bcrypt-cost", "14"],
                            input=owner["owner_password"].encode() + b"\n", capture_output=True, check=True, timeout=120).stdout.strip()
    if not re.fullmatch(rb"\$2[aby]\$14\$[./A-Za-z0-9]{53}", hashed):
        raise ValueError("Invalid bcrypt output")
    stage = "runtime secret files"
    account["foundry_admin_key"] = owner["foundry_admin_key"]
    write_runtime("foundry-runtime.json", json.dumps(account).encode(), 1000)
    write_runtime("owner-auth.caddy", b"owner " + hashed + b"\n", 0)
except Exception:
    raise SystemExit("Secret bootstrap failed during " + stage + "; details suppressed.") from None
PY
phase=caddy-configuration
"${compose[@]}" run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
"${compose[@]}" up --detach --force-recreate caddy >/dev/null 2>&1
phase=trusted-https-owner-gate
code=000
for ((attempt=0; attempt<30; attempt++)); do
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 5 --max-time 10 \
    --resolve foundrytest.bossforge.dev:443:127.0.0.1 https://foundrytest.bossforge.dev/setup)" || code=000
  [[ $code != 401 ]] || break
  sleep 2
done
[[ $code == 401 ]]
for route in / /join /socket.io/; do
  [[ $(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 5 --max-time 10 \
    --resolve foundrytest.bossforge.dev:443:127.0.0.1 "https://foundrytest.bossforge.dev$route") == 401 ]]
done
phase=foundry-start
"${compose[@]}" up --detach --force-recreate foundry >/dev/null 2>&1
# Never tail container logs, print configuration, or accept the Foundry EULA here.
"${compose[@]}" ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
