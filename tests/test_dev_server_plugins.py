"""Unit tests for dev_server.py plugin auto-discovery (/api/plugins).

Covers the scan that lets the platform incorporate plugins by folder presence:
  - the real js/modules/ tree yields the expected built-in set
  - a dropped-in folder is discovered; a removed one disappears
  - a malformed plugin.json is skipped, not fatal (rule 1.1)
  - a placement mismatch (plugin.json placement != directory) is rejected
  - unsafe folder names are ignored (rule 1.4, no traversal)
  - _write_plugins_manifest emits the static fallback shape

Run: py tests/test_dev_server_plugins.py
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import dev_server  # noqa: E402


class TestRealTree(unittest.TestCase):
    def test_builtin_plugins_discovered(self):
        plugins = dev_server._list_plugins()
        ids = {p["id"] for p in plugins}
        # Every plugin carries a derived path + placement matching its directory.
        for p in plugins:
            self.assertIn("path", p)
            self.assertEqual(p["path"].split("/")[0], p["placement"])
        self.assertEqual(len(plugins), 18, "18 built-in plugins discovered from js/modules/")
        self.assertEqual(
            {p["placement"] for p in plugins}, {"tools", "channels", "shaders"}
        )
        for must in ("screenshot", "histogram", "fluorescence", "measure-distance"):
            self.assertIn(must, ids)


class TestIsolatedTree(unittest.TestCase):
    """Drive _list_plugins against a temp js/modules/ to test add/remove/skip."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.mods = Path(self.tmp) / "js" / "modules"
        (self.mods / "tools").mkdir(parents=True)
        (self.mods / "channels").mkdir(parents=True)
        (self.mods / "shaders").mkdir(parents=True)
        self._orig = dev_server.MODULES_DIR
        dev_server.MODULES_DIR = self.mods

    def tearDown(self):
        dev_server.MODULES_DIR = self._orig
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, placement, name, meta):
        d = self.mods / placement / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "plugin.json").write_text(json.dumps(meta), encoding="utf-8")

    def test_add_and_remove(self):
        self._write("tools", "alpha", {"id": "alpha", "placement": "tools"})
        ids = {p["id"] for p in dev_server._list_plugins()}
        self.assertEqual(ids, {"alpha"})

        self._write("tools", "beta", {"id": "beta", "placement": "tools"})
        ids = {p["id"] for p in dev_server._list_plugins()}
        self.assertEqual(ids, {"alpha", "beta"}, "dropped-in folder is discovered")

        import shutil
        shutil.rmtree(self.mods / "tools" / "beta")
        ids = {p["id"] for p in dev_server._list_plugins()}
        self.assertEqual(ids, {"alpha"}, "removed folder disappears")

    def test_malformed_json_skipped(self):
        self._write("tools", "good", {"id": "good", "placement": "tools"})
        (self.mods / "tools" / "bad").mkdir()
        (self.mods / "tools" / "bad" / "plugin.json").write_text("{ not json ", encoding="utf-8")
        ids = {p["id"] for p in dev_server._list_plugins()}
        self.assertEqual(ids, {"good"}, "malformed plugin.json skipped, scan not aborted")

    def test_placement_mismatch_rejected(self):
        # plugin.json claims 'shaders' but lives under tools/ → rejected
        self._write("tools", "liar", {"id": "liar", "placement": "shaders"})
        ids = {p["id"] for p in dev_server._list_plugins()}
        self.assertNotIn("liar", ids, "placement-from-directory contract enforced")

    def test_unsafe_folder_name_ignored(self):
        safe = self.mods / "tools" / "ok"
        safe.mkdir()
        (safe / "plugin.json").write_text(json.dumps({"id": "ok"}), encoding="utf-8")
        # A dotfile-style folder fails _SAFE_FOLDER_RE and is skipped.
        bad = self.mods / "tools" / ".hidden"
        bad.mkdir()
        (bad / "plugin.json").write_text(json.dumps({"id": "hidden"}), encoding="utf-8")
        ids = {p["id"] for p in dev_server._list_plugins()}
        self.assertEqual(ids, {"ok"})

    def test_write_manifest_shape(self):
        self._write("tools", "alpha", {"id": "alpha", "placement": "tools"})
        self._write("shaders", "beam", {"id": "beam", "placement": "shaders"})
        dev_server._write_plugins_manifest(dev_server._list_plugins())
        manifest = json.loads((self.mods / "manifest.json").read_text(encoding="utf-8"))
        self.assertIn("plugins", manifest)
        for entry in manifest["plugins"]:
            self.assertEqual(set(entry.keys()), {"path", "placement", "id"})
        paths = {e["path"] for e in manifest["plugins"]}
        self.assertEqual(paths, {"tools/alpha", "shaders/beam"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
