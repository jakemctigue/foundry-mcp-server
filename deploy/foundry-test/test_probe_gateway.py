"""Offline owner-gate probe tests. No real credentials, cloud calls, or sockets."""

import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("probe_gateway", Path(__file__).with_name("probe-gateway.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

FAKE_PASSWORD = "test-only-password-not-a-real-secret"


def envelope(value=None):
    raw = json.dumps(value if value is not None else {
        "foundry_admin_key": "test-only-independent-admin-value", "owner_password": FAKE_PASSWORD,
    }).encode()
    crc = 0xffffffff
    for byte in raw:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0x82f63b78 if crc & 1 else 0)
    return {"name": probe.SECRET, "payload": {
        "data": base64.b64encode(raw).decode(), "dataCrc32c": str(crc ^ 0xffffffff),
    }}


class ProbeTests(unittest.TestCase):
    def test_expected_version_and_checksum(self):
        data = envelope()
        self.assertEqual(probe.checked_owner_password(data), FAKE_PASSWORD)
        data["name"] = "projects/278230599227/secrets/foundry-test-owner-access/versions/1"
        self.assertEqual(probe.checked_owner_password(data), FAKE_PASSWORD)

    def test_unexpected_secret_or_latest_ref_rejected(self):
        for name in (probe.SECRET.replace("/1", "/latest"), probe.SECRET.replace("owner-access", "other")):
            with self.subTest(name=name):
                data = envelope()
                data["name"] = name
                with self.assertRaises(ValueError):
                    probe.checked_owner_password(data)

    def test_tampered_payload_rejected(self):
        data = envelope()
        data["payload"]["dataCrc32c"] = "0"
        with self.assertRaises(ValueError):
            probe.checked_owner_password(data)

    def test_secret_shape_and_password_limits(self):
        for value in ({}, {"owner_password": FAKE_PASSWORD},
                      {"owner_password": "too-short", "foundry_admin_key": "unused"},
                      {"owner_password": "a" * 73, "foundry_admin_key": "unused"},
                      {"owner_password": "a" * 40 + "\n", "foundry_admin_key": "unused"}):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    probe.checked_owner_password(envelope(value))

    def test_redirects_never_followed(self):
        self.assertIsNone(probe.NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere.invalid"))

    def run_main(self, statuses):
        output = io.StringIO()
        metadata = {"access_token": "test-only-token", "token_type": "Bearer", "expires_in": 3600}
        with patch.object(probe, "get_json", side_effect=[metadata, envelope()]), \
                patch.object(probe, "get_status", side_effect=statuses) as status, \
                contextlib.redirect_stdout(output):
            try:
                probe.main()
            finally:
                self.assertNotIn(FAKE_PASSWORD, output.getvalue())
                self.assertNotIn("test-only-token", output.getvalue())
                self.assertNotIn("Basic ", output.getvalue())
        return output.getvalue(), status.call_args_list

    def test_all_routes_require_both_rejection_and_owner_success(self):
        output, calls = self.run_main([401, 302, 401, 302, 401, 200, 401, 200])
        self.assertEqual(len(calls), 8)
        self.assertEqual([row["passed"] for row in map(json.loads, output.splitlines())], [True] * 4)
        self.assertEqual([call.args[1] for call in calls[::2]], list(probe.ROUTES))
        self.assertTrue(all(len(call.args) == 2 for call in calls[::2]))
        self.assertTrue(all(call.args[2].startswith("Basic ") for call in calls[1::2]))

    def test_any_open_route_or_failed_owner_handshake_fails(self):
        for statuses in ([200, 302, 401, 302, 401, 200, 401, 200],
                         [401, 302, 401, 302, 401, 200, 401, 302],
                         [401, 302, 401, 502, 401, 200, 401, 200]):
            with self.subTest(statuses=statuses):
                with self.assertRaises(ValueError):
                    self.run_main(statuses)


if __name__ == "__main__":
    unittest.main()
