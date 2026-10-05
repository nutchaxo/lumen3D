"""Pipeline ↔ migration parity for formats 3 and 4 (DOCS/dataset-migrations/SPEC.md §12, §13).

The same LOD0 volume is published twice by the pipeline:
  * as format 2 (v2 bricks + planes — the legacy path of step 3), then migrated
    m003-layer-mips → m004-bricks-v3 by the SERVER executor of dataset_migrations.py
    (plan → unit_run until done → finalize, each migration in turn);
  * as format 4 directly (steps 2-3 of preprocess ≥ 0.21.0).
The two trees must agree: index.bin byte for byte (same grid, same pack/offset/length of
every brick slot — both encode with Pillow lossless, quality 75, method 4), every brick of
every level decoding to the same 66³ voxels, the same mips/ pixels and headers, and the
same planes/. Manifests agree except for who made them and when (and the histograms,
which the pipeline takes from its own coarsest level and the migration carries over from
the v2 manifest).

The LOD0 content is chosen so the v2 empty-space tolerance (occupancy > 0.0005 and a
voxel > 5) drops nothing that is not zero: dense regions with edges on multiples of 32.
Where v2 dropped real signal, a migrated dataset keeps the zeros v2 left (SPEC §13.1) and
a re-processed one keeps the signal — test_v3_pipe_format covers that side.

Covers a '3d' dataset (two tile columns, two channels, a short last brick layer, levels
halving Z) and a 'live' one (two trees, Z kept at level 1).

Needs Python 3.12 with numpy, scipy, h5py, Pillow (WebP) and tqdm, and a
dataset_migrations.py that implements m003 and m004.
"""
import hashlib
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
    import dataset_migrations as dm
    HAVE_DEPS = all(hasattr(dm, n) for n in ("process_unit_m004", "process_unit_m003")) and \
        {"m003-layer-mips", "m004-bricks-v3"} <= {m["id"] for m in dm.MIGRATIONS}
    MISSING = "dataset_migrations.py without m003/m004"
except ImportError as exc:  # pragma: no cover
    HAVE_DEPS = False
    MISSING = str(exc)


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(PRE / filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if HAVE_DEPS:
    import bricks_v3_writer as v3
    import mips_writer as mw
    import planes_writer as pw
    step2 = _load("lumen_v3_parity_step2", "2-image_processor.py")
    step3 = _load("lumen_v3_parity_step3", "3-chunk_packer.py")
    step4 = _load("lumen_v3_parity_step4", "4-catalog_generator.py")


class _Serial:
    _max_workers = 1

    def submit(self, fn, task):
        from concurrent.futures import Future
        fut = Future()
        fut.set_result(fn(task))
        return fut


def _lod0(W, H, D, C, rng):
    """Per channel a (D, H, W) LOD0 of dense blocks (edges on multiples of 32) over zeros."""
    out = []
    for c in range(C):
        vol = np.zeros((D, H, W), np.uint8)
        for _ in range(5):
            z0 = 32 * int(rng.integers(0, max(1, D // 32)))
            y0 = 32 * int(rng.integers(0, max(1, H // 32)))
            x0 = 32 * int(rng.integers(0, max(1, W // 32)))
            z1 = min(D, z0 + 32 * int(rng.integers(1, 4)))
            y1 = min(H, y0 + 32 * int(rng.integers(1, 5)))
            x1 = min(W, x0 + 32 * int(rng.integers(1, 5)))
            vol[z0:z1, y0:y1, x0:x1] = rng.integers(0, 230, size=(z1 - z0, y1 - y0, x1 - x0),
                                                    dtype=np.uint8)
        if c == C - 1 and W > 512:
            vol[:, :, 512:] = 0                       # an empty tile column
        out.append(vol)
    return out


def _decode_png(png):
    img = Image.open(io.BytesIO(png))
    img.load()
    return np.asarray(img)


@unittest.skipUnless(HAVE_DEPS, f"parity prerequisites missing")
class FormatFourParity(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen_v3_parity_"))
        self.web = self.tmp / "DATA_WEB"
        dm.configure(self.tmp, data_web=self.web, uploads_dir=self.tmp / "uploads")

    def tearDown(self):
        dm.configure(ROOT)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _publish(self, fmt, dtype, folder, vols_by_t, voxel):
        D, H, W = vols_by_t[0][0].shape
        C, n_tp = len(vols_by_t[0]), len(vols_by_t)
        work = self.tmp / f"work_{folder}"
        work.mkdir()
        vs = {"x": voxel[0], "y": voxel[1], "z": voxel[2]}
        lod_levels = step2.pyramid_levels(W, H, D, vs) if fmt == 4 else step2.lod_ladder(W, H, D)
        (work / "processing_meta.json").write_text(json.dumps({
            "lod_levels": lod_levels, "n_channels": C, "n_timepoints": n_tp, "datasetFormat": fmt,
            "voxel_size": vs, "channel_names": [f"c{c}" for c in range(C)],
            "width": W, "height": H, "depth": D}), encoding="utf-8")
        ds = self.web / dtype / folder
        ds.mkdir(parents=True)
        for t, vols in enumerate(vols_by_t):
            for c, vol in enumerate(vols):
                vol.tofile(work / f"t{t:03d}_c{c}_lod0.bin")
                prev = vol
                for li in lod_levels[1:]:
                    if fmt == 4:
                        prev = v3.reduce_level(prev, li["halveZ"])
                    else:
                        prev = np.stack([np.asarray(Image.fromarray(p).resize(
                            (li["width"], li["height"]), Image.Resampling.BILINEAR)) for p in vol])
                    prev.tofile(work / f"t{t:03d}_c{c}_lod{li['lod']}.bin")
            key = f"t{t:03d}" if n_tp > 1 else ""
            if fmt == 4:
                packed = step3.pack_timepoint_v3(work, ds / "bricks", t, lod_levels, C, _Serial(), key)
            else:
                levels, transport = step3.pack_timepoint(work, ds / "bricks", t, lod_levels, C,
                                                         _Serial(), key)
                packed = {"levels": levels, "brickTransport": transport}
            (work / f"pack_t{t:03d}.json").write_text(json.dumps(packed), encoding="utf-8")
        step3.build_packs(work, ds)
        step4.generate_catalog_metadata(work, ds)
        meta = json.loads((ds / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["formatVersion"], fmt)
        return ds

    def _migrate(self, dataset_id, mid, to):
        plan = dm.plan_job(dataset_id, mid)
        self.assertGreater(plan["total"], 0, mid)
        for _ in range(100000):
            r = dm.unit_run(dataset_id, mid, max_seconds=20)
            if r["done"] >= r["total"]:
                break
        for _ in range(10000):
            r = dm.finalize(dataset_id, mid)
            if r.get("complete", True):
                break
        self.assertEqual(r.get("formatVersion"), to, r)

    def _files(self, ds, root, manifests=True):
        base = ds / root
        return {p.relative_to(base).as_posix(): p.read_bytes()
                for p in sorted(base.rglob("*"))
                if p.is_file() and (manifests or p.name != "manifest.json")}

    def _compare_bricks(self, made, migrated, keys):
        a = json.loads((made / "bricks" / "manifest.json").read_bytes())
        b = json.loads((migrated / "bricks" / "manifest.json").read_bytes())
        for doc in (a, b):
            for k in ("producer", "createdAt", "histograms", "timepointHistograms", "dataset"):
                doc.pop(k, None)
        self.assertEqual(a, b)
        bricks = 0
        for key in keys:
            ta = made / "bricks" / key if key else made / "bricks"
            tb = migrated / "bricks" / key if key else migrated / "bricks"
            ia, ib = (ta / "index.bin").read_bytes(), (tb / "index.bin").read_bytes()
            pa, pb = v3.parse_index_bin(ia), v3.parse_index_bin(ib)
            self.assertEqual(pa["levels"], pb["levels"], key)
            for k, (ea, eb) in enumerate(zip(pa["entries"], pb["entries"])):
                self.assertTrue(np.array_equal(ea["length"] > 0, eb["length"] > 0), (key, k))
                for c in range(pa["channels"]):
                    for i in np.nonzero(ea[c]["length"])[0]:
                        ra, rb = ea[c][i], eb[c][i]
                        da = (ta / v3.pack_rel(k, c, int(ra["pack"]))).read_bytes()
                        db = (tb / v3.pack_rel(k, c, int(rb["pack"]))).read_bytes()
                        va = v3.decode_brick(da[int(ra["offset"]):int(ra["offset"]) + int(ra["length"])])
                        vb = v3.decode_brick(db[int(rb["offset"]):int(rb["offset"]) + int(rb["length"])])
                        self.assertTrue(np.array_equal(va, vb), (key, k, c, int(i)))
                        bricks += 1
            self.assertEqual(ia, ib, f"{key or 'bricks'}: index.bin differs")
            self.assertEqual(self._files(made, f"bricks/{key}" if key else "bricks", False),
                             self._files(migrated, f"bricks/{key}" if key else "bricks", False),
                             f"{key or 'bricks'}: packs differ")
        return bricks

    def _compare_mips(self, made, migrated, keys):
        fa, fb = self._files(made, "mips"), self._files(migrated, "mips")
        self.assertEqual(sorted(fa), sorted(fb))
        for name, data in fa.items():
            other = fb[name]
            if name.endswith("manifest.json"):
                a, b = json.loads(data), json.loads(other)
                self.assertEqual(a.pop("producer"), "pipeline")
                self.assertTrue(b.pop("producer").startswith("migration"))
                a.pop("createdAt"), b.pop("createdAt")
                # Each names its own bricks manifest (whose bytes differ by producer/date).
                for doc, ds in ((a, made), (b, migrated)):
                    self.assertEqual(doc.pop("source"), {"manifestSha256": hashlib.sha256(
                        (ds / "bricks" / "manifest.json").read_bytes()).hexdigest()})
                self.assertEqual(list(a), list(b), name)
                self.assertEqual(a, b, name)
                continue
            ha = pw.parse_plane_pack_header(data, mw.PACK_MAGIC)
            hb = pw.parse_plane_pack_header(other, mw.PACK_MAGIC)
            self.assertEqual({k: v for k, v in ha.items() if k != "entries"},
                             {k: v for k, v in hb.items() if k != "entries"}, name)
            for (oa, la), (ob, lb) in zip(ha["entries"], hb["entries"]):
                self.assertEqual(bool(la), bool(lb), name)
                if la:
                    self.assertTrue(np.array_equal(_decode_png(data[oa:oa + la]),
                                                   _decode_png(other[ob:ob + lb])), name)
        return len(fa)

    def _run_case(self, dtype, W, H, D, C, n_tp, voxel, seed):
        rng = np.random.default_rng(seed)
        vols = [_lod0(W, H, D, C, rng) for _ in range(n_tp)]
        made = self._publish(4, dtype, "made", vols, voxel)
        old = self._publish(2, dtype, "old", vols, voxel)
        planes_before = self._files(old, "planes")
        self._migrate(f"{dtype}/old", "m003-layer-mips", 3)
        self._migrate(f"{dtype}/old", "m004-bricks-v3", 4)
        self.assertEqual(json.loads((old / "metadata.json").read_text())["formatVersion"], 4)
        self.assertFalse((old / "bricks.v2-old").exists())
        self.assertFalse(list(old.glob(".*-incoming")))
        keys = [f"t{t:03d}" for t in range(n_tp)] if n_tp > 1 else [""]
        self.assertGreater(self._compare_bricks(made, old, keys), 0)
        self.assertGreater(self._compare_mips(made, old, keys), 0)
        # planes/: same voxels, manifests re-stamped with the v3 manifest's sha256.
        pa, pb = self._files(made, "planes"), self._files(old, "planes")
        self.assertEqual(sorted(pa), sorted(pb))
        for name in pa:
            if not name.endswith("manifest.json"):
                self.assertEqual(pa[name], pb[name], name)
                self.assertEqual(pb[name], planes_before[name], name)
        self.assertTrue(v3.bricks_complete(old))
        self.assertEqual(step4.dataset_format_version(old), 4)

    def test_3d_dataset(self):
        self._run_case("3d", 600, 530, 70, 2, 1, (1.0, 1.0, 2.5), 101)

    def test_live_dataset(self):
        self._run_case("live", 530, 140, 9, 2, 2, (1.38, 1.38, 5.75), 111)


if __name__ == "__main__":
    if not HAVE_DEPS:
        print(f"SKIP test_v3_pipe_parity: {MISSING}")
    unittest.main()
