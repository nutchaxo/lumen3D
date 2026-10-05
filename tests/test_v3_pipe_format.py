"""Format 4 written by the pipeline (DOCS/dataset-migrations/SPEC.md §12, §13).

  * levels: the ladder rule (X/Y halved, Z halved iff vz_k ≤ 1.5·vxy_{k+1}, stop at
    max(X, Y) ≤ 128) on the lab's real shapes; the integer mean rounded half up against a
    brute-force reference, odd edges included; the streaming reduction (two planes at a
    time) equal to the whole-array one;
  * bricks: 66³ with a 1-voxel apron (neighbour voxels inside, clamp-to-edge outside),
    the 9 × 8 mosaic layout, lossless WebP round trip, exact ESS (a single voxel of 1
    keeps a brick; a zero interior with a non-zero border does not);
  * packs (64 bricks / 16 MiB), index.bin byte layout;
  * step 3 end to end ('3d' and 'live'): every brick of every level decoded from
    index.bin + packs equals the apron brick of the level file; planes = LOD0 verbatim,
    MIPs = per-layer maximum; manifests name the v3 manifest's sha256; step 4 says
    formatVersion 4, and less when a structure is missing.

Needs Python 3.12 with numpy, scipy, h5py, Pillow (WebP) and tqdm.
"""
import hashlib
import importlib.util
import io
import json
import shutil
import struct
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRE = ROOT / "preprocess"
sys.path.insert(0, str(PRE))

try:
    import numpy as np
    import scipy  # noqa: F401
    import h5py  # noqa: F401
    import tqdm  # noqa: F401
    from PIL import Image
    HAVE_DEPS = True
    MISSING = ""
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
    step2 = _load("lumen_v3_pipe_step2", "2-image_processor.py")
    step3 = _load("lumen_v3_pipe_step3", "3-chunk_packer.py")
    step4 = _load("lumen_v3_pipe_step4", "4-catalog_generator.py")


class _Serial:
    _max_workers = 1

    def submit(self, fn, task):
        from concurrent.futures import Future
        fut = Future()
        fut.set_result(fn(task))
        return fut


def _brute_reduce(a, halve_z):
    D, H, W = a.shape
    out = np.zeros(((D + 1) // 2 if halve_z else D, (H + 1) // 2, (W + 1) // 2), np.uint8)
    for z in range(out.shape[0]):
        zs = range(2 * z, min(D, 2 * z + 2)) if halve_z else (z,)
        for y in range(out.shape[1]):
            for x in range(out.shape[2]):
                vals = [int(a[zz, yy, xx]) for zz in zs for yy in range(2 * y, min(H, 2 * y + 2))
                        for xx in range(2 * x, min(W, 2 * x + 2))]
                n = len(vals)
                out[z, y, x] = (sum(vals) + n // 2) // n
    return out


@unittest.skipUnless(HAVE_DEPS, "preprocessing dependencies missing")
class Arithmetic(unittest.TestCase):
    def _dims(self, ladder):
        return [(lv["dimensions"]["x"], lv["dimensions"]["y"], lv["dimensions"]["z"]) for lv in ladder]

    def test_ladder_on_the_lab_shapes(self):
        cases = {
            ((3789, 3789, 257), (0.430366, 0.430366, 2.057107)):
                [(3789, 3789, 257), (1895, 1895, 257), (948, 948, 129), (474, 474, 65),
                 (237, 237, 33), (119, 119, 17)],
            ((5735, 5735, 172), (0.344419, 0.344419, 3.0)):
                [(5735, 5735, 172), (2868, 2868, 172), (1434, 1434, 172), (717, 717, 86),
                 (359, 359, 43), (180, 180, 22), (90, 90, 11)],
            ((922, 1024, 58), (1.383774, 1.383779, 5.756345)):
                [(922, 1024, 58), (461, 512, 58), (231, 256, 29), (116, 128, 15)],
            ((128, 100, 9), (1, 1, 1)): [(128, 100, 9)],
            ((129, 10, 9), (1, 1, 1)): [(129, 10, 9), (65, 5, 5)],
        }
        for (dims, vs), want in cases.items():
            ladder = v3.level_ladder(dims, {"x": vs[0], "y": vs[1], "z": vs[2]})
            self.assertEqual(self._dims(ladder), want, dims)
            self.assertEqual([lv["level"] for lv in ladder], list(range(len(want))))
            for prev, lv in zip(ladder, ladder[1:]):
                self.assertEqual(lv["voxelSize"]["x"], 2 * prev["voxelSize"]["x"])
                self.assertEqual(lv["halveZ"], prev["voxelSize"]["z"] <= 1.5 * max(
                    lv["voxelSize"]["x"], lv["voxelSize"]["y"]))
                self.assertEqual(lv["voxelSize"]["z"],
                                 prev["voxelSize"]["z"] * (2 if lv["halveZ"] else 1))
        # Without calibration the voxel is taken as a cube.
        self.assertEqual(self._dims(v3.level_ladder((300, 300, 40), {"x": 0, "y": 0, "z": 0})),
                         [(300, 300, 40), (150, 150, 20), (75, 75, 10)])

    def test_reduction_is_the_half_up_integer_mean(self):
        rng = np.random.default_rng(7)
        for shape in ((7, 9, 5), (1, 1, 1), (2, 3, 1), (6, 4, 8)):
            a = rng.integers(0, 256, size=shape, dtype=np.uint8)
            for hz in (True, False):
                self.assertTrue(np.array_equal(v3.reduce_level(a, hz), _brute_reduce(a, hz)),
                                (shape, hz))
        # Half up: 1 and 2 average to 2, 1,1,1,2 to 1 (5/4 = 1.25), 255s stay 255.
        self.assertEqual(int(v3.reduce_level(np.array([[[1, 2]]], np.uint8), False)[0, 0, 0]), 2)
        self.assertEqual(int(v3.reduce_level(np.array([[[1, 1], [1, 2]]], np.uint8), False)[0, 0, 0]), 1)
        self.assertEqual(int(v3.reduce_level(np.full((2, 2, 2), 255, np.uint8), True)[0, 0, 0]), 255)

    def test_streaming_reduction_equals_whole_level(self):
        rng = np.random.default_rng(8)
        tmp = Path(tempfile.mkdtemp(prefix="lumen_v3_reduce_"))
        try:
            a = rng.integers(0, 256, size=(13, 37, 41), dtype=np.uint8)
            src = tmp / "src.bin"
            a.tofile(src)
            for hz in (True, False):
                want = v3.reduce_level(a, hz)
                dst = tmp / f"dst{hz}.bin"
                dst.write_bytes(b"\0" * want.size)
                for z0 in range(0, want.shape[0], 3):
                    v3.reduce_task((str(src), a.shape, str(dst), want.shape, hz, z0,
                                    min(z0 + 3, want.shape[0])))
                got = np.fromfile(dst, np.uint8).reshape(want.shape)
                self.assertTrue(np.array_equal(got, want), hz)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_apron_brick(self):
        rng = np.random.default_rng(9)
        vol = rng.integers(0, 256, size=(70, 130, 65), dtype=np.uint8)
        b = v3.brick_with_apron(vol, 1, 1, 1)
        self.assertEqual(b.shape, (66, 66, 66))
        # Interior voxels, then the -1 border from the neighbour, then the clamp.
        self.assertTrue(np.array_equal(b[1:7, 1:65, 1:2], vol[64:70, 64:128, 64:65]))
        self.assertTrue(np.array_equal(b[1:7, 0, 0], vol[64:70, 63, 63]))
        self.assertTrue(np.array_equal(b[1:7, 65, 1], vol[64:70, 128, 64]))
        self.assertTrue((b[7:, 3, 1] == vol[69, 66, 64]).all())          # z past the end
        self.assertTrue((b[3, 3, 2:] == vol[66, 66, 64]).all())          # x past the end
        first = v3.brick_with_apron(vol, 0, 0, 0)
        self.assertTrue(np.array_equal(first[0], first[1]))              # z = -1 clamps to 0
        self.assertTrue(np.array_equal(first[:, 0], first[:, 1]))
        for bx, brick in enumerate(v3.brick_row(vol, 1, 0)):
            self.assertTrue(np.array_equal(brick, v3.brick_with_apron(vol, bx, 1, 0)))

    def test_mosaic_and_webp(self):
        rng = np.random.default_rng(10)
        b = rng.integers(0, 256, size=(66, 66, 66), dtype=np.uint8)
        m = v3.mosaic_9x8(b)
        self.assertEqual(m.shape, (528, 594))
        for s in (0, 8, 9, 40, 65):
            r, c = divmod(s, 9)
            self.assertTrue(np.array_equal(m[r * 66:(r + 1) * 66, c * 66:(c + 1) * 66], b[s]))
        self.assertFalse(m[7 * 66:, 3 * 66:].any())                       # slots 66..71
        data = v3.encode_brick(b)
        self.assertEqual(data[:4], b"RIFF")
        self.assertEqual(data[12:16], b"VP8L")                            # lossless bitstream
        self.assertTrue(np.array_equal(v3.decode_brick(data), b))

    def test_exact_ess(self):
        b = np.zeros((66, 66, 66), np.uint8)
        self.assertFalse(v3.brick_kept(b))
        b[0, 5, 5] = b[65, 5, 5] = b[5, 0, 5] = b[5, 5, 65] = 200          # border only
        self.assertFalse(v3.brick_kept(b))
        b[64, 64, 64] = 1                                                 # one interior 1
        self.assertTrue(v3.brick_kept(b))

    def test_packs_roll_over(self):
        lay, n = v3.pack_layout([10] * 130)            # one row along X: super-blocks of 4
        self.assertEqual(n, 3)
        self.assertEqual([lay[i][0] for i in (0, 63, 64, 127, 128)], [0, 0, 1, 1, 2])
        big = v3.PACK_MAX_BYTES // 3 + 1
        lay, n = v3.pack_layout([big, big, big, 5], (1, 1, 4))   # one super-block > 16 MiB: split
        self.assertEqual(lay, [(0, 0, big), (0, big, big), (1, 0, big), (1, big, 5)])
        # whole super-blocks: the second one (3 bricks) does not fit after 62 bricks
        lens = [1] * 62 + [0, 0] + [1] * 3 + [0]
        lay, n = v3.pack_layout(lens, (4 * 17, 1, 1))
        self.assertEqual((n, lay[61][0], lay[64]), (2, 0, (1, 0, 1)))
        tmp = Path(tempfile.mkdtemp(prefix="lumen_v3_pack_"))
        try:
            grid = (6, 5, 3)
            rng = np.random.default_rng(3)
            lens = [int(v) if v > 2 else 0 for v in rng.integers(0, 40, 6 * 5 * 3)]
            w = v3.PackWriter(tmp, 2, 1)
            got = [(0, 0, 0)] * len(lens)
            for block in v3.superblock_order(grid):
                keys = [i for i in block if lens[i]]
                for i, e in zip(keys, w.add_superblock([bytes(lens[i]) for i in keys])):
                    got[i] = e
            w.close()
            lay, n = v3.pack_layout(lens, grid)
            self.assertEqual(got, lay)
            self.assertEqual(n, w.pack_count)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_index_layout(self):
        e0 = np.zeros((2, 2 * 1 * 3), v3.INDEX_ENTRY)
        e0[1, 4] = (3, 1000, 77)
        e1 = np.zeros((2, 1), v3.INDEX_ENTRY)
        e1[0, 0] = (0, 0, 5)
        blob = v3.index_bin_bytes([(2, 1, 3, 4), (1, 1, 1, 1)], 2, [e0, e1])
        self.assertEqual(blob[:12], b"LBIX" + struct.pack("<HHHH", 1, 2, 2, 0))
        self.assertEqual(blob[12:44], struct.pack("<IIIIIIII", 2, 1, 3, 4, 1, 1, 1, 1))
        off = 44 + (1 * 6 + 4) * 10                                         # level 0, c1, brick 4
        self.assertEqual(blob[off:off + 10], struct.pack("<HII", 3, 1000, 77))
        self.assertEqual(len(blob), 44 + (12 + 2) * 10)
        back = v3.parse_index_bin(blob)
        self.assertTrue(np.array_equal(back["entries"][0], e0))
        with self.assertRaises(ValueError):
            e0[0, 0] = (1, 0, 0)                                            # absent but not zeros
            v3.index_bin_bytes([(2, 1, 3, 4), (1, 1, 1, 1)], 2, [e0, e1])


def _levels_files(work, t_idx, lod_levels, C, rng, low_signal=True):
    """LOD0 with structure, then the real reduction for every coarser level."""
    li0 = lod_levels[0]
    for c in range(C):
        D, H, W = li0["depth"], li0["height"], li0["width"]
        vol = (rng.random((D, H, W)) < 0.003).astype(np.uint8) * rng.integers(
            6, 256, size=(D, H, W), dtype=np.uint8)
        h, w = min(H, 150), min(W, 110)
        vol[:, :h, :w] = rng.integers(0, 230, size=(D, h, w), dtype=np.uint8)
        if low_signal:
            vol[:, -64:, -60:] = 0
            vol[2, H - 3, W - 5] = 1           # one voxel of 1: v2 dropped it, v3 keeps it
        if c == C - 1:
            vol[:, :, 512:] = 0
        path = work / f"t{t_idx:03d}_c{c}_lod0.bin"
        vol.tofile(path)
        prev = vol
        for li in lod_levels[1:]:
            prev = v3.reduce_level(prev, li["halveZ"])
            self_shape = (li["depth"], li["height"], li["width"])
            assert prev.shape == self_shape
            prev.tofile(work / f"t{t_idx:03d}_c{c}_lod{li['lod']}.bin")


def _decode(png):
    img = Image.open(io.BytesIO(png))
    img.load()
    return np.asarray(img)


@unittest.skipUnless(HAVE_DEPS, "preprocessing dependencies missing")
class PipelineTree(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen_v3_pipe_"))
        self.present = {}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _dataset(self, dtype, W, H, D, C, n_tp, seed, voxel=(1.0, 1.0, 2.5)):
        work = self.tmp / "work"
        work.mkdir()
        lod_levels = step2.pyramid_levels(W, H, D, {"x": voxel[0], "y": voxel[1], "z": voxel[2]})
        (work / "processing_meta.json").write_text(json.dumps({
            "lod_levels": lod_levels, "n_channels": C, "n_timepoints": n_tp, "datasetFormat": 4,
            "voxel_size": {"x": voxel[0], "y": voxel[1], "z": voxel[2]},
            "channel_names": [f"c{c}" for c in range(C)], "width": W, "height": H, "depth": D}),
            encoding="utf-8")
        ds = self.tmp / dtype / "ds"
        ds.mkdir(parents=True)
        for t in range(n_tp):
            _levels_files(work, t, lod_levels, C, np.random.default_rng(seed + t))
            packed = step3.pack_timepoint_v3(work, ds / "bricks", t, lod_levels, C, _Serial(),
                                             f"t{t:03d}" if n_tp > 1 else "")
            (work / f"pack_t{t:03d}.json").write_text(json.dumps(packed), encoding="utf-8")
        step3.build_packs(work, ds)
        step4.generate_catalog_metadata(work, ds)
        return work, ds, lod_levels

    def _check_tree(self, work, ds, key, t_idx, lod_levels, C):
        manifest_raw = (ds / "bricks" / "manifest.json").read_bytes()
        manifest = json.loads(manifest_raw)
        sha = hashlib.sha256(manifest_raw).hexdigest()
        tree = ds / "bricks" / key if key else ds / "bricks"
        blob = (tree / "index.bin").read_bytes()
        info = v3.tree_index_info(manifest, key)
        self.assertEqual(info["url"], f"{key}/index.bin" if key else "index.bin")
        self.assertEqual((info["bytes"], info["sha256"]), (len(blob), hashlib.sha256(blob).hexdigest()))
        idx = v3.parse_index_bin(blob)
        self.assertEqual(idx["channels"], C)
        self.assertEqual(len(idx["levels"]), len(lod_levels))
        kept_low = 0
        present = self.present
        for li, (gx, gy, gz, packs), entries, row in zip(lod_levels, idx["levels"], idx["entries"],
                                                         manifest["levels"]):
            k = li["lod"]
            self.assertEqual(row["dimensions"], {"x": li["width"], "y": li["height"], "z": li["depth"]})
            self.assertEqual(row["gridSize"], {"x": gx, "y": gy, "z": gz})
            used = set()
            present[k] = present.get(k, 0) + int((entries["length"] > 0).sum())
            for c in range(C):
                vol = np.fromfile(work / f"t{t_idx:03d}_c{c}_lod{k}.bin", np.uint8).reshape(
                    li["depth"], li["height"], li["width"])
                order = []
                rows_c = entries[c].tolist()
                for i, (pack, off, ln) in enumerate(rows_c):
                    bz, rem = divmod(i, gy * gx)
                    by, bx = divmod(rem, gx)
                    want = v3.brick_with_apron(vol, bx, by, bz)
                    if not ln:
                        self.assertEqual((pack, off), (0, 0))
                        self.assertFalse(v3.brick_kept(want), (k, c, bx, by, bz))
                        continue
                    data = (tree / v3.pack_rel(k, c, pack)).read_bytes()[off:off + ln]
                    got = v3.decode_brick(data)
                    self.assertTrue(np.array_equal(got, want), (k, c, bx, by, bz))
                    interior = want[1:65, 1:65, 1:65]
                    if k == 0 and interior.max() == 1:
                        kept_low += 1
                    order.append((pack, off, ln))
                    used.add((c, pack))
                # Bricks are grouped by super-block and the packs follow the rule (SPEC §13.4).
                lay, _n = v3.pack_layout([ln for _, _, ln in rows_c], (gx, gy, gz))
                self.assertEqual([tuple(r) for r in rows_c], lay)
            self.assertEqual(packs, len(used))
        planes = ds / "planes" / key if key else ds / "planes"
        mips = ds / "mips" / key if key else ds / "mips"
        for doc_path, schema in ((planes / "manifest.json", "lumen-planes-v1"),
                                 (mips / "manifest.json", "lumen-mips-v1")):
            doc = json.loads(doc_path.read_text(encoding="utf-8"))
            self.assertEqual(doc["schema"], schema)
            self.assertEqual(doc["source"]["manifestSha256"], sha)
        li0 = lod_levels[0]
        X, Y, Z = li0["width"], li0["height"], li0["depth"]
        lod0 = np.stack([np.fromfile(work / f"t{t_idx:03d}_c{c}_lod0.bin", np.uint8).reshape(Z, Y, X)
                         for c in range(C)], axis=1)
        tx_n, ty_n = -(-X // 512), -(-Y // 512)
        for z in range(Z):
            data = (planes / pw.pack_name(z)).read_bytes()
            head = pw.parse_plane_pack_header(data)
            for i, (off, ln) in enumerate(head["entries"]):
                c, rem = divmod(i, ty_n * tx_n)
                ty, tx = divmod(rem, tx_n)
                want = lod0[z, c, ty * 512:(ty + 1) * 512, tx * 512:(tx + 1) * 512]
                if ln:
                    self.assertTrue(np.array_equal(_decode(data[off:off + ln]), want))
                else:
                    self.assertFalse(want.any())
        doc = json.loads((mips / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual((doc["layers"], doc["layerDepth"], doc["packPattern"]), (-(-Z // 64), 64, "l{l}.bin"))
        for layer in range(-(-Z // 64)):
            data = (mips / mw.pack_name(layer)).read_bytes()
            self.assertEqual(data[:4], b"LMIP")
            head = pw.parse_plane_pack_header(data, mw.PACK_MAGIC)
            self.assertEqual(head["z"], layer)
            mip = lod0[layer * 64:(layer + 1) * 64].max(axis=0)
            for i, (off, ln) in enumerate(head["entries"]):
                c, rem = divmod(i, ty_n * tx_n)
                ty, tx = divmod(rem, tx_n)
                want = mip[c, ty * 512:(ty + 1) * 512, tx * 512:(tx + 1) * 512]
                if ln:
                    self.assertTrue(np.array_equal(_decode(data[off:off + ln]), want))
                else:
                    self.assertFalse(want.any())
        return kept_low

    def test_3d_dataset(self):
        work, ds, lod_levels = self._dataset("3d", 600, 530, 70, 2, 1, 61)
        self.assertEqual([(li["width"], li["height"], li["depth"]) for li in lod_levels],
                         [(600, 530, 70), (300, 265, 35), (150, 133, 18), (75, 67, 9)])
        manifest = json.loads((ds / "bricks" / "manifest.json").read_bytes())
        self.assertEqual(list(manifest), ["schema", "version", "formatVersion", "dataset", "channels",
                                          "brickSize", "apron", "brickPacking", "encoding",
                                          "levels", "timepoints", "index", "histograms",
                                          "producer", "createdAt"])
        self.assertEqual(manifest["dataset"], "ds")
        self.assertEqual(manifest["brickPacking"], {"mode": "grid", "cols": 9, "rows": 8, "slice": 66})
        self.assertIsNone(manifest["timepoints"])
        self.assertEqual(len(manifest["histograms"]), 2)
        self.assertNotIn(b"\n", (ds / "bricks" / "manifest.json").read_bytes())
        self.assertGreaterEqual(self._check_tree(work, ds, "", 0, lod_levels, 2), 1)
        self.assertEqual([row["brickCount"] for row in manifest["levels"]],
                         [self.present[k] for k in range(len(lod_levels))])
        meta = json.loads((ds / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["formatVersion"], 4)
        self.assertTrue(v3.bricks_complete(ds))
        self.assertFalse(list((ds / "bricks").glob("**/pack_*.bin")))

    def test_live_dataset(self):
        work, ds, lod_levels = self._dataset("live", 530, 140, 9, 2, 2, 71)
        manifest = json.loads((ds / "bricks" / "manifest.json").read_bytes())
        self.assertNotIn("index", manifest)
        self.assertEqual(manifest["timepoints"], [
            {"path": k, "index": {"url": f"{k}/index.bin",
                                  "bytes": (ds / "bricks" / k / "index.bin").stat().st_size,
                                  "sha256": hashlib.sha256((ds / "bricks" / k / "index.bin").read_bytes()).hexdigest()}}
            for k in ("t000", "t001")])
        self.assertEqual(sorted(manifest["timepointHistograms"]), ["t000", "t001"])
        for t in range(2):
            self._check_tree(work, ds, f"t{t:03d}", t, lod_levels, 2)
        # brickCount = bricks present over all channels and both trees.
        self.assertEqual([row["brickCount"] for row in manifest["levels"]],
                         [self.present[k] for k in range(len(lod_levels))])
        meta = json.loads((ds / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["formatVersion"], 4)

    def test_format_follows_the_structures_on_disk(self):
        work, ds, _ = self._dataset("3d", 300, 200, 12, 1, 1, 81)
        self.assertEqual(step4.dataset_format_version(ds), 4)
        (ds / "bricks" / "index.bin").write_bytes(b"LBIX")
        self.assertEqual(step4.dataset_format_version(ds), 3)
        shutil.rmtree(ds / "mips")
        self.assertEqual(step4.dataset_format_version(ds), 2)
        (ds / "planes" / "manifest.json").unlink()
        self.assertEqual(step4.dataset_format_version(ds), 1)

    def test_histogram_injection_restamps_planes_and_mips(self):
        work, ds, _ = self._dataset("3d", 300, 200, 12, 1, 1, 91)
        path = ds / "bricks" / "manifest.json"
        manifest = json.loads(path.read_bytes())
        manifest["histograms"] = []
        path.write_text(json.dumps(manifest), encoding="utf-8")
        self.assertEqual(step4.dataset_format_version(ds), 1)
        step4.generate_catalog_metadata(work, ds)
        self.assertTrue(json.loads(path.read_bytes())["histograms"])
        self.assertEqual(json.loads((ds / "metadata.json").read_text())["formatVersion"], 4)


if __name__ == "__main__":
    if not HAVE_DEPS:
        print(f"SKIP test_v3_pipe_format: {MISSING}")
    unittest.main()
