"""Preprocessing pipeline — the voxel path on synthetic Imaris files.

Needs numpy, scipy, h5py, Pillow and tqdm (preprocess/requirements.txt).

Covers:
  * step 2 levels a channel tile by tile, reading the .ims in pieces, and the result is
    byte-identical to levelling the whole volume at once (the historical algorithm,
    re-implemented here as the reference) whatever the tile size — single volumes and
    timelapses (shared window), seams in Z, Y and X;
  * step 1 never claims a calibration the file does not carry, and converts units;
  * step 3: empty-space skipping (a brick of 125 bright voxels is the documented
    tolerance), packs/manifest invariants (every brickToPack entry inside its pack,
    hashes, compact JSON, histograms present), only bricks with drawable voxels listed;
  * the orchestrator end to end: publish, keep the curation on a re-run (a hidden
    dataset stays hidden), leave the published dataset untouched when a run fails, and
    keep only one timepoint's LOD files at a time.

Run: python -m unittest tests.test_preprocess_pipeline
"""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRE = ROOT / "preprocess"
sys.path.insert(0, str(PRE))
sys.path.insert(0, str(ROOT / "tests"))

try:
    import h5py  # noqa: F401
    import numpy as np
    import scipy  # noqa: F401
    import tqdm  # noqa: F401
    from PIL import Image  # noqa: F401
    HAVE_DEPS = True
except ImportError as exc:  # pragma: no cover
    HAVE_DEPS = False
    MISSING = str(exc)


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(PRE / filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if HAVE_DEPS:
    from scipy.ndimage import binary_dilation, binary_opening, median_filter
    from preprocess_fixtures import synthetic_volume, write_ims
    step1 = _load("lumen_test_step1", "1-ims_metadata.py")
    step2 = _load("lumen_test_step2", "2-image_processor.py")
    step3 = _load("lumen_test_step3", "3-chunk_packer.py")


def reference_level(vol, bg_floor, sig_max):
    """The whole-volume algorithm step 2 used to run, kept as the oracle."""
    v = vol.astype(np.float32)
    mask = np.greater(v, bg_floor * 1.1)
    mask = binary_opening(mask, iterations=1)
    mask = binary_dilation(mask, iterations=3)
    composite = np.where(mask, v, median_filter(v, size=3))
    if sig_max - bg_floor <= 0.0:
        sig_max = bg_floor + 1.0
    clean = np.clip(composite, bg_floor, sig_max)
    return ((clean - bg_floor) / (sig_max - bg_floor) * 255.0).astype(np.uint8)


def reference_bounds(vol):
    v = vol.astype(np.float32)
    D, H, W = v.shape
    cs = max(1, min(32, W // 4, H // 4, D // 4))
    corners = [v[:cs, :cs, :cs], v[:cs, :cs, -cs:], v[:cs, -cs:, :cs], v[:cs, -cs:, -cs:],
               v[-cs:, :cs, :cs], v[-cs:, :cs, -cs:], v[-cs:, -cs:, :cs], v[-cs:, -cs:, -cs:]]
    bg = float(np.percentile(np.concatenate([c.flatten() for c in corners]), 99.0))
    return bg, float(np.percentile(v[::4, ::4, ::4], 99.9))


@unittest.skipUnless(HAVE_DEPS, "preprocessing dependencies missing")
class TiledLeveling(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen_step2_"))
        self._env = os.environ.get("LUMEN_PREPROCESS_TILE_MVOX")

    def tearDown(self):
        if self._env is None:
            os.environ.pop("LUMEN_PREPROCESS_TILE_MVOX", None)
        else:
            os.environ["LUMEN_PREPROCESS_TILE_MVOX"] = self._env
        step2._close_h5_files()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, volumes, tile_mvox, name):
        work = self.tmp / name
        work.mkdir()
        ims = write_ims(work / "x.ims", volumes)
        meta = step1.read_ims_metadata(ims)
        (work / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        os.environ["LUMEN_PREPROCESS_TILE_MVOX"] = str(tile_mvox)
        step2.process_image(ims, work / "meta.json", work / "t", executor=_Serial())
        return work / "t"

    def test_single_volume_matches_whole_volume_for_any_tiling(self):
        vol = synthetic_volume((21, 70, 83), seed=7)
        bg, sig = reference_bounds(vol)
        expected = reference_level(vol, bg, sig)
        for tile in (0.004, 0.02, 24):   # ~4k voxels (seams in every axis) .. one tile
            with self.subTest(tile=tile):
                out = self._run([[vol]], tile, f"single_{tile}")
                got = np.fromfile(out / "t000_c0_lod0.bin", dtype=np.uint8).reshape(vol.shape)
                self.assertTrue(np.array_equal(got, expected),
                                f"{np.count_nonzero(got != expected)} voxels differ")
                proc = json.loads((out / "processing_meta.json").read_text())
                self.assertEqual(proc["normalization"]["signalLevels"]["t000_c0"], round(sig, 4))

    def test_timelapse_uses_one_window_and_matches(self):
        vols = [[synthetic_volume((10, 40, 45), seed=20 + t)] for t in range(3)]
        out = self._run(vols, 0.004, "timelapse")
        proc = json.loads((out / "processing_meta.json").read_text())
        b = proc["normalization"]["bounds"]["c0"]
        pooled_c = np.concatenate([np.concatenate([
            c.flatten() for c in _corners(v[0].astype(np.float32))]) for v in vols])
        pooled_s = np.concatenate([v[0].astype(np.float32)[::4, ::4, ::4].ravel() for v in vols])
        bg = float(np.percentile(pooled_c, 99.0))
        above = pooled_s[pooled_s > bg]
        sig = float(np.percentile(above if above.size >= 1000 else pooled_s, 99.9))
        self.assertEqual(b, {"bgFloor": round(bg, 4), "sigMax": round(sig, 4)})
        for t, v in enumerate(vols):
            got = np.fromfile(out / f"t{t:03d}_c0_lod0.bin", dtype=np.uint8).reshape(v[0].shape)
            self.assertTrue(np.array_equal(got, reference_level(v[0], bg, sig)), f"t{t}")

    def test_tiles_cover_the_volume_once(self):
        shape = (37, 129, 300)
        cover = np.zeros(shape, dtype=np.int32)
        for z0, z1, y0, y1, x0, x1 in step2.plan_tiles(shape, step2.MASK_HALO, 20000):
            cover[z0:z1, y0:y1, x0:x1] += 1
        self.assertTrue((cover == 1).all())


class _Serial:
    """An executor stand-in that runs tasks in this process (workers of a real pool
    cannot import a module loaded from a file path under a test name)."""
    _max_workers = 1

    def map(self, fn, tasks):
        return map(fn, tasks)

    def submit(self, fn, task):
        from concurrent.futures import Future
        fut = Future()
        fut.set_result(fn(task))
        return fut

    def shutdown(self):
        pass


def _corners(v):
    D, H, W = v.shape
    cs = max(1, min(32, W // 4, H // 4, D // 4))
    return [v[:cs, :cs, :cs], v[:cs, :cs, -cs:], v[:cs, -cs:, :cs], v[:cs, -cs:, -cs:],
            v[-cs:, :cs, :cs], v[-cs:, :cs, -cs:], v[-cs:, -cs:, :cs], v[-cs:, -cs:, -cs:]]


@unittest.skipUnless(HAVE_DEPS, "preprocessing dependencies missing")
class Calibration(unittest.TestCase):
    def test_missing_extent_is_not_exact_and_units_convert(self):
        tmp = Path(tempfile.mkdtemp(prefix="lumen_step1_"))
        try:
            vol = synthetic_volume((4, 8, 8), seed=1)
            meta = step1.read_ims_metadata(write_ims(tmp / "a.ims", [[vol]], with_extent=False))
            self.assertEqual(meta["voxel_size"], {"x": 0.0, "y": 0.0, "z": 0.0})
            self.assertIsNone(meta["extent"])
            meta = step1.read_ims_metadata(write_ims(tmp / "b.ims", [[vol]], unit="mm",
                                                     extent=((0, 0, 0), (0.008, 0.016, 0.004))))
            self.assertEqual(meta["voxel_size"], {"x": 1.0, "y": 2.0, "z": 1.0})
            self.assertEqual(meta["extent"]["unit"], "um")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless(HAVE_DEPS, "preprocessing dependencies missing")
class Packing(unittest.TestCase):
    def test_ess_tolerance_is_the_documented_one(self):
        brick = np.zeros((64, 64, 64), np.uint8)
        brick.reshape(-1)[:125] = 255
        _, occ, kept, _ = step3.process_chunk((brick, {"idx": 0, "validVoxelCount": 64 ** 3}, 64))
        self.assertFalse(kept)
        self.assertGreater(occ, 0.0)
        brick.reshape(-1)[:150] = 255
        self.assertTrue(step3.process_chunk((brick, {"idx": 0, "validVoxelCount": 64 ** 3}, 64))[2])
        noise = np.ones((64, 64, 64), np.uint8) * 5      # nothing drawable
        self.assertEqual(step3.process_chunk((noise, {"idx": 0, "validVoxelCount": 64 ** 3}, 64))[1:3],
                         (0.0, False))

    def test_manifest_invariants(self):
        tmp = Path(tempfile.mkdtemp(prefix="lumen_step3_"))
        try:
            D, H, W = 70, 300, 260
            lod_levels = step2.lod_ladder(W, H, D)
            rng = np.random.default_rng(3)
            for li in lod_levels:
                vol = (rng.random((D, li["height"], li["width"])) < 0.002).astype(np.uint8) * 200
                vol[:64, :64, :64] = 1                     # a noise-only brick: never listed
                vol.tofile(tmp / f"t000_c0_lod{li['lod']}.bin")
            proc = {"lod_levels": lod_levels, "n_channels": 1, "n_timepoints": 1,
                    "voxel_size": {"x": 1, "y": 1, "z": 1}, "channel_names": ["c"],
                    "width": W, "height": H, "depth": D}
            (tmp / "processing_meta.json").write_text(json.dumps(proc), encoding="utf-8")
            out = tmp / "3d" / "ds"
            out.mkdir(parents=True)
            levels, transport = step3.pack_timepoint(tmp, out / "bricks", 0, lod_levels, 1,
                                                     _Serial(), "")
            (tmp / "pack_t000.json").write_text(json.dumps({"levels": levels,
                                                            "brickTransport": transport}))
            step3.build_packs(tmp, out)
            raw = (out / "bricks" / "manifest.json").read_text(encoding="utf-8")
            self.assertNotIn("\n", raw)
            manifest = json.loads(raw)
            self.assertEqual(len(manifest["histograms"]), 1)
            self.assertEqual(manifest["histograms"][0]["total"],
                             D * lod_levels[-1]["width"] * lod_levels[-1]["height"])
            bt = manifest["brickTransport"]
            sizes = {}
            for url, digest in bt["packHashes"].items():
                data = (out / "bricks" / url).read_bytes()
                sizes[url] = len(data)
                self.assertEqual(hashlib.sha256(data).hexdigest(), digest)
            for key, entry in bt["brickToPack"].items():
                self.assertLessEqual(entry["offset"] + entry["length"], sizes[entry["url"]], key)
            per_pack = {}
            for entry in bt["brickToPack"].values():
                per_pack[entry["url"]] = per_pack.get(entry["url"], 0) + 1
            self.assertTrue(all(n <= step3.CHUNKS_PER_PACK for n in per_pack.values()))
            for level in manifest["levels"]:
                ids = {c["id"] for c in level["chunks"]}
                self.assertNotIn("0_0_0", ids)             # the noise-only brick
                for c in level["chunks"]:
                    bz, by, bx = map(int, c["id"].split("_"))
                    if c["nonEmpty"]:
                        self.assertIn(f"lod{level['level']}/c0/x{bx:03d}_y{by:03d}_z{bz:03d}.webp",
                                      bt["brickToPack"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless(HAVE_DEPS, "preprocessing dependencies missing")
class DownloadBundle(unittest.TestCase):
    def test_timelapse_frame_and_exact_selection(self):
        tmp = Path(tempfile.mkdtemp(prefix="lumen_bundle_"))
        try:
            vols = [[synthetic_volume((6, 30, 40), seed=60 + t)] for t in range(2)]
            ims = write_ims(tmp / "tl.ims", vols)
            web = tmp / "DATA_WEB"
            for folder in ("tl", "tl-2"):
                d = web / "live" / folder
                d.mkdir(parents=True)
                (d / "metadata.json").write_text(json.dumps({
                    "type": "live", "dimensions": {"x": 40, "y": 30, "z": 6, "c": 1, "t": 2},
                    "channels": [{"name": "GFP", "color": "#FFFFFF"}]}), encoding="utf-8")
            r = subprocess.run([sys.executable, str(ROOT / "tools" / "build_download_bundles.py"),
                                "--data-web", str(web), "--dataset", "live/tl", "--ims", str(ims),
                                "--timepoint", "1", "--no-archive", "--no-ims", "--no-tiff"],
                               capture_output=True, text=True, timeout=300)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertFalse((web / "live" / "tl-2" / "download").exists())
            dl = web / "live" / "tl" / "download"
            png = np.asarray(Image.open(dl / "tl_C1_GFP_MIP.png"))[:, :, 0]
            mip = vols[1][0].max(axis=0).astype(np.float32)
            lo, hi = np.percentile(mip, 1.0), np.percentile(mip, 99.9)
            expected = (np.clip((mip - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)
            self.assertTrue(np.array_equal(png, expected))
            self.assertIn("timepoint 1 of 0..1 only", (dl / "README.txt").read_text(encoding="utf-8"))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless(HAVE_DEPS, "preprocessing dependencies missing")
class Orchestrator(unittest.TestCase):
    """Runs run_preprocess.py the way the operator does (real process pools)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen_pipeline_"))
        self.raw = self.tmp / "raw"
        self.raw.mkdir()
        self.out = self.tmp / "DATA_WEB"
        self.env = dict(os.environ, LUMEN_PREPROCESS_WORKERS="2", LUMEN_PREPROCESS_TILE_MVOX="0.05")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, *extra):
        return subprocess.run([sys.executable, str(PRE / "run_preprocess.py"), "--input", str(self.raw),
                               "--output", str(self.out), "--tracking", "off", *extra],
                              capture_output=True, text=True, env=self.env, timeout=600)

    def test_publish_rerun_and_failure(self):
        vol = synthetic_volume((20, 90, 100), seed=5)
        write_ims(self.raw / "Dll4-E10-5-Em3.ims", [[vol, synthetic_volume((20, 90, 100), seed=6)]])
        r = self._run()
        self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])
        ds = self.out / "3d" / "Dll4-E10-5-Em3"
        meta = json.loads((ds / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual((meta["stage"], meta["stageNumeric"], meta["embryo"]), ("E10.5", 10.5, "Em3"))
        self.assertEqual(meta["calibrationStatus"], "exact")
        self.assertFalse(list(self.out.glob(".temp_preprocess_*")))
        manifest = json.loads((ds / "bricks" / "manifest.json").read_text(encoding="utf-8"))
        self.assertTrue(manifest["histograms"])
        packs_before = {p.relative_to(ds).as_posix(): p.read_bytes()
                        for p in (ds / "bricks").rglob("*.bin")}
        self.assertTrue(any(name.endswith("index.bin") for name in packs_before))
        self.assertTrue(any("/l0/c0/p" in name for name in packs_before))

        # The lab curates the dataset, then it is re-processed.
        meta.update(hidden=True, stage="TS17", orientation=[0, 0, 0, 1], exposure=1.5)
        meta["channels"][0]["color"] = "#123456"
        (ds / "metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        (ds / "download").mkdir()
        (ds / "download" / "keep.txt").write_text("x", encoding="utf-8")
        r = self._run()
        self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])
        again = json.loads((ds / "metadata.json").read_text(encoding="utf-8"))
        self.assertIs(again["hidden"], True)
        self.assertEqual(again["stage"], "TS17")
        self.assertEqual(again["orientation"], [0, 0, 0, 1])
        self.assertEqual(again["channels"][0]["color"], "#123456")
        self.assertTrue((ds / "download" / "keep.txt").exists())
        packs_after = {p.relative_to(ds).as_posix(): p.read_bytes()
                       for p in (ds / "bricks").rglob("*.bin")}
        self.assertEqual(packs_before, packs_after)      # same input, same bytes

        # A run that fails leaves the published dataset exactly as it was.
        before = {p.relative_to(ds).as_posix(): p.read_bytes() for p in ds.rglob("*") if p.is_file()}
        (self.raw / "Dll4-E10-5-Em3.ims").write_bytes(b"not an hdf5 file")
        r = self._run()
        self.assertNotEqual(r.returncode, 0)
        after = {p.relative_to(ds).as_posix(): p.read_bytes() for p in ds.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        self.assertFalse(list(self.out.glob(".temp_preprocess_*")))

    def test_timelapse_keeps_one_frame_of_temporaries(self):
        vols = [[synthetic_volume((8, 300, 280), seed=40 + t)] for t in range(3)]
        ims = write_ims(self.raw / "tl.ims", vols)
        work = self.tmp / "work"
        work.mkdir()
        stage = self.tmp / "stage" / "live" / "tl"
        stage.mkdir(parents=True)
        subprocess.run([sys.executable, str(PRE / "1-ims_metadata.py"), str(ims), str(work / "meta.json")],
                       check=True, capture_output=True)
        r = subprocess.run([sys.executable, str(PRE / "2-image_processor.py"), str(ims),
                            str(work / "meta.json"), str(work), "--pack-into", str(stage)],
                           capture_output=True, text=True, env=self.env, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        left = sorted(p.name for p in work.glob("*.bin"))
        # Levels 300x280, 150x140, 75x70 (format 4): the thumbnail level of t000 is
        # level 0 here, the coarsest level of every frame is level 2; nothing else
        # survives its packing.
        self.assertEqual(left, ["t000_c0_lod0.bin", "t000_c0_lod2.bin", "t001_c0_lod2.bin",
                                "t002_c0_lod2.bin"])
        self.assertEqual(sorted(p.name for p in (stage / "bricks").iterdir()), ["t000", "t001", "t002"])
        r = subprocess.run([sys.executable, str(PRE / "3-chunk_packer.py"), str(work), str(stage)],
                           capture_output=True, text=True, env=self.env, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        manifest = json.loads((stage / "bricks" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema"], "iribhm-bricks-v3")
        self.assertEqual([row["path"] for row in manifest["timepoints"]], ["t000", "t001", "t002"])
        self.assertEqual([row["index"]["url"] for row in manifest["timepoints"]],
                         ["t000/index.bin", "t001/index.bin", "t002/index.bin"])
        self.assertEqual(sorted(manifest["timepointHistograms"]), ["t000", "t001", "t002"])
        self.assertTrue(all(manifest["timepointHistograms"].values()))
        self.assertEqual(sorted(p.name for p in (stage / "mips").iterdir()), ["t000", "t001", "t002"])


if __name__ == "__main__":
    if not HAVE_DEPS:
        print(f"SKIP test_preprocess_pipeline: {MISSING}")
    unittest.main()
