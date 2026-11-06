"""The cached migration plan of a format-1/2 dataset keeps no brick index of its own.

A server run caches one Plan per volume dataset for its whole life (`_PLAN_CACHE`); the
trees already hold the brick index, so the cached manifest drops `brickTransport` (top
level and per timepoint row) and the tree index shares one Path per pack. What the
migrations read from the manifest — levels, histograms, per-timepoint histograms, the
dataset name — is still there: m004 still writes the timepoint histograms.

Run: python tests/test_dataset_migrations_plan_cache.py
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

try:
    import numpy  # noqa: F401
except ImportError:
    print("SKIP numpy unavailable")
    sys.exit(0)

import dataset_migrations as dm  # noqa: E402
from test_v3_py_migrations import make_3d, make_live, run_job  # noqa: E402

M2, M3, M4 = "m002-planes", "m003-layer-mips", "m004-bricks-v3"


class PlanCache(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-plancache-"))
        self.data_web = self.tmp / "DATA_WEB"
        for t in ("3d", "2d", "live"):
            (self.data_web / t).mkdir(parents=True)
        dm.configure(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def assert_shared_paths(self, plan):
        for tree in plan.trees.values():
            self.assertTrue(tree.index)
            by_value, ids = {}, set()
            for path, _off, _len in tree.index.values():
                by_value.setdefault(str(path), set()).add(id(path))
                ids.add(id(path))
            # one Path object per pack file, however many bricks it holds
            self.assertTrue(all(len(v) == 1 for v in by_value.values()))
            self.assertEqual(len(ids), len(by_value))
            self.assertLess(len(ids), len(tree.index))

    def test_3d_manifest_slimmed(self):
        ds, _truth = make_3d(self.data_web, Z=40)
        source = json.loads((ds / "bricks" / "manifest.json").read_text(encoding="utf-8"))
        self.assertIn("brickToPack", source["brickTransport"])
        dm.status()
        plan = dm._plan_for("3d/SYN3")
        self.assertIs(plan, dm._plan_for("3d/SYN3"))          # still cached
        self.assertNotIn("brickTransport", plan.manifest)
        for key in ("levels", "histograms", "dataset", "channels"):
            self.assertEqual(plan.manifest[key], source[key])
        self.assertIn("brickTransport", source)               # the file is untouched
        self.assert_shared_paths(plan)

    def test_live_rows_slimmed_and_m004_keeps_histograms(self):
        ds, _truth = make_live(self.data_web, X=150, Y=140, Z=30, T=2)
        source = json.loads((ds / "bricks" / "manifest.json").read_text(encoding="utf-8"))
        dm.status()
        plan = dm._plan_for("live/LIVE3")
        self.assertNotIn("brickTransport", plan.manifest)
        rows = plan.manifest["timepoints"]
        self.assertEqual(sorted(rows), sorted(source["timepoints"]))
        for key, row in rows.items():
            self.assertNotIn("brickTransport", row)
            self.assertEqual(row["histograms"], source["timepoints"][key]["histograms"])
            self.assertEqual(row["levels"], source["timepoints"][key]["levels"])
            self.assertEqual(row["path"], key)
        self.assert_shared_paths(plan)
        for mid in (M2, M3, M4):
            run_job(self, "live/LIVE3", mid)
        doc = json.loads((ds / "bricks" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(doc.get("timepointHistograms"),
                         {k: source["timepoints"][k]["histograms"] for k in sorted(source["timepoints"])})


if __name__ == "__main__":
    unittest.main(verbosity=2)
