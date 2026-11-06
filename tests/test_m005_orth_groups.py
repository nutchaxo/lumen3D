"""m005 server executor, stage C (SPEC §14.10): sibling xz / yz units whose bands lie in
one row / column of 512-px plane tiles run as one task that decodes those tiles once.

A grouped task must produce, unit for unit, the exact pack the unit makes alone, read
each tile once, and leave the journal with the same done set; a sibling another request
holds is never taken into a group, and the RAM budget caps the group size.

Run: python tests/test_m005_orth_groups.py
"""
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
    import format5  # noqa: F401
except ImportError:
    print("SKIP numpy / format5 unavailable")
    sys.exit(0)

import dataset_migrations as dm  # noqa: E402
from test_v3_py_migrations import make_3d, run_job  # noqa: E402

M2, M3, M4, M5 = "m002-planes", "m003-layer-mips", "m004-bricks-v3", "m005-matrix"
DS = "3d/SYN3"


class OrthGroups(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-m005g-"))
        self.data_web = self.tmp / "DATA_WEB"
        for t in ("3d", "2d", "live"):
            (self.data_web / t).mkdir(parents=True)
        dm.configure(self.tmp)
        dm.server_capabilities(force=True)
        if not dm.server_capabilities(force=True)["migrations"].get(M5, {}).get("available"):
            self.skipTest("m005 server executor unavailable")
        # 300 × 270: five xz and five yz blocks, all in the first tile row / column.
        make_3d(self.data_web, X=300, Y=270, Z=40)
        for mid in (M2, M3, M4):
            run_job(self, DS, mid)
        dm.plan_job(DS, M5)
        self.plan = dm._plan_for(DS)
        self.us = dm._unitset(self.plan, M5)
        self.store = dm.tile_store_dir("3d", "SYN3", M5)

    def tearDown(self):
        dm.server_capabilities(force=True)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def level0_orth(self, axis, channel=0):
        return [u for u in self.us.units if u[0] == 2 and u[2] == 0 and u[3] == channel and u[4] == axis]

    def test_group_is_byte_identical_and_decodes_once(self):
        for axis in (0, 1):
            units = self.level0_orth(axis)
            self.assertGreaterEqual(len(units), 2)
            singles, single_read = [], 0
            for u in units:
                data, nread = dm.process_unit_m005(self.plan, self.us, u, self.store)
                singles.append(data)
                single_read += nread
            grouped, group_read = dm.process_orth_group_m005(self.plan, self.us, units, self.store)
            self.assertEqual(len(grouped), len(units))
            for u, a, b in zip(units, singles, grouped):
                self.assertEqual(a, b, dm._m005_key(u))
            # every unit alone read the whole tile row; the group read it once
            self.assertEqual(group_read * len(units), single_read)

    def test_mixed_group_is_refused(self):
        xz, yz = self.level0_orth(0)[0], self.level0_orth(1)[0]
        with self.assertRaises(dm.MigrationError):
            dm.process_orth_group_m005(self.plan, self.us, [xz, yz], self.store)

    def test_siblings(self):
        u = (2, 0, 0, 1, 0, 9, 0)
        self.assertEqual([s[5] for s in dm._m005_orth_siblings(u)], [8, 10, 11, 12, 13, 14, 15])

    def test_run_groups_respect_claims_and_budget(self):
        xz = self.level0_orth(0)
        held = dm._m005_key(xz[1])
        base = dm._job_base(self.plan, mid=M5)
        self.assertEqual(dm._claim(base, (held,)), held)
        try:
            r = dm.unit_run(DS, M5, max_seconds=20, workers=3)
            while r["done"] < r["total"] - 1:
                r = dm.unit_run(DS, M5, max_seconds=20, workers=3)
                if not r["processed"]:
                    break
            self.assertNotIn(held, r["processed"])
            self.assertEqual(r["done"], r["total"] - 1)
        finally:
            dm._release(base, held)
        r = dm.unit_run(DS, M5, max_seconds=20, workers=3)
        self.assertEqual(r["processed"], [held])
        self.assertEqual(r["done"], r["total"])
        journal = dm._load_journal(dm.journal_path("3d", "SYN3", M5))
        self.assertEqual(sorted(journal["done"]), sorted(dm._m005_key(u) for u in self.us.units))
        # the stored packs are the ones each unit makes alone
        for u in self.level0_orth(0) + self.level0_orth(1):
            data, _ = dm.process_unit_m005(self.plan, self.us, u, self.store)
            self.assertEqual(dm._m005_store_path(self.store, u).read_bytes(), data)

    def test_budget_caps_group_size(self):
        per = dm._m005_orth_band_bytes(self.us, self.level0_orth(0)[0])
        sizes = []
        real = dm.process_orth_group_m005

        def spy(plan, us, units, store):
            if units[0][2] == 0:
                sizes.append(len(units))
            return real(plan, us, units, store)

        old = (dm.M005_ORTH_GROUP_BYTES, dm.process_orth_group_m005)
        dm.M005_ORTH_GROUP_BYTES, dm.process_orth_group_m005 = 2 * per, spy
        try:
            for _ in range(1000):
                r = dm.unit_run(DS, M5, max_seconds=20, workers=1)
                if r["done"] >= r["total"]:
                    break
        finally:
            dm.M005_ORTH_GROUP_BYTES, dm.process_orth_group_m005 = old
        self.assertTrue(sizes)
        self.assertLessEqual(max(sizes), 2)
        self.assertEqual(sum(sizes), sum(1 for u in self.us.units if u[0] == 2 and u[2] == 0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
