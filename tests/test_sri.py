"""Unit/integration tests for Subresource Integrity (ELE-06 / SEC-008).

Every versioned CDN <script> across the HTML entry points must carry an
`integrity="sha384-…"` + `crossorigin` attribute, and (network test) the hash
must match the bytes the CDN actually serves — i.e. what the browser will
compute. Google Fonts CSS is intentionally excluded (dynamically generated).

Run: py tests/test_sri.py
"""
import base64
import glob
import hashlib
import os
import re
import unittest
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CDN_HOSTS = ("unpkg.com", "cdn.jsdelivr.net", "cdn.plot.ly", "cdnjs.cloudflare.com")
SCRIPT_RE = re.compile(r'<script\b[^>]*\bsrc="(https://[^"]+)"[^>]*>', re.IGNORECASE)
SRI_RE = re.compile(
    r'<script\b[^>]*\bsrc="(https://[^"]+)"[^>]*\bintegrity="(sha384-[^"]+)"', re.IGNORECASE
)


def _html_files():
    return sorted(glob.glob(os.path.join(ROOT, "*.html")))


class TestSriPresence(unittest.TestCase):
    def test_all_cdn_scripts_have_integrity(self):
        missing = []
        for f in _html_files():
            txt = open(f, encoding="utf-8").read()
            for m in SCRIPT_RE.finditer(txt):
                url, tag = m.group(1), m.group(0)
                if not any(h in url for h in CDN_HOSTS):
                    continue
                if 'integrity="sha384-' not in tag or "crossorigin" not in tag:
                    missing.append((os.path.basename(f), url))
        self.assertEqual(missing, [], f"CDN scripts without SRI: {missing}")


class TestSriCorrectness(unittest.TestCase):
    """Network test: hashes must match the actual CDN bytes (skipped if offline)."""

    def test_integrity_matches_cdn(self):
        pairs = {}
        for f in _html_files():
            txt = open(f, encoding="utf-8").read()
            for m in SRI_RE.finditer(txt):
                pairs[m.group(1)] = m.group(2)
        if not pairs:
            self.skipTest("no SRI pairs found")
        for url, integ in pairs.items():
            try:
                req = urllib.request.Request(
                    url, headers={"Accept-Encoding": "identity", "User-Agent": "sri-test"}
                )
                data = urllib.request.urlopen(req, timeout=30).read()
            except Exception as e:  # offline / CDN unreachable
                self.skipTest(f"network unavailable for {url}: {e}")
            calc = "sha384-" + base64.b64encode(hashlib.sha384(data).digest()).decode()
            self.assertEqual(calc, integ, f"SRI mismatch for {url}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
