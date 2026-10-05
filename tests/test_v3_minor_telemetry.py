"""Telemetry beacon throttle (web 1.59.0), both backends.

api/telemetry.php and dev_server.py's /api/telemetry.php are public and
unauthenticated. Two integer token buckets now gate them — per client IP and
global — in a FIXED-size table (dev_server._telemetry_allow /
api/_admin_lib.php lumen_telemetry_allow), and a refused beacon answers 429
without touching the stats. Pinned here:
  * the two implementations take the same decision on the same scripted traffic
    and leave byte-identical state;
  * burst, refill and the global cap behave as documented;
  * the state never grows, whatever the number of distinct IPs;
  * over HTTP (Python) the 61st beacon of one IP in a burst is a 429 that counts
    nothing; a GET is still a 405 on both backends.

Run: python tests/test_v3_minor_telemetry.py
"""
import http.client
import json
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import dev_server  # noqa: E402
from v3_minor_support import PhpTwin  # noqa: E402

T0 = 1_800_000_000_000


def fresh():
    return bytearray(16 * (1 + dev_server.TELEMETRY_SLOTS))


class BucketTests(unittest.TestCase):
    def test_burst_then_refill(self):
        st = fresh()
        got = [dev_server._telemetry_allow("10.0.0.1", T0, st) for _ in range(61)]
        self.assertEqual(got.count(True), 60)
        self.assertFalse(got[-1])
        self.assertFalse(dev_server._telemetry_allow("10.0.0.1", T0 + 999, st), "0.999 token is not a token")
        self.assertTrue(dev_server._telemetry_allow("10.0.0.1", T0 + 1000, st), "1 token per second")
        self.assertTrue(dev_server._telemetry_allow("10.0.0.2", T0 + 1000, st), "another IP has its own bucket")

    def test_global_cap(self):
        st = fresh()
        allowed = sum(dev_server._telemetry_allow(f"10.1.{i // 250}.{i % 250}", T0, st) for i in range(700))
        self.assertEqual(allowed, 600)
        self.assertTrue(dev_server._telemetry_allow("10.9.9.9", T0 + 50, st), "20 per second globally")

    def test_state_is_bounded(self):
        st = fresh()
        n = len(st)
        for i in range(20000):
            dev_server._telemetry_allow(f"192.168.{i // 256}.{i % 256}", T0 + i, st)
        self.assertEqual(len(st), n)
        self.assertEqual(n, 16 * 4097)

    def test_php_twin_decides_identically(self):
        tmp = Path(tempfile.mkdtemp(prefix="lumen-tele-"))
        try:
            twin = PhpTwin(tmp, ["_admin_lib.php"])
            if not twin.available():
                self.skipTest("no php interpreter")
            script = []
            for i in range(300):
                ip = ("1.1.1.1", "2.2.2.2", "2001:db8::1", f"9.9.9.{i % 7}")[i % 4]
                script.append((ip, T0 + i * 37))
            st = fresh()
            expected = [dev_server._telemetry_allow(ip, t, st) for ip, t in script]
            store = str(tmp / "throttle.bin")
            got = twin.call(*({"fn": "lumen_telemetry_allow", "args": [ip, t, store]} for ip, t in script))
            self.assertEqual(got, expected)
            self.assertIn(False, expected)
            on_disk = Path(store).read_bytes()
            self.assertEqual(on_disk + b"\0" * (len(st) - len(on_disk)), bytes(st),
                             "the PHP file holds the same table as the Python one")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="lumen-tele-http-"))
        cls._stats = dev_server.STATS_FILE
        dev_server.STATS_FILE = cls.tmp / "stats.json"
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), dev_server.AdminHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        dev_server._flush_stats()
        dev_server.STATS_FILE = cls._stats
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def post(self, method="POST"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        conn.request(method, "/api/telemetry.php?action=visit", body=b"" if method == "POST" else None,
                     headers={"Content-Length": "0"} if method == "POST" else {})
        r = conn.getresponse()
        body = r.read()
        conn.close()
        return r.status, body

    def test_a_flood_is_refused_and_counts_nothing(self):
        dev_server._TELEMETRY_STATE[:] = bytes(len(dev_server._TELEMETRY_STATE))
        dev_server._flush_stats()
        before = dev_server._load_stats().get("global", {}).get("visits", 0)
        statuses = [self.post()[0] for _ in range(65)]
        self.assertEqual(statuses[:60], [200] * 60)
        self.assertTrue(all(s == 429 for s in statuses[60:]), statuses[58:])
        dev_server._flush_stats()
        after = dev_server._load_stats().get("global", {}).get("visits", 0)
        self.assertLessEqual(after - before, 60)
        self.assertEqual(self.post("GET")[0], 405)
        dev_server._TELEMETRY_STATE[:] = bytes(len(dev_server._TELEMETRY_STATE))


class PhpEndpointShape(unittest.TestCase):
    def test_php_endpoint_throttles_before_any_read(self):
        src = (ROOT / "api" / "telemetry.php").read_text(encoding="utf-8")
        gate = src.index("lumen_telemetry_allow(admin_client_ip())")
        self.assertLess(src.index("REQUEST_METHOD"), gate)
        self.assertLess(gate, src.index("lumen_request_json()"))
        self.assertLess(gate, src.index("admin_record_event("))


if __name__ == "__main__":
    unittest.main(verbosity=2)
