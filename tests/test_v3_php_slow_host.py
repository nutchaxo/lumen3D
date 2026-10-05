"""Format 4 on a slow PHP host: m004's server executor under max_execution_time
(api/_migrations_lib.php lumen_mig_unit_run, SPEC §13.5).

A dense m004 unit takes ~20 s in PHP, against a ~25 s request on a 30 s host. A unit is
indivisible, so where the host can kill a request the server executor works in steps:

* octants: the 8 octants (2×2×2 bricks) of a unit, by PHP and by Python, are exactly
  the whole unit (level 0 and level 1; octants beyond the grid hold nothing);
* under a low limit (LUMEN_MIG_EXEC_LIMIT) unit_run stores units octant by octant
  (`partial` in its answer and in the journal), the job resumes across requests, Python
  finishes a half-done unit, and the v3 tree is exact against the pipeline's reference;
* a step killed with its request leaves journal.attempts up: the second death of a unit
  makes the next unit_run answer 409 `unit_timeout` (the tab then proposes the browser
  executor), the level is flagged slow, and a new `plan` gives the unit a fresh count.

Run: py -3.12 tests/test_v3_php_slow_host.py   (php with GD/WebP ≥ 8.1, numpy, Pillow)
"""
import base64
import json
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "preprocess"))

try:
    import numpy as np
    import dataset_migrations as dm
    import test_mig_php_parity as base
    import test_v3_php_parity as vp
except Exception as exc:  # pragma: no cover
    print(f"SKIP: numpy/Pillow/dataset_migrations unavailable ({exc})")
    sys.exit(0)

PHP = base.PHP
M4 = "m004-bricks-v3"
DS, FOLDER = "3d/slow", "slow"
VOXEL = {"x": 1.0, "y": 1.0, "z": 1.0}


class SlowHost(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="lumen-v3-slow-"))
        cls.src = base.Tree(cls.tmp / "src")
        # 300×290×70: level 0 = 2×2×1 super-blocks (the edge ones with empty octants),
        # level 1 (150×145×35) = one unit, level 2 = one unit.
        cls.truth = base.build_dataset(cls.src.data_web, "3d", FOLDER,
                                       {0: [base.make_volume(31, 300, 290, 70), base.make_volume(32, 300, 290, 70)]})
        meta_p = cls.src.data_web / DS / "metadata.json"
        meta = json.loads(meta_p.read_text(encoding="utf-8"))
        meta["formatVersion"] = 3
        meta_p.write_text(json.dumps(meta), encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)
        dm.configure(ROOT)

    def clone(self, name):
        dst = self.tmp / name
        shutil.copytree(self.src.base, dst)
        return base.Tree(dst)

    def req(self, t, ops, exec_limit=None):
        doc = {"dataWeb": str(t.data_web).replace("\\", "/"), "uploads": str(t.uploads).replace("\\", "/"),
               "private": str(t.private).replace("\\", "/"), "ops": ops}
        if exec_limit is not None:
            doc["execLimit"] = exec_limit
        p = t.base / "req.json"
        p.write_text(json.dumps(doc), encoding="utf-8")
        return [*PHP, str(base.DRIVER), str(p)]

    def php(self, t, ops, exec_limit=None):
        r = subprocess.run(self.req(t, ops, exec_limit), capture_output=True, text=True, timeout=600)
        self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])
        return json.loads(r.stdout)

    def _blob(self, t, data):
        p = t.base / "blob.bin"
        p.write_bytes(data)
        return p

    def journal_path(self, t):
        return t.uploads / "migrations" / f"3d__{FOLDER}__{M4}.json"

    def journal(self, t):
        try:
            return json.loads(self.journal_path(t).read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, PermissionError):
            return None

    def finalize_php(self, t):
        for _ in range(50):
            (st, r), = self.php(t, [{"op": "handle", "action": "finalize", "body": {"dataset": DS, "migration": M4}}])
            self.assertEqual(st, 200, r)
            if r.get("complete"):
                return
        self.fail("finalize never completed")

    def check_exact(self, t):
        man, _trees, n = vp.V3Parity.check_v3(self, t.data_web / DS, self.truth, "3d", VOXEL)
        meta = json.loads((t.data_web / DS / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["formatVersion"], 4)
        return man, n

    # ── 1. octants are exactly the unit ──
    def test_octants_equal_whole_unit(self):
        t = self.clone("octants")
        (st, plan), = self.php(t, [{"op": "handle", "action": "plan", "body": {"dataset": DS, "migration": M4}}])
        self.assertEqual(st, 200, plan)
        m = t.py()
        p = m._plan_for(DS)
        us = m._unitset(p, M4)
        store = m.tile_store_dir("3d", FOLDER, M4)
        empty_parts = n = 0

        def compare(units):
            nonlocal empty_parts, n
            for u in units:
                key = m.unit_key_for(M4, u)
                whole_py, _ = m.process_unit_m004(p, us, u, store)
                ops = [{"op": "unit_result", "dataset": DS, "migration": M4, "unit": key}]
                ops += [{"op": "unit_result", "dataset": DS, "migration": M4, "unit": key, "part": o} for o in range(8)]
                res = self.php(t, ops)
                dec = lambda r: {tuple(int(v) for v in k.split(".")): base64.b64decode(b) for k, b in r["result"].items()}
                whole_php, parts_php = dec(res[0]), {}
                parts_py = {}
                for o in range(8):
                    got = dec(res[1 + o])
                    if not m._m004_unit_bricks(us, u, o):
                        self.assertEqual(got, {}, f"{key} octant {o} lies beyond the grid")
                        empty_parts += 1
                    self.assertFalse(set(got) & set(parts_php), f"{key}: octants overlap")
                    parts_php.update(got)
                    py_o, _ = m.process_unit_m004(p, us, u, store, part=o)
                    self.assertTrue(set(py_o) <= set(m._m004_unit_bricks(us, u, o)))
                    parts_py.update(py_o)
                self.assertEqual(parts_py, whole_py, f"{key}: Python octants != whole unit (same encoder: bytes)")
                self.assertEqual(sorted(parts_php), sorted(whole_php), key)
                self.assertEqual(sorted(whole_php), sorted(whole_py), key)
                for b in whole_py:
                    ref = dm.decode_brick_v3(whole_py[b])
                    self.assertTrue(np.array_equal(dm.decode_brick_v3(parts_php[b]), ref), (key, b))
                    self.assertTrue(np.array_equal(dm.decode_brick_v3(whole_php[b]), ref), (key, b))
                    n += 1

        lvl0 = [u for u in us.units if u[1] == 0]
        compare([lvl0[0], lvl0[-1]])             # an interior super-block and an edge one
        # Level 1 reads level 0 from the store: let PHP produce level 0 first.
        while True:
            (st, r), = self.php(t, [{"op": "handle", "action": "unit_run", "body": {"dataset": DS, "migration": M4, "maxSeconds": 20}}])
            self.assertEqual(st, 200, r)
            plan = self.php(t, [{"op": "handle", "action": "plan", "body": {"dataset": DS, "migration": M4}}])[0][1]
            if all(k.startswith("t0.k1.") or k.startswith("t0.k2.") for k in plan["units"]):
                break
        compare([u for u in us.units if u[1] == 1])
        self.assertGreater(empty_parts, 0)
        print(f"  {n} v3 bricks: 8 octants == whole unit (PHP and Python, levels 0 and 1; {empty_parts} octants beyond the grid)")

    # ── 2. a low limit: octant by octant, resumable, Python finishes, exact ──
    def test_low_limit_runs_octants(self):
        for finisher in ("php", "python"):
            t = self.clone("low_" + finisher)
            (st, plan), = self.php(t, [{"op": "handle", "action": "plan", "body": {"dataset": DS, "migration": M4}}])
            self.assertEqual(st, 200, plan)
            seen_partial = seen_journal_partial = False
            calls = 0
            while True:
                # 6 s limit: a 1 s budget, 3 s kept free; every unit is split (no timing yet,
                # and the dataset is too small for any measured whole unit to be refused).
                (st, r), = self.php(t, [{"op": "handle", "action": "unit_run",
                                         "body": {"dataset": DS, "migration": M4, "maxSeconds": 20}}], exec_limit=6)
                self.assertEqual(st, 200, r)
                calls += 1
                self.assertTrue(r["processed"] or r.get("partial"), f"a request made no progress: {r}")
                if r.get("partial"):
                    seen_partial = True
                    self.assertTrue(all(0 < e["parts"] <= e["of"] == 8 for e in r["partial"]), r["partial"])
                j = self.journal(t)
                self.assertNotIn("attempts", j, "a finished step leaves no attempt")
                if j.get("partial"):
                    seen_journal_partial = True
                    for key, parts in j["partial"].items():
                        self.assertNotIn(key, j["done"])
                        self.assertEqual(parts, sorted(set(parts)))
                if finisher == "python" and seen_journal_partial:
                    break
                if r["done"] >= r["total"]:
                    break
                self.assertLess(calls, 400)
            self.assertTrue(seen_partial and seen_journal_partial, "the low limit never split a unit")
            if finisher == "python":
                m = t.py()
                m.plan_job(DS, M4)
                while True:
                    r = m.unit_run(DS, M4, 20)
                    if r["done"] >= r["total"]:
                        break
                j = self.journal(t)
                self.assertNotIn("partial", j, "a unit Python finished keeps no octant record")
                while not m.finalize(DS, M4).get("complete", False):
                    pass
            else:
                self.assertEqual(self.journal(t).get("timing", {}).get("0", {}).get("slow"), None)
                self.finalize_php(t)
            man, n = self.check_exact(t)
            print(f"  low limit, finished by {finisher}: {calls} requests, {n} v3 bricks exact, producer {man['producer']}")

    # ── 3. a step that dies with its request ──
    def kill_when_attempts(self, t, want, exec_limit=100):
        """Start a unit_run and kill the PHP process once some unit's attempts reach `want`.
        None when the request ended first (the step outran the poll on a loaded machine)."""
        proc = subprocess.Popen(self.req(t, [{"op": "handle", "action": "unit_run",
                                              "body": {"dataset": DS, "migration": M4, "maxSeconds": 20}}], exec_limit),
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                j = self.journal(t) or {}
                hit = [k for k, n in (j.get("attempts") or {}).items() if n >= want]
                if hit:
                    proc.kill()
                    proc.wait(30)
                    return hit[0]
                if proc.poll() is not None:
                    return None
                time.sleep(0.002)
            self.fail("no attempt recorded")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(30)

    def test_killed_steps_report_unit_timeout(self):
        t = self.clone("killed")
        (st, plan), = self.php(t, [{"op": "handle", "action": "plan", "body": {"dataset": DS, "migration": M4}}])
        self.assertEqual(st, 200, plan)
        # Two consecutive deaths of one unit. The kill races the step's end: a step that
        # finished before the poll saw it clears its count, and the pair is tried again.
        for _ in range(8):
            key = self.kill_when_attempts(t, 1)
            if key is None:
                continue
            j = self.journal(t)
            self.assertEqual(j["attempts"], {key: 1})
            self.assertNotIn(key, j["done"])
            key2 = self.kill_when_attempts(t, 2)
            if key2 is not None:
                break
        else:
            self.fail("never killed two consecutive steps of one unit")
        self.assertEqual(key2, key, "the next request resumes the unit that died")
        j = self.journal(t)
        level = str(int(key.split(".")[1][1:]))
        self.assertTrue(j["timing"][level]["slow"], j.get("timing"))
        (st, r), = self.php(t, [{"op": "handle", "action": "unit_run", "body": {"dataset": DS, "migration": M4, "maxSeconds": 20}}],
                            exec_limit=100)
        self.assertEqual((st, r["error"], r["unit"], r["attempts"]), (409, "unit_timeout", key, 2), r)
        jt = self.journal(t)
        self.assertEqual(jt["attempts"], {key: 2}, "a refused step is not counted")
        # The tab switches to the browser executor on the SAME journal: still running,
        # every other unit's progress kept.
        self.assertEqual(jt["state"], "running")
        self.assertEqual(jt["done"], j["done"])
        # The browser executor takes the unit over: its blob lands, the bookkeeping goes.
        m = t.py()
        p = m._plan_for(DS)
        us = m._unitset(p, M4)
        bricks, _n = m.process_unit_m004(p, us, m.parse_unit_key_for(M4, key), m.tile_store_dir("3d", FOLDER, M4))
        (st, r), = self.php(t, [{"op": "handle", "action": "unit_put", "params": {"dataset": DS, "migration": M4, "unit": key},
                                 "rawFile": str(self._blob(t, m.build_v3_unit_blob(bricks)))}])
        self.assertEqual(st, 200, r)
        jt = self.journal(t)
        self.assertIn(key, jt["done"])
        self.assertNotIn("attempts", jt)
        self.assertNotIn(key, jt.get("partial") or {})
        # A new plan gives every unit a fresh count (Python has no time limit to count against).
        self.assertEqual(t.py().plan_job(DS, M4)["state"], "running")
        self.assertNotIn("attempts", self.journal(t))
        self.assertTrue(self.journal(t)["timing"][level]["slow"], "the level stays split after a re-plan")
        while True:
            (st, r), = self.php(t, [{"op": "handle", "action": "unit_run", "body": {"dataset": DS, "migration": M4, "maxSeconds": 20}}],
                                exec_limit=100)
            self.assertEqual(st, 200, r)
            if r["done"] >= r["total"]:
                break
        self.finalize_php(t)
        _man, n = self.check_exact(t)
        print(f"  two killed steps of {key}: unit_timeout, then a fresh plan finished the job exactly ({n} v3 bricks)")


if __name__ == "__main__":
    if PHP is None:
        print("SKIP: php with the gd extension (WebP) not found")
        sys.exit(0)
    unittest.main(verbosity=2)
