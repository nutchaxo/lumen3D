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


def _load_publisher():
    """tools/publish_plugin.py exits at import when the platform has no catalog URL."""
    try:
        import tools.publish_plugin as pp
    except SystemExit:
        return None
    return pp


class PublisherPathSafetyTests(unittest.TestCase):
    """The publisher and the builder take the id and version from plugin.json and turn
    them into folder / file names they write and delete: an id such as "." would name
    marketplace/plugins itself, ".." the whole marketplace."""

    BAD_IDS = (".", "..", "a/b", r"a\b", "C:/x", "C:x", "../../js", "", "x\n", 7, None)
    BAD_VERSIONS = ("../x", "1..0", "1/0", r"1\0", "", ".1", "1.0\n", 1)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.market = self.tmp / "marketplace"
        (self.market / "plugins" / "existing").mkdir(parents=True)
        (self.market / "plugins" / "existing" / "SHA256SUMS").write_text("keep", encoding="utf-8")
        self.catalog = self.market / "marketplace-catalog.json"
        self.catalog.write_text(json.dumps({"version": 1, "plugins": [{"id": "existing"}]}),
                                encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _snapshot(self):
        return sorted((p.relative_to(self.tmp).as_posix(),
                       p.read_bytes() if p.is_file() else None)
                      for p in self.tmp.rglob("*"))

    def _plugin(self, name, meta):
        src = self.tmp / "src" / name
        src.mkdir(parents=True)
        (src / "plugin.json").write_text(json.dumps(meta), encoding="utf-8")
        (src / "index.js").write_text("//x", encoding="utf-8")
        return src

    def test_rules(self):
        for good in ("screenshot", "tracking-trails", "a.b_c-1", "_x"):
            self.assertIsNone(bpr.id_problem(good), good)
        for bad in self.BAD_IDS:
            self.assertIsNotNone(bpr.id_problem(bad), repr(bad))
        for good in ("1.0.0", "1.2.3-beta.1", "2.0.0+build.5"):
            self.assertIsNone(bpr.version_problem(good), good)
        for bad in self.BAD_VERSIONS:
            self.assertIsNotNone(bpr.version_problem(bad), repr(bad))

    def test_build_refuses_bad_id_and_version_before_writing(self):
        cases = [{"id": i, "version": "1.0.0"} for i in self.BAD_IDS if i]
        cases += [{"id": "ok", "version": v} for v in self.BAD_VERSIONS if v]
        for n, meta in enumerate(cases):
            src = self._plugin(f"p{n}", meta)
            out = self.tmp / f"out{n}"
            with self.assertRaises(SystemExit, msg=repr(meta)):
                bpr.build(src, out, None)
            self.assertFalse(out.exists(), repr(meta))

    def test_publish_and_remove_leave_the_marketplace_untouched(self):
        pp = _load_publisher()
        if pp is None:
            print("SKIP publisher checks: the platform has no marketplace catalog URL")
            return
        saved = (pp.MARKETPLACE, pp.CATALOG, pp.CATALOG_SIG, pp._seed, pp._push)
        seed = os.urandom(32)
        seed_calls = []

        def fake_seed():
            seed_calls.append(1)
            return seed

        def no_push(_message):
            raise AssertionError("push must not run")

        pp.MARKETPLACE, pp.CATALOG = self.market, self.catalog
        pp.CATALOG_SIG = self.market / "marketplace-catalog.json.sig"
        pp._seed, pp._push = fake_seed, no_push
        try:
            before = self._snapshot()
            cases = [{"id": i, "version": "1.0.0"} for i in self.BAD_IDS if i]
            cases += [{"id": "ok", "version": v} for v in self.BAD_VERSIONS if v]
            for n, meta in enumerate(cases):
                src = self._plugin(f"bad{n}", meta)
                before = self._snapshot()
                with self.assertRaises(SystemExit, msg=repr(meta)):
                    pp.publish(src, None, False)
                self.assertEqual(self._snapshot(), before, repr(meta))
            for bad in (".", "..", "a/b", "C:/x", "../../js"):
                with self.assertRaises(SystemExit, msg=bad):
                    pp.remove(bad, False)
                self.assertEqual(self._snapshot(), before, bad)
            self.assertEqual(seed_calls, [], "validation must come before the signing seed")

            # A valid id still publishes beside the others and unpublishes cleanly.
            src = self._plugin("good", {"id": "good-one", "version": "1.2.0", "placement": "tools"})
            pp.publish(src, None, False)
            published = self.market / "plugins" / "good-one"
            self.assertTrue((published / "plugin-good-one-1.2.0.zip").is_file())
            self.assertFalse((self.market / "plugins" / "good-one.building").exists())
            self.assertTrue((self.market / "plugins" / "existing" / "SHA256SUMS").is_file())
            ids = [e["id"] for e in json.loads(self.catalog.read_text(encoding="utf-8"))["plugins"]]
            self.assertEqual(sorted(ids), ["existing", "good-one"])
            pp.remove("good-one", False)
            self.assertFalse(published.exists())
            self.assertTrue((self.market / "plugins" / "existing" / "SHA256SUMS").is_file())
        finally:
            pp.MARKETPLACE, pp.CATALOG, pp.CATALOG_SIG, pp._seed, pp._push = saved


if __name__ == "__main__":
    unittest.main()
