"""tools/build_download_bundles.py and the visible time range of a timelapse
(metadata.timeRange): the TIFF and MIPs show the first frame a visitor can reach, a TIFF
built on a frame the range now hides is rebuilt, an explicit --timepoint wins, and the
archive / .ims are never cut.

Run: python tests/test_download_bundles_time_range.py
"""
import argparse
import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

try:
    import numpy  # noqa: F401  (imported at the top of the tool)
except Exception as exc:  # pragma: no cover
    print(f"SKIP: numpy unavailable ({exc})")
    sys.exit(0)

spec = importlib.util.spec_from_file_location("lumen_build_download_bundles_range",
                                              str(ROOT / "tools" / "build_download_bundles.py"))
BDB = importlib.util.module_from_spec(spec)
spec.loader.exec_module(BDB)

try:
    import tifffile  # noqa: F401
    HAVE_TIFFFILE = True
except Exception:
    HAVE_TIFFFILE = False


def meta(t=30, window=None):
    m = {"type": "live", "id": "live/ds", "dimensions": {"x": 4, "y": 4, "z": 2, "c": 1, "t": t},
         "channels": [{"name": "A", "color": "#00ff00"}]}
    if window is not None:
        m["timeRange"] = window
    return m


class Reading(unittest.TestCase):
    def test_a_valid_window(self):
        self.assertEqual(BDB.visible_time_range(meta(window={"start": 5, "end": 14})), (5, 14))
        self.assertEqual(BDB.visible_time_range(meta(window={"start": 0, "end": 9})), (0, 9))

    def test_no_window_means_the_whole_series(self):
        for m in (meta(), meta(window=None), meta(window={"start": 0, "end": 29}),
                  meta(window={"start": 5}), meta(window={"start": 9, "end": 3}),
                  meta(window={"start": -1, "end": 4}), meta(window={"start": 2, "end": 30}),
                  meta(window={"start": "2", "end": 9}), meta(window={"start": True, "end": 9}),
                  meta(window=[5, 9]), meta(t=1, window={"start": 0, "end": 0}), {}):
            self.assertIsNone(BDB.visible_time_range(m), m)

    def test_frame_to_show(self):
        self.assertEqual(BDB.resolve_timepoint(meta(window={"start": 5, "end": 14}), None), 5)
        self.assertEqual(BDB.resolve_timepoint(meta(), None), 0)
        self.assertEqual(BDB.resolve_timepoint(meta(window={"start": 5, "end": 14}), 20), 20,
                         "an explicit --timepoint wins")
        self.assertEqual(BDB.resolve_timepoint(meta(window={"start": 5, "end": 14}), 0), 0)


class Process(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-dlrange-"))
        self.data_web = self.tmp / "DATA_WEB"
        self.ds_dir = self.data_web / "live" / "ds"
        (self.ds_dir / "bricks").mkdir(parents=True)
        (self.ds_dir / "bricks" / "manifest.json").write_text("m", encoding="utf-8")
        self.src = self.tmp / "raw" / "ds.ims"
        self.src.parent.mkdir()
        self.src.write_bytes(b"IMS" * 100)
        self._saved = (BDB.DATA_WEB, BDB.build_tiff_and_mips)
        BDB.DATA_WEB = self.data_web
        self.calls = []

        def fake(ims, ds_dir, folder, channels, tiff_path, mip_paths_for, want_tiff,
                 want_mip, force, dry, timepoint=0):
            self.calls.append({"force": force, "timepoint": timepoint})
            return "fake"
        BDB.build_tiff_and_mips = fake

    def tearDown(self):
        BDB.DATA_WEB, BDB.build_tiff_and_mips = self._saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_meta(self, window):
        (self.ds_dir / "metadata.json").write_text(json.dumps(meta(window=window)), encoding="utf-8")

    def _run(self, **over):
        base = dict(no_archive=True, no_ims=True, no_tiff=False, no_mip=False, force=False,
                    refresh_web=False, dry_run=False, timepoint=None, ims=str(self.src))
        base.update(over)
        BDB.process(BDB.load_datasets(exact_id="live/ds")[0], argparse.Namespace(**base))

    def _readme(self):
        return (self.ds_dir / "download" / "README.txt").read_text(encoding="utf-8")

    def test_default_frame_is_the_start_of_the_window(self):
        self._write_meta({"start": 5, "end": 14})
        self._run()
        self.assertEqual(self.calls[-1]["timepoint"], 5)
        self.assertIn("timepoint 5 of 0..29 only", self._readme())
        self.assertIn("The site shows timepoints 5..14 only", self._readme())
        self.assertIn("still hold the whole acquisition", self._readme())

    def test_without_a_window_nothing_changes(self):
        self._write_meta(None)
        self._run()
        self.assertEqual(self.calls[-1], {"force": False, "timepoint": 0})
        self.assertNotIn("The site shows timepoints", self._readme())

    def test_explicit_timepoint_wins(self):
        self._write_meta({"start": 5, "end": 14})
        self._run(timepoint=20)
        self.assertEqual(self.calls[-1]["timepoint"], 20)

    @unittest.skipUnless(HAVE_TIFFFILE, "tifffile unavailable")
    def test_a_tiff_on_a_hidden_frame_is_rebuilt(self):
        import numpy as np
        dl = self.ds_dir / "download"
        dl.mkdir()
        tiff = dl / "ds.tif"

        def write(frame):
            tifffile.imwrite(str(tiff), np.zeros((2, 1, 4, 4), np.uint8), imagej=True,
                             metadata={"axes": "ZCYX",
                                       "Info": f"Source: Imaris .ims, timepoint {frame} of 0..29"})
        self.assertEqual((write(3), BDB.recorded_tiff_frame(tiff))[1], 3)

        self._write_meta({"start": 5, "end": 14})       # 3 is now hidden
        self._run()
        self.assertTrue(self.calls[-1]["force"], "a TIFF on a hidden frame is rebuilt")
        self.assertEqual(self.calls[-1]["timepoint"], 5)

        write(9)                                         # inside the window: kept
        self._run()
        self.assertFalse(self.calls[-1]["force"])

        write(3)                                         # an explicit choice is respected
        self._run(timepoint=3)
        self.assertFalse(self.calls[-1]["force"])

        self._write_meta(None)                           # no window: never stale
        self._run()
        self.assertFalse(self.calls[-1]["force"])

    def test_an_unreadable_tiff_is_left_alone(self):
        dl = self.ds_dir / "download"
        dl.mkdir()
        (dl / "ds.tif").write_bytes(b"not a tiff")
        self.assertIsNone(BDB.recorded_tiff_frame(dl / "ds.tif"))
        self._write_meta({"start": 5, "end": 14})
        self._run()
        self.assertFalse(self.calls[-1]["force"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
