"""Format 5 written by the pipeline (DOCS/dataset-migrations/SPEC.md §14, preprocess ≥ 0.22.0).

Steps 3 and 4 of the pipeline on level-0 files of a synthetic acquisition ('3d' and a
two-frame 'live'), the way step 2 leaves them: the v5 tree under bricks/ is complete and
byte-identical to format5.write_tree on the same voxels, the manifest carries the
histograms (per frame for a timelapse), planes/ and mips/ record the v5 manifest's sha256,
and step 4 says formatVersion 5 (4 when the v5 tree is missing).

Needs Python 3.12 with numpy, scipy, h5py, Pillow (WebP) and tqdm (the pipeline's own).
"""
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRE = ROOT / "preprocess"
sys.path.insert(0, str(PRE))
sys.path.insert(0, str(ROOT))

try:
    import numpy as np
    import scipy  # noqa: F401
    import h5py  # noqa: F401
    import tqdm  # noqa: F401
    HAVE_DEPS = True
    MISSING = ""
except Exception as exc:  # pragma: no cover
    HAVE_DEPS = False
    MISSING = str(exc)


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(PRE / filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


if HAVE_DEPS:
    import format5 as f5
    step2 = _load("lumen_f5_pipe_step2", "2-image_processor.py")
    step3 = _load("lumen_f5_pipe_step3", "3-chunk_packer.py")
    step4 = _load("lumen_f5_pipe_step4", "4-catalog_generator.py")


class _Serial:
    _max_workers = 1

    def submit(self, fn, task):
        from concurrent.futures import Future
        fut = Future()
        fut.set_result(fn(task))
        return fut


def _files(d: Path) -> dict:
    out = {}
    for root, _dirs, names in os.walk(d):
        for n in names:
            p = Path(root) / n
            out[p.relative_to(d).as_posix()] = p.read_bytes()
    return out


@unittest.skipUnless(HAVE_DEPS, "preprocessing dependencies missing")
class PipelineFormat5(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen_f5_pipe_"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _dataset(self, dtype, W, H, D, C, n_tp, seed, voxel=(0.6, 0.6, 2.4), f5_ladder=False):
        """A dataset packed from step-2 files. f5_ladder=False: the levels of a format-4
        pyramid are all on disk (an older step 2); True: what step 2 writes for formats
        5/6 — level 0 only, with format5's own ladder as lod_levels — then its clean-up."""
        work = self.tmp / "work"
        work.mkdir()
        vs = {"x": voxel[0], "y": voxel[1], "z": voxel[2]}
        lod_levels = (step2.format5_levels(W, H, D, vs) if f5_ladder
                      else step2.pyramid_levels(W, H, D, vs))
        (work / "processing_meta.json").write_text(json.dumps({
            "lod_levels": lod_levels, "n_channels": C, "n_timepoints": n_tp, "datasetFormat": 5,
            "voxel_size": vs, "channel_names": [f"c{c}" for c in range(C)],
            "width": W, "height": H, "depth": D}), encoding="utf-8")
        ds = self.tmp / dtype / "ds"
        ds.mkdir(parents=True)
        vols = {}
        for t in range(n_tp):
            rng = np.random.default_rng(seed + t)
            for c in range(C):
                vol = (rng.random((D, H, W)) < 0.004).astype(np.uint8) * rng.integers(6, 256, (D, H, W), dtype=np.uint8)
                vol[:, :120, :100] = rng.integers(0, 220, (D, 120, 100), dtype=np.uint8)
                vol.tofile(work / f"t{t:03d}_c{c}_lod0.bin")
                vols[(t, c)] = vol
                prev = vol
                for li in ([] if f5_ladder else lod_levels[1:]):
                    import bricks_v3_writer as v3
                    prev = v3.reduce_level(prev, li["halveZ"])
                    prev.tofile(work / f"t{t:03d}_c{c}_lod{li['lod']}.bin")
            packed = step3.pack_timepoint_v5(work, ds / "bricks", t, lod_levels, C, _Serial(),
                                             f"t{t:03d}" if n_tp > 1 else "")
            (work / f"pack_t{t:03d}.json").write_text(json.dumps(packed), encoding="utf-8")
            if f5_ladder:
                step2._drop_packed_files(work, t, C, lod_levels)
        step3.build_packs(work, ds)
        step4.generate_catalog_metadata(work, ds)
        return work, ds, vols, vs

    def _same_as_writer(self, ds, key, vols, t, C, W, H, D, vs):
        raw = self.tmp / ("raw_%d" % t)
        raw.mkdir()
        paths = []
        for c in range(C):
            p = raw / ("c%d.u8" % c)
            vols[(t, c)].tofile(p)
            paths.append(str(p))
        ref = self.tmp / ("ref_%d" % t)
        f5.write_tree(paths, (W, H, D), vs, ref, self.tmp / ("w_%d" % t), lambda fn, ts: map(fn, ts))
        got = _files(ds / "bricks" / key if key else ds / "bricks")
        got.pop("manifest.json", None)
        want = _files(ref)
        self.assertEqual(sorted(got), sorted(want))
        for name in want:
            self.assertEqual(got[name], want[name], name)

    def test_3d(self):
        W, H, D, C = 560, 300, 40, 2
        work, ds, vols, vs = self._dataset("3d", W, H, D, C, 1, 81)
        self.assertIsNone(f5.bricks_problem(ds))
        raw = (ds / "bricks" / "manifest.json").read_bytes()
        manifest = json.loads(raw)
        self.assertEqual(manifest["schema"], f5.SCHEMA)
        self.assertEqual([L["target"] for L in manifest["levels"]], ["native", 512, 256])
        self.assertEqual(len(manifest["histograms"]), C)
        self.assertEqual(manifest["dataset"], "ds")
        sha = hashlib.sha256(raw).hexdigest()
        for root in ("planes", "mips"):
            doc = json.loads((ds / root / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(doc["source"]["manifestSha256"], sha)
        meta = json.loads((ds / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["formatVersion"], 5)
        self._same_as_writer(ds, "", vols, 0, C, W, H, D, vs)
        self.assertFalse(any(p.name.startswith("f5work") for p in work.iterdir() if p.is_dir() and any(p.iterdir())))
        # Without the v5 tree the dataset no longer claims format 5.
        (ds / "bricks" / "index" / "ll.bin").unlink()
        self.assertLess(step4.dataset_format_version(ds), 5)

    def _resampled(self, vol, li):
        return np.stack([f5.resample_plane(vol[z], li["width"], li["height"])
                         for z in range(vol.shape[0])])

    def test_step2_writes_level0_only_and_the_tree_hands_back_what_is_read(self):
        # Native 1100 px: format5's ladder is native, 1024, 512, 256 — the thumbnail reads
        # level 1, the histograms level 3; level 2 is never needed outside the tree.
        W, H, D, C = 1100, 200, 6, 1
        work, ds, vols, vs = self._dataset("3d", W, H, D, C, 1, 77, f5_ladder=True)
        meta = json.loads((work / "processing_meta.json").read_text(encoding="utf-8"))
        levels = meta["lod_levels"]
        self.assertEqual([li["target"] for li in levels], ["native", 1024, 512, 256])
        self.assertEqual(step3.thumbnail_lod(levels), 1)
        left = sorted(p.name for p in work.glob("t000_c*_lod*.bin"))
        self.assertEqual(left, ["t000_c0_lod1.bin", "t000_c0_lod3.bin"])
        for k in (1, 3):
            li = levels[k]
            got = np.fromfile(work / f"t000_c0_lod{k}.bin", dtype=np.uint8)
            self.assertTrue(np.array_equal(got.reshape(li["depth"], li["height"], li["width"]),
                                           self._resampled(vols[(0, 0)], li)), k)
        coarsest = self._resampled(vols[(0, 0)], levels[3])
        counts, _ = np.histogram(coarsest, bins=64, range=(0, 255))
        manifest = json.loads((ds / "bricks" / "manifest.json").read_bytes())
        self.assertEqual(manifest["histograms"][0]["counts"], counts.tolist())
        self.assertEqual(manifest["histograms"][0]["total"], coarsest.size)
        run_preprocess = _load("lumen_f5_pipe_run", "run_preprocess.py")
        run_preprocess.build_thumbnail(work, ds, meta)
        self.assertTrue((ds / "thumbnail.webp").is_file())
        self.assertFalse([p for p in work.iterdir() if p.name.startswith("f5work") and any(p.iterdir())])
        self._same_as_writer(ds, "", vols, 0, C, W, H, D, vs)

    def test_live_format5_ladder_keeps_the_coarsest_level_of_every_frame(self):
        W, H, D, C = 300, 280, 12, 2
        work, ds, vols, vs = self._dataset("live", W, H, D, C, 2, 93, f5_ladder=True)
        meta = json.loads((work / "processing_meta.json").read_text(encoding="utf-8"))
        levels = meta["lod_levels"]
        self.assertEqual([li["target"] for li in levels], ["native", 256])
        self.assertEqual(sorted(p.name for p in work.glob("t*_c*_lod*.bin")),
                         ["t000_c0_lod0.bin", "t000_c0_lod1.bin", "t000_c1_lod0.bin",
                          "t000_c1_lod1.bin", "t001_c0_lod1.bin", "t001_c1_lod1.bin"])
        manifest = json.loads((ds / "bricks" / "manifest.json").read_bytes())
        for t in range(2):
            for c in range(C):
                counts, _ = np.histogram(self._resampled(vols[(t, c)], levels[1]),
                                         bins=64, range=(0, 255))
                self.assertEqual(manifest["timepointHistograms"]["t%03d" % t][c]["counts"],
                                 counts.tolist())
            self._same_as_writer(ds, "t%03d" % t, vols, t, C, W, H, D, vs)

    def test_live(self):
        W, H, D, C = 300, 280, 12, 1
        _work, ds, vols, vs = self._dataset("live", W, H, D, C, 2, 91)
        self.assertIsNone(f5.bricks_problem(ds))
        manifest = json.loads((ds / "bricks" / "manifest.json").read_bytes())
        self.assertIsNone(manifest["index"])
        self.assertEqual([r["path"] for r in manifest["timepoints"]], ["t000", "t001"])
        self.assertEqual(sorted(manifest["timepointHistograms"]), ["t000", "t001"])
        meta = json.loads((ds / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["formatVersion"], 5)
        for t in range(2):
            self._same_as_writer(ds, "t%03d" % t, vols, t, C, W, H, D, vs)


if __name__ == "__main__":
    if not HAVE_DEPS:
        print("SKIP preprocessing dependencies missing: " + MISSING)
        sys.exit(0)
    unittest.main(verbosity=2)
