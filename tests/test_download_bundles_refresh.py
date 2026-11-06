"""tools/build_download_bundles.py --refresh-web, what the preprocessing pipeline runs right
after it (re)publishes a dataset: the web archive and the README are rebuilt from the
published bricks and metadata; the .ims link (and the TIFF/MIPs made from it) is kept
while the source .ims is the same file, and rebuilt when the source was replaced.

Run: python tests/test_download_bundles_refresh.py
"""
import argparse
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

try:
    import numpy  # noqa: F401  (imported at the top of the tool)
except Exception as exc:  # pragma: no cover
    print(f"SKIP: numpy unavailable ({exc})")
    sys.exit(0)


def _load_tool():
    spec = importlib.util.spec_from_file_location("lumen_build_download_bundles_refresh",
                                                  str(ROOT / "tools" / "build_download_bundles.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


BDB = _load_tool()


def _args(ims, **over):
    base = dict(no_archive=False, no_ims=False, no_tiff=True, no_mip=True, force=False,
                refresh_web=False, dry_run=False, timepoint=0, ims=str(ims))
    base.update(over)
    return argparse.Namespace(**base)


class RefreshWeb(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-dlrefresh-"))
        self.data_web = self.tmp / "DATA_WEB"
        self.ds_dir = self.data_web / "3d" / "ds"
        (self.ds_dir / "bricks").mkdir(parents=True)
        self.src = self.tmp / "raw" / "ds.ims"
        self.src.parent.mkdir()
        self.src.write_bytes(b"IMS-v1" * 100)
        self._publish("manifest-v1", "Alpha")
        self._saved_data_web = BDB.DATA_WEB
        BDB.DATA_WEB = self.data_web

    def tearDown(self):
        BDB.DATA_WEB = self._saved_data_web
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _publish(self, manifest, channel):
        (self.ds_dir / "bricks" / "manifest.json").write_text(manifest, encoding="utf-8")
        (self.ds_dir / "metadata.json").write_text(json.dumps({
            "type": "3d", "id": "3d/ds", "channels": [{"name": channel, "color": "#00ff00"}],
            "dimensions": {"x": 4, "y": 4, "z": 2, "c": 1, "t": 1}}), encoding="utf-8")

    def _run(self, **over):
        ds = BDB.load_datasets(exact_id="3d/ds")[0]
        BDB.process(ds, _args(self.src, **over))

    def _zip_manifest(self):
        with zipfile.ZipFile(self.ds_dir / "download" / "ds_web.zip") as zf:
            return zf.read("ds/bricks/manifest.json").decode("utf-8")

    def _readme(self):
        return (self.ds_dir / "download" / "README.txt").read_text(encoding="utf-8")

    def test_republication_refreshes_the_archive_and_readme_only(self):
        self._run()
        placed = self.ds_dir / "download" / "ds.ims"
        self.assertEqual(self._zip_manifest(), "manifest-v1")
        self.assertIn("Alpha", self._readme())
        before = placed.stat()

        self._publish("manifest-v2", "Beta")
        self._run()                                      # no flag: idempotent, stale
        self.assertEqual(self._zip_manifest(), "manifest-v1")

        self._run(refresh_web=True)
        self.assertEqual(self._zip_manifest(), "manifest-v2")
        self.assertIn("Beta", self._readme())
        self.assertNotIn("Alpha", self._readme())
        after = placed.stat()
        self.assertEqual((before.st_ino, before.st_mtime_ns), (after.st_ino, after.st_mtime_ns),
                         "an unchanged source .ims is left alone")
        self.assertTrue(BDB._same_file(self.src, placed))

    def test_replaced_source_is_placed_again(self):
        self._run()
        placed = self.ds_dir / "download" / "ds.ims"
        self.assertEqual(placed.read_bytes(), self.src.read_bytes())
        # A re-export: a new file at the same path, another size.
        self.src.unlink()
        self.src.write_bytes(b"IMS-v2" * 150)
        self.assertTrue(BDB.source_changed(self.src, placed, []))
        self._run(refresh_web=True)
        self.assertEqual(placed.read_bytes(), b"IMS-v2" * 150)
        self.assertFalse(BDB.source_changed(self.src, placed, []))

    def test_source_changed_without_a_placed_copy_reads_the_artefacts_age(self):
        dl = self.ds_dir / "download"
        dl.mkdir()
        tiff = dl / "ds.tif"
        tiff.write_bytes(b"tif")
        old = time.time() - 3600
        os.utime(tiff, (old, old))
        self.assertTrue(BDB.source_changed(self.src, dl / "ds.ims", [tiff]))
        new = time.time() + 3600
        os.utime(tiff, (new, new))
        self.assertFalse(BDB.source_changed(self.src, dl / "ds.ims", [tiff]))
        self.assertFalse(BDB.source_changed(self.src, dl / "ds.ims", [dl / "absent.tif"]))

    def test_run_preprocess_passes_the_flag(self):
        text = (ROOT / "preprocess" / "run_preprocess.py").read_text(encoding="utf-8")
        self.assertIn('"--refresh-web"', text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
