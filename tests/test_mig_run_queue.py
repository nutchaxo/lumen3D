"""Server-run scheduling and journaling at scale (dataset_migrations, SPEC §6 "Cost per unit").

A server run must not pay a pass over every unit, nor a journal rewrite, per unit: a 100-frame
timelapse has ~140 000 m005 units. Checked here:

* `_RunQueue` hands out exactly the units the reference rule allows (`_pending_units`: m002 all,
  m004 the lowest unfinished level of each tree/channel, m005 level 0 and stage A at once, a
  later level once stage A of its tree/channel is done), in the unit set's order, on synthetic
  unit sets of every gating kind, finishing units in the order they were taken;
* a whole synthetic m005 schedule of ~140 000 units (taking and finishing every unit) stays in
  the time of a linear pass, where the former per-unit rescan was quadratic;
* units another executor finished (the journal's `done`, absorbed) are not handed out again;
* on a real dataset: one m005 `unit_run` journals in batches (far fewer `_mark_done` calls than
  units, every stored unit in the journal when it answers), and `unit_inputs_many` of 64 keys
  reads the journal once.

Run: python tests/test_mig_run_queue.py
"""
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

try:
    import dataset_migrations as dm
except Exception as exc:  # pragma: no cover
    print(f"SKIP: dataset_migrations unavailable ({exc})")
    sys.exit(0)

DS = "3d/SYN3"
M5 = "m005-matrix"


def unitset(mid, units):
    us = dm.UnitSet(mid)
    us.units = list(units)
    us.unit_bytes = {u: 1 for u in us.units}
    us.total = len(us.units)
    return us


def m005_units(T, C, Z, levels, per_level):
    """Synthetic m005 units in the order _unitset sorts them (stage A first, then by level)."""
    units = []
    for t in range(T):
        for c in range(C):
            for z in range(Z):
                units.append((0, t, 0, c, z, 0, 0))
            for k in range(levels):
                for i in range(per_level):
                    s = 1 + i % 3
                    units.append((s, t, k, c, i % 2, i, 0) if s == 2 else (s, t, k, c, i, 0, 0))
    return sorted(units, key=lambda u: (0 if u[0] == 0 else 1, u[2], u[1], u[0], u[3], u[4], u[5], u[6]))


def m004_units(T, C, levels, per_level):
    units = [(t, k, c, i, 0, 0) for t in range(T) for k in range(levels) for c in range(C) for i in range(per_level)]
    return sorted(units, key=lambda u: (u[1], u[0], u[2], u[3]))


def reference_order(us, held=()):
    """What the former runner took: rescan the pending units after every unit."""
    done, taken, order = set(), set(), []
    while True:
        runnable, _pending = dm._pending_units(us, done)
        key = next((k for k in (dm.unit_key_for(us.mid, u) for u in runnable)
                    if k not in taken and k not in held), None)
        if key is None:
            return order
        taken.add(key)
        done.add(key)
        order.append(key)


def queue_order(us, base, held=()):
    dm._CLAIMS.pop(base, None)
    for k in held:
        dm._claim(base, (k,))
    q = dm._RunQueue(us, [])
    order = []
    while True:
        key = q.claim(base)
        if key is None:
            break
        dm._release(base, key)
        q.finish(key)
        order.append(key)
    dm._CLAIMS.pop(base, None)
    return order


class Queue(unittest.TestCase):

    def test_same_schedule_as_the_reference_rule(self):
        cases = {
            "m002": unitset("m002-planes", [(t, z, c, 0, 0) for t in range(2) for z in range(3) for c in range(2)]),
            "m004": unitset("m004-bricks-v3", m004_units(T=2, C=2, levels=4, per_level=5)),
            "m005": unitset(M5, m005_units(T=2, C=2, Z=6, levels=3, per_level=7)),
        }
        for name, us in cases.items():
            with self.subTest(name):
                self.assertEqual(queue_order(us, "q-" + name), reference_order(us))
                # Units claimed by another request are skipped, not lost for later.
                held = {dm.unit_key_for(us.mid, us.units[1])}
                self.assertEqual(queue_order(us, "q-held-" + name, held), reference_order(us, held))

    def test_a_gate_waits_for_every_unit_it_needs(self):
        us = unitset(M5, m005_units(T=1, C=1, Z=3, levels=2, per_level=3))
        q = dm._RunQueue(us, [])
        base = "q-gate"
        dm._CLAIMS.pop(base, None)
        taken = []
        while True:
            k = q.claim(base)
            if k is None:
                break
            taken.append(k)
        # Nothing finished: stage A and level 0 only.
        allowed = {dm._m005_key(u) for u in us.units if u[0] == 0 or u[2] == 0}
        self.assertEqual(set(taken), allowed)
        a_keys = [k for k in taken if k.startswith("A.")]
        for k in a_keys[:-1]:
            q.finish(k)
            self.assertIsNone(q.claim(base), "a level-1 unit before the last stage-A unit")
        q.finish(a_keys[-1])
        nxt = q.claim(base)
        self.assertIsNotNone(nxt)
        self.assertNotIn(nxt, allowed)
        dm._CLAIMS.pop(base, None)

    def test_units_done_elsewhere_are_not_handed_out(self):
        us = unitset("m002-planes", [(0, z, 0, 0, 0) for z in range(10)])
        q = dm._RunQueue(us, [])
        journal = [dm.unit_key_for(us.mid, u) for u in us.units[:4]]
        q.absorb(journal)
        base = "q-absorb"
        dm._CLAIMS.pop(base, None)
        self.assertEqual(q.claim(base), dm.unit_key_for(us.mid, us.units[4]))
        journal.append(dm.unit_key_for(us.mid, us.units[5]))
        q.absorb(journal)
        self.assertEqual(q.claim(base), dm.unit_key_for(us.mid, us.units[6]))
        dm._CLAIMS.pop(base, None)

    def test_a_large_schedule_is_linear(self):
        # ~140 000 units: 100 frames x 2 channels of 200 stage-A planes + 500 later units.
        us = unitset(M5, m005_units(T=100, C=2, Z=200, levels=5, per_level=100))
        self.assertGreater(len(us.units), 139_000)
        base = "q-large"
        dm._CLAIMS.pop(base, None)
        t0 = time.perf_counter()
        q = dm._RunQueue(us, [])
        n = 0
        while True:
            k = q.claim(base)
            if k is None:
                break
            dm._release(base, k)
            q.finish(k)
            n += 1
        secs = time.perf_counter() - t0
        self.assertEqual(n, len(us.units))
        # The former rescan cost ~0.1 s per unit at this size (hours in all).
        self.assertLess(secs, 60.0, f"{secs:.1f} s for {n} units")
        print(f"  {n} units scheduled in {secs:.2f} s")


class Runs(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        try:
            import numpy  # noqa: F401
            from test_v3_py_migrations import make_3d
        except Exception as exc:  # pragma: no cover
            raise unittest.SkipTest(f"numpy/Pillow unavailable ({exc})")
        cls.tmp = Path(tempfile.mkdtemp(prefix="lumen-runq-"))
        for d in ("3d", "2d", "live"):
            (cls.tmp / "DATA_WEB" / d).mkdir(parents=True)
        dm.configure(cls.tmp)
        make_3d(cls.tmp / "DATA_WEB", X=300, Y=200, Z=40, C=2, voxel=(0.5, 0.5, 1.6))
        for mid in ("m002-planes", "m003-layer-mips", "m004-bricks-v3"):
            dm.plan_job(DS, mid)
            while dm.unit_run(DS, mid, 20)["done"] < dm.plan_job(DS, mid)["total"]:
                pass
            while not dm.finalize(DS, mid).get("complete"):
                pass

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)
        dm.configure(ROOT)

    def test_inputs_many_reads_the_journal_once(self):
        plan = dm.plan_job(DS, M5)
        us = dm._unitset(dm._plan_for(DS), M5)
        gated = [dm._m005_key(u) for u in us.units if u[0] and u[2]][:4]
        keys = [dm._m005_key(u) for u in us.units][:60] + gated
        single = []
        for k in keys:
            try:
                single.append(dm.unit_inputs(DS, M5, k))
            except dm.MigrationError as exc:
                single.append(dm._unit_error(k, exc))
        self.assertTrue(all(x.get("error") == "unit_blocked" for x in single[60:]))
        real, calls = dm._load_journal, {"n": 0}

        def counting(path):
            if path.name.endswith(".json") and M5 in path.name:
                calls["n"] += 1
            return real(path)

        dm._load_journal = counting
        try:
            out = dm.unit_inputs_many(DS, M5, keys)
        finally:
            dm._load_journal = real
        self.assertEqual(calls["n"], 1)
        self.assertEqual(out["items"], single)
        self.assertGreater(plan["total"], 64)

    def test_server_run_journals_in_batches(self):
        dm.plan_job(DS, M5)
        real, calls = dm._mark_done, {"n": 0}

        def counting(*a, **k):
            calls["n"] += 1
            return real(*a, **k)

        dm._mark_done = counting
        try:
            t0 = time.monotonic()
            out = dm.unit_run(DS, M5, 20, workers=4)
            secs = time.monotonic() - t0
        finally:
            dm._mark_done = real
        n = len(out["processed"])
        self.assertGreater(n, dm.RUN_FLUSH_UNITS, "enough units for a batch")
        self.assertLessEqual(calls["n"], n // dm.RUN_FLUSH_UNITS + int(secs / dm.RUN_FLUSH_SECONDS) + 2)
        self.assertLess(calls["n"], n)
        j = dm._load_journal(dm.journal_path("3d", "SYN3", M5))
        self.assertTrue(set(out["processed"]) <= set(j["done"]), "every stored unit journaled on return")
        self.assertEqual(out["done"], dm._summary(j)["done"])
        # The job still completes and finalizes from there.
        while dm.unit_run(DS, M5, 20)["done"] < dm.plan_job(DS, M5)["total"]:
            pass
        while not dm.finalize(DS, M5).get("complete"):
            pass
        self.assertTrue(dm._plan_for(DS).v5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
