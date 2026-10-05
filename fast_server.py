"""Static-only perf server: the dev server's static path without the admin API.

    python fast_server.py [port] [host]

Serves the tree exactly as dev_server.py does for a visitor (byte ranges, ETag /
304, gzip, the cache policy, the {{SITE:…}} head injection, the enforcing CSP on
the top-level pages, no directory listings, keep-alive) so a measurement taken
here holds for the real server. Only the read-only discovery endpoints answer
(catalog, plugins, languages, downloads, health); every admin route is 404.
"""
import os
import posixpath
import sys
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn

ROOT = Path(__file__).resolve().parent

try:
    import dev_server as _ds
except Exception as _exc:  # pragma: no cover - exercised only when the import breaks
    _ds = None
    _IMPORT_ERROR = _exc


if _ds is not None:
    _READ_ONLY_API = frozenset({"/api/health", "/api/plugins", "/api/plugins.php",
                                "/api/languages", "/api/languages.php",
                                "/api/downloads", "/api/downloads.php"})

    class FastHandler(_ds.AdminHandler):
        def do_GET(self):
            path = urllib.parse.urlparse(self.path).path
            if path.startswith("/api/") and path not in _READ_ONLY_API:
                self._json(404, {"error": "Not found"})
                return
            super().do_GET()

        def do_POST(self):
            self._reject(405, {"error": "Method not allowed"})

    Handler = FastHandler
    ServerClass = _ds._QuietServer
else:
    # Fallback when dev_server cannot be imported: static files only, no CSP. The
    # deny list must NOT degrade with it, so it is a local fail-closed twin.
    _FORBIDDEN_ROOTS = frozenset({"api", "secrets", "logs", "backups", "uploads", ".git"})

    def _is_forbidden_static(request_path):
        p = urllib.parse.unquote(request_path or "").replace("\\", "/").split("?", 1)[0]
        p = posixpath.normpath("/" + p).lstrip("/").lower()
        return p.split("/", 1)[0] in _FORBIDDEN_ROOTS or any(
            seg.startswith(".") for seg in p.split("/"))

    class Handler(SimpleHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = 60

        def end_headers(self):
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            super().end_headers()

        def translate_path(self, path):
            fs = super().translate_path(path)
            try:
                rel = Path(fs).resolve().relative_to(ROOT)
            except (ValueError, OSError):
                return fs
            if rel.parts and rel.parts[0].lower() in _FORBIDDEN_ROOTS:
                return str(ROOT / "__forbidden__")   # never exists → 404
            return fs

        def list_directory(self, path):
            self.send_error(404)
            return None

        def do_GET(self):
            clean = urllib.parse.unquote(self.path.split("?", 1)[0]).strip("/")
            if _is_forbidden_static(clean) or clean.lower().endswith((".html", ".htm")):
                # Without the dev server there is no nonce to inject: pages are
                # not served rather than served with a dead CSP placeholder.
                self.send_error(404)
                return
            super().do_GET()

        def do_HEAD(self):
            clean = urllib.parse.unquote(self.path.split("?", 1)[0]).strip("/")
            if _is_forbidden_static(clean):
                self.send_error(404)
                return
            super().do_HEAD()

    class ServerClass(ThreadingMixIn, HTTPServer):
        daemon_threads = True
        request_queue_size = 128


if __name__ == '__main__':
    # Loopback by default. This used to bind 0.0.0.0 unconditionally, which put the
    # whole repo — including secrets/ and api/ — on every interface of the machine.
    # Pass an explicit host to expose it deliberately: `fast_server.py 8080 0.0.0.0`.
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    host = sys.argv[2] if len(sys.argv) > 2 else '127.0.0.1'
    if host not in ('127.0.0.1', 'localhost', '::1'):
        print(f"WARNING: binding {host} exposes this directory to the network.")
    if _ds is None:
        print(f"WARNING: dev_server import failed ({_IMPORT_ERROR!r}); serving static "
              "files only, without HTML pages.")
    # SimpleHTTPRequestHandler.__init__ sets self.directory to the CWD whatever the
    # class says, so the tree is served from ROOT by moving there (as dev_server does).
    os.chdir(ROOT)
    server = ServerClass((host, port), Handler)
    print(f"Serving on {host}:{port} (static only, same caching/CSP as dev_server)")
    server.serve_forever()
