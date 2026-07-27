"""Unit tests for dev_server static-serving guard (ELE-09 / SEC-011).

`api/config.json` (admin password hash) was served as a static file under
`/api/config.json`. The guard blocks static serving of the server-side `api/`
directory, robust to traversal / case / backslash variants.

Run: py tests/test_dev_server_static_guard.py
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import dev_server  # noqa: E402


class TestForbiddenStatic(unittest.TestCase):
    def test_blocks_api_and_config(self):
        for p in (
            "api/config.json",
            "/api/config.json",
            "API/Config.json",          # case-insensitive
            "api\\config.json",         # backslash
            "x/../api/config.json",     # traversal into api/
            "./api/config.json",
            "api/secret.txt",
            "api",                      # bare directory (listing)
            "api/",
        ):
            self.assertTrue(dev_server._is_forbidden_static(p), f"should block: {p!r}")

    def test_blocks_percent_encoded_variants(self):
        """The guard compared the RAW path while SimpleHTTPRequestHandler.translate_path
        percent-decodes before opening the file, so encoding any single character served
        the credential hash: /%61pi/admin_credential.json returned it, /api/… 404'd."""
        for p in (
            "%61pi/admin_credential.json",     # 'a' encoded
            "a%70i/admin_credential.json",     # 'p' encoded
            "api%2fadmin_credential.json",     # separator encoded
            "%41%50I/stats.json",              # encoded + case
            "x/..%2fapi/config.json",          # encoded traversal
        ):
            self.assertTrue(dev_server._is_forbidden_static(p), f"should block: {p!r}")

    def test_blocks_other_secret_roots(self):
        """secrets/ holds the Ed25519 signing seeds — leaking one lets an attacker sign
        a plugin or release every installation trusts."""
        for p in (
            "secrets/marketplace-signing-seed.hex",
            "secrets",
            "%73ecrets/marketplace-signing-seed.hex",
            "logs/dev-server.log",
            "backups/pre-update",
            ".git/config",
            "api/page-drafts/home.json",       # unpublished page drafts
        ):
            self.assertTrue(dev_server._is_forbidden_static(p), f"should block: {p!r}")

    def test_allows_normal_assets(self):
        for p in (
            "index.html",
            "js/core/utils.js",
            "css/base.css",
            "DATA_WEB/fixed/x/metadata.json",
            "DATA_WEB/catalog.json",
            "viewer.html",
            "lang/en.json",
            "apiclient.js",             # not under api/ despite the prefix
        ):
            self.assertFalse(dev_server._is_forbidden_static(p), f"should allow: {p!r}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
