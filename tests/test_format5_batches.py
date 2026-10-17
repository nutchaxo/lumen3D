"""m005 browser batches and pieces (SPEC §14.10), Python and PHP twins.

A browser worker takes up to 64 units at once: `unit_inputs_many` answers what each one reads,
`unit_put_many` stores their results with one journal write, and a result larger than one
request may carry on the host (`status.server.maxUnitBody`, a PHP host's post_max_size) goes
up in pieces through `unit_put_part`. Checked here, on both backends from the same bodies:

* `unit_inputs_many` = the `unit_inputs` answers in order, a blocked unit as an item error,
  more than 64 units refused;
* `unit_put_many`: a malformed unit is refused alone, the others are stored; a stage-A unit
  counts for a later unit of the same batch; a malformed batch body is bad_blob;
* `unit_put_part`: a piece past what was received is refused (409), a repeated piece is
  accepted again, the last piece stores the unit;
* a whole conversion made of batches and pieces finalizes to the same v5 tree as the server
  executor (Python) and byte for byte the same tree on PHP;
* the PHP status announces min(32 MiB, post_max_size − 64 KiB) as maxUnitBody.

Run: python tests/test_format5_batches.py
"""
import json
import shutil
import subprocess
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
    from test_format5_browser_protocol import client_unit, tree_files
except Exception as exc:  # pragma: no cover
    print(f"SKIP: numpy/Pillow/dataset_migrations unavailable ({exc})")
    sys.exit(0)

PHP = base.PHP
M5 = "m005-matrix"
DS = "3d/SYN3"
PIECE = 40_000
BATCH = 16


def strip(d):
    if isinstance(d, dict):
        return {k: strip(v) for k, v in d.items() if k not in ("createdAt", "updatedAt", "assembledAt")}
    if isinstance(d, list):
        return [strip(v) for v in d]
    return d


def jsonish(v):
    return json.loads(json.dumps(v))


class Batches(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="lumen-f5-batch-"))
        src = base.Tree(cls.tmp / "src")
        for t in ("3d", "2d", "live"):
            (src.data_web / t).mkdir(parents=True)
        src.py()
        make_3d(src.data_web, X=300, Y=200, Z=40, C=2, voxel=(0.5, 0.5, 1.6))
        for mid in ("m002-planes", "m003-layer-mips", "m004-bricks-v3"):
            dm.plan_job(DS, mid)
            while dm.unit_run(DS, mid, 20)["done"] < dm.plan_job(DS, mid)["total"]:
                pass
            while not dm.finalize(DS, mid).get("complete"):
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

    # ── Python ────────────────────────────────────────────────────────────────

    def test_python_protocol(self):
        t = self.clone("py-proto")
        t.py()
        plan = dm.plan_job(DS, M5)
        keys = plan["units"]
        a_keys = [k for k in keys if k.startswith("A.")]
        us = dm._unitset(dm._plan_for(DS), M5)
        later = next(dm._m005_key(u) for u in us.units if u[0] and u[2] == 1)
        out = dm.unit_inputs_many(DS, M5, a_keys[:3] + [later])
        self.assertEqual([jsonish(x) for x in out["items"][:3]], [jsonish(dm.unit_inputs(DS, M5, k)) for k in a_keys[:3]])
        self.assertEqual((out["items"][3]["ok"], out["items"][3]["error"], out["items"][3]["unit"]), (False, "unit_blocked", later))
        with self.assertRaises(dm.MigrationError) as cm:
            dm.unit_inputs_many(DS, M5, a_keys[:1] * 65)
        self.assertEqual(cm.exception.code, "bad_unit")
        with self.assertRaises(dm.MigrationError) as cm:
            dm.unit_put_many(DS, M5, b"\x02\x00\x00\x00")
        self.assertEqual(cm.exception.code, "bad_blob")
        # One malformed unit does not refuse the others.
        good = [(k, client_unit(DS, k)) for k in a_keys[:2]]
        res = dm.unit_put_many(DS, M5, dm.build_put_many(good + [(a_keys[2], b"\x01\x00\x00\x00garbage")]))
        self.assertEqual([(r["unit"], r["ok"]) for r in res["results"]], [(a_keys[0], True), (a_keys[1], True), (a_keys[2], False)])
        self.assertEqual(res["results"][2]["error"], "bad_blob")
        self.assertEqual(res["done"], 2)
        # Stage A of one tree/channel and a later unit of it in the same batch.
        c0 = [k for k in (dm._m005_key(u) for u in us.units if u[0] == 0 and u[3] == 0)]
        rest = [(k, client_unit(DS, k)) for k in c0 if k not in a_keys[:2]]
        dm.unit_put_many(DS, M5, dm.build_put_many(rest))
        k1 = next(dm._m005_key(u) for u in us.units if u[0] and u[2] == 1 and u[3] == 0)
        self.assertTrue(dm.unit_inputs(DS, M5, k1))
        # Pieces.
        body = client_unit(DS, k1)
        self.assertGreater(len(body), 3 * 1000)
        n = len(body)
        with self.assertRaises(dm.MigrationError) as cm:
            dm.unit_put_part(DS, M5, k1, 1000, n, body[1000:2000])
        self.assertEqual((cm.exception.code, cm.exception.status), ("bad_blob", 409))
        self.assertEqual(dm.unit_put_part(DS, M5, k1, 0, n, body[:1000])["complete"], False)
        self.assertEqual(dm.unit_put_part(DS, M5, k1, 0, n, body[:1000])["received"], 1000)
        r = dm.unit_put_part(DS, M5, k1, 1000, n, body[1000:])
        self.assertTrue(r["complete"] and r["ok"])
        self.assertEqual(dm.plan_job(DS, M5)["done"], len(c0) + 1)

    def _convert(self, tree, put_many, put_part):
        """A whole m005 job in batches of BATCH units, results over PIECE bytes in pieces."""
        tree.py()
        for _ in range(30):
            tree.py()
            keys = dm.plan_job(DS, M5)["units"]
            if not keys:
                break
            for i in range(0, len(keys), BATCH):
                tree.py()
                bodies = [(k, client_unit(DS, k)) for k in keys[i:i + BATCH]]
                small = [(k, b) for k, b in bodies if len(b) <= PIECE]
                for k, b in bodies:
                    if len(b) > PIECE:
                        for off in range(0, len(b), PIECE):
                            put_part(k, off, len(b), b[off:off + PIECE])
                if small:
                    put_many(small)

    def test_whole_job_python_equals_server_and_php(self):
        server = self.clone("server")
        server.py()
        dm.plan_job(DS, M5)
        while dm.unit_run(DS, M5, 20)["done"] < dm.plan_job(DS, M5)["total"]:
            pass
        while not dm.finalize(DS, M5).get("complete"):
            pass

        py = self.clone("py")
        stats = {"parts": 0, "many": 0}

        def py_many(entries):
            py.py()
            res = dm.unit_put_many(DS, M5, dm.build_put_many(entries))
            self.assertTrue(all(r["ok"] for r in res["results"]), res)
            stats["many"] += 1

        def py_part(k, off, total, piece):
            py.py()
            r = dm.unit_put_part(DS, M5, k, off, total, piece)
            self.assertTrue(r["ok"], r)
            stats["parts"] += 1

        self._convert(py, py_many, py_part)
        self.assertGreater(stats["parts"], 2)
        py.py()
        st = dm.plan_job(DS, M5)
        self.assertEqual(st["done"], st["total"])
        while not dm.finalize(DS, M5).get("complete"):
            pass
        a = tree_files(server.data_web / DS / "bricks")
        b = tree_files(py.data_web / DS / "bricks")
        ma, mb = json.loads(a.pop("manifest.json")), json.loads(b.pop("manifest.json"))
        self.assertEqual(sorted(a), sorted(b))
        for name in a:
            self.assertEqual(a[name], b[name], name)
        for key in ("levels", "columns", "stores", "index", "bytes", "histograms"):
            self.assertEqual(ma[key], mb[key], key)

        if PHP is None:
            print("SKIP: php not found (PHP twin of batches not checked)")
            return
        ph = self.clone("php")
        n = {"i": 0}

        def php_ops(ops):
            for (st_, out), op in zip(ph.php(ops), ops):
                self.assertEqual(st_, 200, (op["action"], out))
                if op["action"] == "unit_put_many":
                    self.assertTrue(all(r["ok"] for r in out["results"]), out)

        st_, out = ph.php_handle("plan", {"dataset": DS, "migration": M5})
        self.assertEqual(st_, 200, out)
        for _ in range(30):
            st_, out = ph.php_handle("plan", {"dataset": DS, "migration": M5})
            keys = out["units"]
            if not keys:
                break
            # Inputs are the PHP twin's own; the bodies are computed once on the Python copy
            # that went through the same waves.
            got = ph.php([{"op": "handle", "action": "unit_inputs_many", "body": {"dataset": DS, "migration": M5, "units": keys[i:i + 64]}}
                          for i in range(0, len(keys), 64)])
            py.py()
            items = [it for _st, o in got for it in o["items"]]
            self.assertEqual(len(items), len(keys))
            ops = []
            for i in range(0, len(keys), BATCH):
                entries = []
                for k in keys[i:i + BATCH]:
                    b = self._body_cache[k]
                    if len(b) > PIECE:
                        for off in range(0, len(b), PIECE):
                            f = ph.base / f"part{n['i']}.bin"
                            n["i"] += 1
                            f.write_bytes(b[off:off + PIECE])
                            ops.append({"op": "handle", "action": "unit_put_part", "rawFile": str(f),
                                        "params": {"dataset": DS, "migration": M5, "unit": k, "offset": str(off), "total": str(len(b))}})
                    else:
                        entries.append((k, b))
                if entries:
                    f = ph.base / f"many{n['i']}.bin"
                    n["i"] += 1
                    f.write_bytes(dm.build_put_many(entries))
                    ops.append({"op": "handle", "action": "unit_put_many", "rawFile": str(f),
                                "params": {"dataset": DS, "migration": M5}})
            php_ops(ops)
        st_, out = ph.php_handle("plan", {"dataset": DS, "migration": M5})
        self.assertEqual(out["done"], out["total"])
        for _ in range(1000):
            st_, out = ph.php_handle("finalize", {"dataset": DS, "migration": M5})
            self.assertEqual(st_, 200, out)
            if out.get("complete"):
                break
        c = tree_files(ph.data_web / DS / "bricks")
        mc = json.loads(c.pop("manifest.json"))
        self.assertEqual(sorted(a), sorted(c))
        for name in a:
            self.assertEqual(a[name], c[name], name)
        for key in ("levels", "columns", "stores", "index", "bytes", "histograms"):
            self.assertEqual(ma[key], mc[key], key)

    @property
    def _body_cache(self):
        """Every unit body of the job, computed from the finished Python browser copy's inputs."""
        if not hasattr(self, "_bodies"):
            t = self.clone("bodies")
            t.py()
            self._bodies = {}
            for _ in range(30):
                t.py()
                keys = dm.plan_job(DS, M5)["units"]
                if not keys:
                    break
                for k in keys:
                    t.py()
                    b = client_unit(DS, k)
                    self._bodies[k] = b
                    dm.unit_put(DS, M5, k, b)
        return self._bodies

    # ── PHP ───────────────────────────────────────────────────────────────────

    @unittest.skipIf(PHP is None, "php not found")
    def test_php_protocol_and_limit(self):
        ph = self.clone("php-proto")
        st, plan = ph.php_handle("plan", {"dataset": DS, "migration": M5})
        self.assertEqual(st, 200, plan)
        keys = plan["units"]
        a_keys = [k for k in keys if k.startswith("A.")]
        py = self.clone("py-mirror")
        py.py()
        dm.plan_job(DS, M5)
        us = dm._unitset(dm._plan_for(DS), M5)
        later = next(dm._m005_key(u) for u in us.units if u[0] and u[2] == 1)
        st, out = ph.php_handle("unit_inputs_many", {"dataset": DS, "migration": M5, "units": a_keys[:3] + [later]})
        self.assertEqual(st, 200, out)
        self.assertEqual(out["items"][:3], [jsonish(dm.unit_inputs(DS, M5, k)) for k in a_keys[:3]])
        self.assertEqual((out["items"][3]["ok"], out["items"][3]["error"]), (False, "unit_blocked"))
        st, out = ph.php_handle("unit_inputs_many", {"dataset": DS, "migration": M5, "units": a_keys[:1] * 65})
        self.assertEqual((st, out.get("error")), (400, "bad_unit"))
        params = {"dataset": DS, "migration": M5}
        st, out = ph.php_handle("unit_put_many", params=params, raw=b"\x02\x00\x00\x00")
        self.assertEqual((st, out.get("error")), (400, "bad_blob"))
        good = [(k, client_unit(DS, k)) for k in a_keys[:2]]
        st, res = ph.php_handle("unit_put_many", params=params,
                                raw=dm.build_put_many(good + [(a_keys[2], b"\x01\x00\x00\x00garbage")]))
        self.assertEqual(st, 200, res)
        self.assertEqual([(r["unit"], r["ok"]) for r in res["results"]], [(a_keys[0], True), (a_keys[1], True), (a_keys[2], False)])
        self.assertEqual((res["results"][2]["error"], res["done"]), ("bad_blob", 2))
        for k, b in good:
            dm.unit_put(DS, M5, k, b)
        c0 = [dm._m005_key(u) for u in us.units if u[0] == 0 and u[3] == 0]
        rest = [(k, client_unit(DS, k)) for k in c0 if k not in a_keys[:2]]
        st, res = ph.php_handle("unit_put_many", params=params, raw=dm.build_put_many(rest))
        self.assertTrue(all(r["ok"] for r in res["results"]), res)
        for k, b in rest:
            dm.unit_put(DS, M5, k, b)
        k1 = next(dm._m005_key(u) for u in us.units if u[0] and u[2] == 1 and u[3] == 0)
        body = client_unit(DS, k1)
        n = len(body)
        piece = dict(params, unit=k1, total=str(n))
        st, out = ph.php_handle("unit_put_part", params=dict(piece, offset="1000"), raw=body[1000:2000])
        self.assertEqual((st, out.get("error")), (409, "bad_blob"))
        for _ in range(2):
            st, out = ph.php_handle("unit_put_part", params=dict(piece, offset="0"), raw=body[:1000])
            self.assertEqual((st, out.get("complete"), out.get("received")), (200, False, 1000), out)
        st, out = ph.php_handle("unit_put_part", params=dict(piece, offset="1000"), raw=body[1000:])
        self.assertEqual((st, out.get("complete"), out.get("ok")), (200, True, True), out)
        # The announced body limit.
        st, status = ph.php_handle("status")
        r = subprocess.run([*PHP, "-r", "echo ini_get('post_max_size');"], capture_output=True, text=True, timeout=30)
        v = r.stdout.strip()
        mult = {"k": 1024, "m": 1024 ** 2, "g": 1024 ** 3}
        post = int(v[:-1]) * mult[v[-1].lower()] if v and v[-1].lower() in mult else int(v or 0)
        cap = 32 * 1024 * 1024
        want = cap if post <= 0 else min(cap, max(1024 * 1024, post - 65536))
        self.assertEqual(status["server"]["maxUnitBody"], want)


if __name__ == "__main__":
    unittest.main(verbosity=2)
