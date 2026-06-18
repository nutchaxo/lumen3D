"""Unit tests for the dev_server robustness/hardening batch.

  EDGE-021/049 thumbnail content (magic-byte) + size validation
  BUG-055      proxy-aware brute-force client IP
  BUG-061      catalog date sort sentinel (missing date sorts last)
  BUG-062      static rebuild and dynamic catalog share one filter+sort
  PERF-035     catalog listing memoized by mtime signature
  RACE-020     atomic JSON writes (temp + os.replace)

Run: py tests/test_dev_server_robustness.py
"""
import base64
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import dev_server  # noqa: E402

WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 "         # minimal WebP magic
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16       # PNG signature + pad


def _reset_cache():
    dev_server._CATALOG_CACHE["sig"] = None
    dev_server._CATALOG_CACHE["data"] = None


class TestThumbnailValidation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._o = dev_server.DATA_WEB
        dev_server.DATA_WEB = Path(self.tmp) / "DATA_WEB"
        (dev_server.DATA_WEB / "fixed").mkdir(parents=True)
        _reset_cache()

    def tearDown(self):
        dev_server.DATA_WEB = self._o
        shutil.rmtree(self.tmp, ignore_errors=True)
        _reset_cache()

    def _send(self, raw_bytes, mime="image/webp"):
        b64 = base64.b64encode(raw_bytes).decode()
        return dev_server._save_thumbnail_bytes("fixed/Demo", f"data:{mime};base64,{b64}")

    def test_webp_accepted(self):
        status, _ = self._send(WEBP)
        self.assertEqual(status, 200)

    def test_png_accepted(self):
        status, _ = self._send(PNG, "image/png")
        self.assertEqual(status, 200, "PNG still accepted (canvas export); only arbitrary binary is rejected")

    def test_arbitrary_binary_rejected(self):
        status, payload = self._send(b"\x00\x01\x02 definitely not an image")
        self.assertEqual(status, 400, "EDGE-021/049: non-image bytes rejected despite data:image/ prefix")
        self.assertNotEqual(payload.get("ok"), True)

    def test_oversize_rejected(self):
        big = WEBP + b"\x00" * (dev_server.MAX_THUMB_BYTES + 1)
        status, _ = self._send(big)
        self.assertEqual(status, 400, "EDGE-021/049: oversize thumbnail rejected before write")


class TestCatalogSortAndConsistency(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._o = dev_server.DATA_WEB
        dev_server.DATA_WEB = Path(self.tmp) / "DATA_WEB"
        for t in ("fixed", "live", "tracking"):
            (dev_server.DATA_WEB / t).mkdir(parents=True)
        _reset_cache()

    def tearDown(self):
        dev_server.DATA_WEB = self._o
        shutil.rmtree(self.tmp, ignore_errors=True)
        _reset_cache()

    def _ds(self, folder, **kw):
        d = dev_server.DATA_WEB / "fixed" / folder
        d.mkdir(parents=True, exist_ok=True)
        (d / "metadata.json").write_text(json.dumps({"id": folder, "configured": True, **kw}), encoding="utf-8")

    def test_missing_date_sorts_last(self):
        self._ds("A", name="A", date="2024-01-01")
        self._ds("B", name="B")               # no date
        self._ds("C", name="C", date="2025-06-01")
        names = [c["name"] for c in dev_server._build_catalog()]
        self.assertEqual(names[0], "C", "BUG-061: newest real date first")
        self.assertEqual(names[-1], "B", "BUG-061: missing date sorts last, not above real dates")

    def test_rebuild_matches_dynamic(self):
        self._ds("A", name="A", date="2024-01-01")
        self._ds("B", name="B")
        dynamic = dev_server._build_catalog()
        dev_server._rebuild_catalog()
        static = json.loads((dev_server.DATA_WEB / "catalog.json").read_text(encoding="utf-8"))
        self.assertEqual(static, dynamic, "BUG-062: static rebuild output equals the dynamic builder")


class TestCatalogCache(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._o = dev_server.DATA_WEB
        dev_server.DATA_WEB = Path(self.tmp) / "DATA_WEB"
        (dev_server.DATA_WEB / "fixed" / "A").mkdir(parents=True)
        (dev_server.DATA_WEB / "fixed" / "A" / "metadata.json").write_text('{"id":"A","configured":true}', encoding="utf-8")
        _reset_cache()

    def tearDown(self):
        dev_server.DATA_WEB = self._o
        shutil.rmtree(self.tmp, ignore_errors=True)
        _reset_cache()

    def test_cache_hits_same_signature(self):
        calls = {"n": 0}
        orig = dev_server._list_datasets

        def counting():
            calls["n"] += 1
            return orig()
        dev_server._list_datasets = counting
        try:
            dev_server._list_datasets_cached()
            dev_server._list_datasets_cached()
            self.assertEqual(calls["n"], 1, "PERF-035: second read served from the mtime cache")
        finally:
            dev_server._list_datasets = orig


class TestClientIp(unittest.TestCase):
    class FakeHandler:
        def __init__(self, peer, headers):
            self.client_address = (peer, 12345)
            self.headers = headers

        def address_string(self):
            return self.client_address[0]

    def test_direct_peer_used_by_default(self):
        h = self.FakeHandler("203.0.113.5", {"X-Forwarded-For": "10.0.0.1"})
        self.assertEqual(dev_server._client_ip(h), "203.0.113.5", "BUG-055: untrusted peer -> XFF ignored")

    def test_trusted_proxy_honors_xff(self):
        dev_server.TRUSTED_PROXIES.add("203.0.113.5")
        try:
            h = self.FakeHandler("203.0.113.5", {"X-Forwarded-For": "198.51.100.7, 10.0.0.1"})
            self.assertEqual(dev_server._client_ip(h), "198.51.100.7", "BUG-055: trusted proxy -> first XFF hop")
        finally:
            dev_server.TRUSTED_PROXIES.discard("203.0.113.5")


class TestAtomicWrite(unittest.TestCase):
    def test_atomic_write_roundtrip_no_temp_leftover(self):
        tmp = tempfile.mkdtemp()
        try:
            p = Path(tmp) / "sub" / "f.json"
            dev_server._atomic_write(p, '{"a":1}')
            self.assertEqual(json.loads(p.read_text(encoding="utf-8")), {"a": 1})
            leftovers = [f for f in (Path(tmp) / "sub").iterdir() if f.name.startswith(".tmp-")]
            self.assertEqual(leftovers, [], "RACE-020: no temp file left behind")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
