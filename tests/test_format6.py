"""Format 6 (SPEC Part IV, §15): two columns, `ll` and `q30`; migration m006-q30 (5 → 6).

* format5.py: the formats' columns, a q30 brick never heavier than its ll image, 0xFE refused,
  write_tree(fmt=6) a valid v6 tree;
* m006 by the server executor on a 3d and a live dataset (formats 1 → 6 through every
  migration): a valid v6 tree, version 6, no format-5 column file left, the ll packs, the
  cut stores and planes/ byte for byte those of the format-5 tree, every q30 brick within
  the codec's reach of its ll voxels;
* m006 through the browser protocol (unit_inputs + read_ranges + unit_put): the same tree as
  the server executor (same encoder), a wrong brick set refused;
* a finalize interrupted after the commit point (v6 manifest written, format-5 columns not yet
  deleted) completes on the next call.

Run: python tests/test_format6.py
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

try:
    import numpy as np
    import dataset_migrations as dm
    import format5 as f5
    from test_v3_py_migrations import make_3d, make_live, run_job
    from test_format5_browser_protocol import read_all, tree_files
except Exception as exc:  # pragma: no cover
    print(f"SKIP: numpy/Pillow/dataset_migrations unavailable ({exc})")
    sys.exit(0)

M6 = "m006-q30"
CHAIN = ("m002-planes", "m003-layer-mips", "m004-bricks-v3", "m005-matrix")


def files_under(d: Path, pred=lambda rel: True) -> dict:
    out = {}
    for root, _dirs, names in os.walk(d):
        for n in names:
            p = Path(root) / n
            rel = p.relative_to(d).as_posix()
            if pred(rel):
                out[rel] = p.read_bytes()
    return out


def kept_v5(rel: str) -> bool:
    """A file format 6 keeps untouched: ll packs and index, xy/xz/yz, cuts."""
    parts = rel.split("/")
    if parts and parts[0].startswith("t") and parts[0][1:].isdigit():
        parts = parts[1:]
    if parts == ["index", "ll.bin"]:
        return True
    if len(parts) > 1 and parts[0].startswith("l") and parts[0][1:].isdigit():
        return parts[1] == "ll"
    return parts[0] in ("xy", "xz", "yz", "cuts")


class Engine(unittest.TestCase):
    def test_columns(self):
        self.assertEqual(f5.columns_of(6), ("ll", "q30"))
        self.assertEqual(f5.columns_of(5), ("ll", "b2", "b4", "q80", "q50"))
        self.assertEqual(f5.schema_format("iribhm-bricks-v6"), 6)
        self.assertIsNone(f5.schema_format("iribhm-bricks-v3"))
        self.assertEqual([c["id"] for c in f5.manifest_columns(6)], ["ll", "q30"])

    def test_q30_brick(self):
        rng = np.random.default_rng(5)
        dense = rng.integers(0, 256, (66, 66, 66), dtype=np.uint8)
        sparse = np.zeros((66, 66, 66), np.uint8)
        sparse[30, 30, 30] = 200
        for b in (dense, sparse):
            ll = f5.encode_brick(b, "ll")
            q = f5.encode_brick(b, "q30", known={"ll": ll})
            self.assertLessEqual(len(q), len(ll) + 1)
            self.assertIn(q[-1], set(range(13)) | {0xFF})
            dec = f5.decode_brick(q, "q30")
            self.assertEqual(dec.shape, b.shape)
        # The sparse brick falls back to its exact image.
        self.assertEqual(q[-1], 0xFF)
        self.assertTrue(np.array_equal(f5.decode_brick(q, "q30"), sparse))
        with self.assertRaises(ValueError):
            f5.decode_brick(f5.encode_brick(sparse, "b4") + bytes([0xFE]), "q30")


class Pipeline(unittest.TestCase):
    """write_tree(fmt=6): the format-5 tree's ll column and stores, and q30 = m006 of its ll."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-f6p-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_write_tree_fmt6(self):
        from test_format5 import write_raw
        rng = np.random.default_rng(13)
        X, Y, Z = 300, 270, 40
        vols = []
        for c in range(2):
            v = rng.integers(0, 256, (Z, Y, X), dtype=np.uint8)
            v[:, :60] = 0
            v[:, :, 200:] //= 9
            vols.append(v)
        paths = write_raw(self.tmp, vols)
        trees = {}
        for fmt in (5, 6):
            tdir = self.tmp / f"f{fmt}" / "bricks"
            tree = f5.write_tree(paths, (X, Y, Z), (0.5, 0.5, 2.0), tdir, self.tmp / "work", lambda fn, ts: map(fn, ts), fmt=fmt)
            doc = f5.manifest_v5(tree["levels"], 2, {"": tree}, [], "now", fmt=fmt)
            f5.atomic_write(tdir / "manifest.json", f5.manifest_bytes(doc))
            self.assertIsNone(f5.bricks_problem(self.tmp / f"f{fmt}", fmt))
            self.assertIsNotNone(f5.bricks_problem(self.tmp / f"f{fmt}", 11 - fmt), "the other format refuses it")
            trees[fmt] = (tdir, doc)
        (d5, m5), (d6, m6) = trees[5], trees[6]
        self.assertEqual(m6["schema"], "iribhm-bricks-v6")
        self.assertEqual([c["id"] for c in m6["columns"]], ["ll", "q30"])
        a = files_under(d5, kept_v5)
        b = files_under(d6, kept_v5)
        self.assertEqual(sorted(a), sorted(b))
        for rel in a:
            self.assertEqual(a[rel], b[rel], rel)
        for k in m6["bytes"]:
            self.assertEqual(m6["bytes"][k]["ll"], m5["bytes"][k]["ll"])
        idx_ll = f5.parse_index_bin((d6 / f5.index_rel("ll")).read_bytes())
        idx_q = f5.parse_index_bin((d6 / f5.index_rel("q30")).read_bytes())
        for k in range(len(m6["levels"])):
            for c in range(2):
                el, eq = idx_ll["entries"][k][c], idx_q["entries"][k][c]
                self.assertTrue(np.array_equal(el["length"] > 0, eq["length"] > 0))
                for i in np.nonzero(el["length"])[0][:5]:
                    def rd(cid, e):
                        with open(d6 / f5.brick_pack_rel(k, cid, c, int(e["pack"][i])), "rb") as fh:
                            fh.seek(int(e["offset"][i]))
                            return fh.read(int(e["length"][i]))
                    raw = rd("ll", el)
                    self.assertEqual(rd("q30", eq), f5.encode_brick(f5.decode_brick(raw, "ll"), "q30", known={"ll": raw}))


class Migration(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-f6-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        dm.configure(ROOT)

    def _site(self, name, live=False):
        root = self.tmp / name
        for t in ("3d", "2d", "live"):
            (root / "DATA_WEB" / t).mkdir(parents=True)
        dm.configure(root)
        if live:
            make_live(root / "DATA_WEB", X=150, Y=140, Z=40, T=2)
            ds = "live/LIVE3"
        else:
            make_3d(root / "DATA_WEB", X=300, Y=270, Z=66, C=2, voxel=(0.5, 0.5, 1.6))
            ds = "3d/SYN3"
        for mid in CHAIN:
            run_job(self, ds, mid)
        return root, ds

    def _check_v6(self, root, ds, before):
        d = root / "DATA_WEB" / ds
        self.assertIsNone(f5.bricks_problem(d, 6))
        meta = json.loads((d / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["formatVersion"], 6)
        after = files_under(d / "bricks")
        for rel in after:
            parts = rel.split("/")
            self.assertFalse(any(p in ("b2", "b4", "q80", "q50", "b2.bin", "b4.bin", "q80.bin", "q50.bin") for p in parts), rel)
        for rel, data in before.items():
            self.assertEqual(after.get(rel), data, rel)
        man = json.loads(after["manifest.json"])
        self.assertEqual(man["schema"], "iribhm-bricks-v6")
        self.assertEqual([c["id"] for c in man["columns"]], ["ll", "q30"])
        for kk, per in man["bytes"].items():
            self.assertEqual(set(per), {"ll", "q30"})
            self.assertLessEqual(sum(per["q30"]), sum(per["ll"]) + 1000)
        # Every q30 brick decodes near its ll voxels.
        for rel in f5.tree_rels(man):
            base = d / "bricks" / rel if rel else d / "bricks"
            idx = {c: f5.parse_index_bin((base / f5.index_rel(c)).read_bytes()) for c in ("ll", "q30")}
            for k in range(len(man["levels"])):
                for c in range(man["channels"]):
                    el, eq = idx["ll"]["entries"][k][c], idx["q30"]["entries"][k][c]
                    self.assertTrue(np.array_equal(el["length"] > 0, eq["length"] > 0))
                    for i in np.nonzero(el["length"])[0][:6]:
                        def rd(cid, e):
                            with open(base / f5.brick_pack_rel(k, cid, c, int(e["pack"][i])), "rb") as fh:
                                fh.seek(int(e["offset"][i]))
                                return fh.read(int(e["length"][i]))
                        a = f5.decode_brick(rd("ll", el), "ll").astype(int)
                        b = f5.decode_brick(rd("q30", eq), "q30").astype(int)
                        self.assertLess(np.abs(a - b).mean(), 12.0)
        st = dm.dataset_status(*ds.split("/"), d)
        self.assertEqual((st["formatVersion"], st["bricksSchema"], st["pending"], st.get("problem")),
                         (6, "iribhm-bricks-v6", [], None))

    def test_server_3d_and_live(self):
        for live in (False, True):
            with self.subTest(live=live):
                root, ds = self._site("live" if live else "srv", live)
                before = files_under(root / "DATA_WEB" / ds / "bricks", kept_v5)
                planes = files_under(root / "DATA_WEB" / ds / "planes", lambda r: not r.endswith("manifest.json"))
                st = dm.dataset_status(*ds.split("/"), root / "DATA_WEB" / ds)
                self.assertEqual(st["pending"], [M6])
                run_job(self, ds, M6)
                self._check_v6(root, ds, before)
                self.assertEqual(files_under(root / "DATA_WEB" / ds / "planes", lambda r: not r.endswith("manifest.json")), planes)
                pdir = root / "DATA_WEB" / ds / "planes" / ("t000" if live else "")
                pm = json.loads((pdir / "manifest.json").read_text(encoding="utf-8"))
                self.assertEqual(pm["source"]["manifestSha256"],
                                 dm._manifest_sha(root / "DATA_WEB" / ds / "bricks" / "manifest.json"))

    def test_browser_protocol_equals_server(self):
        roots = {}
        for name in ("server", "browser"):
            roots[name] = self._site(name)
        root_s, ds = roots["server"]
        dm.configure(root_s)
        run_job(self, ds, M6)
        root_b, _ = roots["browser"]
        dm.configure(root_b)
        plan = dm.plan_job(ds, M6)
        keys = plan["units"]
        self.assertEqual(plan["runnable"], plan["pending"], "every m006 unit is runnable at once")
        wrong = None
        for key in keys:
            inp = dm.unit_inputs(ds, M6, key)
            self.assertFalse(inp["empty"])
            data = read_all(ds, [(r["rel"], r["start"], r["end"]) for r in inp["bricks"]])
            bricks = {(r["bz"], r["by"], r["bx"]): {"q30": f5.encode_brick(f5.decode_brick(raw, "ll"), "q30", known={"ll": raw})}
                      for r, raw in zip(inp["bricks"], data)}
            body = dm._m005_brick_blob(bricks, ("q30",))
            if wrong is None and len(bricks) > 1:
                wrong = key
                drop = dict(list(bricks.items())[1:])
                with self.assertRaises(dm.MigrationError) as cm:
                    dm.unit_put(ds, M6, key, dm._m005_brick_blob(drop, ("q30",)))
                self.assertEqual(cm.exception.code, "bad_blob")
            if key == keys[-1]:
                # The last unit in two pieces (unit_put_part), as a host with a small post_max_size takes it.
                half = len(body) // 2
                r1 = dm.unit_put_part(ds, M6, key, 0, len(body), body[:half])
                self.assertEqual((r1["complete"], r1["received"]), (False, half))
                self.assertTrue(dm.unit_put_part(ds, M6, key, half, len(body), body[half:])["complete"])
            else:
                dm.unit_put(ds, M6, key, body)
        while not dm.finalize(ds, M6, 30).get("complete"):
            pass
        a = tree_files(root_s / "DATA_WEB" / ds / "bricks")
        b = tree_files(root_b / "DATA_WEB" / ds / "bricks")
        ma, mb = json.loads(a.pop("manifest.json")), json.loads(b.pop("manifest.json"))
        self.assertEqual(sorted(a), sorted(b))
        for name in a:
            self.assertEqual(a[name], b[name], name)
        for key in ("levels", "columns", "stores", "index", "bytes", "histograms"):
            self.assertEqual(ma[key], mb[key], key)
        self.assertEqual(mb["producer"], "migration-browser")

    def test_finalize_resumes_after_commit(self):
        root, ds = self._site("resume")
        before = files_under(root / "DATA_WEB" / ds / "bricks", kept_v5)
        dm.plan_job(ds, M6)
        while dm.unit_run(ds, M6, max_seconds=20)["done"] < dm.plan_job(ds, M6)["total"]:
            pass
        real = dm._m006_drop_v5_columns
        calls = {"n": 0}

        def boom(*a, **k):
            calls["n"] += 1
            raise OSError("interrupted after the commit point")

        dm._m006_drop_v5_columns = boom
        try:
            with self.assertRaises(OSError):
                while not dm.finalize(ds, M6, 30).get("complete"):
                    pass
        finally:
            dm._m006_drop_v5_columns = real
        d = root / "DATA_WEB" / ds
        self.assertEqual(json.loads((d / "bricks" / "manifest.json").read_text())["schema"], "iribhm-bricks-v6")
        self.assertTrue((d / "bricks" / "index" / "b2.bin").is_file(), "the format-5 columns are still there")
        st = dm.dataset_status(*ds.split("/"), d)
        self.assertIsNone(st.get("problem"))
        while not dm.finalize(ds, M6, 30).get("complete"):
            pass
        self._check_v6(root, ds, before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
