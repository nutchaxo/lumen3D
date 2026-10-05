"""Subresource Integrity of the self-hosted vendor scripts.

Every `integrity="sha384-..."` pin next to a `js/vendor/...` script in the HTML
entry points, and every `*_SRC` / `*_SRI` constant pair that a plugin uses to
lazy-load a vendor file, must equal the sha384 of the file shipped in the repo
(what the browser computes). A vendor upgrade without updating the hash would
otherwise silently break the page. Local only: no network.

Run: python tests/test_sri.py
"""
import base64
import glob
import hashlib
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SCRIPT_TAG_RE = re.compile(r"<script\b[^>]*>", re.IGNORECASE | re.DOTALL)
SRC_RE = re.compile(r'\bsrc="([^"]+)"', re.IGNORECASE)
INTEGRITY_RE = re.compile(r'\bintegrity="(sha384-[^"]+)"', re.IGNORECASE)
# 'js/vendor/x.js' ... 'sha384-...' constant pairs in plugin sources (SRC then SRI).
CONST_RE = re.compile(
    r"(\w+_SRC)\s*:\s*'([^']*js/vendor/[^']+)'\s*,\s*(\w+_SRI)\s*:\s*'(sha384-[^']+)'")


def _sri(path):
    with open(path, "rb") as fh:
        return "sha384-" + base64.b64encode(hashlib.sha384(fh.read()).digest()).decode()


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _html_files():
    return sorted(glob.glob(os.path.join(ROOT, "*.html")))


def _html_pins():
    pins = []  # (html, vendor-relative path, integrity)
    unpinned = []
    for f in _html_files():
        txt = _read(f)
        for m in SCRIPT_TAG_RE.finditer(txt):
            tag = m.group(0)
            src = SRC_RE.search(tag)
            if not src or "js/vendor/" not in src.group(1):
                continue
            rel = src.group(1).split("?")[0]
            integ = INTEGRITY_RE.search(tag)
            if not integ:
                unpinned.append((os.path.basename(f), rel))
            else:
                pins.append((os.path.basename(f), rel, integ.group(1)))
    return pins, unpinned


def _plugin_pins():
    pins = []
    for f in glob.glob(os.path.join(ROOT, "js", "modules", "**", "*.js"), recursive=True):
        txt = _read(f)
        for m in CONST_RE.finditer(txt):
            pins.append((os.path.relpath(f, ROOT), m.group(2), m.group(4)))
    return pins


class TestVendorSri(unittest.TestCase):
    def test_html_has_pins(self):
        pins, _ = _html_pins()
        self.assertGreater(len(pins), 5, "no vendor SRI pins found in the HTML: the scan itself is broken")

    def test_every_vendor_script_is_pinned(self):
        _, unpinned = _html_pins()
        self.assertEqual(unpinned, [], f"vendor <script> without integrity: {unpinned}")

    def test_html_pins_match_files(self):
        pins, _ = _html_pins()
        bad = []
        for page, rel, integ in pins:
            path = os.path.join(ROOT, rel)
            if not os.path.isfile(path):
                bad.append((page, rel, "missing file"))
            elif _sri(path) != integ:
                bad.append((page, rel, f"pin {integ} != file {_sri(path)}"))
        self.assertEqual(bad, [], f"SRI mismatch (HTML): {bad}")

    def test_plugin_pins_match_files(self):
        pins = _plugin_pins()
        self.assertGreaterEqual(len(pins), 2, "plugin SRI constants not found: the scan itself is broken")
        bad = []
        for plugin, rel, integ in pins:
            path = os.path.join(ROOT, rel)
            if not os.path.isfile(path):
                bad.append((plugin, rel, "missing file"))
            elif _sri(path) != integ:
                bad.append((plugin, rel, f"pin {integ} != file {_sri(path)}"))
        self.assertEqual(bad, [], f"SRI mismatch (plugins): {bad}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
