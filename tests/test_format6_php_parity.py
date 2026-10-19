"""Format 6 — PHP ↔ Python parity of migration m006-q30 (SPEC §15.4). A PHP host has no m006
executor: the browser encodes every unit (one 4×4×4 super-block of `ll` bricks) from what
`unit_inputs` names and posts it with `unit_put`. Here each unit's body is computed ONCE with
Python (the `ll` bricks decoded, `format5.encode_brick(…, "q30", known={"ll": raw})`) and the same
body goes to dataset_migrations.py and to api/_migrations_lib.php (driven by
tests/mig_php_driver.php) on two copies of the same format-5 datasets, a 3d one with two
channels and a live one with two timepoints:

* plans identical (totals, empties, the runnable keys in order, levels), every unit_inputs
  answer identical (and unit_inputs_many on PHP = the single answers);
* a body missing one brick of its super-block refused with bad_blob on both;
* the PHP side fed through unit_put_part (two pieces), unit_put_many and unit_put;
* PHP finalize resumable (zero time budget: one (t, k, c) pack step per call), the finalized
  trees byte for byte identical (manifest compared parsed, its timestamps aside), no format-5
  column left, version 6 on both, planes/ re-stamped with each side's own v6 manifest, status
  rows equal (iribhm-bricks-v6, nothing pending, no problem);
* the PHP capability row: m006 is browser only (unit_run refused); PHP LATEST is 6 and its
  registry equals Python's;
* a damaged v5 tree is a problem (bricks_v5_invalid), never a pending m006, on both;
* cancel removes the q30 files written before the commit point, keeps the format-5 columns.

Run: python tests/test_format6_php_parity.py   (php ≥ 8.1, numpy, Pillow)
"""
import hashlib
import json
import shutil
import struct
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

try:
    import numpy  # noqa: F401
    import dataset_migrations as dm
    import format5 as f5
    import test_mig_php_parity as base
    from test_v3_py_migrations import make_3d, make_live
    from test_format5_browser_protocol import tree_files
except Exception as exc:  # pragma: no cover
    print(f"SKIP: numpy/Pillow/dataset_migrations unavailable ({exc})")
    sys.exit(0)

PHP = base.PHP
M6 = "m006-q30"
CHAIN = ("m002-planes", "m003-layer-mips", "m004-bricks-v3", "m005-matrix")
DATASETS = ("3d/SYN3", "live/LIVE3")
TIMESTAMPS = ("createdAt", "updatedAt", "assembledAt", "migratedAt")


def jsonish(v):
    return json.loads(json.dumps(v))


def strip(d):
    if isinstance(d, dict):
        return {k: strip(v) for k, v in d.items() if k not in TIMESTAMPS}
    if isinstance(d, list):
        return [strip(v) for v in d]
    return d


def unit_body(ds_dir: Path, inp, drop_one=False) -> bytes:
    """The body a browser posts for one m006 unit, from its inputs alone."""
    bricks = {}
    for r in inp["bricks"]:
        with open(ds_dir / r["rel"], "rb") as fh:
            fh.seek(r["start"])
            raw = fh.read(r["end"] - r["start"])
        bricks[(r["bz"], r["by"], r["bx"])] = {"q30": f5.encode_brick(f5.decode_brick(raw, "ll"), "q30", known={"ll": raw})}
    if drop_one:
        bricks = dict(list(bricks.items())[1:])
    return dm._m005_brick_blob(bricks, ("q30",))


def put_many_body(items) -> bytes:
    out = bytearray(struct.pack("<I", len(items)))
    for key, body in items:
        k = key.encode("ascii")
        out += struct.pack("<H", len(k)) + k + struct.pack("<I", len(body)) + body
    return bytes(out)


@unittest.skipIf(PHP is None, "php not found")
class Format6Parity(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="lumen-f6-php-"))
        src = base.Tree(cls.tmp / "src")
        for t in ("3d", "2d", "live"):
            (src.data_web / t).mkdir(parents=True)
        src.py()
        make_3d(src.data_web, X=300, Y=270, Z=40, C=2, voxel=(0.5, 0.5, 1.6))
        make_live(src.data_web, X=280, Y=100, Z=20, T=2)
        for ds in DATASETS:
            for mid in CHAIN:
                dm.plan_job(ds, mid)
                while True:
                    r = dm.unit_run(ds, mid, 20)
                    if r["done"] >= r["total"]:
                        break
                while not dm.finalize(ds, mid).get("complete"):
                    pass
            assert json.loads((src.data_web / ds / "bricks" / "manifest.json").read_text())["schema"] == "iribhm-bricks-v5"
        cls.src = src

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)
        dm.configure(ROOT)

    def clone(self, name):
        dst = self.tmp / name
        shutil.copytree(self.src.base, dst)
        return base.Tree(dst)

    def php_ok(self, tree, action, body=None, params=None, raw=None):
        st, out = tree.php_handle(action, body, params, raw)
        self.assertEqual(st, 200, out)
        return out

    def test_registry_and_capabilities(self):
        caps = self.src.php([{"op": "caps"}])[0]
        self.assertEqual(caps["migrations"][M6], {"available": False, "reasons": ["browser_only"]})
        st, status = self.src.php_handle("status")
        self.assertEqual(st, 200)
        self.assertEqual(status["latest"], 6)
        self.assertEqual(dm.LATEST, 6)
        self.assertEqual(status["migrations"], jsonish(dm.MIGRATIONS))
        rows = {r["id"]: r for r in status["datasets"]}
        for ds in DATASETS:
            self.assertEqual((rows[ds]["formatVersion"], rows[ds]["bricksSchema"], rows[ds]["pending"]), (5, "iribhm-bricks-v5", [M6]))
        # No server executor on PHP: unit_run refused.
        st, out = self.src.php_handle("unit_run", {"dataset": DATASETS[0], "migration": M6})
        self.assertEqual((st, out.get("error")), (409, "server_unavailable"))

    def test_a_damaged_v5_tree_is_a_problem_not_a_pending_m006(self):
        tree = self.clone("damaged")
        ds = DATASETS[0]
        (tree.data_web / ds / "bricks" / "index" / "b2.bin").write_bytes(b"LBIX")
        st, status = tree.php_handle("status")
        row = next(r for r in status["datasets"] if r["id"] == ds)
        self.assertEqual((row["problem"], row["pending"]), ("bricks_v5_invalid", []), row)
        tree.py()
        prow = jsonish(dm.dataset_status(*ds.split("/"), tree.data_web / ds))
        self.assertEqual(strip({k: v for k, v in prow.items() if k != "name"}), strip({k: v for k, v in row.items() if k != "name"}))
        st, out = tree.php_handle("plan", {"dataset": ds, "migration": M6})
        self.assertEqual((st, out.get("error")), (409, "bricks_v5_invalid"))

    def test_cancel_drops_the_q30_files_written_before_the_commit(self):
        tree = self.clone("cancel")
        ds = DATASETS[0]
        self.php_ok(tree, "plan", {"dataset": ds, "migration": M6})
        bricks = tree.data_web / ds / "bricks"
        (bricks / "l0" / "q30" / "c0").mkdir(parents=True)
        (bricks / "l0" / "q30" / "c0" / "p00000.bin").write_bytes(b"x")
        (bricks / "index" / "q30.bin").write_bytes(b"x")
        self.php_ok(tree, "cancel", {"dataset": ds, "migration": M6})
        self.assertFalse((bricks / "l0" / "q30").exists())
        self.assertFalse((bricks / "index" / "q30.bin").exists())
        self.assertTrue((bricks / "index" / "b2.bin").is_file())

    def test_browser_units_assemble_identically(self):
        py, ph = self.clone("py"), self.clone("php")
        for ds in DATASETS:
            with self.subTest(dataset=ds):
                self._one(py, ph, ds)

    def _one(self, py, ph, ds):
        py.py()
        p_py = jsonish(dm.plan_job(ds, M6))
        p_ph = self.php_ok(ph, "plan", {"dataset": ds, "migration": M6})
        for k in ("total", "empty", "done", "pending", "runnable", "units", "levels", "state"):
            self.assertEqual(p_py[k], p_ph[k], k)
        keys = p_py["units"]
        self.assertTrue(keys and p_py["runnable"] == p_py["pending"] == len(keys))
        if ds.startswith("3d/"):
            self.assertGreater(p_py["empty"], 0, "the synthetic volume has empty super-blocks")
        # Inputs of every unit, single and batched.
        py.py()
        want = [jsonish(dm.unit_inputs(ds, M6, k)) for k in keys]
        got = ph.php([{"op": "handle", "action": "unit_inputs", "body": {"dataset": ds, "migration": M6, "unit": k}} for k in keys])
        for k, w, (st, g) in zip(keys, want, got):
            self.assertEqual(st, 200, g)
            self.assertEqual(w, g, k)
        many = self.php_ok(ph, "unit_inputs_many", {"dataset": ds, "migration": M6, "units": keys[:64] + ["t0.k0.c9.z0.y0.x0"]})
        self.assertEqual(many["items"][:-1], want[:64])
        self.assertEqual(many["items"][-1]["error"], "bad_unit")
        py.py()
        self.assertEqual(jsonish(dm.unit_inputs_many(ds, M6, keys[:64]))["items"], want[:64])
        # One body per unit, computed once.
        ds_dir = py.data_web / ds
        bodies = {k: unit_body(ds_dir, w) for k, w in zip(keys, want)}
        wrong = next(k for k, w in zip(keys, want) if len(w["bricks"]) > 1)
        bad = unit_body(ds_dir, want[keys.index(wrong)], drop_one=True)
        with self.assertRaises(dm.MigrationError) as cm:
            dm.unit_put(ds, M6, wrong, bad)
        self.assertEqual(cm.exception.code, "bad_blob")
        st, out = ph.php_handle("unit_put", params={"dataset": ds, "migration": M6, "unit": wrong, "dry": "0"}, raw=bad)
        self.assertEqual((st, out.get("error")), (400, "bad_blob"))
        st, out = ph.php_handle("unit_put", params={"dataset": ds, "migration": M6, "unit": wrong, "dry": "0"},
                                raw=bodies[wrong][:-1] + b"\xfe")
        self.assertEqual((st, out.get("error")), (400, "bad_blob"), "0xFE is a corrupt q30 brick")
        # Python: every unit through unit_put.
        for key in keys:
            dm.unit_put(ds, M6, key, bodies[key])
        self.assertEqual(dm.plan_job(ds, M6)["done"], p_py["total"])
        # PHP: the first unit in two pieces, the next ones in one batch, the rest one by one.
        first, batch, rest = keys[0], keys[1:4], keys[4:]
        b0 = bodies[first]
        half = len(b0) // 2
        out = self.php_ok(ph, "unit_put_part", params={"dataset": ds, "migration": M6, "unit": first, "offset": 0, "total": len(b0)},
                          raw=b0[:half])
        self.assertEqual(out, {"ok": True, "complete": False, "received": half})
        out = self.php_ok(ph, "unit_put_part", params={"dataset": ds, "migration": M6, "unit": first, "offset": half, "total": len(b0)},
                          raw=b0[half:])
        self.assertTrue(out["complete"] and out["ok"], out)
        if batch:
            out = self.php_ok(ph, "unit_put_many", params={"dataset": ds, "migration": M6},
                              raw=put_many_body([(k, bodies[k]) for k in batch] + [("t0.k0.c0.z99.y0.x0", b"")]))
            self.assertEqual([r["ok"] for r in out["results"]], [True] * len(batch) + [False])
            self.assertEqual(out["results"][-1]["error"], "empty_unit")
        ops = []
        for i, key in enumerate(rest):
            f = ph.base / f"blob{i}.bin"
            f.write_bytes(bodies[key])
            ops.append({"op": "handle", "action": "unit_put", "rawFile": str(f),
                        "params": {"dataset": ds, "migration": M6, "unit": key, "dry": "0"}})
        for key, (st, out) in zip(rest, ph.php(ops) if ops else []):
            self.assertEqual(st, 200, (key, out))
        p_ph = self.php_ok(ph, "plan", {"dataset": ds, "migration": M6})
        self.assertEqual(p_ph["done"], p_ph["total"])
        # Finalize both; PHP with no time budget, one pack step per call.
        py.py()
        while not dm.finalize(ds, M6).get("complete"):
            pass
        calls = 0
        for _ in range(1000):
            calls += 1
            st, out = ph.php([{"op": "handle", "action": "finalize", "body": {"dataset": ds, "migration": M6, "maxSeconds": 0}}],
                             zero_floor=True)[0]
            self.assertEqual(st, 200, out)
            if out.get("complete"):
                break
        self.assertGreater(calls, 1, "the PHP finalize paused at least once")
        a = tree_files(py.data_web / ds / "bricks")
        b = tree_files(ph.data_web / ds / "bricks")
        ma, mb = json.loads(a.pop("manifest.json")), json.loads(b.pop("manifest.json"))
        self.assertEqual(sorted(a), sorted(b))
        self.assertTrue(any("/q30/" in n or n.startswith("l0/q30/") for n in a))
        self.assertFalse([n for n in a if any(p in ("b2", "b4", "q80", "q50", "b2.bin", "b4.bin", "q80.bin", "q50.bin") for p in n.split("/"))])
        for name in a:
            self.assertEqual(a[name], b[name], name)
        self.assertEqual(strip(ma), strip(mb))
        self.assertEqual((mb["schema"], mb["version"], mb["formatVersion"], [c["id"] for c in mb["columns"]]),
                         ("iribhm-bricks-v6", 6, 6, ["ll", "q30"]))
        self.assertIn("migratedAt", mb)
        for tree in (py, ph):
            d = tree.data_web / ds
            self.assertIsNone(f5.bricks_problem(d, 6))
            meta = json.loads((d / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(meta.get("formatVersion"), 6)
            sha = hashlib.sha256((d / "bricks" / "manifest.json").read_bytes()).hexdigest()
            for pm in list((d / "planes").rglob("manifest.json")) + list((d / "mips").rglob("manifest.json")):
                self.assertEqual(json.loads(pm.read_text(encoding="utf-8"))["source"]["manifestSha256"], sha, pm)
        st, status = ph.php_handle("status")
        row = next(r for r in status["datasets"] if r["id"] == ds)
        self.assertEqual((row["formatVersion"], row["bricksSchema"], row["pending"], row.get("problem")),
                         (6, "iribhm-bricks-v6", [], None), row)
        py.py()
        prow = jsonish(dm.dataset_status(*ds.split("/"), py.data_web / ds))
        self.assertEqual(strip({k: v for k, v in prow.items() if k != "name"}), strip({k: v for k, v in row.items() if k != "name"}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
