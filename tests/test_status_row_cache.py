"""The PHP status row cache of the Data updates tab (api/_migrations_lib.php).

PHP keeps nothing between requests, so `status` used to rebuild the unit plan of every
volume dataset on every visit of the tab — re-reading, re-hashing and re-decoding each
index.bin of a format-4 dataset — which took ~20 s on a shared host. Each row is now cached
under uploads/migrations/.status/, keyed on a hash of what it depends on. Checked here, on a
synthetic dataset driven through tests/mig_php_driver.php:
* a second status reads the cache (the row file is not rewritten) and answers the same rows;
* every change the row depends on recomputes it: metadata (name), a job (plan → journal),
  a finished migration (format version, pending list), a kept previous tree, a pack
  directory losing a pack (the v3 problem is reported);
* the cached rows equal the Python twin's (dataset_migrations.status);
* the Server-Timing value of a status names the total and the slowest datasets.

Run: py -3.12 tests/test_status_row_cache.py
"""
import json
import re
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
try:
    import dataset_migrations as dm
    import test_mig_php_parity as base
except Exception as exc:  # pragma: no cover
    print(f"SKIP: numpy/Pillow/dataset_migrations unavailable ({exc})")
    sys.exit(0)

M2, M3, M4 = "m002-planes", "m003-layer-mips", "m004-bricks-v3"
DS = "3d/rc"
VOLATILE = ("createdAt", "updatedAt", "assembledAt")


def strip(d):
    if isinstance(d, dict):
        return {k: strip(v) for k, v in d.items() if k not in VOLATILE}
    if isinstance(d, list):
        return [strip(v) for v in d]
    return d


@unittest.skipIf(base.PHP is None, "php with GD/WebP not found")
class StatusRowCache(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-rowcache-"))
        self.tree = base.Tree(self.tmp)
        base.build_dataset(self.tree.data_web, "3d", "rc", {0: [base.make_volume(9, 150, 140, 40)]})
        self.ds_dir = self.tree.data_web / "3d" / "rc"
        self.cache = self.tree.uploads / "migrations" / ".status" / "3d__rc.json"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def php_row(self):
        st, r = self.tree.php_handle("status")
        self.assertEqual(st, 200, r)
        return next(x for x in r["datasets"] if x["id"] == DS)

    def py_row(self):
        return next(r for r in self.tree.py().status()["datasets"] if r["id"] == DS)

    def php_run(self, mid):
        st, r = self.tree.php_handle("plan", {"dataset": DS, "migration": mid})
        self.assertEqual(st, 200, r)
        while True:
            st, r = self.tree.php_handle("unit_run", {"dataset": DS, "migration": mid, "maxSeconds": 20})
            self.assertEqual(st, 200, r)
            if r["done"] >= r["total"]:
                break
        while True:
            st, r = self.tree.php_handle("finalize", {"dataset": DS, "migration": mid, "keepPrevious": True})
            self.assertEqual(st, 200, r)
            if r.get("complete"):
                return

    def assert_hit(self):
        """A status that must come from the cache: the row file is left as it was."""
        before = self.cache.stat().st_mtime_ns
        time.sleep(0.02)
        row = self.php_row()
        self.assertEqual(self.cache.stat().st_mtime_ns, before, "the row was recomputed")
        return row

    def test_cache_hits_and_invalidates(self):
        first = self.php_row()
        self.assertTrue(self.cache.is_file())
        self.assertEqual(first["pending"], [M2, M3, M4])
        self.assertEqual(self.assert_hit(), first)
        self.assertEqual(strip(first), strip(self.py_row()))

        # metadata changed → recomputed
        meta = json.loads((self.ds_dir / "metadata.json").read_text(encoding="utf-8"))
        meta["name"] = "Renamed"
        (self.ds_dir / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
        self.assertEqual(self.php_row()["name"], "Renamed")

        # a job planned → its journal appears in the row
        st, _ = self.tree.php_handle("plan", {"dataset": DS, "migration": M2})
        self.assertEqual(st, 200)
        row = self.php_row()
        self.assertEqual((row["job"] or {}).get("migration"), M2)
        self.assertEqual(self.assert_hit(), row)

        # whole chain, previous tree kept → version, pending and previous follow
        st, _ = self.tree.php_handle("cancel", {"dataset": DS, "migration": M2})
        self.assertEqual(st, 200)
        for mid in (M2, M3, M4):
            self.php_run(mid)
            row = self.php_row()
            self.assertEqual(row["formatVersion"], {M2: 2, M3: 3, M4: 4}[mid])
            self.assertIsNone(row["job"])
        self.assertEqual(row["pending"], [])
        self.assertEqual(row["previous"]["schema"], "iribhm-bricks-v2")
        self.assertEqual(self.assert_hit(), row)
        self.assertEqual(strip(row), strip(self.py_row()))

        # previous dropped → gone from the row
        st, _ = self.tree.php_handle("drop_previous", {"dataset": DS})
        self.assertEqual(st, 200)
        self.assertNotIn("previous", self.php_row())

        # a v3 pack removed → the problem is reported, not hidden by the cache
        # (directory mtimes have a 1 s resolution in PHP: a pack removed within the second of
        # the cached status would wait for the next change — not a case outside a test)
        time.sleep(1.1)
        pack = sorted((self.ds_dir / "bricks" / "l0" / "c0").glob("p*.bin"))[0]
        pack.unlink()
        row = self.php_row()
        self.assertEqual(row.get("problem"), "bricks_v3_invalid")

    def test_server_timing(self):
        script = self.tmp / "st.php"
        lib = (ROOT / "api" / "_migrations_lib.php").as_posix()
        script.write_text(f"""<?php
define('LUMEN_DATA_WEB', '{self.tree.data_web.as_posix()}');
define('LUMEN_UPLOADS_DIR', '{self.tree.uploads.as_posix()}');
define('LUMEN_PRIVATE_DIR', '{(self.tmp / 'private').as_posix()}');
require '{lib}';
lumen_mig_status();
echo lumen_mig_status_server_timing(12.34);
""", encoding="utf-8")
        r = subprocess.run([*base.PHP, str(script)], capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertRegex(r.stdout.strip(), r'^status;dur=12\.3, ds1;desc="3d/rc";dur=\d+\.\d$')


if __name__ == "__main__":
    unittest.main()
