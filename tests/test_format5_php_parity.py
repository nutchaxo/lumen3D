"""Format 5 — PHP ↔ Python parity of migration m005-matrix through the browser protocol
(SPEC §14.10). A PHP host has no m005 executor: the browser computes every unit from what
`unit_inputs` names and posts it with `unit_put`. Here a client that sees only those answers
(tests/test_format5_browser_protocol.py:client_unit) computes each unit once; the same body
goes to dataset_migrations.py and to api/_migrations_lib.php (driven by
tests/mig_php_driver.php) on two copies of the same format-4 datasets, a 3d one with two
channels and a live one with two timepoints:

* plans identical (totals, empties, the runnable keys in order, stages, levels), and every
  unit_inputs answer identical, unit_blocked before stage A on both;
* bad_blob for a malformed body, read_ranges of `@store/A/…` identical;
* the finalized v5 trees byte for byte identical (manifest compared parsed, its timestamp
  aside), version 5 on both, the PHP status row naming a valid v5 tree with nothing pending;
* the PHP capability row: m005 is browser only.

Run: python tests/test_format5_php_parity.py   (php ≥ 8.1, numpy, Pillow)
"""
import base64
import json
import shutil
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
    import test_mig_php_parity as base
    from test_v3_py_migrations import make_3d, make_live
    from test_format5_browser_protocol import client_unit, tree_files
except Exception as exc:  # pragma: no cover
    print(f"SKIP: numpy/Pillow/dataset_migrations unavailable ({exc})")
    sys.exit(0)

PHP = base.PHP
M5 = "m005-matrix"
DATASETS = ("3d/SYN3", "live/LIVE3")


def jsonish(v):
    return json.loads(json.dumps(v))


def strip(d):
    if isinstance(d, dict):
        return {k: strip(v) for k, v in d.items() if k not in ("createdAt", "updatedAt", "assembledAt")}
    if isinstance(d, list):
        return [strip(v) for v in d]
    return d


@unittest.skipIf(PHP is None, "php not found")
class Format5Parity(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="lumen-f5-php-"))
        src = base.Tree(cls.tmp / "src")
        for t in ("3d", "2d", "live"):
            (src.data_web / t).mkdir(parents=True)
        src.py()
        make_3d(src.data_web, X=300, Y=200, Z=40, C=2, voxel=(0.5, 0.5, 1.6))
        make_live(src.data_web, X=280, Y=100, Z=20, T=2)
        for ds in DATASETS:
            for mid in ("m002-planes", "m003-layer-mips", "m004-bricks-v3"):
                dm.plan_job(ds, mid)
                while True:
                    r = dm.unit_run(ds, mid, 20)
                    if r["done"] >= r["total"]:
                        break
                while not dm.finalize(ds, mid).get("complete"):
                    pass
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

    def test_capabilities(self):
        caps = self.src.php([{"op": "caps"}])[0]
        self.assertEqual(caps["migrations"][M5], {"available": False, "reasons": ["browser_only"]})

    def test_browser_units_assemble_identically(self):
        py, ph = self.clone("py"), self.clone("php")
        for ds in DATASETS:
            with self.subTest(dataset=ds):
                self._one(py, ph, ds)

    def _one(self, py, ph, ds):
        py.py()
        p_py = jsonish(dm.plan_job(ds, M5))
        p_ph = self.php_ok(ph, "plan", {"dataset": ds, "migration": M5})
        for k in ("total", "empty", "done", "pending", "runnable", "units", "stages", "levels", "state"):
            self.assertEqual(p_py[k], p_ph[k], k)
        # Inputs of every unit runnable now, and the refusal of a later one.
        py.py()
        keys = p_py["units"]
        want = [jsonish(dm.unit_inputs(ds, M5, k)) for k in keys]
        got = ph.php([{"op": "handle", "action": "unit_inputs", "body": {"dataset": ds, "migration": M5, "unit": k}} for k in keys])
        for k, w, (st, g) in zip(keys, want, got):
            self.assertEqual(st, 200, g)
            self.assertEqual(w, g, k)
        us = dm._unitset(dm._plan_for(ds), M5)
        later = next(dm._m005_key(u) for u in us.units if u[0] and u[2] == 1)
        st, out = ph.php_handle("unit_inputs", {"dataset": ds, "migration": M5, "unit": later})
        self.assertEqual((st, out.get("error")), (409, "unit_blocked"))
        with self.assertRaises(dm.MigrationError) as cm:
            dm.unit_inputs(ds, M5, later)
        self.assertEqual(cm.exception.code, "unit_blocked")
        a_key = next(k for k in keys if k.startswith("A."))
        st, out = ph.php_handle("unit_put", params={"dataset": ds, "migration": M5, "unit": a_key, "dry": "0"},
                                raw=b"\x01\x00\x00\x00garbage")
        self.assertEqual((st, out.get("error")), (400, "bad_blob"))
        # Waves: the same body to both backends.
        for _ in range(20):
            py.py()
            keys = dm.plan_job(ds, M5)["units"]
            if not keys:
                break
            ops = []
            for i, key in enumerate(keys):
                py.py()
                body = client_unit(ds, key)
                dm.unit_put(ds, M5, key, body)
                f = ph.base / f"blob{i}.bin"
                f.write_bytes(body)
                ops.append({"op": "handle", "action": "unit_put", "rawFile": str(f),
                            "params": {"dataset": ds, "migration": M5, "unit": key, "dry": "0"}})
            for key, (st, out) in zip(keys, ph.php(ops)):
                self.assertEqual(st, 200, (key, out))
        py.py()
        self.assertEqual(dm.plan_job(ds, M5)["done"], p_py["total"])
        p_ph = self.php_ok(ph, "plan", {"dataset": ds, "migration": M5})
        self.assertEqual(p_ph["done"], p_ph["total"])
        # read_ranges of a stored stage-A plane, identical.
        py.py()
        k1 = next(dm._m005_key(u) for u in us.units if u[0] and u[2] == 1)
        runs = [[t["rel"], t["start"], t["end"]] for t in dm.unit_inputs(ds, M5, k1)["tiles"]][:4]
        self.assertTrue(runs and runs[0][0].startswith("@store/A/"), runs)
        want = dm.read_ranges(ds, runs)
        st, typ, got = ph.php([{"op": "binary", "action": "read_ranges", "body": {"dataset": ds, "ranges": runs}}])[0]
        self.assertEqual((st, base64.b64decode(got)), (200, want))
        # Finalize both.
        py.py()
        while not dm.finalize(ds, M5).get("complete"):
            pass
        for _ in range(1000):
            if self.php_ok(ph, "finalize", {"dataset": ds, "migration": M5}).get("complete"):
                break
        a = tree_files(py.data_web / ds / "bricks")
        b = tree_files(ph.data_web / ds / "bricks")
        ma, mb = json.loads(a.pop("manifest.json")), json.loads(b.pop("manifest.json"))
        self.assertEqual(sorted(a), sorted(b))
        self.assertGreater(sum(1 for n in a if "/q50/" in n or n.startswith("q50/") or "cuts/" in n), 3)
        for name in a:
            self.assertEqual(a[name], b[name], name)
        self.assertEqual(strip(ma), strip(mb))
        for tree in (py, ph):
            meta = json.loads((tree.data_web / ds / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(meta.get("formatVersion"), 5)
            self.assertFalse((tree.data_web / ds / "bricks.v4-old").exists())
        st, status = ph.php_handle("status")
        row = next(r for r in status["datasets"] if r["id"] == ds)
        self.assertEqual((row["formatVersion"], row["bricksSchema"], row["pending"], row.get("problem")),
                         (5, "iribhm-bricks-v5", [], None), row)
        py.py()
        prow = jsonish(dm.dataset_status(*ds.split("/"), py.data_web / ds))
        self.assertEqual(strip({k: v for k, v in prow.items() if k != "name"}), strip({k: v for k, v in row.items() if k != "name"}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
