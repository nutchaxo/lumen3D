"""Format 5 (SPEC Part III, §14): format5.py and the migration m005-matrix.

Pure part: the level ladder, the exact area average against a brute-force reference,
the bounded quantizers, the dead-zone rule, the mosaics, every column's error bound, the
xz/yz packs, the cut records, the LBIX index and the pack rule.

Pipeline writer: format5.write_tree on a synthetic volume decodes back to independent
references (levels, bricks with their border, xy/xz/yz planes, cut bricks).

Migration: a synthetic format-1 dataset is taken through m002 → m003 → m004 → m005; the
format-5 tree the migration assembles is byte-identical, file by file, to the one
write_tree makes from the same voxels (the two producers share every function); the
dataset is then at version 5 with valid planes/mips, and status / repair / resumability
behave. A timelapse takes the same path.

Run: python tests/test_format5.py
"""
import json
import os
import shutil
import struct
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

import numpy as np  # noqa: E402

import dataset_migrations as dm  # noqa: E402
import format5 as f5  # noqa: E402
from test_v3_py_migrations import make_3d, make_live, run_job  # noqa: E402

M2, M3, M4, M5 = "m002-planes", "m003-layer-mips", "m004-bricks-v3", "m005-matrix"


def brute_resample(plane, out_w, out_h):
    H0, W0 = plane.shape
    out = np.zeros((out_h, out_w), dtype=np.int64)
    for iy in range(out_h):
        for ix in range(out_w):
            s = 0
            for jy in range(H0):
                wy = max(0, min((jy + 1) * out_h, (iy + 1) * H0) - max(jy * out_h, iy * H0))
                if not wy:
                    continue
                for jx in range(W0):
                    wx = max(0, min((jx + 1) * out_w, (ix + 1) * W0) - max(jx * out_w, ix * W0))
                    s += wx * wy * int(plane[jy, jx])
            out[iy, ix] = (s + W0 * H0 // 2) // (W0 * H0)
    return out.astype(np.uint8)


def ref_brick66(vol, bx, by, bz):
    Z, Y, X = vol.shape
    zi = np.clip(np.arange(64 * bz - 1, 64 * bz + 65), 0, Z - 1)
    yi = np.clip(np.arange(64 * by - 1, 64 * by + 65), 0, Y - 1)
    xi = np.clip(np.arange(64 * bx - 1, 64 * bx + 65), 0, X - 1)
    return vol[np.ix_(zi, yi, xi)]


def level_volumes(vol, levels):
    """Every level of one channel by the brute-force-checked resample, plane by plane."""
    out = [vol]
    for L in levels[1:]:
        d = L["dimensions"]
        out.append(np.stack([f5.resample_plane(vol[z], d["x"], d["y"]) for z in range(vol.shape[0])]))
    return out


class Pure(unittest.TestCase):
    def test_ladder(self):
        L = f5.level_ladder((5192, 5192, 312), (0.3, 0.3, 2.0))
        self.assertEqual([r["target"] for r in L], ["native", 4096, 2048, 1024, 512, 256])
        self.assertEqual([r["dimensions"]["x"] for r in L], [5192, 4096, 2048, 1024, 512, 256])
        self.assertTrue(all(r["dimensions"]["z"] == 312 for r in L))
        self.assertAlmostEqual(L[1]["voxelSize"]["x"], 0.3 * 5192 / 4096)
        self.assertEqual(L[1]["voxelSize"]["z"], 2.0)
        self.assertEqual([r["target"] for r in f5.level_ladder((520, 300, 5), (1, 1, 1))], ["native", 512, 256])
        self.assertEqual([r["target"] for r in f5.level_ladder((512, 512, 5), (1, 1, 1))], ["native", 256])
        self.assertEqual([r["target"] for r in f5.level_ladder((256, 100, 5), (1, 1, 1))], ["native"])
        self.assertEqual([r["target"] for r in f5.level_ladder((200, 100, 5), (1, 1, 1))], ["native"])
        r = f5.level_ladder((600, 1000, 7), (1, 1, 1))[1]   # Y is the long axis
        self.assertEqual((r["dimensions"]["x"], r["dimensions"]["y"]), ((2 * 600 * 512 + 1000) // 2000, 512))
        r = f5.level_ladder((3789, 3789, 252), (1, 1, 1))
        self.assertEqual([x["dimensions"]["x"] for x in r], [3789, 2048, 1024, 512, 256])

    def test_resample_exact(self):
        rng = np.random.default_rng(1)
        for (h, w, oh, ow) in ((37, 53, 14, 20), (40, 40, 40, 40), (17, 64, 9, 32), (65, 33, 64, 32), (5, 7, 1, 1)):
            plane = rng.integers(0, 256, (h, w), dtype=np.uint8)
            got = f5.resample_plane(plane, ow, oh, band=3)
            self.assertTrue(np.array_equal(got, brute_resample(plane, ow, oh)), (h, w, oh, ow))
        flat = np.full((50, 70), 200, np.uint8)
        self.assertTrue((f5.resample_plane(flat, 33, 21) == 200).all())

    def test_quantizer(self):
        for e in (2, 4):
            idx, val = f5.quantizer(e)
            v = np.arange(256)
            self.assertEqual(int(idx[0]), 0)
            self.assertEqual(int(val[0]), 0)
            self.assertLessEqual(int(np.abs(val[idx].astype(int) - v).max()), e)
            self.assertTrue((idx[1:] > 0).all())

    def test_dead_zone_is_optimal(self):
        rng = np.random.default_rng(2)
        src = rng.integers(0, 30, (66, 66, 66), dtype=np.uint8)
        src[src < 10] = 0
        dec = np.clip(src.astype(int) + rng.integers(-4, 5, src.shape), 0, 255).astype(np.uint8)
        tau = f5.dead_zone(src, dec)
        s = src[1:-1, 1:-1, 1:-1].astype(int)
        sse = []
        for t in range(13):
            d = dec[1:-1, 1:-1, 1:-1].astype(int)
            d = np.where(d <= t, 0, d)
            sse.append(int(((d - s) ** 2).sum()))
        self.assertEqual(tau, int(np.argmin(sse)))

    def test_mosaics_and_columns(self):
        rng = np.random.default_rng(3)
        b = rng.integers(0, 256, (66, 66, 66), dtype=np.uint8)
        b[:, :20] = 0
        self.assertTrue(np.array_equal(f5.unmosaic66(f5.mosaic66(b)), b))
        self.assertTrue(np.array_equal(f5.unmosaic80(f5.mosaic80(b)), b))
        for cid in f5.COLUMN_IDS:
            data = f5.encode_brick(b, cid)
            dec = f5.decode_brick(data, cid)
            bound = f5.column(cid)["maxError"]
            if bound is not None:
                self.assertLessEqual(int(np.abs(dec.astype(int) - b).max()), bound, cid)
                self.assertTrue((dec[b == 0] == 0).all(), cid)
            else:
                # Uniform noise: the b4 image is smaller than the lossy one, so the light
                # column stores it (tag 0xFE) and keeps its ±4 bound.
                self.assertIn(data[-1], set(range(f5.DEAD_ZONE_MAX + 1)) | {f5.TAG_B4, f5.TAG_LL})
                if data[-1] == f5.TAG_B4:
                    self.assertLessEqual(int(np.abs(dec.astype(int) - b).max()), 4)
                self.assertEqual(dec.shape, b.shape)
        self.assertEqual(len(f5.manifest_columns()[1]["lut"]), 256)

    def test_light_column_never_heavier(self):
        """A sparse brick: the lossy image of the 720×640 mosaic outweighs the lossless one,
        so a light column stores the faithful image with its tag, and decodes exactly."""
        rng = np.random.default_rng(8)
        b = np.zeros((66, 66, 66), np.uint8)
        idx = rng.integers(0, 66, (200, 3))
        b[idx[:, 0], idx[:, 1], idx[:, 2]] = rng.integers(1, 256, 200, dtype=np.uint8)
        enc = f5.encode_brick_columns(b)
        for cid in ("q80", "q50"):
            self.assertLessEqual(len(enc[cid]), len(enc["ll"]) + 1)
            self.assertIn(enc[cid][-1], (f5.TAG_LL, f5.TAG_B4))
            dec = f5.decode_brick(enc[cid], cid)
            ref = f5.decode_brick(enc["ll" if enc[cid][-1] == f5.TAG_LL else "b4"],
                                  "ll" if enc[cid][-1] == f5.TAG_LL else "b4")
            self.assertTrue(np.array_equal(dec, ref))
        # A dense brick keeps its lossy image (a dead-zone trailer).
        dense = rng.integers(40, 200, (66, 66, 66), dtype=np.uint8)
        self.assertLessEqual(f5.encode_brick(dense, "q50")[-1], f5.DEAD_ZONE_MAX)
        with self.assertRaises(ValueError):
            f5.decode_brick(enc["q80"][:-1] + bytes([0x40]), "q80")

    def test_orth_pack(self):
        rng = np.random.default_rng(4)
        images = [rng.integers(0, 4, (530, 700), dtype=np.uint8) for _ in range(3)]
        images[1][:] = 0
        data = f5.orth_pack("xz", 128, images)
        first, count, ta, tz, entries = f5.parse_orth_pack(data, "xz")
        self.assertEqual((first, count, ta, tz), (128, 3, 2, 2))
        for r, im in enumerate(images):
            for iz in range(tz):
                for ia in range(ta):
                    off, ln = entries[(r * tz + iz) * ta + ia]
                    want = im[iz * 512:(iz + 1) * 512, ia * 512:(ia + 1) * 512]
                    if not want.any():
                        self.assertEqual(ln, 0)
                    else:
                        self.assertTrue(np.array_equal(f5.unpng_gray8(data[off:off + ln]), want))

    def test_cut_record(self):
        rng = np.random.default_rng(5)
        X, Y, Z = 300, 270, 40
        vol = rng.integers(0, 256, (Z, Y, X), dtype=np.uint8)
        vol[:, :, 260:] = 0
        bz = 4
        rec = f5.cut_record(vol, (0, 0, 0), (X, Y, Z), bz, 0, 0, 1)
        table = f5.parse_cut_record(rec)
        i = 0
        for lz in range(8):
            for ly in range(8):
                for lx in range(8):
                    off, ln = table[i]
                    i += 1
                    z0, y0, x0 = lz * bz, ly * 32, (8 + lx) * 32
                    if z0 >= Z or y0 >= Y or x0 >= X or not vol[z0:z0 + bz, y0:y0 + 32, x0:x0 + 32].any():
                        self.assertEqual(ln, 0)
                        continue
                    got = f5.decode_cut_brick(rec[off:off + ln], bz)
                    want = np.zeros((bz, 32, 32), np.uint8)
                    sub = vol[z0:z0 + bz, y0:y0 + 32, x0:x0 + 32]
                    want[:sub.shape[0], :sub.shape[1], :sub.shape[2]] = sub
                    self.assertTrue(np.array_equal(got, want))
        self.assertIsNone(f5.cut_record(np.zeros((8, 300, 300), np.uint8), (0, 0, 0), (300, 300, 8), 1, 0, 0, 0))
        self.assertEqual(f5.cut_depth((0.344, 0.344, 3.0)), 4)
        self.assertEqual(f5.cut_depth((0.43, 0.43, 2.06)), 8)
        self.assertEqual(f5.cut_depth((1, 1, 1)), 32)
        self.assertEqual(f5.cut_depth((1, 1, 100)), 1)

    def test_pack_writer_matches_layout(self):
        rng = np.random.default_rng(6)
        grid = (9, 7, 5)
        lengths = [int(v) if rng.random() < 0.7 else 0 for v in rng.integers(1, 900000, 9 * 7 * 5)]
        layout, npacks = f5.pack_layout(lengths, grid)
        tmp = Path(tempfile.mkdtemp(prefix="lumen-f5pw-"))
        try:
            w = f5.PackWriter(lambda pk: str(tmp / ("p%d" % pk)))
            got = [(0, 0, 0)] * len(lengths)
            for block in f5.superblock_order(grid):
                members = [i for i in block if lengths[i]]
                for i, e in zip(members, w.add_group([b"x" * lengths[i] for i in members])):
                    got[i] = e
            w.close()
            self.assertEqual(got, layout)
            self.assertEqual(w.pack_count, npacks)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_index_roundtrip(self):
        e = np.zeros((2, 6), dtype=f5.INDEX_ENTRY)
        e[1, 3] = (2, 77, 5)
        blob = f5.index_bin_bytes([(3, 2, 1, 3)], 2, [e])
        p = f5.parse_index_bin(blob)
        self.assertEqual(p["levels"], [(3, 2, 1, 3)])
        self.assertEqual(tuple(p["entries"][0][1][3]), (2, 77, 5))


def write_raw(dirpath, vols):
    paths = []
    for c, v in enumerate(vols):
        p = Path(dirpath) / ("c%d.u8" % c)
        np.ascontiguousarray(v).tofile(p)
        paths.append(str(p))
    return paths


def tree_files(d: Path) -> dict:
    out = {}
    for root, _dirs, files in os.walk(d):
        for n in files:
            p = Path(root) / n
            out[p.relative_to(d).as_posix()] = p.read_bytes()
    return out


class Writer(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-f5w-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_tree_decodes_to_references(self):
        rng = np.random.default_rng(11)
        X, Y, Z = 300, 270, 40
        vols = []
        for c in range(2):
            v = rng.integers(0, 256, (Z, Y, X), dtype=np.uint8)
            v[:, :60] = 0
            v[:, :, 200:] //= 9
            vols.append(v)
        voxel = (0.5, 0.5, 2.0)
        paths = write_raw(self.tmp, vols)
        tdir = self.tmp / "ds" / "bricks"
        tree = f5.write_tree(paths, (X, Y, Z), voxel, tdir, self.tmp / "work", lambda fn, ts: map(fn, ts))
        doc = f5.manifest_v5(tree["levels"], 2, {"": tree}, [], "now")
        f5.atomic_write(tdir / "manifest.json", f5.manifest_bytes(doc))
        self.assertIsNone(f5.bricks_problem(self.tmp / "ds"))
        self.assertFalse((self.tmp / "work").exists() and any((self.tmp / "work").iterdir()))
        levels = tree["levels"]
        self.assertEqual([L["target"] for L in levels], ["native", 256])
        for c, vol in enumerate(vols):
            lv = level_volumes(vol, levels)
            for k, L in enumerate(levels):
                gx, gy, gz = (L["gridSize"][a] for a in "xyz")
                for cid in f5.COLUMN_IDS:
                    idx = f5.parse_index_bin((tdir / f5.index_rel(cid)).read_bytes())
                    ent = idx["entries"][k][c]
                    for i in range(gx * gy * gz):
                        bx, by, bz = i % gx, (i // gx) % gy, i // (gx * gy)
                        ref = ref_brick66(lv[k], bx, by, bz)
                        pk, off, ln = (int(x) for x in ent[i])
                        if not ref[1:-1, 1:-1, 1:-1].any():
                            self.assertEqual(ln, 0)
                            continue
                        data = (tdir / f5.brick_pack_rel(k, cid, c, pk)).read_bytes()[off:off + ln]
                        dec = f5.decode_brick(data, cid)
                        bound = f5.column(cid)["maxError"]
                        if bound is not None:
                            self.assertLessEqual(int(np.abs(dec.astype(int) - ref).max()), bound, (k, cid, i))
                if k:
                    for z in (0, Z // 2, Z - 1):
                        data = (tdir / f5.xy_pack_rel(k, z)).read_bytes()
                        _z, ch, tx, ty, entries = f5.parse_plane_pack(data)
                        for t_ in range(tx * ty):
                            off, ln = entries[c * tx * ty + t_]
                            ty_, tx_ = divmod(t_, tx)
                            want = lv[k][z, ty_ * 512:(ty_ + 1) * 512, tx_ * 512:(tx_ + 1) * 512]
                            got = f5.unpng_gray8(data[off:off + ln]) if ln else np.zeros_like(want)
                            self.assertTrue(np.array_equal(got, want))
                for kind in ("xz", "yz"):
                    n = lv[k].shape[1] if kind == "xz" else lv[k].shape[2]
                    for b in range(f5.orth_blocks(n)):
                        data = (tdir / f5.orth_pack_rel(kind, k, c, b)).read_bytes()
                        first, count, ta, tz, entries = f5.parse_orth_pack(data, kind)
                        r = count - 1
                        img = lv[k][:, first + r, :] if kind == "xz" else lv[k][:, :, first + r]
                        got = np.zeros_like(img)
                        for iz in range(tz):
                            for ia in range(ta):
                                off, ln = entries[(r * tz + iz) * ta + ia]
                                if ln:
                                    t = f5.unpng_gray8(data[off:off + ln])
                                    got[iz * 512:iz * 512 + t.shape[0], ia * 512:ia * 512 + t.shape[1]] = t
                        self.assertTrue(np.array_equal(got, img), (kind, k, b))
                bzc = f5.cut_depth(L["voxelSize"])
                sgx, sgy, sgz = f5.cut_super_grid(L["dimensions"], bzc)
                cidx = f5.parse_index_bin((tdir / f5.cut_index_rel(k)).read_bytes())
                for i in (0, sgx * sgy * sgz - 1):
                    pk, off, ln = (int(x) for x in cidx["entries"][0][c][i])
                    SX, SY, SZ = i % sgx, (i // sgx) % sgy, i // (sgx * sgy)
                    if not ln:
                        continue
                    rec = (tdir / f5.cut_pack_rel(k, c, pk)).read_bytes()[off:off + ln]
                    table = f5.parse_cut_record(rec)
                    o2, l2 = table[0]
                    z0, y0, x0 = SZ * 8 * bzc, SY * 256, SX * 256
                    sub = lv[k][z0:z0 + bzc, y0:y0 + 32, x0:x0 + 32]
                    if l2:
                        want = np.zeros((bzc, 32, 32), np.uint8)
                        want[:sub.shape[0], :sub.shape[1], :sub.shape[2]] = sub
                        self.assertTrue(np.array_equal(f5.decode_cut_brick(rec[o2:o2 + l2], bzc), want))
                    else:
                        self.assertFalse(sub.any())


class Migration(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-f5m-"))
        self.data_web = self.tmp / "DATA_WEB"
        for t in ("3d", "2d", "live"):
            (self.data_web / t).mkdir(parents=True)
        dm.configure(self.tmp)
        dm.server_capabilities(force=True)

    def tearDown(self):
        dm.server_capabilities(force=True)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def row(self, ds_id):
        return next(r for r in dm.status()["datasets"] if r["id"] == ds_id)

    def test_enabled_by_default(self):
        self.assertEqual(dm.LATEST, 5)
        self.assertEqual([m["id"] for m in dm.registry()][-1], M5)
        self.assertIn(M5, dm.server_capabilities(force=True)["migrations"])

    def test_3d_chain_matches_pipeline(self):
        voxel = (0.5, 0.5, 1.6)
        ds, truth = make_3d(self.data_web, Z=66, voxel=voxel)
        for mid in (M2, M3, M4):
            run_job(self, "3d/SYN3", mid)
        row = self.row("3d/SYN3")
        self.assertEqual(row["pending"], [M5])
        self.assertTrue(dm.server_capabilities()["migrations"][M5]["available"])
        out = dm.plan_job("3d/SYN3", M5)
        self.assertEqual([s["stage"] for s in out["stages"]], ["A", "B", "C", "D"])
        self.assertEqual([L["target"] for L in out["levels"]], ["native", 256])
        # a level-1 unit waits for stage A of its channel
        self.assertTrue(all(dm._m005_parse(k)[0] == 0 or dm._m005_parse(k)[2] == 0 for k in out["units"]))
        # the browser protocol takes units too (SPEC §14.10): an empty stage-A body is malformed
        st, out = dm.handle("unit_put", {"dataset": "3d/SYN3", "migration": M5, "unit": "A.t0.c0.z0"}, {}, b"")
        self.assertEqual((st, out.get("error")), (400, "bad_blob"))
        v4_l0 = {p.name: p.read_bytes() for p in (ds / "bricks" / "l0" / "c0").glob("*.bin")}
        for _ in range(10000):
            r = dm.unit_run("3d/SYN3", M5, max_seconds=20, workers=4)
            if r["done"] >= r["total"]:
                break
        calls = 0
        while True:
            calls += 1
            fin = dm.finalize("3d/SYN3", M5, max_seconds=0.001)
            if fin.get("complete"):
                break
            self.assertLess(calls, 100000)
        self.assertGreater(calls, 3)          # the assembly paused and resumed
        self.assertEqual(fin["formatVersion"], 5)
        meta = json.loads((ds / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["formatVersion"], 5)
        self.assertEqual(meta["curated"], "keep")
        self.assertFalse((ds / "bricks.v4-old").exists())
        self.assertIsNone(f5.bricks_problem(ds))
        plan = dm._plan_for("3d/SYN3")
        self.assertTrue(plan.v5)
        self.assertIsNone(plan.v5_problem)
        self.assertTrue(dm.dataset_planes_valid(plan))
        self.assertTrue(dm.dataset_mips_valid(plan))
        row = self.row("3d/SYN3")
        self.assertEqual(row["pending"], [])
        self.assertEqual(row["formatVersion"], 5)
        self.assertEqual(row["bricksSchema"], f5.SCHEMA)
        # the level-0 lossless packs are the format-4 bytes
        for name, data in v4_l0.items():
            self.assertEqual((ds / "bricks" / "l0" / "ll" / "c0" / name).read_bytes(), data)
        # byte-identical to the pipeline writer on the same voxels
        ref_dir = self.tmp / "ref"
        paths = write_raw(self.tmp, truth[0])
        tree = f5.write_tree(paths, tuple(reversed(truth[0][0].shape)), voxel, ref_dir, self.tmp / "work",
                             lambda fn, ts: map(fn, ts))
        mig = tree_files(ds / "bricks")
        ref = tree_files(ref_dir)
        mig.pop("manifest.json")
        self.assertEqual(sorted(mig), sorted(ref))
        for name in ref:
            self.assertEqual(mig[name], ref[name], name)
        doc = json.loads((ds / "bricks" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(doc["index"]["columns"]["ll"]["sha256"], tree["index"]["columns"]["ll"]["sha256"])
        self.assertEqual(doc["bytes"], tree["bytes"])
        self.assertEqual(doc["histograms"], [{"counts": [1, 2, 3]}] * 2)
        # a damaged v5 tree is a problem, never a pending repair
        (ds / "bricks" / "index" / "b2.bin").write_bytes(b"LBIX")
        row = self.row("3d/SYN3")
        self.assertEqual(row["problem"], "bricks_v5_invalid")
        self.assertEqual(row["pending"], [])

    def test_live_chain(self):
        ds, truth = make_live(self.data_web, X=140, Y=300, Z=30, T=2)
        for mid in (M2, M3, M4):
            run_job(self, "live/LIVE3", mid)
        fin, _ = run_job(self, "live/LIVE3", M5)
        self.assertEqual(fin["formatVersion"], 5)
        self.assertIsNone(f5.bricks_problem(ds))
        doc = json.loads((ds / "bricks" / "manifest.json").read_text(encoding="utf-8"))
        self.assertIsNone(doc["index"])
        self.assertEqual([r["path"] for r in doc["timepoints"]], ["t000", "t001"])
        self.assertEqual(doc["timepoints"][1]["index"]["columns"]["q80"]["url"], "t001/index/q80.bin")
        for t in (0, 1):
            ref_dir = self.tmp / ("ref%d" % t)
            raw_dir = self.tmp / ("raw%d" % t)
            raw_dir.mkdir()
            paths = write_raw(raw_dir, truth[t])
            f5.write_tree(paths, tuple(reversed(truth[t][0].shape)), (1, 1, 1), ref_dir,
                          self.tmp / "work", lambda fn, ts: map(fn, ts))
            mig = tree_files(ds / "bricks" / ("t%03d" % t))
            ref = tree_files(ref_dir)
            self.assertEqual(sorted(mig), sorted(ref))
            self.assertTrue(all(mig[n] == ref[n] for n in ref))

    def test_cancel_and_source_change(self):
        ds, _truth = make_3d(self.data_web, Z=70)
        for mid in (M2, M3, M4):
            run_job(self, "3d/SYN3", mid)
        dm.plan_job("3d/SYN3", M5)
        dm.unit_run("3d/SYN3", M5, max_seconds=1, workers=2)
        self.assertTrue(dm.tile_store_dir("3d", "SYN3", M5).is_dir())
        self.assertEqual(dm.cancel("3d/SYN3", M5), {"ok": True})
        self.assertFalse(dm.tile_store_dir("3d", "SYN3", M5).exists())
        self.assertEqual(self.row("3d/SYN3")["pending"], [M5])
        dm.plan_job("3d/SYN3", M5)
        man = ds / "planes" / "manifest.json"
        man.write_bytes(man.read_bytes() + b" ")
        status, payload = dm.handle("unit_run", {}, {"dataset": "3d/SYN3", "migration": M5, "maxSeconds": 1})
        self.assertEqual((status, payload["error"]), (409, "source_changed"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
