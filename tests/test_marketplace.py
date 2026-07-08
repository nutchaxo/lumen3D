"""Plugin marketplace — dev_server.py + tools/build_plugin_release.py.

Covers the annotated listing, uninstall path safety, hardened plugin-zip
extraction, the fail-closed signature gate, the build->sign->verify chain, and a
guard that the COMMITTED catalog is always validly signed under the pinned key.
All offline (no network) so it is CI-safe.
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
import dev_server as ds
import ed25519_pure as ed
import tools.build_plugin_release as bpr


class MarketplaceTests(unittest.TestCase):
    def test_list_unconfigured(self):
        orig = ds._MARKETPLACE_CATALOG_URL
        try:
            ds._MARKETPLACE_CATALOG_URL = ""
            out = ds._marketplace_list()
            self.assertFalse(out["configured"])
            self.assertEqual(out["plugins"], [])
        finally:
            ds._MARKETPLACE_CATALOG_URL = orig

    def test_uninstall_path_safety(self):
        self.assertEqual(ds._uninstall_marketplace_plugin("../etc")[1], 400)
        self.assertEqual(ds._uninstall_marketplace_plugin("tools/../../x")[1], 400)
        self.assertEqual(ds._uninstall_marketplace_plugin("bad/placement")[1], 400)
        self.assertEqual(ds._uninstall_marketplace_plugin("tools/does-not-exist-xyz")[1], 404)

    def test_signature_gate(self):
        # unkeyed -> integrity-only no-op (must not raise)
        orig = ds._MARKETPLACE_PUBKEY_HEX
        try:
            ds._MARKETPLACE_PUBKEY_HEX = ""
            ds._verify_marketplace_signature(b"data", None)   # no raise
            # keyed but no signature URL -> fail-closed
            ds._MARKETPLACE_PUBKEY_HEX = "00" * 32
            with self.assertRaises(OSError):
                ds._verify_marketplace_signature(b"data", None)
        finally:
            ds._MARKETPLACE_PUBKEY_HEX = orig

    def test_extract_hardening(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            good = tmp / "good.zip"
            with zipfile.ZipFile(good, "w") as z:
                z.writestr("plugin.json", '{"id":"x","placement":"tools"}')
                z.writestr("index.js", "//x")
            self.assertTrue((ds._extract_plugin_zip(good, tmp / "g") / "plugin.json").exists())

            nested = tmp / "nested.zip"
            with zipfile.ZipFile(nested, "w") as z:
                z.writestr("mp/plugin.json", "{}")
                z.writestr("mp/index.js", "//")
            self.assertEqual(ds._extract_plugin_zip(nested, tmp / "n").name, "mp")

            evil = tmp / "evil.zip"
            with zipfile.ZipFile(evil, "w") as z:
                z.writestr("plugin.json", "{}")
                z.writestr("../evil.js", "pwn")
            with self.assertRaises(OSError):
                ds._extract_plugin_zip(evil, tmp / "e")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_build_sign_verify_chain(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            src = tmp / "myplugin"
            src.mkdir()
            (src / "plugin.json").write_text('{"id":"myplugin","version":"1.0.0","placement":"tools"}', encoding="utf-8")
            (src / "index.js").write_text("//x", encoding="utf-8")
            seed = os.urandom(32)
            pub = ed.publickey(seed)
            out = tmp / "out"
            info = bpr.build(src, out, seed.hex())
            self.assertTrue(info["signed"])
            sums = (out / "SHA256SUMS").read_bytes()
            sig = bytes.fromhex((out / "SHA256SUMS.sig").read_text().strip())
            self.assertTrue(ed.verify(pub, sums, sig))                 # signature valid
            self.assertFalse(ed.verify(pub, sums + b"x", sig))         # tamper rejected
            z1 = (out / info["zip"]).read_bytes()
            bpr.build(src, out, None)                                  # rebuild
            self.assertEqual(z1, (out / info["zip"]).read_bytes())     # deterministic
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_committed_catalog_is_validly_signed(self):
        cat = REPO / "marketplace" / "marketplace-catalog.json"
        sig = REPO / "marketplace" / "marketplace-catalog.json.sig"
        if not (cat.exists() and sig.exists() and ds._MARKETPLACE_PUBKEY_HEX):
            self.skipTest("marketplace catalog not configured/keyed")
        raw = cat.read_bytes()
        signature = bytes.fromhex(sig.read_text().strip())
        self.assertTrue(ed.verify(bytes.fromhex(ds._MARKETPLACE_PUBKEY_HEX), raw, signature),
                        "committed marketplace-catalog.json.sig does not verify under the pinned key")


if __name__ == "__main__":
    unittest.main()
