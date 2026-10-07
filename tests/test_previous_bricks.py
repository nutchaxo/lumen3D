"""Keeping the previous brick tree of a format-4 migration (finalize `keepPrevious`).

m004-bricks-v3 replaces bricks/ (v2) by a v3 tree and used to delete the v2 tree after the
version bump. With `keepPrevious: true` it is kept as bricks.previous/, byte for byte the
tree the dataset had, so the viewer can show it (`viewer.html?bricks=previous`); the
status row reports it (`previous: {schema, bytes}`) and `drop_previous` deletes it. Both
backends (dataset_migrations.py and api/_migrations_lib.php through tests/mig_php_driver.php)
on the same synthetic dataset, plus the default (nothing kept) and a re-run of finalize.

Run: py -3.12 tests/test_previous_bricks.py
"""
import hashlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
try:
    import dataset_migrations as dm
    import test_mig_php_parity as base
except Exception as exc:  # pragma: no cover
    print(f"SKIP: numpy/Pillow/dataset_migrations unavailable ({exc})")
    sys.exit(0)

M2, M3, M4 = "m002-planes", "m003-layer-mips", "m004-bricks-v3"
DS = "3d/prev"


def tree_digest(d: Path) -> dict:
    return {p.relative_to(d).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(d.rglob("*")) if p.is_file()}


class PreviousBricks(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-prev-"))
        self.tree = base.Tree(self.tmp)
        base.build_dataset(self.tree.data_web, "3d", "prev", {0: [base.make_volume(5, 150, 140, 40)]})
        self.ds_dir = self.tree.data_web / "3d" / "prev"
        self.v2 = tree_digest(self.ds_dir / "bricks")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ── Python ──
    def py_run(self, mid, keep=None):
        m = self.tree.py()
        m.plan_job(DS, mid)
        while True:
            r = m.unit_run(DS, mid, 20)
            if r["done"] >= r["total"]:
                break
        body = {"dataset": DS, "migration": mid}
        if keep is not None:
            body["keepPrevious"] = keep
        while True:
            st, r = m.handle("finalize", {}, body)
            self.assertEqual(st, 200, r)
            if r.get("complete"):
                return r

    def py_row(self):
        return next(r for r in self.tree.py().status()["datasets"] if r["id"] == DS)

    # ── PHP ──
    def php_run(self, mid, keep=None):
        st, r = self.tree.php_handle("plan", {"dataset": DS, "migration": mid})
        self.assertEqual(st, 200, r)
        while True:
            st, r = self.tree.php_handle("unit_run", {"dataset": DS, "migration": mid, "maxSeconds": 20})
            self.assertEqual(st, 200, r)
            if r["done"] >= r["total"]:
                break
        body = {"dataset": DS, "migration": mid}
        if keep is not None:
            body["keepPrevious"] = keep
        while True:
            st, r = self.tree.php_handle("finalize", body)
            self.assertEqual(st, 200, r)
            if r.get("complete"):
                return r

    def php_row(self):
        st, r = self.tree.php_handle("status")
        self.assertEqual(st, 200, r)
        return next(x for x in r["datasets"] if x["id"] == DS)

    def check_kept(self, row):
        prev = self.ds_dir / dm.PREVIOUS_BRICKS
        self.assertEqual(tree_digest(prev), self.v2)            # the v2 tree, byte for byte
        self.assertFalse((self.ds_dir / "bricks.v2-old").exists())
        self.assertEqual(dm._bricks_dir_schema(self.ds_dir / "bricks"), dm.V3_SCHEMA)
        self.assertEqual(row["formatVersion"], 4)
        self.assertEqual(row["pending"], [])
        self.assertEqual(row["previous"]["schema"], "iribhm-bricks-v2")
        self.assertEqual(row["previous"]["bytes"], sum((prev / k).stat().st_size for k in self.v2))

    def test_python_keep_and_drop(self):
        self.py_run(M2)
        self.py_run(M3)
        self.assertNotIn("previous", self.py_row())
        self.py_run(M4, keep=True)
        self.check_kept(self.py_row())
        # A repeated finalize (a retried request) leaves the kept tree alone.
        st, r = self.tree.py().handle("finalize", {}, {"dataset": DS, "migration": M4})
        self.assertEqual((st, r.get("complete")), (200, True), r)
        self.assertEqual(tree_digest(self.ds_dir / dm.PREVIOUS_BRICKS), self.v2)
        st, r = self.tree.py().handle("drop_previous", {}, {"dataset": DS})
        self.assertEqual((st, r), (200, {"ok": True, "dropped": True}))
        self.assertFalse((self.ds_dir / dm.PREVIOUS_BRICKS).exists())
        self.assertNotIn("previous", self.py_row())
        st, r = self.tree.py().handle("drop_previous", {}, {"dataset": DS})
        self.assertEqual((st, r), (200, {"ok": True, "dropped": False}))
        self.assertEqual(self.tree.py().handle("drop_previous", {}, {"dataset": "3d/../x"})[1].get("error"), "bad_dataset")

    def test_python_default_deletes(self):
        self.py_run(M2)
        self.py_run(M3)
        self.py_run(M4)
        self.assertFalse((self.ds_dir / dm.PREVIOUS_BRICKS).exists())
        self.assertFalse((self.ds_dir / "bricks.v2-old").exists())
        self.assertNotIn("previous", self.py_row())

    def test_python_keep_must_be_true(self):
        self.py_run(M2)
        self.py_run(M3)
        self.py_run(M4, keep="yes")     # only the JSON value true keeps it
        self.assertFalse((self.ds_dir / dm.PREVIOUS_BRICKS).exists())

    @unittest.skipIf(base.PHP is None, "php with GD/WebP not found")
    def test_php_keep_and_drop(self):
        self.php_run(M2)
        self.php_run(M3)
        self.assertNotIn("previous", self.php_row())
        self.php_run(M4, keep=True)
        row = self.php_row()
        self.check_kept(row)
        self.assertEqual(row["previous"], self.py_row()["previous"])   # twins agree
        st, r = self.tree.php_handle("drop_previous", {"dataset": DS})
        self.assertEqual((st, r), (200, {"ok": True, "dropped": True}))
        self.assertFalse((self.ds_dir / dm.PREVIOUS_BRICKS).exists())
        self.assertNotIn("previous", self.php_row())

    @unittest.skipIf(base.PHP is None, "php with GD/WebP not found")
    def test_php_default_deletes(self):
        self.php_run(M2)
        self.php_run(M3)
        self.php_run(M4)
        self.assertFalse((self.ds_dir / dm.PREVIOUS_BRICKS).exists())
        self.assertNotIn("previous", self.php_row())


if __name__ == "__main__":
    unittest.main()
