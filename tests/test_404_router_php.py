"""Branded 404 and favicon under `php -S` with router.php (the PHP twin of
tests/test_favicon_404.py), on a throwaway copy of the files the router needs.

Run: python tests/test_404_router_php.py
"""
import http.client
import re
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PHP = shutil.which("php") or (r"C:\php-portable\php.exe" if Path(r"C:\php-portable\php.exe").is_file() else None)
HTML = {"Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"}


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class HtaccessRules(unittest.TestCase):
    def test_apache_rewrites_are_guarded(self):
        ht = (ROOT / ".htaccess").read_text(encoding="utf-8")
        block = ht[ht.index("# BEGIN LUMEN3D"):]
        self.assertIn("_serve.php?lumen_favicon=1", block)
        rule = re.search(r"^\s*RewriteRule (\^\(\?!\(\?:api\|DATA_WEB\).*?) _serve\.php\?lumen_404=1 \[NC,L\]$", block, re.M)
        self.assertIsNotNone(rule, "404 rewrite missing")
        conds = [c.strip() for c in block[:rule.start()].rstrip().splitlines()[-3:]]
        self.assertEqual(conds, [
            "RewriteCond %{HTTP_ACCEPT} (^$|text/html)",
            "RewriteCond %{REQUEST_FILENAME} !-f",
            "RewriteCond %{REQUEST_FILENAME} !-d",
        ])
        # The guard rules that answer 404 on purpose come first and keep their answer.
        self.assertLess(block.index("R=404,L"), block.index("lumen_404=1"))

    def test_serve_php_handles_both_flags(self):
        src = (ROOT / "_serve.php").read_text(encoding="utf-8")
        self.assertIn("lumen_favicon", src)
        self.assertIn("lumen_404", src)


@unittest.skipUnless(PHP, "SKIP: php not found")
class PhpServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="lumen-404-"))
        shutil.copytree(ROOT / "api", cls.tmp / "api", ignore=shutil.ignore_patterns(".*", "*.json", "page-drafts"))
        for f in ("router.php", "404.html", "index.html"):
            shutil.copy(ROOT / f, cls.tmp / f)
        (cls.tmp / "assets").mkdir()
        shutil.copy(ROOT / "assets" / "favicon.svg", cls.tmp / "assets" / "favicon.svg")
        (cls.tmp / "js").mkdir()
        (cls.tmp / "js" / "a.js").write_text("var a=1;")
        cls.port = free_port()
        cls.proc = subprocess.Popen([PHP, "-S", f"127.0.0.1:{cls.port}", "router.php"], cwd=str(cls.tmp),
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=10)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def req(self, path, headers=None, method="GET"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        try:
            conn.request(method, path, headers=headers or {})
            resp = conn.getresponse()
            data = resp.read()
            return resp.status, {k.lower(): v for k, v in resp.getheaders()}, data
        finally:
            conn.close()

    def test_missing_page_is_branded_with_status_404(self):
        for path in ("/nope", "/nope.html", "/a/b/c", "/a/b/c.html"):
            st, h, body = self.req(path, HTML)
            self.assertEqual(st, 404, path)
            self.assertIn("text/html", h["content-type"], path)
            self.assertIn(b'data-i18n="app.notFoundTitle"', body, path)
            self.assertIn(b'<base href="/">', body, path)
            self.assertIn("nonce-", h["content-security-policy"], path)

    def test_the_page_itself_is_a_404(self):
        st, _, body = self.req("/404.html")
        self.assertEqual(st, 404)
        self.assertIn(b"notFoundTitle", body)

    def test_existing_page_and_assets_unchanged(self):
        self.assertEqual(self.req("/index.html", HTML)[0], 200)
        st, h, body = self.req("/assets/favicon.svg")
        self.assertEqual(st, 200)
        self.assertTrue(body.lstrip().startswith(b"<svg"))
        self.assertEqual(self.req("/js/a.js")[0], 200)

    def test_plain_answers_for_scripts_api_and_data(self):
        for path in ("/js/missing.js", "/assets/missing.png", "/api/missing", "/api/missing.php",
                     "/DATA_WEB/3d/none/metadata.json", "/DATA_WEB/3d/none"):
            st, h, body = self.req(path, HTML)
            self.assertEqual(st, 404, path)
            self.assertNotIn(b"notFoundTitle", body, path)
        st, _, body = self.req("/nope", {"Accept": "application/json"})
        self.assertNotIn(b"notFoundTitle", body)

    def test_guard_paths_keep_their_answer(self):
        for path in ("/uploads/x", "/secrets/x", "/api/admin_credential.json", "/.git/config"):
            st, _, body = self.req(path, HTML)
            self.assertEqual(st, 403, path)
            self.assertNotIn(b"notFoundTitle", body, path)

    def test_favicon_probe_is_204(self):
        st, h, body = self.req("/favicon.ico")
        self.assertEqual((st, body), (204, b""))
        self.assertIn("max-age", h.get("cache-control", ""))


# What Apache does with the root .htaccess, reproduced by a router that sets the same
# variables before handing over to the real _serve.php (REQUEST_URI stays the original).
EMULATOR = """<?php
$prefix = getenv('LUMEN_TEST_PREFIX') ?: '';
$_SERVER['SCRIPT_NAME'] = $prefix . '/_serve.php';
$p = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (substr($p, -12) === '/favicon.ico') { $_GET['lumen_favicon'] = '1'; }
elseif (substr($p, -5) !== '.html') { $_GET['lumen_404'] = '1'; }
require __DIR__ . '/_serve.php';
"""


@unittest.skipUnless(PHP, "SKIP: php not found")
class ApacheEmulation(unittest.TestCase):
    def _run(self, prefix, path, accept=HTML["Accept"]):
        tmp = Path(tempfile.mkdtemp(prefix="lumen-404a-"))
        try:
            shutil.copytree(ROOT / "api", tmp / "api", ignore=shutil.ignore_patterns(".*", "*.json", "page-drafts"))
            for f in ("_serve.php", "404.html", "index.html"):
                shutil.copy(ROOT / f, tmp / f)
            (tmp / "emulator.php").write_text(EMULATOR)
            port = free_port()
            env = dict(__import__("os").environ, LUMEN_TEST_PREFIX=prefix)
            proc = subprocess.Popen([PHP, "-S", f"127.0.0.1:{port}", "emulator.php"], cwd=str(tmp), env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(100):
                    try:
                        socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                        break
                    except OSError:
                        time.sleep(0.1)
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
                conn.request("GET", path, headers={"Accept": accept})
                resp = conn.getresponse()
                return resp.status, resp.read(), dict((k.lower(), v) for k, v in resp.getheaders())
            finally:
                proc.terminate()
                proc.wait(timeout=10)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_missing_page_at_the_root(self):
        st, body, h = self._run("", "/a/b/c")
        self.assertEqual(st, 404)
        self.assertIn(b'<base href="/">', body)
        self.assertIn(b"notFoundTitle", body)

    def test_missing_page_in_a_subdirectory_keeps_its_base(self):
        st, body, _ = self._run("/tools/webplatform", "/tools/webplatform/a/b/c")
        self.assertEqual(st, 404)
        self.assertIn(b'<base href="/tools/webplatform/">', body)

    def test_missing_html_page(self):
        st, body, _ = self._run("", "/nope.html")
        self.assertEqual(st, 404)
        self.assertIn(b"notFoundTitle", body)

    def test_favicon_probe(self):
        st, body, h = self._run("", "/favicon.ico")
        self.assertEqual((st, body), (204, b""))


if __name__ == "__main__":
    unittest.main()
