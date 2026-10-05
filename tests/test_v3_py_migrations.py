"""Dataset formats 3 and 4 — Python engine (dataset_migrations.py), SPEC Part II.

Synthetic datasets built the way preprocess/3-chunk_packer.py does (v2 64³ bricks as
8×8 lossless-WebP mosaics in packs, ESS-dropped bricks, sizes that are multiples of
neither 512 nor 64, anisotropic voxels where Z must NOT halve at the first level and
must halve later, a two-frame timelapse) are taken through m002 → m003 → m004, and
every output is compared with an INDEPENDENT reference computed here: every v3 brick
of every level decodes to exactly the expected 66³ (interior = source/reduced voxels,
border = neighbours / clamp-to-edge / zeros of dropped v2 bricks), absent iff its
interior is zero; level dimensions and voxel sizes; index.bin; layer MIPs = max of the
planes; planes/mips manifests re-stamped; version 4; repair detection; resumability;
the browser executor's blobs and its level ordering. A real local dataset (read-only,
copied to a temp tree) gives timing figures when LUMEN_V3_REAL=1.

Run: py -3.12 tests/test_v3_py_migrations.py
"""
import hashlib
import io
import json
import os
import shutil
import struct
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
import dataset_migrations as dm  # noqa: E402

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from test_mig_py_server import _write_tree, _volume  # noqa: E402

M2, M3, M4 = "m002-planes", "m003-layer-mips", "m004-bricks-v3"
REAL_ROOT = Path(ROOT) / "DATA_WEB" / "3d"


# ── Independent references ─────────────────────────────────────────────────────

def ref_levels(dims, voxel):
    X, Y, Z = dims
    vx, vy, vz = voxel
    out = [((X, Y, Z), (vx, vy, vz), False)]
    while max(X, Y) > 128:
        hz = vz <= 1.5 * max(2 * vx, 2 * vy)
        X, Y = (X + 1) // 2, (Y + 1) // 2
        vx, vy = 2 * vx, 2 * vy
        if hz:
            Z, vz = (Z + 1) // 2, 2 * vz
        out.append(((X, Y, Z), (vx, vy, vz), hz))
    return out


def ref_reduce(vol, hz):
    """Mean of the existing voxels of each block, rounded half up, written with float
    division (exact for n ∈ {1,2,4,8}) and explicit block offsets — independent of
    dm.reduce_level's pairwise sums."""
    Z, Y, X = vol.shape
    oz, oy, ox = ((Z + 1) // 2 if hz else Z), (Y + 1) // 2, (X + 1) // 2
    s = np.zeros((oz, oy, ox), dtype=np.float64)
    n = np.zeros((oz, oy, ox), dtype=np.float64)
    dzs = (0, 1) if hz else (0,)
    for dz in dzs:
        for dy in (0, 1):
            for dx in (0, 1):
                sub = vol[dz::2 if hz else 1, dy::2, dx::2].astype(np.float64)
                s[:sub.shape[0], :sub.shape[1], :sub.shape[2]] += sub
                n[:sub.shape[0], :sub.shape[1], :sub.shape[2]] += 1
    return np.floor(s / n + 0.5).astype(np.uint8)


def ref_brick66(vol, b, dims):
    X, Y, Z = dims
    bz, by, bx = b
    iz = np.clip(np.arange(64 * bz - 1, 64 * bz + 65), 0, Z - 1)
    iy = np.clip(np.arange(64 * by - 1, 64 * by + 65), 0, Y - 1)
    ix = np.clip(np.arange(64 * bx - 1, 64 * bx + 65), 0, X - 1)
    return vol[iz][:, iy][:, :, ix]


def decode_v3(data):
    assert data[:4] == b"RIFF" and data[12:16] == b"VP8L", "not a simple lossless WebP"
    im = Image.open(io.BytesIO(data))
    im.load()
    assert im.size == (594, 528)
    m = np.asarray(im.convert("RGB"))[:, :, 0]
    slots = m.reshape(8, 66, 9, 66).transpose(0, 2, 1, 3).reshape(72, 66, 66)
    assert not slots[66:].any(), "unused slots not zero"
    return slots[:66]


def read_index(data):
    """Independent struct parse of index.bin."""
    magic, ver, nlev, chans, res = struct.unpack_from("<4sHHHH", data, 0)
    assert (magic, ver, res) == (b"LBIX", 1, 0)
    pos, levels = 12, []
    for _ in range(nlev):
        levels.append(struct.unpack_from("<IIII", data, pos))
        pos += 16
    entries = []
    for gx, gy, gz, _pc in levels:
        per_c = []
        for _c in range(chans):
            rows = [struct.unpack_from("<HII", data, pos + 10 * i) for i in range(gx * gy * gz)]
            pos += 10 * gx * gy * gz
            per_c.append(rows)
        entries.append(per_c)
    assert pos == len(data)
    return levels, chans, entries


# ── Synthetic datasets ─────────────────────────────────────────────────────────

def make_3d(data_web, name="SYN3", X=300, Y=270, Z=260, C=2, voxel=(0.5, 0.5, 1.6), seed=7):
    rng = np.random.default_rng(seed)
    ds = data_web / "3d" / name
    vols = [_volume(rng, X, Y, Z) for _ in range(C)]
    for v in vols:
        v[:, :, 200:] //= 50          # faint region: v3's exact ESS must keep it
    drop = lambda c, bx, by, bz: (bx + 2 * by + bz + c) % 4 == 0
    levels, transport, truth = _write_tree(ds / "bricks", vols, drop)
    manifest = {"version": 2, "schema": "iribhm-bricks-v2", "dataset": name, "channels": C, "brickSize": 64,
                "brickPacking": {"mode": "grid", "cols": 8, "rows": 8},
                "voxelSize": {"x": voxel[0], "y": voxel[1], "z": voxel[2]},
                "levels": levels, "brickTransport": transport, "timepoints": None,
                "histograms": [{"counts": [1, 2, 3]}] * C}
    (ds / "bricks" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (ds / "metadata.json").write_text(json.dumps({"id": f"3d/{name}", "name": name, "type": "3d",
                                                  "curated": "keep"}, indent=2), encoding="utf-8")
    return ds, {0: truth}


def make_live(data_web, name="LIVE3", X=150, Y=140, Z=40, T=2, seed=3):
    rng = np.random.default_rng(seed)
    ds = data_web / "live" / name
    tps, truth = {}, {}
    for t in range(T):
        key = f"t{t:03d}"
        vol = _volume(rng, X, Y, Z)
        levels, transport, tr = _write_tree(ds / "bricks" / key, [vol], lambda *a: False)
        tps[key] = {"path": key, "channels": 1, "levels": levels, "brickTransport": transport,
                    "histograms": [{"counts": [t]}]}
        truth[t] = tr
    manifest = {"version": 2, "channels": 1, "brickSize": 64,
                "brickPacking": {"mode": "grid", "cols": 8, "rows": 8},
                "voxelSize": {"x": 1.0, "y": 1.0, "z": 1.0},
                "levels": tps["t000"]["levels"], "brickTransport": tps["t000"]["brickTransport"],
                "timepoints": tps}
    (ds / "bricks" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (ds / "metadata.json").write_text(json.dumps({"name": name, "type": "live"}), encoding="utf-8")
    return ds, truth


def run_job(test, dataset, mid, max_seconds=None):
    dm.plan_job(dataset, mid)
    for _ in range(10000):
        out = dm.unit_run(dataset, mid, max_seconds=20)
        if out["done"] >= out["total"]:
            break
    calls = 0
    while True:
        calls += 1
        fin = dm.finalize(dataset, mid, max_seconds)
        if fin.get("complete"):
            return fin, calls
        test.assertLess(calls, 10000)


def verify_v3(test, ds, truth, voxel, type_dir="3d"):
    """Every brick of every level of every tree against the independent reference."""
    man_bytes = (ds / "bricks" / "manifest.json").read_bytes()
    man = json.loads(man_bytes)
    test.assertEqual((man["schema"], man["version"], man["formatVersion"], man["apron"]),
                     ("iribhm-bricks-v3", 3, 4, 1))
    test.assertEqual(man["brickPacking"], {"mode": "grid", "cols": 9, "rows": 8, "slice": 66})
    any_tree = next(iter(truth.values()))
    C = len(any_tree)
    Z0, Y0, X0 = any_tree[0].shape
    geo = ref_levels((X0, Y0, Z0), voxel)
    test.assertEqual(len(man["levels"]), len(geo))
    for L, ((X, Y, Z), (vx, vy, vz), _hz) in zip(man["levels"], geo):
        test.assertEqual(L["dimensions"], {"x": X, "y": Y, "z": Z})
        test.assertEqual(L["voxelSize"], {"x": vx, "y": vy, "z": vz})
        test.assertEqual(L["gridSize"], {"x": -(-X // 64), "y": -(-Y // 64), "z": -(-Z // 64)})
    if type_dir == "live":
        test.assertNotIn("index", man)
        trees = [(row["path"], row["index"]) for row in man["timepoints"]]
    else:
        test.assertIsNone(man["timepoints"])
        trees = [("", man["index"])]
    present_total = [0] * len(geo)
    for t, (rel, ref) in enumerate(trees):
        tdir = ds / "bricks" / rel if rel else ds / "bricks"
        idx = (ds / "bricks" / ref["url"]).read_bytes()
        test.assertEqual((len(idx), hashlib.sha256(idx).hexdigest()), (ref["bytes"], ref["sha256"]))
        lv, chans, entries = read_index(idx)
        test.assertEqual(chans, C)
        for k, ((dims, _v, _h), (gx, gy, gz, pc)) in enumerate(zip(geo, lv)):
            test.assertEqual((gx, gy, gz), tuple(-(-n // 64) for n in dims))
            packs_seen = 0
            for c in range(C):
                vol = truth[t][c] if k == 0 else None
                if k:
                    vol = truth[t][c]
                    for kk in range(1, k + 1):
                        vol = ref_reduce(vol, geo[kk][2])
                rows = entries[k][c]
                used = set()
                for i, (pk, off, ln) in enumerate(rows):
                    bx, rest = i % gx, i // gx
                    by, bz = rest % gy, rest // gy
                    exp = ref_brick66(vol, (bz, by, bx), dims)
                    interior = exp[1:-1, 1:-1, 1:-1].any()
                    if not ln:
                        test.assertEqual((pk, off), (0, 0))
                        test.assertFalse(interior, f"t{t} k{k} c{c} brick {bz},{by},{bx} dropped")
                        continue
                    present_total[k] += 1
                    used.add(pk)
                    with open(tdir / f"l{k}/c{c}/p{pk:05d}.bin", "rb") as fh:
                        fh.seek(off)
                        got = decode_v3(fh.read(ln))
                    test.assertTrue(interior, f"t{t} k{k} c{c} brick {bz},{by},{bx} stored with zero interior")
                    np.testing.assert_array_equal(got, exp, err_msg=f"t{t} k{k} c{c} brick {bz},{by},{bx}")
                test.assertEqual(used, set(range(len(used))))
                packs_seen += len(used)
            test.assertEqual(pc, packs_seen)
    for k, L in enumerate(man["levels"]):
        test.assertEqual(L["brickCount"], present_total[k])
    return man_bytes


def assert_mips(test, ds, truth, rel_for_t):
    for t, chans in truth.items():
        d = ds / "mips" / rel_for_t(t) if rel_for_t(t) else ds / "mips"
        man = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
        Z, Y, X = chans[0].shape
        test.assertEqual((man["schema"], man["formatVersion"], man["layers"], man["layerDepth"], man["packPattern"]),
                         ("lumen-mips-v1", 3, -(-Z // 64), 64, "l{l}.bin"))
        for layer in range(man["layers"]):
            data = (d / f"l{layer:05d}.bin").read_bytes()
            z, C, TX, TY, entries = dm.parse_plane_pack(data, magic=b"LMIP")
            test.assertEqual((z, C), (layer, len(chans)))
            for c in range(C):
                exp = chans[c][64 * layer:64 * layer + 64].max(axis=0)
                for ty in range(TY):
                    for tx in range(TX):
                        off, ln = entries[(c * TY + ty) * TX + tx]
                        e = exp[ty * 512:ty * 512 + 512, tx * 512:tx * 512 + 512]
                        if not ln:
                            test.assertFalse(e.any())
                            continue
                        w, h, px = dm.decode_png_gray8(data[off:off + ln])
                        np.testing.assert_array_equal(np.frombuffer(px, np.uint8).reshape(h, w), e)


# ── Pure functions ─────────────────────────────────────────────────────────────

class Pure(unittest.TestCase):
    def test_level_geometry_anisotropic(self):
        g = dm.level_geometry((3789, 3789, 257), (0.430366, 0.430366, 2.057107))
        self.assertEqual([L["halveZ"] for L in g], [False, False, True, True, True, True])
        self.assertEqual([L["dimensions"] for L in g],
                         [(3789, 3789, 257), (1895, 1895, 257), (948, 948, 129), (474, 474, 65),
                          (237, 237, 33), (119, 119, 17)])
        for L, (dims, vox, hz) in zip(g, ref_levels((3789, 3789, 257), (0.430366, 0.430366, 2.057107))):
            self.assertEqual((L["dimensions"], L["voxelSize"], L["halveZ"]), (dims, vox, hz))
        self.assertEqual(max(g[-1]["dimensions"][:2]), 119)
        self.assertEqual(len(dm.level_geometry((128, 100, 9), (1, 1, 1))), 1)
        self.assertEqual(len(dm.level_geometry((129, 1, 1), (1, 1, 1))), 2)
        iso = dm.level_geometry((1000, 1000, 1000), (1, 1, 1))
        self.assertTrue(all(L["halveZ"] for L in iso[1:]))

    def test_reduce_level_exact(self):
        rng = np.random.default_rng(1)
        for shape in [(1, 1, 1), (3, 5, 7), (8, 6, 4), (33, 17, 9), (65, 70, 3)]:
            vol = rng.integers(0, 256, size=shape, dtype=np.uint8)
            vol[0, 0, 0] = 255
            for hz in (False, True):
                for chunk in (1, 2, 32):
                    np.testing.assert_array_equal(dm.reduce_level(vol, hz, chunk=chunk), ref_reduce(vol, hz))
        # rounding half up: (1+0)/2 = 0.5 -> 1 ; one 1 among 8 -> 0.125 -> 0 ; 4 of 8 -> 1
        v = np.zeros((2, 2, 2), np.uint8)
        v[0, 0, 0] = 1
        self.assertEqual(int(dm.reduce_level(v, True)[0, 0, 0]), 0)
        v[0, 0, 1] = v[0, 1, 0] = v[0, 1, 1] = 1
        self.assertEqual(int(dm.reduce_level(v, True)[0, 0, 0]), 1)
        self.assertEqual(int(dm.reduce_level(np.array([[[1, 0]]], np.uint8), False)[0, 0, 0]), 1)

    def test_brick_apron_and_mosaic(self):
        rng = np.random.default_rng(2)
        X, Y, Z = 130, 70, 66
        vol = rng.integers(0, 256, size=(Z, Y, X), dtype=np.uint8)
        for b in [(0, 0, 0), (1, 1, 2), (0, 1, 1)]:
            got = dm.brick_with_apron(vol, *b, (X, Y, Z))
            np.testing.assert_array_equal(got, ref_brick66(vol, b, (X, Y, Z)))
            # from a sub-region holding exactly the clamped range
            bz, by, bx = b
            lo = [max(0, 64 * v - 1) for v in (bx, by, bz)]
            hi = [min(n, 64 * v + 65) for v, n in zip((bx, by, bz), (X, Y, Z))]
            sub = vol[lo[2]:hi[2], lo[1]:hi[1], lo[0]:hi[0]]
            np.testing.assert_array_equal(dm.brick_with_apron(sub, *b, (X, Y, Z), tuple(lo)), got)
            m = dm.mosaic_9x8(got)
            self.assertEqual(len(m), 594 * 528)
            img = np.frombuffer(m, np.uint8).reshape(528, 594)
            np.testing.assert_array_equal(img[66 * 7:66 * 8, 66 * 2:66 * 3], got[65])   # slice 65: row 7, col 2
            self.assertFalse(img[66 * 7:, 66 * 3:].any())
            np.testing.assert_array_equal(dm.unmosaic_9x8(m, strict=True), got)
            webp = dm.encode_brick_v3(got)
            self.assertEqual(dm.webp_lossless_size(webp), (594, 528))
            np.testing.assert_array_equal(decode_v3(webp), got)
            np.testing.assert_array_equal(dm.decode_brick_v3(webp, strict=True), got)

    def test_webp_header_checks(self):
        buf = io.BytesIO()
        Image.new("L", (594, 528), 9).save(buf, "WEBP", quality=80)    # lossy
        with self.assertRaises(ValueError):
            dm.webp_lossless_size(buf.getvalue())
        buf = io.BytesIO()
        Image.new("L", (10, 20), 9).save(buf, "WEBP", lossless=True)
        self.assertEqual(dm.webp_lossless_size(buf.getvalue()), (10, 20))
        with self.assertRaises(ValueError):
            dm.webp_lossless_size(buf.getvalue()[:-2])
        with self.assertRaises(ValueError):
            dm.validate_v3_brick(buf.getvalue())

    def test_pack_layout_and_index(self):
        layout, n, order = dm.pack_layout([5] * 130)
        self.assertEqual(n, 3)
        self.assertEqual([layout[i][0] for i in (0, 63, 64, 127, 128)], [0, 0, 1, 1, 2])
        self.assertEqual(layout[65], (1, 5, 5))
        self.assertEqual(order, list(range(130)))
        big = 6 * 1024 * 1024
        # one super-block of 18 MiB: split in brick order
        layout, n, _o = dm.pack_layout([big, 0, big, big, 1], (5, 1, 1))
        self.assertEqual(layout, [(0, 0, big), (0, 0, 0), (0, big, big), (1, 0, big), (1, big, 1)])
        self.assertEqual(n, 2)   # the next super-block joins the split one's last pack
        # super-blocks in (SBZ, SBY, SBX) order, bricks inside in (bz, by, bx) order
        layout, n, order = dm.pack_layout([1] * 10, (5, 2, 1))
        self.assertEqual(order, [0, 1, 2, 3, 5, 6, 7, 8, 4, 9])
        self.assertEqual([layout[i][1] for i in order], list(range(10)))
        with self.assertRaises(ValueError):
            dm.pack_layout([1] * 9, (5, 2, 1))
        grids = [(2, 1, 1), (1, 1, 1)]
        entries = [[[(0, 0, 7), (0, 0, 0)], [(0, 0, 0), (1, 3, 4)]], [[(0, 0, 0)], [(0, 0, 2)]]]
        data = dm.index_bin_bytes(grids, 2, entries)
        self.assertEqual(len(data), 12 + 16 * 2 + 10 * 2 * 3)
        lv, ch, ent = read_index(data)
        self.assertEqual([x[3] for x in lv], [1 + 2, 0 + 1])   # packCount summed over channels
        self.assertEqual(ent, entries)
        parsed = dm.parse_index_bin(data)
        self.assertEqual([tuple(map(int, r)) for r in parsed["levels"][0]["entries"][1]], [(0, 0, 0), (1, 3, 4)])
        with self.assertRaises(ValueError):
            dm.parse_index_bin(data + b"\0")

    def test_mip_tile(self):
        a, b = bytes([1, 9, 3]), bytes([4, 2, 3])
        self.assertEqual(dm.mip_tile([a, None, b]), bytes([4, 9, 3]))
        self.assertIsNone(dm.mip_tile([None, None]))

    def test_cuts_touch_one_pack_per_superblock(self):
        """SPEC §13.4: an XZ or a YZ brick cut of a 6×6×3-super-block volume touches at
        most as many packs per channel as it crosses super-blocks (no super-block over
        16 MiB), and the pipeline writer lays the packs out identically."""
        sys.path.insert(0, os.path.join(ROOT, "preprocess"))
        import bricks_v3_writer as v3
        gx, gy, gz = 24, 24, 12
        grid = (gx, gy, gz)
        rng = np.random.default_rng(7)
        for density, hi in ((1.0, 4096), (0.6, 120000), (0.15, 262144), (1.0, 262144)):
            lens = [int(rng.integers(64, hi + 1)) if rng.random() < density else 0
                    for _ in range(gx * gy * gz)]
            layout, n, order = dm.pack_layout(lens, grid)
            self.assertEqual((layout, n), v3.pack_layout(lens, grid))
            self.assertEqual(sorted(order), [i for i, ln in enumerate(lens) if ln])
            # packs concatenate their bricks without gaps, in write order
            ends = {}
            for i in order:
                pk, off, ln = layout[i]
                self.assertEqual(off, ends.get(pk, 0))
                ends[pk] = off + ln
            self.assertTrue(all(sum(1 for i in order if layout[i][0] == p) <= 64 for p in ends))
            self.assertTrue(all(v <= dm.V3_PACK_MAX_BYTES for v in ends.values()))
            for b in range(gy):          # XZ cut: one brick row (fixed by), every bx and bz
                cut = [(bz * gy + b) * gx + bx for bz in range(gz) for bx in range(gx)]
                packs = {layout[i][0] for i in cut if lens[i]}
                self.assertLessEqual(len(packs), 6 * 3, (density, "xz", b))
            for b in range(gx):          # YZ cut: fixed bx
                cut = [(bz * gy + by) * gx + b for bz in range(gz) for by in range(gy)]
                packs = {layout[i][0] for i in cut if lens[i]}
                self.assertLessEqual(len(packs), 6 * 3, (density, "yz", b))


# ── Engine ─────────────────────────────────────────────────────────────────────

class Engine(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-v3-"))
        self.data_web = self.tmp / "DATA_WEB"
        for t in ("3d", "2d", "live"):
            (self.data_web / t).mkdir(parents=True)
        dm.configure(self.tmp)
        dm.server_capabilities(force=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def row(self, ds_id):
        return next(r for r in dm.status()["datasets"] if r["id"] == ds_id)

    def meta(self, ds):
        return json.loads((ds / "metadata.json").read_text(encoding="utf-8"))

    def test_capabilities(self):
        caps = dm.server_capabilities()
        for mid in (M2, M3, M4):
            self.assertEqual(caps["migrations"][mid], {"available": True, "reasons": []})
        self.assertTrue(caps["webpLosslessEncode"])

    def test_chain_3d(self):
        voxel = (0.5, 0.5, 1.6)
        ds, truth = make_3d(self.data_web, voxel=voxel)
        row = self.row("3d/SYN3")
        self.assertEqual(row["pending"], [M2, M3, M4])
        self.assertFalse(row["estimate"]["migrations"][M3]["exact"])
        self.assertTrue(row["estimate"]["migrations"][M4]["exact"])
        # m004 needs format 3 first
        self.assertEqual(dm.handle("plan", {}, {"dataset": "3d/SYN3", "migration": M4})[0], 409)
        self.assertEqual(dm.handle("plan", {}, {"dataset": "3d/SYN3", "migration": M3})[0], 409)
        run_job(self, "3d/SYN3", M2)
        self.assertEqual(self.row("3d/SYN3")["pending"], [M3, M4])
        fin, _ = run_job(self, "3d/SYN3", M3)
        self.assertEqual(fin["formatVersion"], 3)
        assert_mips(self, ds, truth, lambda t: "")
        self.assertEqual(self.row("3d/SYN3")["pending"], [M4])
        # geometry: Z kept at level 1 (1.6 > 1.5 x 1.0), halved at level 2 (1.6 <= 3.0)
        plan = dm.plan_job("3d/SYN3", M4)
        self.assertEqual([L["halveZ"] for L in plan["levels"]], [False, False, True])
        self.assertEqual([L["dimensions"]["z"] for L in plan["levels"]], [260, 260, 130])
        self.assertTrue(all(k.startswith("t0.k0.") for k in plan["units"]))
        self.assertLess(plan["runnable"], plan["pending"])
        v2_bytes = sum(p.stat().st_size for p in (ds / "bricks").rglob("*.bin"))
        fin, calls = run_job(self, "3d/SYN3", M4)
        self.assertEqual(fin["formatVersion"], 4)
        man_bytes = verify_v3(self, ds, truth, voxel)
        sha = hashlib.sha256(man_bytes).hexdigest()
        for root in ("planes", "mips"):
            m = json.loads((ds / root / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(m["source"]["manifestSha256"], sha)
        self.assertEqual(self.meta(ds)["curated"], "keep")
        self.assertEqual(self.meta(ds)["formatVersion"], 4)
        for gone in ("bricks.v2-old", ".bricks-incoming"):
            self.assertFalse((ds / gone).exists())
        self.assertFalse(dm.tile_store_dir("3d", "SYN3", M4).exists())
        row = self.row("3d/SYN3")
        self.assertEqual((row["pending"], row["repair"], row.get("problem")), ([], False, None))
        v3_bytes = sum(p.stat().st_size for p in (ds / "bricks").rglob("*.bin"))
        self.assertGreater(v3_bytes, 0)
        self.assertGreater(v2_bytes, 0)

        # Repair on a v4 dataset: mips (from planes), then planes (read from the v3 bricks).
        (ds / "mips" / "l00001.bin").unlink()
        row = self.row("3d/SYN3")
        self.assertEqual((row["formatVersion"], row["pending"], row["repair"]), (4, [M3], True))
        self.assertEqual(run_job(self, "3d/SYN3", M3)[0]["formatVersion"], 4)
        assert_mips(self, ds, truth, lambda t: "")
        (ds / "planes" / dm.pack_name(100)).unlink()
        # mips/ is stamped with the bricks manifest, not the planes: it stays valid
        self.assertEqual(self.row("3d/SYN3")["pending"], [M2])
        run_job(self, "3d/SYN3", M2)
        from test_mig_py_server import assert_planes_equal
        assert_planes_equal(self, ds, truth)
        self.assertEqual(self.row("3d/SYN3")["pending"], [])        # mips manifest still stamped right

        # Damaged v3 bricks: a problem, never a pending m004 (its source is gone).
        idx = ds / "bricks" / "index.bin"
        idx.write_bytes(idx.read_bytes()[:-10] + b"\1" * 10)
        row = self.row("3d/SYN3")
        self.assertEqual(row["problem"], "bricks_v3_invalid")
        self.assertNotIn(M4, row["pending"])

    def test_chain_live_two_trees(self):
        ds, truth = make_live(self.data_web)
        for mid in (M2, M3):
            run_job(self, "live/LIVE3", mid)
        assert_mips(self, ds, truth, lambda t: f"t{t:03d}")
        plan = dm.plan_job("live/LIVE3", M4)
        self.assertEqual([L["halveZ"] for L in plan["levels"]], [False, True])   # isotropic: Z halves at once
        fin, _ = run_job(self, "live/LIVE3", M4)
        self.assertEqual(fin["formatVersion"], 4)
        verify_v3(self, ds, truth, (1.0, 1.0, 1.0), "live")
        man = json.loads((ds / "bricks" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual([r["path"] for r in man["timepoints"]], ["t000", "t001"])
        self.assertEqual(man["timepointHistograms"]["t001"], [{"counts": [1]}])
        sha = hashlib.sha256((ds / "bricks" / "manifest.json").read_bytes()).hexdigest()
        for t in ("t000", "t001"):
            for root in ("planes", "mips"):
                m = json.loads((ds / root / t / "manifest.json").read_text(encoding="utf-8"))
                self.assertEqual(m["source"]["manifestSha256"], sha)
        self.assertEqual(self.row("live/LIVE3")["pending"], [])

    def test_browser_executor_ordering_and_blobs(self):
        voxel = (1.0, 1.0, 1.0)
        ds, truth = make_3d(self.data_web, name="BR", X=200, Y=150, Z=70, C=1, voxel=voxel)
        run_job(self, "3d/BR", M2)
        run_job(self, "3d/BR", M3)
        plan = dm.plan_job("3d/BR", M4)
        us = dm._unitset(dm._plan_for("3d/BR"), M4)
        store = dm.tile_store_dir("3d", "BR", M4)
        lvl1 = next(u for u in us.units if u[1] == 1)
        st, out = dm.handle("unit_put", {"dataset": "3d/BR", "migration": M4,
                                         "unit": dm.unit_key_for(M4, lvl1)}, {}, struct.pack("<I", 0))
        self.assertEqual((st, out["error"]), (409, "unit_blocked"))
        # Browser does level-0 units: the server computes their bricks, we upload them.
        first = dm.parse_unit_key_for(M4, plan["units"][0])
        bricks, _ = dm.process_unit_m004(dm._plan_for("3d/BR"), us, first, store)
        self.assertTrue(bricks)
        key = dm.unit_key_for(M4, first)
        # malformed blobs
        some = next(iter(bricks))
        outside = (some[0] + 9, some[1], some[2])
        for bad, code in [(dm.build_v3_unit_blob({outside: bricks[some]}), "bad_blob"),
                          (dm.build_v3_unit_blob({some: bricks[some][:-4]}), "bad_webp"),
                          (dm.build_v3_unit_blob(bricks) + b"x", "bad_blob")]:
            st, out = dm.handle("unit_put", {"dataset": "3d/BR", "migration": M4, "unit": key}, {}, bad)
            self.assertEqual((st, out["error"]), (400, code))
        lossy = io.BytesIO()
        Image.new("RGB", (594, 528)).save(lossy, "WEBP", quality=90)
        st, out = dm.handle("unit_put", {"dataset": "3d/BR", "migration": M4, "unit": key}, {},
                            dm.build_v3_unit_blob({some: lossy.getvalue()}))
        self.assertEqual((st, out["error"]), (400, "bad_webp"))
        # a zero-interior brick is accepted and dropped
        zero = dm.encode_brick_v3(np.zeros((66, 66, 66), np.uint8))
        blob = dict(bricks)
        extra = next(b for b in dm._m004_unit_bricks(us, first) if b not in bricks) if len(bricks) < len(
            dm._m004_unit_bricks(us, first)) else None
        if extra:
            blob[extra] = zero
        st, out = dm.handle("unit_put", {"dataset": "3d/BR", "migration": M4, "unit": key}, {},
                            dm.build_v3_unit_blob(blob))
        self.assertEqual(st, 200, out)
        if extra:
            self.assertFalse(dm._v3_store_brick(store, 0, 0, 0, *extra).exists())
        # idempotent re-put
        self.assertEqual(dm.handle("unit_put", {"dataset": "3d/BR", "migration": M4, "unit": key}, {},
                                   dm.build_v3_unit_blob(bricks))[0], 200)
        # unit_inputs / store_get
        st, inp = dm.handle("unit_inputs", {}, {"dataset": "3d/BR", "migration": M4, "unit": key})
        self.assertEqual((st, inp["source"], inp["level"]), (200, "v2", 0))
        self.assertTrue(all("url" in r for r in inp["bricks"]))
        b = next(iter(bricks))
        st, ctype, data = dm.handle_binary("store_get", {"dataset": "3d/BR", "migration": M4,
                                                         "brick": dm.unit_key_for(M4, (0, 0, 0) + b)})
        self.assertEqual((st, ctype, data), (200, "application/octet-stream", bricks[b]))
        self.assertEqual(dm.handle_binary("store_get", {"dataset": "3d/BR", "migration": M4,
                                                        "brick": "t0.k0.c0.z9.y9.x9"})[0], 404)
        # the server takes over (executor switch), level by level
        run_job(self, "3d/BR", M4)
        verify_v3(self, ds, truth, voxel)

    def test_resumable_finalize_and_crashes(self):
        voxel = (1.0, 1.0, 2.0)
        ds, truth = make_3d(self.data_web, name="RS", X=260, Y=140, Z=70, C=2, voxel=voxel)
        run_job(self, "3d/RS", M2)
        run_job(self, "3d/RS", M3)
        dm.plan_job("3d/RS", M4)
        while dm.unit_run("3d/RS", M4)["processed"]:
            pass
        old = dm.V3_PACK_MAX_BRICKS
        dm.V3_PACK_MAX_BRICKS = 2
        try:
            calls, out = 0, None
            while True:
                calls += 1
                out = dm.finalize("3d/RS", M4, max_seconds=1e-9)
                if out.get("complete") or out.get("formatVersion"):
                    break
                self.assertEqual(out["complete"], False)
                self.assertIn("packs", out["assembly"])
                if calls == 3:
                    # a crash between the two renames of the swap
                    real = dm._replace_retry

                    def crash(src, dst, *a, **k):
                        if Path(src).name == ".bricks-incoming":
                            raise OSError("crash")
                        return real(src, dst, *a, **k)
                    dm._replace_retry = crash
                    try:
                        while True:
                            try:
                                r = dm.finalize("3d/RS", M4)
                            except OSError:
                                break
                            self.assertFalse(r.get("complete"))
                    finally:
                        dm._replace_retry = real
                    self.assertFalse((ds / "bricks").exists())
                    st = dm.plan_job("3d/RS", M4)          # transient state answered from the journal
                    self.assertEqual(st["state"], "assembling")
                    self.assertEqual(dm.handle("cancel", {}, {"dataset": "3d/RS", "migration": M4})[0], 409)
                    # crash between swap and bump
                    real_bump = dm._bump_metadata

                    def boom(*a, **k):
                        raise RuntimeError("crash")
                    dm._bump_metadata = boom
                    try:
                        with self.assertRaises(RuntimeError):
                            dm.finalize("3d/RS", M4)
                    finally:
                        dm._bump_metadata = real_bump
                    self.assertEqual(self.meta(ds)["formatVersion"], 3)
                    self.assertEqual(self.row("3d/RS")["pending"], [M4])
            self.assertGreaterEqual(calls, 3)
        finally:
            dm.V3_PACK_MAX_BRICKS = old
        self.assertEqual(dm.finalize("3d/RS", M4)["formatVersion"], 4)
        verify_v3(self, ds, truth, voxel)
        self.assertEqual(self.row("3d/RS")["pending"], [])
        # journal lost after a swap: version 3 + v3 bricks → plan creates a finalize-only job
        meta = self.meta(ds)
        meta["formatVersion"] = 3
        (ds / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
        self.assertEqual(self.row("3d/RS")["pending"], [M4])
        self.assertEqual(dm.plan_job("3d/RS", M4)["state"], "swapped")
        self.assertEqual(dm.finalize("3d/RS", M4)["formatVersion"], 4)

    def test_source_change_and_unit_run_resume(self):
        ds, truth = make_3d(self.data_web, name="SC", X=140, Y=140, Z=64, C=1, voxel=(1, 1, 1))
        run_job(self, "3d/SC", M2)
        run_job(self, "3d/SC", M3)
        dm.plan_job("3d/SC", M4)
        out = dm.unit_run("3d/SC", M4, max_seconds=1)
        self.assertGreaterEqual(len(out["processed"]), 1)
        mp = ds / "bricks" / "manifest.json"
        mp.write_bytes(mp.read_bytes() + b" ")
        st, err = dm.handle("unit_run", {}, {"dataset": "3d/SC", "migration": M4})
        self.assertEqual((st, err["error"]), (409, "source_changed"))
        # replanning discards the stale job; the chain then completes on the new manifest
        dm.plan_job("3d/SC", M2)
        self.assertEqual(self.row("3d/SC")["pending"][0], M2)


class RealDataset(unittest.TestCase):
    """Timing on a real local dataset, copied to a temp tree (the original is read only).
    Opt-in: LUMEN_V3_REAL=1 (LUMEN_V3_REAL_DS=<folder> picks one; default the smallest)."""

    def test_real_m004_timing(self):
        if not (os.environ.get("LUMEN_V3_REAL") == "1" and REAL_ROOT.is_dir()):
            # Not a skip: an opt-in measurement (CI runs with --strict-skips and holds no dataset).
            print("  (real-dataset m004 timing not run: set LUMEN_V3_REAL=1 with datasets under DATA_WEB/3d)")
            return
        name = os.environ.get("LUMEN_V3_REAL_DS")
        if not name:
            cands = [d for d in REAL_ROOT.iterdir() if (d / "bricks" / "manifest.json").is_file()]
            name = min(cands, key=lambda d: sum(p.stat().st_size for p in (d / "bricks").rglob("*.bin"))).name
        src = REAL_ROOT / name
        tmp = Path(tempfile.mkdtemp(prefix="lumen-v3-real-"))
        try:
            dst = tmp / "DATA_WEB" / "3d" / name
            dst.mkdir(parents=True)
            shutil.copy2(src / "metadata.json", dst / "metadata.json")
            shutil.copytree(src / "bricks", dst / "bricks")
            meta = json.loads((dst / "metadata.json").read_text(encoding="utf-8"))
            meta["formatVersion"] = 3          # m004 reads only the v2 bricks
            (dst / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
            dm.configure(tmp)
            ds_id = "3d/" + name
            v2 = json.loads((dst / "bricks" / "manifest.json").read_text(encoding="utf-8"))
            plan = dm.plan_job(ds_id, M4)
            t0 = time.monotonic()
            per_level = {}
            nread = nwritten = 0
            while True:
                out = dm.unit_run(ds_id, M4, max_seconds=20)
                nread += out["bytesRead"]
                nwritten += out["bytesWritten"]
                for k in out["processed"]:
                    lvl = int(k.split(".")[1][1:])
                    per_level[lvl] = per_level.get(lvl, 0) + 1
                if not out["processed"]:
                    break
            units_s = time.monotonic() - t0
            t1 = time.monotonic()
            while not dm.finalize(ds_id, M4, 20).get("complete"):
                pass
            fin_s = time.monotonic() - t1
            v3 = json.loads((dst / "bricks" / "manifest.json").read_text(encoding="utf-8"))
            print(f"\n[real m004] {name}: {sum(per_level.values())} units in {units_s:.1f}s "
                  f"({sum(per_level.values()) / units_s:.2f} units/s), read {nread / 1e6:.0f} MB, "
                  f"wrote {nwritten / 1e6:.0f} MB, finalize {fin_s:.1f}s; units per level {per_level}")
            for L in v3["levels"]:
                k = L["level"]
                size3 = sum(p.stat().st_size for p in (dst / "bricks" / f"l{k}").rglob("*.bin"))
                old = dst / "bricks" / f"lod{k}"   # v2 is deleted after the bump: measure from the source
                size2 = sum(p.stat().st_size for p in (src / "bricks" / f"lod{k}").rglob("*.bin")) \
                    if (src / "bricks" / f"lod{k}").is_dir() else 0
                v2dims = next((x["dimensions"] for x in v2["levels"] if x["level"] == k), None)
                print(f"  level {k}: v3 {L['dimensions']} vox {L['voxelSize']} {L['brickCount']} bricks "
                      f"{size3 / 1e6:.1f} MB | v2 {v2dims} {size2 / 1e6:.1f} MB")
                self.assertFalse(old.exists())
            # level 0 interiors equal the v2 bricks (sample)
            index = dm.parse_index_bin((dst / "bricks" / "index.bin").read_bytes())
            gx, gy, _gz = index["levels"][0]["grid"]
            b2p = v2["brickTransport"]["brickToPack"]
            checked = 0
            lod0 = [(k, e) for k, e in b2p.items() if dm._BRICK_KEY_RE.match(k)]
            for key, ent in lod0[:: max(1, len(lod0) // 40)]:
                c, bx, by, bz = (int(v) for v in dm._BRICK_KEY_RE.match(key).groups())
                with open(src / "bricks" / ent["url"], "rb") as fh:
                    fh.seek(ent["offset"])
                    v2vox = np.frombuffer(dm.decode_brick(fh.read(ent["length"]), "webp-lossless",
                                                          v2["brickPacking"]), np.uint8).reshape(64, 64, 64)
                pk, off, ln = (int(x) for x in index["levels"][0]["entries"][c][(bz * gy + by) * gx + bx])
                X, Y, Z = (v3["levels"][0]["dimensions"][a] for a in "xyz")
                cz, cy, cx = min(64, Z - 64 * bz), min(64, Y - 64 * by), min(64, X - 64 * bx)
                if not ln:
                    self.assertFalse(v2vox[:cz, :cy, :cx].any())
                    continue
                with open(dst / "bricks" / f"l0/c{c}/p{pk:05d}.bin", "rb") as fh:
                    fh.seek(off)
                    got = decode_v3(fh.read(ln))
                np.testing.assert_array_equal(got[1:1 + cz, 1:1 + cy, 1:1 + cx], v2vox[:cz, :cy, :cx])
                checked += 1
            self.assertGreater(checked, 0)
            self.assertEqual(plan["state"], "running")
        finally:
            dm.configure(ROOT)
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=1)
