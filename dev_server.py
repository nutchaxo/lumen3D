#!/usr/bin/env python3
"""
IRIBHM Microscopy Platform — Dev Server
========================================
Replacement for Python's http.server that also handles the admin API
endpoints (auth + datasets), so the admin panel works without PHP.

Usage:
    python dev_server.py               # port 8080
    python dev_server.py --port 8888
    python dev_server.py --host 0.0.0.0 --port 8080

API routes handled:
    GET  /api/auth.php?action=status
    POST /api/auth.php?action=login
    POST /api/auth.php?action=logout
    GET  /api/datasets.php?action=list
    GET  /api/datasets.php?action=get&id=...
    POST /api/datasets.php?action=save&id=...
    POST /api/datasets.php?action=rebuild_catalog
    GET  /api/plugins            (auto-discovery of js/modules/<placement>/<id>/)

Everything else is served as a static file from the current directory.

Credentials: stored in api/config.json (auto-created on first run).
Sessions:    in-memory dict (lost on server restart — that's fine for dev).
"""

import argparse
import hashlib
import http.server
import json
import os
import posixpath
import re
import secrets
import sys
import tempfile
import threading
import time
import urllib.parse
from datetime import datetime
from http import HTTPStatus
from pathlib import Path

__version__ = "0.12.41"

# ── Paths ──────────────────────────────────────────────────────────────────────
ROOT       = Path(__file__).resolve().parent
DATA_WEB   = ROOT / "DATA_WEB"
CONFIG_FILE = ROOT / "api" / "config.json"
MODULES_DIR = ROOT / "js" / "modules"
PLUGIN_PLACEMENTS = ("tools", "channels", "shaders")

# ── Default credentials ───────────────────────────────────────────────────────
# No hardcoded password: a random one is generated on first run (printed once)
# and only its salted PBKDF2 hash is persisted.
DEFAULT_USERNAME = "admin"

# ── Session store (in-memory) ──────────────────────────────────────────────────
# { token: { "username": ..., "expires": time.time() + TTL } }
_SESSIONS: dict[str, dict] = {}
SESSION_TTL = 28800  # 8 hours
# Brute-force: { ip: { count, until } }
_BRUTE: dict[str, dict] = {}
MAX_ATTEMPTS = 10
LOCKOUT_S    = 900  # 15 min
# BUG-055: peers allowed to set X-Forwarded-For / X-Real-IP for the brute-force key.
# Empty by default -> direct connections keyed on the TCP peer (behaviour unchanged).
TRUSTED_PROXIES: set[str] = set()
# EDGE-021 / EDGE-049: ceiling for an admin-uploaded thumbnail (reject before write).
MAX_THUMB_BYTES = 5 * 1024 * 1024
# RACE-020: serialize JSON writers (ThreadingHTTPServer runs handlers concurrently).
_WRITE_LOCK = threading.Lock()
# PERF-035: memoized catalog listing, keyed on the metadata.json mtime signature.
_CATALOG_CACHE: dict = {"sig": None, "data": None}


def _atomic_write(path: Path, data, *, binary: bool = False) -> None:
    """RACE-020: write to a temp sibling then os.replace (atomic rename on the same
    filesystem), guarded by a process-wide lock — so two concurrent admin POSTs (or a
    save racing a rebuild) can never interleave/truncate a half-written JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with _WRITE_LOCK:
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=path.suffix or ".tmp")
        try:
            if binary:
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
            else:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(data)
            os.replace(tmp, str(path))
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


def _client_ip(handler) -> str:
    """BUG-055: brute-force key. Honor X-Forwarded-For / X-Real-IP only when the direct
    peer is a configured trusted proxy; otherwise use the real TCP peer address. This
    avoids a shared-proxy-IP global lockout while not trusting client-supplied headers
    from arbitrary peers."""
    peer = handler.client_address[0] if getattr(handler, "client_address", None) else handler.address_string()
    if peer in TRUSTED_PROXIES:
        xff = handler.headers.get("X-Forwarded-For")
        if xff:
            return xff.split(",")[0].strip()
        xri = handler.headers.get("X-Real-IP")
        if xri:
            return xri.strip()
    return peer


def _is_supported_image(b: bytes) -> bool:
    """EDGE-021 / EDGE-049 (Rule 1.4): true only for a real image by magic bytes — so a
    `data:image/...` prefix can't smuggle arbitrary binary onto disk. Accepts the formats
    a browser canvas/export can produce (WebP/PNG/JPEG/GIF); the file is named .webp but
    browsers sniff content, so a PNG/JPEG thumbnail still renders."""
    return (
        (b[0:4] == b"RIFF" and b[8:12] == b"WEBP")   # WebP
        or b[0:8] == b"\x89PNG\r\n\x1a\n"            # PNG
        or b[0:3] == b"\xff\xd8\xff"                 # JPEG
        or b[0:6] in (b"GIF87a", b"GIF89a")          # GIF
    )


# ── Config helpers ─────────────────────────────────────────────────────────────

def _sha256(plain: str) -> str:
    return hashlib.sha256(plain.encode()).hexdigest()


def _hash_password(plain: str, salt=None, iterations: int = 200_000) -> str:
    """Salted PBKDF2-HMAC-SHA256, stored as 'pbkdf2_sha256$iters$salt_hex$hash_hex'."""
    if salt is None:
        salt = secrets.token_bytes(16)
    elif isinstance(salt, str):
        salt = bytes.fromhex(salt)
    dk = hashlib.pbkdf2_hmac("sha256", plain.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${dk.hex()}"


def _verify_password(plain: str, stored: str) -> bool:
    if not stored:
        return False
    if stored.startswith("pbkdf2_sha256$"):
        try:
            _scheme, iters, salt_hex, _hash_hex = stored.split("$")
            return secrets.compare_digest(
                _hash_password(plain, salt=salt_hex, iterations=int(iters)), stored
            )
        except Exception:
            return False
    # Legacy unsalted SHA-256 (deprecated; kept so existing configs keep working).
    return secrets.compare_digest(stored, _sha256(plain))


def _load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    # First-run: create config with a RANDOM password (printed once), never a
    # hardcoded/guessable default. Only the salted hash is persisted.
    generated = secrets.token_urlsafe(12)
    cfg = {
        "username": DEFAULT_USERNAME,
        "password_pbkdf2": _hash_password(generated),
        "note": "Change password via: python dev_server.py --set-password",
    }
    _atomic_write(CONFIG_FILE, json.dumps(cfg, indent=2))  # RACE-020
    print(f"  [dev-server] Generated admin password for user '{DEFAULT_USERNAME}': {generated}")
    print("  [dev-server] Save it now; change it via: python dev_server.py --set-password")
    return cfg


def _check_credentials(username: str, password: str) -> bool:
    cfg = _load_config()
    if username != cfg.get("username"):
        return False
    stored = cfg.get("password_pbkdf2") or cfg.get("password_sha256") or ""
    return _verify_password(password, stored)


def _new_session(username: str) -> str:
    token = secrets.token_hex(32)
    _SESSIONS[token] = {
        "username": username,
        "expires": time.time() + SESSION_TTL,
        "csrf": secrets.token_hex(32),
    }
    return token


def _get_session(token: str | None) -> dict | None:
    if not token:
        return None
    s = _SESSIONS.get(token)
    if not s:
        return None
    if s["expires"] < time.time():
        del _SESSIONS[token]
        return None
    return s


def _get_cookie_token(cookie_header: str | None) -> str | None:
    if not cookie_header:
        return None
    for part in cookie_header.split(";"):
        part = part.strip()
        if part.startswith("admpan_token="):
            return part[len("admpan_token="):]
    return None


WRITE_ACTIONS = ("save", "save_thumbnail", "rebuild_catalog")


def _is_write_action(action: str) -> bool:
    return action in WRITE_ACTIONS


def _check_csrf(session: dict | None, token: str | None) -> bool:
    if not session or not token:
        return False
    return secrets.compare_digest(str(session.get("csrf", "")), str(token))


def _authorize_write(method: str, session: dict | None, csrf_header: str | None):
    """Authorise a state-changing API action. Returns (ok, status, payload).

    Requires POST (blocks GET-triggered CSRF such as rebuild_catalog via a link,
    which the SameSite=Lax cookie would still authorise) and a CSRF token
    matching the session (a cross-site form cannot set the X-CSRF-Token header).
    """
    if method != "POST":
        return False, 405, {"error": "Method not allowed (use POST)"}
    if not _check_csrf(session, csrf_header):
        return False, 403, {"error": "Invalid or missing CSRF token"}
    return True, 200, {}


def _is_forbidden_static(request_path: str) -> bool:
    """True for sensitive server-side files that must never be served statically.

    Blocks the whole server-side ``api/`` directory (which holds ``config.json``
    with the admin password hash). The path is normalised first so traversal
    tricks like ``/x/../api/config.json`` or backslash/case variants are still
    caught. The two real API routes are dispatched before this check, so they
    are unaffected.
    """
    p = request_path.replace("\\", "/")
    p = posixpath.normpath("/" + p).lstrip("/").lower()
    return p == "api" or p.startswith("api/")


# ── Dataset helpers ────────────────────────────────────────────────────────────

# Path-traversal guard for the `id` query param (= "<type>/<folder>").
ALLOWED_TYPE_DIRS = ("fixed", "live", "tracking")
_SAFE_FOLDER_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$")


def _safe_dataset_dir(dataset_id: str):
    """Resolve a dataset id ('<type>/<folder>') to a directory under DATA_WEB.

    Returns (type_dir, folder, Path) for a valid id, or None if the id is
    malformed or attempts path traversal. The type segment must be one of the
    allowed dataset roots, the folder must be a single safe path component, and
    the resolved path must stay inside DATA_WEB/<type> (defense in depth).
    """
    if not isinstance(dataset_id, str):
        return None
    parts = dataset_id.split("/", 1)
    if len(parts) != 2:
        return None
    type_dir, folder = parts[0].strip(), parts[1].strip()
    if type_dir not in ALLOWED_TYPE_DIRS:
        return None
    if folder in (".", "..") or not _SAFE_FOLDER_RE.match(folder):
        return None
    base = (DATA_WEB / type_dir).resolve()
    candidate = (base / folder).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        return None
    return type_dir, folder, candidate


def _list_datasets() -> list[dict]:
    datasets = []
    for type_dir in ["fixed", "live", "tracking"]:
        base = DATA_WEB / type_dir
        if not base.is_dir():
            continue
        for ds_dir in sorted(base.iterdir()):
            if not ds_dir.is_dir():
                continue
            meta_path = ds_dir / "metadata.json"
            if not meta_path.exists():
                # Folder exists but no metadata yet (still preprocessing)
                datasets.append({
                    "id": f"{type_dir}/{ds_dir.name}",
                    "name": ds_dir.name,
                    "folderName": ds_dir.name,
                    "type": type_dir,
                    "stage": None, "stageNumeric": None, "embryo": None,
                    "configured": False, "thumbnail": None,
                })
                continue
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            thumb = ds_dir / "thumbnail.webp"
            thumb_url = f"DATA_WEB/{type_dir}/{ds_dir.name}/thumbnail.webp" if thumb.exists() else None

            ds_entry = meta.copy()
            ds_entry.update({
                "id":          f"{type_dir}/{ds_dir.name}",
                "path":        f"{type_dir}/{ds_dir.name}",
                "name":        meta.get("name") or ds_dir.name,
                "folderName":  ds_dir.name,
                "type":        type_dir,
                "stage":       meta.get("stage"),
                "stageNumeric":meta.get("stageNumeric"),
                "embryo":      meta.get("embryo"),
                "configured":  meta.get("configured", False) or meta.get("_adminConfigured", False),
                "thumbnail":   thumb_url,
            })
            
            if "volumeSources" not in ds_entry:
                ds_entry["volumeSources"] = [
                    {
                        "kind": "webstack",
                        "label": "Web slice stack",
                        "priority": 0,
                        "available": True,
                        "multiscale": False,
                        "path": f"DATA_WEB/{type_dir}/{ds_dir.name}"
                    }
                ]
            
            datasets.append(ds_entry)
    return datasets


def _get_dataset(dataset_id: str) -> dict | None:
    """dataset_id = 'fixed/FolderName' """
    safe = _safe_dataset_dir(dataset_id)
    if safe is None:
        return None
    type_dir, folder, ds_dir = safe
    meta_path = ds_dir / "metadata.json"
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["id"]         = dataset_id
        meta["folderName"] = folder
        return meta
    except Exception:
        return None


def _save_dataset(dataset_id: str, body: dict) -> bool:
    safe = _safe_dataset_dir(dataset_id)
    if safe is None:
        return False
    type_dir, folder, ds_dir = safe
    ds_dir.mkdir(parents=True, exist_ok=True)
    meta_path = ds_dir / "metadata.json"

    # Merge: keep existing fields, override with posted fields
    existing = {}
    if meta_path.exists():
        try:
            existing = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    existing.update(body)
    existing["id"]          = folder          # canonical id = just folder name (no type/ prefix)
    existing["type"]        = type_dir
    existing["folderName"]  = folder
    existing["configured"]  = True
    existing["lastModified"] = datetime.now().isoformat()

    _atomic_write(meta_path, json.dumps(existing, indent=2, ensure_ascii=False))  # RACE-020
    _CATALOG_CACHE["sig"] = None  # PERF-035: force a recompute on the next catalog read
    return True


def _save_thumbnail_bytes(dataset_id: str, image_data: str):
    """Decode a data:image/... URL and write it as the dataset thumbnail.

    Returns (http_status, payload). Path-traversal-safe via _safe_dataset_dir.
    """
    if not isinstance(image_data, str) or not image_data.startswith("data:image/"):
        return 400, {"error": "Invalid image format"}
    safe = _safe_dataset_dir(dataset_id)
    if safe is None:
        return 400, {"error": "Invalid dataset ID"}
    type_dir, folder, ds_dir = safe
    try:
        import base64
        _, base64_str = image_data.split(",", 1)
        img_bytes = base64.b64decode(base64_str)
    except Exception as e:
        return 500, {"error": f"Failed to save thumbnail: {e}"}
    # EDGE-021 / EDGE-049 (Rule 1.4): the `data:image/` prefix is attacker-controlled
    # text; verify a real image by magic bytes and a size ceiling before writing,
    # instead of dropping arbitrary binary onto disk.
    if len(img_bytes) > MAX_THUMB_BYTES:
        return 400, {"error": "Thumbnail too large"}
    if not _is_supported_image(img_bytes):
        return 400, {"error": "Not a valid image (expected WebP/PNG/JPEG/GIF)"}
    ds_dir.mkdir(parents=True, exist_ok=True)
    _atomic_write(ds_dir / "thumbnail.webp", img_bytes, binary=True)  # RACE-020
    _CATALOG_CACHE["sig"] = None  # PERF-035
    return 200, {"ok": True, "path": f"DATA_WEB/{type_dir}/{folder}/thumbnail.webp"}


def _catalog_mtime_sig() -> float:
    """PERF-035: cheap change signature — the newest metadata.json mtime across the
    three dataset roots (plus each root dir mtime to catch added/removed datasets)."""
    sig = 0.0
    for t in ("fixed", "live", "tracking"):
        base = DATA_WEB / t
        if not base.is_dir():
            continue
        try:
            sig = max(sig, base.stat().st_mtime)
        except OSError:
            pass
        for ds in base.iterdir():
            try:
                sig = max(sig, (ds / "metadata.json").stat().st_mtime)
            except OSError:
                pass
    return sig


def _list_datasets_cached() -> list[dict]:
    """PERF-035: re-parsing every metadata.json on each catalog.json GET was O(datasets)
    JSON loads per request. Recompute only when the mtime signature changes."""
    sig = _catalog_mtime_sig()
    if _CATALOG_CACHE["sig"] == sig and _CATALOG_CACHE["data"] is not None:
        return _CATALOG_CACHE["data"]
    data = _list_datasets()
    _CATALOG_CACHE["sig"] = sig
    _CATALOG_CACHE["data"] = data
    return data


def _build_catalog() -> list[dict]:
    """BUG-062: single filter + sort shared by the static rebuild and the dynamic GET
    handler, so the two outputs are byte-identical (removes the dev-vs-fast divergence)."""
    catalog = [ds for ds in _list_datasets_cached()
               if ds.get("configured") or ds.get("thumbnail") is not None]

    # BUG-061: collapse every missing/'Unknown' date to one sentinel so it sorts last
    # under reverse=True, instead of the previous mix of 'Unknown'/'1970-01-01'/ISO.
    def _date_key(x):
        d = x.get("date")
        return d if isinstance(d, str) and d not in ("", "Unknown") else "0000-00-00"
    catalog.sort(key=lambda x: (_date_key(x), x.get("name", "")), reverse=True)
    return catalog


def _rebuild_catalog() -> int:
    catalog = _build_catalog()
    catalog_path = DATA_WEB / "catalog.json"  # global (== ROOT/DATA_WEB in prod; lets tests redirect)
    _atomic_write(catalog_path, json.dumps(catalog, indent=2, ensure_ascii=False))  # RACE-020
    return len(catalog)


# ── Plugin discovery helpers ─────────────────────────────────────────────────────

def _list_plugins() -> list[dict]:
    """Scan js/modules/<placement>/<id>/plugin.json and return discovered plugins.

    Each entry is the full plugin.json meta plus a derived ``path`` (``<placement>/<id>``)
    and ``placement`` (forced to the directory it lives in). Folder names are
    validated with _SAFE_FOLDER_RE so the scan can never walk outside
    js/modules/<placement>/ (rule 1.4). A malformed/unreadable plugin.json or a
    placement mismatch skips that single plugin without aborting the batch
    (rule 1.1, mirrors the client-side loadModules tolerance).
    """
    plugins = []
    for placement in PLUGIN_PLACEMENTS:
        base = MODULES_DIR / placement
        if not base.is_dir():
            continue
        for mod_dir in sorted(base.iterdir()):
            if not mod_dir.is_dir() or not _SAFE_FOLDER_RE.match(mod_dir.name):
                continue
            meta_path = mod_dir / "plugin.json"
            if not meta_path.exists():
                continue
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(meta, dict):
                continue
            # Preserve the placement-from-directory contract (mirrors plugin-registry.js:51-55).
            if meta.get("placement") and meta["placement"] != placement:
                continue
            meta["placement"] = placement
            meta["path"] = f"{placement}/{mod_dir.name}"
            plugins.append(meta)
    return plugins


def _write_plugins_manifest(plugins: list[dict]) -> None:
    """Persist the discovered list to js/modules/manifest.json so static hosts
    (fast_server.py, ``python -m http.server``, PHP) inherit a fresh fallback
    with no manual build step. Best-effort: a write failure must not break the
    live endpoint."""
    try:
        manifest = {
            "plugins": [
                {"path": p["path"], "placement": p["placement"], "id": p.get("id")}
                for p in plugins
            ]
        }
        # RACE-020: /api/plugins is a GET that rewrites this file, and the server is
        # ThreadingHTTPServer — concurrent loads could interleave a plain write_text and
        # truncate/corrupt manifest.json. Use the atomic (temp + os.replace, locked) helper.
        _atomic_write(MODULES_DIR / "manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))
    except Exception:
        pass


# ── HTTP handler ───────────────────────────────────────────────────────────────

class AdminHandler(http.server.SimpleHTTPRequestHandler):
    """
    Extends SimpleHTTPRequestHandler to intercept /api/* routes
    and delegate everything else to the normal static file serving.
    """

    def log_message(self, format, *args):
        # Compact log format
        print(f"  {self.address_string()} [{self.log_date_time_string()}] {format % args}")

    # ── Route dispatch ─────────────────────────────────────────────────────────

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        clean_path = parsed.path.strip("/")
        if clean_path in ("DATA_WEB/catalog.json", "DATA_WEB/catalog.json/"):
            self._serve_dynamic_catalog()
        elif parsed.path in ("/api/plugins", "/api/plugins.php"):
            self._serve_plugins()
        elif parsed.path in ("/api/auth.php", "/api/datasets.php"):
            self._handle_api(parsed, body=None)
        elif _is_forbidden_static(clean_path):
            self._json(404, {"error": "Not found"})
        else:
            super().do_GET()

    def _serve_dynamic_catalog(self):
        # BUG-062/PERF-035: same filter+sort as the static rebuild, off the mtime cache.
        catalog = _build_catalog()
        body = json.dumps(catalog, indent=2, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # BUG-060: do NOT re-send Access-Control-Allow-Origin / Cache-Control / Pragma /
        # Expires here — end_headers() already emits CORS and (for a .json path) the
        # no-cache trio. Sending them again duplicated every one of those headers.
        self.end_headers()
        self.wfile.write(body)

    def _serve_plugins(self):
        """Live plugin discovery: enumerate js/modules/ and return the list, also
        refreshing js/modules/manifest.json on disk so static deploys stay current.
        no-store so dropping/removing a plugin folder is reflected on the next reload."""
        plugins = _list_plugins()
        _write_plugins_manifest(plugins)
        body = json.dumps({"plugins": plugins}, indent=2, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self._cors_headers()
        path_no_query = self.path.split('?')[0]
        if path_no_query.endswith('.json') or path_no_query.endswith('.jsonl') or path_no_query.endswith('.js'):
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        super().end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("/api/auth.php", "/api/datasets.php"):
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
            except Exception:
                body = {}
            self._handle_api(parsed, body=body)
        else:
            self._json(405, {"error": "Method not allowed"})

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    # ── API router ─────────────────────────────────────────────────────────────

    def _handle_api(self, parsed, body):
        params = dict(urllib.parse.parse_qsl(parsed.query))
        action = params.get("action", "")
        path   = parsed.path

        # ── Auth ──────────────────────────────────────────────────────────────
        if path == "/api/auth.php":
            if action == "status":
                session = _get_session(self._token())
                self._json(200, {"authenticated": session is not None,
                                 "username": session["username"] if session else None,
                                 "csrf": session["csrf"] if session else None})

            elif action == "login":
                ip = _client_ip(self)  # BUG-055: proxy-aware client IP, not the raw peer
                bf = _BRUTE.get(ip, {"count": 0, "until": 0})
                if bf["until"] > time.time():
                    remaining = int(bf["until"] - time.time())
                    self._json(429, {"error": f"Trop de tentatives. Réessayez dans {remaining}s."})
                    return
                username = (body or {}).get("username", "")
                password = (body or {}).get("password", "")
                if _check_credentials(username, password):
                    _BRUTE.pop(ip, None)
                    token = _new_session(username)
                    self._json(200, {"ok": True, "username": username, "csrf": _SESSIONS[token]["csrf"]}, cookie=f"admpan_token={token}; Path=/; HttpOnly; SameSite=Lax")
                else:
                    bf["count"] = bf.get("count", 0) + 1
                    if bf["count"] >= MAX_ATTEMPTS:
                        bf["until"] = time.time() + LOCKOUT_S
                    _BRUTE[ip] = bf
                    self._json(401, {"error": "Identifiants incorrects."})

            elif action == "logout":
                token = self._token()
                _SESSIONS.pop(token, None)
                self._json(200, {"ok": True}, cookie="admpan_token=; Path=/; Max-Age=0")

            else:
                self._json(400, {"error": f"Unknown action: {action}"})
            return

        # ── Datasets (require auth) ────────────────────────────────────────────
        if path == "/api/datasets.php":
            session = _get_session(self._token())
            if not session:
                self._json(401, {"error": "Not authenticated"})
                return

            if _is_write_action(action):
                ok, status, payload = _authorize_write(
                    self.command, session, self.headers.get("X-CSRF-Token")
                )
                if not ok:
                    self._json(status, payload)
                    return

            if action == "list":
                self._json(200, {"datasets": _list_datasets()})

            elif action == "get":
                ds_id = params.get("id", "")
                meta = _get_dataset(ds_id)
                if meta is None:
                    self._json(404, {"error": "Dataset not found"})
                else:
                    self._json(200, meta)

            elif action == "save":
                ds_id = params.get("id", "")
                ok = _save_dataset(ds_id, body or {})
                if ok:
                    self._json(200, {"ok": True})
                else:
                    self._json(400, {"error": "Invalid dataset ID"})

            elif action == "save_thumbnail":
                status, payload = _save_thumbnail_bytes(
                    params.get("id", ""), (body or {}).get("image", "")
                )
                self._json(status, payload)

            elif action == "rebuild_catalog":
                count = _rebuild_catalog()
                self._json(200, {"ok": True, "count": count})

            else:
                self._json(400, {"error": f"Unknown action: {action}"})
            return

        self._json(404, {"error": "Not found"})

    # ── Helpers ────────────────────────────────────────────────────────────────

    def _token(self) -> str | None:
        return _get_cookie_token(self.headers.get("Cookie"))

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, status: int, data: dict, cookie: str | None = None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)


# ── Entry point ────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="IRIBHM Platform Dev Server")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--set-password", action="store_true",
                        help="Interactively set a new admin password")
    args = parser.parse_args()

    if args.set_password:
        import getpass
        cfg = _load_config()
        username = input(f"Username [{cfg.get('username', 'admin')}]: ").strip() or cfg.get("username", "admin")
        password = getpass.getpass("New password: ")
        cfg["username"]       = username
        cfg["password_pbkdf2"] = _hash_password(password)
        cfg.pop("password_sha256", None)  # drop legacy unsalted hash on update
        _atomic_write(CONFIG_FILE, json.dumps(cfg, indent=2))  # RACE-020
        print(f"✅ Password updated for user '{username}'")
        sys.exit(0)

    # Serve from the platform root
    os.chdir(ROOT)

    # Load/create config on startup
    cfg = _load_config()
    print(
        "\n"
        "=" * 60 + "\n"
        f"  IRIBHM Microscopy Platform (v{__version__}) -- Dev Server\n"
        "=" * 60 + "\n"
        f"  URL     : http://{args.host}:{args.port}\n"
        f"  Admin   : http://{args.host}:{args.port}/admpan.html\n"
        f"  Viewer  : http://{args.host}:{args.port}/explorer.html\n"
        f"  Login   : {cfg.get('username', 'admin')}\n"
        f"  Password: (stored in api/config.json)\n"
        "  Ctrl+C to stop\n"
        "=" * 60 + "\n"
    )


    handler = AdminHandler
    handler.directory = str(ROOT)

    with http.server.ThreadingHTTPServer((args.host, args.port), handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")


if __name__ == "__main__":
    main()
