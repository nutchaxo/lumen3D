"""Downloads counted on PHP hosts (web 1.59.4).

Apache serves DATA_WEB/<type>/<folder>/download/ straight from disk, so before
1.59.4 nothing on a PHP host ever fed the Downloads statistic. Now:
  * Apache: the root .htaccess sends a full GET of an existing file under
    download/ (no Range, not already marked lumen_dl=1) to api/download.php,
    which counts it and answers a 302 to the same file marked lumen_dl=1;
  * php -S: router.php counts it and lets the built-in server serve the file.
Both call lumen_count_download (api/_admin_lib.php), the twin of
dev_server.py _maybe_count_download: a HEAD, a Range continuation, a missing
file, an unknown dataset or a traversal never counts.

This test runs a throwaway copy of the tree under `php -S` with router.php.

Run: python tests/test_download_count_php.py
"""
import http.client
import json
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PHP = shutil.which("php")


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class HtaccessRule(unittest.TestCase):
    def test_rewrite_present(self):
        ht = (ROOT / ".htaccess").read_text(encoding="utf-8")
        block = ht[ht.index("# BEGIN LUMEN3D"):]
        rule = re.search(r"^\s*RewriteRule \^DATA_WEB/\(\[\^/\]\+\)/\(\[\^/\]\+\)/download/\(\.\+\)\$ "
                         r"api/download\.php\?lumen_path=DATA_WEB/\$1/\$2/download/\$3 \[B,L,QSA\]$", block, re.M)
        self.assertIsNotNone(rule, "download rewrite missing from the LUMEN3D block")
        conds = block[:rule.start()].rstrip().splitlines()[-4:]
        self.assertEqual([c.strip() for c in conds], [
            "RewriteCond %{REQUEST_METHOD} =GET",
            "RewriteCond %{HTTP:Range} ^$",
            "RewriteCond %{QUERY_STRING} !(^|&)lumen_dl=1(&|$)",
            "RewriteCond %{REQUEST_FILENAME} -f",
        ])


@unittest.skipUnless(PHP, "php not found")
class PhpServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="lumen-dl-"))
        (cls.tmp / "api").mkdir()
        for f in ("_admin_lib.php", "download.php"):
            shutil.copy(ROOT / "api" / f, cls.tmp / "api" / f)
        shutil.copy(ROOT / "router.php", cls.tmp / "router.php")
        (cls.tmp / "changelog").mkdir()
        (cls.tmp / "changelog" / "changelog_1.59.4.md").write_text("x")
        ds = cls.tmp / "DATA_WEB" / "3d" / "embryo-1"
        (ds / "download" / "sub").mkdir(parents=True)
        (ds / "metadata.json").write_text("{}")
        (ds / "download" / "volume.ims").write_bytes(b"0123456789" * 100)
        (ds / "download" / "sub" / "a&b 1%.tif").write_bytes(b"tiff")
        (cls.tmp / "DATA_WEB" / "3d" / "secret.txt").write_text("no")
        cls.port = free_port()
        cls.proc = subprocess.Popen([PHP, "-S", f"127.0.0.1:{cls.port}", "router.php"], cwd=str(cls.tmp),
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=10)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def req(self, method, path, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request(method, path, headers=headers or {})
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, dict(r.getheaders()), body

    def downloads(self):
        p = self.tmp / "api" / "stats.json"
        if not p.exists():
            return 0, {}
        d = json.loads(p.read_text())
        return d.get("global", {}).get("downloads", 0), {k: v.get("downloads", 0) for k, v in d.get("datasets", {}).items()}

    def test_counting(self):
        base, _ = self.downloads()
        # php -S: router.php counts a full GET and serves the file.
        st, _, body = self.req("GET", "/DATA_WEB/3d/embryo-1/download/volume.ims")
        self.assertEqual((st, len(body)), (200, 1000))
        self.assertEqual(self.downloads()[0], base + 1)
        # Not a new download: HEAD, a Range continuation.
        self.req("HEAD", "/DATA_WEB/3d/embryo-1/download/volume.ims")
        st, _, _ = self.req("GET", "/DATA_WEB/3d/embryo-1/download/volume.ims", {"Range": "bytes=500-"})
        self.assertIn(st, (200, 206))
        self.assertEqual(self.downloads()[0], base + 1)

        # Apache path: the rewrite target counts and redirects to the same file.
        st, h, _ = self.req("GET", "/api/download.php?lumen_path=" +
                            "DATA_WEB%2F3d%2Fembryo-1%2Fdownload%2Fsub%2Fa%26b%201%25.tif&x=1")
        self.assertEqual(st, 302)
        self.assertEqual(h.get("Location"), "a%26b%201%25.tif?x=1&lumen_dl=1")
        self.assertEqual(h.get("Cache-Control"), "no-store")
        total, per = self.downloads()
        self.assertEqual(total, base + 2)
        self.assertEqual(per.get("3d/embryo-1"), 2)

        # Never counted: a missing file, an unknown dataset, a traversal, a non-download path.
        for lp in ("DATA_WEB/3d/embryo-1/download/missing.bin",
                   "DATA_WEB/3d/nope/download/volume.ims",
                   "DATA_WEB/3d/embryo-1/download/../metadata.json",
                   "DATA_WEB/3d/embryo-1/download/sub/../../metadata.json",
                   "DATA_WEB/fixed/embryo-1/download/volume.ims"):
            st, h, _ = self.req("GET", "/api/download.php?lumen_path=" + lp.replace("/", "%2F"))
            self.assertIn(st, (302, 404), lp)
            if st == 302:
                self.assertNotIn("/", h["Location"].split("?")[0], "relative, same-folder redirect only")
        st, _, _ = self.req("GET", "/api/download.php?lumen_path=https%3A%2F%2Fevil.example%2F")
        self.assertEqual(st, 404)
        self.assertEqual(self.downloads()[0], base + 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
