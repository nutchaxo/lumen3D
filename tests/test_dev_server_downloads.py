"""
Run: py tests/test_dev_server_downloads.py

Unit tests for the /api/downloads file-listing helpers in dev_server.py:
  - _safe_subpath  : path-traversal containment (the security-critical guard)
  - _list_download_entries : listing shape, sort order, dotfile skipping, href

The handler itself (_serve_downloads) is thin glue over these two helpers plus
_safe_dataset_dir (already covered by test_dev_server_paths.py), so testing the
helpers covers the security surface without standing up an HTTP server.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import dev_server  # noqa: E402


class SafeSubpathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = (Path(self.tmp) / "download").resolve()
        (self.root / "sub").mkdir(parents=True)

    def test_empty_and_dot_are_root(self):
        self.assertEqual(dev_server._safe_subpath(self.root, ""), self.root)
        self.assertEqual(dev_server._safe_subpath(self.root, "."), self.root)
        self.assertEqual(dev_server._safe_subpath(self.root, "/"), self.root)

    def test_valid_subpath(self):
        self.assertEqual(dev_server._safe_subpath(self.root, "sub"), (self.root / "sub").resolve())

    def test_traversal_and_dotfiles_rejected(self):
        bad = [
            "..", "../", "../..", "sub/../..", "../etc/passwd",
            "../../api/config.json", "sub/../../..", "\\..\\..",
            "sub\\..\\..\\..", ".git", "sub/.secret", ".hidden",
            "sub/..", "a/../../b",
        ]
        for b in bad:
            self.assertIsNone(dev_server._safe_subpath(self.root, b), f"should reject {b!r}")

    def test_non_string_and_nul_rejected(self):
        self.assertIsNone(dev_server._safe_subpath(self.root, 5))
        self.assertIsNone(dev_server._safe_subpath(self.root, "a\x00b"))

    def test_none_is_root(self):
        # An absent ?path= param arrives as None and must mean "the root".
        self.assertEqual(dev_server._safe_subpath(self.root, None), self.root)

    def test_never_escapes_root(self):
        # Whatever is returned (non-None) must always stay inside the root —
        # platform-agnostic invariant, including drive-letter / absolute probes.
        probes = ["/etc/passwd", "C:/Windows", "sub", "sub/deep", "weird name.txt", "a/b/c"]
        for p in probes:
            got = dev_server._safe_subpath(self.root, p)
            if got is not None:
                got.relative_to(self.root)  # raises if it escaped


class ListEntriesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = (Path(self.tmp) / "download").resolve()
        self.root.mkdir(parents=True)
        (self.root / "raw.ims").write_bytes(b"x" * 10)
        (self.root / "notes.txt").write_text("hello")
        (self.root / ".hidden").write_text("secret")
        sub = self.root / "images"
        sub.mkdir()
        (sub / "a.png").write_bytes(b"y" * 3)
        (sub / ".dot").write_text("z")

    def test_listing_shape_and_sort(self):
        entries = dev_server._list_download_entries(self.root, self.root, "fixed/Foo", "")
        names = [e["name"] for e in entries]
        self.assertNotIn(".hidden", names)                    # dotfiles skipped
        self.assertEqual(names, ["images", "notes.txt", "raw.ims"])  # dirs first, then files A→Z

        d = next(e for e in entries if e["name"] == "images")
        self.assertEqual(d["kind"], "dir")
        self.assertEqual(d["count"], 1)                       # .dot not counted

        f = next(e for e in entries if e["name"] == "raw.ims")
        self.assertEqual(f["kind"], "file")
        self.assertEqual(f["ext"], "IMS")
        self.assertEqual(f["sizeBytes"], 10)
        self.assertEqual(f["path"], "raw.ims")
        self.assertEqual(f["href"], "DATA_WEB/fixed/Foo/download/raw.ims")

    def test_nested_rel_and_href(self):
        sub = self.root / "images"
        entries = dev_server._list_download_entries(self.root, sub, "fixed/Foo", "images")
        f = next(e for e in entries if e["name"] == "a.png")
        self.assertEqual(f["path"], "images/a.png")
        self.assertEqual(f["href"], "DATA_WEB/fixed/Foo/download/images/a.png")

    def test_missing_target_is_empty(self):
        ghost = self.root / "does-not-exist"
        self.assertEqual(dev_server._list_download_entries(self.root, ghost, "fixed/Foo", "x"), [])


if __name__ == "__main__":
    unittest.main()
