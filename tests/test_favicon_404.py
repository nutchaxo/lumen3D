"""Favicon and branded 404 of the Python server.

Every public page declares assets/favicon.svg, the implicit /favicon.ico probe is
answered without a 404, and a missing PAGE gets the branded 404.html with status 404
while missing scripts, API routes and DATA_WEB paths stay plain.

Run: python tests/test_favicon_404.py
"""
import http.client
import os
import re
import sys
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)
import dev_server  # noqa: E402

PAGES = ("index", "explorer", "viewer", "2d", "compare", "about", "page", "legal", "admpan")
HTML = {"Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"}


class TestStaticMarkup(unittest.TestCase):
    def test_every_page_declares_the_icon_and_a_noscript_notice(self):
        for name in PAGES + ("404",):
            text = (ROOT / f"{name}.html").read_text(encoding="utf-8")
            self.assertIn('rel="icon"', text, name)
            self.assertIn('href="assets/favicon.svg"', text, name)
            self.assertIn('name="theme-color"', text, name)
            self.assertRegex(text, r'<noscript><div class="noscript-notice"', name)

    def test_favicon_is_a_light_dark_svg(self):
        svg = (ROOT / "assets/favicon.svg").read_text(encoding="utf-8")
        self.assertIn("<svg", svg)
        self.assertIn("prefers-color-scheme", svg)
        self.assertNotIn("<script", svg)

    def test_404_page_uses_relative_urls_under_a_base(self):
        text = (ROOT / "404.html").read_text(encoding="utf-8")
        self.assertIn('<base href="./">', text)
        for url in re.findall(r'(?:src|href)="([^"]+)"', text):
            if url.startswith(("http", "#")):
                continue
            self.assertFalse(url.startswith("/"), url)


class TestLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = dev_server._QuietServer(("127.0.0.1", 0), dev_server.AdminHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def req(self, method, path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        try:
            conn.request(method, path, headers=headers or {})
            resp = conn.getresponse()
            data = resp.read()
            return resp.status, {k.lower(): v for k, v in resp.getheaders()}, data
        finally:
            conn.close()

    def test_favicon_is_served_and_allowed_by_the_csp(self):
        st, h, body = self.req("GET", "/assets/favicon.svg")
        self.assertEqual(st, 200)
        self.assertIn("svg", h.get("content-type", ""))
        self.assertTrue(body.lstrip().startswith(b"<svg"))
        st, h, _ = self.req("GET", "/index.html")
        self.assertEqual(st, 200)
        self.assertIn("img-src 'self'", h["content-security-policy"])

    def test_favicon_ico_probe_is_not_a_404(self):
        st, h, body = self.req("GET", "/favicon.ico")
        self.assertEqual((st, body), (204, b""))
        self.assertIn("max-age", h.get("cache-control", ""))
        self.assertEqual(self.req("HEAD", "/favicon.ico")[0], 204)

    def test_missing_page_is_the_branded_404(self):
        for path in ("/nope", "/nope.html", "/a/b/c", "/a/b/c.html", "/js/nope"):
            st, h, body = self.req("GET", path, HTML)
            self.assertEqual(st, 404, path)
            self.assertIn("text/html", h["content-type"], path)
            self.assertIn(b'data-i18n="app.notFoundTitle"', body, path)
            self.assertIn(b'<base href="/">', body, path)
            self.assertNotIn(b"{{CSP_NONCE}}", body)
            self.assertIn("nonce-", h["content-security-policy"], path)

    def test_the_404_page_itself_answers_404_and_head_has_no_body(self):
        st, h, body = self.req("GET", "/404.html")
        self.assertEqual(st, 404)
        self.assertIn(b"notFoundTitle", body)
        st, h, body = self.req("HEAD", "/missing-page", HTML)
        self.assertEqual((st, body), (404, b""))
        self.assertIn("text/html", h["content-type"])

    def test_assets_api_and_data_misses_stay_plain(self):
        for path in ("/js/missing.js", "/css/missing.css", "/assets/missing.png",
                     "/api/missing", "/api/missing.php", "/DATA_WEB/3d/none/metadata.json",
                     "/DATA_WEB/3d/none"):
            st, h, body = self.req("GET", path, HTML)
            self.assertEqual(st, 404, path)
            self.assertNotIn(b"notFoundTitle", body, path)
            self.assertIn("application/json", h.get("content-type", ""), path)

    def test_non_html_clients_get_the_plain_answer(self):
        st, h, body = self.req("GET", "/nope", {"Accept": "application/json"})
        self.assertEqual(st, 404)
        self.assertNotIn(b"notFoundTitle", body)

    def test_guarded_paths_keep_their_answer(self):
        for path in ("/uploads/x", "/secrets/x", "/api/admin_credential.json", "/.git/config"):
            st, _, body = self.req("GET", path, HTML)
            self.assertEqual(st, 404, path)
            self.assertNotIn(b"notFoundTitle", body, path)


if __name__ == "__main__":
    unittest.main()
