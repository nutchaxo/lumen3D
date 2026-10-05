"""Marketplace catalog anti-rollback (web 1.59.0), both backends + the publisher.

The signed marketplace catalog carried no freshness: whoever could serve an older,
still validly signed catalog could pin a host to plugin versions with known flaws.
tools/publish_plugin.py now stamps a monotonically increasing `serial` (+ `issuedAt`)
into the signed document; a host remembers the highest serial it accepted
(api/marketplace-state.json, update-protected) and refuses a lower one with
`catalog_rollback` (dev_server._marketplace_check_serial / api/_admin_lib.php
mkt_check_serial). Only a signature-proven catalog may raise the stored serial.

Run: python tests/test_v3_minor_marketplace_serial.py
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import dev_server as ds  # noqa: E402
import ed25519_pure as ed  # noqa: E402
import tools.publish_plugin as pub  # noqa: E402
from v3_minor_support import PhpTwin  # noqa: E402


class HostSerial(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-mkt-"))
        self.seed = os.urandom(32)
        self.patches = [
            mock.patch.object(ds, "MARKETPLACE_STATE_FILE", self.tmp / "marketplace-state.json"),
            mock.patch.object(ds, "_MARKETPLACE_PUBKEY_HEX", ed.publickey(self.seed).hex()),
            mock.patch.object(ds, "_MARKETPLACE_CATALOG_URL", "https://example.invalid/marketplace-catalog.json"),
            mock.patch.object(ds, "_fetch_url_bytes", self.fake_fetch),
        ]
        for p in self.patches:
            p.start()
        self.served = b""

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake_fetch(self, url, limit=0):
        if url.endswith(".sig"):
            return ed.sign(self.seed, self.served).hex().encode()
        return self.served

    def serve(self, **doc):
        self.served = json.dumps({"version": 1, "plugins": [], **doc}).encode()

    def stored(self):
        return json.loads((self.tmp / "marketplace-state.json").read_text())["highestSerial"]

    def test_lower_serial_is_refused(self):
        self.serve(serial=5, issuedAt="2026-10-05T00:00:00Z")
        self.assertEqual(ds._fetch_marketplace_catalog(), [])
        self.assertEqual(self.stored(), 5)
        self.serve(serial=5)
        ds._fetch_marketplace_catalog()                     # the same catalog again: fine
        self.serve(serial=4)
        with self.assertRaises(ds.MarketplaceRollback) as ctx:
            ds._fetch_marketplace_catalog()
        self.assertEqual((ctx.exception.offered, ctx.exception.seen), (4, 5))
        self.serve()                                        # no serial = a pre-serial catalog = 0
        with self.assertRaises(ds.MarketplaceRollback):
            ds._fetch_marketplace_catalog()
        out = ds._marketplace_list()
        self.assertEqual(out["error"], "catalog_rollback")
        self.assertEqual(out["rollback"], {"offered": 0, "seen": 5})
        self.assertEqual(out["plugins"], [])
        self.serve(serial=6)
        ds._fetch_marketplace_catalog()
        self.assertEqual(self.stored(), 6)

    def test_install_refuses_a_rolled_back_catalog(self):
        self.serve(serial=3)
        ds._fetch_marketplace_catalog()
        self.serve(serial=2)
        with mock.patch.object(ds, "_verify_password", lambda *a: True):
            ok, status, payload = ds._install_marketplace_plugin("anything", "pw")
        self.assertFalse(ok)
        self.assertEqual((status, payload["error"]), (502, "catalog_rollback"))

    def test_malformed_serials_are_refused(self):
        for bad in ("7", -1, True, 1.5):
            self.serve(serial=bad)
            with self.assertRaises(OSError, msg=repr(bad)):
                ds._fetch_marketplace_catalog()
        self.assertFalse((self.tmp / "marketplace-state.json").exists())

    def test_an_unkeyed_host_never_raises_the_stored_serial(self):
        with mock.patch.object(ds, "_MARKETPLACE_PUBKEY_HEX", ""):
            self.serve(serial=10 ** 9)
            ds._fetch_marketplace_catalog()
        self.assertFalse((self.tmp / "marketplace-state.json").exists())

    def test_the_state_file_is_update_protected(self):
        self.assertIn("api/marketplace-state.json", ds._UPDATE_PROTECT)
        src = (ROOT / "api" / "_admin_lib.php").read_text(encoding="utf-8")
        self.assertIn("'api/marketplace-state.json'", src)

    def test_php_twin_agrees(self):
        twin = PhpTwin(self.tmp / "php", ["_admin_lib.php"])
        if not twin.available():
            self.skipTest("no php interpreter")
        got = twin.call(
            {"fn": "mkt_check_serial", "args": [{"serial": 5, "issuedAt": "x"}]},
            {"fn": "mkt_check_serial", "args": [{"serial": 5}]},
            {"fn": "mkt_check_serial", "args": [{"serial": 4}]},
            {"fn": "mkt_rollback_info", "args": []},
            {"fn": "mkt_check_serial", "args": [{}]},
            {"fn": "mkt_check_serial", "args": [{"serial": "7"}]},
            {"fn": "mkt_check_serial", "args": [{"serial": -1}]},
            {"fn": "mkt_check_serial", "args": [{"serial": 6}]},
        )
        self.assertEqual(got[:3], [None, None, "catalog_rollback"])
        self.assertEqual(got[3], {"offered": 4, "seen": 5})
        self.assertEqual(got[4:], ["catalog_rollback", "catalog_invalid_serial", "catalog_invalid_serial", None])
        state = json.loads((self.tmp / "php" / "api" / "marketplace-state.json").read_text())
        self.assertEqual(state["highestSerial"], 6)


class PublisherSerial(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-mkt-pub-"))
        self.seed = os.urandom(32)
        self.patches = [mock.patch.object(pub, "CATALOG", self.tmp / "marketplace-catalog.json"),
                        mock.patch.object(pub, "CATALOG_SIG", self.tmp / "marketplace-catalog.json.sig")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def catalog(self):
        raw = (self.tmp / "marketplace-catalog.json").read_bytes()
        sig = bytes.fromhex((self.tmp / "marketplace-catalog.json.sig").read_text().strip())
        self.assertTrue(ed.verify(ed.publickey(self.seed), raw, sig))
        return json.loads(raw)

    def test_serial_rises_on_change_only(self):
        cat = {"version": 1, "plugins": [{"id": "a", "placement": "tools"}]}
        self.assertTrue(pub._write_signed_catalog(cat, self.seed))
        first = self.catalog()
        self.assertEqual(first["serial"], 1)
        self.assertRegex(first["issuedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(list(first)[:4], ["version", "serial", "issuedAt", "plugins"])
        before = (self.tmp / "marketplace-catalog.json").read_bytes()
        self.assertFalse(pub._write_signed_catalog(pub._load_catalog(), self.seed), "unchanged: no rewrite")
        self.assertEqual((self.tmp / "marketplace-catalog.json").read_bytes(), before)
        cat = pub._load_catalog()
        cat["plugins"].append({"id": "b", "placement": "tools"})
        self.assertTrue(pub._write_signed_catalog(cat, self.seed))
        self.assertEqual(self.catalog()["serial"], 2)
        self.assertTrue(pub._write_signed_catalog(pub._load_catalog(), self.seed, force=True))
        self.assertEqual(self.catalog()["serial"], 3)

    def test_committed_catalog_carries_a_serial(self):
        cat = json.loads((ROOT / "marketplace" / "marketplace-catalog.json").read_text(encoding="utf-8"))
        self.assertIsInstance(cat.get("serial"), int)
        self.assertGreaterEqual(cat["serial"], 1)
        self.assertIsInstance(cat.get("issuedAt"), str)


if __name__ == "__main__":
    unittest.main(verbosity=2)
