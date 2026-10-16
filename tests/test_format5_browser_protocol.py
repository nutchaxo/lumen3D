"""m005-matrix through the BROWSER protocol (SPEC §14.10), Python side.

A client that sees only what a browser sees — the `unit_inputs` answer (the byte runs of
the plane tiles, of the store's stage-A packs and of the format-4 bricks) and the bytes
`read_ranges` returns — computes each unit with format5.py and posts it through
`unit_put`. The tree finalize assembles from those uploads is byte-identical to the one the
server executor makes on a copy of the same dataset. `unit_put` refuses a malformed body,
a unit of a later level before its stage A, and an empty unit.

Run: python tests/test_format5_browser_protocol.py
"""
import io
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
from test_v3_py_migrations import make_3d, run_job  # noqa: E402

M5 = "m005-matrix"


def read_all(ds, runs):
    """read_ranges, as a browser calls it (batches of <= 1024 runs / 32 MiB)."""
    out = []
    i = 0
    while i < len(runs):
        batch, size = [], 0
        while i < len(runs) and len(batch) < 512 and size + (runs[i][2] - runs[i][1]) <= 16 * 1024 * 1024:
            batch.append(runs[i])
            size += runs[i][2] - runs[i][1]
            i += 1
        if not batch:
            batch = [runs[i]]
            i += 1
        body = dm.read_ranges(ds, [list(r) for r in batch])
        n = struct.unpack_from("<I", body, 0)[0]
        lens = struct.unpack_from("<%dI" % n, body, 4)
        pos = 4 + 4 * n
        for ln in lens:
            out.append(body[pos:pos + ln])
            pos += ln
    return out


def region_from_tiles(inp, tiles, data):
    box = inp["box"]
    (x0, x1), (y0, y1), (z0, z1) = box["x"], box["y"], box["z"]
    region = np.zeros((z1 - z0, y1 - y0, x1 - x0), dtype=np.uint8)
    for t, png in zip(tiles, data):
        img = f5.unpng_gray8(png)
        a0, a1 = max(y0, t["y0"]), min(y1, t["y0"] + t["h"])
        b0, b1 = max(x0, t["x0"]), min(x1, t["x0"] + t["w"])
        if a0 < a1 and b0 < b1:
            region[t["z"] - z0, a0 - y0:a1 - y0, b0 - x0:b1 - x0] = img[a0 - t["y0"]:a1 - t["y0"], b0 - t["x0"]:b1 - t["x0"]]
    return region


def client_unit(ds, key):
    """The body a browser would post for unit `key`, from its inputs alone."""
    inp = dm.unit_inputs(ds, M5, key)
    if inp["empty"]:
        return None
    tiles, bricks = inp["tiles"], inp["bricks"]
    data = read_all(ds, [(r["rel"], r["start"], r["end"]) for r in tiles + bricks])
    tdata, bdata = data[:len(tiles)], data[len(tiles):]
    lv = inp["levels"]
    k = inp["level"]
    L = lv[k]["dimensions"]
    X, Y, Z = L["x"], L["y"], L["z"]
    stage = inp["stage"]
    if stage == "A":
        plane = region_from_tiles(inp, tiles, tdata)[0]
        out = {}
        for row in lv[1:]:
            d = row["dimensions"]
            p = f5.resample_plane(plane, d["x"], d["y"])
            out[row["level"]] = (f5.plane_pack(inp["box"]["z"][0], 1, -(-d["x"] // 512), -(-d["y"] // 512), f5.plane_tiles(p))
                                 if p.any() else None)
        return dm.build_m005_put_body((0,), out)
    if stage == "B":
        cols = inp["columns"]
        enc = {}
        if k == 0:
            for r, raw in zip(bricks, bdata):
                b66 = dm.decode_brick_v3(raw)
                enc[(r["bz"], r["by"], r["bx"])] = f5.encode_brick_columns(b66, cols, known={"ll": raw})
        else:
            region = region_from_tiles(inp, tiles, tdata)
            o = (inp["box"]["x"][0], inp["box"]["y"][0], inp["box"]["z"][0])
            for bz, by, bx in inp["outBricks"]:
                b66 = f5.brick_with_apron(region, bx, by, bz, (X, Y, Z), o)
                if f5.brick_kept(b66):
                    enc[(bz, by, bx)] = f5.encode_brick_columns(b66, cols)
        return dm._m005_brick_blob(enc, cols) if enc else b""
    region = region_from_tiles(inp, tiles, tdata)
    if stage == "C":
        if inp["kind"] == "xz":
            images = [region[:, r, :] for r in range(inp["count"])]
        else:
            images = [region[:, :, r] for r in range(inp["count"])]
        return f5.orth_pack(inp["kind"], inp["first"], images)
    sz, sy, sx = inp["super"]
    o = (inp["box"]["x"][0], inp["box"]["y"][0], inp["box"]["z"][0])
    return f5.cut_record(region, o, (X, Y, Z), inp["brickZ"], sz, sy, sx) or b""


def tree_files(d: Path) -> dict:
    out = {}
    for root, _dirs, files in os.walk(d):
        for n in files:
            p = Path(root) / n
            out[p.relative_to(d).as_posix()] = p.read_bytes()
    return out


class BrowserProtocol(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-f5b-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _site(self, name):
        root = self.tmp / name
        for t in ("3d", "2d", "live"):
            (root / "DATA_WEB" / t).mkdir(parents=True)
        return root

    def test_browser_units_equal_server_units(self):
        roots = {}
        for name in ("server", "browser"):
            root = self._site(name)
            dm.configure(root)
            make_3d(root / "DATA_WEB", X=300, Y=270, Z=66, C=2, voxel=(0.5, 0.5, 1.6))
            for mid in ("m002-planes", "m003-layer-mips", "m004-bricks-v3"):
                run_job(self, "3d/SYN3", mid)
            roots[name] = root
        # Server executor.
        dm.configure(roots["server"])
        run_job(self, "3d/SYN3", M5)
        # Browser protocol.
        dm.configure(roots["browser"])
        ds = "3d/SYN3"
        dm.plan_job(ds, M5)
        # A level-1 unit before stage A is refused.
        later = next(k for k in (dm._m005_key(u) for u in dm._unitset(dm._plan_for(ds), M5).units) if not k.startswith("A") and ".k1." in k)
        with self.assertRaises(dm.MigrationError) as cm:
            dm.unit_put(ds, M5, later, b"")
        self.assertEqual(cm.exception.code, "unit_blocked")
        with self.assertRaises(dm.MigrationError) as cm:
            dm.unit_put(ds, M5, "A.t0.c0.z5", b"\x01\x00\x00\x00garbage")
        self.assertEqual(cm.exception.code, "bad_blob")
        for _ in range(20):
            out = dm.plan_job(ds, M5)
            keys = out["units"]
            if not keys:
                break
            for key in keys:
                dm.unit_put(ds, M5, key, client_unit(ds, key))
        st = dm.plan_job(ds, M5)
        self.assertEqual(st["done"], st["total"])
        while not dm.finalize(ds, M5, 30).get("complete"):
            pass
        a = tree_files(roots["server"] / "DATA_WEB" / "3d" / "SYN3" / "bricks")
        b = tree_files(roots["browser"] / "DATA_WEB" / "3d" / "SYN3" / "bricks")
        ma, mb = json.loads(a.pop("manifest.json")), json.loads(b.pop("manifest.json"))
        self.assertEqual(sorted(a), sorted(b))
        for name in a:
            self.assertEqual(a[name], b[name], name)
        for key in ("levels", "columns", "stores", "index", "bytes", "histograms"):
            self.assertEqual(ma[key], mb[key], key)
        self.assertEqual(mb["producer"], "migration-browser")
        self.assertIsNone(f5.bricks_problem(roots["browser"] / "DATA_WEB" / "3d" / "SYN3"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
