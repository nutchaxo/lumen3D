"""Server features the admin client relies on, over real HTTP (dev_server.py).

* api/site.php: an admin read carries the doc revision (X-Lumen-Rev); a write sent
  with a stale ?rev= is a 409 and writes nothing; save_draft writes the draft (and
  title) only, never the published block; ?merge= replaces only the listed paths of
  instance.json; an anonymous read of a page is a 401 (the public pages read the
  static published copy).
* api/datasets.php?action=gallery_add takes the image as its raw bytes (magic-byte
  check kept), refuses an oversized body before reading it, and `list` states the
  ceiling (galleryMaxBytes).
* api/upload.php?action=ping: 200 for a signed-in admin, 401 otherwise.
* The login throttle answers 429 with Retry-After, and a wrong current password in
  change_password costs an attempt like a login.
* The static cache policy (same table as the root .htaccess) and the directory
  guards (written only when the marker is missing).

The PHP twins are held to the same answers by tests/test_backend2_twins_parity.php.
"""
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import dev_server  # noqa: E402
import upload_staging as us  # noqa: E402

PASSWORD = "test-password-1234"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


class ServerApiCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="lumen-b2-"))
        (cls.tmp / "api").mkdir(parents=True, exist_ok=True)
        (cls.tmp / "DATA_WEB" / "3d" / "G").mkdir(parents=True, exist_ok=True)
        (cls.tmp / "DATA_WEB" / "3d" / "G" / "metadata.json").write_text(
            json.dumps({"name": "G", "type": "3d", "id": "3d/G"}), encoding="utf-8")
        (cls.tmp / "changelog").mkdir(exist_ok=True)
        (cls.tmp / "changelog" / "changelog_1.56.2.md").write_text("x", encoding="utf-8")
        keys = ("ROOT", "DATA_WEB", "CRED_FILE", "UPLOADS_DIR", "CHANGELOG_DIR", "CONFIG_DIR",
                "CONFIG_DEFAULTS_DIR", "INSTANCE_FILE", "THEME_CSS_FILE", "PAGE_DRAFTS_DIR",
                "MAX_GALLERY_BYTES")
        cls._saved = {k: getattr(dev_server, k) for k in keys}
        dev_server.ROOT = cls.tmp
        dev_server.DATA_WEB = cls.tmp / "DATA_WEB"
        dev_server.CRED_FILE = cls.tmp / "api" / "admin_credential.json"
        dev_server.UPLOADS_DIR = cls.tmp / "uploads"
        dev_server.CHANGELOG_DIR = cls.tmp / "changelog"
        dev_server.CONFIG_DIR = cls.tmp / "config"
        dev_server.CONFIG_DEFAULTS_DIR = cls.tmp / "config" / "defaults" / "neutral"
        dev_server.INSTANCE_FILE = cls.tmp / "config" / "instance.json"
        dev_server.THEME_CSS_FILE = cls.tmp / "config" / "theme.css"
        dev_server.PAGE_DRAFTS_DIR = cls.tmp / "api" / "page-drafts"
        dev_server.CONFIG_DEFAULTS_DIR.mkdir(parents=True, exist_ok=True)
        us.configure(cls.tmp)
        us.ensure_dirs()
        dev_server._write_credential_force("admin", PASSWORD)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), dev_server.AdminHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        for k, v in cls._saved.items():
            setattr(dev_server, k, v)
        us.configure(Path(ROOT))
        dev_server._BRUTE.clear()
        dev_server._BRUTE_GLOBAL.update(start=0.0, count=0)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.cookie = None
        self.csrf = None
        dev_server._BRUTE.clear()
        dev_server._BRUTE_GLOBAL.update(start=0.0, count=0)

    def request(self, method, path, body=None, headers=None, raw=False):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        h = dict(headers or {})
        if self.cookie:
            h["Cookie"] = self.cookie
        if self.csrf:
            h["X-CSRF-Token"] = self.csrf
        payload = body
        if body is not None and not raw:
            payload = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
        try:
            conn.request(method, path, body=payload, headers=h)
            res = conn.getresponse()
            data = res.read()
            try:
                parsed = json.loads(data.decode() or "{}")
            except ValueError:
                parsed = {}
            return res.status, {k.lower(): v for k, v in res.getheaders()}, parsed
        finally:
            conn.close()

    def login(self):
        st, hdrs, data = self.request("POST", "/api/auth.php?action=login",
                                      {"username": "admin", "password": PASSWORD})
        self.assertEqual(st, 200, data)
        self.cookie = hdrs.get("set-cookie", "").split(";")[0]
        self.csrf = data["csrf"]

    # ── site.php ────────────────────────────────────────────────────────────────

    def test_anonymous_page_read_is_refused_but_instance_is_public(self):
        st, _h, _d = self.request("GET", "/api/site.php?action=get&doc=pages/news")
        self.assertEqual(st, 401)
        st, _h, _d = self.request("GET", "/api/site.php?action=get&doc=instance")
        self.assertEqual(st, 200)

    def test_save_draft_keeps_published_and_a_stale_revision_is_refused(self):
        self.login()
        st, _h, d = self.request("POST", "/api/site.php?action=save&doc=pages/news",
                                 {"title": {"en": "News"}, "published": {"sections": [{"id": "p1"}]},
                                  "draft": {"sections": [{"id": "d1"}]}})
        self.assertEqual(st, 200, d)
        st, h, doc = self.request("GET", "/api/site.php?action=get&doc=pages/news")
        rev = h.get("x-lumen-rev")
        self.assertTrue(rev)
        self.assertEqual(doc["draft"]["sections"][0]["id"], "d1")

        # Another editor publishes something else meanwhile.
        st, _h, d = self.request("POST", "/api/site.php?action=save&doc=pages/news",
                                 {"title": {"en": "News"}, "published": {"sections": [{"id": "p9"}]},
                                  "draft": {"sections": [{"id": "x"}]}})
        self.assertEqual(st, 200)

        st, _h, d = self.request("POST", f"/api/site.php?action=save_draft&doc=pages/news&rev={rev}",
                                 {"draft": {"sections": [{"id": "d2"}]}})
        self.assertEqual(st, 409, d)
        self.assertEqual(d.get("error"), "stale")
        self.assertEqual(self.request("GET", "/api/site.php?action=get&doc=pages/news")[2]["draft"]["sections"][0]["id"], "x",
                         "a refused save writes nothing")

        current = d["rev"]
        st, _h, d = self.request("POST", f"/api/site.php?action=save_draft&doc=pages/news&rev={current}",
                                 {"draft": {"sections": [{"id": "d3"}]}, "title": {"en": "Renamed"}})
        self.assertEqual(st, 200, d)
        self.assertNotEqual(d["rev"], current)
        st, h, doc = self.request("GET", "/api/site.php?action=get&doc=pages/news")
        self.assertEqual(doc["draft"]["sections"][0]["id"], "d3")
        self.assertEqual(doc["published"]["sections"][0]["id"], "p9", "save_draft never touches published")
        self.assertEqual(doc["title"], {"en": "Renamed"})
        self.assertEqual(h.get("x-lumen-rev"), d["rev"], "the revision a write returns is the one a read reports")
        public = json.loads((dev_server.CONFIG_DIR / "pages" / "news.json").read_text(encoding="utf-8"))
        self.assertNotIn("draft", public, "the draft never reaches the public tree")

        st, _h, d = self.request("POST", "/api/site.php?action=save_draft&doc=instance", {"draft": {}})
        self.assertEqual(st, 400, "save_draft is for pages only")

    def test_merge_replaces_only_the_listed_paths(self):
        self.login()
        self.request("POST", "/api/site.php?action=save&doc=instance",
                     {"brand": {"name": "Old", "accent": "keep"}, "variables": {"v": 1},
                      "nav": {"showAbout": True, "customPages": [{"slug": "p"}]}})
        st, _h, d = self.request("POST", "/api/site.php?action=save&doc=instance&merge=brand.name,nav.showAbout",
                                 {"brand": {"name": "New"}, "nav": {"showAbout": False}, "variables": {"v": 99}})
        self.assertEqual(st, 200, d)
        doc = self.request("GET", "/api/site.php?action=get&doc=instance")[2]
        self.assertEqual(doc["brand"], {"name": "New", "accent": "keep"})
        self.assertEqual(doc["nav"], {"showAbout": False, "customPages": [{"slug": "p"}]})
        self.assertEqual(doc["variables"], {"v": 1}, "an unlisted key is never written")
        st, _h, _d = self.request("POST", "/api/site.php?action=save&doc=instance&merge=../x", {})
        self.assertEqual(st, 400)
        st, _h, _d = self.request("POST", "/api/site.php?action=save&doc=pages/news&merge=title",
                                  {"title": "x"})
        self.assertEqual(st, 400, "pages are written with save / save_draft, not merged")

    # ── gallery_add (raw body) ──────────────────────────────────────────────────

    def test_gallery_takes_raw_image_bytes(self):
        self.login()
        st, _h, d = self.request("GET", "/api/datasets.php?action=list")
        self.assertEqual(d.get("galleryMaxBytes"), dev_server.MAX_GALLERY_BYTES)
        st, _h, d = self.request("POST", "/api/datasets.php?action=gallery_add&id=3d/G&filename=fig%201.png&caption=hello",
                                 PNG, {"Content-Type": "image/png"}, raw=True)
        self.assertEqual(st, 200, d)
        self.assertTrue(d["item"]["file"].endswith(".png"))
        self.assertEqual(d["item"].get("caption"), "hello")
        st, _h, d = self.request("POST", "/api/datasets.php?action=gallery_add&id=3d/G&filename=x.png",
                                 b"<?php echo 1; ?>", {"Content-Type": "image/png"}, raw=True)
        self.assertEqual(st, 400, "the magic bytes decide, not the declared type")
        try:
            dev_server.MAX_GALLERY_BYTES = 32
            st, _h, d = self.request("POST", "/api/datasets.php?action=gallery_add&id=3d/G",
                                     PNG, {"Content-Type": "image/png"}, raw=True)
        finally:
            dev_server.MAX_GALLERY_BYTES = self._saved["MAX_GALLERY_BYTES"]
        self.assertEqual(st, 413)
        self.assertEqual(d.get("error"), "too_large")
        self.csrf = None
        st, _h, _d = self.request("POST", "/api/datasets.php?action=gallery_add&id=3d/G",
                                  PNG, {"Content-Type": "image/png"}, raw=True)
        self.assertEqual(st, 403, "a raw upload still needs the CSRF token")

    # ── upload ping ─────────────────────────────────────────────────────────────

    def test_upload_ping(self):
        st, _h, _d = self.request("GET", "/api/upload.php?action=ping")
        self.assertEqual(st, 401)
        self.login()
        st, h, d = self.request("GET", "/api/upload.php?action=ping")
        self.assertEqual((st, d), (200, {"ok": True}))
        self.assertIn("no-store", h.get("cache-control", ""))

    # ── throttle ────────────────────────────────────────────────────────────────

    def test_login_throttle_answers_429_with_retry_after(self):
        for _ in range(dev_server.MAX_ATTEMPTS):
            st, _h, _d = self.request("POST", "/api/auth.php?action=login",
                                      {"username": "admin", "password": "wrong-password"})
            self.assertEqual(st, 401)
        st, h, d = self.request("POST", "/api/auth.php?action=login",
                                {"username": "admin", "password": PASSWORD})
        self.assertEqual(st, 429, "locked: even the right password waits")
        self.assertTrue(int(h.get("retry-after", "0")) > 0)
        self.assertTrue(d.get("retryAfter"))

    def test_change_password_costs_an_attempt(self):
        self.login()
        dev_server._BRUTE.clear()
        for _ in range(dev_server.MAX_ATTEMPTS):
            st, _h, _d = self.request("POST", "/api/auth.php?action=change_password",
                                      {"current": "nope-nope", "new": "another-password"})
            self.assertEqual(st, 401)
        st, _h, _d = self.request("POST", "/api/auth.php?action=change_password",
                                  {"current": PASSWORD, "new": "another-password"})
        self.assertEqual(st, 429)


class CachePolicyAndGuards(unittest.TestCase):
    def test_cache_table_matches_the_htaccess(self):
        p = dev_server._static_cache_policy
        year, week = "public, max-age=31536000, immutable", "public, max-age=604800, immutable"
        self.assertEqual(p("data_web/3d/x/bricks/lod0/c0/pack_00.bin", "v=abc"), year)
        self.assertEqual(p("data_web/3d/x/bricks/lod0/c0/pack_00.bin", ""), "no-cache")
        self.assertEqual(p("js/core/utils.js", "v=1.56.2"), week)
        self.assertEqual(p("css/base.css", "v="), week, "an empty v= counts, as (^|&)v= does")
        self.assertEqual(p("js/core/utils.js", ""), "no-cache")
        self.assertEqual(p("lang/en.json", "v=1"), "no-cache")
        self.assertEqual(p("data_web/3d/x/bricks/manifest.json", ""), "no-cache")
        ht = Path(ROOT, ".htaccess").read_text(encoding="utf-8")
        self.assertIn("E=LUMEN_VERSIONED_PACK:1", ht)
        self.assertIn('Header set Cache-Control "public, max-age=31536000, immutable" env=LUMEN_VERSIONED_PACK', ht)
        self.assertIn('Header set Cache-Control "public, max-age=604800, immutable" env=LUMEN_VERSIONED', ht)
        self.assertNotIn("<If ", ht, "no Apache 2.4-only container: a 2.2 core would answer 500")

    def test_guard_written_only_when_the_marker_is_missing(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            target = tmp / ".htaccess"
            target.write_text("# old guard without marker\nOptions -Indexes\n", encoding="utf-8")
            us.write_guard(target, us.DATA_WEB_GUARD)
            self.assertEqual(target.read_text(encoding="utf-8"), us.DATA_WEB_GUARD, "an old guard is replaced")
            marked = "# operator copy (" + us.GUARD_MARKER + ") with a local tweak\n"
            target.write_text(marked, encoding="utf-8")
            us.write_guard(target, us.DATA_WEB_GUARD)
            self.assertEqual(target.read_text(encoding="utf-8"), marked, "a marked guard is left alone")
            us.write_guard(tmp / "missing-dir" / ".htaccess", us.DATA_WEB_GUARD)
            self.assertFalse((tmp / "missing-dir").exists(), "no directory is created for a guard")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
