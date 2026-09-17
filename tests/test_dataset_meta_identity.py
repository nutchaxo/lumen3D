"""The identity fields of a dataset (`id`, `type`, `folderName`) come from the
directory it lives in — on every read and every write of dev_server.py.

The admin editor leaves `type` out of what it posts (the backend is the authority);
`_save_dataset` merges and re-asserts, and `_get_dataset` re-asserts on read so a
metadata.json that lost its type (a PHP host wrote the posted body verbatim before
api/datasets.php learnt to merge — see tests/test_datasets_save_php.php) still
mounts in the editor instead of being refused as "invalid type".

Run: py tests/test_dataset_meta_identity.py
"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dev_server  # noqa: E402


class DatasetMetaIdentity(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._orig_root = dev_server.DATA_WEB
        dev_server.DATA_WEB = self.tmp
        self.ds_dir = self.tmp / "3d" / "demo"
        self.ds_dir.mkdir(parents=True)
        self.pipeline = {
            "id": "3d/demo", "type": "3d", "name": "Demo", "stage": "E8.5",
            "dimensions": {"x": 64, "y": 64, "z": 32, "c": 2},
            "channels": [{"name": "DAPI"}, {"name": "GFP"}],
            "volumeSources": [{"kind": "bricks", "path": "DATA_WEB/3d/demo"}],
        }

    def tearDown(self):
        dev_server.DATA_WEB = self._orig_root
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, doc):
        (self.ds_dir / "metadata.json").write_text(json.dumps(doc), encoding="utf-8")

    def _stored(self):
        return json.loads((self.ds_dir / "metadata.json").read_text(encoding="utf-8"))

    def test_get_reasserts_identity_from_directory(self):
        damaged = dict(self.pipeline)
        for k in ("id", "type", "folderName"):
            damaged.pop(k, None)
        self._write(damaged)
        meta = dev_server._get_dataset("3d/demo")
        self.assertEqual(meta["type"], "3d")
        self.assertEqual(meta["id"], "3d/demo")
        self.assertEqual(meta["folderName"], "demo")

    def test_get_overrides_a_wrong_stored_type(self):
        self._write({**self.pipeline, "type": "volume"})
        self.assertEqual(dev_server._get_dataset("3d/demo")["type"], "3d")

    def test_save_without_type_keeps_type(self):
        self._write(self.pipeline)
        posted = {k: v for k, v in self.pipeline.items() if k != "type"}
        posted["name"] = "Demo (oriented)"
        posted["orientation"] = {"x": 0, "y": 0.7071, "z": 0, "w": 0.7071}
        self.assertTrue(dev_server._save_dataset("3d/demo", posted))
        m = self._stored()
        self.assertEqual(m["type"], "3d")
        self.assertEqual(m["id"], "3d/demo")
        self.assertEqual(m["folderName"], "demo")
        self.assertEqual(m["name"], "Demo (oriented)")
        self.assertIn("volumeSources", m)          # merge, not overwrite
        self.assertTrue(m["configured"])

    def test_save_posted_type_never_wins(self):
        self._write(self.pipeline)
        self.assertTrue(dev_server._save_dataset("3d/demo", {"type": "volume"}))
        self.assertEqual(self._stored()["type"], "3d")

    # ── Files already damaged are repaired on disk at boot, nobody re-saves them ──
    def _boot_env(self):
        # The boot pass also looks at uploads/, stats and config: point them at the
        # sandbox so a clean, non-legacy tree is what it sees.
        saved = {k: getattr(dev_server, k) for k in ("UPLOADS_DIR", "STATS_FILE", "CONFIG_DIR", "INSTANCE_FILE")}
        dev_server.UPLOADS_DIR = self.tmp / "uploads"
        dev_server.STATS_FILE = self.tmp / "api" / "stats.json"
        dev_server.CONFIG_DIR = self.tmp / "config"
        dev_server.INSTANCE_FILE = dev_server.CONFIG_DIR / "instance.json"
        self.addCleanup(lambda: [setattr(dev_server, k, v) for k, v in saved.items()])

    def test_boot_repairs_a_file_that_lost_its_type(self):
        self._boot_env()
        damaged = {k: v for k, v in self.pipeline.items() if k not in ("type", "id")}
        self._write(damaged)
        log = dev_server._migrate_dataset_types()
        self.assertEqual(log, ["metadata 3d/demo"], "the repair is reported, nothing else is touched")
        m = self._stored()
        self.assertEqual(m["type"], "3d")
        self.assertEqual(m["id"], "3d/demo")
        self.assertEqual(m["name"], "Demo", "the rest of the file is untouched")
        self.assertEqual(dev_server._migrate_dataset_types(), [], "idempotent: a second boot has nothing to do")

    def test_boot_leaves_a_sound_file_alone(self):
        self._boot_env()
        self._write(self.pipeline)
        before = (self.ds_dir / "metadata.json").read_bytes()
        self.assertEqual(dev_server._migrate_dataset_types(), [])
        self.assertEqual((self.ds_dir / "metadata.json").read_bytes(), before, "not rewritten, not even reformatted")


if __name__ == "__main__":
    unittest.main(verbosity=1)
