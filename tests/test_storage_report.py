"""Storage report of the admin Stockage tab (dev_server.py `_storage_bucket`,
`_scan_storage_tree`, `_admin_storage`). Twin: api/_admin_lib.php `storage_bucket`,
`storage_scan_tree` — tests/test_storage_report_php.php asserts the same table.

Run: py tests/test_storage_report.py
"""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import dev_server  # noqa: E402


class TestBucket(unittest.TestCase):
    def test_classification(self):
        b = dev_server._storage_bucket
        self.assertEqual(b(("DATA_WEB", "3d", "ds", "thumbnail.webp")), ("data", "3d", "3d/ds", "(racine)"))
        self.assertEqual(b(("DATA_WEB", "3d", "ds", "bricks", "lod0", "p.bin")), ("data", "3d", "3d/ds", "bricks"))
        self.assertEqual(b(("DATA_WEB", "live", "ds", "download", "a.zip")), ("data", "live", "live/ds", "download"))
        self.assertEqual(b(("DATA_WEB", ".htaccess")), ("data", "autres", None, None))
        self.assertEqual(b(("DATA_WEB", "3d", "stray.txt")), ("data", "3d", None, None))
        self.assertEqual(b(("uploads", "staging", "3d", "x", "f")), ("uploads", "staging", None, None))
        self.assertEqual(b(("uploads", "trash", "e", "data")), ("uploads", "trash", None, None))
        self.assertEqual(b(("uploads", ".htaccess")), ("uploads", "autres", None, None))
        self.assertEqual(b(("js", "modules", "tools", "x", "index.js")), ("code", "js/modules", None, None))
        self.assertEqual(b(("js", "vendor", "three.js")), ("code", "js/vendor", None, None))
        self.assertEqual(b(("js", "core", "viewer.js")), ("code", "js", None, None))
        self.assertEqual(b(("api", "admin.php")), ("code", "api", None, None))
        self.assertEqual(b(("README.md",)), ("code", "(racine)", None, None))


class TestScan(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._root = dev_server.ROOT
        self._list = dev_server._list_datasets_cached
        dev_server.ROOT = self.tmp
        dev_server._list_datasets_cached = lambda: [{"id": "3d/ds", "name": "Demo"}]
        dev_server._STORAGE_CACHE.clear()

    def tearDown(self):
        dev_server.ROOT = self._root
        dev_server._list_datasets_cached = self._list
        dev_server._STORAGE_CACHE.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, rel, size):
        p = self.tmp / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x" * size)
        return p

    def test_totals_and_datasets(self):
        self._write("DATA_WEB/3d/ds/bricks/lod0/a.bin", 1000)
        self._write("DATA_WEB/3d/ds/thumbnail.webp", 50)
        self._write("js/vendor/three.js", 300)
        self._write("uploads/trash/x/entry.json", 20)
        scan = dev_server._scan_storage_tree()
        self.assertEqual(scan["trackedBytes"], 1370)
        cats = {c["id"]: c for c in scan["categories"]}
        self.assertEqual(cats["data"]["bytes"], 1050)
        self.assertEqual(cats["uploads"]["children"][0]["id"], "trash")
        ds = scan["datasets"][0]
        self.assertEqual((ds["id"], ds["name"], ds["bytes"], ds["files"]), ("3d/ds", "Demo", 1050, 2))
        self.assertEqual(ds["parts"][0], {"id": "bricks", "bytes": 1000})

    def test_hard_link_counted_once(self):
        a = self._write("DATA_WEB/3d/ds/bricks/lod0/a.bin", 4000)
        os.link(a, self.tmp / "DATA_WEB/3d/ds/bricks.previous_a.bin")
        scan = dev_server._scan_storage_tree()
        self.assertEqual(scan["trackedBytes"], 4000)
        self.assertEqual(scan["datasets"][0]["files"], 1)

    def test_report_is_cached_until_refresh(self):
        self._write("js/core/a.js", 10)
        first = dev_server._admin_storage()
        self._write("js/core/b.js", 10)
        second = dev_server._admin_storage()
        self.assertEqual(first["trackedBytes"], second["trackedBytes"])
        self.assertTrue(second["cached"])
        third = dev_server._admin_storage(refresh=True)
        self.assertEqual(third["trackedBytes"], 20)
        self.assertFalse(third["cached"])
        self.assertGreaterEqual(third["disk"]["freeBytes"], 0)
        self.assertEqual(third["otherBytes"], max(0, third["disk"]["usedBytes"] - 20))


if __name__ == "__main__":
    unittest.main()
