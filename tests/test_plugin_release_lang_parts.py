"""tools/build_plugin_release.py refuses a plugin folder that still carries `lang-parts/`
(the per-package dictionaries of the Advanced Studio's development scaffold: they must be merged
into lang/ and deleted before a release). Offline."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
import tools.build_plugin_release as bpr


class LangPartsGuard(unittest.TestCase):
    def _plugin(self, root: Path, with_parts: bool) -> Path:
        d = root / "studio" / "demo-plugin"
        d.mkdir(parents=True)
        (d / "plugin.json").write_text(json.dumps({"id": "demo-plugin", "name": "Demo", "version": "1.0.0", "placement": "studio"}), encoding="utf-8")
        (d / "index.js").write_text("// demo\n", encoding="utf-8")
        if with_parts:
            (d / "lang-parts").mkdir()
            (d / "lang-parts" / "bg.json").write_text("{}", encoding="utf-8")
        return d

    def test_refuses_lang_parts(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = self._plugin(Path(tmp), True)
            with self.assertRaises(SystemExit) as cm:
                bpr.build(d, Path(tmp) / "out", None)
            self.assertIn("lang-parts", str(cm.exception))

    def test_builds_without_lang_parts(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = self._plugin(Path(tmp), False)
            out = Path(tmp) / "out"
            bpr.build(d, out, None)
            self.assertTrue(any(out.glob("plugin-demo-plugin-1.0.0.zip")))


if __name__ == "__main__":
    unittest.main()
