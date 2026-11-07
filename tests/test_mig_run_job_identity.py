"""Dataset migrations: a server run credits its units only to the job it computed them for.

`unit_run` journals its stored units in batches (_RunJournal: one _mark_done per
RUN_FLUSH_UNITS units or RUN_FLUSH_SECONDS). `cancel` deletes the journal and the tile store
without waiting for a running request, and a re-plan writes a fresh running journal, often in
the same second (createdAt alone cannot tell the two jobs apart). A run that outlives that
cancel + re-plan must answer `no_job` and leave the new journal's `done` list empty; it must
never mark units whose tiles the cancel deleted.

Covered: the generic run (m002) cancelled and re-planned between two units, a run that is not
interrupted, a journal written before `jobId` existed, and a journal planned by the PHP twin
(it carries a `jobId` and a Python run credits its units).

Run: python tests/test_mig_run_job_identity.py
"""
import re
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
    from test_v3_py_migrations import make_3d
except Exception as exc:  # pragma: no cover
    print(f"SKIP: numpy/Pillow/dataset_migrations unavailable ({exc})")
    sys.exit(0)

DS = "3d/SYN3"
MID = "m002-planes"


class RunJobIdentity(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="lumen-mig-jobid-"))
        src = base.Tree(cls.tmp / "src")
        for t in ("3d", "2d", "live"):
            (src.data_web / t).mkdir(parents=True)
        src.py()
        make_3d(src.data_web, X=300, Y=200, Z=40, C=2, voxel=(0.5, 0.5, 1.6))
        cls.src = src

    @classmethod
    def tearDownClass(cls):
        dm.configure(ROOT)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.flush = (dm.RUN_FLUSH_UNITS, dm.RUN_FLUSH_SECONDS)
        self.store_any = dm._store_any
        # Deterministic batches: a flush every second unit, never on time.
        dm.RUN_FLUSH_UNITS, dm.RUN_FLUSH_SECONDS = 2, 1e9

    def tearDown(self):
        dm.RUN_FLUSH_UNITS, dm.RUN_FLUSH_SECONDS = self.flush
        dm._store_any = self.store_any

    def clone(self, name):
        dst = self.tmp / name
        shutil.copytree(self.src.base, dst)
        tree = base.Tree(dst)
        tree.py()
        return tree

    def journal(self):
        plan = dm._plan_for(DS)
        return dm._load_journal(dm.journal_path(plan.type, plan.folder, MID))

    def test_new_job_has_a_job_id(self):
        self.clone("ids")
        dm.plan_job(DS, MID)
        first = self.journal()
        self.assertRegex(first.get("jobId") or "", r"^[0-9a-f]{16}$")
        dm.cancel(DS, MID)
        dm.plan_job(DS, MID)
        second = self.journal()
        self.assertNotEqual(first["jobId"], second["jobId"])

    def test_cancel_and_replan_during_a_run(self):
        self.clone("race")
        dm.plan_job(DS, MID)
        old = self.journal()
        calls = []

        def hooked(plan, us, unit, store, result):
            calls.append(unit)
            if len(calls) == 2:
                # The operator discards the update and starts it again while this run's
                # first unit is stored but not yet journaled.
                dm.cancel(DS, MID)
                dm.plan_job(DS, MID)
            self.store_any(plan, us, unit, store, result)

        dm._store_any = hooked
        with self.assertRaises(dm.MigrationError) as cm:
            dm.unit_run(DS, MID, 20)
        self.assertEqual(cm.exception.code, "no_job")
        new = self.journal()
        self.assertEqual(new.get("state"), "running")
        self.assertNotEqual(new.get("jobId"), old.get("jobId"))
        self.assertEqual(new.get("done"), [], "units of the cancelled job credited to the new one")
        self.assertEqual((new.get("executors") or {}).get("server"), 0)
        # The new job still runs to completion on its own.
        dm._store_any = self.store_any
        while True:
            r = dm.unit_run(DS, MID, 20)
            if r["done"] >= r["total"]:
                break
        while not dm.finalize(DS, MID).get("complete"):
            pass
        self.assertEqual(dm.format_version(dm._read_metadata(dm._plan_for(DS).ds_dir)), 2)

    def test_uninterrupted_run_is_credited(self):
        self.clone("plain")
        total = dm.plan_job(DS, MID)["total"]
        r = dm.unit_run(DS, MID, 20)
        self.assertTrue(r["processed"])
        self.assertEqual(len(self.journal()["done"]), len(r["processed"]))
        self.assertLessEqual(r["done"], total)

    def test_journal_without_job_id(self):
        self.clone("legacy")
        dm.plan_job(DS, MID)
        j = self.journal()
        j.pop("jobId")
        plan = dm._plan_for(DS)
        dm._save_journal(dm.journal_path(plan.type, plan.folder, MID), j)
        r = dm.unit_run(DS, MID, 20)
        self.assertTrue(r["processed"])
        after = self.journal()
        self.assertNotIn("jobId", after)
        self.assertEqual(len(after["done"]), len(r["processed"]))

    @unittest.skipIf(base.PHP is None, "php not found")
    def test_php_planned_job(self):
        tree = self.clone("php")
        st, out = tree.php_handle("plan", {"dataset": DS, "migration": MID})
        self.assertEqual(st, 200, out)
        tree.py()
        j = self.journal()
        self.assertTrue(re.fullmatch(r"[0-9a-f]{16}", j.get("jobId") or ""), j.get("jobId"))
        r = dm.unit_run(DS, MID, 20)
        self.assertTrue(r["processed"])
        self.assertEqual(len(self.journal()["done"]), len(r["processed"]))


if __name__ == "__main__":
    unittest.main()
