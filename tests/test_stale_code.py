"""The code that EXECUTES knows its own release (web 1.84.1).

A checkout keeps a placeholder ("unstamped"): no verdict, no refusal. The release
build stamps dev_server.py and api/_admin_lib.php; a stamped server whose changelog
folder holds a newer version has code older than its files: the `version` answer
says so, install/update are refused with 409 stale_server_code, an entry for a
placement the platform does not host is 409 unsupported_placement and is listed as
incompatible. PHP twin: tests/test_stale_code_php.php.

Run: python tests/test_stale_code.py
"""
import shutil
import sys
import tempfile
import os
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

import dev_server as ds            # noqa: E402
import build_release as br         # noqa: E402


class _Fixture(unittest.TestCase):
    """Point dev_server at a throwaway changelog folder and a chosen stamp."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        for v in ("1.2.0", "1.3.0"):
            (self.tmp / f"changelog_{v}.md").write_text(f"# {v}\n", encoding="utf-8")
        self._orig = (ds.CHANGELOG_DIR, ds._CODE_VERSION, ds._MARKETPLACE_CATALOG_URL)
        ds.CHANGELOG_DIR = self.tmp

    def tearDown(self):
        ds.CHANGELOG_DIR, ds._CODE_VERSION, ds._MARKETPLACE_CATALOG_URL = self._orig
        shutil.rmtree(self.tmp, ignore_errors=True)


class UnstampedTests(_Fixture):
    def test_checkout_is_unstamped(self):
        # The shipped source holds the placeholder, never a version.
        self.assertIn("@@LUMEN_CODE_VERSION@@", (ROOT / "dev_server.py").read_text(encoding="utf-8"))
        self.assertIsNone(ds._code_version())

    def test_no_verdict_no_refusal(self):
        ds._CODE_VERSION = "@@LUMEN_CODE_VERSION@@"
        st = ds._code_status()
        self.assertFalse(st["stale"])
        self.assertIsNone(st["codeVersion"])
        self.assertEqual(st["filesVersion"], "1.3.0")
        self.assertIsNone(st["diagnosis"])
        self.assertIsNone(ds._stale_code_problem())
        info = ds._version_info()
        self.assertFalse(info["codeStale"])
        self.assertIsNone(info["codeDiagnosis"])
        self.assertEqual(info["filesVersion"], "1.3.0")

    def test_install_is_not_refused_as_stale(self):
        ds._CODE_VERSION = "@@LUMEN_CODE_VERSION@@"
        ds._MARKETPLACE_CATALOG_URL = ""
        ok, status, payload = ds._install_marketplace_plugin("x", "pw")
        self.assertEqual((status, payload["error"]), (400, "marketplace_not_configured"))


class StampedTests(_Fixture):
    def test_matching_stamp_is_not_stale(self):
        ds._CODE_VERSION = "1.3.0"
        st = ds._code_status()
        self.assertEqual((st["codeVersion"], st["stale"]), ("1.3.0", False))
        self.assertIsNone(ds._stale_code_problem())

    def test_mismatch_is_reported(self):
        ds._CODE_VERSION = "1.2.0"
        info = ds._version_info()
        self.assertTrue(info["codeStale"])
        self.assertEqual((info["codeVersion"], info["filesVersion"]), ("1.2.0", "1.3.0"))
        self.assertEqual(info["codeDiagnosis"], {"backend": "python", "action": "restart", "direction": "code_older"})

    def test_code_newer_than_files_says_so(self):
        ds._CODE_VERSION = "1.4.0"
        st = ds._code_status()
        self.assertTrue(st["stale"])
        self.assertEqual(st["diagnosis"]["direction"], "code_newer")
        self.assertEqual(ds._stale_code_problem()["error"], "stale_server_code")

    def test_a_refusal_before_the_password_check_does_not_reset_the_throttle(self):
        # The route clears the login counter only for an answer that checked the password.
        src = Path(ds.__file__).read_text(encoding="utf-8")
        i = src.index('elif action in ("install_plugin", "update_plugin"):')
        block = src[i:i + 900]
        self.assertIn('"stale_server_code"', block)
        self.assertIn("_brute_clear(ip)", block)
        self.assertLess(block.index('"stale_server_code"'), block.index("_brute_clear(ip)"))

    def test_install_and_update_refused_before_anything_else(self):
        ds._CODE_VERSION = "1.2.0"
        ds._MARKETPLACE_CATALOG_URL = "https://example.invalid/catalog.json"   # would otherwise try the network
        for upgrade in (False, True):
            ok, status, payload = ds._install_marketplace_plugin("anything", "wrong-password", upgrade=upgrade)
            self.assertFalse(ok)
            self.assertEqual(status, 409)
            self.assertEqual(payload, {"error": "stale_server_code", "codeVersion": "1.2.0", "filesVersion": "1.3.0"})

    def test_malformed_stamp_is_unstamped(self):
        for bad in ("1.2", "x.y.z", "", "@@LUMEN_CODE_VERSION@@"):
            self.assertIsNone(ds._code_version(bad), bad)


class PlacementTests(_Fixture):
    def test_hosted_placements_pass(self):
        for placement in ("tools", "channels", "shaders", "studio"):
            self.assertIsNone(ds._entry_install_problem({"id": "p", "placement": placement}), placement)

    def test_unknown_placement(self):
        status, payload = ds._entry_install_problem({"id": "adv", "placement": "widgets"})
        self.assertEqual((status, payload), (409, {"error": "unsupported_placement", "placement": "widgets"}))
        status, payload = ds._entry_install_problem({"id": "adv"})
        self.assertEqual(payload["error"], "unsupported_placement")

    def test_malformed_id_stays_bad_plugin_id(self):
        self.assertEqual(ds._entry_install_problem({"id": "../x", "placement": "tools"}), (400, {"error": "bad_plugin_id"}))
        self.assertEqual(ds._entry_install_problem({"id": "../x", "placement": "widgets"})[1]["error"], "bad_plugin_id")

    def test_listing_marks_unknown_placement_incompatible(self):
        ds._CODE_VERSION = "@@LUMEN_CODE_VERSION@@"
        ds._MARKETPLACE_CATALOG_URL = "https://example.invalid/catalog.json"
        orig = ds._fetch_marketplace_catalog
        ds._fetch_marketplace_catalog = lambda: [
            {"id": "adv", "placement": "widgets", "platformCompat": ">=1.0.0", "latestVersion": "1.0.0"},
            {"id": "ok", "placement": "studio", "platformCompat": ">=1.0.0", "latestVersion": "1.0.0"},
        ]
        try:
            rows = {r["id"]: r for r in ds._marketplace_list()["plugins"]}
        finally:
            ds._fetch_marketplace_catalog = orig
        self.assertFalse(rows["adv"]["compat"])
        self.assertIn("widgets", rows["adv"]["compatReason"])
        self.assertTrue(rows["ok"]["compat"])


class BuildStampTests(unittest.TestCase):
    def _real(self):
        return {a: (ROOT / a).read_bytes() for a in br.CODE_VERSION_FILES}

    def test_placeholder_is_replaced_exactly_once_in_each_file(self):
        by_name = self._real()
        for data in by_name.values():
            self.assertEqual(data.count(br.CODE_VERSION_PLACEHOLDER.encode()), 1)
        br.stamp_code_version(by_name, "9.8.7")
        for arc, data in by_name.items():
            self.assertNotIn(br.CODE_VERSION_PLACEHOLDER.encode(), data, arc)
            self.assertEqual(data.count(b"9.8.7") >= 1, True, arc)
        py = by_name["dev_server.py"].decode("utf-8")
        self.assertIn('_CODE_VERSION = "9.8.7"', py)
        php = by_name["api/_admin_lib.php"].decode("utf-8")
        self.assertIn("const LUMEN_CODE_VERSION = '9.8.7';", php)
        compile(py, "dev_server.py", "exec")

    def test_build_fails_when_the_placeholder_is_missing_or_duplicated(self):
        marker = br.CODE_VERSION_PLACEHOLDER.encode()
        missing = self._real()
        missing["dev_server.py"] = missing["dev_server.py"].replace(marker, b"1.0.0")
        with self.assertRaises(ValueError):
            br.stamp_code_version(missing, "9.8.7")
        twice = self._real()
        twice["api/_admin_lib.php"] += b"\n// " + marker + b"\n"
        with self.assertRaises(ValueError):
            br.stamp_code_version(twice, "9.8.7")
        absent = self._real()
        del absent["api/_admin_lib.php"]
        with self.assertRaises(ValueError):
            br.stamp_code_version(absent, "9.8.7")
        with self.assertRaises(ValueError):
            br.stamp_code_version(self._real(), "9.8")

    def test_stamp_must_equal_the_newest_shipped_changelog(self):
        by_name = self._real()
        by_name["changelog/changelog_9.8.7.md"] = b"# 9.8.7"
        by_name["changelog/changelog_9.8.8.md"] = b"# 9.8.8"
        with self.assertRaises(ValueError):
            br.stamp_code_version(by_name, "9.8.7")
        br.stamp_code_version(by_name, "9.8.8")
        self.assertIn(b"9.8.8", by_name["dev_server.py"])

    def test_both_files_are_in_the_release(self):
        shipped = {a for a, _ in br.collect_files(ROOT)}
        for arc in br.CODE_VERSION_FILES:
            self.assertIn(arc, shipped)


class CodeManifestTests(unittest.TestCase):
    """api/code-manifest.json: which shipped PHP file differs, hashed after stamping."""

    def _tree(self):
        by_name = {a: (ROOT / a).read_bytes() for a in br.CODE_VERSION_FILES}
        by_name["api/admin.php"] = b"<?php // admin"
        by_name["router.php"] = b"<?php // router"
        by_name["install.php"] = b"<?php // installer"
        by_name["api/.htaccess"] = b"Deny from all"
        by_name["js/app.js"] = b"x"
        return by_name

    def test_manifest_hashes_the_stamped_php_files(self):
        import hashlib, json
        by_name = self._tree()
        br.stamp_code_version(by_name, "9.8.7")
        br.build_code_manifest(by_name, "9.8.7")
        doc = json.loads(by_name["api/code-manifest.json"])
        self.assertEqual(doc["version"], "9.8.7")
        self.assertEqual(sorted(doc["files"]), ["api/_admin_lib.php", "api/admin.php", "router.php"])
        self.assertEqual(doc["files"]["api/_admin_lib.php"], hashlib.sha256(by_name["api/_admin_lib.php"]).hexdigest())
        self.assertIn(b"const LUMEN_CODE_VERSION = '9.8.7';", by_name["api/_admin_lib.php"])
        self.assertNotIn("install.php", doc["files"])
        self.assertNotIn("api/code-manifest.json", doc["files"])
        raw = by_name["api/code-manifest.json"].decode("utf-8")
        self.assertEqual(raw, json.dumps(doc, sort_keys=True, separators=(",", ":")))

    def test_build_fails_without_any_api_php(self):
        with self.assertRaises(ValueError):
            br.build_code_manifest({"router.php": b"<?php"}, "9.8.7")

    def test_manifest_passes_the_api_allowlist_and_is_not_protected(self):
        from pathlib import PurePosixPath
        self.assertFalse(br.is_excluded(PurePosixPath("api/code-manifest.json")))
        src = (ROOT / "api" / "_admin_lib.php").read_text(encoding="utf-8")
        self.assertNotIn("code-manifest", src[src.index("function admin_update_protected"):src.index("const ADMIN_UPDATE_OBSOLETE")])
        self.assertNotIn("code-manifest", Path(ds.__file__).read_text(encoding="utf-8")[Path(ds.__file__).read_text(encoding="utf-8").index("_UPDATE_PROTECT"):][:3000])


class PermissionRepairKeysTests(unittest.TestCase):
    def test_repair_reports_what_it_could_not_change(self):
        import tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "api").mkdir()
            (root / "api" / "late.php").write_text("<?php\n", encoding="utf-8")
            (root / "dev_server.py").write_text("x = 1\n", encoding="utf-8")
            (root / "other.txt").write_text("x", encoding="utf-8")
            real_chmod = Path.chmod

            def chmod(self, mode, *a, **k):
                if self.name == "other.txt":
                    raise PermissionError("not the owner")
                return real_chmod(self, mode, *a, **k)

            with mock.patch.object(ds, "ROOT", root),                  mock.patch.object(Path, "chmod", chmod),                  mock.patch.object(ds.os, "access", lambda p, m, **k: False):
                out = ds._apply_tree_modes()
        if os.name != "posix":
            self.assertEqual(out["failedPaths"], [])
            self.assertEqual(out["codeUnwritable"], [])
            return
        self.assertIn("other.txt", out["failedPaths"])
        self.assertEqual(out["failed"], len(out["failedPaths"]))
        self.assertLessEqual(len(out["failedPaths"]), 20)
        self.assertEqual(sorted(out["codeUnwritable"]), ["api/late.php", "dev_server.py"])
        for k in ("fixed", "failed", "scanned", "dirMode", "fileMode", "split"):
            self.assertIn(k, out)

    def test_python_answer_has_no_reinstall(self):
        self.assertFalse(ds._version_info()["reinstallSupported"])


if __name__ == "__main__":
    unittest.main()
