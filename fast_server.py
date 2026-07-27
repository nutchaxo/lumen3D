import posixpath
import secrets
import sys
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn

ROOT = Path(__file__).resolve().parent

# Reuse the canonical enforcing CSP policy AND the static deny list from the dev
# server (single source of truth). If the import fails, HTML degrades to no CSP —
# but the deny list must NOT degrade, so it falls back to a local fail-closed twin.
try:
    from dev_server import _csp_policy, _is_forbidden_static, _FORBIDDEN_ROOTS
except Exception:
    _csp_policy = None
    _FORBIDDEN_ROOTS = frozenset({"api", "secrets", "logs", "backups", ".git"})

    def _is_forbidden_static(request_path):
        p = urllib.parse.unquote(request_path or "").replace("\\", "/").split("?", 1)[0]
        p = posixpath.normpath("/" + p).lstrip("/").lower()
        return p.split("/", 1)[0] in _FORBIDDEN_ROOTS


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def translate_path(self, path):
        """No request may resolve inside a forbidden root (api/, secrets/, logs/,
        backups/, .git/). This server has no admin API, but it runs from the repo
        root — without this it served the signing seeds and the credential hash as
        plain static files."""
        fs = super().translate_path(path)
        try:
            rel = Path(fs).resolve().relative_to(ROOT)
        except (ValueError, OSError):
            return fs
        if rel.parts and rel.parts[0].lower() in _FORBIDDEN_ROOTS:
            return str(ROOT / "__forbidden__")   # never exists → 404
        return fs

    def list_directory(self, path):
        # No directory indexes: a perf-test server should never enumerate the tree.
        self.send_error(404)
        return None

    def do_GET(self):
        clean = urllib.parse.unquote(self.path.split("?", 1)[0]).strip("/")
        if _is_forbidden_static(clean):
            self.send_error(404); return
        # HTML documents get a per-request CSP nonce injected + the enforcing header,
        # matching dev_server.py (so the strict CSP holds on this static server too).
        if _csp_policy is not None and (clean == "" or clean.endswith(".html")):
            self._serve_html(clean or "index.html")
        else:
            super().do_GET()

    def do_HEAD(self):
        clean = urllib.parse.unquote(self.path.split("?", 1)[0]).strip("/")
        if _is_forbidden_static(clean):
            self.send_error(404); return
        super().do_HEAD()

    def _serve_html(self, rel):
        fs = (ROOT / rel.replace("\\", "/").lstrip("/")).resolve()
        try:
            fs.relative_to(ROOT)
        except ValueError:
            self.send_error(404); return
        if not fs.is_file():
            super().do_GET(); return
        try:
            html = fs.read_text(encoding="utf-8")
        except OSError:
            self.send_error(500); return
        nonce = secrets.token_urlsafe(18)
        body = html.replace("{{CSP_NONCE}}", nonce).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", _csp_policy(nonce))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.end_headers()
        self.wfile.write(body)


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


if __name__ == '__main__':
    # Loopback by default. This used to bind 0.0.0.0 unconditionally, which put the
    # whole repo — including secrets/ and api/ — on every interface of the machine.
    # Pass an explicit host to expose it deliberately: `fast_server.py 8080 0.0.0.0`.
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    host = sys.argv[2] if len(sys.argv) > 2 else '127.0.0.1'
    if host not in ('127.0.0.1', 'localhost', '::1'):
        print(f"WARNING: binding {host} exposes this directory to the network.")
    server = ThreadingHTTPServer((host, port), NoCacheHandler)
    print(f"Serving on {host}:{port} (multi-threaded, no-cache, enforcing CSP on HTML)")
    server.serve_forever()
