"""Unit tests for dev_server.py path-traversal guards (CRIT-02 / CRIT-03).

The admin API derives disk paths from the `id` query param ("<type>/<folder>").
Before the fix this was used unsanitised, allowing arbitrary file read/write
(incl. arbitrary bytes via save_thumbnail). These tests assert the guard
`_safe_dataset_dir` rejects traversal and that the write/read helpers refuse
malformed ids.

Run: py tests/test_dev_server_paths.py
"""
import base64
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import dev_server  # noqa: E402

BAD_IDS = [
    "3d/../../etc",
    "3d/..",
    "3d/../secret",
    "2d/..",
    "2d/../secret",
    "../../../etc/passwd",
    "3d/a/b",             # nested -> folder contains '/'
    "3d/foo/../../bar",
    "3d/",                # empty folder
    "/etc/passwd",        # empty type
    "etc/passwd",         # disallowed type
    "fixed/Demo",         # the former spelling of '3d' is not a type any more
    "wholemount/Demo",    # idem for '2d' — no alias, no double reading
    "3d/..\\..",          # backslash traversal
    "C:/Windows",         # disallowed type "C:"
    "3d",                 # no slash
    "2d",
    "",
]


class TestSafeDatasetDir(unittest.TestCase):
    def test_valid_id(self):
        res = dev_server._safe_dataset_dir("3d/MyDataset_01")
        self.assertIsNotNone(res)
        type_dir, folder, path = res
        self.assertEqual(type_dir, "3d")
        self.assertEqual(folder, "MyDataset_01")
        self.assertTrue(str(path).endswith(os.path.join("3d", "MyDataset_01")))

    def test_valid_realistic_dataset_name(self):
        name = "Egfl7eGFP-Em3-Decidua-7hCulture-TS11c-10x-2x2-16062026-DeconvolvedTypeAutomatic"
        self.assertIsNotNone(dev_server._safe_dataset_dir(f"3d/{name}"))
        self.assertIsNotNone(dev_server._safe_dataset_dir(f"live/{name}"))
        self.assertIsNotNone(dev_server._safe_dataset_dir(f"tracking/{name}"))
        self.assertIsNotNone(dev_server._safe_dataset_dir(f"2d/{name}"))

    def test_rejects_traversal_and_malformed(self):
        for bid in BAD_IDS:
            self.assertIsNone(dev_server._safe_dataset_dir(bid), f"should reject: {bid!r}")

    def test_rejects_non_string(self):
        self.assertIsNone(dev_server._safe_dataset_dir(None))
        self.assertIsNone(dev_server._safe_dataset_dir(123))


class TestWriteGuards(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._orig = dev_server.DATA_WEB
        dev_server.DATA_WEB = Path(self.tmp) / "DATA_WEB"
        (dev_server.DATA_WEB / "3d").mkdir(parents=True)

    def tearDown(self):
        dev_server.DATA_WEB = self._orig
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_save_dataset_valid(self):
        self.assertTrue(dev_server._save_dataset("3d/Demo", {"name": "Demo"}))
        self.assertTrue((dev_server.DATA_WEB / "3d" / "Demo" / "metadata.json").exists())

    def test_save_dataset_traversal_blocked(self):
        self.assertFalse(dev_server._save_dataset("3d/../../evil", {"name": "x"}))
        self.assertFalse((Path(self.tmp) / "evil").exists())
        self.assertFalse((Path(self.tmp) / "evil_metadata").exists())

    def test_save_thumbnail_valid(self):
        png = base64.b64encode(b"\x89PNG\r\n\x1a\n").decode()
        status, payload = dev_server._save_thumbnail_bytes(
            "3d/Demo", f"data:image/png;base64,{png}"
        )
        self.assertEqual(status, 200)
        self.assertTrue((dev_server.DATA_WEB / "3d" / "Demo" / "thumbnail.webp").exists())

    def test_save_thumbnail_traversal_blocked(self):
        png = base64.b64encode(b"x").decode()
        status, payload = dev_server._save_thumbnail_bytes(
            "3d/../../evil", f"data:image/png;base64,{png}"
        )
        self.assertEqual(status, 400)
        self.assertNotEqual(payload.get("ok"), True)
        self.assertFalse((Path(self.tmp) / "evil.webp").exists())

    def test_save_thumbnail_bad_format(self):
        status, _ = dev_server._save_thumbnail_bytes("3d/Demo", "not-an-image")
        self.assertEqual(status, 400)


class TestReadGuard(unittest.TestCase):
    """CRIT-03 (SEC-002): _get_dataset must not read outside DATA_WEB."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._orig = dev_server.DATA_WEB
        dev_server.DATA_WEB = Path(self.tmp) / "DATA_WEB"
        d = dev_server.DATA_WEB / "3d" / "Demo"
        d.mkdir(parents=True)
        (d / "metadata.json").write_text('{"name": "Demo"}', encoding="utf-8")
        # a secret file outside the dataset tree (must never be reachable)
        (Path(self.tmp) / "secret.json").write_text('{"secret": true}', encoding="utf-8")

    def tearDown(self):
        dev_server.DATA_WEB = self._orig
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_get_valid(self):
        meta = dev_server._get_dataset("3d/Demo")
        self.assertIsNotNone(meta)
        self.assertEqual(meta["folderName"], "Demo")
        self.assertEqual(meta["id"], "3d/Demo")

    def test_get_traversal_blocked(self):
        for bid in BAD_IDS:
            self.assertIsNone(dev_server._get_dataset(bid), f"should reject: {bid!r}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
