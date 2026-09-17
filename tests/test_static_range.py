"""Byte ranges on the dev server's static files.

The brick loader asks for the byte runs of a cut through the volume instead of whole
packs; the stdlib handler answers a Range request with the whole file, so
AdminHandler serves a single satisfiable range itself (206 + Content-Range) and
leaves everything else (suffix past the start, unsatisfiable, multi-part, no Range)
to the ordinary 200 answer.

Run: python tests/test_static_range.py
"""
import http.client
import os
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)
import dev_server  # noqa: E402

TARGET = "/js/core/compat.js"


class StaticRangeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), dev_server.AdminHandler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.data = (ROOT / TARGET.lstrip("/")).read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def get(self, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        conn.request("GET", TARGET, headers=headers or {})
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        return resp.status, dict((k.lower(), v) for k, v in resp.getheaders()), body

    def test_single_range_is_a_206(self):
        status, headers, body = self.get({"Range": "bytes=10-29"})
        self.assertEqual(status, 206)
        self.assertEqual(body, self.data[10:30])
        self.assertEqual(headers.get("content-range"), f"bytes 10-29/{len(self.data)}")
        self.assertEqual(headers.get("content-length"), "20")
        self.assertEqual(headers.get("accept-ranges"), "bytes")

    def test_open_ended_and_suffix_ranges(self):
        size = len(self.data)
        status, headers, body = self.get({"Range": f"bytes={size - 5}-"})
        self.assertEqual(status, 206)
        self.assertEqual(body, self.data[-5:])
        status, headers, body = self.get({"Range": "bytes=-7"})
        self.assertEqual(status, 206)
        self.assertEqual(body, self.data[-7:])
        self.assertEqual(headers.get("content-range"), f"bytes {size - 7}-{size - 1}/{size}")

    def test_everything_else_is_the_whole_file(self):
        for rng in ("bytes=999999999-", "bytes=30-10", "bytes=0-5,10-15", "items=0-5", "bytes=abc"):
            status, headers, body = self.get({"Range": rng})
            self.assertEqual(status, 200, rng)
            self.assertEqual(body, self.data, rng)
        status, headers, body = self.get()
        self.assertEqual(status, 200)
        self.assertEqual(body, self.data)


if __name__ == "__main__":
    unittest.main(verbosity=1)
