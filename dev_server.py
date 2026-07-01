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
    GET  /api/auth.php?action=status            (+ needsSetup flag)
    POST /api/auth.php?action=login | logout
    POST /api/auth.php?action=setup             (first-run password, create-exclusive)
    POST /api/auth.php?action=change_password
    GET  /api/datasets.php?action=list | get
    POST /api/datasets.php?action=save | save_thumbnail | rebuild_catalog | set_visibility
    POST /api/telemetry.php?action=visit | view | download   (public usage beacons)
    GET  /api/admin.php?action=stats | plugins | version | update_check | update_status
    POST /api/admin.php?action=set_plugin | update_apply
    GET  /api/plugins            (auto-discovery, honoring api/disabled-plugins.json)

Everything else is served as a static file from the current directory.

Credentials: api/admin_credential.json (one-way PBKDF2 hash; created via the panel's
             first-run setup or `--set-password`; never served over HTTP).
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
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime
from http import HTTPStatus
from pathlib import Path

__version__ = "0.13.0"

# ── Paths ──────────────────────────────────────────────────────────────────────
ROOT       = Path(__file__).resolve().parent
DATA_WEB   = ROOT / "DATA_WEB"
CONFIG_FILE = ROOT / "api" / "config.json"
# Admin credential store (separate, single source of truth for the password).
# Lives under api/ → never served over HTTP (see _is_forbidden_static).
CRED_FILE = ROOT / "api" / "admin_credential.json"
# Usage analytics (visits / dataset views / downloads) and plugin enable state.
STATS_FILE = ROOT / "api" / "stats.json"
DISABLED_PLUGINS_FILE = ROOT / "api" / "disabled-plugins.json"
# Self-update: where pre-update backups land, and the GitHub repo to pull releases from.
BACKUPS_DIR = ROOT / "backups"
CHANGELOG_DIR = ROOT / "changelog"
GITHUB_REPO = "nutchaxo/lumen3D"
MODULES_DIR = ROOT / "js" / "modules"
PLUGIN_PLACEMENTS = ("tools", "channels", "shaders")
LANG_DIR = ROOT / "lang"
# A bare locale code (BCP-47-ish): two/three letters with an optional region.
_LANG_CODE_RE = re.compile(r"^[a-z]{2,3}(-[A-Za-z]{2,4})?$")

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
# Serialize the read-modify-write of stats.json so concurrent beacons can't lose
# increments. A SEPARATE lock from _WRITE_LOCK (which _atomic_write takes) — they are
# never held nested in the same order, so no deadlock (threading.Lock isn't reentrant).
_STATS_LOCK = threading.Lock()
# Live self-update progress, polled by the admin UI via /api/admin.php?action=update_status.
_UPDATE_STATE = {"phase": "idle", "pct": 0, "message": "", "error": None, "running": False, "target": None}
# PERF-035: memoized catalog listing, keyed on the metadata.json mtime signature.
_CATALOG_CACHE: dict = {"sig": None, "data": None}
# PERF: a synchronous console write per request sits on the response hot path
# (dozens per page load; the Windows console is slow and serializes across the
# ThreadingHTTPServer workers). Off by default; enable with --verbose. Errors
# (4xx/5xx) always log regardless — see AdminHandler.log_error.
_LOG_REQUESTS = False


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
    """Non-secret server config (currently just a default username hint).

    The admin PASSWORD no longer lives here — it moved to the dedicated credential
    store (CRED_FILE). No password is ever auto-generated: a missing credential puts
    the panel into first-run setup mode (see _credential_exists / the setup action).
    """
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"username": DEFAULT_USERNAME}


# ── Admin credential store ─────────────────────────────────────────────────────
# Single source of truth for the admin password. Holds ONLY a one-way salted PBKDF2
# hash (no plaintext, no reversible secret) in a file that is never served over HTTP.
# Possessing the file yields neither the password nor an auth bypass. The only reset
# path is DELETING the file (then the panel re-enters setup) — and the HTTP setup
# action is create-exclusive (O_EXCL), so it can NEVER overwrite a live credential.

def _load_credential() -> dict | None:
    if CRED_FILE.exists():
        try:
            rec = json.loads(CRED_FILE.read_text(encoding="utf-8"))
            return rec if isinstance(rec, dict) else None
        except Exception:
            return None
    return None


def _credential_exists() -> bool:
    return CRED_FILE.exists()


def _credential_record(username: str, password: str) -> dict:
    now = datetime.now().isoformat()
    return {
        "version": 1,
        "username": (username or DEFAULT_USERNAME).strip() or DEFAULT_USERNAME,
        "password_pbkdf2": _hash_password(password),  # 'pbkdf2_sha256$iters$salt$hash'
        "created": now,
        "rotated": now,
    }


def _harden_perms(path: Path) -> None:
    """Best-effort: restrict the credential file to the server's own user.

    POSIX: chmod 0600. Windows: reset ACL inheritance and grant only the current
    user (icacls). Best-effort — a failure must not break setup/login.
    """
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    if os.name == "nt":
        try:
            import getpass
            import subprocess
            user = os.environ.get("USERNAME") or getpass.getuser()
            subprocess.run(
                ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:F"],
                capture_output=True, timeout=5,
            )
        except Exception:
            pass


def _setup_credential(username: str, password: str):
    """Create the credential ONLY if none exists. Returns (ok, status, payload).

    The anti-overwrite guarantee is the O_CREAT|O_EXCL open: it atomically fails if
    the file already exists, so this HTTP-reachable path can never replace a live
    password (race-free, even under concurrent setup requests).
    """
    if not isinstance(password, str) or len(password) < 4:
        return False, 400, {"error": "weak_password"}
    rec = _credential_record(username, password)
    data = json.dumps(rec, indent=2, ensure_ascii=False).encode("utf-8")
    CRED_FILE.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(str(CRED_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False, 409, {"error": "already_configured"}
    except OSError as e:
        return False, 500, {"error": f"setup_failed: {e}"}
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
    except OSError as e:
        return False, 500, {"error": f"setup_write_failed: {e}"}
    _harden_perms(CRED_FILE)
    return True, 200, {"ok": True, "username": rec["username"]}


def _change_credential(current: str, new: str):
    """Rotate the password — requires the CURRENT password. Returns (ok, status, payload).

    This is the only path that overwrites an existing credential, and it is gated on
    knowing the live password (the caller is additionally session-authenticated).
    """
    rec = _load_credential()
    if not rec:
        return False, 409, {"error": "not_configured"}
    if not _verify_password(current or "", rec.get("password_pbkdf2") or ""):
        return False, 401, {"error": "bad_current"}
    if not isinstance(new, str) or len(new) < 4:
        return False, 400, {"error": "weak_password"}
    newrec = _credential_record(rec.get("username") or DEFAULT_USERNAME, new)
    newrec["created"] = rec.get("created", newrec["created"])
    _atomic_write(CRED_FILE, json.dumps(newrec, indent=2, ensure_ascii=False))  # RACE-020
    _harden_perms(CRED_FILE)
    return True, 200, {"ok": True}


def _write_credential_force(username: str, password: str) -> None:
    """Operator-only (CLI --set-password): write/overwrite the credential without the
    old password. Intentionally NOT exposed over HTTP — an operator with shell access
    is already trusted (and could delete the file anyway)."""
    rec = _credential_record(username, password)
    existing = _load_credential()
    if existing:
        rec["created"] = existing.get("created", rec["created"])
    _atomic_write(CRED_FILE, json.dumps(rec, indent=2, ensure_ascii=False))  # RACE-020
    _harden_perms(CRED_FILE)


def _check_credentials(username: str, password: str) -> bool:
    rec = _load_credential()
    if not rec:
        return False
    if username != rec.get("username"):
        return False
    return _verify_password(password, rec.get("password_pbkdf2") or "")


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


WRITE_ACTIONS = ("save", "save_thumbnail", "rebuild_catalog", "set_visibility")


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


# ── Usage statistics ───────────────────────────────────────────────────────────

def _load_stats() -> dict:
    if STATS_FILE.exists():
        try:
            d = json.loads(STATS_FILE.read_text(encoding="utf-8"))
            if isinstance(d, dict):
                d.setdefault("global", {})
                d.setdefault("daily", {})
                d.setdefault("datasets", {})
                return d
        except Exception:
            pass
    return {"global": {"visits": 0, "views": 0, "downloads": 0, "since": datetime.now().isoformat()},
            "daily": {}, "datasets": {}}


def _record_event(kind: str, dataset_id: str | None = None) -> None:
    """Increment a usage counter (visit / view / download) — global, per-day, and
    per-dataset. Serialized by _STATS_LOCK so concurrent beacons never lose an
    increment; the actual file write is the atomic temp+rename helper."""
    field = {"visit": "visits", "view": "views", "download": "downloads"}.get(kind)
    if not field:
        return
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    with _STATS_LOCK:
        stats = _load_stats()
        g = stats["global"]
        g[field] = int(g.get(field, 0)) + 1
        g.setdefault("since", now.isoformat())
        day = stats["daily"].setdefault(today, {})
        day[field] = int(day.get(field, 0)) + 1
        if dataset_id and kind in ("view", "download"):
            ds = stats["datasets"].setdefault(dataset_id, {})
            ds[field] = int(ds.get(field, 0)) + 1
            if kind == "view":
                ds["lastViewed"] = now.isoformat()
        _atomic_write(STATS_FILE, json.dumps(stats, indent=2, ensure_ascii=False))  # RACE-020


def _admin_stats() -> dict:
    """Stats enriched with dataset display names for the admin table."""
    stats = _load_stats()
    names = {}
    try:
        for ds in _list_datasets_cached():
            names[ds.get("id")] = ds.get("name")
    except Exception:
        pass
    rows = []
    for ds_id, v in stats.get("datasets", {}).items():
        rows.append({
            "id": ds_id,
            "name": names.get(ds_id, ds_id),
            "views": int(v.get("views", 0)),
            "downloads": int(v.get("downloads", 0)),
            "lastViewed": v.get("lastViewed"),
        })
    rows.sort(key=lambda r: (r["views"] + r["downloads"]), reverse=True)
    return {"global": stats.get("global", {}), "daily": stats.get("daily", {}), "datasets": rows}


# ── Plugin enable/disable state ────────────────────────────────────────────────

def _load_disabled_plugins() -> set:
    if DISABLED_PLUGINS_FILE.exists():
        try:
            d = json.loads(DISABLED_PLUGINS_FILE.read_text(encoding="utf-8"))
            return set(d.get("disabled", [])) if isinstance(d, dict) else set()
        except Exception:
            pass
    return set()


def _save_disabled_plugins(disabled: set) -> None:
    _atomic_write(DISABLED_PLUGINS_FILE,
                  json.dumps({"disabled": sorted(disabled)}, indent=2, ensure_ascii=False))  # RACE-020


def _admin_plugins() -> list:
    """Full plugin inventory (unfiltered) annotated with enabled/protected, for the
    admin Plugins tab. 'protected' = the last still-enabled shader (disabling it would
    leave the viewer with no render mode)."""
    disabled = _load_disabled_plugins()
    plugins = _list_plugins()  # raw scan, no manifest write
    enabled_shaders = [p for p in plugins
                       if p.get("placement") == "shaders" and p["path"] not in disabled]
    enabled_shader_paths = {p["path"] for p in enabled_shaders}
    out = []
    for p in plugins:
        path = p["path"]
        is_enabled = path not in disabled
        out.append({
            "id": p.get("id"),
            "path": path,
            "placement": p.get("placement"),
            "name": p.get("name") or p.get("id") or path,
            "icon": p.get("icon"),
            "group": p.get("group"),
            "subtype": p.get("subtype"),
            "version": p.get("version"),
            "creator": p.get("creator"),
            "enabled": is_enabled,
            "protected": len(enabled_shaders) <= 1 and path in enabled_shader_paths,
        })
    out.sort(key=lambda x: (x["placement"] or "", x.get("group") or "", x.get("name") or ""))
    return out


def _set_plugin_enabled(plugin_path: str, enabled: bool):
    """Toggle a plugin. Returns (ok, status, payload). Refuses to disable the last
    enabled shader (the viewer needs at least one render mode)."""
    known = {p["path"] for p in _list_plugins()}
    if plugin_path not in known:
        return False, 404, {"error": "unknown_plugin"}
    disabled = _load_disabled_plugins()
    if not enabled:
        if plugin_path.startswith("shaders/"):
            enabled_shaders = [p for p in _list_plugins()
                               if p.get("placement") == "shaders" and p["path"] not in disabled]
            if len(enabled_shaders) <= 1 and plugin_path in {p["path"] for p in enabled_shaders}:
                return False, 409, {"error": "last_shader"}
        disabled.add(plugin_path)
    else:
        disabled.discard(plugin_path)
    _save_disabled_plugins(disabled)
    return True, 200, {"ok": True, "enabled": enabled}


# ── Version & self-update ──────────────────────────────────────────────────────

_VERSION_RE = re.compile(r"^changelog_(\d+)\.(\d+)\.(\d+)\.md$")


def _parse_versions_in(dir_path: Path) -> list:
    vs = []
    if dir_path.is_dir():
        for f in dir_path.glob("changelog_*.md"):
            m = _VERSION_RE.match(f.name)
            if m:
                vs.append(tuple(int(x) for x in m.groups()))
    return sorted(vs)


def _max_version(dir_path: Path):
    vs = _parse_versions_in(dir_path)
    return ".".join(map(str, vs[-1])) if vs else None


def _version_tuple(s: str) -> tuple:
    try:
        nums = re.findall(r"\d+", s or "")
        return tuple(int(x) for x in nums[:3]) or (0, 0, 0)
    except Exception:
        return (0, 0, 0)


def _preprocess_version():
    try:
        txt = (ROOT / "preprocess" / "run_preprocess.py").read_text(encoding="utf-8")
        m = re.search(r'__version__\s*=\s*["\']([\d.]+)["\']', txt)
        if m:
            return m.group(1)
    except Exception:
        pass
    return _max_version(ROOT / "preprocess" / "changelog")


def _version_info() -> dict:
    """Web platform version = newest changelog/changelog_X.Y.Z.md (the convention's
    single source of truth — no constant introduced)."""
    return {
        "web": _max_version(CHANGELOG_DIR),
        "devServer": __version__,
        "preprocess": _preprocess_version(),
        "repo": GITHUB_REPO,
    }


def _http_get_json(url: str, timeout: int = 10) -> dict:
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "lumen3d-admin",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _update_check() -> dict:
    current = _max_version(CHANGELOG_DIR) or "0.0.0"
    try:
        rel = _http_get_json(f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"current": current, "latest": None, "available": False, "noReleases": True}
        return {"current": current, "latest": None, "available": False, "error": f"HTTP {e.code}"}
    except Exception as e:
        return {"current": current, "latest": None, "available": False, "error": str(e)}
    latest = (rel.get("tag_name") or "").lstrip("v") or None
    available = bool(latest) and _version_tuple(latest) > _version_tuple(current)
    return {
        "current": current,
        "latest": latest,
        "available": available,
        "notes": rel.get("body"),
        "publishedAt": rel.get("published_at"),
        "zipUrl": rel.get("zipball_url"),
        "htmlUrl": rel.get("html_url"),
    }


# Paths (relative, posix) that the updater must never overwrite or delete: user data,
# the credential/stats/plugin state, logs, backups, and VCS/runtime dirs.
_UPDATE_PROTECT = (
    "DATA_WEB", ".git", ".conda", "logs", "backups", "node_modules",
    "api/admin_credential.json", "api/config.json", "api/stats.json",
    "api/disabled-plugins.json",
)


def _is_protected_rel(rel: str) -> bool:
    rel = rel.replace("\\", "/").strip("/")
    for p in _UPDATE_PROTECT:
        if rel == p or rel.startswith(p + "/"):
            return True
    return False


def _set_update(phase: str, pct: int, message: str, error=None) -> None:
    _UPDATE_STATE.update({"phase": phase, "pct": pct, "message": message})
    if error is not None:
        _UPDATE_STATE["error"] = error


def _start_update():
    """Validate + kick off a guarded update in a background thread.
    Returns (ok, status, payload)."""
    if _UPDATE_STATE.get("running"):
        return False, 409, {"error": "already_running"}
    info = _update_check()
    if not info.get("available") or not info.get("zipUrl"):
        return False, 400, {"error": "no_update_available", "info": info}
    _UPDATE_STATE.update({"phase": "starting", "pct": 0, "message": "Préparation…",
                          "error": None, "running": True, "target": info.get("latest")})
    threading.Thread(target=_run_update, args=(info,), daemon=True).start()
    return True, 200, {"ok": True, "restarting": True, "target": info.get("latest")}


def _make_backup_zip(backup_path: Path) -> None:
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(backup_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(ROOT):
            rel_root = os.path.relpath(root, ROOT).replace("\\", "/")
            rel_root = "" if rel_root == "." else rel_root
            dirs[:] = [d for d in dirs
                       if not _is_protected_rel(f"{rel_root}/{d}" if rel_root else d)]
            for f in files:
                rel = f"{rel_root}/{f}" if rel_root else f
                if _is_protected_rel(rel):
                    continue
                try:
                    zf.write(os.path.join(root, f), rel)
                except OSError:
                    pass


def _download_file(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "lumen3d-admin"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


def _copy_tree_filtered(src_root: Path, dst_root: Path) -> None:
    for root, dirs, files in os.walk(src_root):
        rel_root = os.path.relpath(root, src_root).replace("\\", "/")
        rel_root = "" if rel_root == "." else rel_root
        dirs[:] = [d for d in dirs
                   if not _is_protected_rel(f"{rel_root}/{d}" if rel_root else d)]
        for f in files:
            rel = f"{rel_root}/{f}" if rel_root else f
            if _is_protected_rel(rel):
                continue
            dst = dst_root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copy2(os.path.join(root, f), dst)
            except OSError:
                pass


def _delayed_restart(delay: float) -> None:
    time.sleep(delay)
    try:
        # Re-exec the same interpreter + argv. Python source isn't locked once imported,
        # so the freshly written dev_server.py loads on restart (Windows-safe).
        os.execv(sys.executable, [sys.executable, *sys.argv])
    except Exception:
        os._exit(0)


def _run_update(info: dict) -> None:
    tmpdir = None
    try:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        current = info.get("current") or "unknown"
        _set_update("backup", 10, "Sauvegarde de l'installation…")
        _make_backup_zip(BACKUPS_DIR / f"backup-{current}-{ts}.zip")

        _set_update("download", 35, "Téléchargement de la mise à jour…")
        tmpdir = Path(tempfile.mkdtemp(prefix="lumen-update-"))
        zip_path = tmpdir / "release.zip"
        _download_file(info["zipUrl"], zip_path)

        _set_update("extract", 60, "Extraction…")
        extract_dir = tmpdir / "extracted"
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(extract_dir)
        roots = [p for p in extract_dir.iterdir() if p.is_dir()]
        src_root = roots[0] if len(roots) == 1 else extract_dir  # strip GitHub's top folder

        _set_update("apply", 80, "Application des fichiers…")
        _copy_tree_filtered(src_root, ROOT)

        _UPDATE_STATE["running"] = False
        _set_update("done", 100, "Mise à jour terminée. Redémarrage…")
        threading.Thread(target=_delayed_restart, args=(1.5,), daemon=True).start()
    except Exception as e:
        _UPDATE_STATE["running"] = False
        _set_update("error", 0, "Échec de la mise à jour.", error=str(e))
    finally:
        if tmpdir is not None:
            shutil.rmtree(tmpdir, ignore_errors=True)


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


def _safe_subpath(root: Path, rel):
    """Resolve a user-supplied relative path under an already-resolved ``root``.

    Returns the resolved Path (``root`` itself for an empty path), or ``None`` if
    the path is malformed or escapes ``root``. Mirrors the layered defense of
    ``_safe_dataset_dir``: reject ``..``/dotfile/absolute/backslash segments up
    front, then ``resolve()`` + ``relative_to()`` as the authoritative
    containment check, so a crafted ``path=../../api/config.json`` can never
    climb out of the dataset's download folder (Rule 1.4).
    """
    if rel is None:
        rel = ""
    if not isinstance(rel, str) or "\x00" in rel:
        return None
    rel = rel.replace("\\", "/").strip("/")
    if rel in ("", "."):
        return root
    segments = rel.split("/")
    for seg in segments:
        if seg in ("", ".", "..") or seg.startswith("."):
            return None
    candidate = (root / Path(*segments)).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate


def _list_download_entries(download_root: Path, target: Path, dataset_id: str, rel: str):
    """List the immediate children of ``target`` (a dir inside ``download_root``).

    Skips dotfiles and any entry whose resolved path escapes ``download_root`` (a
    symlink pointing outside). Directories report a (non-dotfile) child count;
    files report a byte size, an uppercase extension, and a static ``href`` under
    ``DATA_WEB/``. Sorted directories-first, then case-insensitive by name.
    """
    entries = []
    try:
        scan = list(os.scandir(target))
    except OSError:
        scan = []
    for de in scan:
        name = de.name
        if name.startswith("."):
            continue
        try:
            Path(de.path).resolve().relative_to(download_root)
        except (OSError, ValueError):
            continue  # symlink (or junction) pointing outside the download root
        child_rel = f"{rel}/{name}" if rel else name
        try:
            is_dir = de.is_dir()
        except OSError:
            continue
        if is_dir:
            try:
                count = sum(1 for s in os.scandir(de.path) if not s.name.startswith("."))
            except OSError:
                count = 0
            entries.append({"name": name, "kind": "dir", "path": child_rel, "count": count})
        elif de.is_file():
            try:
                size = de.stat().st_size
            except OSError:
                size = None
            ext = name.rsplit(".", 1)[-1].upper() if "." in name else "FILE"
            entries.append({
                "name": name,
                "kind": "file",
                "ext": ext,
                "sizeBytes": size,
                "path": child_rel,
                "href": f"DATA_WEB/{dataset_id}/download/{child_rel}",
            })
    entries.sort(key=lambda e: (e["kind"] != "dir", e["name"].lower()))
    return entries


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


def _set_dataset_hidden(dataset_id: str, hidden: bool) -> bool:
    """Flip the `hidden` flag on a dataset's metadata.json. Hidden datasets are
    omitted from the public catalog.json (_build_catalog) but still listed in admin."""
    safe = _safe_dataset_dir(dataset_id)
    if safe is None:
        return False
    _type_dir, _folder, ds_dir = safe
    meta_path = ds_dir / "metadata.json"
    if not meta_path.exists():
        return False
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return False
    meta["hidden"] = bool(hidden)
    meta["lastModified"] = datetime.now().isoformat()
    _atomic_write(meta_path, json.dumps(meta, indent=2, ensure_ascii=False))  # RACE-020
    _CATALOG_CACHE["sig"] = None  # PERF-035
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
               if (ds.get("configured") or ds.get("thumbnail") is not None)
               and not ds.get("hidden")]

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
            # Advertise the locales this plugin actually ships (lang/<code>.json),
            # so the client can load only those and fall back to English for the
            # rest. Folder scan keeps i18nLanguages honest even if plugin.json
            # drifts; missing dir simply yields no override.
            shipped = _scan_plugin_locales(mod_dir)
            if shipped:
                meta["i18nLanguages"] = shipped
                # PERF: inline each shipped locale's dictionary so the client can
                # graft them synchronously from this single /api/plugins response,
                # eliminating one per-plugin per-locale lang round-trip on the viewer
                # boot path (16-32 requests across the plugin set). Best-effort: a
                # malformed file is skipped; the client falls back to fetching it.
                # Only advertised when English (the per-plugin fallback) is present.
                dicts = {}
                for code in shipped:
                    try:
                        dicts[code] = json.loads((mod_dir / "lang" / f"{code}.json").read_text(encoding="utf-8"))
                    except Exception:
                        pass
                if dicts.get("en"):
                    meta["i18n"] = dicts
            plugins.append(meta)
    return plugins


def _scan_plugin_locales(mod_dir: Path) -> list[str]:
    """Return the sorted locale codes a plugin ships as lang/<code>.json."""
    lang_dir = mod_dir / "lang"
    if not lang_dir.is_dir():
        return []
    codes = []
    for f in lang_dir.glob("*.json"):
        code = f.stem
        if _LANG_CODE_RE.match(code):
            codes.append(code)
    return sorted(codes)


def _list_languages() -> list[str]:
    """Scan lang/<code>.json and return the platform's available locale codes.

    'en' is guaranteed present (the fallback locale) so the UI can never end up
    with an empty switcher. manifest.json is excluded (it is the index, not a
    locale). Mirrors plugin discovery so dropping lang/zh.json is picked up live.
    """
    codes = set()
    if LANG_DIR.is_dir():
        for f in LANG_DIR.glob("*.json"):
            if f.stem == "manifest":
                continue
            if _LANG_CODE_RE.match(f.stem):
                codes.add(f.stem)
    codes.add("en")
    # Keep 'en' first, then the rest alphabetically — stable, predictable order.
    rest = sorted(c for c in codes if c != "en")
    return ["en", *rest]


def _write_languages_manifest(codes: list[str]) -> None:
    """Persist lang/manifest.json so static hosts inherit the discovered locale
    list with no build step. Best-effort, atomic (mirrors the plugin manifest).
    PERF: skip the write entirely when the on-disk content is already current, so
    a discovery GET on the boot path does no temp-file churn / lock contention in
    the common (unchanged) case."""
    try:
        new_text = json.dumps({"languages": codes}, indent=2, ensure_ascii=False)
        target = LANG_DIR / "manifest.json"
        try:
            if target.read_text(encoding="utf-8") == new_text:
                return
        except (OSError, ValueError):
            pass
        _atomic_write(target, new_text)
    except Exception:
        pass


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
        # Canonical on-disk form stays the {path,placement,id} triple — the inline
        # plugin meta / i18n dicts in the /api/plugins response are NOT persisted
        # (static hosts must keep fetching plugin.json, see plugin-registry.js).
        new_text = json.dumps(manifest, indent=2, ensure_ascii=False)
        target = MODULES_DIR / "manifest.json"
        # PERF: skip the write when already current, so a discovery GET on the boot
        # path does no temp-file churn / _WRITE_LOCK contention in the common case.
        try:
            if target.read_text(encoding="utf-8") == new_text:
                return
        except (OSError, ValueError):
            pass
        # RACE-020: /api/plugins is a GET that rewrites this file, and the server is
        # ThreadingHTTPServer — concurrent loads could interleave a plain write and
        # truncate/corrupt manifest.json. Use the atomic (temp + os.replace, locked) helper.
        _atomic_write(target, new_text)
    except Exception:
        pass


# ── HTTP handler ───────────────────────────────────────────────────────────────

# A served file under a dataset's download/ folder (used to count downloads).
_DOWNLOAD_RE = re.compile(r"^DATA_WEB/(fixed|live|tracking)/([^/]+)/download/.+", re.IGNORECASE)


class AdminHandler(http.server.SimpleHTTPRequestHandler):
    """
    Extends SimpleHTTPRequestHandler to intercept /api/* routes
    and delegate everything else to the normal static file serving.
    """

    def log_message(self, format, *args):
        # Compact log format. Quiet by default (PERF: skip the synchronous
        # per-request console write on the response hot path); enable with --verbose.
        if _LOG_REQUESTS:
            print(f"  {self.address_string()} [{self.log_date_time_string()}] {format % args}")

    def log_error(self, format, *args):
        # 4xx/5xx must always surface, even when routine request logging is quiet.
        print(f"  {self.address_string()} [{self.log_date_time_string()}] ERROR {format % args}")

    # ── Route dispatch ─────────────────────────────────────────────────────────

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        clean_path = parsed.path.strip("/")
        if clean_path in ("DATA_WEB/catalog.json", "DATA_WEB/catalog.json/"):
            self._serve_dynamic_catalog()
        elif parsed.path in ("/api/plugins", "/api/plugins.php"):
            self._serve_plugins()
        elif parsed.path in ("/api/languages", "/api/languages.php"):
            self._serve_languages()
        elif parsed.path in ("/api/downloads", "/api/downloads.php"):
            self._serve_downloads(parsed)
        elif parsed.path in ("/api/auth.php", "/api/datasets.php", "/api/admin.php", "/api/telemetry.php"):
            self._handle_api(parsed, body=None)
        elif _is_forbidden_static(clean_path):
            self._json(404, {"error": "Not found"})
        else:
            self._maybe_count_download(clean_path)
            super().do_GET()

    def _maybe_count_download(self, clean_path: str):
        """Count a download when a file under DATA_WEB/<type>/<folder>/download/ is
        served. Server-side is the reliable hook (static GETs aren't POSTed). Range
        continuations are skipped so one download ≈ one increment."""
        if "Range" in self.headers:
            return
        m = _DOWNLOAD_RE.match(clean_path.replace("\\", "/"))
        if not m:
            return
        ds_id = f"{m.group(1)}/{m.group(2)}"
        if _safe_dataset_dir(ds_id):
            try:
                _record_event("download", ds_id)
            except Exception:
                pass

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
        no-store so dropping/removing a plugin folder is reflected on the next reload.
        Admin-disabled plugins are filtered out HERE (in discovery, before the client
        builds any UI) so the load-order invariant is preserved; the persisted manifest
        mirrors the filtered list so static hosts inherit the same exclusions."""
        disabled = _load_disabled_plugins()
        plugins = [p for p in _list_plugins() if p.get("path") not in disabled]
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

    def _serve_languages(self):
        """Live language discovery: enumerate lang/<code>.json and return the
        platform's available locales, refreshing lang/manifest.json so static
        deploys stay current. no-store so dropping lang/zh.json is reflected on
        the next reload."""
        codes = _list_languages()
        _write_languages_manifest(codes)
        body = json.dumps({"languages": codes}, indent=2, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.end_headers()
        self.wfile.write(body)

    def _serve_downloads(self, parsed):
        """Live per-dataset file listing for the Download Center's file explorer.

        GET /api/downloads?dataset=<type>/<folder>&path=<subdir>
        Lists DATA_WEB/<type>/<folder>/download/<subdir>. Read-only and
        unauthenticated (the files under it are already statically downloadable),
        no-store so a freshly dropped file shows up on the next open. Path
        traversal is blocked on BOTH params: the dataset id via _safe_dataset_dir
        and the inner path via _safe_subpath (Rule 1.4 — reject, never partially
        mount)."""
        params = dict(urllib.parse.parse_qsl(parsed.query))
        info = _safe_dataset_dir(params.get("dataset", ""))
        if not info:
            self._json_nostore(400, {"error": "Invalid dataset"})
            return
        type_dir, folder, ds_dir = info
        dataset_id = f"{type_dir}/{folder}"
        download_root = (ds_dir / "download").resolve()
        target = _safe_subpath(download_root, params.get("path", ""))
        if target is None:
            self._json_nostore(400, {"error": "Invalid path"})
            return
        if not download_root.is_dir():
            # No download/ folder provisioned for this dataset — empty, not an error.
            self._json_nostore(200, {"dataset": dataset_id, "path": "", "available": False, "entries": []})
            return
        if not target.is_dir():
            self._json_nostore(404, {"error": "Not found"})
            return
        rel = target.relative_to(download_root).as_posix()
        if rel == ".":
            rel = ""
        entries = _list_download_entries(download_root, target, dataset_id, rel)
        self._json_nostore(200, {"dataset": dataset_id, "path": rel, "available": True, "entries": entries})

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
        if parsed.path in ("/api/auth.php", "/api/datasets.php", "/api/admin.php", "/api/telemetry.php"):
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
                                 "csrf": session["csrf"] if session else None,
                                 "needsSetup": not _credential_exists()})

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

            elif action == "setup":
                # First-run password creation. _setup_credential is create-exclusive
                # (O_EXCL) so it can NEVER overwrite a live credential. No session is
                # required (none can exist before a password is set) but it is
                # rate-limited like login, and a 409 also costs a brute-force attempt.
                if self.command != "POST":
                    self._json(405, {"error": "Method not allowed (use POST)"})
                    return
                ip = _client_ip(self)
                bf = _BRUTE.get(ip, {"count": 0, "until": 0})
                if bf["until"] > time.time():
                    remaining = int(bf["until"] - time.time())
                    self._json(429, {"error": f"Trop de tentatives. Réessayez dans {remaining}s."})
                    return
                username = (body or {}).get("username") or DEFAULT_USERNAME
                password = (body or {}).get("password", "")
                ok, status, payload = _setup_credential(username, password)
                if ok:
                    token = _new_session(payload["username"])
                    self._json(200, {**payload, "csrf": _SESSIONS[token]["csrf"]},
                               cookie=f"admpan_token={token}; Path=/; HttpOnly; SameSite=Lax")
                else:
                    bf["count"] = bf.get("count", 0) + 1
                    if bf["count"] >= MAX_ATTEMPTS:
                        bf["until"] = time.time() + LOCKOUT_S
                    _BRUTE[ip] = bf
                    self._json(status, payload)

            elif action == "change_password":
                session = _get_session(self._token())
                if not session:
                    self._json(401, {"error": "Not authenticated"})
                    return
                ok, status, payload = _authorize_write(
                    self.command, session, self.headers.get("X-CSRF-Token")
                )
                if not ok:
                    self._json(status, payload)
                    return
                ok2, st2, pl2 = _change_credential(
                    (body or {}).get("current", ""), (body or {}).get("new", "")
                )
                self._json(st2, pl2)

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

            elif action == "set_visibility":
                ds_id = params.get("id", "")
                hidden = bool((body or {}).get("hidden", False))
                if _set_dataset_hidden(ds_id, hidden):
                    _rebuild_catalog()
                    self._json(200, {"ok": True, "hidden": hidden})
                else:
                    self._json(400, {"error": "Invalid dataset ID"})

            else:
                self._json(400, {"error": f"Unknown action: {action}"})
            return

        # ── Telemetry (public usage beacons, no auth) ──────────────────────────
        if path == "/api/telemetry.php":
            kind = action  # visit | view | download
            if kind not in ("visit", "view", "download"):
                self._json(400, {"error": "bad_kind"})
                return
            ds_id = params.get("id") or (body or {}).get("id")
            if kind in ("view", "download"):
                if not ds_id or _safe_dataset_dir(ds_id) is None:
                    ds_id = None  # still count globally if the id is missing/invalid
            else:
                ds_id = None
            _record_event(kind, ds_id)
            self._json(200, {"ok": True})
            return

        # ── Admin feature endpoints (require auth) ─────────────────────────────
        if path == "/api/admin.php":
            session = _get_session(self._token())
            if not session:
                self._json(401, {"error": "Not authenticated"})
                return
            if action in ("set_plugin", "update_apply"):
                ok, status, payload = _authorize_write(
                    self.command, session, self.headers.get("X-CSRF-Token")
                )
                if not ok:
                    self._json(status, payload)
                    return

            if action == "stats":
                self._json(200, _admin_stats())
            elif action == "plugins":
                self._json(200, {"plugins": _admin_plugins()})
            elif action == "set_plugin":
                ok2, st2, pl2 = _set_plugin_enabled(
                    (body or {}).get("id", ""), bool((body or {}).get("enabled", True))
                )
                self._json(st2, pl2)
            elif action == "version":
                self._json(200, _version_info())
            elif action == "update_check":
                self._json(200, _update_check())
            elif action == "update_apply":
                ok2, st2, pl2 = _start_update()
                self._json(st2, pl2)
            elif action == "update_status":
                self._json(200, dict(_UPDATE_STATE))
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

    def _json_nostore(self, status: int, data: dict):
        # Like _json but with the explicit no-store trio used by the discovery
        # endpoints. /api/* paths don't end in .json, so end_headers() won't add
        # no-cache for them — a directory listing must not be cached. CORS is
        # emitted by end_headers(); do not re-send it here (would duplicate).
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(body)


# ── Entry point ────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="IRIBHM Platform Dev Server")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--set-password", action="store_true",
                        help="Interactively set a new admin password")
    parser.add_argument("--verbose", action="store_true",
                        help="Log every request to the console (off by default for speed)")
    args = parser.parse_args()

    global _LOG_REQUESTS
    _LOG_REQUESTS = bool(args.verbose)

    if args.set_password:
        import getpass
        rec = _load_credential()
        default_user = (rec or {}).get("username", DEFAULT_USERNAME)
        username = input(f"Username [{default_user}]: ").strip() or default_user
        password = getpass.getpass("New password: ")
        if len(password) < 4:
            print("❌ Password too short (min 4 chars).")
            sys.exit(1)
        # Operator CLI may overwrite (already trusted with the filesystem); the
        # HTTP setup path remains create-exclusive (cannot overwrite a live credential).
        _write_credential_force(username, password)
        print(f"✅ Password set for user '{username}' (api/admin_credential.json)")
        sys.exit(0)

    # Serve from the platform root
    os.chdir(ROOT)

    rec = _load_credential()
    if rec:
        cred_line = f"  Login   : {rec.get('username', DEFAULT_USERNAME)}  (password in api/admin_credential.json)\n"
    else:
        cred_line = "  Login   : (first run — open the admin panel to create a password)\n"
    print(
        "\n"
        "=" * 60 + "\n"
        f"  IRIBHM Microscopy Platform (v{__version__}) -- Dev Server\n"
        "=" * 60 + "\n"
        f"  URL     : http://{args.host}:{args.port}\n"
        f"  Admin   : http://{args.host}:{args.port}/admpan.html\n"
        f"  Viewer  : http://{args.host}:{args.port}/explorer.html\n"
        f"{cred_line}"
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
