"""White-label site-config store (/api/site.php) — dev_server.py.

Covers the config-doc store (instance/theme/legal/pages), the {{SITE:…}} head
injection, the theme.css compiler + value scrubbing, and a regression guard for
the v1.11.2 bug where /api/site.php was routed in do_GET but not do_POST.
"""
import inspect
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dev_server as ds


class SiteConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._orig = {k: getattr(ds, k) for k in ("CONFIG_DIR", "CONFIG_DEFAULTS_DIR", "INSTANCE_FILE", "THEME_CSS_FILE")}
        ds.CONFIG_DIR = self.tmp / "config"
        ds.CONFIG_DEFAULTS_DIR = self.tmp / "config" / "defaults" / "neutral"
        ds.INSTANCE_FILE = self.tmp / "config" / "instance.json"
        ds.THEME_CSS_FILE = self.tmp / "config" / "theme.css"
        ds.CONFIG_DEFAULTS_DIR.mkdir(parents=True, exist_ok=True)
        (ds.CONFIG_DEFAULTS_DIR / "legal.json").write_text('{"sections": []}', encoding="utf-8")
        ds._INSTANCE_CACHE.update({"sig": None, "data": {}})

    def tearDown(self):
        for k, v in self._orig.items():
            setattr(ds, k, v)
        ds._INSTANCE_CACHE.update({"sig": None, "data": {}})
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_doc_path_safety(self):
        self.assertIsNone(ds._site_doc_path("../secret"))
        self.assertIsNone(ds._site_doc_path("pages/../../etc"))
        self.assertIsNone(ds._site_doc_path("pages/Bad Slug"))
        self.assertIsNone(ds._site_doc_path("unknown"))
        self.assertIsNotNone(ds._site_doc_path("instance"))
        self.assertIsNotNone(ds._site_doc_path("pages/home"))

    def test_save_load_publish_reset(self):
        self.assertTrue(ds._save_site_doc("pages/home", {"draft": {"blocks": [{"type": "heading"}]}, "published": {"blocks": []}}))
        self.assertEqual(ds._load_site_doc("pages/home")["draft"]["blocks"][0]["type"], "heading")
        ds._publish_site_doc("pages/home")
        self.assertEqual(len(ds._load_site_doc("pages/home")["published"]["blocks"]), 1)
        # invalid doc names are rejected, not written
        self.assertFalse(ds._save_site_doc("../evil", {"x": 1}))
        # reset restores the shipped neutral default
        ds._save_site_doc("legal", {"sections": [{"title": {"en": "X"}}]})
        ds._reset_site_doc("legal")
        self.assertEqual(ds._load_site_doc("legal"), {"sections": []})

    def test_site_placeholder_injection(self):
        ds.INSTANCE_FILE.parent.mkdir(parents=True, exist_ok=True)
        ds.INSTANCE_FILE.write_text(json.dumps({"brand": {"name": "Acme & Co"}}), encoding="utf-8")
        ds._INSTANCE_CACHE.update({"sig": None, "data": {}})
        out = ds._apply_site_placeholders("<title>{{SITE:brand.name|Fallback}}</title> {{SITE:seo.description|Def}}")
        self.assertIn("Acme &amp; Co", out)   # value resolved + HTML-escaped
        self.assertIn("Def", out)             # fallback used for a missing key
        self.assertNotIn("{{SITE:", out)      # no leftover placeholder

    def test_theme_css_generation_and_scrub(self):
        css = ds._generate_theme_css({
            "tokens": {"--color-primary": "#123456", "badname": "x", "--evil": "red; } body{display:none}"},
            "dark": {"--bg-surface": "#000"},
        })
        self.assertIn(":root{", css)
        self.assertIn("--color-primary:#123456", css)
        self.assertNotIn("badname", css)      # a non---prefixed token name is dropped
        self.assertNotIn("body{", css)        # scrubbed: operator value cannot open a new rule
        self.assertNotIn("; }", css)          # scrubbed: cannot close :root early
        self.assertIn('[data-theme="dark"]', css)

    def test_post_route_regression(self):
        # v1.11.2: /api/site.php MUST be routed in BOTH do_GET and do_POST — otherwise
        # every admin save (theme/branding/pages/legal) 405s on the Python dev server.
        self.assertIn("/api/site.php", inspect.getsource(ds.AdminHandler.do_GET))
        self.assertIn("/api/site.php", inspect.getsource(ds.AdminHandler.do_POST))


if __name__ == "__main__":
    unittest.main()
