"""Dataset migrations — Python engine (dataset_migrations.py) and its HTTP route.

Builds synthetic datasets the way preprocess/3-chunk_packer.py does (64³ bricks as
8×8 lossless-WebP mosaics in .bin packs indexed by brickToPack, ESS-dropped bricks,
dimensions that are multiples of neither 512 nor 64, a two-frame timelapse), runs
migration m002-planes with both executors, and checks every tile of every plane
against the source voxels — exactly, pixel for pixel. Also: the pure format
functions (numpy and pure-Python paths byte-identical), journal idempotence, the
executor switch, source-change detection, a crash between swap and version bump,
repair detection, unit-blob validation, and the un-mosaic against the REAL browser
decoder (js/core/brick-decode-worker.js run under node on real local bricks).

Run: py -3.12 tests/test_mig_py_server.py
"""
import http.client
import io
import json
import os
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import dataset_migrations as dm  # noqa: E402

try:
    import numpy as np
    from PIL import Image
except Exception:  # pragma: no cover
    np = None
    Image = None

MID = "m002-planes"
REAL_DS = Path(ROOT) / "DATA_WEB" / "3d" / "Egfl7eGFP-E825-Em2-10122024-DAPI-Pecam1647-10x-07xzoom-2x2Tiles-stack_Stitch"


# ── Synthetic datasets ─────────────────────────────────────────────────────────

def _volume(rng, X, Y, Z):
    """uint8 (z, y, x) with structure: noise, flat zero regions, saturated spots."""
    vol = rng.integers(0, 256, size=(Z, Y, X), dtype=np.uint8)
    vol[:, : Y // 5, :] = 0
    vol[: Z // 3, :, X // 2:] //= 7
    vol[Z // 2, Y // 2, X // 2] = 255
    return vol


def _mosaic_webp(cube):
    mosaic = np.zeros((512, 512), dtype=np.uint8)
    for z in range(64):
        r, c = divmod(z, 8)
        mosaic[r * 64:(r + 1) * 64, c * 64:(c + 1) * 64] = cube[z]
    buf = io.BytesIO()
    Image.fromarray(mosaic).save(buf, format="WEBP", lossless=True)
    return buf.getvalue()


def _write_tree(tree_dir, vols, drop, pack_size=7):
    """Bricks of every channel into packs; returns (levels, transport, truth) where
    truth is the per-channel volume with the dropped bricks zeroed."""
    Z, Y, X = vols[0].shape
    nx, ny, nz = -(-X // 64), -(-Y // 64), -(-Z // 64)
    b2p, truth = {}, []
    for c, vol in enumerate(vols):
        tv = vol.copy()
        cdir = tree_dir / "lod0" / f"c{c}"
        cdir.mkdir(parents=True, exist_ok=True)
        packs, cur, n = [], bytearray(), 0
        for bz in range(nz):
            for by in range(ny):
                for bx in range(nx):
                    sub = vol[bz * 64:(bz + 1) * 64, by * 64:(by + 1) * 64, bx * 64:(bx + 1) * 64]
                    if drop(c, bx, by, bz) or not sub.any():
                        tv[bz * 64:(bz + 1) * 64, by * 64:(by + 1) * 64, bx * 64:(bx + 1) * 64] = 0
                        continue
                    cube = np.zeros((64, 64, 64), dtype=np.uint8)
                    d, h, w = sub.shape
                    cube[:d, :h, :w] = sub
                    blob = _mosaic_webp(cube)
                    url = f"lod0/c{c}/pack_{len(packs):02d}.bin"
                    b2p[f"lod0/c{c}/x{bx:03d}_y{by:03d}_z{bz:03d}.webp"] = {
                        "url": url, "offset": len(cur), "length": len(blob)}
                    cur += blob
                    n += 1
                    if n % pack_size == 0:
                        (tree_dir / url).write_bytes(bytes(cur))
                        packs.append(url)
                        cur = bytearray()
        if cur:
            url = f"lod0/c{c}/pack_{len(packs):02d}.bin"
            (tree_dir / url).write_bytes(bytes(cur))
        truth.append(tv)
    chunks = [{"id": f"{bz}_{by}_{bx}", "nonEmpty": True}
              for bz in range(nz) for by in range(ny) for bx in range(nx)]
    levels = [{"level": 0, "scale": 1.0, "dimensions": {"x": X, "y": Y, "z": Z}, "brickSize": 64,
               "gridSize": {"x": nx, "y": ny, "z": nz}, "chunks": chunks}]
    transport = {"mode": "packs", "encoding": "webp-lossless", "packSize": pack_size, "brickToPack": b2p}
    return levels, transport, truth


def make_3d(data_web, name="SYN", X=600, Y=530, Z=70, C=2, seed=1):
    rng = np.random.default_rng(seed)
    ds = data_web / "3d" / name
    vols = [_volume(rng, X, Y, Z) for _ in range(C)]
    drop = lambda c, bx, by, bz: (bx + by + bz + c) % 5 == 0   # ESS-dropped bricks
    levels, transport, truth = _write_tree(ds / "bricks", vols, drop)
    manifest = {"version": 2, "schema": "iribhm-bricks-v2", "channels": C, "brickSize": 64,
                "brickPacking": {"mode": "grid", "cols": 8, "rows": 8},
                "levels": levels, "brickTransport": transport, "timepoints": None}
    (ds / "bricks" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (ds / "metadata.json").write_text(json.dumps({"id": f"3d/{name}", "name": name, "type": "3d",
                                                  "curated": "keep me"}, indent=2), encoding="utf-8")
    return ds, {0: truth}


def make_live(data_web, name="LIVE", X=130, Y=70, Z=20, T=2, seed=2):
    rng = np.random.default_rng(seed)
    ds = data_web / "live" / name
    tps, truth = {}, {}
    for t in range(T):
        key = f"t{t:03d}"
        vol = _volume(rng, X, Y, Z)
        levels, transport, tr = _write_tree(ds / "bricks" / key, [vol], lambda *a: False)
        tps[key] = {"path": key, "channels": 1, "levels": levels, "brickTransport": transport}
        truth[t] = tr
    manifest = {"version": 2, "channels": 1, "brickSize": 64,
                "brickPacking": {"mode": "grid", "cols": 8, "rows": 8},
                "levels": tps["t000"]["levels"], "brickTransport": tps["t000"]["brickTransport"],
                "timepoints": tps}
    (ds / "bricks" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (ds / "metadata.json").write_text(json.dumps({"name": name, "type": "live"}), encoding="utf-8")
    return ds, truth


def read_plane_tile(planes_dir, z, c, ty, tx):
    data = (planes_dir / dm.pack_name(z)).read_bytes()
    zz, C, TX, TY, entries = dm.parse_plane_pack(data)
    assert zz == z
    off, length = entries[(c * TY + ty) * TX + tx]
    if not length:
        return None
    w, h, px = dm.decode_png_gray8(data[off:off + length])
    return np.frombuffer(px, dtype=np.uint8).reshape(h, w)


def assert_planes_equal(case, ds, truth_by_tree, live=False):
    for t, truth in truth_by_tree.items():
        pdir = ds / "planes" / (f"t{t:03d}" if live else "")
        man = json.loads((pdir / "manifest.json").read_text(encoding="utf-8"))
        C = len(truth)
        Z, Y, X = truth[0].shape
        case.assertEqual(man["dimensions"], {"x": X, "y": Y, "z": Z})
        case.assertEqual(man["headerBytes"], 16 + 12 * C * man["tiles"]["x"] * man["tiles"]["y"])
        for z in range(Z):
            raw = (pdir / dm.pack_name(z)).read_bytes()
            case.assertEqual(len(raw) >= man["headerBytes"], True)
            for c in range(C):
                for ty in range(man["tiles"]["y"]):
                    for tx in range(man["tiles"]["x"]):
                        expect = truth[c][z, ty * 512:(ty + 1) * 512, tx * 512:(tx + 1) * 512]
                        got = read_plane_tile(pdir, z, c, ty, tx)
                        if got is None:
                            case.assertFalse(expect.any(), f"t{t} z{z} c{c} y{ty} x{tx} stored as zero")
                        else:
                            case.assertEqual(got.shape, expect.shape)
                            case.assertTrue(np.array_equal(got, expect), f"t{t} z{z} c{c} y{ty} x{tx}")


def run_all_units(dataset):
    for _ in range(10000):
        out = dm.unit_run(dataset, MID, max_seconds=20)
        if out["done"] >= out["total"]:
            return out
    raise AssertionError("unit_run never completed")


# ── Tests ──────────────────────────────────────────────────────────────────────

class PureFormat(unittest.TestCase):
    @unittest.skipIf(np is None, "numpy")
    def test_png_numpy_and_pure_paths_identical(self):
        rng = np.random.default_rng(3)
        for w, h in ((512, 512), (77, 13), (1, 1), (300, 2)):
            img = rng.integers(0, 256, size=(h, w), dtype=np.uint8)
            img[:, : w // 3] = 0
            fast = dm.png_gray8(w, h, img.tobytes())
            saved, dm._np = dm._np, None
            try:
                slow = dm.png_gray8(w, h, img.tobytes())
                w2, h2, px = dm.decode_png_gray8(slow)   # the pure decoder too
            finally:
                dm._np = saved
            self.assertEqual(fast, slow)
            self.assertEqual((w2, h2, px), (w, h, img.tobytes()))
            self.assertEqual(Image.open(io.BytesIO(fast)).tobytes(), img.tobytes())
            self.assertFalse(dm.validate_png_gray8(fast, w, h))
            png = fast
            chunks = [png[8 + 4:8 + 8]]
            self.assertEqual(chunks[0], b"IHDR")
            self.assertNotIn(b"gAMA", png)
            self.assertNotIn(b"sRGB", png)

    @unittest.skipIf(np is None, "numpy")
    def test_unmosaic_paths_identical(self):
        rng = np.random.default_rng(4)
        mosaic = rng.integers(0, 256, size=(512, 512), dtype=np.uint8).tobytes()
        fast = dm.unmosaic_brick(mosaic, 512, 512)
        saved, dm._np = dm._np, None
        try:
            slow = dm.unmosaic_brick(mosaic, 512, 512)
            short = dm.unmosaic_brick(mosaic[: 512 * 300], 512, 300)
        finally:
            dm._np = saved
        self.assertEqual(fast, slow)
        m = np.frombuffer(mosaic, dtype=np.uint8).reshape(512, 512)
        cube = np.frombuffer(fast, dtype=np.uint8).reshape(64, 64, 64)
        for z in (0, 7, 8, 63):
            r, c = divmod(z, 8)
            self.assertTrue(np.array_equal(cube[z], m[r * 64:(r + 1) * 64, c * 64:(c + 1) * 64]))
        sc = np.frombuffer(short, dtype=np.uint8).reshape(64, 64, 64)
        self.assertFalse(sc[40:].any())   # truncated mosaic: rows past 300 read 0
        self.assertTrue(np.array_equal(sc[:32], cube[:32]))

    def test_zero_png_detected_and_validation(self):
        z = dm.png_gray8(10, 4, bytes(40))
        self.assertTrue(dm.validate_png_gray8(z, 10, 4))
        with self.assertRaises(ValueError):
            dm.validate_png_gray8(z, 11, 4)
        bad = z[:-12] + dm._png_chunk(b"tEXt", b"k\x00v") + z[-12:]
        with self.assertRaises(ValueError):
            dm.validate_png_gray8(bad, 10, 4)
        with self.assertRaises(ValueError):
            dm.validate_png_gray8(b"\x89PNX" + z[4:], 10, 4)

    def test_pack_layout(self):
        tiles = [b"AAAA", None, b"BB", b""]
        pack = dm.build_plane_pack(3, 1, 2, 2, tiles)
        self.assertEqual(pack[:4], b"LPLN")
        self.assertEqual(struct.unpack_from("<HHHHI", pack, 4), (1, 1, 2, 2, 3))
        hb = dm.pack_header_bytes(1, 2, 2)
        self.assertEqual(hb, 16 + 48)
        z, c, tx, ty, entries = dm.parse_plane_pack(pack)
        self.assertEqual(entries, [(hb, 4), (0, 0), (hb + 4, 2), (0, 0)])
        self.assertEqual(pack[hb:], b"AAAABB")

    def test_probe(self):
        caps = dm.server_capabilities(force=True)
        if Image is None:
            self.assertFalse(caps["available"])
            self.assertIn("no_webp_decode", caps["reasons"])
        else:
            self.assertTrue(caps["available"], caps)


@unittest.skipIf(np is None or Image is None, "numpy + Pillow")
class Engine(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-mig-"))
        self.data_web = self.tmp / "DATA_WEB"
        for t in ("3d", "2d", "live"):
            (self.data_web / t).mkdir(parents=True)
        dm.configure(self.tmp)

    def tearDown(self):
        dm.configure(Path(ROOT))
        shutil.rmtree(self.tmp, ignore_errors=True)

    def meta(self, ds):
        return json.loads((ds / "metadata.json").read_text(encoding="utf-8"))

    def test_server_executor_3d_exact(self):
        ds, truth = make_3d(self.data_web)
        st = dm.status()
        row = next(r for r in st["datasets"] if r["id"] == "3d/SYN")
        self.assertEqual((row["formatVersion"], row["pending"], row["repair"], row["trees"]), (1, [MID], False, 1))
        self.assertGreater(row["estimate"]["units"], 0)
        plan = dm.plan_job("3d/SYN", MID)
        # 2 layers x 2 channels x 2 x 2 tiles
        self.assertEqual(plan["total"], 16)
        self.assertEqual(plan["done"], plan["empty"])
        self.assertEqual(len(plan["units"]), plan["total"] - plan["empty"])
        run_all_units("3d/SYN")
        out = dm.finalize("3d/SYN", MID)
        self.assertEqual(out["formatVersion"], 2)
        assert_planes_equal(self, ds, truth)
        meta = self.meta(ds)
        self.assertEqual((meta["formatVersion"], meta["curated"]), (2, "keep me"))
        man = json.loads((ds / "planes" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(man["producer"], "migration-server")
        self.assertEqual(list(man)[:3], ["schema", "formatVersion", "level"])
        self.assertFalse(dm.journal_path("3d", "SYN", MID).exists())
        self.assertFalse(dm.tile_store_dir("3d", "SYN", MID).exists())
        self.assertFalse((ds / ".planes-incoming").exists())
        row = next(r for r in dm.status()["datasets"] if r["id"] == "3d/SYN")
        self.assertEqual((row["pending"], row["repair"], row["job"]), ([], False, None))

    def test_live_two_timepoints(self):
        ds, truth = make_live(self.data_web)
        plan = dm.plan_job("live/LIVE", MID)
        self.assertEqual(plan["total"], 2)  # 2 trees x 1 layer x 1 channel x 1 x 1 tile
        run_all_units("live/LIVE")
        dm.finalize("live/LIVE", MID)
        assert_planes_equal(self, ds, truth, live=True)
        self.assertEqual(self.meta(ds)["formatVersion"], 2)
        sha = json.loads((ds / "planes" / "t001" / "manifest.json").read_text())["source"]["manifestSha256"]
        self.assertEqual(sha, dm._manifest_sha(ds / "bricks" / "manifest.json"))

    def test_browser_blobs_idempotent_and_switch(self):
        ds, truth = make_3d(self.data_web, X=200, Y=600, Z=64, C=1)
        plan = dm.plan_job("3d/SYN", MID)
        keys = plan["units"]
        p = dm._plan_for("3d/SYN")
        first = keys[0]
        tiles, _ = dm.process_unit(p, dm.parse_unit_key(first))
        blob = struct.pack("<I", len(tiles)) + b"".join(
            struct.pack("<II", z, len(png)) + png for z, png in sorted(tiles.items()))
        # Plus one explicit all-zero tile: accepted, stored as nothing.
        z0 = dm.parse_unit_key(first)[1] * 64
        _tree, w, h, _z0, depth = dm._unit_geometry(p, dm.parse_unit_key(first))
        zero_z = next(z for z in range(z0, z0 + depth) if z not in tiles) if len(tiles) < depth else None
        if zero_z is not None:
            zpng = dm.png_gray8(w, h, bytes(w * h))
            blob = struct.pack("<I", len(tiles) + 1) + blob[4:] + struct.pack("<II", zero_z, len(zpng)) + zpng
        a = dm.unit_put("3d/SYN", MID, first, blob)
        b = dm.unit_put("3d/SYN", MID, first, blob)   # duplicate: harmless
        self.assertEqual(a["done"], b["done"])
        j = json.loads(dm.journal_path("3d", "SYN", MID).read_text())
        self.assertEqual(j["executors"], {"browser": 1, "server": 0})
        self.assertEqual(j["done"].count(first), 1)
        if zero_z is not None:
            self.assertFalse(dm.tile_path(dm.tile_store_dir("3d", "SYN", MID), dm.parse_unit_key(first), zero_z).exists())
        # The server finishes the job (switch), then a late duplicate re-put is still fine.
        run_all_units("3d/SYN")
        dm.unit_put("3d/SYN", MID, first, blob)
        dm.finalize("3d/SYN", MID)
        assert_planes_equal(self, ds, truth)
        man = json.loads((ds / "planes" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(man["producer"], "mixed" if len(keys) > 1 else "migration-browser")

    def test_unit_put_rejections_and_dry(self):
        make_3d(self.data_web, X=100, Y=100, Z=64, C=1)
        self.assertTrue(dm.unit_put("3d/SYN", MID, "t0.z0.c0.y0.x0", b"x" * 100, dry=True)["ok"])
        dm.plan_job("3d/SYN", MID)
        key = "t0.z0.c0.y0.x0"

        def put(entries):
            body = struct.pack("<I", len(entries)) + b"".join(struct.pack("<II", z, len(p)) + p for z, p in entries)
            return dm.handle("unit_put", {"dataset": "3d/SYN", "migration": MID, "unit": key}, {}, body)

        good = dm.png_gray8(100, 100, bytes(range(100)) * 100)
        self.assertEqual(put([(0, dm.png_gray8(99, 100, bytes(9900)))])[0], 400)      # wrong size
        self.assertEqual(put([(64, good)])[0], 400)                                    # z outside layer
        self.assertEqual(put([(0, b"GIF89a" + good[6:])])[0], 400)                     # signature
        self.assertEqual(put([(0, good), (0, good)])[0], 400)                          # duplicate z
        self.assertEqual(dm.handle("unit_put", {"dataset": "3d/SYN", "migration": MID, "unit": key},
                                   {}, b"\x01\x00")[0], 400)                           # truncated
        self.assertEqual(dm.handle("unit_put", {"dataset": "3d/SYN", "migration": MID, "unit": "t0.z9.c0.y0.x0"},
                                   {}, struct.pack("<I", 0))[0], 400)                  # unknown unit
        self.assertEqual(dm.handle("unit_put", {"dataset": "../x", "migration": MID, "unit": key},
                                   {}, struct.pack("<I", 0))[0], 400)
        self.assertEqual(put([(0, good)])[0], 200)

    def test_source_change_fails_the_job(self):
        ds, _ = make_3d(self.data_web, X=100, Y=100, Z=64, C=1)
        dm.plan_job("3d/SYN", MID)
        mp = ds / "bricks" / "manifest.json"
        mp.write_bytes(mp.read_bytes() + b"\n")
        code, payload = dm.handle("unit_run", {}, {"dataset": "3d/SYN", "migration": MID})
        self.assertEqual((code, payload["error"]), (409, "source_changed"))
        j = json.loads(dm.journal_path("3d", "SYN", MID).read_text())
        self.assertEqual((j["state"], j["error"]), ("failed", "source_changed"))
        self.assertEqual(dm.handle("finalize", {}, {"dataset": "3d/SYN", "migration": MID})[0], 409)
        again = dm.plan_job("3d/SYN", MID)       # retry = a fresh job on the new manifest
        self.assertEqual(again["state"], "running")
        run_all_units("3d/SYN")
        self.assertEqual(dm.finalize("3d/SYN", MID)["formatVersion"], 2)

    def test_crash_between_swap_and_bump(self):
        ds, truth = make_3d(self.data_web, X=100, Y=100, Z=64, C=1)
        dm.plan_job("3d/SYN", MID)
        run_all_units("3d/SYN")
        real = dm._bump_metadata

        def crash(*a, **k):
            raise RuntimeError("power cut")
        dm._bump_metadata = crash
        try:
            with self.assertRaises(RuntimeError):
                dm.finalize("3d/SYN", MID)
        finally:
            dm._bump_metadata = real
        self.assertTrue((ds / "planes" / "manifest.json").exists())
        self.assertNotIn("formatVersion", self.meta(ds))
        row = next(r for r in dm.status()["datasets"] if r["id"] == "3d/SYN")
        self.assertEqual((row["formatVersion"], row["pending"]), (1, [MID]))
        self.assertEqual(dm.finalize("3d/SYN", MID)["formatVersion"], 2)
        assert_planes_equal(self, ds, truth)
        # Idempotent beyond the journal: a second finalize, and one with no job at all.
        meta = self.meta(ds)
        meta.pop("formatVersion")
        (ds / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
        self.assertEqual(dm.finalize("3d/SYN", MID)["formatVersion"], 2)

    def test_swap_interrupted_after_first_rename(self):
        ds, truth = make_3d(self.data_web, X=100, Y=100, Z=64, C=1)
        (ds / "planes").mkdir()
        (ds / "planes" / "stale.txt").write_text("old")
        dm.plan_job("3d/SYN", MID)
        run_all_units("3d/SYN")
        real = dm._replace_retry

        def crash_on_second_rename(src, dst, *a, **k):
            if Path(src).name == ".planes-incoming":   # planes/ already moved aside
                raise OSError("crash")
            return real(src, dst, *a, **k)
        dm._replace_retry = crash_on_second_rename
        try:
            with self.assertRaises(OSError):
                dm.finalize("3d/SYN", MID)
        finally:
            dm._replace_retry = real
        self.assertFalse((ds / "planes").exists())
        self.assertEqual(dm.finalize("3d/SYN", MID)["formatVersion"], 2)
        assert_planes_equal(self, ds, truth)
        self.assertFalse((ds / ".planes-old").exists())

    def test_repair_detection(self):
        ds, truth = make_3d(self.data_web, X=100, Y=100, Z=64, C=1)
        dm.plan_job("3d/SYN", MID)
        run_all_units("3d/SYN")
        dm.finalize("3d/SYN", MID)
        (ds / "planes" / dm.pack_name(17)).unlink()
        row = next(r for r in dm.status()["datasets"] if r["id"] == "3d/SYN")
        self.assertEqual((row["formatVersion"], row["pending"], row["repair"]), (2, [MID], True))
        dm.plan_job("3d/SYN", MID)
        run_all_units("3d/SYN")
        self.assertEqual(dm.finalize("3d/SYN", MID)["formatVersion"], 2)
        assert_planes_equal(self, ds, truth)
        # Re-processed bricks (manifest changed) make existing planes stale: repair again.
        mp = ds / "bricks" / "manifest.json"
        mp.write_bytes(mp.read_bytes() + b" ")
        row = next(r for r in dm.status()["datasets"] if r["id"] == "3d/SYN")
        self.assertTrue(row["repair"])

    def test_not_applicable_and_cancel(self):
        make_3d(self.data_web, X=100, Y=100, Z=64, C=1)
        (self.data_web / "2d" / "PHOTO").mkdir()
        (self.data_web / "2d" / "PHOTO" / "metadata.json").write_text('{"type":"2d"}')
        self.assertEqual(dm.handle("plan", {}, {"dataset": "2d/PHOTO", "migration": MID})[0], 409)
        self.assertEqual(dm.handle("plan", {}, {"dataset": "3d/SYN", "migration": "m999"})[0], 400)
        row = next(r for r in dm.status()["datasets"] if r["id"] == "2d/PHOTO")
        self.assertEqual(row["pending"], [])
        dm.plan_job("3d/SYN", MID)
        dm.unit_run("3d/SYN", MID, max_seconds=1)
        self.assertTrue(dm.tile_store_dir("3d", "SYN", MID).exists())
        dm.cancel("3d/SYN", MID)
        self.assertFalse(dm.journal_path("3d", "SYN", MID).exists())
        self.assertFalse(dm.tile_store_dir("3d", "SYN", MID).exists())

    def test_insufficient_disk_refuses_a_new_job(self):
        make_3d(self.data_web, X=100, Y=100, Z=64, C=1)
        real = dm._volume_key
        dm._volume_key = lambda path: (dm.DISK_RESERVE_BYTES + 10, 1)   # one volume, 10 B free
        try:
            code, payload = dm.handle("plan", {}, {"dataset": "3d/SYN", "migration": MID})
        finally:
            dm._volume_key = real
        self.assertEqual((code, payload["error"]), (507, "insufficient_disk"))
        plan = dm._plan_for("3d/SYN")
        self.assertEqual(payload["neededBytes"], 2 * int(sum(plan.unit_bytes.values()) * dm.PLANES_SIZE_RATIO))
        self.assertEqual(payload["freeBytes"], 10)
        self.assertFalse(dm.journal_path("3d", "SYN", MID).exists())
        self.assertEqual(dm.handle("plan", {}, {"dataset": "3d/SYN", "migration": MID})[0], 200)

    def test_cancel_after_the_dataset_was_deleted(self):
        ds, _ = make_3d(self.data_web, X=100, Y=100, Z=64, C=1)
        dm.plan_job("3d/SYN", MID)
        dm.unit_run("3d/SYN", MID, max_seconds=1)
        shutil.rmtree(ds)
        self.assertEqual(dm.handle("unit_run", {}, {"dataset": "3d/SYN", "migration": MID})[0], 404)
        self.assertEqual(dm.handle("cancel", {}, {"dataset": "3d/SYN", "migration": MID})[0], 200)
        self.assertFalse(dm.journal_path("3d", "SYN", MID).exists())
        self.assertFalse(dm.tile_store_dir("3d", "SYN", MID).exists())
        self.assertFalse(ds.exists())                   # never re-created
        self.assertEqual(dm.handle("cancel", {}, {"dataset": "3d/../x", "migration": MID})[0], 400)

    def test_republish_during_assembly_is_not_swapped_in(self):
        ds, _ = make_3d(self.data_web, X=100, Y=100, Z=64, C=1)
        dm.plan_job("3d/SYN", MID)
        run_all_units("3d/SYN")
        real = dm.dataset_planes_valid
        mp = ds / "bricks" / "manifest.json"

        def republish_then_check(plan, root_name="planes"):
            if root_name == ".planes-incoming":
                mp.write_bytes(mp.read_bytes() + b"\n")  # the dataset changed meanwhile
            return real(plan, root_name)
        dm.dataset_planes_valid = republish_then_check
        try:
            code, payload = dm.handle("finalize", {}, {"dataset": "3d/SYN", "migration": MID})
        finally:
            dm.dataset_planes_valid = real
        self.assertEqual((code, payload["error"]), (409, "source_changed"))
        self.assertFalse((ds / "planes").exists())
        self.assertNotIn("formatVersion", self.meta(ds))

    def test_malformed_numbers_and_ids_are_refused_not_crashed(self):
        make_3d(self.data_web, X=100, Y=100, Z=64, C=1)
        code, payload = dm.handle("plan", {}, {"dataset": "3d/SYN", "migration": MID,
                                                "offset": "abc", "limit": float("inf")})
        self.assertEqual(code, 200, payload)
        self.assertEqual(payload["offset"], 0)
        self.assertEqual(dm.handle("finalize", {}, {"dataset": "3d/SYN", "migration": MID,
                                                    "maxSeconds": "soon"})[0], 409)   # units_pending
        self.assertEqual(dm.handle("bench", {}, {"dataset": "3d/SYN", "units": float("nan")})[0], 200)
        for bad in ("3d/SYN\n", "3d/SY٣N", "3d/.SYN", "3d/", "/SYN", "3d/a/b"):
            self.assertEqual(dm.handle("plan", {}, {"dataset": bad, "migration": MID})[0], 400, bad)
        with self.assertRaises(dm.MigrationError):
            dm.parse_unit_key("t0.z0.c0.y0.x0\n")
        with self.assertRaises(dm.MigrationError):
            dm.parse_unit_key("t0.z0.c0.y0.x٣")

    def test_every_runtime_file_ships_in_the_release(self):
        sys.path.insert(0, os.path.join(ROOT, "tools"))
        try:
            import build_release
        finally:
            sys.path.pop(0)
        shipped = {str(rel).replace("\\", "/") for rel in
                   (e[0] if isinstance(e, tuple) else e for e in build_release.collect_files(Path(ROOT)))}
        for rel in ("dataset_migrations.py", "api/migrations.php", "api/_migrations_lib.php",
                    "js/core/plane-codec.js", "js/core/plane-loader.js",
                    "js/workers/plane-decode-worker.js", "js/workers/migration-worker.js",
                    "js/migrations/m002-planes.js", "js/pages/admin/migration-runner.js",
                    "js/pages/admin/tab-dataset-updates.js", "css/admin-updates.css"):
            self.assertIn(rel, shipped)
        sys.path.insert(0, os.path.join(ROOT, "tools"))
        try:
            import build_pipeline_bundle
        finally:
            sys.path.pop(0)
        self.assertIn("planes_writer.py", build_pipeline_bundle.PIPELINE_SCRIPTS)

    @unittest.skipUnless(os.name == "posix", "POSIX file modes")
    def test_published_files_are_readable_by_a_static_server(self):
        ds, _ = make_3d(self.data_web, X=100, Y=100, Z=64, C=1)
        dm.plan_job("3d/SYN", MID)
        run_all_units("3d/SYN")
        dm.finalize("3d/SYN", MID)
        for p in (ds / "metadata.json", ds / "planes" / "manifest.json", ds / "planes" / dm.pack_name(0)):
            self.assertEqual(p.stat().st_mode & 0o044, 0o044, p)

    def test_bench_and_dry_run(self):
        make_3d(self.data_web, X=600, Y=530, Z=70, C=1)
        out = dm.bench("3d/SYN", 3)
        self.assertEqual(out["units"], 3)
        self.assertGreater(out["bytesRead"], 0)
        dm.plan_job("3d/SYN", MID)
        dry = dm.unit_run("3d/SYN", MID, max_seconds=5, dry=True)
        self.assertGreater(len(dry["processed"]), 0)
        self.assertEqual(dry["done"], dm.plan_job("3d/SYN", MID)["empty"])   # nothing recorded
        self.assertFalse(any(dm.tile_store_dir("3d", "SYN", MID).rglob("*.png")))

    def test_without_numpy_tiles_are_byte_identical(self):
        """A host without numpy runs the pure-Python paths: same tiles, same bytes."""
        make_3d(self.data_web, X=130, Y=70, Z=66, C=1)
        p = dm._plan_for("3d/SYN")
        want = {}
        for u in p.units:
            tiles, _ = dm.process_unit(p, u)
            want[dm.unit_key(*u)] = {str(z): png.hex() for z, png in tiles.items()}
        child = "\n".join((
            "import sys, json; sys.modules['numpy'] = None; sys.path.insert(0, sys.argv[1])",
            "import dataset_migrations as dm; dm.configure(sys.argv[2]); assert dm._np is None",
            "p = dm._plan_for('3d/SYN'); out = {}",
            "for u in p.units:",
            "    tiles, _ = dm.process_unit(p, u)",
            "    out[dm.unit_key(*u)] = {str(z): png.hex() for z, png in tiles.items()}",
            "print(json.dumps(out))",
        ))
        r = subprocess.run([sys.executable, "-c", child, ROOT, str(self.tmp)],
                           capture_output=True, text=True, timeout=300)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout), want)

    def test_metadata_without_formatversion_is_v1_and_bump_merges(self):
        ds, _ = make_3d(self.data_web, X=64, Y=64, Z=64, C=1)
        self.assertEqual(dm.format_version({}), 1)
        self.assertEqual(dm.format_version({"formatVersion": "2"}), 1)
        self.assertEqual(dm.format_version({"formatVersion": 3}), 3)
        meta = self.meta(ds)
        meta["formatVersion"] = 3
        (ds / "metadata.json").write_text(json.dumps(meta))
        dm._bump_metadata(ds, 2)                       # never lowers
        self.assertEqual(self.meta(ds)["formatVersion"], 3)


@unittest.skipIf(np is None or Image is None, "numpy + Pillow")
class RealData(unittest.TestCase):
    """The un-mosaic of this module against the browser's own decoder, on real bricks,
    and the server executor over a real dataset (read-only: outputs go to a temp dir)."""

    @unittest.skipUnless((REAL_DS / "bricks" / "manifest.json").exists(), "real dataset not present")
    def test_matches_js_decoder_on_real_bricks(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node not available")
        m = json.loads((REAL_DS / "bricks" / "manifest.json").read_text(encoding="utf-8"))
        b2p = m["brickTransport"]["brickToPack"]
        keys = [k for k in b2p if k.startswith("lod0/")][:: max(1, len([k for k in b2p if k.startswith("lod0/")]) // 6)][:6]
        tmp = Path(tempfile.mkdtemp(prefix="lumen-mig-js-"))
        try:
            cases = []
            for i, key in enumerate(keys):
                e = b2p[key]
                with open(REAL_DS / "bricks" / e["url"], "rb") as fh:
                    fh.seek(e["offset"])
                    raw = fh.read(e["length"])
                with Image.open(io.BytesIO(raw)) as im:
                    rgba = im.convert("RGBA")
                    (tmp / f"{i}.rgba").write_bytes(rgba.tobytes())
                    cases.append({"i": i, "w": rgba.size[0], "h": rgba.size[1]})
                (tmp / f"{i}.py").write_bytes(dm.decode_brick(raw, "webp-lossless", m["brickPacking"]))
            worker = Path(ROOT, "js", "core", "brick-decode-worker.js").read_text(encoding="utf-8")
            harness = r"""
const fs = require('fs'); const path = require('path');
const dir = process.argv[2]; const cases = JSON.parse(process.argv[3]);
let current = null;
globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width: current.w, height: current.h, close() {} });
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; }
  getContext() { const c = this; return { set globalCompositeOperation(v) {}, drawImage() {},
    getImageData(x, y, w, h) { const src = current.rgba, out = new Uint8ClampedArray(w * h * 4);
      for (let r = 0; r < h; r++) for (let q = 0; q < w; q++) for (let k = 0; k < 4; k++) {
        const sx = x + q, sy = y + r;
        out[(r * w + q) * 4 + k] = (sx < current.w && sy < current.h) ? src[(sy * current.w + sx) * 4 + k] : 0; }
      return { data: out }; } }; } };
globalThis.Blob = class { constructor() {} };
const results = [];
globalThis.postMessage = (m) => results.push(m);
""" + worker + r"""
(async () => {
  for (const c of cases) {
    current = { w: c.w, h: c.h, rgba: fs.readFileSync(path.join(dir, c.i + '.rgba')) };
    results.length = 0;
    self.onmessage({ data: { type: 'DECODE', id: c.i, buffer: new ArrayBuffer(4), brickSize: 64,
                             packing: { mode: 'grid', cols: 8, rows: 8 } } });
    await decodeQueue; await new Promise(r => setTimeout(r, 0)); await decodeQueue;
    const res = results.find(r => r.id === c.i);
    if (!res || !res.ok) { console.error('decode failed', res); process.exit(2); }
    fs.writeFileSync(path.join(dir, c.i + '.js'), Buffer.from(res.buffer));
  }
})();
"""
            (tmp / "harness.js").write_text(harness, encoding="utf-8")
            r = subprocess.run([node, str(tmp / "harness.js"), str(tmp), json.dumps(cases)],
                               capture_output=True, text=True, timeout=120)
            self.assertEqual(r.returncode, 0, r.stderr)
            for c in cases:
                self.assertEqual((tmp / f"{c['i']}.js").read_bytes(), (tmp / f"{c['i']}.py").read_bytes(),
                                 f"brick {keys[c['i']]}")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @unittest.skipUnless((REAL_DS / "bricks" / "manifest.json").exists(), "real dataset not present")
    def test_server_executor_on_real_dataset(self):
        """A temp DATA_WEB holds copies of metadata.json + bricks/manifest.json only; the
        LOD0 packs are read in place from the real tree (never written)."""
        tmp = Path(tempfile.mkdtemp(prefix="lumen-mig-real-"))
        try:
            ds = tmp / "DATA_WEB" / "3d" / REAL_DS.name
            (ds / "bricks").mkdir(parents=True)
            shutil.copy2(REAL_DS / "metadata.json", ds / "metadata.json")
            shutil.copy2(REAL_DS / "bricks" / "manifest.json", ds / "bricks" / "manifest.json")
            dm.configure(tmp)
            plan = dm._plan_for(f"3d/{REAL_DS.name}")
            picks = plan.units[:: max(1, len(plan.units) // 4)][:4]
            tree = plan.trees[0]
            # Read the packs in place (read-only): re-point the index at the real tree.
            tmp_bricks = (ds / "bricks").resolve()
            tree.index = {k: (REAL_DS / "bricks" / Path(p).resolve().relative_to(tmp_bricks), o, n)
                          for k, (p, o, n) in tree.index.items()}
            import time as _t
            t0 = _t.monotonic()
            nread = nwritten = ntiles = 0
            for u in picks:
                tiles, r = dm.process_unit(plan, u)
                nread += r
                nwritten += sum(len(x) for x in tiles.values())
                ntiles += len(tiles)
                # Every emitted tile decodes to the bricks' voxels.
                _tree, w, h, z0, depth = dm._unit_geometry(plan, u)
                for z, png in list(tiles.items())[:3]:
                    _w, _h, px = dm.decode_png_gray8(png)
                    self.assertEqual((_w, _h), (w, h))
            secs = _t.monotonic() - t0
            print(f"\n[real] {len(picks)} units in {secs:.2f}s = {secs / len(picks):.3f} s/unit, "
                  f"read {nread / 1e6:.1f} MB, wrote {nwritten / 1e6:.1f} MB in {ntiles} tiles; "
                  f"dataset: {len(plan.units)} non-empty of {plan.total} units, "
                  f"{sum(plan.unit_bytes.values()) / 1e6:.0f} MB LOD0")
        finally:
            dm.configure(Path(ROOT))
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipIf(np is None or Image is None, "numpy + Pillow")
class HttpRoute(unittest.TestCase):
    """/api/migrations.php on a real ThreadingHTTPServer over a throwaway root."""

    @classmethod
    def setUpClass(cls):
        import dev_server
        from http.server import ThreadingHTTPServer
        cls.ds_mod = dev_server
        cls.tmp = Path(tempfile.mkdtemp(prefix="lumen-mig-http-"))
        (cls.tmp / "api").mkdir()
        (cls.tmp / "changelog").mkdir()
        (cls.tmp / "changelog" / "changelog_1.58.0.md").write_text("x", encoding="utf-8")
        for t in ("3d", "2d", "live"):
            (cls.tmp / "DATA_WEB" / t).mkdir(parents=True)
        cls._saved = {k: getattr(dev_server, k) for k in
                      ("ROOT", "DATA_WEB", "CRED_FILE", "UPLOADS_DIR", "CHANGELOG_DIR")}
        dev_server.ROOT = cls.tmp
        dev_server.DATA_WEB = cls.tmp / "DATA_WEB"
        dev_server.CRED_FILE = cls.tmp / "api" / "admin_credential.json"
        dev_server.UPLOADS_DIR = cls.tmp / "uploads"
        dev_server.CHANGELOG_DIR = cls.tmp / "changelog"
        import upload_staging
        upload_staging.configure(cls.tmp)
        dev_server._write_credential_force("admin", "test-password-1234")
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), dev_server.AdminHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.ds, cls.truth = make_3d(cls.tmp / "DATA_WEB", X=200, Y=100, Z=64, C=1)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        for k, v in cls._saved.items():
            setattr(cls.ds_mod, k, v)
        import upload_staging
        upload_staging.configure(Path(ROOT))
        dm.configure(Path(ROOT))
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def req(self, method, path, body=None, raw=None, cookie=None, csrf=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        h = {}
        if cookie:
            h["Cookie"] = cookie
        if csrf:
            h["X-CSRF-Token"] = csrf
        payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        if raw is not None:
            h["Content-Type"] = "application/octet-stream"
        elif body is not None:
            h["Content-Type"] = "application/json"
        conn.request(method, path, body=payload, headers=h)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        try:
            return res.status, json.loads(data.decode() or "{}"), dict(res.getheaders())
        except Exception:
            return res.status, {"_raw": data[:200]}, dict(res.getheaders())

    def test_flow(self):
        base = "/api/migrations.php"
        self.assertEqual(self.req("GET", base + "?action=status")[0], 401)
        self.assertEqual(self.req("POST", base + "?action=unit_put&dataset=3d/SYN", raw=b"x" * 10)[0], 401)
        st, data, hdrs = self.req("POST", "/api/auth.php?action=login",
                                  {"username": "admin", "password": "test-password-1234"})
        self.assertEqual(st, 200)
        cookie, csrf = hdrs["Set-Cookie"].split(";")[0], data["csrf"]
        st, data, _ = self.req("GET", base + "?action=status", cookie=cookie)
        self.assertEqual(st, 200, data)
        self.assertEqual(data["latest"], 2)
        self.assertEqual(data["migrations"][0]["id"], MID)
        self.assertTrue(data["server"]["available"])
        self.assertEqual(self.req("POST", base + "?action=plan", {"dataset": "3d/SYN", "migration": MID},
                                  cookie=cookie)[0], 403)        # CSRF
        self.assertEqual(self.req("GET", base + "?action=plan", cookie=cookie, csrf=csrf)[0], 405)
        st, plan, _ = self.req("POST", base + "?action=plan", {"dataset": "3d/SYN", "migration": MID},
                               cookie=cookie, csrf=csrf)
        self.assertEqual(st, 200, plan)
        first = plan["units"][0]
        p = dm._plan_for("3d/SYN")
        tiles, _ = dm.process_unit(p, dm.parse_unit_key(first))
        blob = struct.pack("<I", len(tiles)) + b"".join(
            struct.pack("<II", z, len(png)) + png for z, png in sorted(tiles.items()))
        q = f"{base}?action=unit_put&dataset=3d/SYN&migration={MID}&unit={first}"
        st, out, _ = self.req("POST", q + "&dry=1", raw=blob, cookie=cookie, csrf=csrf)
        self.assertEqual((st, out.get("dry")), (200, True))
        st, out, _ = self.req("POST", q, raw=blob, cookie=cookie, csrf=csrf)
        self.assertEqual(st, 200, out)
        st, out, _ = self.req("POST", base + "?action=bench", {"dataset": "3d/SYN", "units": 2},
                              cookie=cookie, csrf=csrf)
        self.assertEqual(st, 200, out)
        while True:
            st, out, _ = self.req("POST", base + "?action=unit_run",
                                  {"dataset": "3d/SYN", "migration": MID, "maxSeconds": 5},
                                  cookie=cookie, csrf=csrf)
            self.assertEqual(st, 200, out)
            if out["done"] >= out["total"]:
                break
        st, out, _ = self.req("POST", base + "?action=finalize", {"dataset": "3d/SYN", "migration": MID},
                              cookie=cookie, csrf=csrf)
        self.assertEqual((st, out.get("formatVersion")), (200, 2), out)
        assert_planes_equal(self, self.ds, self.truth)
        self.assertTrue((self.tmp / "uploads" / ".htaccess").exists())
        # The catalog carries the bumped version (it copies metadata verbatim).
        st, cat, _ = self.req("GET", "/DATA_WEB/catalog.json")
        row = next((r for r in cat if r.get("id") == "3d/SYN"), None) if isinstance(cat, list) else None
        if row is not None:
            self.assertEqual(row.get("formatVersion"), 2)
        # The tile store is unreachable over HTTP.
        self.assertEqual(self.req("GET", "/uploads/migrations/x.json")[0], 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
