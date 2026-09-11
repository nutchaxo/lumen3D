"""The retirement of the `tracking` dataset type (web v1.53.0).

A tracked timelapse always lived under DATA_WEB/live/ with its tracks beside the
bricks; DATA_WEB/tracking/ only ever held what install.php seeded. The one-shot
migration must:
  * remove an EMPTY DATA_WEB/tracking (and its staging twin), and only then;
  * leave a non-empty one exactly where it is, saying so;
  * drop pageTitles.tracking / nav.showTracking / datasetTypes.tracking from
    config/instance.json without touching anything else;
  * re-point explorer.html?type=tracking links in config/pages/ to the timelapses;
  * be a no-op the second time (and on a clean tree).

Run: python -m unittest tests.test_migrate_tracking_type
"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import dev_server  # noqa: E402


class TrackingTypeRetirement(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.saved = {k: getattr(dev_server, k) for k in
                      ("DATA_WEB", "UPLOADS_DIR", "STATS_FILE", "CONFIG_DIR", "INSTANCE_FILE")}
        dev_server.DATA_WEB = self.tmp / "DATA_WEB"
        dev_server.UPLOADS_DIR = self.tmp / "uploads"
        dev_server.STATS_FILE = self.tmp / "api" / "stats.json"
        dev_server.CONFIG_DIR = self.tmp / "config"
        dev_server.INSTANCE_FILE = dev_server.CONFIG_DIR / "instance.json"
        for t in ("3d", "2d", "live"):
            (dev_server.DATA_WEB / t).mkdir(parents=True)
        (dev_server.UPLOADS_DIR / "staging").mkdir(parents=True)
        (dev_server.UPLOADS_DIR / "state").mkdir(parents=True)
        (dev_server.CONFIG_DIR / "pages").mkdir(parents=True)
        dev_server._CATALOG_CACHE["sig"] = None

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(dev_server, k, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _instance(self, **extra):
        doc = {
            "pageTitles": {"home": "Home", "tracking": "Cell Tracking", "2d": "Photos"},
            "nav": {"showExplorer": True, "showTracking": True, "showAbout": False},
            "datasetTypes": {"tracking": {"label": "Suivi"}, "3d": {"label": "Volumes"}},
            "brand": {"name": "Lab"},
        }
        doc.update(extra)
        dev_server.INSTANCE_FILE.write_text(json.dumps(doc), encoding="utf-8")
        return doc

    def test_clean_tree_is_a_no_op(self):
        self.assertFalse(dev_server._legacy_types_present())
        self.assertEqual(dev_server._migrate_dataset_types(), [])

    def test_empty_tracking_dirs_are_removed(self):
        (dev_server.DATA_WEB / "tracking").mkdir()
        (dev_server.DATA_WEB / "tracking" / ".gitkeep").write_text("", encoding="utf-8")
        (dev_server.UPLOADS_DIR / "staging" / "tracking").mkdir()
        self.assertTrue(dev_server._legacy_types_present())
        log = dev_server._migrate_dataset_types()
        self.assertFalse((dev_server.DATA_WEB / "tracking").exists())
        self.assertFalse((dev_server.UPLOADS_DIR / "staging" / "tracking").exists())
        self.assertEqual(sum(1 for line in log if line.startswith("removed empty")), 2)
        self.assertEqual(dev_server._migrate_dataset_types(), [], "idempotent")

    def test_non_empty_tracking_dir_is_left_and_reported(self):
        ds = dev_server.DATA_WEB / "tracking" / "Hand_made"
        ds.mkdir(parents=True)
        (ds / "metadata.json").write_text('{"type": "tracking"}', encoding="utf-8")
        log = dev_server._migrate_dataset_types()
        self.assertTrue((ds / "metadata.json").is_file(), "bytes are never touched")
        # The path is printed relative to ROOT when it is inside it, absolute (OS
        # separators) otherwise — this temp tree is outside.
        self.assertTrue(any(line.startswith("LEFT") and line.replace("\\", "/").rstrip().find("DATA_WEB/tracking") >= 0
                            for line in log), log)
        # Not a type any more: the folder is invisible to the catalog and the id guard.
        self.assertNotIn("tracking", dev_server.ALLOWED_TYPE_DIRS)
        self.assertIsNone(dev_server._safe_dataset_dir("tracking/Hand_made"))

    def test_instance_config_loses_the_retired_keys_only(self):
        self._instance()
        self.assertTrue(dev_server._legacy_types_present())
        log = dev_server._migrate_dataset_types()
        doc = json.loads(dev_server.INSTANCE_FILE.read_text(encoding="utf-8"))
        self.assertEqual(doc["pageTitles"], {"home": "Home", "2d": "Photos"})
        self.assertEqual(doc["nav"], {"showExplorer": True, "showAbout": False})
        self.assertEqual(doc["datasetTypes"], {"3d": {"label": "Volumes"}})
        self.assertEqual(doc["brand"], {"name": "Lab"})
        self.assertTrue(any("pageTitles.tracking dropped" in line and "nav.showTracking dropped" in line
                            and "datasetTypes.tracking dropped" in line for line in log), log)
        self.assertFalse(dev_server._legacy_types_present(), "the guard goes cold")
        self.assertEqual(dev_server._migrate_dataset_types(), [])

    def test_page_links_to_the_retired_filter_open_the_timelapses(self):
        page = dev_server.CONFIG_DIR / "pages" / "home.json"
        page.write_text(json.dumps({"sections": [{"widgets": [
            {"type": "button", "props": {"href": "explorer.html?type=tracking"}},
            {"type": "button", "props": {"href": "explorer.html?type=trackingX"}},
            {"type": "button", "props": {"href": "explorer.html?type=live"}},
        ]}]}), encoding="utf-8")
        self.assertTrue(dev_server._legacy_types_present())
        log = dev_server._migrate_dataset_types()
        text = page.read_text(encoding="utf-8")
        self.assertIn("explorer.html?type=live", text)
        self.assertNotIn("type=tracking\"", text)
        self.assertIn("type=trackingX", text, "a longer word is not the retired type")
        self.assertTrue(any("home.json" in line for line in log), log)
        self.assertEqual(dev_server._migrate_dataset_types(), [])


if __name__ == "__main__":
    unittest.main()
