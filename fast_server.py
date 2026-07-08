import secrets
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn

ROOT = Path(__file__).resolve().parent

# Reuse the canonical enforcing CSP policy from the dev server (single source of
# truth). If it can't be imported, HTML is served without a CSP (degraded).
try:
    from dev_server import _csp_policy
except Exception:
    _csp_policy = None


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_GET(self):
        # HTML documents get a per-request CSP nonce injected + the enforcing header,
        # matching dev_server.py (so the strict CSP holds on this static server too).
        clean = self.path.split("?", 1)[0].strip("/")
        if _csp_policy is not None and (clean == "" or clean.endswith(".html")):
            self._serve_html(clean or "index.html")
        else:
            super().do_GET()

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
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = ThreadingHTTPServer(('0.0.0.0', port), NoCacheHandler)
    print(f"Serving on port {port} (multi-threaded, no-cache, enforcing CSP on HTML)")
    server.serve_forever()
