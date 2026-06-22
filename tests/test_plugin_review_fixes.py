"""Regression test for review finding #4 on PR #55: dev_server._write_plugins_manifest
wrote manifest.json with a plain write_text (non-atomic) on every /api/plugins GET —
under ThreadingHTTPServer concurrent loads could interleave-corrupt it. It must use the
atomic helper (temp + os.replace, locked) added in v1.0.45.

Run: py tests/test_plugin_review_fixes.py
"""
import inspect
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import dev_server  # noqa: E402


class TestPluginManifestAtomicWrite(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._orig = dev_server.MODULES_DIR
        dev_server.MODULES_DIR = Path(self.tmp) / "modules"

    def tearDown(self):
        dev_server.MODULES_DIR = self._orig
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_writes_manifest_atomically_no_temp_leftover(self):
        plugins = [
            {"path": "tools/screenshot", "placement": "tools", "id": "screenshot"},
            {"path": "shaders/fluorescence", "placement": "shaders", "id": "fluorescence"},
        ]
        dev_server._write_plugins_manifest(plugins)
        mpath = dev_server.MODULES_DIR / "manifest.json"
        self.assertTrue(mpath.exists(), "manifest.json written")
        data = json.loads(mpath.read_text(encoding="utf-8"))
        self.assertEqual([p["path"] for p in data["plugins"]],
                         ["tools/screenshot", "shaders/fluorescence"], "content correct")
        leftovers = [f for f in dev_server.MODULES_DIR.iterdir() if f.name.startswith(".tmp-")]
        self.assertEqual(leftovers, [], "#4: no temp file left behind (atomic os.replace)")

    def test_uses_atomic_write_helper(self):
        # Structural: the writer routes through _atomic_write, not a bare write_text.
        src = inspect.getsource(dev_server._write_plugins_manifest)
        self.assertIn("_atomic_write(", src, "#4: _write_plugins_manifest uses _atomic_write")
        self.assertNotIn(".write_text(", src, "#4: no bare write_text in the manifest writer")


if __name__ == "__main__":
    unittest.main(verbosity=2)
