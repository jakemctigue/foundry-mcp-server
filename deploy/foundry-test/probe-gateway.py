#!/usr/bin/env python3
"""Read-only HTTPS owner-gate probe; credentials and response bodies never leave memory."""

import base64
import json
import re
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

ORIGIN = "https://foundrytest.bossforge.dev"
SECRET = "projects/bossforgedev/secrets/foundry-test-owner-access/versions/1"
ROUTES = ("/", "/setup", "/join", "/socket.io/?EIO=4&transport=polling")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def get_json(opener, url, headers):
    with opener.open(Request(url, headers=headers), timeout=20) as response:
        raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError("Response exceeds limit")
        return json.loads(raw)


def checked_owner_password(response):
    if response.get("name") not in (
        SECRET,
        "projects/278230599227/secrets/foundry-test-owner-access/versions/1",
    ):
        raise ValueError("Unexpected secret version")
    raw = base64.b64decode(response["payload"]["data"], validate=True)
    if len(raw) > 8192:
        raise ValueError("Secret exceeds limit")
    crc = 0xffffffff
    for byte in raw:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0x82f63b78 if crc & 1 else 0)
    if int(response["payload"]["dataCrc32c"]) != (crc ^ 0xffffffff):
        raise ValueError("Checksum mismatch")
    value = json.loads(raw)
    if not isinstance(value, dict) or set(value) != {"foundry_admin_key", "owner_password"}:
        raise ValueError("Unexpected secret fields")
    password = value["owner_password"]
    if not isinstance(password, str) or not 20 <= len(password.encode()) <= 72:
        raise ValueError("Invalid owner credential")
    if any(c in password for c in "\r\n\0"):
        raise ValueError("Invalid owner credential")
    return password


def get_status(opener, route, authorization=None):
    headers = {} if authorization is None else {"Authorization": authorization}
    try:
        response = opener.open(Request(ORIGIN + route, headers=headers), timeout=20)
    except HTTPError as error:
        response = error
    with response:
        return response.status


def main():
    opener = build_opener(ProxyHandler({}), NoRedirect())
    metadata = get_json(
        opener,
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        {"Metadata-Flavor": "Google"},
    )
    token = metadata["access_token"]
    if (metadata.get("token_type") != "Bearer" or int(metadata["expires_in"]) < 60
            or not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9._~+/-]+=*", token)):
        raise ValueError("Invalid metadata token")
    owner = checked_owner_password(get_json(
        opener, "https://secretmanager.googleapis.com/v1/" + SECRET + ":access",
        {"Authorization": "Bearer " + token},
    ))
    authorization = "Basic " + base64.b64encode(("owner:" + owner).encode()).decode("ascii")
    passed = True
    for route in ROUTES:
        public = get_status(opener, route)
        authenticated = get_status(opener, route, authorization)
        allowed = (200,) if route.startswith("/socket.io/") else (200, 302, 303, 307, 308)
        ok = public == 401 and authenticated in allowed
        passed = passed and ok
        print(json.dumps({"path": route.split("?")[0], "unauthenticated": public,
                          "ownerAuthenticated": authenticated, "passed": ok}))
    if not passed:
        raise ValueError("Owner gate failed")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"error": "Owner-gate probe failed; credentials and response details suppressed"}))
        raise SystemExit(1) from None
