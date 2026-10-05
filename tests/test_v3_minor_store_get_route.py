"""GET /api/migrations.php?action=store_get on the Python server (web 1.59.0).

The browser m004 executor reads level-k v3 bricks back from the tile store through
this route (dataset_migrations.handle_binary): admin session required, no CSRF (a
read), raw application/octet-stream, or the JSON error of the store (404 absent).

Run: python tests/test_v3_minor_store_get_route.py
"""
import http.client
import json
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import dev_server  # noqa: E402
import dataset_migrations  # noqa: E402


class StoreGetRoute(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), dev_server.AdminHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def get(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        conn.request("GET", "/api/migrations.php?action=store_get&dataset=3d/DS"
                            "&migration=m004-bricks-v3&brick=t0.k1.c0.z0.y0.x0")
        r = conn.getresponse()
        body = r.read()
        conn.close()
        return r.status, r.getheader("Content-Type"), body

    def test_needs_a_session(self):
        with mock.patch.object(dataset_migrations, "handle_binary") as hb:
            status, _, _ = self.get()
        self.assertEqual(status, 401)
        hb.assert_not_called()

    def test_streams_the_brick_or_reports_absent(self):
        calls = []

        def fake(action, params):
            calls.append((action, params))
            if params.get("brick") == "t0.k1.c0.z0.y0.x0" and len(calls) == 1:
                return 200, "application/octet-stream", b"RIFF\x00brick"
            return 404, "application/json", b'{"error":"absent"}'

        with mock.patch.object(dev_server, "_get_session", lambda token: {"user": "admin"}), \
                mock.patch.object(dev_server, "_migrations_bind", lambda: None), \
                mock.patch.object(dataset_migrations, "handle_binary", fake):
            first = self.get()
            second = self.get()
        self.assertEqual(first, (200, "application/octet-stream", b"RIFF\x00brick"))
        self.assertEqual(second[0], 404)
        self.assertEqual(json.loads(second[2]), {"error": "absent"})
        self.assertEqual(calls[0][0], "store_get")
        self.assertEqual(calls[0][1]["migration"], "m004-bricks-v3")


if __name__ == "__main__":
    unittest.main(verbosity=2)
