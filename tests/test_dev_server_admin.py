"""Unit tests for the v1.4.0 admin features in dev_server.py:
usage statistics, plugin enable/disable (last-shader guard), version parsing, and
the dataset `hidden` flag excluding a dataset from the public catalog.

Run: py tests/test_dev_server_admin.py
"""
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


class TestStats(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._orig = dev_server.STATS_FILE
        dev_server.STATS_FILE = self.tmp / "stats.json"

    def tearDown(self):
        dev_server.STATS_FILE = self._orig
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_counts_under_plural_fields(self):
        dev_server._record_event("visit")
        dev_server._record_event("view", "fixed/foo")
        dev_server._record_event("view", "fixed/foo")
        dev_server._record_event("download", "fixed/foo")
        s = dev_server._load_stats()
        self.assertEqual(s["global"]["visits"], 1)
        self.assertEqual(s["global"]["views"], 2)
        self.assertEqual(s["global"]["downloads"], 1)
        self.assertEqual(s["datasets"]["fixed/foo"]["views"], 2)
        self.assertEqual(s["datasets"]["fixed/foo"]["downloads"], 1)
        # one daily bucket, mirroring the global totals
        day = next(iter(s["daily"].values()))
        self.assertEqual(day, {"visits": 1, "views": 2, "downloads": 1})

    def test_visit_is_not_attributed_to_a_dataset(self):
        dev_server._record_event("visit", "fixed/foo")  # dataset id ignored for visits
        s = dev_server._load_stats()
        self.assertNotIn("fixed/foo", s["datasets"])

    def test_bad_kind_is_ignored(self):
        dev_server._record_event("bogus")
        self.assertFalse(dev_server.STATS_FILE.exists())


class TestPluginToggle(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._orig = dev_server.DISABLED_PLUGINS_FILE
        dev_server.DISABLED_PLUGINS_FILE = self.tmp / "disabled-plugins.json"

    def tearDown(self):
        dev_server.DISABLED_PLUGINS_FILE = self._orig
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_last_shader_cannot_be_disabled(self):
        shaders = [p["path"] for p in dev_server._list_plugins() if p.get("placement") == "shaders"]
        self.assertGreaterEqual(len(shaders), 2, "fixture needs >=2 shaders")
        ok, status, _ = dev_server._set_plugin_enabled(shaders[0], False)
        self.assertTrue(ok)
        self.assertIn(shaders[0], dev_server._load_disabled_plugins())
        # disabling the last remaining shader is refused
        ok2, status2, payload2 = dev_server._set_plugin_enabled(shaders[1], False)
        self.assertFalse(ok2)
        self.assertEqual(status2, 409)
        self.assertEqual(payload2.get("error"), "last_shader")
        self.assertNotIn(shaders[1], dev_server._load_disabled_plugins())

    def test_unknown_plugin_rejected(self):
        ok, status, _ = dev_server._set_plugin_enabled("tools/does-not-exist", False)
        self.assertFalse(ok)
        self.assertEqual(status, 404)

    def test_admin_plugins_marks_disabled(self):
        tools = [p["path"] for p in dev_server._list_plugins() if p.get("placement") == "tools"]
        self.assertTrue(tools)
        dev_server._set_plugin_enabled(tools[0], False)
        listing = {p["path"]: p for p in dev_server._admin_plugins()}
        self.assertFalse(listing[tools[0]]["enabled"])


class TestVersion(unittest.TestCase):
    def test_max_version_from_changelog(self):
        v = dev_server._max_version(dev_server.CHANGELOG_DIR)
        self.assertRegex(v, r"^\d+\.\d+\.\d+$")

    def test_version_tuple_ordering(self):
        self.assertGreater(dev_server._version_tuple("1.10.0"), dev_server._version_tuple("1.9.9"))
        self.assertEqual(dev_server._version_tuple("v1.4.0"), (1, 4, 0))

    def test_version_info_shape(self):
        info = dev_server._version_info()
        self.assertIn("web", info)
        self.assertEqual(info["devServer"], dev_server.__version__)
        self.assertEqual(info["repo"], dev_server.GITHUB_REPO)


class TestHiddenCatalog(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._orig_dw = dev_server.DATA_WEB
        dev_server.DATA_WEB = self.tmp / "DATA_WEB"
        # one configured dataset
        ds = dev_server.DATA_WEB / "fixed" / "Demo"
        ds.mkdir(parents=True)
        (ds / "metadata.json").write_text(json.dumps({
            "id": "Demo", "name": "Demo", "type": "fixed", "configured": True,
            "dimensions": {"x": 8, "y": 8, "z": 8, "c": 1},
            "channels": [{"name": "c0"}],
        }), encoding="utf-8")
        dev_server._CATALOG_CACHE["sig"] = None  # force recompute

    def tearDown(self):
        dev_server.DATA_WEB = self._orig_dw
        dev_server._CATALOG_CACHE["sig"] = None
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_hidden_dataset_excluded_from_catalog(self):
        names = [d.get("name") for d in dev_server._build_catalog()]
        self.assertIn("Demo", names)
        ok = dev_server._set_dataset_hidden("fixed/Demo", True)
        self.assertTrue(ok)
        names_after = [d.get("name") for d in dev_server._build_catalog()]
        self.assertNotIn("Demo", names_after, "hidden dataset must drop out of the public catalog")
        # un-hide restores it
        dev_server._set_dataset_hidden("fixed/Demo", False)
        self.assertIn("Demo", [d.get("name") for d in dev_server._build_catalog()])


if __name__ == "__main__":
    unittest.main(verbosity=2)
