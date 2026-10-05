"""Multi-range requests on the dev server's static files (web 1.59.0).

`Range: bytes=a-b,c-d` used to be answered with the whole file (a 200, which the
RFC allows). AdminHandler now answers it as RFC 9110 §14.6 describes: a 206
multipart/byteranges, one part per range with its own Content-Range, after
sorting and coalescing overlapping/adjacent ranges; more than MAX_BYTE_RANGES
distinct ranges, or any malformed element, falls back to the whole file. One
range keeps the plain 206 of tests/test_static_range.py. `php -S` (router.php)
ignores Range altogether — a 200 with the whole body, which every client of the
platform accepts (BrickLoader keeps a 200 as the whole pack); Apache answers
multi-range natively.

Run: python tests/test_v3_minor_multirange.py
"""
import http.client
import os
import re
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


def parse_multipart(body: bytes, boundary: str):
    parts = []
    for chunk in body.split(b"--" + boundary.encode())[1:]:
        if chunk.startswith(b"--"):
            break
        head, _, data = chunk.partition(b"\r\n\r\n")
        headers = dict(line.split(": ", 1) for line in head.decode().strip().split("\r\n"))
        parts.append((headers, data[:-2] if data.endswith(b"\r\n") else data))
    return parts


class MultiRangeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), dev_server.AdminHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.data = (ROOT / TARGET.lstrip("/")).read_bytes()
        cls.size = len(cls.data)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def get(self, rng, method="GET"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        conn.request(method, TARGET, headers={"Range": rng})
        r = conn.getresponse()
        body = r.read()
        conn.close()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, body

    def multipart(self, rng):
        status, h, body = self.get(rng)
        self.assertEqual(status, 206, rng)
        m = re.fullmatch(r"multipart/byteranges; boundary=([0-9a-f]+)", h["content-type"])
        self.assertIsNotNone(m, h["content-type"])
        self.assertEqual(int(h["content-length"]), len(body))
        return parse_multipart(body, m.group(1))

    def test_two_ranges_are_two_parts(self):
        parts = self.multipart("bytes=0-9,100-119")
        self.assertEqual([p[0]["Content-Range"] for p in parts],
                         [f"bytes 0-9/{self.size}", f"bytes 100-119/{self.size}"])
        self.assertEqual(parts[0][1], self.data[0:10])
        self.assertEqual(parts[1][1], self.data[100:120])
        self.assertTrue(all(p[0]["Content-Type"] for p in parts))

    def test_overlapping_and_out_of_order_ranges_coalesce(self):
        parts = self.multipart("bytes=200-299, 0-49,40-60,61-70, -5")
        self.assertEqual([p[0]["Content-Range"] for p in parts],
                         [f"bytes 0-70/{self.size}", f"bytes 200-299/{self.size}",
                          f"bytes {self.size - 5}-{self.size - 1}/{self.size}"])
        self.assertEqual(parts[0][1], self.data[0:71])
        self.assertEqual(parts[2][1], self.data[-5:])

    def test_ranges_that_merge_into_one_are_a_plain_206(self):
        status, h, body = self.get("bytes=0-9,10-19,5-12")
        self.assertEqual(status, 206)
        self.assertEqual(h["content-range"], f"bytes 0-19/{self.size}")
        self.assertEqual(body, self.data[:20])

    def test_unsatisfiable_parts_are_dropped(self):
        status, h, body = self.get(f"bytes=0-3,{self.size + 10}-")
        self.assertEqual((status, body), (206, self.data[:4]))
        status, h, _ = self.get(f"bytes={self.size}-,{self.size + 5}-{self.size + 9}")
        self.assertEqual(status, 416)
        self.assertEqual(h["content-range"], f"bytes */{self.size}")

    def test_too_many_or_malformed_ranges_send_the_whole_file(self):
        many = ",".join(f"{4 * i}-{4 * i + 1}" for i in range(dev_server.MAX_BYTE_RANGES + 1))
        for rng in (many, "bytes=0-5,30-10", "bytes=0-5,abc", "bytes=,"):
            status, _, body = self.get(rng if rng.startswith("bytes") else "bytes=" + rng)
            self.assertEqual((status, body), (200, self.data), rng[:40])
        ok = ",".join(f"{4 * i}-{4 * i + 1}" for i in range(dev_server.MAX_BYTE_RANGES))
        self.assertEqual(len(self.multipart("bytes=" + ok)), dev_server.MAX_BYTE_RANGES)

    def test_head_announces_the_same_length(self):
        _, hg, body = self.get("bytes=0-9,100-119")
        status, hh, empty = self.get("bytes=0-9,100-119", method="HEAD")
        self.assertEqual((status, empty), (206, b""))
        self.assertEqual(hh["content-length"], hg["content-length"])

    def test_parser_contract(self):
        p = dev_server._parse_byte_ranges
        self.assertEqual(p("bytes=0-1,4-5", 10), [(0, 1), (4, 5)])
        self.assertEqual(p("BYTES = 2-3", 10), [(2, 3)])
        self.assertIs(p("bytes=10-,20-", 10), dev_server._RANGE_UNSATISFIABLE)
        self.assertIs(p("bytes=-0", 10), dev_server._RANGE_UNSATISFIABLE)
        self.assertIsNone(p("bytes=1-2", 10, max_ranges=0))
        self.assertIsNone(p(None, 10))
        self.assertIsNone(p("bytes=" + ",".join(["0-1"] * 2000), 10), "spec count capped before parsing")


if __name__ == "__main__":
    unittest.main(verbosity=2)
