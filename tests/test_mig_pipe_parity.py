"""Pipeline ↔ migration parity for format 2 (DOCS/dataset-migrations/SPEC.md §3, §10).

A dataset built by the pipeline (step 3) has its planes/ removed and its formatVersion
reset to 1; the migration `m002-planes` then runs on it with the SERVER executor of
dataset_migrations.py (plan → unit_run until done → finalize). The tree it produces must
be the pipeline's own: every zNNNNN.bin byte-identical (same headers, same PNG bytes —
both encode None + zlib 6 and drop all-zero tiles), every decoded pixel equal, and each
planes/manifest.json equal except `producer` and `createdAt`. Covers a '3d' dataset (two
tile columns, two channels, a brick layer cut short) and a 'live' one (two trees).

The migration also recognises a pipeline-made tree as valid: finalize on a dataset that
already holds the pipeline's planes but still says format 1 bumps it without a job.

Needs Python 3.12 with numpy, scipy, h5py, Pillow (WebP) and tqdm.
"""
import importlib.util
import io
import json
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
    from PIL import Image
    HAVE_DEPS = (ROOT / "dataset_migrations.py").is_file()
    MISSING = "dataset_migrations.py absent"
except ImportError as exc:  # pragma: no cover
    HAVE_DEPS = False
    MISSING = str(exc)


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(PRE / filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if HAVE_DEPS:
    import planes_writer as pw
    import dataset_migrations as dm
    step2 = _load("lumen_mig_parity_step2", "2-image_processor.py")
    step3 = _load("lumen_mig_parity_step3", "3-chunk_packer.py")
    step4 = _load("lumen_mig_parity_step4", "4-catalog_generator.py")

MID = "m002-planes"


class _Serial:
    _max_workers = 1

    def submit(self, fn, task):
        from concurrent.futures import Future
        fut = Future()
        fut.set_result(fn(task))
        return fut


def _write_lods(work, t_idx, lod_levels, channels, rng):
    for c in range(channels):
        for li in lod_levels:
            D, H, W = li["depth"], li["height"], li["width"]
            vol = (rng.random((D, H, W)) < 0.004).astype(np.uint8) * rng.integers(
                6, 256, size=(D, H, W), dtype=np.uint8)
            h, w = min(H, 180), min(W, 140)
            vol[:, :h, :w] = rng.integers(0, 230, size=(D, h, w), dtype=np.uint8)
            vol[:, -64:, -70:] = 1                          # dropped by ESS
            if c == channels - 1:
                vol[:, :, 512:] = 0                         # an empty tile column
            vol.tofile(work / f"t{t_idx:03d}_c{c}_lod{li['lod']}.bin")


def _decode(png):
    img = Image.open(io.BytesIO(png))
    img.load()
    return np.asarray(img)


@unittest.skipUnless(HAVE_DEPS, "parity prerequisites missing")
class PipelineMigrationParity(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen_mig_parity_"))
        self.web = self.tmp / "DATA_WEB"
        dm.configure(self.tmp, data_web=self.web, uploads_dir=self.tmp / "uploads")

    def tearDown(self):
        dm.configure(ROOT)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _pipeline_dataset(self, dtype, folder, W, H, D, C, n_tp, seed):
        work = self.tmp / f"work_{folder}"
        work.mkdir()
        lod_levels = step2.lod_ladder(W, H, D)
        (work / "processing_meta.json").write_text(json.dumps({
            "lod_levels": lod_levels, "n_channels": C, "n_timepoints": n_tp,
            "voxel_size": {"x": 1, "y": 1, "z": 2}, "channel_names": [f"c{c}" for c in range(C)],
            "width": W, "height": H, "depth": D}), encoding="utf-8")
        ds = self.web / dtype / folder
        ds.mkdir(parents=True)
        for t in range(n_tp):
            _write_lods(work, t, lod_levels, C, np.random.default_rng(seed + t))
            levels, transport = step3.pack_timepoint(work, ds / "bricks", t, lod_levels, C, _Serial(),
                                                     f"t{t:03d}" if n_tp > 1 else "")
            (work / f"pack_t{t:03d}.json").write_text(json.dumps(
                {"levels": levels, "brickTransport": transport}), encoding="utf-8")
        step3.build_packs(work, ds)
        step4.generate_catalog_metadata(work, ds)
        meta = json.loads((ds / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["formatVersion"], 2)
        return ds

    def _snapshot(self, ds):
        planes = ds / "planes"
        return {p.relative_to(planes).as_posix(): p.read_bytes()
                for p in sorted(planes.rglob("*")) if p.is_file()}

    def _set_version(self, ds, v):
        meta = json.loads((ds / "metadata.json").read_text(encoding="utf-8"))
        meta["formatVersion"] = v
        (ds / "metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    def _migrate(self, dataset_id):
        plan = dm.plan_job(dataset_id, MID)
        self.assertGreater(plan["total"], 0)
        for _ in range(10000):
            r = dm.unit_run(dataset_id, MID, max_seconds=20)
            if r["done"] >= r["total"]:
                break
        for _ in range(1000):
            r = dm.finalize(dataset_id, MID)
            if r.get("complete", True):
                break
        self.assertEqual(r.get("formatVersion"), 2, r)

    def _compare(self, pipeline, migrated):
        self.assertEqual(sorted(pipeline), sorted(migrated))
        trees = 0
        for name, data in pipeline.items():
            other = migrated[name]
            if name.endswith("manifest.json"):
                a, b = json.loads(data), json.loads(other)
                self.assertEqual(a.pop("producer"), "pipeline")
                self.assertEqual(b.pop("producer"), "migration-server")
                a.pop("createdAt"), b.pop("createdAt")
                self.assertEqual(list(a), list(b), name)        # same key order
                self.assertEqual(a, b, name)
                trees += 1
                continue
            ha = pw.parse_plane_pack_header(data)
            z2, c2, tx2, ty2, entries2 = dm.parse_plane_pack(other)
            self.assertEqual((ha["z"], ha["channels"], ha["tilesX"], ha["tilesY"]), (z2, c2, tx2, ty2))
            self.assertEqual(data[:pw.header_bytes(ha["channels"], ha["tilesX"], ha["tilesY"])],
                             other[:pw.header_bytes(ha["channels"], ha["tilesX"], ha["tilesY"])],
                             f"{name}: headers differ")
            for (off, ln), (off2, ln2) in zip(ha["entries"], entries2):
                self.assertEqual((off, ln), (off2, ln2), name)
                if ln:
                    self.assertTrue(np.array_equal(_decode(data[off:off + ln]),
                                                   _decode(other[off2:off2 + ln2])), name)
            self.assertEqual(data, other, f"{name}: packs differ")
        return trees

    def _run_case(self, dtype, folder, W, H, D, C, n_tp, seed):
        ds = self._pipeline_dataset(dtype, folder, W, H, D, C, n_tp, seed)
        pipeline = self._snapshot(ds)
        self.assertTrue(any(name.endswith(".bin") for name in pipeline))
        shutil.rmtree(ds / "planes")
        self._set_version(ds, 1)
        self._migrate(f"{dtype}/{folder}")
        self.assertEqual(self._compare(pipeline, self._snapshot(ds)), n_tp if n_tp > 1 else 1)
        self.assertFalse((ds / ".planes-incoming").exists())
        self.assertTrue(pw.planes_complete(ds))

    def test_3d_dataset(self):
        self._run_case("3d", "vol", 600, 530, 70, 2, 1, 31)

    def test_live_dataset(self):
        self._run_case("live", "tl", 530, 140, 9, 2, 2, 41)

    def test_pipeline_tree_is_valid_for_the_migration(self):
        ds = self._pipeline_dataset("3d", "made", 300, 200, 12, 1, 1, 51)
        self._set_version(ds, 1)
        r = dm.finalize("3d/made", MID)
        self.assertEqual(r.get("formatVersion"), 2, r)
        self.assertEqual(json.loads((ds / "metadata.json").read_text())["formatVersion"], 2)


if __name__ == "__main__":
    if not HAVE_DEPS:
        print(f"SKIP test_mig_pipe_parity: {MISSING}")
    unittest.main()
