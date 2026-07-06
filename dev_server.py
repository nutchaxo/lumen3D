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

__version__ = "0.15.0"

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
_RELEASE_PUBKEY_HEX = ""

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
_MARKETPLACE_CATALOG_URL = "https://raw.githubusercontent.com/nutchaxo/lumen3D/dev/marketplace/marketplace-catalog.json"
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
            os.replace(tmp, str(path))
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


def _load_site_doc(doc: str):
    """Read a site-config doc (active → default → empty). None on an invalid doc name."""
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


def _save_site_doc(doc: str, data) -> bool:
    """Persist a site-config doc atomically (public, world-readable 0644). instance.json
    also drops the mtime cache so the next served page picks up the head change."""
    res = _site_doc_path(doc)
    if not res or not isinstance(data, (dict, list)):
        return False
    active, _default = res
    _atomic_write(active, json.dumps(data, indent=2, ensure_ascii=False), mode=0o644)
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
    _atomic_write(THEME_CSS_FILE, _generate_theme_css(theme if isinstance(theme, dict) else {}), mode=0o644)


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


def _publish_site_doc(doc: str) -> bool:
    """Promote a doc's draft to published (page builder). Copies the `draft` block over
    `published` in-place; no-op-safe for docs without a draft/published split."""
    res = _site_doc_path(doc)
    if not res:
        return False
    data = _load_site_doc(doc)
    if isinstance(data, dict) and "draft" in data:
        data["published"] = data.get("draft")
        return _save_site_doc(doc, data)
    return True


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
    if not isinstance(password, str) or len(password) < 8:
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
    try:
        nums = re.findall(r"\d+", s or "")
        return tuple(int(x) for x in nums[:3]) or (0, 0, 0)
    except Exception:
        return (0, 0, 0)


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
    # Prefer the curated runtime artifact (allowlist-built by tools/build_release.py,
    # ships version.json with per-file sha256) over GitHub's raw source zipball, and
    # pick up the SHA256SUMS asset when published so the download can be verified.
    asset_url = asset_name = sums_url = sig_url = None
    asset_size = None
    for a in rel.get("assets") or []:
        name = a.get("name") or ""
        if _RELEASE_ASSET_RE.match(name):
            asset_url, asset_name, asset_size = a.get("browser_download_url"), name, a.get("size")
        elif name == "SHA256SUMS":
            sums_url = a.get("browser_download_url")
        elif name == "SHA256SUMS.sig":
            sig_url = a.get("browser_download_url")
    return {
        "current": current,
        "latest": latest,
        "available": available,
        "notes": rel.get("body"),
        "publishedAt": rel.get("published_at"),
        "zipUrl": rel.get("zipball_url"),
        "htmlUrl": rel.get("html_url"),
        "assetUrl": asset_url,
        "assetName": asset_name,
        "assetSize": asset_size,
        "sumsUrl": sums_url,
        "sigUrl": sig_url,
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
    "api/admin_credential.json", "api/config.json", "api/stats.json",
    "api/disabled-plugins.json", "api/quarantined-plugins.json", "api/plugin-trust.json",
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
        if not info.get("available") or not (info.get("assetUrl") or info.get("zipUrl")):
            _UPDATE_STATE["running"] = False
            return False, 400, {"error": "no_update_available", "info": info}
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


def _http_download(url: str, dest: Path, *, expected_size=None, progress=None) -> int:
    """Stream url → dest. A truncated body must fail HERE (Content-Length check),
    never surface later in the apply phase. Returns bytes written."""
    req = urllib.request.Request(url, headers={
        "User-Agent": "lumen3d-admin", "Accept": "application/octet-stream",
    })
    written = 0
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        declared = r.headers.get("Content-Length")
        declared = int(declared) if declared and declared.isdigit() else None
        while True:
            chunk = r.read(256 * 1024)
            if not chunk:
                break
            f.write(chunk)
            written += len(chunk)
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


def _fetch_marketplace_catalog() -> list:
    """Fetch + signature-verify the curated catalog JSON. Returns its plugin list.
    The catalog itself is signed (URL + '.sig') so the LIST of what-to-install is not
    forgeable, not just each release."""
    if not _MARKETPLACE_CATALOG_URL:
        raise OSError("marketplace_not_configured")
    raw = _fetch_url_bytes(_MARKETPLACE_CATALOG_URL, limit=1 << 20)
    _verify_marketplace_signature(raw, _MARKETPLACE_CATALOG_URL + ".sig")
    data = json.loads(raw.decode("utf-8"))
    plugins = data.get("plugins") if isinstance(data, dict) else None
    if not isinstance(plugins, list):
        raise OSError("catalogue marketplace invalide")
    return plugins


_MARKETPLACE_CARD_KEYS = ("id", "name", "placement", "subtype", "description",
                          "creator", "icon", "platformCompat", "sandboxCapabilities",
                          "latestVersion", "recommended")


def _marketplace_list() -> dict:
    """Catalog annotated with installed + compat status, for the admin Marketplace tab.
    Fetch/verify failures are surfaced (never fatal to the panel)."""
    base = {"configured": bool(_MARKETPLACE_CATALOG_URL), "signed": bool(_MARKETPLACE_PUBKEY_HEX)}
    if not _MARKETPLACE_CATALOG_URL:
        return {**base, "plugins": []}
    try:
        entries = _fetch_marketplace_catalog()
    except Exception as e:
        return {**base, "error": str(e), "plugins": []}
    ver = _max_version(CHANGELOG_DIR)
    installed = {p["path"] for p in _list_plugins()}
    out = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        pid = str(e.get("id", ""))
        placement = e.get("placement")
        path = f"{placement}/{pid}" if placement in PLUGIN_PLACEMENTS else None
        ok_c, reason_c = _compat_satisfies(ver, e.get("platformCompat"))
        card = {k: e.get(k) for k in _MARKETPLACE_CARD_KEYS}
        card.update({"installed": (path in installed) if path else False,
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


def _install_marketplace_plugin(catalog_id: str, password: str):
    """Install a first-party plugin from the signed catalog. Operator-initiated,
    re-auth'd, verified fail-closed; on ANY failure js/modules is left untouched. The
    plugin lands as an operator-approved (server-recomputed hash) plugin the existing
    loadModules trust gate re-verifies. Returns (ok, status, payload)."""
    if not _MARKETPLACE_CATALOG_URL:
        return False, 400, {"error": "marketplace_not_configured"}
    if not _verify_password(password or "", (_load_credential() or {}).get("password_pbkdf2") or ""):
        return False, 401, {"error": "bad_password"}
    try:
        entries = _fetch_marketplace_catalog()
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
    if target_dir.exists():
        return False, 409, {"error": "already_installed"}
    ok_c, reason_c = _compat_satisfies(_max_version(CHANGELOG_DIR), entry.get("platformCompat"))
    if not ok_c:
        return False, 409, {"error": "incompatible", "detail": reason_c}
    asset_url, sums_url, sig_url = entry.get("assetUrl"), entry.get("sumsUrl"), entry.get("sigUrl")
    if not asset_url:
        return False, 400, {"error": "no_asset"}
    tmp_root = Path(tempfile.mkdtemp(prefix=".mkt-", dir=str(MODULES_DIR)))
    moved = False
    try:
        zip_path = tmp_root / "plugin.zip"
        _download_capped(asset_url, zip_path, _MARKETPLACE_MAX_ZIP)
        digest = _sha256_file(zip_path)
        # Authenticity: verify the detached signature over SHA256SUMS (fail-closed when
        # keyed), THEN read the expected zip digest from those authenticated bytes.
        if sums_url:
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
        _rename_retry(proot, target_dir)
        moved = True
    except Exception as e:
        if moved:
            shutil.rmtree(target_dir, ignore_errors=True)
        return False, 502, {"error": "install_failed", "detail": str(e)}
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)
    # Operator approval PINNED to the on-disk bytes (server recomputes the hash — INV-4).
    server_hash = _plugin_hash(_plugin_file_hashes(target_dir))
    declared = sorted(_plugin_declared_caps(target_dir))
    wants_sandbox = bool(meta.get("sandbox")) or (placement == "tools" and bool(declared))
    mode = "sandboxed" if wants_sandbox else "trusted"
    ok_a, st_a, pl_a = _approve_plugin(path, server_hash, mode, declared, password)
    if not ok_a:
        shutil.rmtree(target_dir, ignore_errors=True)
        return False, st_a, {**pl_a, "stage": "approve"}
    global _TRUST_EPOCH
    _TRUST_EPOCH += 1
    return True, 200, {"ok": True, "path": path, "mode": mode}


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
    pivot_script = Path(tempfile.gettempdir()) / f"lumen3d-pivot-{os.getpid()}.py"
    shutil.copy2(Path(__file__).resolve(), pivot_script)
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
        url = info.get("assetUrl") or info.get("zipUrl")
        workdir.mkdir(parents=True, exist_ok=True)
        zip_path = workdir / "release.zip"

        def _dl_progress(done, total):
            if total:
                _set_update("download", min(15 + int(35 * done / total), 50),
                            f"Téléchargement… {done / 1e6:.1f} / {total / 1e6:.1f} Mo")
        _http_download(url, zip_path,
                       expected_size=info.get("assetSize") if info.get("assetUrl") else None,
                       progress=_dl_progress)

        _set_update("verify", 55, "Vérification de l'authenticité…")
        # Authenticity + integrity chain: (pinned key) —sig→ SHA256SUMS —sha256→ zip.
        # Fetch the manifest bytes ONCE: the signature is over those exact bytes, and
        # the zip digest is read from the same bytes we authenticated.
        if info.get("sumsUrl") and info.get("assetUrl") and info.get("assetName"):
            sums_raw = _fetch_url_bytes(info["sumsUrl"])
            _verify_release_signature(sums_raw, info)          # fail-closed if key pinned
            expected = _parse_sha256sums(sums_raw).get(info["assetName"])
            if expected and _sha256_file(zip_path) != expected:
                raise OSError("empreinte SHA-256 de l'archive invalide")
        elif _RELEASE_PUBKEY_HEX:
            # A signing key is pinned but the release ships no SHA256SUMS to sign over.
            raise OSError("release sans SHA256SUMS alors qu'une clé de signature est "
                          "épinglée — authenticité impossible à prouver (fail-closed)")
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
        cfile = str(Path(tempfile.gettempdir()) / f"lumen3d-check-{os.getpid()}.pyc")
        try:
            py_compile.compile(str(root / "dev_server.py"), cfile=cfile, doraise=True)
        except Exception as e:
            errors.append(f"dev_server.py ne compile pas: {e}")
        finally:
            try:
                os.unlink(cfile)
            except OSError:
                pass

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
        elif parsed.path == "/api/health":
            # Liveness + version probe: consumed by the pivot supervisor's online
            # gate after an update, and usable by any external monitor. Public and
            # minimal by design (the version is already public on GitHub). The
            # lastUpdate summary (phase+target only, no details) lets the admin UI
            # report the outcome across the restart, before re-authentication.
            payload = {"ok": True, "web": _max_version(CHANGELOG_DIR), "server": __version__,
                       "devTrust": _DEV_TRUST, "trustEpoch": _TRUST_EPOCH}
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
        elif parsed.path in ("/api/auth.php", "/api/datasets.php", "/api/admin.php", "/api/telemetry.php", "/api/site.php"):
            self._handle_api(parsed, body=None)
        elif _is_forbidden_static(clean_path):
            self._json(404, {"error": "Not found"})
        elif clean_path == "" or clean_path.endswith(".html"):
            # HTML documents get a per-request CSP nonce injected + the enforcing
            # nonce-CSP header (INV-1). '' → index.html (the directory index).
            self._serve_html(clean_path or "index.html")
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
                           "trustEpoch": _TRUST_EPOCH}, indent=2, ensure_ascii=False).encode("utf-8")
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
        # HTML documents carry the ENFORCING nonce-CSP set in _serve_html (not here —
        # the nonce is per-request). Non-HTML responses need no CSP.
        super().end_headers()

    def _serve_html(self, rel_path: str):
        """Serve an HTML document with a fresh per-request CSP nonce substituted for
        the {{CSP_NONCE}} placeholder, and the matching ENFORCING CSP header (INV-1).
        Only the dev/PHP server can do per-request nonce injection; pure-static hosts
        serve the literal placeholder (harmless — the nonce attr is inert with no CSP)."""
        rel = rel_path.replace("\\", "/").lstrip("/")
        fs_path = (ROOT / rel).resolve()
        try:
            fs_path.relative_to(ROOT)
        except ValueError:
            self._json(404, {"error": "Not found"}); return
        if not fs_path.is_file():
            super().do_GET(); return  # let the base handler 404 / directory-index
        try:
            html = fs_path.read_text(encoding="utf-8")
        except OSError:
            self._json(500, {"error": "read failed"}); return
        nonce = secrets.token_urlsafe(18)
        # White-label head/brand injection: resolve {{SITE:…}} from instance.json
        # (SEO-correct, flash-free), then the per-request CSP nonce.
        doc = _apply_site_placeholders(html)
        body = doc.replace("{{CSP_NONCE}}", nonce).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", _csp_policy(nonce))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")  # clickjacking (legacy; CSP frame-ancestors covers modern)
        self.send_header("Cache-Control", "no-store")  # per-request nonce → never cache
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("/api/auth.php", "/api/datasets.php", "/api/admin.php", "/api/telemetry.php", "/api/site.php"):
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

        # ── Site config (white-label) ─────────────────────────────────────────
        # Public GET of a config doc (instance/theme/legal/pages/<slug>); writes
        # (save/reset/publish) require an authenticated admin session + CSRF. The
        # PUBLISHED docs are also fetchable directly as static config/*.json — the
        # GET action exists so the admin editor can read a doc uniformly. Twin: api/site.php.
        if path == "/api/site.php":
            if action == "get":
                data = _load_site_doc(params.get("doc", ""))
                if data is None:
                    self._json(400, {"error": "Invalid doc"})
                else:
                    self._json_nostore(200, data)
                return
            session = _get_session(self._token())
            if not session:
                self._json(401, {"error": "Not authenticated"})
                return
            if action in ("save", "reset", "publish"):
                ok, status, payload = _authorize_write(
                    self.command, session, self.headers.get("X-CSRF-Token"))
                if not ok:
                    self._json(status, payload)
                    return
            if action == "save":
                ok = _save_site_doc(params.get("doc", ""), body or {})
                self._json(200 if ok else 400, {"ok": True} if ok else {"error": "Invalid doc"})
            elif action == "reset":
                ok = _reset_site_doc(params.get("doc", ""))
                self._json(200 if ok else 400, {"ok": True} if ok else {"error": "Invalid doc"})
            elif action == "publish":
                ok = _publish_site_doc(params.get("doc", ""))
                self._json(200 if ok else 400, {"ok": True} if ok else {"error": "Invalid doc"})
            else:
                self._json(400, {"error": f"Unknown action: {action}"})
            return

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
            if action in ("set_plugin", "update_apply", "update_ack",
                          "approve_plugin", "revoke_plugin",
                          "install_plugin", "uninstall_plugin"):
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
                ok2, st2, pl2 = _approve_plugin(b.get("path", ""), b.get("sha256", ""),
                                                b.get("mode", ""), b.get("caps"),
                                                b.get("password", ""))
                self._json(st2, pl2)
            elif action == "revoke_plugin":
                ok2, st2, pl2 = _revoke_plugin((body or {}).get("path", ""))
                self._json(st2, pl2)
            elif action == "marketplace_catalog":
                self._json(200, _marketplace_list())
            elif action == "install_plugin":
                b = body or {}
                ok2, st2, pl2 = _install_marketplace_plugin(b.get("id", ""), b.get("password", ""))
                self._json(st2, pl2)
            elif action == "uninstall_plugin":
                ok2, st2, pl2 = _uninstall_marketplace_plugin((body or {}).get("path", ""))
                self._json(st2, pl2)
            elif action == "version":
                self._json(200, _version_info())
            elif action == "update_check":
                self._json(200, _update_check())
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
    parser.add_argument("--check", action="store_true",
                        help="Validate a platform tree offline (CI / self-updater boot gate) and exit")
    parser.add_argument("--root", default=None,
                        help="Tree to validate with --check (default: this script's folder)")
    parser.add_argument("--pivot", default=None, help=argparse.SUPPRESS)  # internal: update supervisor
    parser.add_argument("--dev-trust-local", action="store_true",
                        help="Trust every plugin in js/modules as first-party (DEV ONLY — never on a real deployment)")
    args = parser.parse_args()

    global _LOG_REQUESTS, _DEV_TRUST
    _LOG_REQUESTS = bool(args.verbose)
    # Dev-trust is a POSITIVE signal (INV-3), never "version.json is missing". Two
    # positive sources: the explicit --dev-trust-local flag, OR a `.git/` checkout
    # BOUND TO LOOPBACK ONLY. The loopback gate is essential: a `.git` checkout
    # served on 0.0.0.0 (LAN/public) must NOT auto-trust local plugins — otherwise a
    # dropped-in third-party plugin would run in-page for every LAN visitor. A real
    # deployment (release artifact, no .git) stays fail-closed regardless of host.
    _git_dev = (ROOT / ".git").exists() and (args.host or "localhost") in ("localhost", "127.0.0.1", "::1")
    _DEV_TRUST = bool(args.dev_trust_local) or _git_dev

    if args.check:
        sys.exit(_check_main(args.root))
    if args.pivot:
        sys.exit(_pivot_main(args.pivot))

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

    rec = _load_credential()
    if rec:
        cred_line = f"  Login   : {rec.get('username', DEFAULT_USERNAME)}  (password in api/admin_credential.json)\n"
    else:
        cred_line = "  Login   : (first run — open the admin panel to create a password)\n"
    trust_line = ("  Trust   : DEV — all local plugins trusted (.git checkout / --dev-trust-local)\n"
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

    with http.server.ThreadingHTTPServer((args.host, args.port), handler) as httpd:
        _HTTPD = httpd
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")


if __name__ == "__main__":
    main()
