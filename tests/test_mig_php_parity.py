"""Dataset migrations — PHP ↔ Python parity (SPEC §4, §5, §10).

The same synthetic published datasets (bricks encoded by Pillow exactly like
preprocess/3-chunk_packer.py, so the PHP side decodes WebP it did not write) go through
api/_migrations_lib.php (driven by tests/mig_php_driver.php) and dataset_migrations.py:

* the two plans and journals have the same structure and the same values (timestamps aside);
* each backend's planes/ tree decodes, tile for tile, to the source voxels; the two trees
  hold the same files, the same manifests (producer / createdAt aside) and the same set
  of zero-length entries;
* a job resumes across backends both ways (half the units by one, the rest + finalize by
  the other), and the result is exact;
* the same tile store finalized by each backend gives byte-identical plane packs;
* on real local bricks (read-only), the PHP and Python server executors cut identical pixels.

Run: python tests/test_mig_php_parity.py   (needs php with GD/WebP, numpy, Pillow)
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

try:
    import numpy as np
    from PIL import Image
    import dataset_migrations as dm
except Exception as exc:  # pragma: no cover
    print(f"SKIP: numpy/Pillow/dataset_migrations unavailable ({exc})")
    sys.exit(0)

MID = "m002-planes"
DRIVER = ROOT / "tests" / "mig_php_driver.php"
REAL_DS = "3d/Egfl7eGFP-E825-Em2-10122024-DAPI-Pecam1647-10x-07xzoom-2x2Tiles-stack_Stitch"


def find_php():
    for cand in ("php", r"C:\php-portable\php.exe"):
        exe = shutil.which(cand) or (cand if os.path.isfile(cand) else None)
        if not exe:
            continue
        probe = "echo (extension_loaded('gd') && function_exists('imagecreatefromwebp')) ? 1 : 0;"
        for extra in ([], ["-d", "extension_dir=" + str(Path(exe).parent / "ext"), "-d", "extension=gd"]):
            try:
                r = subprocess.run([exe, *extra, "-r", probe], capture_output=True, text=True, timeout=30)
            except Exception:
                continue
            if r.stdout.strip().endswith("1"):
                return [exe, *extra]
    return None


PHP = find_php()


# ── Synthetic datasets (the pipeline's own encoding) ───────────────────────────

def make_volume(seed, X, Y, Z):
    rng = np.random.default_rng(seed)
    vol = rng.integers(0, 256, size=(Z, Y, X), dtype=np.uint8)
    vol[:, : Y // 6, :] = 0                       # flat zero band
    vol[:, :, X - 40:] //= 9                      # dim region
    return vol


def dropped(t, c, bx, by, bz):
    if c == 1 and bx >= 8 and bz == 0:
        return True                               # a whole empty unit
    return (bx * 3 + by * 5 + bz * 7 + c + t) % 11 == 0


def build_dataset(data_web, typ, folder, vols):
    """vols: {t: [vol_c0, vol_c1, …]} (each (Z, Y, X) uint8). Returns the source voxels
    with the ESS-dropped bricks zeroed, as the planes must show them."""
    ds = Path(data_web) / typ / folder
    (ds / "bricks").mkdir(parents=True)
    rows, truth = {}, {}
    root_transport = root_levels = None
    for t, chans in vols.items():
        rel = f"t{t:03d}" if typ == "live" else ""
        tree = ds / "bricks" / rel if rel else ds / "bricks"
        Z, Y, X = chans[0].shape
        nx, ny, nz = -(-X // 64), -(-Y // 64), -(-Z // 64)
        b2p = {}
        truth[t] = []
        for c, vol in enumerate(chans):
            vol = vol.copy()
            (tree / "lod0" / f"c{c}").mkdir(parents=True)
            url = f"lod0/c{c}/pack_00.bin"
            off = 0
            with open(tree / url, "wb") as fh:
                for bz in range(nz):
                    for by in range(ny):
                        for bx in range(nx):
                            sl = (slice(bz * 64, bz * 64 + 64), slice(by * 64, by * 64 + 64), slice(bx * 64, bx * 64 + 64))
                            if dropped(t, c, bx, by, bz):
                                vol[sl] = 0
                                continue
                            padded = np.zeros((64, 64, 64), np.uint8)
                            chunk = vol[sl]
                            padded[: chunk.shape[0], : chunk.shape[1], : chunk.shape[2]] = chunk
                            mosaic = np.zeros((512, 512), np.uint8)
                            for z in range(64):
                                mosaic[(z // 8) * 64:(z // 8) * 64 + 64, (z % 8) * 64:(z % 8) * 64 + 64] = padded[z]
                            buf = io.BytesIO()
                            Image.fromarray(mosaic).save(buf, format="WEBP", lossless=True)
                            data = buf.getvalue()
                            fh.write(data)
                            b2p[f"lod0/c{c}/x{bx:03d}_y{by:03d}_z{bz:03d}.webp"] = {"url": url, "offset": off, "length": len(data)}
                            off += len(data)
            truth[t].append(vol)
        levels = [{"level": 0, "scale": 1.0, "dimensions": {"x": X, "y": Y, "z": Z}, "brickSize": 64,
                   "gridSize": {"x": nx, "y": ny, "z": nz}, "chunks": []}]
        transport = {"mode": "packs", "encoding": "webp-lossless", "packSize": 128, "brickToPack": b2p}
        if root_transport is None:
            root_transport, root_levels = transport, levels
        if rel:
            rows[rel] = {"path": rel, "channels": len(chans), "levels": levels, "brickTransport": transport}
    first = vols[min(vols)]
    man = {"version": 2, "schema": "iribhm-bricks-v2", "dataset": folder, "datasetType": typ,
           "channels": len(first), "brickSize": 64, "brickPacking": {"mode": "grid", "cols": 8, "rows": 8},
           "levels": root_levels, "timepoints": rows or None, "brickTransport": root_transport}
    (ds / "bricks" / "manifest.json").write_text(json.dumps(man), encoding="utf-8")
    Z, Y, X = first[0].shape
    meta = {"id": f"{typ}/{folder}", "type": typ, "name": folder, "curated": "keep",
            "dimensions": {"x": X, "y": Y, "z": Z, "c": len(first)},
            "channels": [{"name": f"c{c}"} for c in range(len(first))]}
    (ds / "metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return truth


class Tree:
    """One deployment root: DATA_WEB + uploads + private, usable by both backends."""

    def __init__(self, base: Path):
        self.base = base
        self.data_web = base / "DATA_WEB"
        self.uploads = base / "uploads"
        self.private = base / "private"

    def py(self):
        dm.configure(self.base, data_web=self.data_web, uploads_dir=self.uploads)
        return dm

    def php(self, ops, zero_floor=False):
        req = self.base / "req.json"
        req.write_text(json.dumps({"dataWeb": str(self.data_web).replace("\\", "/"),
                                   "uploads": str(self.uploads).replace("\\", "/"),
                                   "private": str(self.private).replace("\\", "/"),
                                   "zeroBudgetFloor": zero_floor, "ops": ops}), encoding="utf-8")
        r = subprocess.run([*PHP, str(DRIVER), str(req)], capture_output=True, text=True, timeout=900)
        if r.returncode != 0:
            raise AssertionError(f"php driver failed: {r.stdout[-2000:]} {r.stderr[-2000:]}")
        return json.loads(r.stdout)

    def php_handle(self, action, body=None, params=None, raw=None):
        op = {"op": "handle", "action": action, "body": body or {}, "params": params or {}}
        if raw is not None:
            p = self.base / "blob.bin"
            p.write_bytes(raw)
            op["rawFile"] = str(p)
        return self.php([op])[0]


def blob_of(tiles):
    out = bytearray(struct.pack("<I", len(tiles)))
    for z in sorted(tiles):
        out += struct.pack("<II", z, len(tiles[z])) + tiles[z]
    return bytes(out)


def read_planes(planes_dir: Path):
    """{relative pack path: (z, C, TX, TY, [(length==0) …], [pixels bytes or None …])} + manifests."""
    packs, manifests = {}, {}
    for p in sorted(planes_dir.rglob("*")):
        rel = p.relative_to(planes_dir).as_posix()
        if p.name == "manifest.json":
            manifests[rel] = json.loads(p.read_text(encoding="utf-8"))
        elif p.suffix == ".bin":
            data = p.read_bytes()
            z, c, tx, ty, entries = dm.parse_plane_pack(data)
            pix = [dm.decode_png_gray8(data[o:o + n])[2] if n else None for o, n in entries]
            packs[rel] = (z, c, tx, ty, pix, data)
    return packs, manifests


def check_against_truth(tc, planes_dir: Path, truth, typ):
    packs, manifests = read_planes(planes_dir)
    n = 0
    for t, chans in truth.items():
        prefix = f"t{t:03d}/" if typ == "live" else ""
        Z, Y, X = chans[0].shape
        TX, TY = -(-X // 512), -(-Y // 512)
        tc.assertIn(prefix + "manifest.json", manifests)
        for z in range(Z):
            zz, C, tx_, ty_, pix, _ = packs[f"{prefix}z{z:05d}.bin"]
            tc.assertEqual((zz, C, tx_, ty_), (z, len(chans), TX, TY))
            i = 0
            for c in range(C):
                for ty in range(TY):
                    for tx in range(TX):
                        ref = chans[c][z, ty * 512:(ty + 1) * 512, tx * 512:(tx + 1) * 512]
                        if pix[i] is None:
                            tc.assertFalse(ref.any(), f"t{t} z{z} c{c} y{ty} x{tx}: zero entry over data")
                        else:
                            tc.assertEqual(pix[i], ref.tobytes(), f"t{t} z{z} c{c} y{ty} x{tx}: pixels")
                        i += 1
                        n += 1
    return n


def strip_times(d):
    return {k: v for k, v in d.items() if k not in ("createdAt", "updatedAt", "assembledAt")}


@unittest.skipIf(PHP is None, "php with GD/WebP not found")
class Parity(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="lumen-mig-parity-"))
        cls.src = Tree(cls.tmp / "src")
        cls.truth3d = build_dataset(cls.src.data_web, "3d", "synA",
                                    {0: [make_volume(1, 600, 530, 70), make_volume(2, 600, 530, 70)]})
        cls.truthLive = build_dataset(cls.src.data_web, "live", "synL",
                                      {0: [make_volume(3, 200, 100, 40)], 1: [make_volume(4, 200, 100, 40)]})

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)
        dm.configure(ROOT)

    def clone(self, name) -> Tree:
        dst = self.tmp / name
        shutil.copytree(self.src.base, dst)
        return Tree(dst)

    def run_python(self, tree: Tree, ds):
        m = tree.py()
        m.plan_job(ds, MID)
        while True:
            r = m.unit_run(ds, MID, 20)
            if r["done"] >= r["total"]:
                break
        while not m.finalize(ds, MID).get("complete", False):
            pass

    def run_php(self, tree: Tree, ds):
        st, r = tree.php_handle("plan", {"dataset": ds, "migration": MID})
        self.assertEqual(st, 200, r)
        while True:
            st, r = tree.php_handle("unit_run", {"dataset": ds, "migration": MID, "maxSeconds": 20})
            self.assertEqual(st, 200, r)
            if r["done"] >= r["total"]:
                break
        while True:
            st, r = tree.php_handle("finalize", {"dataset": ds, "migration": MID})
            self.assertEqual(st, 200, r)
            if r.get("complete", True):
                break

    # ── 1. plan / journal / status structure ──────────────────────────────────
    def test_plan_and_journal_parity(self):
        a, b = self.clone("planA"), self.clone("planB")
        for ds, typ, folder in (("3d/synA", "3d", "synA"), ("live/synL", "live", "synL")):
            pa = {"ok": True, **a.py().plan_job(ds, MID)}
            st, pb = b.php_handle("plan", {"dataset": ds, "migration": MID})
            self.assertEqual(st, 200, pb)
            self.assertEqual(strip_times(pa), strip_times(pb), ds)
            ja = json.loads(a.py().journal_path(typ, folder, MID).read_text(encoding="utf-8"))
            jb = json.loads((b.uploads / "migrations" / f"{typ}__{folder}__{MID}.json").read_text(encoding="utf-8"))
            self.assertEqual(sorted(ja), sorted(jb))
            self.assertEqual(strip_times(ja), strip_times(jb), ds)
        sa = a.py().status()
        st, sb = b.php_handle("status")
        self.assertEqual(st, 200)
        self.assertEqual(sa["migrations"], sb["migrations"], "registries differ")
        rows_a = {r["id"]: strip_times(r) for r in sa["datasets"]}
        rows_b = {r["id"]: strip_times(r) for r in sb["datasets"]}
        for row in list(rows_a.values()) + list(rows_b.values()):
            if row.get("job"):
                row["job"] = strip_times(row["job"])
        self.assertEqual(rows_a, rows_b)
        self.assertEqual(sorted(sa["server"]), sorted(sb["server"]), "server capability keys differ")

    # ── 2. full migration by each backend ─────────────────────────────────────
    def test_full_migration_each_backend(self):
        a, b = self.clone("fullA"), self.clone("fullB")
        for ds, typ, truth in (("3d/synA", "3d", self.truth3d), ("live/synL", "live", self.truthLive)):
            self.run_python(a, ds)
            self.run_php(b, ds)
            pa = a.data_web / ds / "planes"
            pb = b.data_web / ds / "planes"
            n = check_against_truth(self, pa, truth, typ)
            check_against_truth(self, pb, truth, typ)
            packs_a, man_a = read_planes(pa)
            packs_b, man_b = read_planes(pb)
            self.assertEqual(sorted(packs_a), sorted(packs_b))
            for rel in packs_a:
                self.assertEqual(packs_a[rel][4], packs_b[rel][4], f"{ds} {rel}: decoded pixels")
                self.assertEqual([p is None for p in packs_a[rel][4]], [p is None for p in packs_b[rel][4]])
            for rel in man_a:
                drop = lambda d: {k: v for k, v in d.items() if k not in ("createdAt", "producer")}
                self.assertEqual(drop(man_a[rel]), drop(man_b[rel]))
                self.assertEqual(list(man_a[rel]), list(man_b[rel]), "manifest key order")
                self.assertEqual(man_b[rel]["producer"], "migration-server")
            for tree in (a, b):
                meta = json.loads((tree.data_web / ds / "metadata.json").read_text(encoding="utf-8"))
                self.assertEqual((meta["formatVersion"], meta["curated"]), (2, "keep"))
            print(f"  {ds}: {n} tiles exact under both backends", flush=True)

    # ── 3. cross-backend resume, both directions ──────────────────────────────
    def test_resume_python_then_php(self):
        tree = self.clone("resPyPhp")
        m = tree.py()
        units = m.plan_job("3d/synA", MID)["units"]
        plan = m._plan_for("3d/synA")
        for key in units[: len(units) // 2]:
            tiles, _ = m.process_unit(plan, m.parse_unit_key(key))
            m.unit_put("3d/synA", MID, key, blob_of(tiles))
        st, r = tree.php_handle("plan", {"dataset": "3d/synA", "migration": MID})
        self.assertEqual((st, r["done"]), (200, r["empty"] + len(units) // 2), r)
        while True:
            st, r = tree.php_handle("unit_run", {"dataset": "3d/synA", "migration": MID})
            self.assertEqual(st, 200, r)
            if r["done"] >= r["total"]:
                break
        st, r = tree.php_handle("finalize", {"dataset": "3d/synA", "migration": MID, "maxSeconds": 20})
        self.assertTrue(st == 200 and r["complete"], r)
        check_against_truth(self, tree.data_web / "3d/synA/planes", self.truth3d, "3d")
        man = json.loads((tree.data_web / "3d/synA/planes/manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(man["producer"], "mixed")

    def test_resume_php_then_python(self):
        tree = self.clone("resPhpPy")
        st, plan = tree.php_handle("plan", {"dataset": "live/synL", "migration": MID})
        self.assertEqual(st, 200, plan)
        ops = [{"op": "unit_tiles", "dataset": "live/synL", "unit": k} for k in plan["units"][: len(plan["units"]) // 2]]
        for key, res in zip([o["unit"] for o in ops], tree.php(ops)):
            tiles = {int(z): base64.b64decode(p) for z, p in res["tiles"].items()}
            st, r = tree.php_handle("unit_put", params={"dataset": "live/synL", "migration": MID, "unit": key}, raw=blob_of(tiles))
            self.assertEqual(st, 200, r)
        m = tree.py()
        while True:
            r = m.unit_run("live/synL", MID, 20)
            if r["done"] >= r["total"]:
                break
        # Python starts the assembly under a tiny budget, PHP finishes it: the resumable
        # finalize also crosses backends.
        first = m.finalize("live/synL", MID, 0.000001)
        st, r = tree.php_handle("finalize", {"dataset": "live/synL", "migration": MID, "maxSeconds": 20})
        self.assertTrue(st == 200 and r.get("complete"), (first, r))
        check_against_truth(self, tree.data_web / "live/synL/planes", self.truthLive, "live")

    # ── 4. same tile store → byte-identical packs ─────────────────────────────
    def test_same_store_identical_packs(self):
        base = self.clone("store")
        m = base.py()
        m.plan_job("3d/synA", MID)
        while m.unit_run("3d/synA", MID, 20)["done"] < m.plan_job("3d/synA", MID)["total"]:
            pass
        a = Tree(self.tmp / "storeA"); shutil.copytree(base.base, a.base)
        b = Tree(self.tmp / "storeB"); shutil.copytree(base.base, b.base)
        self.assertTrue(a.py().finalize("3d/synA", MID)["complete"])
        st, r = b.php_handle("finalize", {"dataset": "3d/synA", "migration": MID})
        self.assertTrue(st == 200 and r["complete"], r)
        pa, ma = read_planes(a.data_web / "3d/synA/planes")
        pb, mb = read_planes(b.data_web / "3d/synA/planes")
        self.assertEqual(sorted(pa), sorted(pb))
        for rel in pa:
            self.assertEqual(pa[rel][5], pb[rel][5], f"{rel}: pack bytes differ")
        for rel in ma:
            self.assertEqual({k: v for k, v in ma[rel].items() if k != "createdAt"},
                             {k: v for k, v in mb[rel].items() if k != "createdAt"})

    # ── 5. real bricks, read-only ─────────────────────────────────────────────
    def test_real_bricks_same_pixels(self):
        if not (ROOT / "DATA_WEB" / REAL_DS / "bricks" / "manifest.json").is_file():
            print("  (real-dataset parity not run: DATA_WEB holds no local dataset - CI)")
            return
        scratch = self.tmp / "real"
        scratch.mkdir(exist_ok=True)
        real = Tree(scratch)
        real.data_web = ROOT / "DATA_WEB"          # read-only: only plans and unit cuts run
        m = real.py()
        plan = m._plan_for(REAL_DS)
        units = plan.units
        picks = [units[(k * len(units)) // 4] for k in range(4)]
        res = real.php([{"op": "unit_tiles", "dataset": REAL_DS, "unit": m.unit_key(*u)} for u in picks])
        for u, r in zip(picks, res):
            py_tiles, _ = m.process_unit(plan, u)
            php_tiles = {int(z): base64.b64decode(p) for z, p in r["tiles"].items()}
            self.assertEqual(sorted(py_tiles), sorted(php_tiles), m.unit_key(*u))
            for z in py_tiles:
                self.assertEqual(dm.decode_png_gray8(py_tiles[z]), dm.decode_png_gray8(php_tiles[z]), f"{m.unit_key(*u)} z{z}")
        print(f"  real bricks: {len(picks)} units of {REAL_DS} cut identically by PHP (GD) and Python (Pillow)", flush=True)


if __name__ == "__main__":
    if PHP is None:
        print("SKIP: php with the gd extension (WebP) not found")
        sys.exit(0)
    unittest.main(verbosity=2)
