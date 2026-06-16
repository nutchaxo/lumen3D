"""Unit test for admin preview iframe sandbox (ELE-07 / SEC-009).

The preview iframe always loads first-party, same-origin viewer.html, which
needs allow-scripts + allow-same-origin (ES modules + localStorage). The fix
applies least privilege: allow-forms / allow-popups are removed (never needed
for a read-only preview), and the iframe stays sandboxed.

Run: py tests/test_admin_iframe_sandbox.py
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, "admpan.html")


class TestPreviewIframeSandbox(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = open(HTML, encoding="utf-8").read()

    def _sandbox_tokens(self):
        tag = re.search(r'<iframe[^>]*id="preview-frame"[^>]*>', self.src, re.IGNORECASE)
        self.assertIsNotNone(tag, "preview-frame iframe not found")
        sb = re.search(r'sandbox="([^"]*)"', tag.group(0))
        self.assertIsNotNone(sb, "iframe must keep a sandbox attribute")
        return set(sb.group(1).split())

    def test_required_capabilities_present(self):
        tokens = self._sandbox_tokens()
        self.assertIn("allow-scripts", tokens)
        self.assertIn("allow-same-origin", tokens)

    def test_unneeded_capabilities_removed(self):
        tokens = self._sandbox_tokens()
        self.assertNotIn("allow-forms", tokens)
        self.assertNotIn("allow-popups", tokens)
        self.assertNotIn("allow-top-navigation", tokens)

    def test_still_sandboxed(self):
        # a non-empty sandbox attribute (an empty one would also be fine, but the
        # viewer needs the two flags above)
        self.assertGreaterEqual(len(self._sandbox_tokens()), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
