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
        self._orig = {k: getattr(ds, k) for k in ("CONFIG_DIR", "CONFIG_DEFAULTS_DIR", "INSTANCE_FILE",
                                                  "THEME_CSS_FILE", "PAGE_DRAFTS_DIR")}
        ds.CONFIG_DIR = self.tmp / "config"
        ds.CONFIG_DEFAULTS_DIR = self.tmp / "config" / "defaults" / "neutral"
        ds.INSTANCE_FILE = self.tmp / "config" / "instance.json"
        ds.THEME_CSS_FILE = self.tmp / "config" / "theme.css"
        ds.PAGE_DRAFTS_DIR = self.tmp / "api" / "page-drafts"
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
        # The draft is readable by the operator, and ONLY by the operator.
        self.assertEqual(ds._load_site_admin("pages/home")["draft"]["blocks"][0]["type"], "heading")
        ds._publish_site_doc("pages/home")
        self.assertEqual(len(ds._load_site_admin("pages/home")["published"]["blocks"]), 1)
        # invalid doc names are rejected, not written
        self.assertFalse(ds._save_site_doc("../evil", {"x": 1}))
        # reset restores the shipped neutral default
        ds._save_site_doc("legal", {"sections": [{"title": {"en": "X"}}]})
        ds._reset_site_doc("legal")
        self.assertEqual(ds._load_site_doc("legal"), {"sections": []})

    def test_draft_never_reaches_the_public_tree(self):
        """config/pages/<slug>.json is served statically to every visitor, so an
        unpublished draft must never be stored in it (nor returned to an anon read)."""
        ds._save_site_doc("pages/home", {"published": {"blocks": []},
                                         "draft": {"blocks": [{"type": "heading", "text": "SECRET"}]}})
        on_disk = json.loads((ds.CONFIG_DIR / "pages" / "home.json").read_text(encoding="utf-8"))
        self.assertNotIn("draft", on_disk)
        self.assertNotIn("SECRET", json.dumps(on_disk))
        self.assertNotIn("draft", ds._load_site_public("pages/home"))
        self.assertIn("draft", ds._load_site_admin("pages/home"))
        # The draft lives under api/, which _is_forbidden_static blocks.
        self.assertTrue((ds.PAGE_DRAFTS_DIR / "home.json").is_file())
        self.assertTrue(ds._is_forbidden_static("api/page-drafts/home.json"))
        # Deleting the page takes its draft with it (no orphaned unpublished content).
        ds._delete_site_doc("pages/home")
        self.assertFalse((ds.PAGE_DRAFTS_DIR / "home.json").exists())

    def test_legacy_inline_draft_is_migrated_out(self):
        """Documents written before the split kept the draft inline; the one-shot
        migration must strip the public copy while preserving published content."""
        (ds.CONFIG_DIR / "pages").mkdir(parents=True, exist_ok=True)
        legacy = ds.CONFIG_DIR / "pages" / "old.json"
        legacy.write_text(json.dumps({"published": {"blocks": [{"type": "text"}]},
                                      "draft": {"blocks": [{"type": "heading", "text": "SECRET"}]}}),
                          encoding="utf-8")
        ds._migrate_inline_drafts()
        on_disk = json.loads(legacy.read_text(encoding="utf-8"))
        self.assertNotIn("draft", on_disk)
        self.assertEqual(len(on_disk["published"]["blocks"]), 1)   # published untouched
        self.assertEqual(ds._load_site_admin("pages/old")["draft"]["blocks"][0]["text"], "SECRET")

    def test_migration_never_destroys_a_draft_it_could_not_park(self):
        """The public copy is the ONLY copy of a legacy draft. If parking it fails —
        a read-only api/, a full disk — stripping the public file anyway would
        destroy the operator's unpublished work to fix a confidentiality bug. The
        sweep must leave that page untouched AND stay unmarked so it retries."""
        (ds.CONFIG_DIR / "pages").mkdir(parents=True, exist_ok=True)
        legacy = ds.CONFIG_DIR / "pages" / "stuck.json"
        legacy.write_text(json.dumps({"published": {"blocks": []},
                                      "draft": {"blocks": [{"type": "heading", "text": "SECRET"}]}}),
                          encoding="utf-8")
        # A FILE where the draft directory must be: every write under it now fails.
        ds.PAGE_DRAFTS_DIR.parent.mkdir(parents=True, exist_ok=True)
        ds.PAGE_DRAFTS_DIR.write_text("not a directory", encoding="utf-8")

        ds._migrate_inline_drafts()

        on_disk = json.loads(legacy.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["draft"]["blocks"][0]["text"], "SECRET")  # not destroyed
        self.assertFalse(ds.PAGE_DRAFTS_DIR.is_dir())                     # nothing parked
        self.assertTrue(ds.PAGE_DRAFTS_DIR.is_file())                     # marker not written

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
