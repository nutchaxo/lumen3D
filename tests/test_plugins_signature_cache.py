"""/api/plugins: the per-file walk of js/modules is reused for a short TTL and the
compressed body is built once per rebuild, while every input that an operator
changes through the admin (trust epoch, disabled list, trust store) still takes
effect on the very next request.

Run: python tests/test_plugins_signature_cache.py
"""
import gzip
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import dev_server  # noqa: E402


class _FakeHandler:
    def __init__(self, accept_encoding=None):
        self.headers = {"Accept-Encoding": accept_encoding} if accept_encoding else {}
        self.sent = {}
        self.status = None
        self.wfile = io.BytesIO()

    def send_response(self, status):
        self.status = status

    def send_header(self, k, v):
        self.sent[k] = v

    def end_headers(self):
        pass


class PluginsCacheCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-plugins-cache-"))
        self.modules = self.tmp / "modules"
        plug = self.modules / "tools" / "demo"
        plug.mkdir(parents=True)
        (plug / "plugin.json").write_text(json.dumps({"id": "demo", "placement": "tools"}))
        (plug / "index.js").write_text("// demo\n")
        self.disabled = self.tmp / "disabled-plugins.json"
        self.patches = [
            mock.patch.object(dev_server, "MODULES_DIR", self.modules),
            mock.patch.object(dev_server, "DISABLED_PLUGINS_FILE", self.disabled),
            mock.patch.object(dev_server, "TRUST_FILE", self.tmp / "plugin-trust.json"),
            mock.patch.object(dev_server, "_write_plugins_manifest", lambda plugins: None),
            mock.patch.dict(dev_server._PLUGINS_WALK, {"entry": None}),
            mock.patch.dict(dev_server._PLUGINS_CACHE, {"entry": None}),
        ]
        for p in self.patches:
            p.start()
        self.epoch = dev_server._TRUST_EPOCH

    def tearDown(self):
        dev_server._TRUST_EPOCH = self.epoch
        for p in reversed(self.patches):
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _walks(self):
        return mock.patch.object(dev_server.os, "walk", wraps=os.walk)


class TestSignature(PluginsCacheCase):
    def test_walk_reused_within_ttl(self):
        with self._walks() as walk:
            a = dev_server._plugins_signature()
            first = walk.call_count
            b = dev_server._plugins_signature()
        self.assertEqual(first, len(dev_server.PLUGIN_PLACEMENTS))
        self.assertEqual(walk.call_count, first, "second call inside the TTL must not walk")
        self.assertEqual(a, b)

    def test_walk_redone_after_ttl(self):
        a = dev_server._plugins_signature()
        (self.modules / "tools" / "demo" / "index.js").write_text("// demo, edited by hand\n")
        self.assertEqual(dev_server._plugins_signature(), a, "a hand edit may wait for the TTL")
        with mock.patch.object(dev_server, "_CATALOG_SIG_TTL_S", 0.0), self._walks() as walk:
            b = dev_server._plugins_signature()
        self.assertGreater(walk.call_count, 0)
        self.assertNotEqual(a, b)

    def test_trust_epoch_takes_effect_at_once(self):
        a = dev_server._plugins_signature()
        (self.modules / "tools" / "demo" / "index.js").write_text("// installed\n")
        dev_server._TRUST_EPOCH += 1
        with self._walks() as walk:
            b = dev_server._plugins_signature()
        self.assertNotEqual(a, b)
        self.assertGreater(walk.call_count, 0, "an epoch bump re-walks immediately")
        # The re-walk saw the new file: once the epoch is back, the digest differs
        # from the first one too.
        dev_server._TRUST_EPOCH -= 1
        with mock.patch.object(dev_server, "_CATALOG_SIG_TTL_S", 0.0):
            self.assertNotEqual(dev_server._plugins_signature(), a)

    def test_disabled_list_takes_effect_at_once(self):
        a = dev_server._plugins_signature()
        self.disabled.write_text(json.dumps(["tools/demo"]))
        with self._walks() as walk:
            b = dev_server._plugins_signature()
        self.assertNotEqual(a, b)
        self.assertEqual(walk.call_count, 0, "the cheap half alone carries the change")


class TestServeBody(PluginsCacheCase):
    def test_gzip_built_once_and_identical(self):
        with mock.patch.object(dev_server, "_GZIP_MIN_BYTES", 1), \
             mock.patch.object(dev_server.gzip, "compress", wraps=gzip.compress) as comp:
            h1 = _FakeHandler("gzip")
            dev_server.AdminHandler._serve_plugins(h1)
            h2 = _FakeHandler("gzip")
            dev_server.AdminHandler._serve_plugins(h2)
            h3 = _FakeHandler()
            dev_server.AdminHandler._serve_plugins(h3)
        self.assertEqual(comp.call_count, 1)
        for h in (h1, h2):
            self.assertEqual(h.status, 200)
            self.assertEqual(h.sent.get("Content-Encoding"), "gzip")
            self.assertEqual(int(h.sent["Content-Length"]), len(h.wfile.getvalue()))
        self.assertEqual(h1.wfile.getvalue(), h2.wfile.getvalue())
        self.assertNotIn("Content-Encoding", h3.sent)
        self.assertEqual(gzip.decompress(h1.wfile.getvalue()), h3.wfile.getvalue())
        self.assertIn("plugins", json.loads(h3.wfile.getvalue()))

    def test_epoch_bump_rebuilds_body(self):
        h1 = _FakeHandler()
        dev_server.AdminHandler._serve_plugins(h1)
        dev_server._TRUST_EPOCH += 1
        h2 = _FakeHandler()
        dev_server.AdminHandler._serve_plugins(h2)
        self.assertEqual(json.loads(h2.wfile.getvalue())["trustEpoch"], dev_server._TRUST_EPOCH)
        self.assertNotEqual(h1.wfile.getvalue(), h2.wfile.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=1)
