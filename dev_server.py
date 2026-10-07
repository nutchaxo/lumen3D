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
                                       | gallery_add | gallery_delete
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
import atexit
import email.utils
import gzip
import hashlib
import hmac
import http.server
import io
import ipaddress
import json
import math
import os
import posixpath
import re
import secrets
import shutil
import struct
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import OrderedDict
from datetime import datetime
from http import HTTPStatus
from pathlib import Path

# Dataset import staging (the admin Import page). Kept in its own module because
# the chunk/journal/validation logic is self-contained and unit-testable without
# an HTTP server; this file only routes to it. See upload_staging.py.
import upload_staging
# In-place format upgrades of published datasets (admin "Data updates" tab). Same
# split: the engine and its pure format functions live in dataset_migrations.py,
# this file only authenticates and routes /api/migrations.php to it.
import dataset_migrations

__version__ = "0.16.0"

# ── Paths ──────────────────────────────────────────────────────────────────────
ROOT       = Path(__file__).resolve().parent
DATA_WEB   = ROOT / "DATA_WEB"
# Dataset import staging root. FORBIDDEN as a static path (see _FORBIDDEN_ROOTS):
# it holds browser-supplied bytes that have not passed validate_dataset() yet.
UPLOADS_DIR = ROOT / "uploads"
upload_staging.configure(ROOT)
CONFIG_FILE = ROOT / "api" / "config.json"
# Admin credential store (separate, single source of truth for the password).
# Lives under api/ → never served over HTTP (see _is_forbidden_static).
CRED_FILE = ROOT / "api" / "admin_credential.json"
# Usage analytics (visits / dataset views / downloads) and plugin enable state.
STATS_FILE = ROOT / "api" / "stats.json"
DISABLED_PLUGINS_FILE = ROOT / "api" / "disabled-plugins.json"
# Operator plugin-approval store (third-party trust). Never served over HTTP, never
# touched by the updater, never seedable by a release (see _classify_plugin / INV-5).
TRUST_FILE = ROOT / "api" / "plugin-trust.json"
# Self-update: where pre-update backups land, and the GitHub repo to pull releases from.
BACKUPS_DIR = ROOT / "backups"
LOGS_DIR = ROOT / "logs"
CHANGELOG_DIR = ROOT / "changelog"
GITHUB_REPO = "nutchaxo/lumen3D"
MODULES_DIR = ROOT / "js" / "modules"
PLUGIN_PLACEMENTS = ("tools", "channels", "shaders")
LANG_DIR = ROOT / "lang"
# A bare locale code (BCP-47-ish): two/three letters with an optional region.
_LANG_CODE_RE = re.compile(r"^[a-z]{2,3}(-[A-Za-z]{2,4})?$")

# ── White-label instance configuration (PUBLIC, served like lang/*.json) ────────
# Operator-editable "study content" that the generic engine must never hardcode:
# brand, specimen vocabulary, SEO/head text, footer, nav, theme, page layouts,
# legal. Lives OUTSIDE api/ (which is static-blocked) precisely because the public
# pages must fetch it. Secrets NEVER go here. Protected from the self-updater by
# _UPDATE_PROTECT so an update never wipes operator customisation.
CONFIG_DIR = ROOT / "config"
# Unpublished page drafts — deliberately under api/ (never web-served) rather than
# in the public config/ tree. Module-level so tests can redirect it like CONFIG_DIR.
PAGE_DRAFTS_DIR = ROOT / "api" / "page-drafts"
CONFIG_DEFAULTS_DIR = CONFIG_DIR / "defaults" / "neutral"
INSTANCE_FILE = CONFIG_DIR / "instance.json"
# Theme editor: config/theme.json (operator tokens) is compiled to a served
# config/theme.css (a single :root{…} + [data-theme=…] block) that every page
# loads via <link> AFTER themes.css. Generated file — never hand-edited.
THEME_CSS_FILE = CONFIG_DIR / "theme.css"
# A CSS custom-property name: --kebab-or-camel. Anything else is dropped (the
# generated CSS is built from operator input; validate names + scrub values).
_THEME_TOKEN_RE = re.compile(r"^--[A-Za-z0-9-]+$")
# Cache the parsed instance config, invalidated on the file's mtime, so the
# per-request {{SITE:…}} head injection never re-parses JSON on the hot path.
_INSTANCE_CACHE: dict = {"sig": None, "data": {}}
# {{SITE:dotted.path|fallback}} — server-side head/brand substitution.
_SITE_PLACEHOLDER_RE = re.compile(r"\{\{SITE:([^}|]+)(?:\|([^}]*))?\}\}")
# A site-config doc slug for pages/<slug> (lowercase, url-safe).
_SITE_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

# ── Default credentials ───────────────────────────────────────────────────────
# No hardcoded password: a random one is generated on first run (printed once)
# and only its salted PBKDF2 hash is persisted.
DEFAULT_USERNAME = "admin"

# ── Session store (in-memory) ──────────────────────────────────────────────────
# { token: { "username": ..., "expires": time.time() + TTL } }
_SESSIONS: dict[str, dict] = {}
_SESSIONS_LOCK = threading.Lock()
SESSION_TTL = 28800  # 8 hours
# A single admin account needs a handful of live sessions; the ceiling only stops
# a flood of successful logins from growing the dict without bound.
MAX_SESSIONS = 256
# Brute-force: { ip: { count, until, seen } }. Every read-check-increment happens
# under _BRUTE_LOCK and the attempt is RESERVED before the password is hashed, so a
# burst of parallel guesses cannot all pass the check while the PBKDF2s run.
_BRUTE: dict[str, dict] = {}
_BRUTE_LOCK = threading.Lock()
_BRUTE_MAX_ENTRIES = 10_000
MAX_ATTEMPTS = 10
LOCKOUT_S    = 900  # 15 min; also the window after which old failures are forgotten
# Soft ceiling across ALL addresses per LOCKOUT_S window (twin of ADMIN_BF_GLOBAL_MAX).
BF_GLOBAL_MAX = 200
_BRUTE_GLOBAL = {"start": 0.0, "count": 0}
# Peers allowed to set X-Forwarded-For / X-Real-IP / X-Forwarded-Proto. Empty by
# default -> every connection is keyed on its TCP peer. Behind a reverse proxy the
# operator names it (--trusted-proxy, or LUMEN_TRUSTED_PROXIES="ip,ip,cidr"),
# otherwise all visitors share the proxy's address and one lockout bucket.
TRUSTED_PROXIES: set[str] = set()


def _parse_proxy_list(value) -> set[str]:
    out = set()
    for item in re.split(r"[\s,;]+", str(value or "")):
        item = item.strip()
        if not item:
            continue
        try:
            out.add(str(ipaddress.ip_network(item, strict=False)) if "/" in item
                    else str(ipaddress.ip_address(item)))
        except ValueError:
            print(f"  [proxy] ignored invalid trusted proxy: {item!r}")
    return out


def _proxies_from_file(path: Path) -> set[str]:
    """api/trusted-proxies.json {"proxies": [...]}: the list a PHP host keeps (never
    served — api/*.json is denied), honoured here too so one file serves both."""
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    items = doc.get("proxies") if isinstance(doc, dict) else None
    return _parse_proxy_list(",".join(str(x) for x in items if isinstance(x, str))) if isinstance(items, list) else set()


TRUSTED_PROXIES |= _parse_proxy_list(os.environ.get("LUMEN_TRUSTED_PROXIES", ""))
TRUSTED_PROXIES |= _proxies_from_file(ROOT / "api" / "trusted-proxies.json")


def _is_trusted_proxy(peer: str) -> bool:
    if not TRUSTED_PROXIES or not peer:
        return False
    if peer in TRUSTED_PROXIES:
        return True
    try:
        addr = ipaddress.ip_address(peer)
    except ValueError:
        return False
    for item in TRUSTED_PROXIES:
        if "/" in item:
            try:
                if addr in ipaddress.ip_network(item, strict=False):
                    return True
            except ValueError:
                continue
    return False


# Session cookie `Secure` flag. Set automatically when a trusted proxy reports
# X-Forwarded-Proto: https; LUMEN_COOKIE_SECURE=1 forces it (TLS terminated by a
# proxy that does not send the header).
_COOKIE_SECURE_FORCED = os.environ.get("LUMEN_COOKIE_SECURE", "").strip().lower() in ("1", "true", "yes")
# Current PBKDF2-HMAC-SHA256 work factor (OWASP 2023 guidance). A stored hash with
# fewer iterations is re-hashed at the next successful login.
PBKDF2_ITERATIONS = 600_000
# Ceilings on a JSON API body, per endpoint, checked against Content-Length before
# a byte is read. The largest legitimate bodies are base64 images (media library
# and gallery: 8 MB decoded) and a page-builder document (2 MB).
_API_BODY_LIMITS = {
    "/api/auth.php": 64 * 1024,
    "/api/telemetry.php": 16 * 1024,
    "/api/admin.php": 1024 * 1024,
    "/api/site.php": 4 * 1024 * 1024,
    "/api/media.php": 16 * 1024 * 1024,
    "/api/datasets.php": 16 * 1024 * 1024,
}
# Idle/stall timeout of a client socket (seconds). Without it a peer that opens a
# connection and sends nothing, or announces a body it never sends, pins a thread.
_SOCKET_TIMEOUT_S = 60
# EDGE-021 / EDGE-049: ceiling for an admin-uploaded thumbnail (reject before write).
MAX_THUMB_BYTES = 5 * 1024 * 1024
# Ceiling on ANY import request body. A chunk is capped far lower by
# upload_staging.MAX_CHUNK_SIZE; this is the outer guard so an oversized
# Content-Length is refused before a byte is read off the socket.
_MAX_UPLOAD_BODY = upload_staging.MAX_CHUNK_SIZE + (1 << 20)
# RACE-020: serialize JSON writers (ThreadingHTTPServer runs handlers concurrently).
_WRITE_LOCK = threading.Lock()
# Serialize the read-modify-write of stats.json so concurrent beacons can't lose
# increments. A SEPARATE lock from _WRITE_LOCK (which _atomic_write takes) — they are
# never held nested in the same order, so no deadlock (threading.Lock isn't reentrant).
_STATS_LOCK = threading.Lock()
# Live self-update progress, polled by the admin UI via /api/admin.php?action=update_status.
_UPDATE_STATE = {"phase": "idle", "pct": 0, "message": "", "error": None, "running": False, "target": None}
# Closes the check-then-set race on _UPDATE_STATE["running"] (two concurrent
# update_apply POSTs must never both launch the pipeline).
_UPDATE_LOCK = threading.Lock()
# Pivot journal: the on-disk transaction log of the file swap. Its presence means
# a swap is in flight (or was interrupted — reconciled at next boot). Lives under
# backups/ (protected, same volume as ROOT → os.replace is atomic).
JOURNAL_FILE = BACKUPS_DIR / "pivot-journal.json"
# Result of the last completed/rolled-back update, persisted across the restart so
# the admin UI can report the outcome once the new (or restored) server is up.
LAST_UPDATE_FILE = BACKUPS_DIR / "last-update.json"
# The curated release artifact (allowlist-built by tools/build_release.py). Preferred
# over GitHub's raw source zipball: it ships version.json with per-file sha256.
_RELEASE_ASSET_RE = re.compile(r"^lumen3d-web-.*\.zip$", re.IGNORECASE)

# Release AUTHENTICITY (L7): the project signing public key (Ed25519, 32 bytes hex).
# CI signs the release's SHA256SUMS with the matching private seed (held in the
# LUMEN_SIGNING_KEY GitHub secret) → SHA256SUMS.sig asset. Before applying an
# update, the running server re-verifies that detached signature against THIS key
# (pinned in the currently-installed code, never taken from the download).
#   - Empty  → authenticity "not configured": integrity-only (sha256) with a loud
#              warning. This is the pre-setup state; run tools/gen_signing_key.py.
#   - Set    → signature is MANDATORY. A release missing SHA256SUMS.sig, or whose
#              signature does not verify under this key, is REJECTED (fail-closed).
# To enable: generate a keypair (tools/gen_signing_key.py), paste the public key
# here AND into install.php's $PINNED_PUBKEY, and store the seed as the CI secret.
_RELEASE_PUBKEY_HEX = "9635e20bd09e2dc84830b018a99f3fb051de2f44db97f03e8d5f28e8d769ed79"

# ── First-party plugin marketplace (white-label) ────────────────────────────────
# A CURATED, first-party catalog of plugins the operator can browse + install in one
# click from the admin panel. The catalog and each plugin release are Ed25519-signed;
# installs are ALWAYS operator-initiated, verified fail-closed, and land in the SAME
# trust gate + sandbox as any other plugin (no new arbitrary-code-execution surface).
#
# _MARKETPLACE_PUBKEY_HEX is SEPARATE from the core release key so plugin-signing
# authority can be rotated independently of core-release authority. Empty ⇒ integrity
# only (sha256) + a loud warning; SET ⇒ signature MANDATORY, fail-closed (a catalog or
# plugin release without a valid signature is refused). Pin it in repo SOURCE (like
# _RELEASE_PUBKEY_HEX) so it ships in every release and survives self-updates.
# _MARKETPLACE_CATALOG_URL points at the signed catalog JSON (its detached signature is
# fetched from the same URL + ".sig"). Empty ⇒ the marketplace tab is inert (no source).
_MARKETPLACE_PUBKEY_HEX = "7f5feaddd11dac38c836f556cd7d7b09fe9a7bda307c20e1e062aafa0ab27d3e"
_MARKETPLACE_CATALOG_URL = "https://raw.githubusercontent.com/nutchaxo/lumen3D/main/marketplace/marketplace-catalog.json"
_MARKETPLACE_MAX_ZIP = 8 * 1024 * 1024      # per-plugin download ceiling

try:
    import ed25519_pure as _ed25519           # vendored, stdlib-only (RFC 8032)
except Exception:
    _ed25519 = None
# Set by main() so the update thread can stop serve_forever cleanly before the
# pivot, and so the pivot journal records how to respawn the server.
_HTTPD = None
_SERVE_HOST = "localhost"
_SERVE_PORT = 8080
_SERVE_ARGS: list = []
# PERF-035: memoized catalog listing, keyed on the metadata.json mtime signature.
_CATALOG_CACHE: dict = {"sig": None, "data": None}
# INV-3: dev-trust is a POSITIVE operator signal (--dev-trust-local), NEVER inferred
# from a missing version.json. On a real deployment this stays False, so the trust
# gate is fail-closed. Bumped on every approve/revoke so viewers can drop revoked
# sandboxes at runtime (trustEpoch).
_DEV_TRUST = False
_TRUST_EPOCH = 0
# CSP (INV-1): the strict policy that makes the null-origin sandbox the only path
# for non-approved code. ENFORCED (not report-only) — the dev server injects a
# per-request nonce into each HTML document ({{CSP_NONCE}} placeholder) and stamps
# the matching 'nonce-…' here. No 'unsafe-inline'/'unsafe-eval'; no blob: in
# script-src (a trusted plugin's Blob-URL <script> is allowed by its nonce, so a
# compromised in-page script still cannot inject an un-nonced blob).
def _csp_policy(nonce: str) -> str:
    # script-src collapses to 'self' + the per-request nonce — all libraries are
    # self-hosted under js/vendor/ (no multi-tenant CDN origin remains as an
    # injection target, and the platform loads offline). worker-src 'self' (no
    # blob: — the only Workers are same-origin file URLs). frame-ancestors 'self'
    # blocks cross-origin framing (clickjacking); the compare page frames only
    # same-origin viewer.html.
    #
    # style (L8): the ELEMENT context is nonce-locked — style-src-elem has NO
    # 'unsafe-inline', so an injected <style> stylesheet (the strong CSS vector:
    # full-page redressing, @import) is blocked; our own inline <style> blocks carry
    # the per-request nonce, and same-origin/Google-Fonts <link>s are host-allowed.
    # The ATTRIBUTE context keeps 'unsafe-inline' (style-src-attr): the platform sets
    # ~200 data-driven style="" values (widths, channel colors) whose only CSP-clean
    # forms are utility-class sprawl or CSSOM rewrites — disproportionate given the
    # residual threat is CSS-only (script-src is nonce-locked) and url()-exfiltration
    # is already closed by img-src/connect-src 'self'. `style-src` remains as the CSP2
    # fallback for engines that don't honor the -elem/-attr split.
    return (
        "default-src 'self'; "
        f"script-src 'self' 'nonce-{nonce}'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        f"style-src-elem 'self' 'nonce-{nonce}' https://fonts.googleapis.com; "
        "style-src-attr 'unsafe-inline'; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; "
        "frame-src 'self'; child-src 'self'; object-src 'none'; base-uri 'self'; "
        "form-action 'self'; frame-ancestors 'self'"
    )
# PERF: a synchronous console write per request sits on the response hot path
# (dozens per page load; the Windows console is slow and serializes across the
# ThreadingHTTPServer workers). Off by default; enable with --verbose. Errors
# (4xx/5xx) always log regardless — see AdminHandler.log_error.
_LOG_REQUESTS = False


# ── Filesystem permissions (keep the site editable over FTP/SFTP) ────────────
# Twin of install.php / api/_admin_lib.php. When this process runs as a different
# system user than the one owning the web root, everything it creates would be
# owned by the process in 0755/0644 and the site's owner could neither write into
# those directories nor delete what is inside them (POSIX takes the delete right
# from the PARENT directory). We detect that split and create world-writable so the
# owner keeps control; run as the owner — the normal case here — and nothing changes.
# api/ secrets keep their own restrictive mode. Override: LUMEN_DIR_MODE/LUMEN_FILE_MODE.

def _perms_owner_split() -> bool:
    if os.name != "posix":
        return False
    try:
        return ROOT.stat().st_uid != os.geteuid()
    except OSError:
        return False


def _mode_override(name: str) -> int | None:
    v = (os.environ.get(name) or "").strip()
    if not re.fullmatch(r"0?[0-7]{3,4}", v):
        return None
    try:
        return int(v, 8)
    except ValueError:
        return None


def _base_modes() -> tuple[int, int]:
    """Modes are INHERITED FROM THE WEB ROOT: it is what the hosting account was set
    up with and already encodes how the site is shared. The common shared-hosting
    layout is `user:client 0770` — the server process and the SFTP login are different
    users of the SAME GROUP, so files must be GROUP-writable (0770/0660); 0755/0644
    would lock the operator out and 0777/0666 would grant more than needed. World-
    writable is kept only for a root writable by nobody but an owner we are not."""
    if os.name != "posix":
        return 0o755, 0o644
    try:
        base = ROOT.stat().st_mode & 0o777
    except OSError:
        return 0o755, 0o644
    if _perms_owner_split() and not base & 0o022:
        base |= 0o022
    return base | 0o700, (base & 0o666) | 0o600


def _dir_mode() -> int:
    return _mode_override("LUMEN_DIR_MODE") or _base_modes()[0]


def _file_mode() -> int:
    return _mode_override("LUMEN_FILE_MODE") or _base_modes()[1]


def _make_dir(path: Path) -> None:
    """mkdir -p, then set the mode on every level created (mkdir applies the umask)."""
    if path.is_dir():
        return
    path.mkdir(parents=True, exist_ok=True)
    if os.name != "posix":
        return
    mode, cur = _dir_mode(), path.resolve()
    root = ROOT.resolve()
    while cur != root and root in cur.parents:
        try:
            cur.chmod(mode)
        except OSError:
            pass
        cur = cur.parent


def _fix_file_mode(path: Path) -> None:
    if os.name == "posix":
        try:
            path.chmod(_file_mode())
        except OSError:
            pass


def _is_secret_rel(rel: str) -> bool:
    return rel.startswith("api/") and rel.endswith(".json")


def _permissions_report() -> dict:
    def uname(uid):
        if uid is None:
            return None
        try:
            import pwd
            return pwd.getpwuid(uid).pw_name
        except Exception:
            return str(uid)
    owner = php_user = None
    if os.name == "posix":
        try:
            owner = ROOT.stat().st_uid
        except OSError:
            owner = None
        php_user = os.geteuid()
    def gname(gid):
        if gid is None:
            return None
        try:
            import grp
            return grp.getgrgid(gid).gr_name
        except Exception:
            return str(gid)
    root_mode = ROOT.stat().st_mode & 0o777 if os.name == "posix" else None
    try:
        group = ROOT.stat().st_gid if os.name == "posix" else None
    except OSError:
        group = None
    return {
        "posix": os.name == "posix",
        "split": _perms_owner_split(),
        "siteOwner": uname(owner),
        "siteGroup": gname(group),
        "phpUser": uname(php_user),
        "dirMode": format(_dir_mode(), "04o"),
        "fileMode": format(_file_mode(), "04o"),
        "rootMode": format(root_mode, "04o") if root_mode is not None else None,
        "groupWritable": bool(root_mode is not None and root_mode & 0o020),
    }


def _apply_tree_modes(max_entries: int = 200_000) -> dict:
    """Repair pass: re-apply the resolved modes across the install (symlinks skipped)."""
    out = {"fixed": 0, "failed": 0, "scanned": 0,
           "dirMode": format(_dir_mode(), "04o"), "fileMode": format(_file_mode(), "04o"),
           "split": _perms_owner_split()}
    if os.name != "posix":
        return out
    dir_mode, file_mode = _dir_mode(), _file_mode()
    for dirpath, dirnames, filenames in os.walk(ROOT, followlinks=False):
        for name, is_dir in [(d, True) for d in dirnames] + [(f, False) for f in filenames]:
            p = Path(dirpath) / name
            out["scanned"] += 1
            if out["scanned"] > max_entries:
                return out
            if p.is_symlink():
                continue
            rel = p.relative_to(ROOT).as_posix()
            if _is_secret_rel(rel):
                continue
            want = dir_mode if is_dir else file_mode
            try:
                if (p.stat().st_mode & 0o777) == want:
                    continue
                p.chmod(want)
                out["fixed"] += 1
            except OSError:
                out["failed"] += 1
    return out


def _replace_retry(src, dst, attempts: int = 10, delay: float = 0.04) -> None:
    """os.replace with a short bounded retry. On Windows a rename onto a file that
    another thread (or the static handler, or an antivirus scan) holds open fails
    with PermissionError for as long as that handle lives — typically milliseconds."""
    for i in range(attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(delay * (i + 1))


def _atomic_write(path: Path, data, *, binary: bool = False, mode: int | None = None) -> None:
    """RACE-020: write to a temp sibling then os.replace (atomic rename on the same
    filesystem), guarded by a process-wide lock — so two concurrent admin POSTs (or a
    save racing a rebuild) can never interleave/truncate a half-written JSON file.

    ``mode`` (POSIX): when set, chmod the final file. mkstemp creates 0600 temp files,
    which is right for api/ secrets but would make a PUBLIC config/ file unreadable by
    a separate static server (e.g. Apache serving a php-fpm-written file) — pass
    mode=0o644 for public config so any host can serve it."""
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
            if mode is not None:
                try:
                    os.chmod(tmp, mode)
                except OSError:
                    pass
            _replace_retry(tmp, str(path))
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


# ── White-label instance config: load + head injection + doc store ──────────────

def _esc_html(s: str) -> str:
    """Minimal HTML escaping for values substituted into served HTML (head/brand)."""
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _load_instance() -> dict:
    """Parsed config/instance.json, memoized on the file mtime. Tolerant: a missing or
    malformed file yields {} (the HTML placeholders then use their inline fallbacks)."""
    try:
        st = INSTANCE_FILE.stat()
        sig = st.st_mtime_ns
    except OSError:
        _INSTANCE_CACHE.update({"sig": None, "data": {}})
        return {}
    if _INSTANCE_CACHE.get("sig") == sig:
        return _INSTANCE_CACHE["data"]
    try:
        data = json.loads(INSTANCE_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
    _INSTANCE_CACHE.update({"sig": sig, "data": data})
    return data


def _apply_site_placeholders(text: str) -> str:
    """Replace {{SITE:dotted.path|fallback}} in an HTML document with the matching
    instance-config value (HTML-escaped), or the inline fallback when unset. Twin of
    api/_html_server.php:lumen_apply_site — keep the two in lockstep."""
    if "{{SITE:" not in text:
        return text
    inst = _load_instance()

    def _repl(m):
        path = m.group(1).strip()
        fallback = m.group(2) if m.group(2) is not None else ""
        val = inst
        for seg in path.split("."):
            if isinstance(val, dict) and seg in val:
                val = val[seg]
            else:
                val = None
                break
        if not isinstance(val, str) or val == "":
            val = fallback
        return _esc_html(val)

    return _SITE_PLACEHOLDER_RE.sub(_repl, text)


def _site_doc_path(doc: str):
    """Map a site-config doc name to (active_path, default_path) under config/, or None
    for an unknown/unsafe name. Supported: instance | theme | legal | pages/<slug>."""
    doc = (doc or "").strip()
    if doc in ("instance", "theme", "legal"):
        return CONFIG_DIR / f"{doc}.json", CONFIG_DEFAULTS_DIR / f"{doc}.json"
    if doc.startswith("pages/"):
        slug = doc[len("pages/"):]
        if _SITE_SLUG_RE.match(slug):
            return CONFIG_DIR / "pages" / f"{slug}.json", CONFIG_DEFAULTS_DIR / "pages" / f"{slug}.json"
    return None


def _site_draft_path(doc: str):
    """Where a page's UNPUBLISHED draft lives — deliberately OUTSIDE the public
    config/ tree. config/pages/<slug>.json is served statically to every visitor, so
    an inline draft was world-readable; since the editor autosaves roughly every
    second, polling that URL let anyone watch the operator write. api/ is denied by
    the static filter here, by api/.htaccess and by router.php alike. None for docs
    with no draft concept (instance/theme/legal) or an unsafe slug."""
    doc = (doc or "").strip()
    if not doc.startswith("pages/"):
        return None
    slug = doc[len("pages/"):]
    if not _SITE_SLUG_RE.match(slug):
        return None
    return PAGE_DRAFTS_DIR / f"{slug}.json"


def _load_site_doc(doc: str):
    """Read a site-config doc (active → default → empty). None on an invalid doc name.

    May still carry a legacy inline ``draft`` (pre-split documents) — call
    _load_site_public() or _load_site_admin() rather than using this directly."""
    res = _site_doc_path(doc)
    if not res:
        return None
    for p in res:
        try:
            if p.exists():
                d = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(d, (dict, list)):
                    return d
        except Exception:
            pass
    return {}


def _migrate_inline_drafts() -> None:
    """Relocate pre-split inline page drafts out of the public tree (runs at boot).

    Documents written before the split kept ``draft`` inside config/pages/<slug>.json,
    which is served statically to every visitor. Fixing them on the next save is not
    enough — the stale public copy keeps leaking until someone edits that page — so
    this sweeps them once, guarded by a marker. Twin: _admin_lib.php's
    admin_migrate_inline_drafts()."""
    marker = PAGE_DRAFTS_DIR / ".migrated"
    if marker.exists():
        return
    complete = True
    pages = CONFIG_DIR / "pages"
    if pages.is_dir():
        for f in sorted(pages.glob("*.json")):
            try:
                doc = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(doc, dict) or "draft" not in doc:
                continue
            slug = f.stem
            if not _SITE_SLUG_RE.match(slug):
                continue
            draft = doc.pop("draft")
            # Park FIRST, strip second, and never strip when parking failed: the
            # public copy is the only remaining copy of that draft, so a read-only
            # api/ would otherwise destroy the operator's unpublished work to fix a
            # confidentiality bug. A non-dict draft carries nothing to lose.
            try:
                if isinstance(draft, dict):
                    _atomic_write(PAGE_DRAFTS_DIR / f"{slug}.json",
                                  json.dumps(draft, indent=2, ensure_ascii=False), mode=0o600)
            except Exception:
                complete = False
                continue
            try:
                _atomic_write(f, json.dumps(doc, indent=2, ensure_ascii=False), mode=_file_mode())
            except Exception:
                complete = False
    # Only claim the sweep is done when every page actually moved — otherwise the
    # marker would freeze a half-migrated tree and the leak would never be retried.
    if not complete:
        return
    try:
        _atomic_write(marker, datetime.now().isoformat(), mode=0o600)
    except Exception:
        pass


def _load_site_public(doc: str):
    """The doc as any visitor may see it: published content only, never the draft."""
    data = _load_site_doc(doc)
    if isinstance(data, dict):
        data.pop("draft", None)
    return data


def _load_site_admin(doc: str):
    """The doc as the operator sees it: published content + the private draft."""
    data = _load_site_doc(doc)
    if not isinstance(data, dict):
        return data
    draft = None
    p = _site_draft_path(doc)
    if p is not None and p.exists():
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(d, dict):
                draft = d
        except Exception:
            pass
    # Back-compat: documents written before the split kept the draft inline. Keep
    # serving it so no work is lost — the next save relocates it — but it must never
    # stay in a payload that could reach a non-admin.
    if draft is None and isinstance(data.get("draft"), dict):
        draft = data["draft"]
    data.pop("draft", None)
    if draft is not None:
        data["draft"] = draft
    return data


def _save_site_doc(doc: str, data) -> bool:
    """Persist a site-config doc atomically (public, world-readable 0644). instance.json
    also drops the mtime cache so the next served page picks up the head change."""
    res = _site_doc_path(doc)
    if not res or not isinstance(data, (dict, list)):
        return False
    active, _default = res
    # Split the draft out before ANYTHING reaches the public config/ tree.
    draft_path = _site_draft_path(doc)
    if draft_path is not None and isinstance(data, dict):
        data = dict(data)                      # never mutate the caller's payload
        draft = data.pop("draft", None)
        if isinstance(draft, dict):
            try:
                draft_path.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write(draft_path, json.dumps(draft, indent=2, ensure_ascii=False), mode=0o600)
            except Exception:
                return False                   # never publish the public half alone
        elif draft_path.exists():
            try:
                draft_path.unlink()
            except OSError:
                pass
    _atomic_write(active, json.dumps(data, indent=2, ensure_ascii=False), mode=_file_mode())
    if doc == "instance":
        _INSTANCE_CACHE.update({"sig": None, "data": {}})
    elif doc == "theme":
        try:
            _regenerate_theme_css(data)
        except Exception:
            pass
    return True


def _scrub_css_value(v) -> str:
    """Neutralize characters that could break out of a CSS declaration/rule. The
    generated theme.css is compiled from operator (admin) input; even though the
    operator is trusted, values are scrubbed + length-capped so a stray brace can
    never corrupt the whole stylesheet (Rule 1.4: reject malformed, never half-apply)."""
    s = str(v)
    for ch in ("{", "}", ";", "<", ">", "\\", "@"):
        s = s.replace(ch, "")
    return s.replace("\n", " ").replace("\r", " ").strip()[:200]


def _theme_css_block(selector: str, tokens) -> str:
    if not isinstance(tokens, dict):
        return ""
    decls = []
    for name, val in tokens.items():
        if not isinstance(name, str) or not _THEME_TOKEN_RE.match(name):
            continue
        sv = _scrub_css_value(val)
        if sv:
            decls.append(f"{name}:{sv}")
    return (selector + "{" + ";".join(decls) + "}\n") if decls else ""


def _generate_theme_css(theme: dict) -> str:
    """Compile config/theme.json → a CSS override sheet: :root{ structural tokens }
    plus optional [data-theme=dark|light]{ surface tokens }. Loaded AFTER themes.css
    so it wins the cascade. Twin of api/site.php:site_generate_theme_css."""
    if not isinstance(theme, dict):
        theme = {}
    out = ["/* GENERATED from config/theme.json by the theme editor — do not edit by hand. */\n"]
    out.append(_theme_css_block(":root", theme.get("tokens")))
    if theme.get("dark"):
        out.append(_theme_css_block('[data-theme="dark"]', theme.get("dark")))
    if theme.get("light"):
        out.append(_theme_css_block('[data-theme="light"]', theme.get("light")))
    return "".join(out)


def _regenerate_theme_css(theme: dict | None = None) -> None:
    if theme is None:
        theme = _load_site_doc("theme")
    _atomic_write(THEME_CSS_FILE, _generate_theme_css(theme if isinstance(theme, dict) else {}), mode=_file_mode())


def _reset_site_doc(doc: str) -> bool:
    """Restore a site-config doc to its shipped neutral default (revert-to-default).
    Routes through _save_site_doc so side effects (instance cache flush, theme.css
    regeneration) fire exactly as on a normal save."""
    res = _site_doc_path(doc)
    if not res:
        return False
    _active, default = res
    try:
        data = json.loads(default.read_text(encoding="utf-8")) if default.exists() else {}
        if not isinstance(data, (dict, list)):
            data = {}
    except Exception:
        data = {}
    return _save_site_doc(doc, data)


def _delete_site_doc(doc: str) -> bool:
    """Delete a custom page doc (config/pages/<slug>.json) from disk. Refuses
    instance/theme/legal (those revert-to-default via reset; they are never
    removed). Idempotent: a missing file still returns True."""
    doc = (doc or "").strip()
    if not doc.startswith("pages/"):
        return False
    res = _site_doc_path(doc)
    if not res:
        return False
    active, _default = res
    try:
        if active.exists():
            active.unlink()
        # The private draft is part of the page: deleting must not orphan it.
        draft_path = _site_draft_path(doc)
        if draft_path is not None and draft_path.exists():
            draft_path.unlink()
        return True
    except Exception:
        return False


_PAGE_MAX_BYTES = 2 * 1024 * 1024   # 2 MB per page doc
_PAGE_SCHEMA_VERSION = 2


def _validate_page_doc(data):
    """Structural gate for a page doc before it is written (rule 1.4: reject a
    malformed doc, don't half-write it). Enforces a size cap, the
    {title?,draft?,published?} shape, bounded section/column/widget counts, and
    width 1–12 (clamped). Forward-compatible: unknown widget TYPES are allowed
    (the renderer degrades gracefully) — only gross structural violations are
    rejected. Stamps schemaVersion. Returns (ok, error|None); mutates `data`
    (schemaVersion + width clamp)."""
    try:
        raw = json.dumps(data)
    except Exception:
        return False, "Malformed page document"
    if len(raw) > _PAGE_MAX_BYTES:
        return False, "Page document too large"
    if not isinstance(data, dict):
        return False, "Page document must be an object"
    data["schemaVersion"] = _PAGE_SCHEMA_VERSION
    for key in ("published", "draft"):
        src = data.get(key)
        if src is None:
            continue
        if not isinstance(src, dict):
            return False, f"Invalid '{key}' block"
        secs = src.get("sections")
        if secs is None:
            continue   # legacy {blocks:[]} shape → left to the renderer's normalizer
        if not isinstance(secs, list) or len(secs) > 300:
            return False, "Invalid sections"
        for s in secs:
            if not isinstance(s, dict):
                return False, "Invalid section"
            cols = s.get("columns")
            if cols is None:
                continue
            if not isinstance(cols, list) or len(cols) > 12:
                return False, "Invalid columns"
            for c in cols:
                if not isinstance(c, dict):
                    return False, "Invalid column"
                w = c.get("width")
                if isinstance(w, (int, float)):
                    c["width"] = max(1, min(12, int(w)))
                widgets = c.get("widgets")
                if widgets is None:
                    continue
                if not isinstance(widgets, list) or len(widgets) > 500:
                    return False, "Invalid widgets"
                for wd in widgets:
                    if not isinstance(wd, dict) or not isinstance(wd.get("type"), str):
                        return False, "Invalid widget"
    return True, None


# Serialises every read-modify-write of a site doc (merge, draft, rev check): two
# admin tabs saving at once must not interleave between the check and the write.
_SITE_LOCK = threading.RLock()
_MERGE_PATH_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,3}$")
_MERGE_MAX_PATHS = 32


def _site_rev(doc: str):
    """Revision of a site doc as the operator sees it: sha256 over the stored public
    file and, for a page, its private draft (a missing file counts as empty), first
    20 hex. A client that read revision R and saves with ?rev=R is refused (409) when
    the doc changed in between. Twin of api/site.php site_rev — same bytes, same rev."""
    res = _site_doc_path(doc)
    if not res:
        return None
    h = hashlib.sha256()
    for path in (res[0], _site_draft_path(doc)):
        data = b""
        if path is not None:
            try:
                data = path.read_bytes()
            except OSError:
                data = b""
        h.update(str(len(data)).encode("ascii") + b":" + data + b";")
    return h.hexdigest()[:20]


def _parse_merge_paths(raw):
    """`merge=variables,editor,nav.customPages` → validated dotted paths, or None."""
    paths = [p.strip() for p in str(raw or "").split(",") if p.strip()]
    if not paths or len(paths) > _MERGE_MAX_PATHS or not all(_MERGE_PATH_RE.match(p) for p in paths):
        return None
    return paths


def _merge_paths(current: dict, incoming: dict, paths) -> dict:
    """``current`` with each dotted path replaced by its value in ``incoming`` — or
    removed when ``incoming`` has none. Keys nobody listed are left untouched, which
    is what lets the Identity tab, the Types tab and the page editor share one
    instance.json without overwriting each other's fields."""
    out = json.loads(json.dumps(current)) if isinstance(current, dict) else {}
    for path in paths:
        segs = path.split(".")
        src, found = incoming, True
        for seg in segs:
            if isinstance(src, dict) and seg in src:
                src = src[seg]
            else:
                found = False
                break
        node = out
        for seg in segs[:-1]:
            if not isinstance(node.get(seg), dict):
                if not found:
                    node = None
                    break
                node[seg] = {}
            node = node[seg]
        if node is None:
            continue
        if found:
            node[segs[-1]] = json.loads(json.dumps(src))
        else:
            node.pop(segs[-1], None)
    return out


def _site_save_checked(doc: str, data, rev=None, merge=None):
    """Save under _SITE_LOCK with an optional stale-revision check (``rev``) and an
    optional field merge (``merge``: dotted paths). Returns (status, payload)."""
    with _SITE_LOCK:
        if _site_doc_path(doc) is None:
            return 400, {"error": "Invalid doc"}
        current = _site_rev(doc)
        if rev and rev != current:
            return 409, {"error": "stale", "rev": current}
        if merge is not None:
            if doc.strip().startswith("pages/"):
                return 400, {"error": "merge_not_supported"}
            base = _load_site_doc(doc)
            data = _merge_paths(base if isinstance(base, dict) else {},
                                data if isinstance(data, dict) else {}, merge)
        if not _save_site_doc(doc, data if isinstance(data, (dict, list)) else {}):
            return 400, {"error": "Invalid doc"}
        return 200, {"ok": True, "rev": _site_rev(doc)}


def _site_save_draft(doc: str, body, rev=None):
    """Write ONLY a page's private draft — and its title when the body carries one.
    The published block is never touched, so an autosave can never revert a publish
    made elsewhere. Body: {"draft": {...}, "title"?: ...}. Returns (status, payload)."""
    doc = (doc or "").strip()
    draft_path = _site_draft_path(doc)
    if draft_path is None:
        return 400, {"error": "Invalid doc"}
    body = body if isinstance(body, dict) else {}
    draft = body.get("draft")
    if not isinstance(draft, dict):
        return 400, {"error": "Invalid 'draft' block"}
    probe = {"draft": draft}
    ok, err = _validate_page_doc(probe)
    if not ok:
        return 400, {"error": err or "Invalid page"}
    with _SITE_LOCK:
        current = _site_rev(doc)
        if rev and rev != current:
            return 409, {"error": "stale", "rev": current}
        if "title" in body:
            public = _load_site_public(doc)
            public = public if isinstance(public, dict) else {}
            if public.get("title") != body.get("title"):
                public["title"] = body.get("title")
                if not isinstance(public.get("published"), dict):
                    public["published"] = {"sections": []}
                public["schemaVersion"] = _PAGE_SCHEMA_VERSION
                try:
                    _atomic_write(_site_doc_path(doc)[0],
                                  json.dumps(public, indent=2, ensure_ascii=False), mode=_file_mode())
                except OSError:
                    return 500, {"error": "write_failed"}
        try:
            draft_path.parent.mkdir(parents=True, exist_ok=True)
            _atomic_write(draft_path, json.dumps(probe["draft"], indent=2, ensure_ascii=False), mode=0o600)
        except OSError:
            return 500, {"error": "write_failed"}
        return 200, {"ok": True, "rev": _site_rev(doc)}


def _publish_site_doc(doc: str) -> bool:
    """Promote a doc's draft to published (page builder). Copies the `draft` block over
    `published` in-place; no-op-safe for docs without a draft/published split."""
    res = _site_doc_path(doc)
    if not res:
        return False
    data = _load_site_admin(doc)   # needs the private draft to promote it
    if isinstance(data, dict) and "draft" in data:
        data["published"] = data.get("draft")
        return _save_site_doc(doc, data)
    return True


# ── Media library (operator image uploads → config/uploads/) ──────────────────
MEDIA_DIR = CONFIG_DIR / "uploads"
# Raster only: SVG is excluded on purpose (an uploaded SVG served from the config/
# origin could carry inline script if opened directly).
_MEDIA_EXT = {"png", "jpg", "jpeg", "webp", "gif", "avif"}
_MEDIA_MAX = 8 * 1024 * 1024  # 8 MB decoded


def _media_safe_name(name: str):
    name = (name or "").strip().replace("\\", "/").split("/")[-1]
    if "." not in name:
        return None
    stem, ext = name.rsplit(".", 1)
    ext = ext.lower()
    if ext not in _MEDIA_EXT:
        return None
    stem = re.sub(r"[^a-zA-Z0-9_-]+", "-", stem).strip("-").lower()[:60] or "image"
    return f"{stem}.{ext}"


def _media_list():
    out = []
    try:
        if MEDIA_DIR.exists():
            files = [p for p in MEDIA_DIR.iterdir()
                     if p.is_file() and "." in p.name and p.name.rsplit(".", 1)[1].lower() in _MEDIA_EXT]
            for p in sorted(files, key=lambda x: x.stat().st_mtime, reverse=True):
                out.append({"name": p.name, "url": f"config/uploads/{p.name}", "size": p.stat().st_size})
    except Exception:
        pass
    return out


def _media_upload(body):
    import base64
    body = body or {}
    name = _media_safe_name(body.get("filename") or body.get("name") or "")
    if not name:
        return {"ok": False, "error": "Type de fichier non supporté (png, jpg, webp, gif, avif)"}
    data = body.get("data") or ""
    if isinstance(data, str) and data.startswith("data:"):
        comma = data.find(",")
        if comma != -1:
            data = data[comma + 1:]
    try:
        raw = base64.b64decode(data or "", validate=False)
    except Exception:
        return {"ok": False, "error": "Données invalides"}
    if not raw or len(raw) > _MEDIA_MAX:
        return {"ok": False, "error": "Fichier vide ou trop volumineux (max 8 Mo)"}
    try:
        _make_dir(MEDIA_DIR)
        # Images only, never a script — the same guard api/media.php writes.
        upload_staging.write_guard(MEDIA_DIR / ".htaccess", upload_staging.MEDIA_GUARD)
        stem, ext = name.rsplit(".", 1)
        target = MEDIA_DIR / name
        i = 1
        while target.exists():
            name = f"{stem}-{i}.{ext}"
            target = MEDIA_DIR / name
            i += 1
        target.write_bytes(raw)
        try:
            target.chmod(_file_mode())
        except Exception:
            pass
        return {"ok": True, "url": f"config/uploads/{name}", "name": name}
    except Exception:
        return {"ok": False, "error": "Écriture impossible"}


def _media_delete(name: str) -> bool:
    name = _media_safe_name(name)
    if not name:
        return False
    try:
        p = MEDIA_DIR / name
        if p.exists():
            p.unlink()
        return True
    except Exception:
        return False


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def _client_ip(handler) -> str:
    """The client's address, the key of the login throttle. The TCP peer, or —
    behind a declared proxy (--trusted-proxy, LUMEN_TRUSTED_PROXIES,
    api/trusted-proxies.json) — the right-most X-Forwarded-For hop that is not itself
    a declared proxy: each proxy APPENDS the peer it saw, so anything left of that
    hop was written by the client and would let a guesser pick a fresh bucket per
    request. A malformed hop ends the walk; X-Real-IP, then the peer, are the
    fallbacks. Twin of api/_admin_lib.php admin_client_ip."""
    peer = handler.client_address[0] if getattr(handler, "client_address", None) else handler.address_string()
    if not _is_trusted_proxy(peer):
        return peer or "unknown"
    hops = [h.strip() for h in (handler.headers.get("X-Forwarded-For") or "").split(",")]
    for hop in reversed(hops):
        if not hop or not _is_ip(hop):
            break
        if not _is_trusted_proxy(hop):
            return hop
    xri = (handler.headers.get("X-Real-IP") or "").strip()
    return xri if xri and _is_ip(xri) else peer


def _request_is_https(handler) -> bool:
    """True when the browser reached us over TLS (terminated by a trusted proxy)."""
    if _COOKIE_SECURE_FORCED:
        return True
    peer = handler.client_address[0] if getattr(handler, "client_address", None) else ""
    if not _is_trusted_proxy(peer):
        return False
    proto = (handler.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
    return proto == "https"


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


def _hash_password(plain: str, salt=None, iterations: int = PBKDF2_ITERATIONS) -> str:
    """Salted PBKDF2-HMAC-SHA256, stored as 'pbkdf2_sha256$iters$salt_hex$hash_hex'."""
    if salt is None:
        salt = secrets.token_bytes(16)
    elif isinstance(salt, str):
        salt = bytes.fromhex(salt)
    dk = hashlib.pbkdf2_hmac("sha256", plain.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${dk.hex()}"


def _verify_password(plain: str, stored: str) -> bool:
    if not isinstance(stored, str) or not stored or not isinstance(plain, str):
        return False
    try:
        if stored.startswith("pbkdf2_sha256$"):
            _scheme, iters, salt_hex, _hash_hex = stored.split("$")
            iters = int(iters)
            if not (1 <= iters <= 10_000_000):
                return False
            return hmac.compare_digest(
                _hash_password(plain, salt=salt_hex, iterations=iters).encode("ascii"),
                stored.encode("utf-8"))
        # Legacy unsalted SHA-256 credential. Still verified so an old install can
        # log in once; _check_credentials then rewrites it as PBKDF2 and the legacy
        # form is gone for good. Compared as bytes: str compare_digest raises on a
        # non-ASCII stored value.
        return hmac.compare_digest(stored.encode("utf-8"), _sha256(plain).encode("ascii"))
    except Exception:
        return False


def _needs_rehash(stored: str) -> bool:
    """A stored hash weaker than the current scheme: legacy SHA-256, or PBKDF2
    with fewer iterations than PBKDF2_ITERATIONS."""
    if not isinstance(stored, str) or not stored.startswith("pbkdf2_sha256$"):
        return True
    try:
        return int(stored.split("$")[1]) < PBKDF2_ITERATIONS
    except (IndexError, ValueError):
        return True


_DUMMY_HASH: list = []


def _dummy_hash() -> str:
    """A throwaway hash at the current cost, verified against when the username is
    unknown or no credential exists, so a wrong username takes as long as a wrong
    password and the timing does not reveal which one was wrong."""
    if not _DUMMY_HASH:
        _DUMMY_HASH.append(_hash_password(secrets.token_hex(16)))
    return _DUMMY_HASH[0]


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
    if not isinstance(password, str) or len(password) < 8:
        return False, 400, {"error": "weak_password"}
    if CRED_FILE.exists():
        return False, 409, {"error": "already_configured"}
    rec = _credential_record(username, password)
    data = json.dumps(rec, indent=2, ensure_ascii=False).encode("utf-8")
    CRED_FILE.parent.mkdir(parents=True, exist_ok=True)
    # Written in full to a temp sibling, then hard-linked into place: os.link fails
    # if the target exists (create-exclusive, like O_EXCL) and the name only ever
    # appears complete. A crash mid-write used to leave an EMPTY credential that
    # blocked both login and setup until someone deleted it by hand.
    fd, tmp = tempfile.mkstemp(dir=str(CRED_FILE.parent), prefix=".tmp-cred-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        try:
            os.link(tmp, str(CRED_FILE))
        except FileExistsError:
            return False, 409, {"error": "already_configured"}
        except OSError:
            # No hard links on this filesystem: fall back to the O_EXCL create.
            try:
                xfd = os.open(str(CRED_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                return False, 409, {"error": "already_configured"}
            with os.fdopen(xfd, "wb") as f:
                f.write(data)
    except OSError as e:
        return False, 500, {"error": f"setup_failed: {e.__class__.__name__}"}
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
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
    if not isinstance(new, str) or len(new) < 8:
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


_CRED_LOCK = threading.Lock()


def _check_credentials(username: str, password: str) -> bool:
    """Constant work whatever is wrong: an unknown username, or no credential at
    all, still runs one PBKDF2 (against a dummy hash). A correct login on a weaker
    stored hash (legacy SHA-256, fewer iterations) upgrades it in place."""
    if not isinstance(username, str):
        username = ""
    if not isinstance(password, str):
        password = ""
    rec = _load_credential()
    stored = (rec or {}).get("password_pbkdf2") or ""
    user_ok = bool(rec) and hmac.compare_digest(
        username.encode("utf-8", "surrogatepass"),
        str(rec.get("username") or "").encode("utf-8", "surrogatepass"))
    if not user_ok or not isinstance(stored, str) or not stored:
        _verify_password(password, _dummy_hash())
        return False
    if not _verify_password(password, stored):
        return False
    if _needs_rehash(stored):
        _upgrade_credential_hash(stored, password)
    return True


def _upgrade_credential_hash(old_stored: str, password: str) -> None:
    """Re-hash the credential at the current cost after a successful login. Skipped
    when the file changed in between (a concurrent password change wins)."""
    with _CRED_LOCK:
        rec = _load_credential()
        if not rec or rec.get("password_pbkdf2") != old_stored:
            return
        rec["password_pbkdf2"] = _hash_password(password)
        rec["version"] = 1
        try:
            _atomic_write(CRED_FILE, json.dumps(rec, indent=2, ensure_ascii=False))
            _harden_perms(CRED_FILE)
        except OSError as exc:
            print(f"  [auth] credential re-hash failed: {exc}")


def _brute_prune(now: float) -> None:
    """Forget lockouts that have expired and failures older than the window; if the
    table is still full, drop the least recently seen entries. Caller holds the lock."""
    for key in [k for k, v in _BRUTE.items()
                if v.get("until", 0) <= now and v.get("seen", 0) < now - LOCKOUT_S]:
        _BRUTE.pop(key, None)
    overflow = len(_BRUTE) - (_BRUTE_MAX_ENTRIES - 1)
    if overflow > 0:
        for key, _v in sorted(_BRUTE.items(), key=lambda kv: kv[1].get("seen", 0))[:overflow]:
            _BRUTE.pop(key, None)


def _bf_reserve(key: str):
    """Reserve one password attempt for ``key`` (the client address) BEFORE the
    password is hashed. Returns ``(allowed, retry_after_s, reason)``.

    Twin of api/_admin_lib.php admin_bf_reserve, rule for rule: per address,
    MAX_ATTEMPTS attempts in a LOCKOUT_S window, the last of them arming a LOCKOUT_S
    lock; across all addresses, BF_GLOBAL_MAX attempts per window, which caps a
    guessing run spread over many addresses. A burst of parallel requests takes one
    slot each, so it can never get more guesses than the budget. The store is this
    process's memory: it cannot be unwritable, so there is no fail-open path to close.
    """
    now = time.time()
    with _BRUTE_LOCK:
        bf = _BRUTE.get(key)
        if bf is not None and bf.get("until", 0) > now:
            return False, max(1, math.ceil(bf["until"] - now)), "locked"
        if (bf is None or bf.get("start", 0) + LOCKOUT_S <= now
                or (bf.get("until", 0) and bf["until"] <= now)):
            if bf is None and len(_BRUTE) >= _BRUTE_MAX_ENTRIES:
                _brute_prune(now)
            bf = {"start": now, "count": 0, "until": 0, "seen": now}
            _BRUTE[key] = bf
        g = _BRUTE_GLOBAL
        if g["start"] + LOCKOUT_S <= now:
            g["start"], g["count"] = now, 0
        if g["count"] >= BF_GLOBAL_MAX:
            return False, max(1, math.ceil(g["start"] + LOCKOUT_S - now)), "global"
        bf["count"] += 1
        bf["seen"] = now
        if bf["count"] >= MAX_ATTEMPTS:
            bf["until"] = now + LOCKOUT_S
        g["count"] += 1
        return True, 0, None


def _brute_reserve(key: str):
    """Seconds left on a refusal (lockout or global ceiling), or None when the
    attempt may proceed. See _bf_reserve."""
    ok, retry, _reason = _bf_reserve(key)
    return None if ok else retry


def _brute_clear(key: str) -> None:
    """The attempt succeeded: the address's budget is reset and its global slot
    returned (twin of admin_bf_success)."""
    with _BRUTE_LOCK:
        _BRUTE.pop(key, None)
        _BRUTE_GLOBAL["count"] = max(0, _BRUTE_GLOBAL["count"] - 1)


def _new_session(username: str) -> str:
    token = secrets.token_hex(32)
    now = time.time()
    with _SESSIONS_LOCK:
        if len(_SESSIONS) >= MAX_SESSIONS:
            for t in [t for t, v in _SESSIONS.items() if v.get("expires", 0) < now]:
                _SESSIONS.pop(t, None)
            while len(_SESSIONS) >= MAX_SESSIONS:
                oldest = min(_SESSIONS, key=lambda t: _SESSIONS[t].get("expires", 0))
                _SESSIONS.pop(oldest, None)
        _SESSIONS[token] = {
            "username": username,
            "expires": now + SESSION_TTL,
            "csrf": secrets.token_hex(32),
        }
    return token


def _get_session(token: str | None) -> dict | None:
    if not token:
        return None
    with _SESSIONS_LOCK:
        s = _SESSIONS.get(token)
        if not s:
            return None
        if s["expires"] < time.time():
            _SESSIONS.pop(token, None)
            return None
        return s


def _drop_session(token: str | None) -> None:
    if token:
        with _SESSIONS_LOCK:
            _SESSIONS.pop(token, None)


def _revoke_other_sessions(keep_token: str | None) -> int:
    """Log out every session but the caller's (password rotation: a stolen cookie
    must not outlive the change meant to evict it)."""
    with _SESSIONS_LOCK:
        doomed = [t for t in _SESSIONS if t != keep_token]
        for t in doomed:
            _SESSIONS.pop(t, None)
    return len(doomed)


def _get_cookie_token(cookie_header: str | None) -> str | None:
    if not cookie_header:
        return None
    for part in cookie_header.split(";"):
        part = part.strip()
        if part.startswith("admpan_token="):
            return part[len("admpan_token="):]
    return None


WRITE_ACTIONS = ("save", "save_thumbnail", "rebuild_catalog", "set_visibility",
                 "gallery_add", "gallery_delete", "gallery_thumbs")


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


# Top-level directories that must never leave the machine over HTTP.
#   api/      — credential hash, trust store, plugin toggles, shared PHP includes
#   secrets/  — release + marketplace Ed25519 SIGNING SEEDS. Leaking one lets an
#               attacker sign a plugin or release that every installation trusts,
#               so it outranks the credential hash in blast radius.
#   logs/, backups/ — operational traces and pre-update copies of the above
#   .git/     — full history, including anything ever committed by mistake
#   uploads/  — dataset bytes that arrived from a browser and have NOT been
#               structurally validated yet. DATA_WEB is web-served by design, so
#               an import must land somewhere unreachable first; the admin preview
#               reads it back through api/upload.php?action=blob (session-gated).
_FORBIDDEN_ROOTS = frozenset({"api", "secrets", "logs", "backups", "uploads", ".git"})


def _is_forbidden_static(request_path: str) -> bool:
    """True for sensitive server-side paths that must never be served statically.

    The path is percent-DECODED before normalisation. This is load-bearing, not
    cosmetic: ``SimpleHTTPRequestHandler.translate_path`` unquotes before opening
    the file, so a check against the raw request path is bypassed by encoding any
    single character — ``/%61pi/admin_credential.json`` reaches the same file that
    ``/api/admin_credential.json`` does. Decoding first, then normalising, also
    catches ``/x/../api/…``, ``api%2f…`` and backslash/case variants.

    The real API routes are dispatched before this check, so they are unaffected.
    """
    p = urllib.parse.unquote(request_path or "")
    p = p.replace("\\", "/").split("?", 1)[0]
    p = posixpath.normpath("/" + p).lstrip("/").lower()
    return p.split("/", 1)[0] in _FORBIDDEN_ROOTS


# ── Usage statistics ───────────────────────────────────────────────────────────

# Usage beacons are public and frequent; rewriting the whole stats.json for each
# one serialised every request behind the file write. Increments accumulate here
# and are merged into the file at most every _STATS_FLUSH_S seconds, whenever the
# admin reads the figures, and at shutdown.
_STATS_PENDING: dict = {}
_STATS_LAST_FLUSH = [0.0]
_STATS_FLUSH_S = 5.0


def _read_stats_file() -> dict:
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


def _flush_stats_locked() -> None:
    """Merge the pending increments into stats.json. Caller holds _STATS_LOCK."""
    _STATS_LAST_FLUSH[0] = time.monotonic()
    if not _STATS_PENDING:
        return
    pending = dict(_STATS_PENDING)
    _STATS_PENDING.clear()
    stats = _read_stats_file()
    g = stats["global"]
    g.setdefault("since", datetime.now().isoformat())
    for (scope, key, field), value in pending.items():
        if scope == "global":
            g[field] = int(g.get(field, 0)) + value
        elif scope == "daily":
            day = stats["daily"].setdefault(key, {})
            day[field] = int(day.get(field, 0)) + value
        elif scope == "dataset":
            ds = stats["datasets"].setdefault(key, {})
            if field == "lastViewed":
                ds["lastViewed"] = value
            else:
                ds[field] = int(ds.get(field, 0)) + value
    try:
        _atomic_write(STATS_FILE, json.dumps(stats, ensure_ascii=False, separators=(",", ":")))
    except OSError as exc:
        print(f"  [stats] write failed: {exc}")


def _flush_stats() -> None:
    with _STATS_LOCK:
        _flush_stats_locked()


atexit.register(_flush_stats)


def _load_stats() -> dict:
    """Current figures: the file plus anything still pending (flushed first)."""
    with _STATS_LOCK:
        _flush_stats_locked()
        return _read_stats_file()


def _record_event(kind: str, dataset_id: str | None = None) -> None:
    """Increment a usage counter (visit / view / download) — global, per-day, and
    per-dataset. Serialized by _STATS_LOCK so concurrent beacons never lose an
    increment. Callers pass a dataset id only after proving the dataset exists, so
    the per-dataset table is bounded by the catalog."""
    field = {"visit": "visits", "view": "views", "download": "downloads"}.get(kind)
    if not field:
        return
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    with _STATS_LOCK:
        for k in (("global", "", field), ("daily", today, field)):
            _STATS_PENDING[k] = _STATS_PENDING.get(k, 0) + 1
        if dataset_id and kind in ("view", "download"):
            k = ("dataset", dataset_id, field)
            _STATS_PENDING[k] = _STATS_PENDING.get(k, 0) + 1
            if kind == "view":
                _STATS_PENDING[("dataset", dataset_id, "lastViewed")] = now.isoformat()
        if time.monotonic() - _STATS_LAST_FLUSH[0] >= _STATS_FLUSH_S:
            _flush_stats_locked()


# ── Telemetry throttle (twin: api/_admin_lib.php lumen_telemetry_allow) ─────────
# The beacon is public and unauthenticated, so a loop of requests could inflate the
# counters and keep the stats writer busy. Two token buckets gate it: one per client
# IP (resolved through the trusted-proxy rules of _client_ip) and one global. State
# is a fixed table — 16-byte global bucket then TELEMETRY_SLOTS 16-byte slots, each
# u32 tag | u32 milli-tokens | u64 last refill (ms), little-endian — so it can never
# grow: an IP hashes to a slot (sha256(ip) bytes 0..3 as u32 LE, modulo the slot
# count) and a different IP landing there (tag = bytes 4..7 | 1) simply starts a
# fresh bucket; the global bucket still caps the total. Integer arithmetic, so the
# two backends decide identically: tokens += elapsed_ms · rate (a rate of R per
# second is R milli-tokens per ms), capped at burst·1000; a request costs 1000.
TELEMETRY_IP_BURST = 60
TELEMETRY_IP_RATE = 1            # tokens per second
TELEMETRY_GLOBAL_BURST = 600
TELEMETRY_GLOBAL_RATE = 20
TELEMETRY_SLOTS = 4096
_TELEMETRY_STATE = bytearray(16 * (1 + TELEMETRY_SLOTS))
_TELEMETRY_LOCK = threading.Lock()


def _telemetry_refill(tokens: int, last: int, now: int, burst: int, rate: int) -> tuple[int, int]:
    if now > last:
        tokens = min(burst * 1000, tokens + (now - last) * rate)
    return tokens, now


def _telemetry_allow(ip: str, now_ms: int | None = None, state: bytearray | None = None) -> bool:
    """Spend one token of the client's bucket and of the global one, or refuse."""
    now = int(time.time() * 1000) if now_ms is None else int(now_ms)
    buf = _TELEMETRY_STATE if state is None else state
    h = hashlib.sha256((ip or "unknown").encode("utf-8")).digest()
    slot = int.from_bytes(h[0:4], "little") % TELEMETRY_SLOTS
    tag = int.from_bytes(h[4:8], "little") | 1
    off = 16 * (1 + slot)
    with _TELEMETRY_LOCK:
        _gtag, g_tok, g_t = struct.unpack_from("<IIQ", buf, 0)
        if g_t == 0:
            g_tok, g_t = TELEMETRY_GLOBAL_BURST * 1000, now
        g_tok, g_t = _telemetry_refill(g_tok, g_t, now, TELEMETRY_GLOBAL_BURST, TELEMETRY_GLOBAL_RATE)
        s_tag, s_tok, s_t = struct.unpack_from("<IIQ", buf, off)
        if s_tag != tag:
            s_tag, s_tok, s_t = tag, TELEMETRY_IP_BURST * 1000, now
        s_tok, s_t = _telemetry_refill(s_tok, s_t, now, TELEMETRY_IP_BURST, TELEMETRY_IP_RATE)
        allowed = s_tok >= 1000 and g_tok >= 1000
        if allowed:
            s_tok -= 1000
            g_tok -= 1000
        struct.pack_into("<IIQ", buf, 0, 0, g_tok, g_t)
        struct.pack_into("<IIQ", buf, off, s_tag, s_tok, s_t)
    return allowed


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
    ver = _max_version(CHANGELOG_DIR)
    approvals = _load_trust_store()
    manifest = _release_manifest_files()
    enabled_shaders = [p for p in plugins
                       if p.get("placement") == "shaders" and p["path"] not in disabled]
    enabled_shader_paths = {p["path"] for p in enabled_shaders}
    out = []
    for p in plugins:
        path = p["path"]
        is_enabled = path not in disabled
        compat_ok, compat_reason = _compat_satisfies(ver, p.get("platformCompat"))
        trust = _classify_plugin(path, MODULES_DIR / path, approvals, manifest)
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
            "platformCompat": p.get("platformCompat"),
            "compat": compat_ok,
            "compatReason": compat_reason,
            # Trust surface for the admin approval UI (all plugins, incl. untrusted).
            "trust": {"tier": trust["tier"], "hash": trust["hash"],
                      "mode": trust.get("mode"), "caps": trust.get("caps"),
                      "reason": trust.get("reason"),
                      "declaredCaps": sorted(_plugin_declared_caps(MODULES_DIR / path))},
        })
    out.sort(key=lambda x: (x["placement"] or "", x.get("group") or "", x.get("name") or ""))
    return out


def _approve_plugin(path: str, sha256: str, mode: str, caps, current_pw: str):
    """Record an operator approval PINNED to the exact on-disk content hash.
    Returns (ok, status, payload). Hardened per INV-4: re-auth with the current
    password, and the server recomputes the hash itself (never trusts the client's
    sha256 as truth) and requires client==server agreement on the bytes."""
    if not _verify_password(current_pw or "", (_load_credential() or {}).get("password_pbkdf2") or ""):
        return False, 401, {"error": "bad_password"}
    if mode not in ("trusted", "sandboxed"):
        return False, 400, {"error": "bad_mode"}
    safe = _safe_plugin_path(path)
    if not safe:
        return False, 400, {"error": "bad_path"}
    mod_dir = MODULES_DIR / path
    if not (mod_dir / "plugin.json").exists():
        return False, 404, {"error": "unknown_plugin"}
    server_hash = _plugin_hash(_plugin_file_hashes(mod_dir))
    if sha256 != server_hash:
        # The operator reviewed bytes X; the disk is now Y. Refuse (INV-4).
        return False, 409, {"error": "hash_mismatch", "serverHash": server_hash}
    declared = _plugin_declared_caps(mod_dir)
    req_caps = {c for c in (caps or []) if c in _SANDBOX_CAP_ALLOWLIST}
    # The approval must cover at least what the plugin declares it needs.
    if not declared.issubset(req_caps):
        req_caps |= declared
    approvals = [a for a in _load_trust_store() if a.get("path") != path]
    approvals.append({
        "path": path, "sha256": server_hash, "mode": mode,
        "caps": sorted(req_caps), "at": datetime.now().isoformat(),
        "by": (_load_credential() or {}).get("username", DEFAULT_USERNAME),
    })
    _save_trust_store(approvals)
    return True, 200, {"ok": True, "hash": server_hash, "mode": mode, "caps": sorted(req_caps)}


def _revoke_plugin(path: str):
    approvals = _load_trust_store()
    remaining = [a for a in approvals if a.get("path") != path]
    if len(remaining) == len(approvals):
        return False, 404, {"error": "not_approved"}
    _save_trust_store(remaining)
    return True, 200, {"ok": True}


def _safe_plugin_path(path: str):
    """'<placement>/<id>' with both segments validated (no traversal, known
    placement). Returns the pair or None."""
    if not isinstance(path, str):
        return None
    parts = path.split("/")
    if len(parts) != 2:
        return None
    placement, folder = parts
    if placement not in PLUGIN_PLACEMENTS or not _SAFE_FOLDER_RE.match(folder):
        return None
    return placement, folder


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
    """Always 3 components, like the PHP twin admin_version_tuple: an unpadded
    ("1.4",) < ("1.4.0") would read a two-part version as OLDER than its own
    three-part spelling and invent an update out of nothing."""
    try:
        nums = [int(x) for x in re.findall(r"\d+", s or "")[:3]]
    except Exception:
        nums = []
    return tuple(nums + [0] * (3 - len(nums)))


# ── Plugin/platform compatibility ──────────────────────────────────────────────
# Twin of js/core/compat.js — both validated against tests/compat-vector.json;
# any semantic change must land in the three places at once. Fail-closed: a
# present-but-unreadable declaration is INCOMPATIBLE. The single fail-open case
# is an unknown platform version (the gate is inert, and says so).

_COMPAT_OPS_RE = re.compile(r"^(>=|<=|>|<|=|\^|~)?(.+)$")
_COMPAT_NUM_RE = re.compile(r"^(\d+(?:\.\d+){0,2})")


def _compat_nums(s):
    m = _COMPAT_NUM_RE.match(str(s).strip())
    return [int(x) for x in m.group(1).split(".")] if m else None


def _compat_cmp(a: list, b: list) -> int:
    for i in range(3):
        x = a[i] if i < len(a) else 0
        y = b[i] if i < len(b) else 0
        if x != y:
            return -1 if x < y else 1
    return 0


def _compat_bare(tok: str):
    """Bare token → ('any',) | ('exact', nums) | ('range', min, max_ex) | None."""
    tok = tok.strip()
    if tok in ("*", "x"):
        return ("any",)
    stripped = re.sub(r"\.[x*]$", "", tok, flags=re.IGNORECASE)
    explicit_wildcard = stripped != tok
    if not re.fullmatch(r"\d+(\.\d+){0,2}", stripped):
        return None
    nums = _compat_nums(stripped)
    if len(nums) == 3 and not explicit_wildcard:
        return ("exact", nums)
    max_ex = nums.copy()
    max_ex[-1] += 1
    return ("range", nums, max_ex)


def _compat_comparator(tok: str):
    """One RANGE comparator → predicate(nums) | None."""
    m = _COMPAT_OPS_RE.match(tok.strip())
    if not m:
        return None
    op, body = m.group(1) or "", m.group(2)
    if not op:
        b = _compat_bare(body)
        if b is None:
            return None
        if b[0] == "any":
            return lambda v: True
        if b[0] == "exact":
            return lambda v, e=b[1]: _compat_cmp(v, e) == 0
        return lambda v, lo=b[1], hi=b[2]: _compat_cmp(v, lo) >= 0 and _compat_cmp(v, hi) < 0
    if not re.fullmatch(r"\d+(\.\d+){0,2}([.-].*)?", body.strip()):
        return None
    nums = _compat_nums(body)
    if nums is None:
        return None
    if op == ">=":
        return lambda v: _compat_cmp(v, nums) >= 0
    if op == ">":
        return lambda v: _compat_cmp(v, nums) > 0
    if op == "<=":
        return lambda v: _compat_cmp(v, nums) <= 0
    if op == "<":
        return lambda v: _compat_cmp(v, nums) < 0
    if op == "=":
        return lambda v: _compat_cmp(v, nums) == 0
    if op == "^":
        hi = [nums[0] + 1, 0, 0]
        return lambda v: _compat_cmp(v, nums) >= 0 and _compat_cmp(v, hi) < 0
    if op == "~":
        hi = [nums[0], (nums[1] if len(nums) > 1 else 0) + 1, 0]
        return lambda v: _compat_cmp(v, nums) >= 0 and _compat_cmp(v, hi) < 0
    return None


def _compat_satisfies(platform_version, decl):
    """Returns (ok: bool, reason: str). See js/core/compat.js for the contract."""
    if decl is None:
        return True, "no constraint declared"
    if platform_version is None:
        return True, "platform version unknown — gate disabled"
    v = _compat_nums(platform_version)
    if v is None:
        return True, "platform version unreadable — gate disabled"

    if isinstance(decl, str):
        tokens = decl.split()
        if not tokens:
            return False, "empty constraint"
        for tok in tokens:
            pred = _compat_comparator(tok)
            if pred is None:
                return False, f'unreadable constraint token "{tok}"'
            if not pred(v):
                return False, f'platform {platform_version} fails "{decl}"'
        return True, f'matches "{decl}"'

    if isinstance(decl, list):
        if not decl:
            return False, "empty constraint list"
        for item in decl:
            mi = _COMPAT_OPS_RE.match(item.strip()) if isinstance(item, str) else None
            if not isinstance(item, str) or (mi and mi.group(1)):
                return False, f'invalid list item "{item}" (bare tokens only)'
            b = _compat_bare(item)
            if b is None:
                return False, f'unreadable list token "{item}"'
            if b[0] == "any":
                return True, "wildcard"
            if (b[0] == "exact" and _compat_cmp(v, b[1]) == 0) or \
               (b[0] == "range" and _compat_cmp(v, b[1]) >= 0 and _compat_cmp(v, b[2]) < 0):
                return True, f'matches "{item}"'
        return False, f"platform {platform_version} matches none of {decl}"

    return False, f"unreadable constraint (type {type(decl).__name__})"


# ── Plugin trust (third-party isolation) ────────────────────────────────────────
# The SERVER is the trust authority: it classifies every plugin (bundled / dev /
# approved / untrusted), excludes untrusted from discovery, and vouches a content
# hash the client re-verifies over the exact bytes it executes (INV-1/2/3). Twin of
# js/core/plugin-trust.js — hashing validated by tests/plugin-trust-vector.json.

_TRUST_SCHEME = "lumen-plugin-trust/1"
# Files inside a plugin folder that define its identity (code + manifest + shipped
# locales). Any change to any of them changes the hash → a prior approval is void.
_TRUST_HASH_EXT = (".js", ".json", ".mjs", ".css", ".html")


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _plugin_file_hashes(mod_dir: Path) -> dict:
    """{posix-relpath-within-folder: sha256hex} for every identity-bearing file,
    hashed over RAW BYTES AS SERVED (no CRLF/BOM normalization — must match the
    browser's fetch(...).arrayBuffer(), which the server serves verbatim)."""
    out = {}
    if not mod_dir.is_dir():
        return out
    for p in sorted(mod_dir.rglob("*")):
        if p.is_file() and p.suffix.lower() in _TRUST_HASH_EXT and not p.name.startswith("."):
            rel = p.relative_to(mod_dir).as_posix()
            try:
                out[rel] = _sha256_bytes(p.read_bytes())
            except OSError:
                out[rel] = "unreadable"
    return out


def _plugin_hash(file_hashes: dict) -> str:
    """Composite identity hash: sha256 over the scheme + sorted 'relpath:filehash'
    lines. Order-stable and unambiguous (concatenating file bytes would not be)."""
    lines = [f"{rel}:{file_hashes[rel]}" for rel in sorted(file_hashes)]
    doc = _TRUST_SCHEME + "\n" + "\n".join(lines)
    return _sha256_bytes(doc.encode("utf-8"))


def _release_manifest_files() -> dict | None:
    """version.json `files` map (repo-relative posix → sha256) for a release install,
    or None on a dev checkout (no version.json). Source of truth for `bundled`."""
    vj = ROOT / "version.json"
    if not vj.exists():
        return None
    try:
        m = json.loads(vj.read_text(encoding="utf-8"))
        f = m.get("files")
        return f if isinstance(f, dict) else None
    except (OSError, ValueError):
        return None


def _load_trust_store() -> list:
    """Operator approvals: [{path, sha256, mode, caps, at, by}]. Absent ⇒ []."""
    if TRUST_FILE.exists():
        try:
            d = json.loads(TRUST_FILE.read_text(encoding="utf-8"))
            ap = d.get("approvals") if isinstance(d, dict) else None
            return ap if isinstance(ap, list) else []
        except (OSError, ValueError):
            return []
    return []


def _save_trust_store(approvals: list) -> None:
    global _TRUST_EPOCH
    _atomic_write(TRUST_FILE, json.dumps({"version": 1, "approvals": approvals},
                                         indent=2, ensure_ascii=False))
    _harden_perms(TRUST_FILE)
    _TRUST_EPOCH += 1  # signal viewers to re-evaluate / tear down revoked sandboxes


# Capabilities a sandboxed plugin may hold. The operator's approval pins a subset;
# effective = intersection(disk request, approved, this allowlist).
_SANDBOX_CAP_ALLOWLIST = frozenset({
    "toolbar.addButton", "ui.toast", "ui.download",
    "viewer.getCanvasBlob", "viewer.getInfo", "viewer.setRenderMode",
    "channels.getState", "events.subscribe",
})
_SANDBOX_DEFAULT_CAPS = ("toolbar.addButton", "ui.toast", "viewer.getInfo")


def _classify_plugin(plugin_path: str, mod_dir: Path, approvals: list,
                     manifest: dict | None) -> dict:
    """Authoritative trust classification. Returns
    {tier, hash, files, mode?, caps?, reason}. First matching tier wins.

      bundled  — every folder file is in version.json.files with a matching digest
                 (content match, never path match → closes dependency-confusion).
      dev      — only when the operator ran --dev-trust-local (POSITIVE signal;
                 NEVER inferred from a missing version.json — INV-3).
      approved — an operator approval matches the CURRENT on-disk hash AND the
                 on-disk caps are a subset of what was approved.
      untrusted— default (not loaded in-page; excluded from discovery).
    """
    file_hashes = _plugin_file_hashes(mod_dir)
    phash = _plugin_hash(file_hashes)
    base = {"hash": phash, "files": file_hashes}

    # `sandbox: true` in plugin.json is the AUTHOR's declaration that the plugin is
    # written for the LumenPlugin sandbox SDK (not the in-page ViewerContext). It
    # decides the LANE; trust decides only whether it loads at all. So a trusted
    # (bundled/dev/approved) sandbox plugin still runs in the iframe — otherwise its
    # `LumenPlugin.*` calls would be undefined in-page and it would crash.
    wants_sandbox = _plugin_wants_sandbox(mod_dir)
    declared = _plugin_declared_caps(mod_dir)
    sb_caps = sorted((declared or set(_SANDBOX_DEFAULT_CAPS)) & _SANDBOX_CAP_ALLOWLIST)

    def _trusted_result(tier, mode, reason, caps=None):
        if wants_sandbox:
            return {**base, "tier": "sandboxed", "mode": "sandboxed",
                    "caps": caps if caps is not None else sb_caps, "reason": reason + " + sandbox:true"}
        return {**base, "tier": tier, "mode": mode, "caps": caps, "reason": reason}

    # bundled: content-addressed against the signed release manifest.
    if manifest is not None:
        prefix = f"js/modules/{plugin_path}/"
        all_match = bool(file_hashes) and all(
            manifest.get(prefix + rel) == h for rel, h in file_hashes.items()
        )
        if all_match:
            return _trusted_result("bundled", None, "in release manifest")

    # Find this plugin's approval (if any), validated against the CURRENT bytes.
    ap = next((a for a in approvals if a.get("path") == plugin_path), None)
    ap_valid = ap is not None and ap.get("sha256") == phash
    if ap_valid:
        approved_caps = set(ap.get("caps") or [])
        disk_caps = _plugin_declared_caps(mod_dir)
        if not disk_caps.issubset(approved_caps):
            ap_valid = False  # plugin now requests caps beyond what the operator approved
        else:
            eff = sorted((disk_caps or set(_SANDBOX_DEFAULT_CAPS)) & approved_caps & _SANDBOX_CAP_ALLOWLIST)

    # A 'sandboxed' approval is a deliberate CONTAINMENT choice — it must win even on
    # a dev-trust host, or the operator's decision to sandbox would be silently
    # overridden into full in-page execution.
    if ap_valid and ap.get("mode") == "sandboxed":
        return {**base, "tier": "sandboxed", "mode": "sandboxed",
                "caps": eff, "reason": "operator-approved (sandboxed)"}

    # dev: positive operator signal (explicit flag or loopback .git checkout).
    if _DEV_TRUST:
        return _trusted_result("dev", None, "dev-trust (local)")

    if ap_valid and ap.get("mode") == "trusted":
        # An in-page approval of a sandbox:true plugin still runs it sandboxed
        # (author's SDK requires it) — with declared ∩ approved caps (eff).
        return _trusted_result("approved-trusted", "trusted", "operator-approved (in-page)", caps=eff)
    if ap is not None and not ap_valid:
        return {**base, "tier": "untrusted", "reason": "approval void — content or caps changed"}

    return {**base, "tier": "untrusted", "reason": "not approved"}


def _plugin_declared_caps(mod_dir: Path) -> set:
    """The sandboxCapabilities a plugin.json requests, intersected with the host
    allowlist (an unknown cap can never be granted)."""
    try:
        meta = json.loads((mod_dir / "plugin.json").read_text(encoding="utf-8"))
        req = meta.get("sandboxCapabilities")
        if isinstance(req, list):
            return {c for c in req if c in _SANDBOX_CAP_ALLOWLIST}
    except (OSError, ValueError):
        pass
    return set()


def _plugin_wants_sandbox(mod_dir: Path) -> bool:
    """True if plugin.json declares `sandbox: true` — the author says this plugin
    is written for the LumenPlugin sandbox SDK, so it must run in the iframe lane
    regardless of trust tier (running it in-page would crash on LumenPlugin.*)."""
    try:
        meta = json.loads((mod_dir / "plugin.json").read_text(encoding="utf-8"))
        return meta.get("sandbox") is True
    except (OSError, ValueError):
        return False


def _preprocess_version():
    """Version of the Python preprocessing pipeline the operator can actually obtain.

    The downloadable pack wins (_pipeline_pack_versions, defined with the rest of
    the pipeline plumbing further down): it is the copy the admin panel hands out,
    and on a deployed host it is the ONLY copy present — the release excludes
    preprocess/. A dev checkout with no pack built yet falls back to the sources
    the pack would be built from.
    """
    v = _pipeline_pack_versions().get("preprocess")
    if v:
        return v
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
    single source of truth — no constant introduced).

    The dev server's own __version__ is deliberately NOT reported: it versions the
    serving tool, drifts from the platform on purpose, and has no counterpart on a
    PHP host — an operator reading two unrelated numbers side by side can only
    conclude one of them is wrong.
    """
    return {
        "web": _max_version(CHANGELOG_DIR),
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


# ── Document library ───────────────────────────────────────────────────────────
# Operator-facing documents (guides, procedures) live in DOCS/ on GitHub rather
# than inside the release, so a corrected guide reaches every install without
# shipping a new version of the platform.
#
# The filename IS the metadata — no sidecar index to keep in sync:
#
#     260803 - GUIDE-ADMIN - FR.pdf
#     ^date    ^stable id    ^language
#
# The date sorts and versions (newest wins, older ones stay reachable), the id is
# what makes two files the same document across versions and languages, and the
# language lets the panel serve the operator's own. A file that does not match is
# ignored rather than guessed at.
DOCS_DIR_REMOTE = "DOCS"
# Documents are read from the published branch, not from wherever development
# happens: an operator should only ever see a guide that has been released.
DOCS_BRANCH = "main"
_DOC_RE = re.compile(r"^(\d{6})\s*-\s*(.+?)\s*-\s*([A-Za-z]{2,6})\.([A-Za-z0-9]{1,5})$")
_DOCS_CACHE: dict = {"at": 0.0, "payload": None}
_DOCS_TTL = 600.0          # GitHub's unauthenticated API allows 60 calls/hour


def _doc_parse(name: str) -> dict | None:
    m = _DOC_RE.match(name)
    if not m:
        return None
    yymmdd, doc_id, lang, ext = m.group(1), m.group(2).strip(), m.group(3).upper(), m.group(4).lower()
    try:
        y, mo, d = 2000 + int(yymmdd[:2]), int(yymmdd[2:4]), int(yymmdd[4:6])
        date = datetime(y, mo, d).strftime("%Y-%m-%d")
    except ValueError:
        return None                      # 260899 is not a date; treat as unparseable
    return {"file": name, "date": date, "stamp": yymmdd, "id": doc_id, "lang": lang, "ext": ext}


def _docs_list(force: bool = False) -> dict:
    """Group DOCS/ into one entry per document, newest version first."""
    now = time.time()
    if not force and _DOCS_CACHE["payload"] and now - _DOCS_CACHE["at"] < _DOCS_TTL:
        return _DOCS_CACHE["payload"]

    url = (f"https://api.github.com/repos/{GITHUB_REPO}/contents/{DOCS_DIR_REMOTE}"
           f"?ref={DOCS_BRANCH}")
    try:
        entries = _http_get_json(url, timeout=12)
    except urllib.error.HTTPError as e:
        payload = {"docs": [], "error": "rate_limited" if e.code == 403 else "unreachable",
                   "detail": f"HTTP {e.code}", "repo": GITHUB_REPO}
        _DOCS_CACHE.update(at=now, payload=payload)
        return payload
    except Exception as e:
        payload = {"docs": [], "error": "unreachable", "detail": str(e)[:160], "repo": GITHUB_REPO}
        _DOCS_CACHE.update(at=now, payload=payload)
        return payload

    if not isinstance(entries, list):
        payload = {"docs": [], "error": "no_folder", "repo": GITHUB_REPO}
        _DOCS_CACHE.update(at=now, payload=payload)
        return payload

    groups: dict[str, dict] = {}
    skipped = []
    for e in entries:
        if e.get("type") != "file":
            continue
        nm = e.get("name", "")
        info = _doc_parse(nm)
        if not info:
            # README.md documents the naming rule and is expected to be here;
            # reporting it as a malformed document every time is just noise.
            if not nm.lower().startswith(("readme", ".")):
                skipped.append(nm)
            continue
        info["size"] = e.get("size", 0)
        g = groups.setdefault(info["id"], {"id": info["id"], "versions": []})
        g["versions"].append(info)

    docs = []
    for g in groups.values():
        # newest first; ties broken on language so the order is stable
        g["versions"].sort(key=lambda v: (v["stamp"], v["lang"]), reverse=True)
        g["languages"] = sorted({v["lang"] for v in g["versions"]})
        g["latest"] = g["versions"][0]["stamp"]
        g["latestDate"] = g["versions"][0]["date"]
        docs.append(g)
    docs.sort(key=lambda d: (d["latest"], d["id"]), reverse=True)

    payload = {"docs": docs, "repo": GITHUB_REPO, "folder": DOCS_DIR_REMOTE,
               "skipped": skipped[:10]}
    _DOCS_CACHE.update(at=now, payload=payload)
    return payload


_DOC_MIME = {
    "pdf": "application/pdf", "md": "text/plain; charset=utf-8",
    "txt": "text/plain; charset=utf-8", "html": "text/html; charset=utf-8",
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "svg": "image/svg+xml", "zip": "application/zip",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
# Only these may be shown in a frame. HTML and SVG are deliberately absent: both
# can carry script, and a document is fetched from a repository — displaying one
# inline on this origin would run it beside the admin session. They download.
DOC_INLINE_OK = {"pdf", "png", "jpg", "jpeg", "txt", "md"}


def _doc_fetch(name: str) -> tuple[bytes, str] | None:
    """Fetch one document from GitHub. Returns (bytes, content-type).

    The name is validated against the naming rule AND against the live listing:
    the proxy must never be usable to pull an arbitrary repo path through the
    admin session.
    """
    info = _doc_parse(name)
    if not info:
        return None
    listing = _docs_list()
    known = {v["file"] for d in listing.get("docs", []) for v in d["versions"]}
    if name not in known:
        return None
    url = (f"https://raw.githubusercontent.com/{GITHUB_REPO}/{DOCS_BRANCH}/"
           f"{DOCS_DIR_REMOTE}/{urllib.parse.quote(name)}")
    req = urllib.request.Request(url, headers={"User-Agent": "lumen3d-admin"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data, _DOC_MIME.get(info["ext"], "application/octet-stream")


# ── Downloadable processing pipelines ──────────────────────────────────────────
# The admin panel hands operators a self-contained pack that turns raw microscope
# output into datasets: the Imaris .ims volume pipeline plus the Imaris-Excel cell
# tracking pipeline, with a worked example for each and a launcher that verifies
# itself before running. Two editions, because they cannot be delivered the same way:
#
#   "leger"   ~3 MB, BUILT INTO THE RELEASE under assets/pipeline/. Always available,
#             costs the host nothing to serve. Fetches Python at first run.
#   "complet" ~72 MB with a full Python runtime pre-installed. Far too large for the
#             web release artifact, so the release CI attaches it to the GitHub
#             release and the browser downloads it from there directly. The host
#             never proxies it: the PHP fetch helper buffers whole bodies in memory
#             and caps well below that size.
PIPELINE_DIR = ROOT / "assets" / "pipeline"
_PIPELINE_EDITIONS = {"leger": "lumen3d-pipeline-leger-", "complet": "lumen3d-pipeline-complet-"}


def _version_key(stem: str) -> tuple:
    m = re.search(r"(\d+)\.(\d+)\.(\d+)$", stem)
    return tuple(int(g) for g in m.groups()) if m else (0, 0, 0)


_PACK_DOC_CACHE: dict = {}   # str(path) -> ((mtime_ns, size), VERSION.json dict)


def _pipeline_pack_doc(pack: Path) -> dict:
    """The VERSION.json a pack carries, written by tools/build_pipeline_bundle.py.

    Cached on (mtime, size): the admin panel asks on every load, and the answer
    only changes when the artifact on disk does.
    """
    try:
        st = pack.stat()
    except OSError:
        return {}
    key = (st.st_mtime_ns, st.st_size)
    hit = _PACK_DOC_CACHE.get(str(pack))
    if hit and hit[0] == key:
        return hit[1]
    doc = {}
    try:
        with zipfile.ZipFile(pack) as zf:
            name = next((n for n in zf.namelist()
                         if n == "VERSION.json" or n.endswith("/VERSION.json")), None)
            if name:
                with zf.open(name) as fh:
                    parsed = json.loads(fh.read(1 << 16).decode("utf-8"))
                if isinstance(parsed, dict):
                    doc = parsed
    except (OSError, ValueError, zipfile.BadZipFile):
        doc = {}
    _PACK_DOC_CACHE[str(pack)] = (key, doc)
    return doc


def _pipeline_local(edition: str) -> Path | None:
    """The pack to serve for an edition — the current one when several coexist.

    They do coexist: a copy-over update (PHP hosts, api/_admin_lib.php) writes the
    new release's files over the tree without removing what the previous one left.
    The filename cannot arbitrate, because since web v1.42.0 a pack is named after
    the PIPELINE version it contains, which does not move in step with the platform
    version — a pack named 0.15.0 supersedes one named 1.41.0. So the pack that
    declares THIS install's platform version wins; failing that, the most recently
    written one, and only then the highest version in the name.
    """
    prefix = _PIPELINE_EDITIONS.get(edition)
    if not prefix or not PIPELINE_DIR.is_dir():
        return None
    found = sorted(PIPELINE_DIR.glob(f"{prefix}*.zip"))
    if len(found) <= 1:
        return found[0] if found else None
    here = _max_version(CHANGELOG_DIR)

    def rank(p: Path) -> tuple:
        try:
            mtime = p.stat().st_mtime_ns
        except OSError:
            mtime = 0
        matches_install = bool(here) and _pipeline_pack_doc(p).get("platformVersion") == here
        return (1 if matches_install else 0, mtime, _version_key(p.stem))

    return max(found, key=rank)


def _pipeline_pack_versions() -> dict:
    """Versions carried BY the downloadable pack.

    The pack's own version is the pipeline's; the platform version it shipped with
    is recorded beside it, which is what lets _pipeline_local tell a current pack
    from one a previous release left behind.
    """
    pack = _pipeline_local("leger") or _pipeline_local("complet")
    if not pack:
        return {}
    doc = _pipeline_pack_doc(pack)
    return {"pack": doc.get("bundleVersion"),
            "preprocess": doc.get("preprocessVersion"),
            "platform": doc.get("platformVersion")}


def _pipeline_build_lite() -> Path | None:
    """Build the light pack on demand — dev checkouts only.

    A release ships the finished zip, so this never runs on a deployed host (which
    has neither preprocess/ nor SCRIPTS/ nor tools/). In a dev checkout the sources
    ARE present, and rebuilding keeps the offered pack in step with edited scripts
    instead of serving a stale artifact.
    """
    import subprocess

    builder = ROOT / "tools" / "build_pipeline_bundle.py"
    if not builder.is_file() or not (ROOT / "preprocess").is_dir() or not (ROOT / "SCRIPTS").is_dir():
        return None
    try:
        proc = subprocess.run([sys.executable, str(builder), "--out", str(PIPELINE_DIR)],
                              capture_output=True, text=True, timeout=180, cwd=str(ROOT))
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        print(f"[pipeline] construction du pack echouee: "
              f"{(proc.stderr or proc.stdout or '').strip()[:300]}", flush=True)
        return None
    return _pipeline_local("leger")


_RELEASE_CACHE: dict = {}      # "latest" -> (fetched_at, release dict)
_RELEASE_TTL = 300.0

# The notes of every version ship as ONE asset of each release
# (tools/build_release.py → lumen3d-release-notes.json): a host that skipped
# releases shows the notes of every version it is about to absorb without one
# GitHub call per version — and a version that was never tagged has no release
# body anywhere else. Cached per tag: the asset of a tag never changes.
RELEASE_NOTES_ASSET = "lumen3d-release-notes.json"
_RELEASE_NOTES_MAX_BYTES = 4 * 1024 * 1024
_RELEASE_NOTES_CACHE: dict = {}   # tag -> {version: markdown}
_CHANGELOG_NAME_RE = re.compile(r"^changelog_(\d+\.\d+\.\d+)\.md$")


def _select_changelogs(versions: dict, current: str, latest: str) -> list:
    """The notes of every version the host will absorb — current < v <= latest —
    oldest first, so the operator reads them in the order they were released."""
    lo, hi = _version_tuple(current or "0.0.0"), _version_tuple(latest or "0.0.0")
    picked = []
    for v, md in (versions or {}).items():
        if not isinstance(v, str) or not isinstance(md, str) or not md.strip():
            continue
        if not re.fullmatch(r"\d+\.\d+\.\d+", v):
            continue
        tv = _version_tuple(v)
        if lo < tv <= hi:
            picked.append((tv, v, md))
    picked.sort()
    return [{"version": v, "markdown": md} for _, v, md in picked]


def _parse_release_notes_bundle(raw: bytes) -> dict:
    doc = json.loads(raw.decode("utf-8"))
    out = {}
    entries = doc.get("versions") if isinstance(doc, dict) else None
    for entry in entries or []:
        if (isinstance(entry, dict) and isinstance(entry.get("version"), str)
                and isinstance(entry.get("markdown"), str)):
            out[entry["version"]] = entry["markdown"]
    return out


def _release_notes_bundle(rel: dict) -> dict | None:
    """{version: markdown} read from the release's notes asset, or None when the
    release predates the asset (its body then stands for the latest version alone)."""
    tag = rel.get("tag_name") or ""
    url, size = None, None
    for a in rel.get("assets") or []:
        if a.get("name") == RELEASE_NOTES_ASSET:
            url, size = a.get("browser_download_url"), a.get("size")
            break
    if not url or not tag:
        return None
    if tag in _RELEASE_NOTES_CACHE:
        return _RELEASE_NOTES_CACHE[tag]
    if isinstance(size, int) and size > _RELEASE_NOTES_MAX_BYTES:
        return None
    req = urllib.request.Request(url, headers={"User-Agent": "lumen3d-admin"})
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read(_RELEASE_NOTES_MAX_BYTES + 1)
    if len(raw) > _RELEASE_NOTES_MAX_BYTES:
        return None
    bundle = _parse_release_notes_bundle(raw)
    _RELEASE_NOTES_CACHE[tag] = bundle
    return bundle


def _local_changelogs() -> list:
    """The notes of every installed version, newest first — what the changelog page
    lists under the pending ones."""
    out = []
    for path in CHANGELOG_DIR.glob("changelog_*.md"):
        m = _CHANGELOG_NAME_RE.match(path.name)
        if not m:
            continue
        try:
            md = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if md.strip():
            out.append((_version_tuple(m.group(1)), m.group(1), md))
    out.sort(reverse=True)
    return [{"version": v, "markdown": md} for _, v, md in out]


def _github_latest_release() -> dict:
    """The latest release, cached briefly.

    Both admin tabs ask on load and each asks for its own reason, while GitHub
    allows 60 unauthenticated requests an hour per IP — a shared campus NAT burns
    that fast. One answer serves every caller for five minutes.
    """
    hit = _RELEASE_CACHE.get("latest")
    if hit and (time.time() - hit[0]) < _RELEASE_TTL:
        return hit[1]
    rel = _http_get_json(f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest")
    _RELEASE_CACHE["latest"] = (time.time(), rel)
    return rel


def _pipeline_remote_assets() -> dict:
    """The pipeline packs attached to the latest release, per edition.

    A pack is named after the PIPELINE version it contains, so the filename alone
    dates it — no download needed to tell whether the host's copy is behind.
    Network failures are not errors: the local pack still works, so the caller
    reports what could not be reached and carries on.
    """
    try:
        rel = _github_latest_release()
    except Exception as exc:
        return {"reason": "unreachable", "detail": str(exc)[:200], "editions": {}}
    out = {"tag": rel.get("tag_name"), "editions": {}}
    for asset in rel.get("assets") or []:
        name = asset.get("name") or ""
        if not name.endswith(".zip"):
            continue
        for edition, prefix in _PIPELINE_EDITIONS.items():
            if name.startswith(prefix):
                out["editions"][edition] = {
                    "available": True, "name": name, "size": asset.get("size"),
                    "url": asset.get("browser_download_url"), "tag": rel.get("tag_name"),
                    "version": _version_name(name),
                }
    return out


def _version_name(stem: str) -> str | None:
    m = re.search(r"(\d+\.\d+\.\d+)", stem)
    return m.group(1) if m else None


def _pipeline_github_asset() -> dict:
    """The complete pack among the latest release's assets, for the download card."""
    remote = _pipeline_remote_assets()
    got = remote.get("editions", {}).get("complet")
    if got:
        return dict(got)
    if remote.get("reason"):
        return {"available": False, "reason": remote["reason"], "detail": remote.get("detail")}
    return {"available": False, "reason": "absent", "tag": remote.get("tag")}


def _pipeline_outdated(pack: Path) -> bool:
    """Whether a locally built pack no longer matches the pipeline sources.

    Dev checkouts only: a deployed host has no preprocess/ to compare against, so
    this is always False there and the pack shipped in the release is served as-is.
    In a checkout, a pack whose version differs from run_preprocess.py's is stale
    and would hand out yesterday's scripts under yesterday's number.
    """
    src = ROOT / "preprocess" / "run_preprocess.py"
    try:
        m = re.search(r'__version__\s*=\s*["\']([\d.]+)["\']', src.read_text(encoding="utf-8"))
    except OSError:
        return False
    return bool(m) and _pipeline_pack_doc(pack).get("bundleVersion") != m.group(1)


def _pipeline_local_version(pack: Path) -> str | None:
    """Pipeline version a local pack contains — declared inside, filename as fallback."""
    return _pipeline_pack_doc(pack).get("bundleVersion") or _version_name(pack.stem)


def _pipeline_info() -> dict:
    local_lite = _pipeline_local("leger")
    if local_lite is None or _pipeline_outdated(local_lite):
        local_lite = _pipeline_build_lite() or local_lite
    local_full = _pipeline_local("complet")

    info = {
        # "preprocess" IS the pack's version (CLAUDE.md §1.5: the pack is the
        # preprocessing tool) and is what its filename now carries; "platform" is
        # the web release it was built alongside, absent from packs predating that.
        "versions": {"web": _max_version(CHANGELOG_DIR),
                     "preprocess": _preprocess_version(),
                     "platform": _pipeline_pack_versions().get("platform")},
        "leger": {"available": False},
        "complet": {"available": False},
    }
    if local_lite:
        info["leger"] = {"available": True, "name": local_lite.name,
                         "size": local_lite.stat().st_size, "source": "local",
                         "version": _pipeline_local_version(local_lite)}
    if local_full:
        # An operator can drop the complete pack next to the light one; serving it
        # from the host then beats sending them to GitHub.
        info["complet"] = {"available": True, "name": local_full.name,
                           "size": local_full.stat().st_size, "source": "local",
                           "version": _pipeline_local_version(local_full)}
    else:
        remote = _pipeline_github_asset()
        remote["source"] = "github"
        info["complet"] = remote

    info["update"] = _pipeline_update_state(info)
    return info


def _pipeline_update_state(info: dict, remote: dict | None = None) -> dict:
    """Whether a newer pipeline pack than this host's has been published.

    The pack has its own release cadence: the preprocessing tool moves on its own
    numbers and a platform update is not what should carry it. So the host's copy
    is compared against what the latest release actually attaches, and each edition
    that is behind gets the newer pack offered next to the one already here.
    """
    remote = remote if remote is not None else _pipeline_remote_assets()
    editions = remote.get("editions") or {}
    if not editions:
        return {"available": False, "reason": remote.get("reason", "absent"),
                "detail": remote.get("detail"), "tag": remote.get("tag")}

    newest_local = newest_remote = None
    for edition in _PIPELINE_EDITIONS:
        here = info.get(edition) or {}
        there = editions.get(edition)
        # Only a LOCAL pack can be behind: an edition served straight from GitHub is
        # by construction the published one.
        if here.get("source") != "local" or not there:
            continue
        local_v, remote_v = here.get("version"), there.get("version")
        if not local_v or not remote_v or _version_key(remote_v) <= _version_key(local_v):
            continue
        here["newer"] = dict(there)
        if newest_local is None or _version_key(local_v) < _version_key(newest_local):
            newest_local = local_v
        if newest_remote is None or _version_key(remote_v) > _version_key(newest_remote):
            newest_remote = remote_v

    return {"available": newest_remote is not None,
            "local": newest_local, "remote": newest_remote,
            "tag": remote.get("tag")}


def _update_check() -> dict:
    current = _max_version(CHANGELOG_DIR) or "0.0.0"
    try:
        rel = _http_get_json(f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"current": current, "latest": None, "available": False, "noReleases": True}
        # Unauthenticated GitHub allows 60 requests/hour per IP — a shared campus NAT
        # burns that quickly, and "HTTP 403" alone reads like a permission problem.
        hdr = getattr(e, "headers", None) or {}
        remaining = hdr.get("x-ratelimit-remaining")
        retry_after = hdr.get("retry-after")
        if e.code in (403, 429) and (remaining == "0" or retry_after):
            minutes = None
            reset = hdr.get("x-ratelimit-reset")
            try:
                if reset:
                    minutes = max(1, -(-(int(reset) - int(time.time())) // 60))
                elif retry_after:
                    minutes = max(1, -(-int(retry_after) // 60))
            except (TypeError, ValueError):
                minutes = None
            return {"current": current, "latest": None, "available": False,
                    "error": "rate_limited", "retryAfterMin": minutes, "detail": f"HTTP {e.code}"}
        return {"current": current, "latest": None, "available": False,
                "error": "unreachable", "detail": f"HTTP {e.code}"}
    except Exception as e:
        return {"current": current, "latest": None, "available": False,
                "error": "unreachable", "detail": str(e)}
    latest = (rel.get("tag_name") or "").lstrip("v") or None
    available = bool(latest) and _version_tuple(latest) > _version_tuple(current)
    # Prefer the curated runtime artifact (allowlist-built by tools/build_release.py,
    # ships version.json with per-file sha256) over GitHub's raw source zipball, and
    # pick up the SHA256SUMS asset when published so the download can be verified.
    asset_url = asset_name = sums_url = sig_url = None
    asset_size = None
    asset_error = None
    # The release artifact is named after the tag it was built for. Any other
    # matching asset (an extra zip attached by hand, a stale one) is never applied,
    # and two candidates for the same name make the release ambiguous: refused.
    wanted = f"lumen3d-web-{latest}.zip" if latest else None
    candidates = []
    for a in rel.get("assets") or []:
        name = a.get("name") or ""
        if _RELEASE_ASSET_RE.match(name):
            candidates.append(a)
        elif name == "SHA256SUMS":
            sums_url = a.get("browser_download_url")
        elif name == "SHA256SUMS.sig":
            sig_url = a.get("browser_download_url")
    exact = [a for a in candidates if wanted and (a.get("name") or "").lower() == wanted.lower()]
    if len(exact) == 1:
        a = exact[0]
        asset_url, asset_name, asset_size = a.get("browser_download_url"), a.get("name"), a.get("size")
    elif len(exact) > 1:
        asset_error = "ambiguous_asset"
    elif candidates:
        asset_error = "asset_name_mismatch"
    else:
        asset_error = "no_release_asset"
    if not asset_error and not sums_url:
        asset_error = "no_checksums"
    # One entry per version the update brings, oldest first. The release body is
    # only the newest changelog, so a host several releases behind reads the
    # others from the notes asset; a release older than that asset gets its body.
    changelogs, source = [], None
    if available:
        try:
            bundle = _release_notes_bundle(rel)
        except Exception:
            bundle = None
        if bundle:
            changelogs, source = _select_changelogs(bundle, current, latest), "asset"
        body = rel.get("body")
        if not changelogs and isinstance(body, str) and body.strip():
            changelogs, source = [{"version": latest, "markdown": body}], "body"
    return {
        "current": current,
        "latest": latest,
        "available": available,
        "notes": rel.get("body"),
        "changelogs": changelogs,
        "changelogsSource": source,
        "publishedAt": rel.get("published_at"),
        "zipUrl": rel.get("zipball_url"),
        "htmlUrl": rel.get("html_url"),
        "assetUrl": asset_url,
        "assetName": asset_name,
        "assetSize": asset_size,
        "sumsUrl": sums_url,
        "sigUrl": sig_url,
        "assetError": asset_error,
        "signingConfigured": bool(_RELEASE_PUBKEY_HEX),
    }


# Paths (relative, posix) the update pipeline must NEVER touch — not in the backup
# (they are exactly what an update cannot affect), not in the swap plan, not in the
# deletion list. Three families: user/runtime state, local environments, and
# dev-checkout content that never ships in a release artifact (protected so running
# the updater on a developer machine cannot overwrite or delete it).
_UPDATE_PROTECT = (
    # User / runtime state
    "DATA_WEB", "logs", "backups",
    "uploads",           # in-flight dataset imports — an update must not wipe them
    "api/admin_credential.json", "api/config.json", "api/stats.json",
    "api/disabled-plugins.json", "api/quarantined-plugins.json", "api/plugin-trust.json",
    "api/marketplace-state.json",   # highest marketplace catalog serial seen (anti-rollback)
    "api/page-drafts",   # unpublished page drafts (private half of config/pages/*)
    "secrets",           # Ed25519 signing seeds — never shipped, never overwritten
    # White-label operator config (public, editable from admin). NOT the whole
    # config/ dir — config/defaults/ ships in releases and MUST stay updatable.
    "config/instance.json", "config/theme.json", "config/theme.css",
    "config/legal.json", "config/pages",
    # Local environments / VCS / caches
    ".git", ".conda", ".venv-312", ".runtime", "__pycache__", "node_modules",
    # Dev-checkout content (absent from release artifacts by construction)
    ".github", ".claude", ".agents", ".vscode", ".idea", "DOCS", "preprocess",
    "tests", "tools", "audits", "CLAUDE.md", "README.md",
    ".gitignore", ".gitattributes", "start_dev.bat", "start_php_server.bat",
    # One-file installer artifacts (install.php self-locks; updates must not revive it)
    "install.php", ".install-lock", ".install-state.json",
)


def _is_protected_rel(rel: str) -> bool:
    rel = rel.replace("\\", "/").strip("/")
    for p in _UPDATE_PROTECT:
        if rel == p or rel.startswith(p + "/"):
            return True
    return False


def _set_update(phase: str, pct: int, message: str, error=None, persist: bool = False) -> None:
    _UPDATE_STATE.update({"phase": phase, "pct": pct, "message": message})
    if error is not None:
        _UPDATE_STATE["error"] = error
    if persist:
        # Terminal phases survive the restart so the admin UI can report the outcome
        # once the new (or restored) server answers again.
        try:
            _atomic_write(LAST_UPDATE_FILE, json.dumps({
                "phase": phase, "message": message, "error": error,
                "target": _UPDATE_STATE.get("target"), "at": datetime.now().isoformat(),
            }, indent=2, ensure_ascii=False))
        except OSError:
            pass


def _read_last_update() -> dict | None:
    try:
        d = json.loads(LAST_UPDATE_FILE.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


def _start_update():
    """Validate + kick off the guarded update pipeline in a background thread.
    Returns (ok, status, payload). The lock closes the check-then-set race between
    concurrent update_apply POSTs (ThreadingHTTPServer runs handlers concurrently)."""
    with _UPDATE_LOCK:
        if _UPDATE_STATE.get("running"):
            return False, 409, {"error": "already_running"}
        _UPDATE_STATE["running"] = True  # claimed; released on every non-launch path
    try:
        if JOURNAL_FILE.exists():
            _UPDATE_STATE["running"] = False
            return False, 409, {"error": "pivot_pending"}
        info = _update_check()
        if not info.get("available"):
            _UPDATE_STATE["running"] = False
            return False, 400, {"error": "no_update_available", "info": info}
        # Only the curated, checksummed artifact is ever applied. GitHub's source
        # zipball has no entry in SHA256SUMS and cannot be verified.
        if info.get("assetError") or not (info.get("assetUrl") and info.get("sumsUrl")):
            _UPDATE_STATE["running"] = False
            return False, 400, {"error": "unverifiable_release",
                                "reason": info.get("assetError") or "no_release_asset",
                                "info": info}
        _UPDATE_STATE.update({"phase": "starting", "pct": 0, "message": "Préparation…",
                              "error": None, "target": info.get("latest")})
        threading.Thread(target=_run_update, args=(info,), daemon=True).start()
        return True, 200, {"ok": True, "target": info.get("latest")}
    except BaseException:
        _UPDATE_STATE["running"] = False
        raise


def _make_backup_zip(backup_path: Path) -> None:
    """Zip the release-managed part of the install (protected paths excluded — an
    update cannot touch them, so they need no backup). Any unreadable file ABORTS:
    a silently incomplete safety net is worse than an update that refuses to start."""
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    failures = []
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
                except OSError as e:
                    failures.append(f"{rel}: {e}")
    if failures:
        backup_path.unlink(missing_ok=True)
        head = "; ".join(failures[:5])
        more = f" (+{len(failures) - 5})" if len(failures) > 5 else ""
        raise OSError(f"sauvegarde incomplète — {head}{more}")
    with zipfile.ZipFile(backup_path) as zf:
        bad = zf.testzip()
    if bad:
        backup_path.unlink(missing_ok=True)
        raise OSError(f"sauvegarde corrompue ({bad})")


def _prune_backups(keep_zips: int = 3) -> None:
    """Cap disk growth in backups/: keep the newest pre-update zips and old-tree
    mirrors, drop every stale staging/tmp dir (no update is mid-flight when this
    runs — _run_update calls it before creating its own)."""
    def newest_first(pattern):
        try:
            return sorted(BACKUPS_DIR.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            return []
    for pattern, cap in (("backup-*.zip", keep_zips), ("old-*", 2), ("staging-*", 0), ("tmp-*", 0)):
        for p in newest_first(pattern)[cap:]:
            try:
                shutil.rmtree(p) if p.is_dir() else p.unlink()
            except OSError:
                pass


# Ceiling on a downloaded release archive. A real release is a few megabytes; the
# cap only keeps a hostile or broken source from filling the disk.
_RELEASE_MAX_BYTES = 1 << 30


def _http_download(url: str, dest: Path, *, expected_size=None, progress=None,
                   limit: int = _RELEASE_MAX_BYTES) -> int:
    """Stream url → dest. A truncated body must fail HERE (Content-Length check),
    never surface later in the apply phase. Returns bytes written."""
    req = urllib.request.Request(url, headers={
        "User-Agent": "lumen3d-admin", "Accept": "application/octet-stream",
    })
    written = 0
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        declared = r.headers.get("Content-Length")
        declared = int(declared) if declared and declared.isdigit() else None
        if declared is not None and declared > limit:
            raise OSError(f"archive trop volumineuse ({declared} octets)")
        while True:
            chunk = r.read(256 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > limit:
                raise OSError("archive trop volumineuse")
            f.write(chunk)
            if progress:
                progress(written, declared or expected_size)
    if declared is not None and written != declared:
        raise OSError(f"téléchargement tronqué ({written}/{declared} octets)")
    if expected_size and declared is None and written != expected_size:
        raise OSError(f"taille inattendue ({written}/{expected_size} octets)")
    return written


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _fetch_url_bytes(url: str, *, limit: int = 1 << 20) -> bytes:
    """Fetch a small release asset (SHA256SUMS / .sig) fully into memory, capped."""
    req = urllib.request.Request(url, headers={"User-Agent": "lumen3d-admin"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read(limit + 1)[:limit]


def _parse_sha256sums(raw: bytes) -> dict:
    """Parse coreutils-style SHA256SUMS bytes → {filename: hex}."""
    out = {}
    for line in raw.decode("utf-8", "replace").splitlines():
        parts = line.strip().split()
        if len(parts) == 2 and re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
            out[parts[1].lstrip("*")] = parts[0].lower()
    return out


def _fetch_sha256sums(url: str) -> dict:
    """Parse a coreutils-style SHA256SUMS release asset → {filename: hex}."""
    return _parse_sha256sums(_fetch_url_bytes(url))


def _verify_release_signature(sums_raw: bytes, info: dict) -> None:
    """Authenticity gate (L7). The detached SHA256SUMS.sig must verify against the
    PINNED public key (_RELEASE_PUBKEY_HEX) over the EXACT bytes of SHA256SUMS.

    Fail-closed once a key is pinned: a release without a valid signature is refused.
    With no key pinned, this is a no-op except for a loud "unsigned" warning — the
    integrity chain (sha256) still holds, but authenticity is not proven.
    """
    if not _RELEASE_PUBKEY_HEX:
        print("MAJ: clé de signature non configurée — vérification d'intégrité "
              "seule (sha256), authenticité NON prouvée. Voir tools/gen_signing_key.py.",
              flush=True)
        return
    if _ed25519 is None:
        raise OSError("vérificateur Ed25519 indisponible (ed25519_pure.py) — "
                      "impossible d'authentifier la release (fail-closed)")
    sig_url = info.get("sigUrl")
    if not sig_url:
        raise OSError("release non signée: asset SHA256SUMS.sig absent alors qu'une "
                      "clé de signature est épinglée (fail-closed)")
    try:
        raw = _fetch_url_bytes(sig_url, limit=4096)
        txt = raw.strip()
        # Canonical form is hex (CI writes sig.hex()+"\n"); tolerate an exact raw
        # 64-byte binary. NB: never .strip() a raw signature — an Ed25519 sig can
        # legitimately begin/end with a byte that equals ASCII whitespace.
        if re.fullmatch(rb"[0-9a-fA-F]{128}", txt):
            sig = bytes.fromhex(txt.decode("ascii"))
        elif len(raw) == 64:
            sig = raw
        else:
            sig = txt
    except Exception as e:
        raise OSError(f"signature illisible: {e}")
    if not _ed25519.verify(bytes.fromhex(_RELEASE_PUBKEY_HEX), sums_raw, sig):
        raise OSError("signature de release invalide — authenticité refusée (fail-closed)")
    print(f"MAJ: signature de release vérifiée (Ed25519, clé {_RELEASE_PUBKEY_HEX[:16]}…).",
          flush=True)


def _verify_release_download(info: dict, zip_path: Path) -> None:
    """Integrity + authenticity of a downloaded release, fail-closed.

    The asset MUST have its own line in SHA256SUMS and the digest MUST match: an
    asset absent from the (signed) sums file used to skip the digest check, which
    let a zip attached next to an older, validly signed SHA256SUMS through. With a
    pinned key the sums file must also carry a valid signature; without one the
    chain is integrity-only and _verify_release_signature says so loudly.
    """
    name = info.get("assetName")
    if not info.get("sumsUrl") or not name:
        raise OSError("release sans SHA256SUMS — intégrité impossible à prouver (fail-closed)")
    sums_raw = _fetch_url_bytes(info["sumsUrl"])
    _verify_release_signature(sums_raw, info)          # fail-closed if key pinned
    expected = _parse_sha256sums(sums_raw).get(name)
    if not expected:
        raise OSError(f"{name} absent de SHA256SUMS — archive non couverte, refusée (fail-closed)")
    if _sha256_file(zip_path) != expected:
        raise OSError("empreinte SHA-256 de l'archive invalide")


def _extract_release(zip_path: Path, dest: Path) -> Path:
    """Extract with explicit per-member validation — CPython sanitizes extraction
    paths since 2.7.4, but a release zip is remote input (rule 1.4): reject
    absolute paths, drive letters, backslashes and parent-escapes outright. Then
    locate the runtime root (GitHub source zipballs nest under <owner-repo-sha>/;
    the curated asset is flat)."""
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        for m in zf.infolist():
            name = m.filename
            first = name.split("/", 1)[0]
            if (not name or name.startswith(("/", "\\")) or "\\" in name
                    or ":" in first or ".." in name.split("/")):
                raise OSError(f"entrée d'archive rejetée: {name!r}")
        zf.extractall(dest)
    if (dest / "dev_server.py").exists():
        return dest
    entries = [p for p in dest.iterdir() if p.is_dir()]
    if len(entries) == 1 and (entries[0] / "dev_server.py").exists():
        return entries[0]
    raise OSError("archive invalide: dev_server.py introuvable à la racine")


# ── Plugin marketplace (curated, signed, operator-initiated) ─────────────────────

def _verify_marketplace_signature(data_raw: bytes, sig_url) -> None:
    """Verify a detached Ed25519 signature over data_raw against the PINNED marketplace
    key. Fail-closed once keyed (missing/invalid sig ⇒ refuse); no-op + warning when
    unkeyed. Twin of _verify_release_signature, but with the SEPARATE marketplace key."""
    if not _MARKETPLACE_PUBKEY_HEX:
        print("MARKETPLACE: clé non configurée — intégrité sha256 seule, authenticité "
              "NON prouvée. Voir tools/gen_signing_key.py.", flush=True)
        return
    if _ed25519 is None:
        raise OSError("vérificateur Ed25519 indisponible (fail-closed)")
    if not sig_url:
        raise OSError("signature marketplace absente alors qu'une clé est épinglée (fail-closed)")
    raw = _fetch_url_bytes(sig_url, limit=4096)
    txt = raw.strip()
    if re.fullmatch(rb"[0-9a-fA-F]{128}", txt):
        sig = bytes.fromhex(txt.decode("ascii"))
    elif len(raw) == 64:
        sig = raw
    else:
        sig = txt
    if not _ed25519.verify(bytes.fromhex(_MARKETPLACE_PUBKEY_HEX), data_raw, sig):
        raise OSError("signature marketplace invalide — authenticité refusée (fail-closed)")


# Anti-rollback (twin: api/_admin_lib.php mkt_check_serial). The signed catalog
# carries a `serial` that tools/publish_plugin.py raises on every publish; a host
# remembers the highest one it accepted and refuses an older catalog, which would
# otherwise let whoever can serve a stale — still validly signed — catalog pin the
# host to plugin versions with known flaws. A catalog without `serial` predates it
# and reads as 0. Only a signature-proven catalog may raise the stored serial: an
# unkeyed host could otherwise be frozen by one forged, huge serial.
MARKETPLACE_STATE_FILE = ROOT / "api" / "marketplace-state.json"
_MARKETPLACE_STATE_LOCK = threading.Lock()


class MarketplaceRollback(OSError):
    def __init__(self, offered: int, seen: int):
        super().__init__("catalog_rollback")
        self.offered, self.seen = offered, seen


def _marketplace_check_serial(doc: dict) -> None:
    serial = doc.get("serial", 0)
    if isinstance(serial, bool) or not isinstance(serial, int) or serial < 0:
        raise OSError("catalog_invalid_serial")
    if not _MARKETPLACE_PUBKEY_HEX:
        return
    with _MARKETPLACE_STATE_LOCK:
        try:
            state = json.loads(MARKETPLACE_STATE_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            state = {}
        seen = state.get("highestSerial", 0) if isinstance(state, dict) else 0
        seen = seen if isinstance(seen, int) and not isinstance(seen, bool) and seen >= 0 else 0
        if serial < seen:
            raise MarketplaceRollback(serial, seen)
        if serial > seen:
            issued = doc.get("issuedAt")
            _atomic_write(MARKETPLACE_STATE_FILE, json.dumps({
                "highestSerial": serial,
                "issuedAt": issued if isinstance(issued, str) else None,
                "acceptedAt": datetime.now().isoformat(timespec="seconds"),
            }, indent=2))


def _fetch_marketplace_catalog() -> list:
    """Fetch + signature-verify the curated catalog JSON. Returns its plugin list.
    The catalog itself is signed (URL + '.sig') so the LIST of what-to-install is not
    forgeable, not just each release; its serial is then checked against the highest
    this host has accepted (anti-rollback)."""
    if not _MARKETPLACE_CATALOG_URL:
        raise OSError("marketplace_not_configured")
    raw = _fetch_url_bytes(_MARKETPLACE_CATALOG_URL, limit=1 << 20)
    _verify_marketplace_signature(raw, _MARKETPLACE_CATALOG_URL + ".sig")
    data = json.loads(raw.decode("utf-8"))
    plugins = data.get("plugins") if isinstance(data, dict) else None
    if not isinstance(plugins, list):
        raise OSError("catalogue marketplace invalide")
    _marketplace_check_serial(data)
    return plugins


_MARKETPLACE_CARD_KEYS = ("id", "name", "placement", "subtype", "description",
                          "creator", "icon", "platformCompat", "sandboxCapabilities",
                          "latestVersion", "recommended")


def _marketplace_list() -> dict:
    """Catalog annotated with installed + compat + upgrade status, for the admin
    Marketplace and Updates tabs. Fetch/verify failures are surfaced (never fatal
    to the panel).

    Upgradability is split in two on purpose: `updateAvailable` is what the Updates
    tab may actually act on (newer AND compatible with the platform in place), while
    `updateBlocked` marks a newer version the current platform cannot accept — the
    operator has to see that one too, or the missing entry reads as "no update".
    """
    base = {"configured": bool(_MARKETPLACE_CATALOG_URL), "signed": bool(_MARKETPLACE_PUBKEY_HEX)}
    if not _MARKETPLACE_CATALOG_URL:
        return {**base, "plugins": []}
    try:
        entries = _fetch_marketplace_catalog()
    except MarketplaceRollback as e:
        return {**base, "error": "catalog_rollback",
                "rollback": {"offered": e.offered, "seen": e.seen}, "plugins": []}
    except Exception as e:
        return {**base, "error": str(e), "plugins": []}
    ver = _max_version(CHANGELOG_DIR)
    installed = {p["path"]: p for p in _list_plugins()}
    out = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        pid = str(e.get("id", ""))
        placement = e.get("placement")
        path = f"{placement}/{pid}" if placement in PLUGIN_PLACEMENTS else None
        ok_c, reason_c = _compat_satisfies(ver, e.get("platformCompat"))
        card = {k: e.get(k) for k in _MARKETPLACE_CARD_KEYS}
        local = installed.get(path) if path else None
        cur = str(local.get("version")) if local and local.get("version") else None
        latest = str(e.get("latestVersion")) if e.get("latestVersion") else None
        # No version on either side ⇒ nothing to compare ⇒ no update offered.
        newer = bool(cur and latest and _version_tuple(latest) > _version_tuple(cur))
        card.update({"installed": local is not None,
                     "installedVersion": cur,
                     "updateAvailable": newer and ok_c,
                     "updateBlocked": newer and not ok_c,
                     "compat": ok_c, "compatReason": reason_c})
        out.append(card)
    return {**base, "plugins": out}


def _download_capped(url: str, dest: Path, limit: int) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "lumen3d-admin"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        got = 0
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            got += len(chunk)
            if got > limit:
                raise OSError("téléchargement trop volumineux")
            f.write(chunk)


# What a plugin package may carry (twin of api/_admin_lib.php mkt_plugin_entry_allowed):
# js/modules/ is web-served, so a server-side script or a dotfile (.htaccess) in a
# package must never land there, whatever signed the catalog.
_PLUGIN_ENTRY_EXT = frozenset({"js", "mjs", "json", "css", "html", "md", "txt", "png", "jpg", "jpeg",
                               "gif", "webp", "svg", "woff", "woff2", "ttf", "otf", "wasm", "glsl",
                               "frag", "vert", "map"})


def _plugin_entry_allowed(name: str) -> bool:
    base = name.rstrip("/").rsplit("/", 1)[-1]
    if not base or base.startswith("."):
        return False
    if "." not in base:
        return True                       # LICENSE, README
    return base.rsplit(".", 1)[1].lower() in _PLUGIN_ENTRY_EXT


def _extract_plugin_zip(zip_path: Path, dest: Path) -> Path:
    """Hardened extraction of a plugin zip (remote input, rule 1.4): reject
    traversal/absolute/drive/backslash entries, cap entry count + total size. Returns
    the directory holding plugin.json (flat or single-nested)."""
    dest.mkdir(parents=True, exist_ok=True)
    MAX_ENTRIES, MAX_TOTAL = 500, 24 * 1024 * 1024
    with zipfile.ZipFile(zip_path) as zf:
        infos = zf.infolist()
        if len(infos) > MAX_ENTRIES:
            raise OSError("archive plugin: trop d'entrées")
        total = 0
        for m in infos:
            name = m.filename
            first = name.split("/", 1)[0]
            if (not name or name.startswith(("/", "\\")) or "\\" in name
                    or ":" in first or ".." in name.split("/")):
                raise OSError(f"entrée d'archive rejetée: {name!r}")
            if not name.endswith("/") and not _plugin_entry_allowed(name):
                raise OSError(f"entrée d'archive refusée (type de fichier): {name!r}")
            total += m.file_size
            if total > MAX_TOTAL:
                raise OSError("archive plugin: trop volumineuse")
        zf.extractall(dest)
    if (dest / "plugin.json").exists():
        return dest
    subs = [p for p in dest.iterdir() if p.is_dir()]
    if len(subs) == 1 and (subs[0] / "plugin.json").exists():
        return subs[0]
    raise OSError("archive plugin invalide: plugin.json introuvable")


def _install_marketplace_plugin(catalog_id: str, password: str, upgrade: bool = False):
    """Install — or with upgrade=True, replace in place — a first-party plugin from
    the signed catalog. Operator-initiated, re-auth'd, verified fail-closed; on ANY
    failure js/modules is left untouched, which for an upgrade means the working
    version is put back rather than the operator being left with no plugin. The
    plugin lands as an operator-approved (server-recomputed hash) plugin the existing
    loadModules trust gate re-verifies. Returns (ok, status, payload)."""
    if not _MARKETPLACE_CATALOG_URL:
        return False, 400, {"error": "marketplace_not_configured"}
    if not _verify_password(password or "", (_load_credential() or {}).get("password_pbkdf2") or ""):
        return False, 401, {"error": "bad_password"}
    try:
        entries = _fetch_marketplace_catalog()
    except MarketplaceRollback as e:
        return False, 502, {"error": "catalog_rollback", "rollback": {"offered": e.offered, "seen": e.seen}}
    except Exception as e:
        return False, 502, {"error": "catalog_fetch_failed", "detail": str(e)}
    entry = next((e for e in entries if isinstance(e, dict) and str(e.get("id")) == str(catalog_id)), None)
    if not entry:
        return False, 404, {"error": "unknown_catalog_id"}
    placement, pid = entry.get("placement"), str(entry.get("id", ""))
    if placement not in PLUGIN_PLACEMENTS or not _SAFE_FOLDER_RE.match(pid):
        return False, 400, {"error": "bad_plugin_id"}
    path = f"{placement}/{pid}"
    target_dir = MODULES_DIR / placement / pid
    if target_dir.exists() and not upgrade:
        return False, 409, {"error": "already_installed"}
    if upgrade and not target_dir.exists():
        return False, 404, {"error": "not_installed"}
    ok_c, reason_c = _compat_satisfies(_max_version(CHANGELOG_DIR), entry.get("platformCompat"))
    if not ok_c:
        return False, 409, {"error": "incompatible", "detail": reason_c}
    asset_url, sums_url, sig_url = entry.get("assetUrl"), entry.get("sumsUrl"), entry.get("sigUrl")
    if not asset_url:
        return False, 400, {"error": "no_asset"}
    MODULES_DIR.mkdir(parents=True, exist_ok=True)   # fresh (un-bundled) install: js/modules may not exist yet
    tmp_root = Path(tempfile.mkdtemp(prefix=".mkt-", dir=str(MODULES_DIR)))
    backup = None    # upgrade only: the working copy, parked until the new one is approved
    moved = False

    def _abort(status, payload):
        """Leave js/modules exactly as this call found it, then report."""
        if moved:
            shutil.rmtree(target_dir, ignore_errors=True)
        if backup is not None and backup.exists():
            try:
                _rename_retry(backup, target_dir)
            except OSError:
                pass   # nothing left to try; the payload already says the call failed
        shutil.rmtree(tmp_root, ignore_errors=True)
        return False, status, payload

    try:
        zip_path = tmp_root / "plugin.zip"
        _download_capped(asset_url, zip_path, _MARKETPLACE_MAX_ZIP)
        digest = _sha256_file(zip_path)
        # Authenticity. Fast path: when the marketplace is keyed, _fetch_marketplace_catalog
        # already verified the catalog's Ed25519 signature fail-closed, so entry.sha256 is
        # AUTHENTICATED — trust it and skip the per-plugin SHA256SUMS + .sig fetches (2 fewer
        # sequential GitHub round-trips per install; the install was ~12s from 5 raw requests).
        # Fall back to the detached SHA256SUMS chain when the catalog is unsigned.
        if _MARKETPLACE_PUBKEY_HEX and entry.get("sha256"):
            if str(entry["sha256"]).lower() != digest:
                raise OSError("sha256 du zip ≠ catalogue (signé)")
        elif sums_url:
            sums_raw = _fetch_url_bytes(sums_url, limit=1 << 16)
            _verify_marketplace_signature(sums_raw, sig_url)
            sums = _parse_sha256sums(sums_raw)
            zip_name = asset_url.rsplit("/", 1)[-1]
            expected = sums.get(zip_name) or sums.get(zip_name.lstrip("*")) or (next(iter(sums.values()), None) if len(sums) == 1 else None)
            if not expected or expected != digest:
                raise OSError("sha256 du zip absent/≠ SHA256SUMS")
        elif entry.get("sha256"):
            if str(entry["sha256"]).lower() != digest:
                raise OSError("sha256 du zip ≠ catalogue")
        else:
            raise OSError("aucune empreinte à vérifier (ni SHA256SUMS ni sha256)")
        proot = _extract_plugin_zip(zip_path, tmp_root / "x")
        meta = json.loads((proot / "plugin.json").read_text(encoding="utf-8"))
        if str(meta.get("id", "")) != pid:
            raise OSError("plugin.json id ≠ catalogue")
        if meta.get("placement") and meta["placement"] != placement:
            raise OSError("plugin.json placement ≠ catalogue")
        target_dir.parent.mkdir(parents=True, exist_ok=True)
        if target_dir.exists():
            # Park the working copy instead of deleting it: everything after this
            # point can still fail, and an operator who asked for an upgrade must
            # never end up with less than they had.
            backup = tmp_root / "previous"
            _rename_retry(target_dir, backup)
        _rename_retry(proot, target_dir)
        moved = True
    except Exception as e:
        return _abort(502, {"error": "install_failed", "detail": str(e)})
    # Operator approval PINNED to the on-disk bytes (server recomputes the hash — INV-4).
    server_hash = _plugin_hash(_plugin_file_hashes(target_dir))
    declared = sorted(_plugin_declared_caps(target_dir))
    wants_sandbox = bool(meta.get("sandbox")) or (placement == "tools" and bool(declared))
    mode = "sandboxed" if wants_sandbox else "trusted"
    ok_a, st_a, pl_a = _approve_plugin(path, server_hash, mode, declared, password)
    if not ok_a:
        return _abort(st_a, {**pl_a, "stage": "approve"})
    shutil.rmtree(tmp_root, ignore_errors=True)   # takes the parked previous version with it
    global _TRUST_EPOCH
    _TRUST_EPOCH += 1
    return True, 200, {"ok": True, "path": path, "mode": mode,
                       "version": meta.get("version"), "upgraded": bool(upgrade)}


def _uninstall_marketplace_plugin(path: str):
    """Remove an installed plugin folder + its approval. Idempotent; folder-driven
    (next discovery simply omits it). Refuses to remove the last enabled shader."""
    safe = _safe_plugin_path(path)
    if not safe:
        return False, 400, {"error": "bad_path"}
    placement, folder = safe
    target = MODULES_DIR / placement / folder
    if not target.exists():
        return False, 404, {"error": "not_installed"}
    if placement == "shaders":
        disabled = _load_disabled_plugins()
        enabled_shaders = [p for p in _list_plugins()
                           if p.get("placement") == "shaders" and p["path"] not in disabled]
        if len(enabled_shaders) <= 1 and path in {p["path"] for p in enabled_shaders}:
            return False, 409, {"error": "last_shader"}
    shutil.rmtree(target, ignore_errors=True)
    _revoke_plugin(path)  # drop approval (tolerate not_approved)
    global _TRUST_EPOCH
    _TRUST_EPOCH += 1
    return True, 200, {"ok": True}


def _validate_staging(staging: Path, target: str) -> None:
    """Reject a staged tree that cannot possibly be a working platform BEFORE any
    live file moves. The curated artifact's version.json additionally pins every
    shipped file to a sha256 — verify all of them."""
    required = ("index.html", "viewer.html", "admpan.html", "dev_server.py",
                "js/core/plugin-registry.js", "lang/en.json", "api", "changelog", "css")
    missing = [r for r in required if not (staging / r).exists()]
    if missing:
        raise OSError("arbre incomplet: " + ", ".join(missing))
    # INV-5: a release must NEVER carry the operator trust store — that would let a
    # malicious release pre-approve an attacker plugin. Reject such an artifact.
    if (staging / "api" / "plugin-trust.json").exists():
        raise OSError("artefact rejeté: contient api/plugin-trust.json (pré-approbation interdite)")
    staged_version = _max_version(staging / "changelog")
    if staged_version != target:
        raise OSError(f"version stagée {staged_version!r} ≠ cible {target!r} (release mal taguée)")
    vj = staging / "version.json"
    if vj.exists():
        try:
            manifest = json.loads(vj.read_text(encoding="utf-8"))
        except ValueError as e:
            raise OSError(f"version.json illisible: {e}")
        if manifest.get("web") != target:
            raise OSError(f"version.json ({manifest.get('web')!r}) ≠ cible {target!r}")
        for rel, digest in (manifest.get("files") or {}).items():
            p = staging / rel
            if not p.is_file():
                raise OSError(f"fichier manquant dans l'artefact: {rel}")
            if _sha256_file(p) != str(digest).lower():
                raise OSError(f"empreinte invalide: {rel}")


def _run_offline_check(staging: Path) -> None:
    """Boot gate: the STAGED tree's own dev_server.py must pass its self-check in a
    subprocess. This both validates the tree layout and proves the new server code
    compiles and imports — before a single live file is touched."""
    import subprocess
    proc = subprocess.run(
        [sys.executable, str(staging / "dev_server.py"), "--check", "--root", str(staging)],
        capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0:
        detail = (proc.stdout or proc.stderr or "").strip()[-500:]
        raise OSError(f"le contrôle de démarrage a échoué: {detail}")


def _build_plan(staging: Path) -> dict:
    """Compute the exact swap plan the pivot supervisor applies.

    files     — every file of the staged tree (posix relpaths), minus protected
                paths (defense in depth; the artifact should not contain those).
    deletions — files the PREVIOUS release shipped (ROOT/version.json manifest)
                that the new release no longer contains: removed upstream, so
                removed here too. Files unknown to both manifests (user-added,
                side-loaded plugins) are never listed → never touched.
    """
    files = []
    for root, dirs, fnames in os.walk(staging):
        rel_root = os.path.relpath(root, staging).replace("\\", "/")
        rel_root = "" if rel_root == "." else rel_root
        dirs[:] = [d for d in dirs
                   if not _is_protected_rel(f"{rel_root}/{d}" if rel_root else d)]
        for f in fnames:
            rel = f"{rel_root}/{f}" if rel_root else f
            if not _is_protected_rel(rel):
                files.append(rel)
    files.sort()
    deletions = []
    prev_manifest = ROOT / "version.json"
    if prev_manifest.exists():
        try:
            prev_files = json.loads(prev_manifest.read_text(encoding="utf-8")).get("files") or {}
        except ValueError:
            prev_files = {}
        staged = set(files)
        for rel in prev_files:
            rel = str(rel).replace("\\", "/")
            if rel not in staged and not _is_protected_rel(rel) and (ROOT / rel).is_file():
                deletions.append(rel)
    deletions.sort()
    return {"files": files, "deletions": deletions}


def _update_preflight_report(target: str | None) -> dict:
    """Bidirectional compat gate, CORE side: before updating the platform to
    `target`, report which installed plugins would become incompatible (they get
    quarantined by discovery after the swap — reversible by a later plugin or
    core update). `blocking` is reserved for states that must refuse the update:
    today, losing the last enabled render mode (the viewer needs ≥1 shader)."""
    if not target:
        target = (_update_check() or {}).get("latest")
    current = _max_version(CHANGELOG_DIR)
    disabled = _load_disabled_plugins()
    ok, will_quarantine, blocking = [], [], []
    shaders_surviving = 0
    for p in _list_plugins():
        path = p.get("path")
        ok_target = _compat_satisfies(target, p.get("platformCompat"))[0]
        entry = {"path": path, "name": p.get("name") or p.get("id"),
                 "platformCompat": p.get("platformCompat")}
        if ok_target:
            ok.append(entry)
            if p.get("placement") == "shaders" and path not in disabled:
                shaders_surviving += 1
        else:
            entry["okNow"] = _compat_satisfies(current, p.get("platformCompat"))[0]
            will_quarantine.append(entry)
    if target and shaders_surviving == 0:
        blocking.append({"reason": "no_render_mode",
                         "detail": "Aucun mode de rendu (shader) ne resterait compatible — le viewer serait inutilisable."})
    return {"target": target, "current": current, "ok": ok,
            "willQuarantine": will_quarantine, "blocking": blocking}


def _preflight_update(info: dict) -> None:
    """Everything that can be checked before touching anything, checked first."""
    if JOURNAL_FILE.exists():
        raise OSError("un basculement précédent n'est pas réconcilié (redémarrer le serveur)")
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    # The swap is rename-only → staging and ROOT must share a filesystem. backups/
    # lives under ROOT so this holds by construction; assert anyway (a symlinked
    # backups/ would silently break atomicity).
    if Path(BACKUPS_DIR).resolve().drive != Path(ROOT).resolve().drive:
        raise OSError("backups/ doit être sur le même volume que la plateforme")
    free = shutil.disk_usage(str(ROOT)).free
    need = max(int(info.get("assetSize") or 0) * 3, 300 * 1024 * 1024)
    if free < need:
        raise OSError(f"espace disque insuffisant ({free / 1e9:.1f} Go libres, {need / 1e9:.1f} Go requis)")
    probe = BACKUPS_DIR / f".wtest-{os.getpid()}"
    try:
        probe.write_text("x")
        probe.unlink()
    except OSError as e:
        raise OSError(f"backups/ non inscriptible: {e}")


def _journal_save(journal_file: Path, j: dict) -> None:
    tmp = journal_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(j, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(str(tmp), str(journal_file))


def _read_journal() -> dict | None:
    try:
        d = json.loads(JOURNAL_FILE.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


def _spawn_pivot() -> None:
    """Launch the pivot supervisor: a COPY of this (known-good, currently running)
    server script, executed detached from the temp dir so it holds no handle on any
    file about to be swapped. The copy — not the live file — is executed because
    the live dev_server.py is itself part of the swap."""
    import subprocess
    # A private 0700 directory: a predictable name in the shared temp dir could be
    # pre-planted (symlink) by another local user and then executed by us.
    pivot_dir = Path(tempfile.mkdtemp(prefix="lumen3d-pivot-"))
    pivot_script = pivot_dir / "lumen3d-pivot.py"
    shutil.copyfile(Path(__file__).resolve(), pivot_script)
    LOGS_DIR.mkdir(exist_ok=True)
    log_f = open(LOGS_DIR / f"update-pivot-{datetime.now():%Y%m%d-%H%M%S}.log",
                 "a", encoding="utf-8")
    kwargs = {"cwd": tempfile.gettempdir(), "stdin": subprocess.DEVNULL,
              "stdout": log_f, "stderr": subprocess.STDOUT}
    if os.name == "nt":
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: survives this process's exit.
        kwargs["creationflags"] = 0x00000008 | 0x00000200
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen([sys.executable, str(pivot_script), "--pivot", str(JOURNAL_FILE)], **kwargs)


def _run_update(info: dict) -> None:
    """Update pipeline (daemon thread in the RUNNING server).

    Everything up to the pivot is side-effect-free for the live tree — an error
    at any point leaves the installation untouched. The pivot itself (the only
    mutating phase) is delegated to a supervisor process so the server can be
    stopped, swapped, restarted, health-probed and — if the probe fails —
    automatically rolled back, all from outside the process being replaced.
    """
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    current = info.get("current") or "unknown"
    target = info.get("latest")
    workdir = BACKUPS_DIR / f"tmp-{ts}"
    try:
        _set_update("preflight", 3, "Vérifications préalables…")
        _preflight_update(info)
        _prune_backups()

        _set_update("backup", 8, "Sauvegarde de l'installation…")
        _make_backup_zip(BACKUPS_DIR / f"backup-{current}-{ts}.zip")

        _set_update("download", 15, "Téléchargement de la mise à jour…")
        url = info.get("assetUrl")
        if not url or not info.get("sumsUrl") or not info.get("assetName"):
            raise OSError("release sans archive vérifiable (asset + SHA256SUMS) — refusée")
        workdir.mkdir(parents=True, exist_ok=True)
        zip_path = workdir / "release.zip"

        def _dl_progress(done, total):
            if total:
                _set_update("download", min(15 + int(35 * done / total), 50),
                            f"Téléchargement… {done / 1e6:.1f} / {total / 1e6:.1f} Mo")
        _http_download(url, zip_path, expected_size=info.get("assetSize"),
                       progress=_dl_progress)

        _set_update("verify", 55, "Vérification de l'authenticité…")
        # Authenticity + integrity chain: (pinned key) —sig→ SHA256SUMS —sha256→ zip.
        # Fetch the manifest bytes ONCE: the signature is over those exact bytes, and
        # the zip digest is read from the same bytes we authenticated.
        _verify_release_download(info, zip_path)
        with zipfile.ZipFile(zip_path) as zf:
            bad = zf.testzip()
        if bad:
            raise OSError(f"archive corrompue ({bad})")

        _set_update("staging", 65, "Préparation de la nouvelle version…")
        staging = _extract_release(zip_path, workdir / "tree")
        _validate_staging(staging, target)

        _set_update("verifying", 78, "Contrôle de démarrage de la nouvelle version…")
        _run_offline_check(staging)

        _set_update("planning", 85, "Préparation du basculement…")
        plan = _build_plan(staging)
        _journal_save(JOURNAL_FILE, {
            "phase": "planned", "createdAt": datetime.now().isoformat(),
            "target": target, "current": current,
            "root": str(ROOT), "staging": str(staging),
            "old": str(BACKUPS_DIR / f"old-{current}-{ts}"),
            "plan": plan, "applied": 0,
            "host": _SERVE_HOST, "port": _SERVE_PORT,
            "argv": _SERVE_ARGS, "python": sys.executable,
        })

        _set_update("pivoting", 90, "Basculement vers la nouvelle version…", persist=True)
        _spawn_pivot()
        time.sleep(1.0)  # let in-flight update_status responses flush before the stop
        if _HTTPD is not None:
            threading.Thread(target=_HTTPD.shutdown, daemon=True).start()
        # The process exits once serve_forever returns; the supervisor takes over.
    except Exception as e:
        _UPDATE_STATE["running"] = False
        shutil.rmtree(workdir, ignore_errors=True)
        JOURNAL_FILE.unlink(missing_ok=True)
        _set_update("error", 0, "Échec de la mise à jour — installation intacte.",
                    error=str(e), persist=True)


# ── Pivot supervisor (runs as `dev_server.py --pivot <journal>` from %TEMP%) ────

def _log_pivot(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def _rename_retry(src: Path, dst: Path, attempts: int = 10, delay: float = 0.4) -> None:
    """os.replace with bounded retries — antivirus/indexers hold transient locks on
    freshly written files under Windows; a rename still failing after ~4 s is real."""
    for i in range(attempts):
        try:
            os.replace(str(src), str(dst))
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(delay)


def _loopback_for(host: str) -> str:
    """Map a wildcard/empty BIND address to a routable loopback CONNECT address.

    The server may bind 0.0.0.0 (all interfaces) but you cannot *connect* to
    0.0.0.0 — on Windows urlopen/connect to it raises WinError 10049. The probe
    and port-free check must target a real address the new server accepts on, or
    every update on `--host 0.0.0.0` would spuriously roll back."""
    return "127.0.0.1" if host in ("", "0.0.0.0", "::", "*") else host


def _wait_port_free(host: str, port: int, timeout: float) -> None:
    import socket
    connect_host = _loopback_for(host)
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as s:
            s.settimeout(0.5)
            if s.connect_ex((connect_host, port)) != 0:
                return
        time.sleep(0.4)
    raise OSError(f"le port {port} n'a pas été libéré en {timeout:.0f}s")


def _probe_health(host: str, port: int, expect_version, timeout: float,
                  any_version: bool = False) -> bool:
    """Online gate: the freshly started server must answer /api/health with the
    expected platform version inside the window."""
    deadline = time.time() + timeout
    url = f"http://{_loopback_for(host)}:{port}/api/health"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                data = json.loads(r.read().decode("utf-8"))
            if data.get("ok") and (any_version or data.get("web") == expect_version):
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def _apply_plan(journal_file: Path, j: dict, root: Path, staging: Path, old: Path) -> None:
    """Forward swap — renames only, no data copied, so the whole apply is typically
    sub-second. Idempotent per op (each step checks the DISK, not assumptions), so
    a replay after a crash resumes exactly where it stopped:
      file op    S0(live=old, staged=new) → S1(mirror=old) → S2(live=new)
      delete op  S0(live=old)             → S1(mirror=old)
    """
    plan = j["plan"]
    ops = [("delete", rel) for rel in plan["deletions"]] + [("file", rel) for rel in plan["files"]]
    start = int(j.get("applied") or 0)
    for i, (kind, rel) in enumerate(ops):
        if i < start:
            continue
        live, staged, mirror = root / rel, staging / rel, old / rel
        if kind == "file" and not staged.exists():
            continue  # replay: already promoted (S2)
        if kind == "delete" and mirror.exists():
            continue  # replay: already removed (S1)
        if live.exists():
            mirror.parent.mkdir(parents=True, exist_ok=True)
            _rename_retry(live, mirror)
        if kind == "file":
            live.parent.mkdir(parents=True, exist_ok=True)
            _rename_retry(staged, live)
        if (i + 1) % 50 == 0:
            j["applied"] = i + 1
            _journal_save(journal_file, j)
    j["applied"] = len(ops)


def _reverse_plan(j: dict, root: Path, staging: Path, old: Path) -> None:
    """Restore the pre-update tree exactly. Safe on ANY intermediate state — each
    step checks the disk: promoted staged files go back to staging, mirrored
    originals go back live, restored deletions reappear."""
    plan = j.get("plan") or {"files": [], "deletions": []}
    for rel in plan["files"]:
        live, staged, mirror = root / rel, staging / rel, old / rel
        if not staged.exists() and live.exists():
            staged.parent.mkdir(parents=True, exist_ok=True)
            _rename_retry(live, staged)      # un-promote the staged copy
        if mirror.exists():
            live.parent.mkdir(parents=True, exist_ok=True)
            _rename_retry(mirror, live)      # restore the original
    for rel in plan["deletions"]:
        live, mirror = root / rel, old / rel
        if mirror.exists() and not live.exists():
            live.parent.mkdir(parents=True, exist_ok=True)
            _rename_retry(mirror, live)


def _spawn_server(j: dict):
    """Start the platform server from the (post-swap or restored) live tree,
    detached, with output captured under logs/."""
    import subprocess
    root = Path(j["root"])
    (root / "logs").mkdir(exist_ok=True)
    log_f = open(root / "logs" / f"dev-server-{datetime.now():%Y%m%d-%H%M%S}.log",
                 "a", encoding="utf-8")
    # The supervisor is the SOLE owner of the journal until the probe verdict is in.
    # The server it spawns must NOT run _reconcile_pivot at startup (it would consume
    # the journal + delete staging out from under the supervisor). Signalled by env
    # var, not argv, so it never leaks into the journal-persisted _SERVE_ARGS.
    child_env = {**os.environ, "LUMEN_SKIP_PIVOT_RECONCILE": "1"}
    kwargs = {"cwd": str(root), "stdin": subprocess.DEVNULL,
              "stdout": log_f, "stderr": subprocess.STDOUT, "env": child_env}
    if os.name == "nt":
        kwargs["creationflags"] = 0x00000008 | 0x00000200
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen([j["python"], str(root / "dev_server.py"), *j.get("argv", [])],
                            **kwargs)


def _terminate(proc) -> None:
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _write_result(root: Path, data: dict) -> None:
    try:
        target = root / "backups" / "last-update.json"
        tmp = target.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(str(tmp), str(target))
    except OSError:
        pass


def _verify_tree_manifest(root: Path, expected_version) -> bool:
    """True only if the live tree fully matches its own version.json (web ==
    expected + every listed file's sha256 matches). Proves a swap COMPLETED,
    regardless of journal bookkeeping — a half-applied or half-reverted tree
    fails this (some files are the other version, or version.json itself is)."""
    vj = root / "version.json"
    if not vj.exists():
        return False  # release artifacts ship version.json; its absence ⇒ not fully applied
    try:
        manifest = json.loads(vj.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if manifest.get("web") != expected_version:
        return False
    for rel, digest in (manifest.get("files") or {}).items():
        p = root / rel
        if not p.is_file() or _sha256_file(p) != str(digest).lower():
            return False
    return True


def _finalize_success(journal_file: Path, j: dict, root: Path) -> None:
    _write_result(root, {"phase": "done", "target": j.get("target"),
                         "message": f"Mise à jour vers {j.get('target')} terminée.",
                         "at": datetime.now().isoformat()})
    journal_file.unlink(missing_ok=True)
    # The workdir (tmp-<ts>/: release.zip + now mostly-empty staged tree) is done;
    # the old-tree mirror stays as a manual-rollback grace window (pruned keep=2).
    staging = j.get("staging")
    if staging:
        shutil.rmtree(Path(staging).parent, ignore_errors=True)


def _pivot_main(journal_path: str) -> int:
    """Supervisor entry (`--pivot <journal>`), executed as a detached temp copy.

    Owns the only phase that mutates the live tree. Every mutation is a journaled
    same-volume rename, so an interruption at ANY point is either completed
    forward or fully reversed — by this process, or by _reconcile_pivot() at the
    next server start if this process itself dies.
    """
    journal_file = Path(journal_path)
    j = None
    try:
        j = json.loads(journal_file.read_text(encoding="utf-8"))
        root, staging, old = Path(j["root"]), Path(j["staging"]), Path(j["old"])
        host, port, target = j["host"], j["port"], j["target"]

        _log_pivot(f"pivot {j.get('current')} → {target}: waiting for the port to free")
        _wait_port_free(host, port, timeout=30)

        j["phase"] = "applying"
        _journal_save(journal_file, j)
        _log_pivot(f"applying {len(j['plan']['files'])} files, "
                   f"{len(j['plan']['deletions'])} deletions")
        _apply_plan(journal_file, j, root, staging, old)
        j["phase"] = "applied"
        _journal_save(journal_file, j)

        _log_pivot("starting the new server")
        proc = _spawn_server(j)
        if _probe_health(host, port, target, timeout=30):
            j["phase"] = "done"
            _journal_save(journal_file, j)
            _finalize_success(journal_file, j, root)
            _log_pivot(f"update to {target} complete")
            return 0

        _log_pivot("health probe FAILED — rolling back")
        _terminate(proc)
        _wait_port_free(host, port, timeout=15)
        # Mark 'rolling_back' BEFORE mutating: if this reverse is itself interrupted,
        # the surviving journal says 'rolling_back' so _reconcile_pivot completes the
        # reverse instead of mistaking a half-reverted tree for a finished update.
        j["phase"] = "rolling_back"
        _journal_save(journal_file, j)
        _reverse_plan(j, root, staging, old)
        _write_result(root, {"phase": "rolled_back", "target": target,
                             "error": "La nouvelle version n'a pas démarré — restauration automatique effectuée.",
                             "at": datetime.now().isoformat()})
        journal_file.unlink(missing_ok=True)
        _spawn_server(j)
        ok = _probe_health(host, port, j.get("current"), timeout=30, any_version=True)
        _log_pivot(f"rollback complete, previous server {'confirmed' if ok else 'NOT CONFIRMED'}")
        return 1
    except Exception as e:
        _log_pivot(f"FATAL: {e}")
        # Never leave a half-applied tree without trying to restore it.
        try:
            if j:
                root = Path(j["root"])
                j["phase"] = "rolling_back"
                _journal_save(journal_file, j)
                _reverse_plan(j, root, Path(j["staging"]), Path(j["old"]))
                _write_result(root, {"phase": "rolled_back", "target": j.get("target"),
                                     "error": str(e), "at": datetime.now().isoformat()})
                journal_file.unlink(missing_ok=True)
                _spawn_server(j)
        except Exception as e2:
            _log_pivot(f"rollback also failed: {e2} — reconciliation will run at next start")
        return 1


def _reconcile_pivot() -> None:
    """Startup crash recovery: a journal on disk means a swap was interrupted
    (power loss, kill). Roll FORWARD only when the swap provably COMPLETED — the
    forward phase was reached AND the live tree fully matches the target manifest
    (sha256 of every file). Any other state — including an interrupted reverse
    (phase 'rolling_back') or a half-applied/half-reverted tree — rolls BACK.
    Never trust the changelog version alone: it is one swappable file among many."""
    j = _read_journal()
    if not j:
        return
    root = Path(j.get("root") or ROOT)
    target = j.get("target")
    forward = (j.get("phase") in ("applied", "done")
               and _max_version(CHANGELOG_DIR) == target
               and _verify_tree_manifest(root, target))
    try:
        if forward:
            print(f"  [update] pivot interrompu après application — finalisation (v{target}).")
            _finalize_success(JOURNAL_FILE, j, root)
        else:
            print("  [update] pivot interrompu ou incomplet — restauration de la version précédente.")
            _reverse_plan(j, root, Path(j.get("staging") or ""), Path(j.get("old") or ""))
            _write_result(root, {"phase": "rolled_back", "target": target,
                                 "error": "Basculement interrompu — restauration automatique au démarrage.",
                                 "at": datetime.now().isoformat()})
            JOURNAL_FILE.unlink(missing_ok=True)
    except Exception as e:
        print(f"  [update] ATTENTION: réconciliation impossible ({e}) — voir backups/pivot-journal.json")


# ── Offline self-check (`--check [--root DIR]`) ─────────────────────────────────

def _check_main(root_arg) -> int:
    """Offline validation of a platform tree: used as the pre-pivot boot gate (run
    against the STAGED tree by the updater), in CI on every push, and manually.
    Prints a JSON report; exit 0 = sane. Plugin problems are warnings, not errors —
    a broken plugin is quarantined at runtime, never fatal (rule 1.1)."""
    import py_compile
    root = Path(root_arg).resolve() if root_arg else ROOT
    errors, warnings = [], []

    for rel in ("index.html", "explorer.html", "viewer.html", "admpan.html",
                "dev_server.py", "js/core/plugin-registry.js", "js/pages/viewer.js",
                "css", "lang/en.json", "api/auth.php", "changelog"):
        if not (root / rel).exists():
            errors.append(f"manquant: {rel}")

    if (root / "dev_server.py").exists():
        check_dir = tempfile.mkdtemp(prefix="lumen3d-check-")
        cfile = str(Path(check_dir) / "dev_server.pyc")
        try:
            py_compile.compile(str(root / "dev_server.py"), cfile=cfile, doraise=True)
        except Exception as e:
            errors.append(f"dev_server.py ne compile pas: {e}")
        finally:
            shutil.rmtree(check_dir, ignore_errors=True)

    version = _max_version(root / "changelog")
    if not version:
        errors.append("aucun changelog_X.Y.Z.md")

    vj = root / "version.json"
    if vj.exists():
        try:
            manifest = json.loads(vj.read_text(encoding="utf-8"))
            if manifest.get("web") != version:
                errors.append(f"version.json {manifest.get('web')!r} ≠ changelog {version!r}")
        except ValueError as e:
            errors.append(f"version.json illisible: {e}")

    for rel in ("lang/en.json", "lang/fr.json", "lang/es.json"):
        p = root / rel
        if p.exists():
            try:
                json.loads(p.read_text(encoding="utf-8"))
            except ValueError as e:
                errors.append(f"{rel} illisible: {e}")

    modules = root / "js" / "modules"
    for placement in PLUGIN_PLACEMENTS:
        base = modules / placement
        if not base.is_dir():
            continue
        for mod_dir in sorted(base.iterdir()):
            meta_path = mod_dir / "plugin.json"
            if not mod_dir.is_dir() or not meta_path.exists():
                continue
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                if meta.get("placement") and meta["placement"] != placement:
                    warnings.append(f"plugin {placement}/{mod_dir.name}: placement incohérent")
                if not (mod_dir / "index.js").exists():
                    warnings.append(f"plugin {placement}/{mod_dir.name}: index.js manquant")
                okc, rc = _compat_satisfies(version, meta.get("platformCompat"))
                if not okc:
                    warnings.append(f"plugin {placement}/{mod_dir.name}: incompatible ({rc})")
            except ValueError as e:
                warnings.append(f"plugin {placement}/{mod_dir.name}: plugin.json illisible ({e})")

    report = {"ok": not errors, "root": str(root), "version": version,
              "errors": errors, "warnings": warnings}
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if not errors else 1


# ── Dataset helpers ────────────────────────────────────────────────────────────

# The dataset vocabulary, single table for the whole server: it is at once the
# directory under DATA_WEB/ (and under uploads/staging/), the first segment of a
# dataset id, the `type` field of metadata.json and the ?type= filter value.
# Cell tracking is not a type: a tracked timelapse is a `live` dataset whose
# metadata.json carries a `tracking` block (tracks.json beside the bricks).
# Path-traversal guard for the `id` query param (= "<type>/<folder>").
ALLOWED_TYPE_DIRS = ("3d", "2d", "live")
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


def _dataset_is_hidden(ds_dir: Path) -> bool:
    try:
        meta = json.loads((ds_dir / "metadata.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(meta, dict) and bool(meta.get("hidden"))


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
    for type_dir in ALLOWED_TYPE_DIRS:
        base = DATA_WEB / type_dir
        if not base.is_dir():
            continue
        for ds_dir in sorted(base.iterdir()):
            # A dot-folder is never a dataset: it is a publish in flight or its
            # leftover (.incoming-*, .replaced-*), or something hand-made.
            if ds_dir.name.startswith(".") or not ds_dir.is_dir():
                continue
            meta_path = ds_dir / "metadata.json"
            if not meta_path.exists():
                # Folder exists but no metadata yet (still preprocessing). `path` is
                # emitted even here: it is the byte base every client builds URLs
                # from, and a row without one has no way back to its folder.
                datasets.append({
                    "id": f"{type_dir}/{ds_dir.name}",
                    "path": f"{type_dir}/{ds_dir.name}",
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
            if not isinstance(meta, dict):
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
            
            # A 2d dataset is a photograph: nothing for the volume renderer to mount.
            if "volumeSources" not in ds_entry and type_dir == "2d":
                ds_entry["volumeSources"] = []
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
    """dataset_id = '<type>/FolderName' (e.g. '3d/FolderName')"""
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
        meta["type"]       = type_dir      # the folder is the authority, as in the catalog
        meta["folderName"] = folder
        return meta
    except Exception:
        return None


# ── Staged (still-importing) datasets, surfaced in the admin editor ────────────
# A staged dataset is addressed as "staging:<type>/<folder>". The prefix is the
# whole routing decision: it tells the editor to read/write the staging store
# instead of DATA_WEB, and it tells the viewer to stream bytes through the
# authenticated blob proxy instead of a static DATA_WEB URL (js/pages/viewer.js
# _datasetBase). Published datasets keep their bare "<type>/<folder>" id, so
# nothing about the existing flow changes.
_STAGING_PREFIX = "staging:"


def _is_staged_id(dataset_id) -> bool:
    return isinstance(dataset_id, str) and dataset_id.startswith(_STAGING_PREFIX)


def _split_staged_id(dataset_id: str):
    body = dataset_id[len(_STAGING_PREFIX):]
    type_dir, _, folder = body.partition("/")
    return type_dir, folder


def _staged_blob_url(type_dir: str, folder: str, rel: str) -> str:
    ds = urllib.parse.quote(f"{type_dir}/{folder}", safe="")
    return f"api/upload.php?action=blob&ds={ds}&path={rel}"


def _staged_dataset_rows() -> list[dict]:
    """Admin-list rows for every dataset currently in the staging store."""
    rows = []
    for info in upload_staging.list_staged():
        type_dir, folder = info["type"], info["folder"]
        meta = upload_staging.read_staged_metadata(type_dir, folder) or {}
        editable = info["state"] in (upload_staging.STATE_EDITABLE, upload_staging.STATE_STAGED)
        rows.append({
            "id": f"{_STAGING_PREFIX}{type_dir}/{folder}",
            "path": f"{_STAGING_PREFIX}{type_dir}/{folder}",
            "name": meta.get("name") or info.get("name") or folder,
            "folderName": folder,
            "type": type_dir,
            "stage": meta.get("stage"),
            "stageNumeric": meta.get("stageNumeric"),
            "embryo": meta.get("embryo"),
            "configured": bool(meta.get("configured")),
            "hidden": True,                      # never in the public catalog
            "thumbnail": _staged_blob_url(type_dir, folder, "thumbnail.webp") if info.get("hasThumbnail") else None,
            "staging": True,
            "stagingState": info["state"],
            "stagingEditable": editable,
            "totalBytes": info["totalBytes"],
            "receivedBytes": info["receivedBytes"],
            "publishedExists": info["publishedExists"],
            "expiresInS": info.get("expiresInS"),
        })
    return rows


def _get_staged_dataset(dataset_id: str) -> dict | None:
    type_dir, folder = _split_staged_id(dataset_id)
    info = upload_staging.describe(type_dir, folder)
    if info is None:
        return None
    meta = upload_staging.read_staged_metadata(type_dir, folder)
    if meta is None:
        return None
    meta = dict(meta)
    meta["id"] = dataset_id
    meta["path"] = dataset_id
    meta["folderName"] = folder
    meta["type"] = type_dir
    meta["staging"] = True
    meta["stagingState"] = info["state"]
    meta["stagingEditable"] = info["state"] in (upload_staging.STATE_EDITABLE, upload_staging.STATE_STAGED)
    meta["hidden"] = True
    # Rewrite the pipeline's DATA_WEB-relative source paths onto the proxy so the
    # admin preview can mount a dataset that is not web-served yet.
    sources = meta.get("volumeSources")
    if isinstance(sources, list):
        rewritten = []
        for src in sources:
            if not isinstance(src, dict):
                continue
            s = dict(src)
            s["path"] = _staged_blob_url(type_dir, folder, "")
            if s.get("manifestPath"):
                s["manifestPath"] = _staged_blob_url(type_dir, folder, "bricks/manifest.json")
            rewritten.append(s)
        meta["volumeSources"] = rewritten
    return meta


def _save_staged_thumbnail(dataset_id: str, image_data: str):
    if not isinstance(image_data, str) or not image_data.startswith("data:image/"):
        return 400, {"error": "Invalid image format"}
    try:
        import base64
        img_bytes = base64.b64decode(image_data.split(",", 1)[1])
    except Exception:
        return 400, {"error": "Invalid image data"}
    if len(img_bytes) > MAX_THUMB_BYTES or not _is_supported_image(img_bytes):
        return 400, {"error": "Not a valid image"}
    type_dir, folder = _split_staged_id(dataset_id)
    status, payload = upload_staging.save_staged_thumbnail(type_dir, folder, img_bytes)
    if status == 200:
        payload = {"ok": True, "path": _staged_blob_url(type_dir, folder, "thumbnail.webp")}
    return status, payload


# Serialises every read-modify-write of a published metadata.json (editor save,
# visibility flip, gallery add/delete): _atomic_write only makes each WRITE whole,
# two interleaved RMWs would still lose one of the edits.
_META_LOCK = threading.RLock()


def _migrations_bind() -> None:
    """Point the migrations engine at this server's tree and metadata lock (the tests
    move DATA_WEB / UPLOADS_DIR after import, so this runs per request; it only
    reconfigures when a path actually changed)."""
    data_web, uploads = Path(DATA_WEB).resolve(), Path(UPLOADS_DIR).resolve()
    if (dataset_migrations.DATA_WEB != data_web or dataset_migrations.UPLOADS_DIR != uploads
            or dataset_migrations._META_LOCK is not _META_LOCK):
        dataset_migrations.configure(
            ROOT, data_web=data_web, uploads_dir=uploads, meta_lock=_META_LOCK,
            on_metadata_change=lambda: _CATALOG_CACHE.__setitem__("sig", None),
            file_mode=_file_mode())


def _save_dataset(dataset_id: str, body: dict) -> bool:
    with _META_LOCK:
        return _save_dataset_locked(dataset_id, body)


def _save_dataset_locked(dataset_id: str, body: dict) -> bool:
    safe = _safe_dataset_dir(dataset_id)
    if safe is None:
        return False
    type_dir, folder, ds_dir = safe
    _make_dir(ds_dir)
    meta_path = ds_dir / "metadata.json"

    # Merge: keep existing fields, override with posted fields
    existing = {}
    if meta_path.exists():
        try:
            existing = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    if not isinstance(existing, dict):
        existing = {}
    if not isinstance(body, dict):
        body = {}

    stored_gallery = existing.get("gallery")
    _gallery_sync_thumbs(ds_dir)
    existing.update(body)
    existing["id"]          = f"{type_dir}/{folder}"   # one id shape everywhere: '<type>/<folder>'
    existing["type"]        = type_dir
    existing["folderName"]  = folder
    existing["configured"]  = True
    existing["lastModified"] = datetime.now().isoformat()
    # The posted `gallery` decides ORDER and CAPTIONS only; which files exist is decided
    # by the folder. Keeps a stale draft from resurrecting a deleted image or dropping
    # one that was uploaded while the form was open.
    gallery = _gallery_reconcile(existing, ds_dir, fallback=stored_gallery)
    if gallery:
        existing["gallery"] = gallery
    else:
        existing.pop("gallery", None)

    _atomic_write(meta_path, json.dumps(existing, indent=2, ensure_ascii=False), mode=_file_mode())  # RACE-020
    _CATALOG_CACHE["sig"] = None  # PERF-035: force a recompute on the next catalog read
    return True


def _set_dataset_hidden(dataset_id: str, hidden: bool) -> bool:
    """Flip the `hidden` flag on a dataset's metadata.json. Hidden datasets are
    omitted from the public catalog.json (_build_catalog) but still listed in admin."""
    with _META_LOCK:
        return _set_dataset_hidden_locked(dataset_id, hidden)


def _set_dataset_hidden_locked(dataset_id: str, hidden: bool) -> bool:
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
    if not isinstance(meta, dict):
        return False
    meta["hidden"] = bool(hidden)
    meta["lastModified"] = datetime.now().isoformat()
    _atomic_write(meta_path, json.dumps(meta, indent=2, ensure_ascii=False), mode=_file_mode())  # RACE-020
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
    _make_dir(ds_dir)
    _atomic_write(ds_dir / "thumbnail.webp", img_bytes, binary=True, mode=_file_mode())  # RACE-020
    _CATALOG_CACHE["sig"] = None  # PERF-035
    return 200, {"ok": True, "path": f"DATA_WEB/{type_dir}/{folder}/thumbnail.webp"}


# ── Dataset gallery (operator-attached images, e.g. annotated captures) ────────
# Images live INSIDE the dataset folder (DATA_WEB/<type>/<folder>/gallery/), not in
# the shared media library: an annotated figure is a fact about that dataset, so it
# travels with it on a copy/SFTP move and disappears with it on delete. metadata.json
# stays the single source of truth (Rule 1.1) — it holds the order and the captions,
# the folder holds the bytes, and _gallery_reconcile keeps the two honest.
GALLERY_DIRNAME = "gallery"
MAX_GALLERY_BYTES = 8 * 1024 * 1024
MAX_GALLERY_ITEMS = 40
_GALLERY_CAPTION_MAX = 400
# Extension is derived from the MAGIC BYTES, never from the client-supplied filename:
# the four formats _is_supported_image can actually prove. An .png that is really a
# script therefore lands as neither.
_GALLERY_MAGIC_EXT = (
    (lambda b: b[0:4] == b"RIFF" and b[8:12] == b"WEBP", "webp"),
    (lambda b: b[0:8] == b"\x89PNG\r\n\x1a\n", "png"),
    (lambda b: b[0:3] == b"\xff\xd8\xff", "jpg"),
    (lambda b: b[0:6] in (b"GIF87a", b"GIF89a"), "gif"),
)
_GALLERY_FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(webp|png|jpg|jpeg|gif)$")

# Grid-sized copies of the gallery images (twin: api/datasets.php gallery_thumb_*).
# gallery/thumbs/<file>.webp — or <file>.jpg where the imaging library cannot
# encode WebP — at most GALLERY_THUMB_PX on the long side, never upscaled. The
# viewer's grid and the admin list load these; the lightbox loads the original.
# A sub-folder (not a dot-folder: every host shape refuses to serve dot-segments)
# that _gallery_reconcile never mistakes for an image, since it lists files only.
GALLERY_THUMB_DIRNAME = "thumbs"
GALLERY_THUMB_PX = 320
# Larger sources are left without a thumbnail (the grid falls back to the image):
# an 8 MB PNG can still declare a decompression-bomb canvas.
GALLERY_THUMB_MAX_SOURCE_PIXELS = 50_000_000


def _gallery_thumb_existing(gdir: Path, name: str):
    """Relative path (from gallery/) of the current thumbnail of ``name``, or None.
    A thumbnail older than its source is stale and does not count."""
    try:
        src_mtime = (gdir / name).stat().st_mtime_ns
    except OSError:
        return None
    for ext in ("webp", "jpg"):
        rel = f"{GALLERY_THUMB_DIRNAME}/{name}.{ext}"
        try:
            if (gdir / rel).stat().st_mtime_ns >= src_mtime:
                return rel
        except OSError:
            continue
    return None


def _gallery_make_thumb(gdir: Path, name: str):
    """Write the thumbnail of gallery/<name>. Returns its relative path, or None when
    Pillow is missing or the image cannot (or should not) be decoded."""
    try:
        from PIL import Image, ImageOps, features
    except Exception:
        return None
    try:
        with Image.open(gdir / name) as im:
            if im.width * im.height > GALLERY_THUMB_MAX_SOURCE_PIXELS:
                return None
            im.draft("RGB", (GALLERY_THUMB_PX, GALLERY_THUMB_PX))
            im = ImageOps.exif_transpose(im)
            im = im.convert("RGBA")
            im.thumbnail((GALLERY_THUMB_PX, GALLERY_THUMB_PX), Image.LANCZOS)
            tdir = gdir / GALLERY_THUMB_DIRNAME
            _make_dir(tdir)
            buf = io.BytesIO()
            if features.check("webp"):
                im.save(buf, "WEBP", quality=80, method=4)
                rel = f"{GALLERY_THUMB_DIRNAME}/{name}.webp"
                stale = tdir / f"{name}.jpg"
            else:
                flat = Image.new("RGB", im.size, (255, 255, 255))
                flat.paste(im, mask=im.getchannel("A"))
                flat.save(buf, "JPEG", quality=85)
                rel = f"{GALLERY_THUMB_DIRNAME}/{name}.jpg"
                stale = tdir / f"{name}.webp"
    except Exception:
        return None
    _atomic_write(gdir / rel, buf.getvalue(), binary=True, mode=_file_mode())
    try:
        stale.unlink()
    except OSError:
        pass
    return rel


def _gallery_sync_thumbs(ds_dir: Path) -> None:
    """Every gallery image gets a current thumbnail; a thumbnail whose image is gone
    is removed. Run on add, delete, save and the lazy `gallery_thumbs` action."""
    gdir = ds_dir / GALLERY_DIRNAME
    if not gdir.is_dir():
        return
    try:
        names = [p.name for p in gdir.iterdir() if p.is_file() and _GALLERY_FILE_RE.match(p.name)]
    except OSError:
        return
    for name in names:
        if _gallery_thumb_existing(gdir, name) is None:
            _gallery_make_thumb(gdir, name)
    tdir = gdir / GALLERY_THUMB_DIRNAME
    if tdir.is_dir():
        keep = set(names)
        for t in tdir.iterdir():
            base, _, ext = t.name.rpartition(".")
            if not t.is_file() or ext not in ("webp", "jpg") or base not in keep:
                try:
                    if t.is_file():
                        t.unlink()
                except OSError:
                    pass


def _gallery_ext(raw: bytes):
    for probe, ext in _GALLERY_MAGIC_EXT:
        if probe(raw):
            return ext
    return None


def _gallery_stem(name: str) -> str:
    """Slug for the on-disk name: keeps the operator's filename recognisable in the
    folder without letting it decide the path."""
    stem = (name or "").replace("\\", "/").split("/")[-1]
    stem = stem.rsplit(".", 1)[0] if "." in stem else stem
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", stem).strip("-").lower()[:60]
    return stem or "image"


def _gallery_rel(file_name: str):
    """Validate a gallery entry's `file` and return it normalised, or None.

    The value is echoed into a URL by the viewer, so it must be a bare file name in
    the gallery folder — never a path, never a traversal.
    """
    if not isinstance(file_name, str):
        return None
    name = file_name.replace("\\", "/").strip("/")
    if name.startswith(GALLERY_DIRNAME + "/"):
        name = name[len(GALLERY_DIRNAME) + 1:]
    if "/" in name or not _GALLERY_FILE_RE.match(name):
        return None
    return name


def _gallery_clean_text(value, limit: int = _GALLERY_CAPTION_MAX) -> str:
    if not isinstance(value, str):
        return ""
    return value.replace("\r", " ").replace("\n", " ").strip()[:limit]


def _gallery_reconcile(meta: dict, ds_dir: Path, fallback=None) -> list:
    """Make metadata.json's `gallery` agree with what is actually on disk.

    Two directions, both required:
      · entries whose file is missing (or whose `file` is malformed) are DROPPED, so a
        hand-edited or stale client draft can never point the viewer at a bogus URL;
      · files present in gallery/ but absent from the incoming list are APPENDED, so a
        concurrent upload is not silently erased by a Save carrying an older draft.

    ``fallback`` is the gallery as it stood BEFORE the incoming edit: a re-appended file
    recovers its stored caption from it instead of coming back bare.
    """
    gdir = ds_dir / GALLERY_DIRNAME
    on_disk = []
    try:
        if gdir.is_dir():
            on_disk = sorted(
                (p.name for p in gdir.iterdir() if p.is_file() and _GALLERY_FILE_RE.match(p.name)),
                key=lambda n: ((gdir / n).stat().st_mtime, n),
            )
    except OSError:
        on_disk = []
    disk_set = set(on_disk)

    prior = {}
    for entry in (fallback if isinstance(fallback, list) else []):
        if isinstance(entry, dict):
            key = _gallery_rel(entry.get("file"))
            if key:
                prior[key] = entry

    def _entry(name: str, src: dict) -> dict:
        item = {"file": name}
        # Derived from the disk, never from the posted entry.
        thumb = _gallery_thumb_existing(gdir, name)
        if thumb:
            item["thumb"] = thumb
        title = _gallery_clean_text(src.get("title"), 120)
        caption = _gallery_clean_text(src.get("caption"))
        if title:
            item["title"] = title
        if caption:
            item["caption"] = caption
        if isinstance(src.get("added"), str):
            item["added"] = src["added"][:40]
        return item

    out, seen = [], set()
    for entry in (meta.get("gallery") if isinstance(meta.get("gallery"), list) else []):
        if not isinstance(entry, dict):
            continue
        name = _gallery_rel(entry.get("file"))
        if not name or name in seen or name not in disk_set:
            continue
        seen.add(name)
        out.append(_entry(name, entry))

    for name in on_disk:
        if name not in seen:
            out.append(_entry(name, prior.get(name, {})))

    return out[:MAX_GALLERY_ITEMS]


def _gallery_add(dataset_id: str, body: dict):
    """Store a new gallery image — raw bytes (``body["raw"]``) or a data: URL
    (``body["image"]``). Returns (status, payload)."""
    with _META_LOCK:
        return _gallery_add_locked(dataset_id, body if isinstance(body, dict) else {})


def _gallery_add_locked(dataset_id: str, body: dict):
    safe = _safe_dataset_dir(dataset_id)
    if safe is None:
        return 400, {"error": "Invalid dataset ID"}
    type_dir, folder, ds_dir = safe
    if not ds_dir.is_dir():
        return 404, {"error": "Dataset not found"}

    raw = (body or {}).get("raw")
    if not isinstance(raw, (bytes, bytearray)):
        # Legacy JSON form: a data: URL. The magic-byte check below applies to both.
        image = (body or {}).get("image", "")
        if not isinstance(image, str) or not image.startswith("data:image/"):
            return 400, {"error": "Invalid image format"}
        try:
            import base64
            raw = base64.b64decode(image.split(",", 1)[1])
        except Exception:
            return 400, {"error": "Invalid image data"}
    raw = bytes(raw)
    if not raw:
        return 400, {"error": "Empty image"}
    if len(raw) > MAX_GALLERY_BYTES:
        return 400, {"error": "Image too large"}
    ext = _gallery_ext(raw)
    if ext is None:
        return 400, {"error": "Not a valid image (expected WebP/PNG/JPEG/GIF)"}

    meta_path = ds_dir / "metadata.json"
    meta = {}
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            meta = {}
    if not isinstance(meta, dict):
        meta = {}
    current = _gallery_reconcile(meta, ds_dir)
    if len(current) >= MAX_GALLERY_ITEMS:
        return 409, {"error": f"Gallery full (max {MAX_GALLERY_ITEMS} images)"}

    gdir = ds_dir / GALLERY_DIRNAME
    _make_dir(gdir)
    stem = _gallery_stem(body.get("filename") or body.get("name") or "")
    name = f"{stem}.{ext}"
    i = 1
    while (gdir / name).exists():
        name = f"{stem}-{i}.{ext}"
        i += 1
    _atomic_write(gdir / name, raw, binary=True, mode=_file_mode())  # RACE-020
    thumb = _gallery_make_thumb(gdir, name)

    entry = {"file": name, "added": datetime.now().isoformat()}
    if thumb:
        entry["thumb"] = thumb
    title = _gallery_clean_text(body.get("title"), 120)
    caption = _gallery_clean_text(body.get("caption"))
    if title:
        entry["title"] = title
    if caption:
        entry["caption"] = caption
    current.append(entry)
    meta["gallery"] = current
    meta["lastModified"] = datetime.now().isoformat()
    _atomic_write(meta_path, json.dumps(meta, indent=2, ensure_ascii=False), mode=_file_mode())
    _CATALOG_CACHE["sig"] = None  # PERF-035
    return 200, {"ok": True, "item": entry, "gallery": current,
                 "url": f"DATA_WEB/{type_dir}/{folder}/{GALLERY_DIRNAME}/{name}"}


def _gallery_thumbs(dataset_id: str):
    """Lazy thumbnails for a gallery that predates them (the admin asks when it shows
    a gallery with entries lacking `thumb`). Returns (status, payload)."""
    with _META_LOCK:
        safe = _safe_dataset_dir(dataset_id)
        if safe is None:
            return 400, {"error": "Invalid dataset ID"}
        _type_dir, _folder, ds_dir = safe
        meta_path = ds_dir / "metadata.json"
        if not meta_path.is_file():
            return 404, {"error": "Dataset not found"}
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            return 500, {"error": "Unreadable metadata"}
        if not isinstance(meta, dict):
            return 500, {"error": "Unreadable metadata"}
        _gallery_sync_thumbs(ds_dir)
        gallery = _gallery_reconcile(meta, ds_dir)
        if gallery != (meta.get("gallery") or []):
            if gallery:
                meta["gallery"] = gallery
            else:
                meta.pop("gallery", None)
            _atomic_write(meta_path, json.dumps(meta, indent=2, ensure_ascii=False), mode=_file_mode())
            _CATALOG_CACHE["sig"] = None
        return 200, {"ok": True, "gallery": gallery}


def _gallery_delete(dataset_id: str, file_name: str):
    with _META_LOCK:
        return _gallery_delete_locked(dataset_id, file_name)


def _gallery_delete_locked(dataset_id: str, file_name: str):
    safe = _safe_dataset_dir(dataset_id)
    if safe is None:
        return 400, {"error": "Invalid dataset ID"}
    _type_dir, _folder, ds_dir = safe
    name = _gallery_rel(file_name)
    if not name:
        return 400, {"error": "Invalid file"}
    target = ds_dir / GALLERY_DIRNAME / name
    try:
        if target.is_file():
            target.unlink()
    except OSError:
        return 500, {"error": "Delete failed"}
    for ext in ("webp", "jpg"):
        try:
            (ds_dir / GALLERY_DIRNAME / GALLERY_THUMB_DIRNAME / f"{name}.{ext}").unlink()
        except OSError:
            pass

    meta_path = ds_dir / "metadata.json"
    meta = {}
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            meta = {}
    if not isinstance(meta, dict):
        meta = {}
    meta["gallery"] = _gallery_reconcile(meta, ds_dir)
    meta["lastModified"] = datetime.now().isoformat()
    _atomic_write(meta_path, json.dumps(meta, indent=2, ensure_ascii=False), mode=_file_mode())
    _CATALOG_CACHE["sig"] = None  # PERF-035
    return 200, {"ok": True, "gallery": meta["gallery"]}


# How long a computed catalog signature is trusted before the tree is stat-ed
# again. Every write through this server resets the cache at once; the interval
# only bounds how late an out-of-band change (SFTP, the pipeline) is noticed.
_CATALOG_SIG_TTL_S = 2.0


def _catalog_mtime_sig():
    """Change signature of everything the catalog is built from: per dataset folder,
    (name, metadata.json mtime_ns + size, thumbnail.webp mtime_ns + size). A MAX of
    mtimes missed a metadata.json restored with an older mtime and a thumbnail
    added by SFTP; hashing the full tuple catches both."""
    h = hashlib.sha256(str(DATA_WEB).encode("utf-8", "surrogatepass"))
    for t in ALLOWED_TYPE_DIRS:
        base = DATA_WEB / t
        if not base.is_dir():
            continue
        try:
            names = sorted(e.name for e in os.scandir(base))
        except OSError:
            continue
        for name in names:
            if name.startswith("."):
                continue
            h.update(f"|{t}/{name}".encode("utf-8", "surrogatepass"))
            for leaf in ("metadata.json", "thumbnail.webp"):
                try:
                    st = os.stat(base / name / leaf)
                    h.update(f":{st.st_mtime_ns}:{st.st_size}".encode())
                except OSError:
                    h.update(b":-")
    return h.hexdigest()


def _list_datasets_cached() -> list[dict]:
    """PERF-035: re-parsing every metadata.json on each catalog.json GET was O(datasets)
    JSON loads per request. Recompute only when the signature changes, and stat the
    tree at most every _CATALOG_SIG_TTL_S seconds."""
    now = time.monotonic()
    cached = _CATALOG_CACHE.get("data")
    if (_CATALOG_CACHE.get("sig") is not None and cached is not None
            and _CATALOG_CACHE.get("root") == str(DATA_WEB)
            and now - _CATALOG_CACHE.get("checked", 0.0) < _CATALOG_SIG_TTL_S):
        return cached
    sig = _catalog_mtime_sig()
    if _CATALOG_CACHE.get("sig") == sig and cached is not None:
        _CATALOG_CACHE["checked"] = now
        return cached
    data = _list_datasets()
    _CATALOG_CACHE.update({"sig": sig, "data": data, "checked": now,
                           "root": str(DATA_WEB), "body": None})
    return data


def _catalog_body() -> tuple[bytes, str]:
    """The public catalog as encoded JSON plus its ETag, re-encoded only when the
    underlying listing changed."""
    data = _list_datasets_cached()
    cached = _CATALOG_CACHE.get("body")
    if cached is not None and cached[2] is data:
        return cached[0], cached[1]
    body = json.dumps(_build_catalog(), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    etag = '"cat-' + hashlib.sha256(body).hexdigest()[:24] + '"'
    _CATALOG_CACHE["body"] = (body, etag, data)
    return body, etag


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
    _atomic_write(catalog_path, json.dumps(catalog, indent=2, ensure_ascii=False), mode=_file_mode())  # RACE-020
    return len(catalog)


# ── One-shot migration: the pre-rename dataset vocabulary ──────────────────────
# The dataset types used to be spelled 'fixed' / 'wholemount' / 'live' /
# 'tracking'. They are now '3d' / '2d' / 'live' EVERYWHERE: the directory under
# DATA_WEB/ and uploads/staging/, the first segment of a dataset id,
# metadata.json's `type`, the import journal name and its `type` field, the
# api/stats.json key and the ?type= filter value. Nothing anywhere reads the old
# spelling any more — there is no alias layer, by design — so a deployment that
# already holds bytes is converted once, here, at boot.
#
# Idempotent, and it costs a handful of is_dir()/glob() calls on a tree with
# nothing left to convert. Renames go through os.replace() inside try/except so
# two servers starting at the same moment cannot fight over the same directory.
_LEGACY_TYPE_DIRS = {"fixed": "3d", "wholemount": "2d"}
# The former fifth type. A tracked timelapse was always written to DATA_WEB/live/
# with tracks.json beside its bricks (the viewer draws the tracking as a layer of
# that dataset), so DATA_WEB/tracking/ only ever held what install.php seeded —
# an empty folder — or a hand-made dataset. The folder is removed when empty and
# reported when not; its bytes are never touched.
_RETIRED_TYPE_DIR = "tracking"
# An explorer filter link as the page builder serialises it into config/pages/.
_LEGACY_TYPE_HREF_RE = re.compile(
    r"(explorer\.html\?type=)(" + "|".join(_LEGACY_TYPE_DIRS) + r")(?![A-Za-z0-9_-])")
# A link to the retired type's filter now opens the timelapses.
_RETIRED_TYPE_HREF_RE = re.compile(r"(explorer\.html\?type=)tracking(?![A-Za-z0-9_-])")


def _migrate_rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except (ValueError, OSError):
        return str(path)


def _migrate_legacy_id(value):
    """'fixed/Foo' → '3d/Foo'. Returns (value, changed); anything that is not a
    legacy-prefixed id comes back untouched."""
    if not isinstance(value, str):
        return value, False
    head, sep, rest = value.partition("/")
    canon = _LEGACY_TYPE_DIRS.get(head)
    if not sep or canon is None:
        return value, False
    return f"{canon}/{rest}", True


def _contains_bytes(path: Path, needles) -> bool:
    """Substring probe on a small JSON file. Cheaper than parsing it, and this runs
    on every boot of a tree that has nothing left to migrate."""
    try:
        raw = path.read_bytes()
    except OSError:
        return False
    return any(n in raw for n in needles)


def _legacy_types_present() -> bool:
    """The boot guard: is there any artefact left in the old vocabulary?"""
    staging = UPLOADS_DIR / "staging"
    state = UPLOADS_DIR / "state"
    for legacy in _LEGACY_TYPE_DIRS:
        if (DATA_WEB / legacy).is_dir() or (staging / legacy).is_dir():
            return True
        if state.is_dir() and next(state.glob(f"{legacy}__*.json"), None) is not None:
            return True
    if (DATA_WEB / _RETIRED_TYPE_DIR).is_dir() or (staging / _RETIRED_TYPE_DIR).is_dir():
        return True
    if _contains_bytes(STATS_FILE, (b'"fixed/', b'"wholemount/')):
        return True
    # "tracking": covers pageTitles.tracking and datasetTypes.tracking alike.
    if _contains_bytes(INSTANCE_FILE, (b'"wholemount":', b'"showTracking"', b'"tracking":')):
        return True
    pages = CONFIG_DIR / "pages"
    if pages.is_dir():
        for page in pages.glob("*.json"):
            # The full href pattern, not a substring: a page that merely mentions
            # "type=fixedish" must not keep this guard hot on every boot.
            try:
                text = page.read_text(encoding="utf-8")
            except OSError:
                continue
            if _LEGACY_TYPE_HREF_RE.search(text) or _RETIRED_TYPE_HREF_RE.search(text):
                return True
    return False


def _migrate_retire_tracking(log: list) -> None:
    """Retire DATA_WEB/tracking and uploads/staging/tracking: gone when empty,
    reported — never moved, never deleted — when something is in them."""
    for root in (DATA_WEB / _RETIRED_TYPE_DIR, UPLOADS_DIR / "staging" / _RETIRED_TYPE_DIR):
        if not root.is_dir():
            continue
        try:
            entries = [p for p in root.iterdir() if p.name != ".gitkeep"]
        except OSError as exc:
            log.append(f"FAILED {_migrate_rel(root)}: {exc}")
            continue
        if entries:
            log.append(f"LEFT {_migrate_rel(root)}: {len(entries)} item(s) — cell tracking is no "
                       f"longer a dataset type; a tracked timelapse belongs under DATA_WEB/live/")
            continue
        try:
            for p in root.iterdir():
                p.unlink()
            root.rmdir()
            log.append(f"removed empty {_migrate_rel(root)}")
        except OSError as exc:
            log.append(f"FAILED {_migrate_rel(root)}: {exc}")


def _migrate_move_dir(src: Path, dest: Path, log: list) -> None:
    """Move a whole type directory onto its canonical name.

    A plain rename when the target does not exist; otherwise (a half-migrated tree,
    or an operator who created the new folder by hand) the datasets are moved one
    by one and a name that exists on BOTH sides is left alone and reported — never
    silently overwritten, the bytes are irreplaceable."""
    if not src.is_dir():
        return
    if not dest.exists():
        try:
            os.replace(src, dest)
            log.append(f"{_migrate_rel(src)} -> {_migrate_rel(dest)}")
            return
        except OSError:
            # Cross-device, or another process created the target between the two
            # calls. The per-child merge below handles both.
            pass
    try:
        dest.mkdir(parents=True, exist_ok=True)
        children = sorted(src.iterdir())
    except OSError as exc:
        log.append(f"FAILED {_migrate_rel(src)}: {exc}")
        return
    for child in children:
        target = dest / child.name
        if target.exists():
            log.append(f"SKIPPED {_migrate_rel(child)}: {_migrate_rel(target)} already exists")
            continue
        try:
            os.replace(child, target)
            log.append(f"{_migrate_rel(child)} -> {_migrate_rel(target)}")
        except OSError as exc:
            log.append(f"FAILED {_migrate_rel(child)}: {exc}")
    try:
        if not any(src.iterdir()):
            src.rmdir()
            log.append(f"removed empty {_migrate_rel(src)}")
    except OSError:
        pass


def _migrate_journals(state_dir: Path, log: list) -> None:
    """uploads/state/<type>__<folder>.json — the resumable-import journal.

    The type lives in the file NAME (list_staged splits the stem) and again in the
    document's `type` field, and the format is shared byte-for-byte with the PHP
    twin so an import started on one backend resumes on the other. Both halves
    therefore move together."""
    if not state_dir.is_dir():
        return
    for legacy, canon in _LEGACY_TYPE_DIRS.items():
        for jp in sorted(state_dir.glob(f"{legacy}__*.json")):
            target = state_dir / f"{canon}__{jp.name[len(legacy) + 2:]}"
            if target.exists():
                log.append(f"SKIPPED {jp.name}: {target.name} already exists")
                continue
            try:
                doc = json.loads(jp.read_text(encoding="utf-8"))
            except Exception:
                doc = None
            try:
                if isinstance(doc, dict):
                    doc["type"] = canon
                    _atomic_write(target, json.dumps(doc, ensure_ascii=False), mode=_file_mode())
                    jp.unlink()
                else:
                    # Unreadable journal: move it as-is rather than drop it. Worst
                    # case the operator re-drops the folder and it re-plans.
                    os.replace(jp, target)
                log.append(f"journal {jp.name} -> {target.name}")
            except OSError as exc:
                log.append(f"FAILED journal {jp.name}: {exc}")


def _migrate_metadata(log: list) -> None:
    """Make every published metadata.json agree with its folder: `type` is the
    directory it sits in, `id` is '<type>/<folder>', and any dataset relation the
    operator recorded is re-pointed at the new id."""
    for type_dir in ALLOWED_TYPE_DIRS:
        base = DATA_WEB / type_dir
        if not base.is_dir():
            continue
        for ds_dir in sorted(base.iterdir()):
            meta_path = ds_dir / "metadata.json"
            if ds_dir.name.startswith(".") or not ds_dir.is_dir() or not meta_path.is_file():
                continue
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(meta, dict):
                continue
            ds_id = f"{type_dir}/{ds_dir.name}"
            changed = False
            if meta.get("type") != type_dir:
                meta["type"] = type_dir          # the folder is the authority
                changed = True
            if meta.get("id") != ds_id:
                meta["id"] = ds_id
                changed = True
            related = meta.get("relatedIds")
            if isinstance(related, list):
                rebuilt = []
                for item in related:
                    value, moved = _migrate_legacy_id(item)
                    changed = changed or moved
                    rebuilt.append(value)
                if rebuilt != related:
                    meta["relatedIds"] = rebuilt
            if not changed:
                continue
            try:
                _atomic_write(meta_path, json.dumps(meta, indent=2, ensure_ascii=False),
                              mode=_file_mode())
                log.append(f"metadata {ds_id}")
            except OSError as exc:
                log.append(f"FAILED metadata {ds_id}: {exc}")


def _migrate_merge_counters(a, b):
    """Two stats rows for one dataset (a legacy-keyed one and an already-canonical
    one): numeric counters add up, the most recent ISO timestamp wins."""
    if not isinstance(a, dict):
        return b
    if not isinstance(b, dict):
        return a
    merged = dict(a)
    for key, value in b.items():
        current = merged.get(key)
        if isinstance(value, bool) or isinstance(current, bool):
            merged[key] = value
        elif isinstance(value, (int, float)) and isinstance(current, (int, float)):
            merged[key] = current + value
        elif isinstance(value, str) and isinstance(current, str):
            merged[key] = max(current, value)   # ISO timestamps sort lexicographically
        else:
            merged.setdefault(key, value)
    return merged


def _migrate_stats(log: list) -> None:
    """api/stats.json is indexed by dataset id and is _UPDATE_PROTECTed, so a
    deployment's whole view/download history is keyed in the old vocabulary."""
    if not STATS_FILE.exists():
        return
    try:
        stats = json.loads(STATS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(stats, dict) or not isinstance(stats.get("datasets"), dict):
        return
    rekeyed: dict = {}
    changed = False
    for key, value in stats["datasets"].items():
        new_key, moved = _migrate_legacy_id(key)
        changed = changed or moved
        if new_key in rekeyed:
            rekeyed[new_key] = _migrate_merge_counters(rekeyed[new_key], value)
        else:
            rekeyed[new_key] = value
    if not changed:
        return
    stats["datasets"] = rekeyed
    try:
        _atomic_write(STATS_FILE, json.dumps(stats, indent=2, ensure_ascii=False))
        log.append(f"api/stats.json: {len(rekeyed)} dataset row(s) re-keyed")
    except OSError as exc:
        log.append(f"FAILED api/stats.json: {exc}")


def _migrate_instance(log: list) -> None:
    """config/instance.json — pageTitles is keyed by <body data-page>, and the
    photograph page is served as 2d.html (data-page="2d"). The retired tracking
    page and type leave their title, their nav toggle and their display names."""
    if not INSTANCE_FILE.exists():
        return
    try:
        doc = json.loads(INSTANCE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(doc, dict):
        return
    changes = []
    titles = doc.get("pageTitles")
    if isinstance(titles, dict) and "wholemount" in titles:
        value = titles.pop("wholemount")
        titles.setdefault("2d", value)   # never clobber a title the operator already set
        changes.append("pageTitles.wholemount -> pageTitles.2d")
    if isinstance(titles, dict) and "tracking" in titles:
        titles.pop("tracking")
        changes.append("pageTitles.tracking dropped")
    nav = doc.get("nav")
    if isinstance(nav, dict) and "showTracking" in nav:
        nav.pop("showTracking")
        changes.append("nav.showTracking dropped")
    dtypes = doc.get("datasetTypes")
    if isinstance(dtypes, dict) and "tracking" in dtypes:
        dtypes.pop("tracking")
        changes.append("datasetTypes.tracking dropped")
    if not changes:
        return
    try:
        _atomic_write(INSTANCE_FILE, json.dumps(doc, indent=2, ensure_ascii=False),
                      mode=_file_mode())
        log.append("config/instance.json: " + ", ".join(changes))
    except OSError as exc:
        log.append(f"FAILED config/instance.json: {exc}")


def _migrate_pages(log: list) -> None:
    """config/pages/<slug>.json holds operator-authored layouts whose buttons link
    to explorer.html?type=<type>. Those hrefs are content, so nothing else will
    ever fix them."""
    pages = CONFIG_DIR / "pages"
    if not pages.is_dir():
        return
    for page in sorted(pages.glob("*.json")):
        try:
            text = page.read_text(encoding="utf-8")
        except OSError:
            continue
        rewritten = _LEGACY_TYPE_HREF_RE.sub(
            lambda m: m.group(1) + _LEGACY_TYPE_DIRS[m.group(2)], text)
        rewritten = _RETIRED_TYPE_HREF_RE.sub(lambda m: m.group(1) + "live", rewritten)
        if rewritten == text:
            continue
        try:
            _atomic_write(page, rewritten, mode=_file_mode())
            log.append(f"config/pages/{page.name}: explorer ?type= links re-pointed")
        except OSError as exc:
            log.append(f"FAILED config/pages/{page.name}: {exc}")


def _migrate_dataset_types() -> list[str]:
    """Convert a deployment to the canonical dataset vocabulary. Returns one line
    per change (empty list = nothing to do). Safe to call on every boot.

    The metadata pass is NOT gated on the legacy guard: every published
    metadata.json must agree with its folder on `type` / `id` at every boot. A file
    that lost them — a PHP host wrote the editor's payload verbatim, and the editor
    never posts `type` — is put right here, once, without anyone having to re-save
    it. Reading one small file per dataset is what the catalog does per request."""
    log: list[str] = []
    legacy = _legacy_types_present()
    if legacy:
        staging = UPLOADS_DIR / "staging"
        for old, canon in _LEGACY_TYPE_DIRS.items():
            _migrate_move_dir(DATA_WEB / old, DATA_WEB / canon, log)
            _migrate_move_dir(staging / old, staging / canon, log)
        _migrate_retire_tracking(log)
        _migrate_journals(UPLOADS_DIR / "state", log)
    _migrate_metadata(log)
    if legacy:
        _migrate_stats(log)
        _migrate_instance(log)
        _migrate_pages(log)
    if log:
        _CATALOG_CACHE["sig"] = None
    return log


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
        _atomic_write(target, new_text, mode=_file_mode())
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
        _atomic_write(target, new_text, mode=_file_mode())
    except Exception:
        pass


# ── HTTP handler ───────────────────────────────────────────────────────────────

# A served file under a dataset's download/ folder (used to count downloads). The
# type alternation is BUILT from the one type table, so the two can never drift.
_DOWNLOAD_RE = re.compile(
    r"^DATA_WEB/(" + "|".join(re.escape(t) for t in ALLOWED_TYPE_DIRS) + r")/([^/]+)/download/.+",
    re.IGNORECASE)


# ── Static serving helpers ─────────────────────────────────────────────────────

# The platform's own documents: HTML files at the top of the tree. Only these get a
# CSP nonce injected; an .html anywhere else (a plugin folder, a dataset, a backup
# copy) is refused, because a same-origin document carrying a live nonce, or simply
# loading same-origin scripts, would sidestep the plugin trust gate.
_HTML_LIKE_EXT = (".html", ".htm", ".xhtml", ".shtml")

# Text assets worth compressing on the wire. A pretty-printed brick manifest runs to
# 23 MB and gzips to about 1.5 MB; it is the first heavy request of every open.
_COMPRESSIBLE_EXT = frozenset({".json", ".jsonl", ".js", ".mjs", ".css", ".svg",
                               ".txt", ".csv", ".md", ".map"})
_GZIP_MIN_BYTES = 1024
_GZIP_MAX_SOURCE = 256 * 1024 * 1024
_GZIP_CACHE: "OrderedDict[tuple, bytes]" = OrderedDict()
_GZIP_CACHE_LOCK = threading.Lock()
_GZIP_CACHE_BUDGET = 96 * 1024 * 1024
_GZIP_CACHE_BYTES = [0]

# Cache lifetimes — the SAME rule as the root .htaccess, so a deployment behaves
# alike on both backends. Revalidated (no-cache + ETag) costs a 304 when unchanged.
#   brick pack (.bin/.rgba/.gz) WITH ?v=  → immutable for a year: the brick loader
#       stamps every pack URL with a hash of the manifest's pack list, so a
#       re-processed dataset gets new URLs and can never read yesterday's voxels;
#   brick pack without ?v=                → revalidated;
#   script/style WITH ?v= (release stamp) → immutable for a week (a host that rate-
#       limits per address answers 429 when ~25 scripts revalidate on every page);
#   everything else (unversioned scripts, JSON, manifests…) → revalidated.
_CACHE_REVALIDATE = "no-cache"
_CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
_CACHE_VERSIONED_ASSET = "public, max-age=604800, immutable"
_PACK_EXT = (".bin", ".rgba", ".gz")
_ASSET_EXT = (".js", ".mjs", ".css")

# A document served from the dataset tree or the media library is someone's upload,
# never one of our pages: whatever a browser makes of it, it runs nothing and reaches
# nothing. Never applied to .js (a Worker script's own CSP would bind the worker).
_UNTRUSTED_DOC_CSP = ("default-src 'none'; img-src 'self' data:; media-src 'self'; "
                      "style-src 'unsafe-inline'; sandbox")

def _static_cache_policy(rel_lower: str, query: str) -> str:
    """Cache-Control for a static file (see the table above _CACHE_REVALIDATE). A
    `v` parameter counts with an empty value too, as the .htaccess `(^|&)v=` does."""
    versioned = "v" in urllib.parse.parse_qs(query or "", keep_blank_values=True)
    if rel_lower.endswith(_PACK_EXT):
        return _CACHE_IMMUTABLE if versioned else _CACHE_REVALIDATE
    if rel_lower.endswith(_ASSET_EXT):
        return _CACHE_VERSIONED_ASSET if versioned else _CACHE_REVALIDATE
    return _CACHE_REVALIDATE


_RANGE_UNSATISFIABLE = object()
_RANGE_RE = re.compile(r"\s*bytes\s*=\s*([0-9]{0,19})\s*-\s*([0-9]{0,19})\s*")


def _parse_byte_range(header, size: int):
    """One RFC 9110 byte range against a representation of ``size`` bytes.

    Returns ``(start, end)`` inclusive, ``None`` when the header is absent, malformed
    or multi-part (the whole representation is then sent with a 200, which the RFC
    allows), or ``_RANGE_UNSATISFIABLE`` (answer 416). A suffix ``bytes=-N`` is the
    LAST N bytes; an end past the representation is clamped to ``size - 1``.
    """
    if not header:
        return None
    m = _RANGE_RE.fullmatch(header)
    if not m:
        return None
    lo, hi = m.groups()
    if not lo and not hi:
        return None
    if not lo:
        n = int(hi)
        if n == 0 or size == 0:
            return _RANGE_UNSATISFIABLE
        return max(0, size - n), size - 1
    start = int(lo)
    if hi and int(hi) < start:
        return None
    if start >= size:
        return _RANGE_UNSATISFIABLE
    end = min(int(hi), size - 1) if hi else size - 1
    return start, end


# Multi-range (RFC 9110 §14.2, §14.6): more ranges than this after coalescing and the
# header is ignored (a 200 with the whole file — what Apache does past MaxRanges),
# so one request cannot make the server assemble thousands of parts.
MAX_BYTE_RANGES = 64
_MAX_RANGE_SPECS = 1024
_RANGE_SPEC_RE = re.compile(r"\s*([0-9]{0,19})\s*-\s*([0-9]{0,19})\s*")


def _parse_byte_ranges(header, size: int, max_ranges: int = MAX_BYTE_RANGES):
    """Every RFC 9110 byte range of ``header`` against ``size`` bytes.

    Returns a list of inclusive ``(start, end)`` pairs, sorted and coalesced (an
    overlapping or adjacent range merges into its neighbour, which the RFC allows
    regardless of the order requested); ``None`` when the header is absent,
    malformed (any bad element voids the whole header), or asks for more than
    ``max_ranges`` distinct ranges — the whole representation is then sent;
    ``_RANGE_UNSATISFIABLE`` when no range overlaps the representation. Suffix and
    clamping rules are those of ``_parse_byte_range``.
    """
    if not header:
        return None
    unit, sep, spec = header.partition("=")
    if not sep or unit.strip().lower() != "bytes":
        return None
    items = spec.split(",")
    if len(items) > _MAX_RANGE_SPECS:
        return None
    wanted, seen_any = [], False
    for item in items:
        if not item.strip():
            continue                    # the RFC list syntax tolerates empty elements
        m = _RANGE_SPEC_RE.fullmatch(item)
        if not m:
            return None
        lo, hi = m.groups()
        if not lo and not hi:
            return None
        seen_any = True
        if not lo:
            n = int(hi)
            if n > 0 and size > 0:
                wanted.append((max(0, size - n), size - 1))
            continue
        start = int(lo)
        if hi and int(hi) < start:
            return None
        if start < size:
            wanted.append((start, min(int(hi), size - 1) if hi else size - 1))
    if not seen_any:
        return None
    if not wanted:
        return _RANGE_UNSATISFIABLE
    wanted.sort()
    merged = [list(wanted[0])]
    for start, end in wanted[1:]:
        if start <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    if len(merged) > max_ranges:
        return None
    return [(a, b) for a, b in merged]


def _accepts_gzip(header) -> bool:
    for part in (header or "").split(","):
        token, _, params = part.strip().partition(";")
        if token.strip().lower() not in ("gzip", "x-gzip", "*"):
            continue
        q = 1.0
        for p in params.split(";"):
            k, _, v = p.strip().partition("=")
            if k.strip().lower() == "q":
                try:
                    q = float(v)
                except ValueError:
                    q = 0.0
        if q > 0:
            return True
    return False


def _gzip_cached(path: str, st) -> bytes:
    """gzip of a file, memoised on (path, mtime_ns, size) under a byte budget."""
    key = (path, st.st_mtime_ns, st.st_size)
    with _GZIP_CACHE_LOCK:
        hit = _GZIP_CACHE.get(key)
        if hit is not None:
            _GZIP_CACHE.move_to_end(key)
            return hit
    with open(path, "rb") as fh:
        data = fh.read()
    body = gzip.compress(data, compresslevel=6, mtime=0)
    with _GZIP_CACHE_LOCK:
        if key not in _GZIP_CACHE and len(body) <= _GZIP_CACHE_BUDGET // 4:
            for old in [k for k in _GZIP_CACHE if k[0] == path]:
                _GZIP_CACHE_BYTES[0] -= len(_GZIP_CACHE.pop(old))
            _GZIP_CACHE[key] = body
            _GZIP_CACHE_BYTES[0] += len(body)
            while _GZIP_CACHE_BYTES[0] > _GZIP_CACHE_BUDGET and _GZIP_CACHE:
                _k, v = _GZIP_CACHE.popitem(last=False)
                _GZIP_CACHE_BYTES[0] -= len(v)
    return body


def _etag_matches(header, etag: str) -> bool:
    """If-None-Match comparison (weak, as RFC 9110 requires for this header)."""
    if not header:
        return False
    if header.strip() == "*":
        return True
    bare = etag[2:] if etag.startswith("W/") else etag
    for tag in header.split(","):
        tag = tag.strip()
        if tag.startswith("W/"):
            tag = tag[2:]
        if tag == bare:
            return True
    return False


def _not_modified_since(header, mtime: float) -> bool:
    if not header:
        return False
    try:
        ims = email.utils.parsedate_to_datetime(header)
    except (TypeError, ValueError, IndexError, OverflowError):
        return False
    if ims is None:
        return False
    try:
        return int(mtime) <= int(ims.timestamp())
    except (OverflowError, OSError, ValueError):
        return False


def _has_dot_segment(clean_path: str) -> bool:
    """A path segment starting with '.' (dotfiles, .git, a publish in flight such
    as .incoming-*/.replaced-*) is never served. .well-known is the one exception."""
    for seg in clean_path.replace("\\", "/").split("/"):
        if seg.startswith(".") and seg not in (".well-known",):
            return True
    return False


def _content_disposition_attachment(name: str) -> str:
    ascii_name = re.sub(r'[^A-Za-z0-9._ ()+-]', "_", name)[:180] or "download"
    quoted = urllib.parse.quote(name, safe="")
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quoted}'


# ── Plugin discovery response cache ───────────────────────────────────────────
# /api/plugins hashes every plugin file (trust classification) and inlines every
# plugin dictionary; it is called on each page boot, by anyone. The response is
# rebuilt only when something it depends on changes.
_PLUGINS_CACHE: dict = {"sig": None, "body": None}


def _plugins_signature() -> str:
    h = hashlib.sha256()
    h.update(f"{_DEV_TRUST}|{_TRUST_EPOCH}|{MODULES_DIR}".encode("utf-8", "surrogatepass"))
    for f in (TRUST_FILE, ROOT / "version.json", DISABLED_PLUGINS_FILE, CHANGELOG_DIR):
        try:
            st = os.stat(f)
            h.update(f"|{f.name}:{st.st_mtime_ns}:{st.st_size}".encode("utf-8", "surrogatepass"))
        except OSError:
            h.update(f"|{f.name}:-".encode("utf-8", "surrogatepass"))
    for placement in PLUGIN_PLACEMENTS:
        base = MODULES_DIR / placement
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames.sort()
            for name in sorted(filenames):
                full = os.path.join(dirpath, name)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                rel = os.path.relpath(full, MODULES_DIR)
                h.update(f"|{rel}:{st.st_mtime_ns}:{st.st_size}".encode("utf-8", "surrogatepass"))
    return h.hexdigest()


class _DiscardWriter:
    """Stand-in for wfile once a HEAD response's headers are out."""
    def __init__(self, inner):
        self._inner = inner

    def write(self, data):
        return len(data)

    def flush(self):
        try:
            self._inner.flush()
        except (OSError, ValueError):
            pass


class _QuietServer(http.server.ThreadingHTTPServer):
    """ThreadingHTTPServer with a backlog sized for a Compare page (four embedded
    viewers opening their sockets at once): the default of 5 dropped SYNs, which
    Windows clients retry only after one to three seconds."""
    request_queue_size = 128
    daemon_threads = True


class AdminHandler(http.server.SimpleHTTPRequestHandler):
    """
    Extends SimpleHTTPRequestHandler to intercept /api/* routes
    and delegate everything else to the normal static file serving.
    """

    # Keep-alive: every response carries a Content-Length (or closes the
    # connection), so the hundred-odd requests of a viewer boot share a few sockets.
    protocol_version = "HTTP/1.1"
    timeout = _SOCKET_TIMEOUT_S
    disable_nagle_algorithm = True
    # Explicit types for what the platform serves: with nosniff on every response a
    # registry-derived guess (Windows maps .js to text/plain on some hosts) would
    # stop scripts from loading.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript",
        ".css": "text/css", ".json": "application/json", ".jsonl": "application/x-ndjson",
        ".map": "application/json", ".wasm": "application/wasm",
        ".webp": "image/webp", ".svg": "image/svg+xml", ".png": "image/png",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
        ".avif": "image/avif", ".ico": "image/x-icon",
        ".glb": "model/gltf-binary", ".bin": "application/octet-stream",
        ".rgba": "application/octet-stream", ".ims": "application/octet-stream",
        ".h5": "application/octet-stream", ".hdf5": "application/octet-stream",
        ".tif": "image/tiff", ".tiff": "image/tiff", ".pdf": "application/pdf",
        ".zip": "application/zip", ".txt": "text/plain; charset=utf-8",
        ".md": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
        ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
    }

    _head_only = False
    _response_started = False

    def log_message(self, format, *args):
        # Compact log format. Quiet by default (PERF: skip the synchronous
        # per-request console write on the response hot path); enable with --verbose.
        if _LOG_REQUESTS:
            print(f"  {self.address_string()} [{self.log_date_time_string()}] {format % args}")

    def log_error(self, format, *args):
        # 4xx/5xx must always surface, even when routine request logging is quiet.
        print(f"  {self.address_string()} [{self.log_date_time_string()}] ERROR {format % args}")

    # ── Route dispatch ─────────────────────────────────────────────────────────

    def translate_path(self, path):
        """Last line of defence: no request may ever RESOLVE inside a forbidden root.

        _is_forbidden_static guards the routing table; this guards the file system
        itself, so it holds for any code path reaching the stdlib static handler
        (HEAD, a future verb, a routing mistake). It compares the already-decoded,
        already-resolved path, so no encoding trick survives it.
        """
        fs = super().translate_path(path)
        try:
            rel = Path(fs).resolve().relative_to(ROOT)
        except (ValueError, OSError):
            return fs   # outside ROOT: the stdlib already confines it there
        if rel.parts and rel.parts[0].lower() in _FORBIDDEN_ROOTS:
            return str(ROOT / "__forbidden__")   # never exists → 404
        return fs

    def send_response(self, code, message=None):
        self._response_started = True
        super().send_response(code, message)

    def flush_headers(self):
        super().flush_headers()
        if self._head_only and not isinstance(self.wfile, _DiscardWriter):
            # HEAD runs the GET route so both answer with the same status and
            # headers; only the body is swallowed, after the header block went out.
            self.wfile = _DiscardWriter(self.wfile)

    def do_HEAD(self):
        """HEAD answers exactly what GET would, minus the body.

        Without an override the stdlib's do_HEAD bypasses the whole router: a HEAD
        on the credential store answered 200 with its size and mtime (i.e. when the
        admin password was last changed) while the GET answered 404, and a HEAD on
        a page returned the raw template's length.
        """
        self._head_only = True
        real = self.wfile
        try:
            self.do_GET()
        finally:
            self.wfile = real
            self._head_only = False

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        clean_path = urllib.parse.unquote(parsed.path).strip("/")
        if clean_path in ("DATA_WEB/catalog.json", "DATA_WEB/catalog.json/"):
            self._serve_dynamic_catalog()
        elif parsed.path == "/api/health":
            # Liveness + version probe: consumed by the pivot supervisor's online
            # gate after an update, and usable by any external monitor. Public and
            # minimal by design (the version is already public on GitHub). The
            # lastUpdate summary (phase+target only, no details) lets the admin UI
            # report the outcome across the restart, before re-authentication.
            # trustEpoch drives the viewers' live revocation of sandboxed plugins;
            # whether this host runs in dev-trust is nobody else's business.
            payload = {"ok": True, "web": _max_version(CHANGELOG_DIR), "server": __version__,
                       "trustEpoch": _TRUST_EPOCH}
            last = _read_last_update()
            if last and last.get("phase") in ("done", "rolled_back"):
                payload["lastUpdate"] = {"phase": last["phase"], "target": last.get("target")}
            self._json_nostore(200, payload)
        elif parsed.path in ("/api/plugins", "/api/plugins.php"):
            self._serve_plugins()
        elif parsed.path in ("/api/languages", "/api/languages.php"):
            self._serve_languages()
        elif parsed.path in ("/api/downloads", "/api/downloads.php"):
            self._serve_downloads(parsed)
        elif parsed.path == "/api/upload.php":
            self._guarded(self._handle_upload, parsed, body=None, raw=None)
        elif parsed.path == "/api/migrations.php":
            self._guarded(self._handle_migrations, parsed, body=None, raw=None)
        elif parsed.path in ("/api/auth.php", "/api/datasets.php", "/api/admin.php", "/api/telemetry.php", "/api/site.php"):
            self._guarded(self._handle_api, parsed, body=None)
        elif _is_forbidden_static(clean_path) or _has_dot_segment(clean_path) or "\x00" in clean_path:
            self._json(404, {"error": "Not found"})
        elif clean_path == "":
            self._serve_html("index.html")
        elif clean_path.lower().endswith(_HTML_LIKE_EXT):
            # HTML documents get a per-request CSP nonce injected + the enforcing
            # nonce-CSP header (INV-1) — but only the platform's own top-level pages.
            self._serve_html(clean_path)
        else:
            self._serve_static(parsed, clean_path)

    def _maybe_count_download(self, clean_path: str):
        """Count a download when a file under DATA_WEB/<type>/<folder>/download/ is
        served. Server-side is the reliable hook (static GETs aren't POSTed). Range
        continuations are skipped so one download ≈ one increment. Only an existing
        dataset is counted (the caller has already proved the file exists): an
        invented id must never mint a stats row."""
        if "Range" in self.headers or self._head_only:
            return
        m = _DOWNLOAD_RE.match(clean_path.replace("\\", "/"))
        if not m:
            return
        # The regex is case-insensitive (a URL may spell the type dir in any case on
        # a case-insensitive filesystem); the stats key must not be. Lower-casing it
        # keeps this counter and the telemetry beacon writing the SAME key.
        safe = _safe_dataset_dir(f"{m.group(1).lower()}/{m.group(2)}")
        if safe and safe[2].is_dir():
            try:
                _record_event("download", f"{safe[0]}/{safe[1]}")
            except Exception:
                pass

    def list_directory(self, path):
        # No directory indexes anywhere: a listing of DATA_WEB/<type>/ names every
        # dataset, hidden ones included (twin of `Options -Indexes`).
        self.send_error(HTTPStatus.NOT_FOUND)
        return None

    def _static_cache_control(self, rel_lower: str, query: str) -> str:
        return _static_cache_policy(rel_lower, query)

    def _serve_static(self, parsed, clean_path: str):
        """Every static file: validators (ETag / Last-Modified, 304), cache policy,
        gzip for text assets, a single byte range for everything else.

        The brick loader asks for the byte runs of a cut through the volume instead
        of whole packs; a malformed or multi-part range is answered with the whole
        file (200), an unsatisfiable one with 416.
        """
        fs = self.translate_path(self.path)
        try:
            real = Path(fs).resolve()
            is_dir = real.is_dir()
            is_file = (not is_dir) and real.is_file()
        except OSError:
            is_dir = is_file = False
        if not is_file or real.suffix.lower() in _HTML_LIKE_EXT:
            # Directories never list; an HTML document reached through an alias
            # (trailing dot, 8.3 name) is not one of our pages either.
            self._json(404, {"error": "Not found"})
            return
        try:
            st = real.stat()
        except OSError:
            self._json(404, {"error": "Not found"})
            return
        size = st.st_size
        rel = clean_path.replace("\\", "/")
        rel_lower = rel.lower()
        ctype = self.guess_type(str(real))
        is_download = bool(_DOWNLOAD_RE.match(rel))
        compressible = real.suffix.lower() in _COMPRESSIBLE_EXT and not is_download
        rng_header = self.headers.get("Range")
        use_gzip = (compressible and not rng_header and _GZIP_MIN_BYTES <= size <= _GZIP_MAX_SOURCE
                    and _accepts_gzip(self.headers.get("Accept-Encoding")))
        etag = f'"{st.st_mtime_ns:x}-{size:x}{"-gz" if use_gzip else ""}"'
        last_modified = self.date_time_string(int(st.st_mtime))
        cache_control = self._static_cache_control(rel_lower, parsed.query)

        def common_headers():
            self.send_header("ETag", etag)
            self.send_header("Last-Modified", last_modified)
            self.send_header("Cache-Control", cache_control)
            if compressible:
                self.send_header("Vary", "Accept-Encoding")
            if is_download:
                self.send_header("Content-Disposition",
                                 _content_disposition_attachment(real.name))

        inm = self.headers.get("If-None-Match")
        if (_etag_matches(inm, etag) if inm
                else _not_modified_since(self.headers.get("If-Modified-Since"), st.st_mtime)):
            self.send_response(304)
            common_headers()
            self.end_headers()
            return

        if use_gzip:
            try:
                body = _gzip_cached(str(real), st)
            except OSError:
                self._json(404, {"error": "Not found"})
                return
            self._maybe_count_download(clean_path)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            common_headers()
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
            return

        rng = None
        if rng_header:
            if_range = self.headers.get("If-Range")
            if not if_range or if_range.strip() in (etag, last_modified):
                rng = _parse_byte_ranges(rng_header, size)
        if isinstance(rng, list) and len(rng) > 1:
            self._send_multipart_ranges(real, rng, size, ctype, common_headers)
            return
        if isinstance(rng, list):
            rng = rng[0]
        if rng is _RANGE_UNSATISFIABLE:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            common_headers()
            self.end_headers()
            return
        start, end = rng if rng else (0, size - 1)
        length = max(0, end - start + 1)
        if not rng:
            self._maybe_count_download(clean_path)
        try:
            fh = open(real, "rb")
        except OSError:
            self._json(404, {"error": "Not found"})
            return
        with fh:
            self.send_response(206 if rng else 200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            if rng:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            common_headers()
            self.end_headers()
            if self._head_only:
                return
            fh.seek(start)
            remaining = length
            while remaining > 0:
                block = fh.read(min(remaining, 1 << 20))
                if not block:
                    # The file shrank under us: the promised length can no longer
                    # be honoured, so the connection must not be reused.
                    self.close_connection = True
                    break
                try:
                    self.wfile.write(block)
                except (BrokenPipeError, ConnectionResetError):
                    self.close_connection = True
                    return
                remaining -= len(block)

    def _send_multipart_ranges(self, real: Path, ranges, size: int, ctype: str, common_headers):
        """206 multipart/byteranges (RFC 9110 §14.6): one part per coalesced range,
        each with its own Content-Range. The length is known up front, so the body
        streams from the file without being assembled in memory."""
        boundary = secrets.token_hex(16)
        heads = [(f"\r\n--{boundary}\r\nContent-Type: {ctype}\r\n"
                  f"Content-Range: bytes {a}-{b}/{size}\r\n\r\n").encode("latin-1") for a, b in ranges]
        tail = f"\r\n--{boundary}--\r\n".encode("latin-1")
        length = sum(len(h) for h in heads) + sum(b - a + 1 for a, b in ranges) + len(tail)
        try:
            fh = open(real, "rb")
        except OSError:
            self._json(404, {"error": "Not found"})
            return
        with fh:
            self.send_response(206)
            self.send_header("Content-Type", f"multipart/byteranges; boundary={boundary}")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            common_headers()
            self.end_headers()
            if self._head_only:
                return
            try:
                for head, (a, b) in zip(heads, ranges):
                    self.wfile.write(head)
                    fh.seek(a)
                    remaining = b - a + 1
                    while remaining > 0:
                        block = fh.read(min(remaining, 1 << 20))
                        if not block:
                            # The file shrank: the promised length is a lie now.
                            self.close_connection = True
                            return
                        self.wfile.write(block)
                        remaining -= len(block)
                self.wfile.write(tail)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

    def _serve_dynamic_catalog(self):
        # BUG-062/PERF-035: same filter+sort as the static rebuild, off the mtime
        # cache, encoded once per change, revalidated by ETag and gzipped on request.
        body, etag = _catalog_body()
        if _etag_matches(self.headers.get("If-None-Match"), etag):
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", _CACHE_REVALIDATE)
            self.end_headers()
            return
        encoding = None
        if len(body) >= _GZIP_MIN_BYTES and _accepts_gzip(self.headers.get("Accept-Encoding")):
            body = gzip.compress(body, compresslevel=6, mtime=0)
            encoding = "gzip"
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", _CACHE_REVALIDATE)
        self.end_headers()
        self.wfile.write(body)

    def _serve_plugins(self):
        """Live plugin discovery: enumerate js/modules/ and return the list, also
        refreshing js/modules/manifest.json on disk so static deploys stay current.
        no-store so dropping/removing a plugin folder is reflected on the next reload.
        Admin-disabled plugins are filtered out HERE (in discovery, before the client
        builds any UI) so the load-order invariant is preserved; the persisted manifest
        mirrors the filtered list so static hosts inherit the same exclusions."""
        sig = _plugins_signature()
        body = _PLUGINS_CACHE["body"] if _PLUGINS_CACHE["sig"] == sig else None
        if body is None:
            disabled = _load_disabled_plugins()
            ver = _max_version(CHANGELOG_DIR)
            approvals = _load_trust_store()
            manifest = _release_manifest_files()
            # Fail-closed on hosts with an API: incompatible OR untrusted plugins are
            # filtered out of discovery, so an untrusted index.js is never even a load
            # candidate (defense in depth — the real containment is the CSP, INV-1).
            # Surviving plugins carry a `trust` vouch (tier/hash/mode/caps) the client
            # re-verifies over the exact bytes it executes (INV-2).
            plugins = []
            for p in _list_plugins():
                if p.get("path") in disabled:
                    continue
                if not _compat_satisfies(ver, p.get("platformCompat"))[0]:
                    continue
                trust = _classify_plugin(p["path"], MODULES_DIR / p["path"], approvals, manifest)
                if trust["tier"] == "untrusted":
                    continue
                p["trust"] = {"tier": trust["tier"], "hash": trust["hash"],
                              "mode": trust.get("mode"), "caps": trust.get("caps"),
                              "files": sorted(trust["files"].keys())}
                plugins.append(p)
            _write_plugins_manifest(plugins)
            body = json.dumps({"plugins": plugins, "devTrust": _DEV_TRUST,
                               "trustEpoch": _TRUST_EPOCH},
                              ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            _PLUGINS_CACHE.update({"sig": sig, "body": body})
        encoding = None
        if len(body) >= _GZIP_MIN_BYTES and _accepts_gzip(self.headers.get("Accept-Encoding")):
            body = gzip.compress(body, compresslevel=6, mtime=0)
            encoding = "gzip"
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Vary", "Accept-Encoding")
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
        if _dataset_is_hidden(ds_dir):
            # Same answer as a dataset that does not exist: a hidden dataset is not
            # announced anywhere public, and its file list is no exception.
            self._json_nostore(404, {"error": "Not found"})
            return
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

    def _send_bytes(self, data: bytes, content_type: str, filename: str, inline: bool):
        """Send an already-fetched body.

        Documents are proxied rather than linked straight to GitHub: raw.github
        serves them as octet-stream, so a browser would download instead of
        display, and a cross-origin frame would be refused by the CSP anyway.
        Coming back through our own origin, "inline" previews in an <iframe>.
        """
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        safe = filename.replace('"', "")
        self.send_header("Content-Disposition",
                         f'{"inline" if inline else "attachment"}; filename="{safe}"')
        self.send_header("Cache-Control", "private, max-age=300")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_attachment(self, path: Path, filename: str):
        """Stream a file back as a download.

        Written by hand because neither _json nor _json_nostore can emit a binary
        body, and both buffer whole. The pack is tens of megabytes, so it is copied
        in chunks rather than read into memory. Do NOT add _cors_headers() here —
        end_headers() already emits them, and duplicating headers was a real past bug.
        """
        try:
            size = path.stat().st_size
            fh = path.open("rb")
        except OSError:
            self._json(404, {"error": "Not found"})
            return
        with fh:
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(size))
            # The filename is server-controlled (a glob match on our own directory),
            # but quote it anyway so a future name with a space cannot split the header.
            self.send_header("Content-Disposition",
                             f'attachment; filename="{filename}"')
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                shutil.copyfileobj(fh, self.wfile, 256 * 1024)
            except (BrokenPipeError, ConnectionResetError):
                # The operator cancelled the download; nothing to recover.
                pass

    def end_headers(self):
        path_no_query = urllib.parse.unquote(self.path.split('?')[0]).strip("/").lower()
        if self._cors_allowed():
            self._cors_headers()
        # Every response: no content-type guessing (a JSON, text or image answer can
        # never be promoted to a document). HTML pages repeat it in _serve_html.
        self.send_header("X-Content-Type-Options", "nosniff")
        if path_no_query.startswith(("data_web/", "config/uploads/")):
            self.send_header("Content-Security-Policy", _UNTRUSTED_DOC_CSP)
        # HTML documents carry the ENFORCING nonce-CSP set in _serve_html (not here —
        # the nonce is per-request).
        super().end_headers()

    def _serve_html(self, rel_path: str):
        """Serve one of the platform's top-level HTML pages with a fresh per-request
        CSP nonce substituted for the {{CSP_NONCE}} placeholder, and the matching
        ENFORCING CSP header (INV-1). Only the dev/PHP server can do per-request
        nonce injection; pure-static hosts serve the literal placeholder (harmless —
        the nonce attr is inert with no CSP).

        Anything else that looks like a document is refused: a page inside a plugin
        folder or a dataset would otherwise be handed a valid nonce for this origin."""
        rel = rel_path.replace("\\", "/").strip("/")
        if not rel or "/" in rel or not rel.lower().endswith(".html"):
            self._json(404, {"error": "Not found"}); return
        try:
            fs_path = (ROOT / rel).resolve()
            ok = fs_path.parent == ROOT and fs_path.suffix.lower() == ".html" and fs_path.is_file()
        except OSError:
            ok = False
        if not ok:
            self._json(404, {"error": "Not found"}); return
        try:
            html = fs_path.read_text(encoding="utf-8")
        except OSError:
            self._json(500, {"error": "read failed"}); return
        nonce = secrets.token_urlsafe(18)
        # White-label head/brand injection: resolve {{SITE:…}} from instance.json
        # (SEO-correct, flash-free), then the per-request CSP nonce.
        doc = _apply_site_placeholders(html)
        # Cache-bust config/theme.css by its mtime so an operator theme change is
        # picked up immediately even though CSS is otherwise long-cached (.htaccess).
        # The URL changes only when theme.css is regenerated → best of both worlds.
        try:
            _tv = int(THEME_CSS_FILE.stat().st_mtime) if THEME_CSS_FILE.exists() else 0
        except OSError:
            _tv = 0
        doc = doc.replace('href="config/theme.css"', f'href="config/theme.css?v={_tv}"')
        body = doc.replace("{{CSP_NONCE}}", nonce).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", _csp_policy(nonce))
        self.send_header("X-Frame-Options", "SAMEORIGIN")  # clickjacking (legacy; CSP frame-ancestors covers modern)
        self.send_header("Cache-Control", "no-store")  # per-request nonce → never cache
        self.end_headers()
        self.wfile.write(body)

    def _reject(self, status: int, payload: dict):
        """Answer without having read the request body: the unread bytes would be
        parsed as the next request on a kept-alive connection, so close it."""
        self.close_connection = True
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _content_length(self, limit: int):
        """The announced body length, or None after answering 400/411/413. A length
        is accepted only as plain decimal digits, never negative, never above
        ``limit`` — refused before a byte is read off the socket."""
        if self.headers.get("Transfer-Encoding"):
            self._reject(411, {"error": "length_required"})
            return None
        raw = (self.headers.get("Content-Length") or "0").strip()
        if not re.fullmatch(r"[0-9]{1,15}", raw):
            self._reject(400, {"error": "bad_length"})
            return None
        length = int(raw)
        if length > limit:
            self._reject(413, {"error": "body_too_large", "limit": limit})
            return None
        return length

    def _guarded(self, fn, *args, **kwargs):
        """Run a route; an unexpected exception becomes a 500 JSON answer and a
        closed connection instead of a reset socket and a stderr traceback."""
        try:
            fn(*args, **kwargs)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True
        except Exception as exc:
            self.close_connection = True
            self.log_error("unhandled %s on %s: %r", exc.__class__.__name__, self.path, exc)
            if not self._response_started:
                try:
                    self._json(500, {"error": "internal_error"})
                except Exception:
                    pass

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/upload.php":
            self._guarded(self._read_upload_post, parsed)
            return
        if parsed.path == "/api/migrations.php":
            self._guarded(self._read_migrations_post, parsed)
            return
        limit = _API_BODY_LIMITS.get(parsed.path)
        if limit is None:
            self._reject(405, {"error": "Method not allowed"})
            return
        length = self._content_length(limit)
        if length is None:
            return
        ctype = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if parsed.path == "/api/datasets.php" and ctype.startswith("image/"):
            # A gallery image travels as its raw bytes (no base64 inside JSON, +33%),
            # its name and caption in the query string. Refused before a byte is read
            # when it cannot fit.
            if length > MAX_GALLERY_BYTES:
                self._reject(413, {"error": "too_large", "limit": MAX_GALLERY_BYTES})
                return
            raw = self._read_exact(length)
            if raw is None:
                self._reject(400, {"error": "short_body"})
                return
            self._guarded(self._handle_api, parsed, body={}, raw_image=raw)
            return
        raw = self._read_exact(length) if length else b"{}"
        if raw is None:
            self._reject(400, {"error": "short_body"})
            return
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = {}
        # Every handler reads fields with .get(): a JSON array, string or number
        # is treated as an empty object rather than raising.
        if not isinstance(body, dict):
            body = {}
        self._guarded(self._handle_api, parsed, body=body)

    def _read_upload_post(self, parsed):
        """Read an import POST — raw octets for `chunk`, JSON for everything else.

        `chunk` carries the payload as the RAW request body, not base64 inside
        JSON. That is the single biggest throughput decision in the import path:
        base64 costs +33% on the wire and forces a multi-megabyte string through
        json.loads on both ends. All chunk parameters travel in the query string,
        so nothing here has to parse the body at all.

        The session is checked BEFORE the body is read: an anonymous peer must not
        be able to make the server buffer a 17 MiB chunk.
        """
        params = dict(urllib.parse.parse_qsl(parsed.query))
        if not _get_session(self._token()):
            self._reject(401, {"error": "Not authenticated"})
            return
        length = self._content_length(_MAX_UPLOAD_BODY)
        if length is None:
            return
        if params.get("action") == "chunk":
            raw = self._read_exact(length)
            if raw is None:
                self._reject(400, {"error": "short_body"})
                return
            self._handle_upload(parsed, body=None, raw=raw)
            return
        raw = self._read_exact(length) if length else b"{}"
        if raw is None:
            self._reject(400, {"error": "short_body"})
            return
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        self._handle_upload(parsed, body=body, raw=None)

    def _read_migrations_post(self, parsed):
        """A migrations POST: `unit_put` carries a unit blob as the RAW body (up to
        32 MiB of PNG tiles, never base64), `speedtest_put` a converted test block (≤ 4 MiB,
        dropped), every other action a small JSON body.
        Session and CSRF are checked BEFORE a byte is read, so an anonymous or forged
        request cannot make the server buffer a 32 MiB body."""
        params = dict(urllib.parse.parse_qsl(parsed.query))
        session = _get_session(self._token())
        if not session:
            self._reject(401, {"error": "Not authenticated"})
            return
        ok, status, payload = _authorize_write(self.command, session, self.headers.get("X-CSRF-Token"))
        if not ok:
            self._reject(status, payload)
            return
        if params.get("action") in ("unit_put", "speedtest_put"):
            cap = (dataset_migrations.MAX_UNIT_BODY if params.get("action") == "unit_put"
                   else dataset_migrations.SPEEDTEST_PUT_MAX)
            length = self._content_length(cap)
            if length is None:
                return
            raw = self._read_exact(length)
            if raw is None:
                self._reject(400, {"error": "short_body"})
                return
            self._handle_migrations(parsed, body={}, raw=raw)
            return
        length = self._content_length(64 * 1024)
        if length is None:
            return
        raw = self._read_exact(length) if length else b"{}"
        if raw is None:
            self._reject(400, {"error": "short_body"})
            return
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = {}
        self._handle_migrations(parsed, body=body if isinstance(body, dict) else {}, raw=None)

    def _handle_migrations(self, parsed, body, raw):
        """api/migrations.php — dataset format upgrades (SPEC DOCS/dataset-migrations).
        Every action needs the admin session; the mutating ones POST + CSRF (checked
        again here for the GET path, which only serves `status`)."""
        params = dict(urllib.parse.parse_qsl(parsed.query))
        action = params.get("action", "")
        session = _get_session(self._token())
        if not session:
            self._json(401, {"error": "Not authenticated"})
            return
        if action in dataset_migrations.WRITE_ACTIONS:
            ok, status, payload = _authorize_write(self.command, session, self.headers.get("X-CSRF-Token"))
            if not ok:
                self._json(status, payload)
                return
            upload_staging.ensure_dirs()   # asserts the deny-all guard of uploads/
        elif action in dataset_migrations.BINARY_POST_ACTIONS and self.command == "POST":
            # A browser unit's input runs in one answer (read_ranges): POST + CSRF like a write.
            ok, status, payload = _authorize_write(self.command, session, self.headers.get("X-CSRF-Token"))
            if not ok:
                self._json(status, payload)
                return
            _migrations_bind()
            status, ctype, data = dataset_migrations.handle_binary(action, params, body)
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if not self._head_only:
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    self.close_connection = True
            return
        elif action in dataset_migrations.BINARY_ACTIONS and self.command == "GET":
            # A read, session only, no CSRF: one stored v3 brick of an m004 tile store
            # (store_get, read back by the browser executor to reduce the next level), or
            # the speed test's input batch (speedtest_sample).
            _migrations_bind()
            status, ctype, data = dataset_migrations.handle_binary(action, params)
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if not self._head_only:
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    self.close_connection = True
            return
        elif action != "status" or self.command != "GET":
            self._json(400, {"error": "Unknown action"})
            return
        _migrations_bind()
        status, payload = dataset_migrations.handle(action, params, body, raw)
        self._json_nostore(status, payload)

    def _read_exact(self, length: int):
        """Read exactly `length` bytes, or None if the peer hung up early.

        rfile.read(n) on a socket-backed buffered reader can return short on a
        connection reset. A short read must FAIL the chunk — silently storing a
        truncated body would defeat the per-chunk hash check downstream.
        """
        if length <= 0:
            return b""
        chunks, remaining = [], length
        while remaining > 0:
            try:
                block = self.rfile.read(min(remaining, 1 << 20))
            except (OSError, ValueError):
                return None
            if not block:
                return None
            chunks.append(block)
            remaining -= len(block)
        return b"".join(chunks)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ── Dataset import (staging) ───────────────────────────────────────────────

    def _handle_upload(self, parsed, body, raw):
        """api/upload.php — the resumable dataset import endpoint.

        EVERY action requires an authenticated admin session, including the reads:
        the staging store holds unvalidated bytes and its very existence must not
        be probeable anonymously. Writes additionally require the CSRF header via
        _authorize_write, exactly like the other admin POST routes.
        """
        params = dict(urllib.parse.parse_qsl(parsed.query))
        action = params.get("action", "")

        session = _get_session(self._token())
        if not session:
            self._json(401, {"error": "Not authenticated"})
            return

        _WRITE_ACTIONS = ("plan", "chunk", "file_done", "publish", "discard",
                          "save_metadata", "save_thumbnail", "gc")
        if action in _WRITE_ACTIONS:
            ok, status, payload = _authorize_write(
                self.command, session, self.headers.get("X-CSRF-Token"))
            if not ok:
                self._json(status, payload)
                return
            upload_staging.ensure_dirs()

        ds = params.get("ds", "")
        type_dir, _, folder = ds.partition("/")

        if action == "limits":
            # The client negotiates its chunk size from this. Python has no
            # post_max_size equivalent, so it simply advertises the ceiling.
            self._json_nostore(200, {
                "ok": True,
                "chunkSize": upload_staging.DEFAULT_CHUNK_SIZE,
                "maxChunkSize": upload_staging.MAX_CHUNK_SIZE,
                "parallel": 4,
                "staleAfterS": upload_staging.STALE_AFTER_S,
                "backend": "python",
            })
        elif action == "ping":
            # The upload worker's network probe: a cheap authenticated round-trip
            # that tells "the network is back" from "the session is gone" (401).
            self._json_nostore(200, {"ok": True})
        elif action == "list":
            _gc, kept = upload_staging.gc_and_list()
            self._json_nostore(200, {"ok": True, "datasets": kept})
        elif action == "state":
            info = upload_staging.describe(type_dir, folder)
            self._json_nostore(200 if info else 404,
                               {"ok": True, **info} if info else {"error": "not_staged"})
        elif action == "validate":
            self._json_nostore(200, upload_staging.validate_dataset(type_dir, folder))
        elif action == "blob":
            self._serve_staged_blob(type_dir, folder, params.get("path", ""))
        elif action == "metadata":
            meta = upload_staging.read_staged_metadata(type_dir, folder)
            self._json_nostore(200 if meta else 404, meta or {"error": "not_staged"})
        elif action == "plan":
            result = upload_staging.plan((body or {}).get("datasets"),
                                         (body or {}).get("chunkSize", upload_staging.DEFAULT_CHUNK_SIZE))
            self._json(200 if result.get("ok") else 400, result)
        elif action == "chunk":
            try:
                index = int(params.get("index", "-1"))
            except ValueError:
                index = -1
            try:
                file_id = int(params["fid"]) if "fid" in params else None
            except ValueError:
                file_id = None
            status, payload = upload_staging.write_chunk(
                type_dir, folder, params.get("path", ""), index,
                raw if raw is not None else b"", params.get("sha256"), file_id)
            self._json(status, payload)
        elif action == "file_done":
            status, payload = upload_staging.finalize_file(
                type_dir, folder, (body or {}).get("path", ""), (body or {}).get("root"))
            self._json(status, payload)
        elif action == "save_metadata":
            status, payload = upload_staging.write_staged_metadata(
                type_dir, folder, (body or {}).get("metadata"))
            self._json(status, payload)
        elif action == "save_thumbnail":
            image = (body or {}).get("image", "")
            if not isinstance(image, str) or not image.startswith("data:image/"):
                self._json(400, {"error": "Invalid image format"})
                return
            try:
                import base64 as _b64
                img_bytes = _b64.b64decode(image.split(",", 1)[1])
            except Exception:
                self._json(400, {"error": "Invalid image data"})
                return
            if len(img_bytes) > MAX_THUMB_BYTES or not _is_supported_image(img_bytes):
                self._json(400, {"error": "Invalid image"})
                return
            status, payload = upload_staging.save_staged_thumbnail(type_dir, folder, img_bytes)
            self._json(status, payload)
        elif action == "publish":
            status, payload = upload_staging.publish_dataset(
                type_dir, folder,
                overwrite=bool((body or {}).get("overwrite")),
                hidden=bool((body or {}).get("hidden", True)))
            if status == 200:
                _CATALOG_CACHE["sig"] = None
            self._json(status, payload)
        elif action == "discard":
            status, payload = upload_staging.discard_dataset(type_dir, folder)
            self._json(status, payload)
        elif action == "gc":
            self._json(200, {"ok": True, **upload_staging.gc()})
        else:
            # Deliberately does not echo `action` back — no reason to reflect
            # attacker-controlled input, even JSON-encoded (twin: api/upload.php).
            self._json(400, {"error": "Unknown action"})

    def _serve_staged_blob(self, type_dir: str, folder: str, rel: str):
        """Stream one staged file to an authenticated admin.

        This is the ONLY way bytes leave the staging store before publication, and
        it is what lets the operator preview and edit a dataset while the rest of
        it is still arriving. Served as opaque octets with nosniff, so even a file
        that somehow carried markup can never be interpreted as a document by the
        browser. Range is honoured because the brick loader fetches whole packs but
        the viewer may retry partially.
        """
        path = upload_staging.staged_file_path(type_dir, folder, rel)
        if path is None or not path.is_file():
            self._json_nostore(404, {"error": "Not found"})
            return
        try:
            size = path.stat().st_size
        except OSError:
            self._json_nostore(404, {"error": "Not found"})
            return

        rng = _parse_byte_range(self.headers.get("Range"), size)
        if rng is _RANGE_UNSATISFIABLE:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        status = 206 if rng else 200
        start, end = rng if rng else (0, size - 1)

        length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self._head_only:
            return
        with open(path, "rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                block = fh.read(min(remaining, 1 << 20))
                if not block:
                    self.close_connection = True
                    break
                try:
                    self.wfile.write(block)
                except (BrokenPipeError, ConnectionResetError):
                    self.close_connection = True
                    return
                remaining -= len(block)

    # ── API router ─────────────────────────────────────────────────────────────

    def _handle_api(self, parsed, body, raw_image=None):
        params = dict(urllib.parse.parse_qsl(parsed.query))
        action = params.get("action", "")
        path   = parsed.path

        # ── Site config (white-label) ─────────────────────────────────────────
        # Public GET of a config doc (instance/theme/legal/pages/<slug>); writes
        # (save/reset/publish) require an authenticated admin session + CSRF. The
        # PUBLISHED docs are also fetchable directly as static config/*.json — the
        # GET action exists so the admin editor can read a doc uniformly. Twin: api/site.php.
        if path == "/api/site.php":
            doc_name = params.get("doc", "")
            if action == "get":
                # Only the operator gets the draft back. An anonymous read of a PAGE
                # is refused outright: the public pages read the static published
                # copy (config/pages/<slug>.json), and an admin whose session expired
                # must learn it here rather than be handed the published-only doc
                # and autosave it over the draft.
                session = _get_session(self._token())
                if not session and doc_name.strip().startswith("pages/"):
                    self._json(401, {"error": "Not authenticated"})
                    return
                data = _load_site_admin(doc_name) if session else _load_site_public(doc_name)
                if data is None:
                    self._json(400, {"error": "Invalid doc"})
                elif session:
                    self._json(200, data, headers={"Cache-Control": "no-store",
                                                   "X-Lumen-Rev": _site_rev(doc_name) or ""})
                else:
                    self._json_nostore(200, data)
                return
            session = _get_session(self._token())
            if not session:
                self._json(401, {"error": "Not authenticated"})
                return
            if action in ("save", "save_draft", "reset", "publish", "delete"):
                ok, status, payload = _authorize_write(
                    self.command, session, self.headers.get("X-CSRF-Token"))
                if not ok:
                    self._json(status, payload)
                    return
            rev = params.get("rev") or None
            if action == "save":
                merge = None
                if "merge" in params:
                    merge = _parse_merge_paths(params.get("merge"))
                    if merge is None:
                        self._json(400, {"error": "bad_merge"})
                        return
                if doc_name.startswith("pages/"):
                    _vok, _verr = _validate_page_doc(body if isinstance(body, dict) else {})
                    if not _vok:
                        self._json(400, {"error": _verr or "Invalid page"})
                        return
                st, pl = _site_save_checked(doc_name, body or {}, rev=rev, merge=merge)
                self._json(st, pl)
            elif action == "save_draft":
                st, pl = _site_save_draft(doc_name, body or {}, rev=rev)
                self._json(st, pl)
            elif action == "reset":
                with _SITE_LOCK:
                    ok = _reset_site_doc(doc_name)
                self._json(200 if ok else 400,
                           {"ok": True, "rev": _site_rev(doc_name)} if ok else {"error": "Invalid doc"})
            elif action == "delete":
                with _SITE_LOCK:
                    ok = _delete_site_doc(doc_name)
                self._json(200 if ok else 400, {"ok": True} if ok else {"error": "Invalid doc"})
            elif action == "publish":
                with _SITE_LOCK:
                    ok = _publish_site_doc(doc_name)
                self._json(200 if ok else 400,
                           {"ok": True, "rev": _site_rev(doc_name)} if ok else {"error": "Invalid doc"})
            else:
                self._json(400, {"error": f"Unknown action: {action}"})
            return

        # ── Media library (operator image uploads) ────────────────────────────
        if path == "/api/media.php":
            session = _get_session(self._token())
            if not session:
                self._json(401, {"error": "Not authenticated"})
                return
            if action in ("upload", "delete"):
                ok, status, payload = _authorize_write(
                    self.command, session, self.headers.get("X-CSRF-Token"))
                if not ok:
                    self._json(status, payload)
                    return
            if action == "list":
                self._json(200, {"files": _media_list()})
            elif action == "upload":
                res = _media_upload(body or {})
                self._json(200 if res.get("ok") else 400, res)
            elif action == "delete":
                ok = _media_delete((body or {}).get("name", ""))
                self._json(200 if ok else 400, {"ok": True} if ok else {"error": "Invalid file"})
            else:
                self._json(400, {"error": f"Unknown action: {action}"})
            return

        # ── Auth ──────────────────────────────────────────────────────────────
        if path == "/api/auth.php":
            if action in ("login", "logout", "setup", "change_password"):
                # Login CSRF: a cross-site page could otherwise POST a text/plain
                # "JSON" body (a simple request, no preflight) and log the victim
                # into an attacker-chosen account, or claim a fresh install.
                if self.command != "POST":
                    self._json(405, {"error": "Method not allowed (use POST)"})
                    return
                refusal = self._same_origin_json_refusal()
                if refusal:
                    self._json(403, {"error": refusal})
                    return
            if action == "status":
                session = _get_session(self._token())
                self._json(200, {"authenticated": session is not None,
                                 "username": session["username"] if session else None,
                                 "csrf": session["csrf"] if session else None,
                                 "needsSetup": not _credential_exists()})

            elif action == "login":
                # The attempt is counted BEFORE the password is hashed (proxy-aware
                # client address), so a burst of parallel guesses cannot all slip
                # past the lockout check.
                ip = self._bf_gate()
                if ip is None:
                    return
                username = (body or {}).get("username", "")
                password = (body or {}).get("password", "")
                if _check_credentials(username, password):
                    _brute_clear(ip)
                    token = _new_session(username)
                    session = _get_session(token) or {}
                    self._json(200, {"ok": True, "username": username, "csrf": session.get("csrf")},
                               cookie=self._session_cookie(token))
                else:
                    self._json(401, {"error": "Identifiants incorrects."})

            elif action == "logout":
                _drop_session(self._token())
                self._json(200, {"ok": True}, cookie=self._session_cookie(""))

            elif action == "setup":
                # First-run password creation. _setup_credential is create-exclusive
                # (O_EXCL) so it can NEVER overwrite a live credential. No session is
                # required (none can exist before a password is set) but it is
                # rate-limited like login, and a 409 also costs a brute-force attempt.
                if self.command != "POST":
                    self._json(405, {"error": "Method not allowed (use POST)"})
                    return
                ip = self._bf_gate()
                if ip is None:
                    return
                username = (body or {}).get("username") or DEFAULT_USERNAME
                if not isinstance(username, str):
                    username = DEFAULT_USERNAME
                password = (body or {}).get("password", "")
                ok, status, payload = _setup_credential(username, password)
                if ok:
                    _brute_clear(ip)
                    token = _new_session(payload["username"])
                    session = _get_session(token) or {}
                    self._json(200, {**payload, "csrf": session.get("csrf")},
                               cookie=self._session_cookie(token))
                else:
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
                ip = self._bf_gate()
                if ip is None:
                    return
                ok2, st2, pl2 = _change_credential(
                    (body or {}).get("current", ""), (body or {}).get("new", "")
                )
                if st2 != 401:          # only a wrong current password counts
                    _brute_clear(ip)
                if ok2:
                    # Every other session dies with the old password; the caller
                    # keeps the one that just proved knowledge of it.
                    pl2 = {**pl2, "revokedSessions": _revoke_other_sessions(self._token())}
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
                # Staged imports are listed alongside published datasets so the
                # editor is ONE list: an import becomes editable the moment its
                # coarse LOD lands, long before it is published (Rule 1.3 — the
                # operator should never have to watch a progress bar to start work).
                self._json(200, {"datasets": _list_datasets() + _staged_dataset_rows(),
                                 "galleryMaxBytes": MAX_GALLERY_BYTES})

            elif action == "get":
                ds_id = params.get("id", "")
                meta = (_get_staged_dataset(ds_id) if _is_staged_id(ds_id)
                        else _get_dataset(ds_id))
                if meta is None:
                    self._json(404, {"error": "Dataset not found"})
                else:
                    self._json(200, meta)

            elif action == "save":
                ds_id = params.get("id", "")
                if _is_staged_id(ds_id):
                    t, f = _split_staged_id(ds_id)
                    status, payload = upload_staging.write_staged_metadata(t, f, body or {})
                    self._json(status, payload)
                elif _save_dataset(ds_id, body or {}):
                    self._json(200, {"ok": True})
                else:
                    self._json(400, {"error": "Invalid dataset ID"})

            elif action == "save_thumbnail":
                ds_id = params.get("id", "")
                if _is_staged_id(ds_id):
                    self._json(*_save_staged_thumbnail(ds_id, (body or {}).get("image", "")))
                else:
                    status, payload = _save_thumbnail_bytes(ds_id, (body or {}).get("image", ""))
                    self._json(status, payload)

            elif action in ("gallery_add", "gallery_delete", "gallery_thumbs"):
                ds_id = params.get("id", "")
                if _is_staged_id(ds_id):
                    # The staging store accepts only what the preprocessing pipeline
                    # emits (upload_staging.classify_path); a gallery is attached once
                    # the import is published.
                    self._json(409, {"error": "not_published"})
                elif action == "gallery_add":
                    if raw_image is not None:
                        body = {"raw": raw_image, "filename": params.get("filename", ""),
                                "title": params.get("title", ""), "caption": params.get("caption", "")}
                    self._json(*_gallery_add(ds_id, body or {}))
                elif action == "gallery_thumbs":
                    self._json(*_gallery_thumbs(ds_id))
                else:
                    self._json(*_gallery_delete(ds_id, (body or {}).get("file", "")))

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
            if self.command != "POST":
                # Beacons are POSTs (navigator.sendBeacon); a GET would let any
                # third-party page count visits with an <img> tag.
                self._json(405, {"error": "Method not allowed (use POST)"})
                return
            if not _telemetry_allow(_client_ip(self)):
                # Refused before anything is read or written: a flood costs a hash
                # and two 16-byte slot updates per request, nothing more.
                self._json(429, {"error": "rate_limited"})
                return
            if kind not in ("visit", "view", "download"):
                self._json(400, {"error": "bad_kind"})
                return
            ds_id = params.get("id") or (body or {}).get("id")
            if not isinstance(ds_id, str):
                ds_id = None
            if kind in ("view", "download"):
                # Well-formed AND existing. _safe_dataset_dir only proves the shape is
                # safe (it accepts a not-yet-created folder so `save` can mint one), so
                # without the is_dir() check this public unauthenticated beacon let
                # anyone append unlimited invented dataset keys to api/stats.json.
                safe = _safe_dataset_dir(ds_id) if ds_id else None
                if safe is None or not safe[2].is_dir():
                    ds_id = None  # still count globally if the id is missing/invalid
                else:
                    # Key on the RESOLVED pair, never on the raw client string: the
                    # download counter (_maybe_count_download) writes that same
                    # '<type>/<folder>', so one dataset can never grow two rows.
                    ds_id = f"{safe[0]}/{safe[1]}"
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
            if action in ("set_plugin", "update_apply", "update_ack",
                          "approve_plugin", "revoke_plugin",
                          "install_plugin", "update_plugin", "uninstall_plugin",
                          "repair_permissions"):
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
            elif action == "plugin_trust":
                self._json(200, {"approvals": _load_trust_store(),
                                 "devTrust": _DEV_TRUST, "trustEpoch": _TRUST_EPOCH})
            elif action == "approve_plugin":
                b = body or {}
                ip = self._bf_gate()     # a password re-check, throttled like a login
                if ip is None:
                    return
                ok2, st2, pl2 = _approve_plugin(b.get("path", ""), b.get("sha256", ""),
                                                b.get("mode", ""), b.get("caps"),
                                                b.get("password", ""))
                if st2 != 401:
                    _brute_clear(ip)
                self._json(st2, pl2)
            elif action == "revoke_plugin":
                ok2, st2, pl2 = _revoke_plugin((body or {}).get("path", ""))
                self._json(st2, pl2)
            elif action == "marketplace_catalog":
                self._json(200, _marketplace_list())
            elif action in ("install_plugin", "update_plugin"):
                b = body or {}
                ip = self._bf_gate()     # a password re-check, throttled like a login
                if ip is None:
                    return
                ok2, st2, pl2 = _install_marketplace_plugin(b.get("id", ""), b.get("password", ""),
                                                            upgrade=(action == "update_plugin"))
                if st2 != 401:
                    _brute_clear(ip)
                self._json(st2, pl2)
            elif action == "uninstall_plugin":
                ok2, st2, pl2 = _uninstall_marketplace_plugin((body or {}).get("path", ""))
                self._json(st2, pl2)
            elif action == "version":
                self._json(200, _version_info())
            elif action == "pipeline_info":
                self._json(200, _pipeline_info())
            elif action == "pipeline_download":
                edition = params.get("edition", "leger")
                local = _pipeline_local(edition)
                if local is None and edition == "leger":
                    local = _pipeline_build_lite()
                if local is None:
                    self._json(404, {"error": "pipeline_unavailable", "edition": edition})
                else:
                    self._send_attachment(local, local.name)
            elif action == "docs_list":
                self._json_nostore(200, _docs_list(force=params.get("refresh") == "1"))
            elif action == "docs_download":
                name = params.get("file", "")
                try:
                    got = _doc_fetch(name)
                except Exception as e:
                    self._json(502, {"error": "fetch_failed", "detail": str(e)[:160]})
                    return
                if got is None:
                    self._json(404, {"error": "unknown_document"})
                else:
                    body, ctype = got
                    info = _doc_parse(name) or {}
                    inline = (params.get("inline") == "1"
                              and info.get("ext") in DOC_INLINE_OK)
                    self._send_bytes(body, ctype, name, inline)
            elif action == "permissions_status":
                self._json(200, _permissions_report())
            elif action == "repair_permissions":
                self._json(200, _apply_tree_modes())
            elif action == "update_check":
                self._json(200, _update_check())
            elif action == "changelog_history":
                self._json(200, {"current": _max_version(CHANGELOG_DIR), "versions": _local_changelogs()})
            elif action == "update_preflight":
                self._json(200, _update_preflight_report(params.get("target")))
            elif action == "update_apply":
                ok2, st2, pl2 = _start_update()
                self._json(st2, pl2)
            elif action == "update_status":
                state = dict(_UPDATE_STATE)
                if state.get("phase") == "idle":
                    # After the pivot restart the in-memory state is fresh — surface
                    # the persisted outcome so the UI can report done/rolled_back.
                    last = _read_last_update()
                    if last:
                        state["last"] = last
                self._json(200, state)
            elif action == "update_ack":
                # The admin UI acknowledges the last update outcome (clears the banner).
                LAST_UPDATE_FILE.unlink(missing_ok=True)
                self._json(200, {"ok": True})
            else:
                self._json(400, {"error": f"Unknown action: {action}"})
            return

        self._json(404, {"error": "Not found"})

    # ── Helpers ────────────────────────────────────────────────────────────────

    def _token(self) -> str | None:
        return _get_cookie_token(self.headers.get("Cookie"))

    # Public, read-only endpoints that may be fetched cross-origin (an external
    # catalogue or monitor). Everything else under /api/ is same-origin only: no
    # CORS header, so a cross-site preflight for a JSON POST fails.
    _CORS_PUBLIC_API = frozenset({"/api/health", "/api/plugins", "/api/plugins.php",
                                  "/api/languages", "/api/languages.php",
                                  "/api/downloads", "/api/downloads.php"})

    def _cors_allowed(self) -> bool:
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/api/"):
            return self.command in ("GET", "HEAD")
        return path in self._CORS_PUBLIC_API and self.command in ("GET", "HEAD")

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _session_cookie(self, token: str) -> str:
        """The admin session cookie (an empty token clears it). Secure when the
        browser reached us over HTTPS through a trusted proxy (or when forced)."""
        secure = "; Secure" if _request_is_https(self) else ""
        if not token:
            return f"admpan_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax{secure}"
        return (f"admpan_token={token}; Path=/; Max-Age={SESSION_TTL}; HttpOnly; "
                f"SameSite=Lax{secure}")

    def _same_origin_json_refusal(self):
        """None when an auth POST is a same-origin JSON request, else an error code.

        application/json makes a cross-origin request preflighted (and the preflight
        gets no CORS grant for /api/). Sec-Fetch-Site, sent by every current browser,
        settles the origin question directly; Origin is the fallback for older ones.
        A request with neither header is not from a browser page, so it cannot be a
        forged cross-site request."""
        ctype = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if ctype != "application/json":
            return "json_required"
        site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if site:
            return None if site in ("same-origin", "none") else "cross_origin"
        origin = (self.headers.get("Origin") or "").strip()
        if not origin:
            return None
        if origin == "null":
            return "cross_origin"
        allowed = {(self.headers.get("Host") or "").strip().lower()}
        peer = self.client_address[0] if getattr(self, "client_address", None) else ""
        if _is_trusted_proxy(peer):
            fwd = (self.headers.get("X-Forwarded-Host") or "").split(",")[0].strip().lower()
            if fwd:
                allowed.add(fwd)
        netloc = urllib.parse.urlparse(origin).netloc.lower()
        if not netloc or netloc not in allowed:
            return "cross_origin"
        return None

    def _json(self, status: int, data: dict, cookie: str | None = None, headers: dict | None = None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _bf_gate(self):
        """Reserve a password attempt for this client; on refusal answer 429 (with
        Retry-After) and return None. Returns the bucket key when the check may run.
        Twin of api/_admin_lib.php admin_bf_gate."""
        key = _client_ip(self)
        ok, retry, _reason = _bf_reserve(key)
        if ok:
            return key
        self._json(429, {"error": "Trop de tentatives. Réessayez plus tard.", "retryAfter": retry},
                   headers={"Retry-After": str(max(1, retry))})
        return None

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
    parser.add_argument("--migrate-types", action="store_true",
                        help="Convert an existing tree to the 3d/2d dataset vocabulary, report, and exit")
    parser.add_argument("--verbose", action="store_true",
                        help="Log every request to the console (off by default for speed)")
    parser.add_argument("--check", action="store_true",
                        help="Validate a platform tree offline (CI / self-updater boot gate) and exit")
    parser.add_argument("--root", default=None,
                        help="Tree to validate with --check (default: this script's folder)")
    parser.add_argument("--pivot", default=None, help=argparse.SUPPRESS)  # internal: update supervisor
    parser.add_argument("--dev-trust-local", action="store_true",
                        help="Trust every plugin in js/modules as first-party (DEV ONLY — never on a real deployment)")
    parser.add_argument("--trusted-proxy", action="append", default=[], metavar="IP[,IP|CIDR]",
                        help="Reverse proxy allowed to set X-Forwarded-For/-Proto/-Host "
                             "(repeatable; also LUMEN_TRUSTED_PROXIES)")
    args = parser.parse_args()
    for item in args.trusted_proxy:
        TRUSTED_PROXIES.update(_parse_proxy_list(item))

    global _LOG_REQUESTS, _DEV_TRUST
    _LOG_REQUESTS = bool(args.verbose)
    # Dev-trust is a POSITIVE signal (INV-3) and comes from the explicit flag only.
    # A `.git` checkout bound to loopback is also exactly what a production install
    # behind a reverse proxy looks like, so it is no evidence of a developer.
    # LUMEN_DEV_TRUST=1 is the same signal from the environment, honoured only in a
    # .git checkout (twin of api/_admin_lib.php admin_dev_trust).
    _DEV_TRUST = bool(args.dev_trust_local) or (
        os.environ.get("LUMEN_DEV_TRUST", "").strip() == "1" and (ROOT / ".git").is_dir())

    if args.check:
        sys.exit(_check_main(args.root))
    if args.pivot:
        sys.exit(_pivot_main(args.pivot))

    if args.migrate_types:
        changes = _migrate_dataset_types()
        for line in changes:
            print(f"  {line}")
        # Plain ASCII on purpose: this runs on a Windows console whose default
        # encoding (cp1252) cannot encode an emoji, and a crash here would look
        # like a failed migration.
        print(f"[types] {len(changes)} change(s) applied." if changes
              else "[types] Nothing to migrate - the tree already uses 3d/2d/live.")
        sys.exit(0)

    if args.set_password:
        import getpass
        rec = _load_credential()
        default_user = (rec or {}).get("username", DEFAULT_USERNAME)
        username = input(f"Username [{default_user}]: ").strip() or default_user
        password = getpass.getpass("New password: ")
        if len(password) < 8:
            print("❌ Password too short (min 8 chars).")
            sys.exit(1)
        # Operator CLI may overwrite (already trusted with the filesystem); the
        # HTTP setup path remains create-exclusive (cannot overwrite a live credential).
        _write_credential_force(username, password)
        print(f"✅ Password set for user '{username}' (api/admin_credential.json)")
        sys.exit(0)

    # Serve from the platform root
    os.chdir(ROOT)

    # Crash recovery: consume any pivot journal left by an interrupted update
    # (completes it forward or restores the previous tree) before serving. Skipped
    # for a server the pivot supervisor spawned — the supervisor owns the journal
    # until its health verdict; this child reconciling would race it (see _spawn_server).
    if not os.environ.get("LUMEN_SKIP_PIVOT_RECONCILE"):
        _reconcile_pivot()

    # One-shot: move any pre-split inline page draft out of the public config/ tree
    # before the first request can read it back.
    _migrate_inline_drafts()

    # One-shot: a deployment created before the type rename still stores its bytes
    # under DATA_WEB/fixed and DATA_WEB/wholemount, which nothing reads any more.
    # Must run before the first request so no handler ever sees the old tree.
    try:
        upload_staging.ensure_dirs()   # also (re)asserts the uploads/ + DATA_WEB guards
    except OSError as exc:
        print(f"  [types] staging root unavailable: {exc}")
    for line in _migrate_dataset_types():
        print(f"  [types] {line}")
    # A publish interrupted by a crash (or a replaced dataset Windows would not let
    # go of) leaves a dot-folder beside the datasets: restore or reclaim it.
    for line in upload_staging.recover_publish_leftovers():
        print(f"  [publish] {line}")

    rec = _load_credential()
    if rec:
        cred_line = f"  Login   : {rec.get('username', DEFAULT_USERNAME)}  (password in api/admin_credential.json)\n"
    else:
        cred_line = "  Login   : (first run — open the admin panel to create a password)\n"
    trust_line = ("  Trust   : DEV — all local plugins trusted (--dev-trust-local)\n"
                  if _DEV_TRUST else
                  "  Trust   : PROD — only bundled + operator-approved plugins load\n")
    print(
        "\n"
        "=" * 60 + "\n"
        f"  IRIBHM Microscopy Platform (v{__version__}) -- Dev Server\n"
        "=" * 60 + "\n"
        f"  URL     : http://{args.host}:{args.port}\n"
        f"  Admin   : http://{args.host}:{args.port}/admpan.html\n"
        f"  Viewer  : http://{args.host}:{args.port}/explorer.html\n"
        f"{cred_line}"
        f"{trust_line}"
        "  Ctrl+C to stop\n"
        "=" * 60 + "\n"
    )


    handler = AdminHandler
    handler.directory = str(ROOT)

    # Recorded for the update pipeline: lets the pivot journal respawn the server
    # with the same arguments, and lets the update thread stop it cleanly.
    global _HTTPD, _SERVE_HOST, _SERVE_PORT, _SERVE_ARGS
    _SERVE_HOST, _SERVE_PORT = args.host, args.port
    _SERVE_ARGS = ["--host", args.host, "--port", str(args.port)] \
        + (["--verbose"] if args.verbose else [])

    if TRUSTED_PROXIES:
        print(f"  Proxies : {', '.join(sorted(TRUSTED_PROXIES))}")
    with _QuietServer((args.host, args.port), handler) as httpd:
        _HTTPD = httpd
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")


if __name__ == "__main__":
    main()
