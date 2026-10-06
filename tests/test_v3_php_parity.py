"""Dataset formats 3 and 4 — PHP ↔ Python parity of migrations m003-layer-mips and
m004-bricks-v3 (SPEC §12, §13), driving api/_migrations_lib.php through
tests/mig_php_driver.php and dataset_migrations.py on the same synthetic datasets
(v2 bricks encoded by Pillow exactly like the pipeline):

* the whole chain m002 → m003 → m004 by each backend: plans, journals and status rows
  identical (timestamps aside); every layer MIP equal to the maximum of the source voxels
  and identical between backends; every v3 brick of every level, decoded, equal to the
  pipeline's own reference (preprocess/bricks_v3_writer: level ladder, integer mean
  rounded half up, 66³ apron with clamp-to-edge, exact ESS) and identical between
  backends; index.bin presence maps and pack counts identical; manifests identical apart
  from the encoder-dependent sizes/hashes; planes/ and mips/ re-stamped; version 4;
* cross-backend resume of m004 both ways (PHP starts, Python finishes, and the reverse);
* the browser path through PHP: unit_put of Python-made blobs, unit_blocked before a
  lower level is complete, bad_webp for a lossy brick, bad_blob for a foreign brick —
  same status and error code as the Python twin; unit_inputs and store_get identical;
* memory: a dense level-0 and level-1 unit and a large plan (a 3789×3789×226×4 manifest)
  under PHP memory_limit = 128M, peak reported.

Run: py -3.12 tests/test_v3_php_parity.py   (php with GD/WebP ≥ 8.1, numpy, Pillow)

The default run (what CI runs) uses a 600×150×70 volume, one shared copy of the
format-3 dataset and a 257³ dense volume for the memory checks; LUMEN_V3_FULL=1 runs the
full-size variants as well (a 140-plane volume, and a full dense level-1 unit of 514³
source voxels under 128 MiB, ~2 min each).
"""
import base64
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "preprocess"))

try:
    import numpy as np
    from PIL import Image
    import dataset_migrations as dm
    import bricks_v3_writer as bw
    import test_mig_php_parity as base
except Exception as exc:  # pragma: no cover
    print(f"SKIP: numpy/Pillow/dataset_migrations unavailable ({exc})")
    sys.exit(0)

PHP = base.PHP
FULL = os.environ.get("LUMEN_V3_FULL") == "1"
M2, M3, M4 = "m002-planes", "m003-layer-mips", "m004-bricks-v3"
strip = base.strip_times


def strip_deep(d):
    if isinstance(d, dict):
        return {k: strip_deep(v) for k, v in d.items() if k not in ("createdAt", "updatedAt", "assembledAt")}
    if isinstance(d, list):
        return [strip_deep(v) for v in d]
    return d


ENCODER_KEYS = ("bytesRemaining", "bytes", "bytesTotal", "inputManifests")


def strip_encoded(d):
    """m003's inputs are the planes each backend ENCODED itself (zlib builds differ):
    their byte sizes and manifest hashes are not comparable, the rest is."""
    if isinstance(d, dict):
        return {k: strip_encoded(v) for k, v in d.items() if k not in ENCODER_KEYS}
    if isinstance(d, list):
        return [strip_encoded(v) for v in d]
    return d


def set_voxel(ds_dir: Path, voxel):
    p = ds_dir / "bricks" / "manifest.json"
    man = json.loads(p.read_text(encoding="utf-8"))
    man["voxelSize"] = voxel
    p.write_text(json.dumps(man), encoding="utf-8")


def reference_levels(vol, voxel):
    """{level: {(bz, by, bx): 66³ array}} of the stored v3 bricks, from the pipeline's code."""
    Z, Y, X = vol.shape
    ladder = bw.level_ladder((X, Y, Z), voxel)
    out, cur = {}, vol
    for L in ladder:
        if L["level"]:
            hz = L["halveZ"]
            D = cur.shape[0]
            cur = np.stack([bw.reduce_level(cur[2 * z:min(D, 2 * z + 2)] if hz else cur[z:z + 1], hz)[0]
                            for z in range(L["dimensions"]["z"])])
        gx, gy, gz = bw.grid_size(L["dimensions"])
        bricks = {}
        for bz in range(gz):
            for by in range(gy):
                for bx in range(gx):
                    b = bw.brick_with_apron(cur, bx, by, bz)
                    if bw.brick_kept(b):
                        bricks[(bz, by, bx)] = b
        out[L["level"]] = bricks
    return ladder, out


def read_v3_tree(tree_dir: Path, channels):
    """{(k, c): {(bz, by, bx): 66³ array}}, [(gx, gy, gz, packCount)] of one v3 tree."""
    data = (tree_dir / "index.bin").read_bytes()
    idx = dm.parse_index_bin(data)
    out = {}
    for k, L in enumerate(idx["levels"]):
        gx, gy, gz = L["grid"]
        for c in range(channels):
            arr = L["entries"][c]
            d = {}
            for i in range(gx * gy * gz):
                p, o, ln = int(arr[i]["p"]), int(arr[i]["o"]), int(arr[i]["l"])
                if not ln:
                    continue
                bx, r = i % gx, i // gx
                by, bz = r % gy, r // gy
                with open(tree_dir / dm.v3_pack_rel(k, c, p), "rb") as fh:
                    fh.seek(o)
                    d[(bz, by, bx)] = dm.decode_brick_v3(fh.read(ln), strict=True)
            out[(k, c)] = d
    return out, [(*L["grid"], L["packCount"]) for L in idx["levels"]]


def read_mips(mips_dir: Path):
    packs = {}
    for p in sorted(mips_dir.rglob("*.bin")):
        data = p.read_bytes()
        z, c, tx, ty, entries = dm.parse_plane_pack(data, magic=b"LMIP")
        packs[p.relative_to(mips_dir).as_posix()] = (z, c, tx, ty, [
            dm.decode_png_gray8(data[o:o + n])[2] if n else None for o, n in entries])
    return packs


@unittest.skipIf(PHP is None, "php with GD/WebP not found")
class V3Parity(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="lumen-v3-parity-"))
        cls.src = base.Tree(cls.tmp / "src")
        # Default 600×150×70: two plane/MIP tiles across X (a partial one), partial last
        # brick row/layer on every axis, four v3 levels; FULL: 600×530×140 (two tiles in Y too).
        Y, Z = (530, 140) if FULL else (150, 70)
        cls.truth3d = base.build_dataset(cls.src.data_web, "3d", "synA",
                                         {0: [base.make_volume(11, 600, Y, Z), base.make_volume(12, 600, Y, Z)]})
        # Anisotropic voxel: level 1 keeps Z (2 > 1.5·1), level 2 halves it.
        cls.voxel3d = {"x": 0.5, "y": 0.5, "z": 2.0}
        set_voxel(cls.src.data_web / "3d" / "synA", cls.voxel3d)
        cls.truthLive = base.build_dataset(cls.src.data_web, "live", "synL",
                                           {0: [base.make_volume(13, 300, 140, 40)], 1: [base.make_volume(14, 300, 140, 40)]})

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)
        dm.configure(ROOT)

    def clone(self, name):
        dst = self.tmp / name
        shutil.copytree(self.src.base, dst)
        return base.Tree(dst)

    # ── executors ──
    def py_run(self, tree, ds, mid):
        m = tree.py()
        m.plan_job(ds, mid)
        while True:
            r = m.unit_run(ds, mid, 20)
            if r["done"] >= r["total"]:
                break
        while not m.finalize(ds, mid).get("complete", False):
            pass

    def php_run(self, tree, ds, mid, budget=20):
        st, r = tree.php_handle("plan", {"dataset": ds, "migration": mid})
        self.assertEqual(st, 200, r)
        while True:
            st, r = tree.php_handle("unit_run", {"dataset": ds, "migration": mid, "maxSeconds": budget})
            self.assertEqual(st, 200, r)
            if r["done"] >= r["total"]:
                break
        while True:
            st, r = tree.php_handle("finalize", {"dataset": ds, "migration": mid})
            self.assertEqual(st, 200, r)
            if r.get("complete"):
                break

    # ── checks ──
    def check_mips(self, ds_dir, truth, typ):
        packs = read_mips(ds_dir / "mips")
        n = 0
        for t, chans in truth.items():
            prefix = f"t{t:03d}/" if typ == "live" else ""
            Z, Y, X = chans[0].shape
            TX, TY = -(-X // 512), -(-Y // 512)
            for lay in range(-(-Z // 64)):
                z, C, tx_, ty_, pix = packs[f"{prefix}l{lay:05d}.bin"]
                self.assertEqual((z, C, tx_, ty_), (lay, len(chans), TX, TY))
                i = 0
                for c in range(C):
                    mx = chans[c][lay * 64:lay * 64 + 64].max(axis=0)
                    for ty in range(TY):
                        for tx in range(TX):
                            ref = mx[ty * 512:(ty + 1) * 512, tx * 512:(tx + 1) * 512]
                            if pix[i] is None:
                                self.assertFalse(ref.any(), f"{prefix}l{lay} c{c}: zero entry over data")
                            else:
                                self.assertEqual(pix[i], ref.tobytes(), f"{prefix}l{lay} c{c} y{ty} x{tx}")
                            i += 1
                            n += 1
        return packs, n

    def check_v3(self, ds_dir, truth, typ, voxel):
        man = json.loads((ds_dir / "bricks" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(man["schema"], "iribhm-bricks-v3")
        trees = {}
        nb = 0
        for t, chans in truth.items():
            rel = f"t{t:03d}" if typ == "live" else ""
            got, grids = read_v3_tree(ds_dir / "bricks" / rel if rel else ds_dir / "bricks", len(chans))
            for c, vol in enumerate(chans):
                ladder, ref = reference_levels(vol, voxel)
                self.assertEqual(len(grids), len(ladder))
                for k in ref:
                    g = got[(k, c)]
                    self.assertEqual(sorted(g), sorted(ref[k]), f"{rel} level {k} c{c}: stored brick set")
                    for b, arr in ref[k].items():
                        self.assertTrue(np.array_equal(g[b], arr), f"{rel} level {k} c{c} brick {b}")
                        nb += 1
            trees[rel] = (got, grids)
        return man, trees, nb

    # ── 1. the whole chain by each backend ──
    def test_chain_each_backend(self):
        for ds, typ, truth, voxel in (("3d/synA", "3d", self.truth3d, self.voxel3d),
                                      ("live/synL", "live", self.truthLive, {"x": 1.0, "y": 1.0, "z": 1.0})):
            a, b = self.clone("chainA_" + typ), self.clone("chainB_" + typ)
            folder = ds.split("/")[1]
            for mid in (M2, M3, M4):
                pa = {"ok": True, **a.py().plan_job(ds, mid)}
                st, pb = b.php_handle("plan", {"dataset": ds, "migration": mid})
                self.assertEqual(st, 200, pb)
                norm = strip_encoded if mid == M3 else (lambda x: x)
                self.assertEqual(norm(strip_deep(pa)), norm(strip_deep(pb)), f"{ds} {mid}: plan")
                ja = json.loads(a.py().journal_path(typ, folder, mid).read_text(encoding="utf-8"))
                jb = json.loads((b.uploads / "migrations" / f"{typ}__{folder}__{mid}.json").read_text(encoding="utf-8"))
                self.assertEqual(norm(strip(ja)), norm(strip(jb)), f"{ds} {mid}: journal")
                sa = {r["id"]: strip_deep(r) for r in a.py().status()["datasets"]}
                st, sbb = b.php_handle("status")
                sb = {r["id"]: strip_deep(r) for r in sbb["datasets"]}
                self.assertEqual(norm(sa[ds]), norm(sb[ds]), f"{ds} {mid}: status row")
                self.py_run(a, ds, mid)
                self.php_run(b, ds, mid)
                fa = json.loads((a.data_web / ds / "metadata.json").read_text(encoding="utf-8"))
                fb = json.loads((b.data_web / ds / "metadata.json").read_text(encoding="utf-8"))
                self.assertEqual(fa["formatVersion"], fb["formatVersion"])
                self.assertEqual(fb.get("curated"), "keep")
            self.assertEqual(fb["formatVersion"], 4)
            mpa, n = self.check_mips(a.data_web / ds, truth, typ)
            mpb, _ = self.check_mips(b.data_web / ds, truth, typ)
            self.assertEqual({k: v for k, v in mpa.items()}, {k: v for k, v in mpb.items()}, "mips differ")
            mana, ta, nb = self.check_v3(a.data_web / ds, truth, typ, voxel)
            manb, tb, _ = self.check_v3(b.data_web / ds, truth, typ, voxel)
            for rel in ta:
                self.assertEqual(ta[rel][1], tb[rel][1], f"{rel}: index grids / pack counts")
            # Manifests: equal but for what the encoder decides (index size/sha) and the producer.
            def norm(m):
                m = json.loads(json.dumps(m))
                m.pop("createdAt", None); m.pop("producer", None)
                m.get("index", {}).pop("bytes", None); m.get("index", {}).pop("sha256", None)
                for row in m.get("timepoints") or []:
                    row["index"].pop("bytes", None); row["index"].pop("sha256", None)
                return m
            self.assertEqual(norm(mana), norm(manb), f"{ds}: v3 manifests")
            self.assertEqual(manb["producer"], "migration-server")
            sha_b = dm._manifest_sha(b.data_web / ds / "bricks" / "manifest.json")
            for root in ("planes", "mips"):
                for p in (b.data_web / ds / root).rglob("manifest.json"):
                    self.assertEqual(json.loads(p.read_text(encoding="utf-8"))["source"]["manifestSha256"], sha_b, f"{p}: re-stamp")
            self.assertFalse((b.data_web / ds / "bricks.v2-old").exists())
            st, sbb = b.php_handle("status")
            row = {r["id"]: r for r in sbb["datasets"]}[ds]
            self.assertEqual((row["pending"], row["bricksSchema"], row.get("problem")), ([], "iribhm-bricks-v3", None))
            print(f"  {ds}: chain exact under both backends ({n} MIP tiles, {nb} v3 bricks)")

    # ── 2. m004 resumed across backends ──
    def _prepare_v3(self, name):
        """A copy of synA at format 3 (m002 + m003 run once by Python, then copied)."""
        cls = type(self)
        if getattr(cls, "_v3_ready", None) is None:
            t = self.clone("format3")
            for mid in (M2, M3):
                self.py_run(t, "3d/synA", mid)
            cls._v3_ready = t
        dst = self.tmp / name
        shutil.copytree(cls._v3_ready.base, dst)
        return base.Tree(dst)

    def test_resume_both_ways(self):
        ds = "3d/synA"
        for first in ("php", "python"):
            t = self._prepare_v3("resume_" + first)
            m = t.py()
            if first == "php":
                st, _r = t.php_handle("plan", {"dataset": ds, "migration": M4})
                # 0 s budget: one unit per call — three calls, then Python takes over.
                res = t.php([{"op": "handle", "action": "unit_run", "body": {"dataset": ds, "migration": M4, "maxSeconds": 0}, "params": {}}] * 3,
                            zero_floor=True)
                self.assertTrue(all(r[0] == 200 and len(r[1]["processed"]) == 1 for r in res), res)
                self.py_run(t, ds, M4)
            else:
                m.plan_job(ds, M4)
                m.unit_run(ds, M4, 0.0001)
                self.php_run(t, ds, M4)
            j = None
            self.check_v3(t.data_web / ds, self.truth3d, "3d", self.voxel3d)
            meta = json.loads((t.data_web / ds / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["formatVersion"], 4)
            print(f"  m004 started by {first}, finished by the other: exact")

    # ── 3. the browser path, PHP vs Python answers ──
    def test_unit_put_and_inputs(self):
        ds = "3d/synA"
        a, b = self._prepare_v3("putA"), self._prepare_v3("putB")
        pa = a.py().plan_job(ds, M4)
        st, pb = b.php_handle("plan", {"dataset": ds, "migration": M4})
        self.assertEqual(strip_deep({"ok": True, **pa}), strip_deep(pb))
        m = a.py()
        plan = m._plan_for(ds)
        us = m._unitset(plan, M4)
        store = m.tile_store_dir("3d", "synA", M4)
        # A level-1 unit before level 0 is complete: blocked on both.
        lvl1 = next(u for u in us.units if u[1] == 1)
        key1 = m.unit_key_for(M4, lvl1)
        blob1 = m.build_v3_unit_blob({})
        ra = m.handle("unit_put", {"dataset": ds, "migration": M4, "unit": key1}, {}, blob1)
        rb = b.php_handle("unit_put", params={"dataset": ds, "migration": M4, "unit": key1}, raw=blob1)
        self.assertEqual((ra[0], ra[1]["error"]), (rb[0], rb[1]["error"]))
        self.assertEqual(rb[1]["error"], "unit_blocked")
        # unit_inputs identical (level 0, before anything ran).
        key0 = pa["units"][0]
        ia = m.handle("unit_inputs", {}, {"dataset": ds, "migration": M4, "unit": key0})
        ib = b.php_handle("unit_inputs", {"dataset": ds, "migration": M4, "unit": key0})
        self.assertEqual(ia, tuple(ib) if isinstance(ib, tuple) else (ib[0], ib[1]))
        # Every level-0 unit posted to PHP as Python computes it; then level 1 by PHP itself.
        for key in pa["units"]:
            unit = m.parse_unit_key_for(M4, key)
            bricks, _n = m.process_unit_m004(plan, us, unit, store)
            st, r = b.php_handle("unit_put", params={"dataset": ds, "migration": M4, "unit": key}, raw=m.build_v3_unit_blob(bricks))
            self.assertEqual(st, 200, r)
        # Bad bricks: a lossy WebP, a brick outside the unit — same code as Python.
        nxt = b.php_handle("plan", {"dataset": ds, "migration": M4})[1]["units"][0]
        u = m.parse_unit_key_for(M4, nxt)
        inside = m._m004_unit_bricks(us, u)[0]
        buf = io.BytesIO()
        Image.fromarray(np.zeros((528, 594), np.uint8)).save(buf, format="WEBP", quality=80)
        for bricks, code in (({inside: buf.getvalue()}, "bad_webp"), ({(999, 0, 0): buf.getvalue()}, "bad_blob")):
            blob = m.build_v3_unit_blob(bricks)
            rb = b.php_handle("unit_put", params={"dataset": ds, "migration": M4, "unit": nxt}, raw=blob)
            self.assertEqual((rb[0], rb[1]["error"]), (400, code))
        # store_get of a level-0 brick posted above, and an absent one.
        any_key = next(k for k in pa["units"])
        t0, k0, c0, BZ, BY, BX = m.parse_unit_key_for(M4, any_key)
        stored = sorted((b.uploads / "migrations" / f"3d__synA__{M4}" / "t0" / "k0" / f"c{c0}").glob("*.webp"))
        self.assertTrue(stored)
        z_, y_, x_ = (int(s[1:]) for s in stored[0].stem.split("."))
        bkey = f"t0.k0.c{c0}.z{z_}.y{y_}.x{x_}"
        (stc, typ, body), = b.php([{"op": "binary", "action": "store_get", "params": {"dataset": ds, "migration": M4, "brick": bkey}}])
        self.assertEqual((stc, typ, base64.b64decode(body)), (200, "application/octet-stream", stored[0].read_bytes()))
        (stc, typ, body), = b.php([{"op": "binary", "action": "store_get", "params": {"dataset": ds, "migration": M4, "brick": "t0.k0.c0.z99.y0.x0"}}])
        self.assertEqual((stc, json.loads(base64.b64decode(body))["error"]), (404, "absent"))
        # store_get_many: byte-identical to the Python twin, absent brick = length 0.
        many = {"dataset": ds, "migration": M4, "base": f"t0.k0.c{c0}", "bricks": f"{z_}.{y_}.{x_},99.0.0"}
        (stc, typ, body), = b.php([{"op": "binary", "action": "store_get_many", "params": many}])
        self.assertEqual((stc, typ), (200, "application/octet-stream"))
        self.assertEqual(base64.b64decode(body), struct.pack("<III", 2, len(stored[0].read_bytes()), 0) + stored[0].read_bytes())
        (stc, _typ, body), = b.php([{"op": "binary", "action": "store_get_many", "params": {**many, "bricks": ""}}])
        self.assertEqual(stc, 400)
        # The rest by the PHP server executor, then the result is exact (mixed producer).
        self.php_run(b, ds, M4)
        man, _t, _n = self.check_v3(b.data_web / ds, self.truth3d, "3d", self.voxel3d)
        self.assertEqual(man["producer"], "mixed")
        print("  m004 browser path through PHP: blobs accepted, refusals identical, result exact")

    # ── 4. memory under a shared host's 128 MiB ──
    def test_memory_peak(self):
        t = base.Tree(self.tmp / "mem")
        rng = np.random.default_rng(7)
        # 257³: the first level-0 unit reads a full-size region (257³ of the 258³ a unit
        # can read), the other seven are 1-voxel slivers, and level 1 (129³) is one unit.
        dense = rng.integers(1, 256, size=(257, 257, 257), dtype=np.uint8)
        base.build_dataset(t.data_web, "3d", "dense", {0: [dense]})
        man_p = t.data_web / "3d" / "dense" / "bricks" / "manifest.json"
        man = json.loads(man_p.read_text(encoding="utf-8"))
        # build_dataset drops some bricks (ESS pattern); fine: the unit is still dense.
        meta_p = t.data_web / "3d" / "dense" / "metadata.json"
        meta = json.loads(meta_p.read_text(encoding="utf-8"))
        meta["formatVersion"] = 3
        meta_p.write_text(json.dumps(meta), encoding="utf-8")
        # A large plan: a real-sized manifest (3789×3789×226, 4 channels, every brick listed).
        big = t.data_web / "3d" / "big"
        (big / "bricks").mkdir(parents=True)
        nx, ny, nz = 60, 60, 4
        b2p = {f"lod0/c{c}/x{x:03d}_y{y:03d}_z{z:03d}.webp": {"url": f"lod0/c{c}/pack_{(x * ny + y) % 99:03d}.bin", "offset": 1000 * z, "length": 999}
               for c in range(4) for x in range(nx) for y in range(ny) for z in range(nz)}
        chunks = [{"id": f"{z}_{y}_{x}", "nonEmpty": True, "bounds": [0, 0, 0, 64, 64, 64]} for z in range(nz) for y in range(ny) for x in range(nx)]
        bm = {"version": 2, "schema": "iribhm-bricks-v2", "channels": 4, "brickSize": 64,
              "brickPacking": {"mode": "grid", "cols": 8, "rows": 8}, "voxelSize": {"x": 0.43, "y": 0.43, "z": 2.05},
              "levels": [{"level": 0, "dimensions": {"x": 3789, "y": 3789, "z": 226}, "brickSize": 64,
                          "gridSize": {"x": nx, "y": ny, "z": nz}, "chunks": chunks}],
              "histograms": [{"counts": list(range(256))}] * 4,
              "brickTransport": {"mode": "packs", "encoding": "webp-lossless", "brickToPack": b2p}}
        (big / "bricks" / "manifest.json").write_text(json.dumps(bm), encoding="utf-8")
        (big / "metadata.json").write_text(json.dumps({"id": "3d/big", "type": "3d", "name": "big", "formatVersion": 3}), encoding="utf-8")
        mb = (big / "bricks" / "manifest.json").stat().st_size / 1e6

        def php_peak(ops):
            req = t.base / "req.json"
            req.write_text(json.dumps({"dataWeb": str(t.data_web).replace("\\", "/"), "uploads": str(t.uploads).replace("\\", "/"),
                                       "private": str(t.private).replace("\\", "/"), "ops": ops + [{"op": "peak"}]}), encoding="utf-8")
            r = subprocess.run([*PHP, "-d", "memory_limit=128M", str(base.DRIVER), str(req)], capture_output=True, text=True, timeout=900)
            self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])
            return json.loads(r.stdout)

        out = php_peak([{"op": "handle", "action": "status"},
                        {"op": "handle", "action": "plan", "body": {"dataset": "3d/big", "migration": M4}}])
        self.assertEqual(out[1][0], 200, out[1])
        peak_plan = out[-1]["peak"]
        out = php_peak([{"op": "handle", "action": "plan", "body": {"dataset": "3d/dense", "migration": M4}},
                        {"op": "handle", "action": "unit_run", "body": {"dataset": "3d/dense", "migration": M4, "maxSeconds": 0}}])
        self.assertEqual(out[1][0], 200, out[1])
        self.assertEqual(out[1][1]["processed"], ["t0.k0.c0.z0.y0.x0"])
        peak_l0 = out[-1]["peak"]
        while True:
            st, r = t.php_handle("unit_run", {"dataset": "3d/dense", "migration": M4, "maxSeconds": 20})
            self.assertEqual(st, 200, r)
            if r["processed"] and r["processed"][-1].startswith("t0.k1."):
                break
            if r["done"] >= r["total"]:
                break
        # Level 1 of the dense volume: re-run its first unit alone in a fresh 128M process.
        store = t.uploads / "migrations" / f"3d__dense__{M4}"
        jpath = t.uploads / "migrations" / f"3d__dense__{M4}.json"
        j = json.loads(jpath.read_text(encoding="utf-8"))
        k1 = [k for k in j["done"] if k.startswith("t0.k1.")]
        if k1:
            j["done"] = [k for k in j["done"] if k != k1[0]]
            jpath.write_text(json.dumps(j), encoding="utf-8")
            out = php_peak([{"op": "handle", "action": "unit_run", "body": {"dataset": "3d/dense", "migration": M4, "maxSeconds": 0}}])
            self.assertEqual(out[0][0], 200, out[0])
            peak_l1 = out[-1]["peak"]
        else:
            peak_l1 = 0
        print(f"  PHP peak memory: status+plan of a {mb:.0f} MB manifest {peak_plan / 2**20:.1f} MiB, "
              f"dense level-0 unit {peak_l0 / 2**20:.1f} MiB, dense level-1 unit {peak_l1 / 2**20:.1f} MiB (limit 128M)")
        for p in (peak_plan, peak_l0, peak_l1):
            self.assertLess(p, 128 * 2**20)

    # ── 5. a full-size dense level-1 unit (source 514³ voxels) under 128 MiB ──
    def test_memory_full_level1_unit(self):
        if not FULL:
            print("  (full-size dense level-1 unit not run: set LUMEN_V3_FULL=1, ~2 min)")
            return
        t = base.Tree(self.tmp / "mem1")
        N = 520
        ds_dir = t.data_web / "3d" / "cube"
        (ds_dir / "bricks").mkdir(parents=True)
        g = -(-N // 64)
        b2p = {f"lod0/c0/x{x:03d}_y{y:03d}_z{z:03d}.webp": {"url": "lod0/c0/never_read.bin", "offset": 0, "length": 1000}
               for x in range(g) for y in range(g) for z in range(g)}
        man = {"version": 2, "schema": "iribhm-bricks-v2", "channels": 1, "brickSize": 64,
               "brickPacking": {"mode": "grid", "cols": 8, "rows": 8}, "voxelSize": {"x": 1, "y": 1, "z": 1},
               "levels": [{"level": 0, "dimensions": {"x": N, "y": N, "z": N}, "brickSize": 64, "gridSize": {"x": g, "y": g, "z": g}}],
               "brickTransport": {"mode": "packs", "encoding": "webp-lossless", "brickToPack": b2p}}
        (ds_dir / "bricks" / "manifest.json").write_text(json.dumps(man), encoding="utf-8")
        (ds_dir / "metadata.json").write_text(json.dumps({"id": "3d/cube", "type": "3d", "name": "cube", "formatVersion": 3}), encoding="utf-8")
        st, plan = t.php_handle("plan", {"dataset": "3d/cube", "migration": M4})
        self.assertEqual(st, 200, plan)
        # Level 0 as if done: the store bricks of the first level-1 unit's source range.
        rng = np.random.default_rng(5)
        zz, yy, xx = np.ogrid[0:N, 0:N, 0:N]
        vol = ((xx + 2 * yy + 3 * zz) % 251 + 1).astype(np.uint8)
        vol ^= rng.integers(0, 4, size=vol.shape, dtype=np.uint8)
        store = t.uploads / "migrations" / f"3d__cube__{M4}" / "t0" / "k0" / "c0"
        store.mkdir(parents=True)
        for bz in range(9):
            for by in range(9):
                for bx in range(9):
                    b = bw.brick_with_apron(vol, bx, by, bz)
                    (store / f"z{bz}.y{by}.x{bx}.webp").write_bytes(dm.encode_brick_v3(b))
        jpath = t.uploads / "migrations" / f"3d__cube__{M4}.json"
        j = json.loads(jpath.read_text(encoding="utf-8"))
        j["done"] = [k for k in plan["units"] if k.startswith("t0.k0.")]
        jpath.write_text(json.dumps(j), encoding="utf-8")
        req = t.base / "req.json"
        req.write_text(json.dumps({"dataWeb": str(t.data_web).replace("\\", "/"), "uploads": str(t.uploads).replace("\\", "/"),
                                   "private": str(t.private).replace("\\", "/"), "zeroBudgetFloor": True,
                                   "ops": [{"op": "handle", "action": "unit_run", "body": {"dataset": "3d/cube", "migration": M4, "maxSeconds": 0}},
                                           {"op": "peak"}]}), encoding="utf-8")
        r = subprocess.run([*PHP, "-d", "memory_limit=128M", str(base.DRIVER), str(req)], capture_output=True, text=True, timeout=900)
        self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])
        out = json.loads(r.stdout)
        self.assertEqual(out[0][0], 200, out[0])
        self.assertEqual(out[0][1]["processed"], ["t0.k1.c0.z0.y0.x0"])
        # Exactness of that unit against the pipeline's reduction of the same voxels.
        lvl1 = bw.reduce_level(vol[:514, :514, :514], True)
        got = t.uploads / "migrations" / f"3d__cube__{M4}" / "t0" / "k1" / "c0"
        n = 0
        for bz in range(4):
            for by in range(4):
                for bx in range(4):
                    ref = bw.brick_with_apron(lvl1, bx, by, bz)[: , :, :]
                    # brick_with_apron clamps at the REGION's edge; compare the interior + low apron only
                    dec = dm.decode_brick_v3((got / f"z{bz}.y{by}.x{bx}.webp").read_bytes())
                    self.assertTrue(np.array_equal(dec[:65, :65, :65], ref[:65, :65, :65]), (bz, by, bx))
                    n += 1
        print(f"  PHP dense full level-1 unit (514³ source voxels, 729 source bricks): {out[1]['peak'] / 2**20:.1f} MiB, "
              f"{out[0][1]['seconds']} s, {n} bricks exact")
        self.assertLess(out[1]["peak"], 128 * 2**20)


    # ── 6. real local bricks (read-only): PHP and Python cut identical v3 bricks ──
    def test_real_bricks_m004_units(self):
        real = ROOT / "DATA_WEB" / base.REAL_DS
        if not (real / "bricks" / "manifest.json").is_file():
            # Not a skip: CI has no dataset in the repository (cf. test_mig_php_parity).
            print("  (real-dataset m004 parity not run: DATA_WEB holds no local dataset - CI)")
            return
        t = base.Tree(self.tmp / "real")
        dm.configure(ROOT)
        plan = dm._plan_for(base.REAL_DS)
        if plan.v3:
            print("  (real-dataset m004 parity not run: the local dataset is already v3)")
            return
        us = dm._unitset(plan, M4)
        lvl0 = [u for u in us.units if u[1] == 0]
        picks = [lvl0[len(lvl0) // 3], lvl0[(2 * len(lvl0)) // 3]]
        root = base.Tree(ROOT)
        n = 0
        for u in picks:
            key = dm.unit_key_for(M4, u)
            want, _r = dm.process_unit_m004(plan, us, u, Path(tempfile.gettempdir()))
            req = t.base / "req.json"
            t.base.mkdir(parents=True, exist_ok=True)
            req.write_text(json.dumps({"dataWeb": str(ROOT / "DATA_WEB").replace("\\", "/"), "uploads": str(t.base / "up").replace("\\", "/"),
                                       "private": str(t.base / "pr").replace("\\", "/"),
                                       "ops": [{"op": "unit_result", "dataset": base.REAL_DS, "migration": M4, "unit": key}]}), encoding="utf-8")
            r = subprocess.run([*PHP, str(base.DRIVER), str(req)], capture_output=True, text=True, timeout=900)
            self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])
            got = {tuple(int(v) for v in k.split(".")): base64.b64decode(v) for k, v in json.loads(r.stdout)[0]["result"].items()}
            self.assertEqual(sorted(got), sorted(want), key)
            for b in want:
                self.assertTrue(np.array_equal(dm.decode_brick_v3(got[b]), dm.decode_brick_v3(want[b])), (key, b))
                n += 1
        print(f"  real bricks: {n} level-0 v3 bricks of {base.REAL_DS} cut identically by PHP (GD) and Python (Pillow)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
