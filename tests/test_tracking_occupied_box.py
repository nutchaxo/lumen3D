"""The stabilised display box of a tracked timelapse is built from the occupied bricks
whatever the brick format: format 2 (`nonEmpty` chunks in the manifest), format 4
(`index.bin` per tree, bricks_v3_writer) and formats 5/6 (the lossless `ll` column
index per tree, format5). A tree whose index is missing falls back to the acquisition
box for that timepoint only.

Run: python tests/test_tracking_occupied_box.py
"""
import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRE = ROOT / "preprocess"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(PRE))

try:
    import numpy as np
    import bricks_v3_writer as v3
    import format5 as f5
    from PIL import Image  # noqa: F401  (the writers encode WebP)
except Exception as exc:  # pragma: no cover
    print(f"SKIP: numpy/Pillow/brick writers unavailable ({exc})")
    sys.exit(0)


def _load_importer():
    spec = importlib.util.spec_from_file_location("lumen_tracking_importer_box",
                                                  str(PRE / "5-tracking_importer.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


TI = _load_importer()
IDENTITY = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


def _volume(shape, box):
    """uint8 (Z, Y, X) volume, zero except a block of signal over box = ((x0,x1),(y0,y1),(z0,z1))."""
    vol = np.zeros(shape, dtype=np.uint8)
    (x0, x1), (y0, y1), (z0, z1) = box
    vol[z0:z1, y0:y1, x0:x1] = 200
    return vol


def _raw(dirpath, vols):
    paths = []
    for c, v in enumerate(vols):
        p = Path(dirpath) / f"c{c}.u8"
        np.ascontiguousarray(v).tofile(p)
        paths.append(str(p))
    return paths


class OccupiedBox(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-occbox-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _expect(self, extent, dims, bricks_lo, bricks_hi):
        lo = np.array(extent["min"], float)
        voxel = (np.array(extent["max"], float) - lo) / np.array(dims, float)
        vmin = np.array(bricks_lo) * 64
        vmax = np.minimum((np.array(bricks_hi) + 1) * 64, dims)
        return lo + vmin * voxel, lo + vmax * voxel

    def _assert_box(self, got, want):
        np.testing.assert_allclose(got[0], want[0], atol=1e-9)
        np.testing.assert_allclose(got[1], want[1], atol=1e-9)

    def test_format4_live_tree(self):
        X, Y, Z = 128, 128, 70
        dims = (X, Y, Z)
        extent = {"min": [10.0, -5.0, 0.0], "max": [10.0 + X * 0.5, -5.0 + Y * 0.5, Z * 2.0]}
        ds = self.tmp / "live4"
        bricks = ds / "bricks"
        boxes = {"t000": ((70, 90), (5, 20), (66, 69)),     # brick (1, 0, 1) only
                 "t001": ((64, 100), (70, 120), (0, 10))}   # brick (1, 1, 0) only
        trees = {}
        for key, box in boxes.items():
            work = self.tmp / f"w4{key}"
            work.mkdir()
            # Channel 1 is empty: occupancy is the union over channels.
            paths = _raw(work, [_volume((Z, Y, X), box), np.zeros((Z, Y, X), np.uint8)])
            levels = v3.level_ladder(dims, (0.5, 0.5, 2.0))
            self.assertEqual(len(levels), 1)
            trees[key] = v3.write_tree([paths], levels, bricks / key, lambda fn, ts: map(fn, ts))
        manifest = v3.manifest_v3(2, trees, [], "now")
        (bricks / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

        occ = TI._occupied_boxes_um(ds, extent, {"x": X, "y": Y, "z": Z})
        self.assertEqual(sorted(occ), [0, 1])
        self._assert_box(occ[0], self._expect(extent, dims, (1, 0, 1), (1, 0, 1)))
        self._assert_box(occ[1], self._expect(extent, dims, (1, 1, 0), (1, 1, 0)))

        reg = {"transforms": [{"index": 0, "matrix": IDENTITY}, {"index": 1, "matrix": IDENTITY}]}
        union = TI._image_box_union(reg, extent, occ)
        self.assertEqual(union["basis"], "occupied-bricks")
        want_lo = np.minimum(occ[0][0], occ[1][0])
        want_hi = np.maximum(occ[0][1], occ[1][1])
        np.testing.assert_allclose(union["min"], np.round(want_lo, 4))
        np.testing.assert_allclose(union["max"], np.round(want_hi, 4))
        # Tighter than the acquisition box it replaces.
        acq = TI._image_box_union(reg, extent, None)
        self.assertEqual(acq["basis"], "acquisition-box")
        self.assertLess(np.prod(np.subtract(union["max"], union["min"])),
                        np.prod(np.subtract(acq["max"], acq["min"])))

        # A timepoint whose index is gone keeps the acquisition box; the others stay tight.
        (bricks / "t001" / v3.INDEX_NAME).unlink()
        occ = TI._occupied_boxes_um(ds, extent, {"x": X, "y": Y, "z": Z})
        self.assertEqual(sorted(occ), [0])

    def test_format4_3d_tree(self):
        X, Y, Z = 100, 128, 64
        dims = (X, Y, Z)
        extent = {"min": [0.0, 0.0, 0.0], "max": [100.0, 128.0, 64.0]}
        ds = self.tmp / "vol4"
        work = self.tmp / "w4"
        work.mkdir()
        paths = _raw(work, [_volume((Z, Y, X), ((80, 95), (100, 110), (1, 3)))])
        tree = v3.write_tree([paths], v3.level_ladder(dims, (1, 1, 1)), ds / "bricks",
                             lambda fn, ts: map(fn, ts))
        (ds / "bricks" / "manifest.json").write_text(
            json.dumps(v3.manifest_v3(1, {"": tree}, [], "now")), encoding="utf-8")
        occ = TI._occupied_boxes_um(ds, extent, {"x": X, "y": Y, "z": Z})
        self.assertEqual(sorted(occ), [0])
        # Brick (1, 1, 0) is clipped to the 100-voxel width: interior 64..100, not 64..128.
        self._assert_box(occ[0], self._expect(extent, dims, (1, 1, 0), (1, 1, 0)))
        self.assertAlmostEqual(occ[0][1][0], 100.0)

    def test_format6_live_tree(self):
        X, Y, Z = 200, 130, 70
        dims = (X, Y, Z)
        extent = {"min": [0.0, 0.0, 0.0], "max": [X * 0.4, Y * 0.4, Z * 2.5]}
        ds = self.tmp / "live6"
        bricks = ds / "bricks"
        boxes = {"t000": ((130, 140), (66, 128), (2, 4)),     # bricks x 2, y 1, z 0
                 "t002": ((10, 199), (0, 10), (65, 70))}      # bricks x 0..3, y 0, z 1
        trees, levels = {}, None
        for key, box in boxes.items():
            work = self.tmp / f"w6{key}"
            work.mkdir()
            paths = _raw(work, [_volume((Z, Y, X), box)])
            tree = f5.write_tree(paths, dims, (0.4, 0.4, 2.5), bricks / key, work / "levels",
                                 lambda fn, ts: map(fn, ts), fmt=6)
            levels = tree["levels"]
            trees[key] = tree
        doc = f5.manifest_v5(levels, 1, trees, [], "now", fmt=6)
        f5.atomic_write(bricks / "manifest.json", f5.manifest_bytes(doc))
        self.assertIsNone(f5.bricks_problem(ds, 6))

        occ = TI._occupied_boxes_um(ds, extent, {"x": X, "y": Y, "z": Z})
        self.assertEqual(sorted(occ), [0, 2])
        self._assert_box(occ[0], self._expect(extent, dims, (2, 1, 0), (2, 1, 0)))
        self._assert_box(occ[2], self._expect(extent, dims, (0, 0, 1), (3, 0, 1)))
        self.assertAlmostEqual(occ[2][1][0], X * 0.4)
        self.assertAlmostEqual(occ[2][1][2], Z * 2.5)

        reg = {"transforms": [{"index": 0, "matrix": IDENTITY}, {"index": 2, "matrix": IDENTITY}]}
        self.assertEqual(TI._image_box_union(reg, extent, occ)["basis"], "occupied-bricks")

    def test_format2_manifest_unchanged(self):
        ds = self.tmp / "v2"
        (ds / "bricks").mkdir(parents=True)
        manifest = {"schema": "iribhm-bricks-v2", "levels": [{"level": 0, "chunks": [
            {"min": [64, 0, 0], "max": [128, 64, 64], "nonEmpty": True},
            {"min": [0, 0, 0], "max": [64, 64, 64], "nonEmpty": False}]}]}
        (ds / "bricks" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        extent = {"min": [0.0, 0.0, 0.0], "max": [128.0, 64.0, 64.0]}
        occ = TI._occupied_boxes_um(ds, extent, {"x": 128, "y": 64, "z": 64})
        self._assert_box(occ[0], (np.array([64.0, 0, 0]), np.array([128.0, 64, 64])))

    def test_unreadable_manifest(self):
        ds = self.tmp / "bad"
        (ds / "bricks").mkdir(parents=True)
        (ds / "bricks" / "manifest.json").write_text("{not json", encoding="utf-8")
        extent = {"min": [0.0, 0.0, 0.0], "max": [1.0, 1.0, 1.0]}
        self.assertIsNone(TI._occupied_boxes_um(ds, extent, {"x": 1, "y": 1, "z": 1}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
