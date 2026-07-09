#!/usr/bin/env python3
"""Build the Lumen3D web release artifact: lumen3d-web-<version>.zip.

Packs the runtime files of the web platform from an explicit allowlist —
anything not listed is excluded, so new repo content (docs, tooling, data)
never leaks into a release by accident. A ``version.json`` manifest with a
per-file sha256 map is generated at the zip root, and a ``SHA256SUMS`` file
(sha256sum format) is written next to the zip.

Usage:
    python tools/build_release.py --version 1.5.0 --out dist [--commit <sha>]
"""

import argparse
import hashlib
import json
import os
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

ROOT_FILES = (
    "index.html",
    "explorer.html",
    "viewer.html",
    "compare.html",
    "tracking.html",
    "admpan.html",
    "about.html",
    "widgets.html",
    "legal.html",   # legal notices page (footer link) — was missing → 404
    "page.html",    # custom-page host (page.html?slug=…) for the page builder — was missing → 404
    "dev_server.py",
    "fast_server.py",
    "ed25519_pure.py",  # vendored release-signature verifier (updater authenticity)
    "router.php",
    "_serve.php",     # Apache HTML entry (nonce-CSP) — rewritten to by the root .htaccess
    ".htaccess",      # routes *.html → _serve.php on Apache
    "start.bat",
    "LICENCE",
)

ROOT_DIRS = ("css", "js", "lang", "assets", "changelog", "api", "config")

# Runtime state written by the admin API on the deployed host — shipping it
# would overwrite live credentials/config on update.
API_RUNTIME_STATE = frozenset(
    {
        "config.json",
        "admin_credential.json",
        "stats.json",
        "disabled-plugins.json",
        "quarantined-plugins.json",
        "plugin-trust.json",  # operator approvals — never ship (would pre-approve plugins)
    }
)

EXCLUDED_DIR_NAMES = frozenset({"__pycache__"})
EXCLUDED_FILE_NAMES = frozenset({".DS_Store", "Thumbs.db"})
EXCLUDED_SUFFIXES = frozenset({".pyc"})

# Fixed DOS timestamp so zip bytes do not vary with build-machine mtimes.
ZIP_ENTRY_DATE = (1980, 1, 1, 0, 0, 0)


def is_excluded(rel_path):
    """Return True if a path (relative to repo root) is filtered out."""
    if any(part in EXCLUDED_DIR_NAMES for part in rel_path.parts[:-1]):
        return True
    if rel_path.name in EXCLUDED_FILE_NAMES or rel_path.suffix in EXCLUDED_SUFFIXES:
        return True
    if rel_path.parts[0] == "api" and rel_path.name in API_RUNTIME_STATE:
        return True
    # App-store model: bundled plugins are NOT shipped in the release — they are
    # installed on demand from the signed marketplace (first-run picker). js/modules/
    # itself stays (installs land there); every plugin folder + the stale discovery
    # manifest are dropped so a fresh install starts plugin-less.
    parts = rel_path.parts
    if len(parts) >= 4 and parts[0] == "js" and parts[1] == "modules" and parts[2] in ("tools", "channels", "shaders"):
        return True
    if parts[:2] == ("js", "modules") and rel_path.name == "manifest.json":
        return True
    # White-label config: ship the neutral DEFAULTS (config/defaults/**) + the empty
    # generated theme.css (avoids a pre-first-save 404), but NEVER the operator/IRIBHM
    # config data (instance.json / theme.json / legal.json / pages/*) — a fresh install
    # must start neutral and get its identity from the setup wizard.
    if parts[0] == "config":
        if parts[:2] == ("config", "defaults") or rel_path.name == "theme.css":
            return False
        return True
    return False


def collect_files(root):
    """Resolve the allowlist to a sorted list of (arcname, absolute path).

    Fails hard if an allowlisted root file or directory is missing — a
    release without one of them would be broken.
    """
    selected = {}
    missing = []

    for name in ROOT_FILES:
        path = root / name
        if path.is_file():
            selected[name] = path
        else:
            missing.append(name)

    for dirname in ROOT_DIRS:
        directory = root / dirname
        if not directory.is_dir():
            missing.append(dirname + "/")
            continue
        for path in directory.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(root)
            if not is_excluded(rel):
                selected[rel.as_posix()] = path

    if missing:
        raise SystemExit(
            "ERROR: allowlisted runtime entries missing from repo: "
            + ", ".join(missing)
        )
    return sorted(selected.items())


def sha256_hex(data):
    """sha256 hex digest of a bytes payload."""
    return hashlib.sha256(data).hexdigest()


def build_version_manifest(version, commit, file_hashes):
    """Serialize version.json (covers every zip file except itself)."""
    manifest = {
        "component": "lumen3d-web",
        "web": version,
        "tag": f"v{version}",
        "released": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "commit": commit,
        "files": file_hashes,
    }
    return json.dumps(manifest, indent=2, sort_keys=True) + "\n"


def write_zip(zip_path, entries):
    """Write sorted (arcname, bytes) entries with fixed metadata."""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for arcname, data in entries:
            info = zipfile.ZipInfo(arcname, date_time=ZIP_ENTRY_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)


# ── Per-page JS bundling (request-count reduction) ──────────────────────────
# The platform ships as ~25-35 separate classic <script> files per page (no dev
# bundler by design). On hosts with aggressive per-IP request rate limiting that
# burst returns HTTP 429 and the page's JS never loads (e.g. the viewer stuck on
# "Loading dataset"). At RELEASE time only, we concatenate each classic page's
# LOCAL app scripts (js/… except js/vendor/…) into a single js/bundle/<page>.js and
# rewrite the page to load that one file — cutting ~35 requests to ~3 (bundle + the
# shared vendor libs). This changes nothing at dev time (the repo keeps separate
# files) and preserves semantics: top-level `const` in a classic script lands in the
# shared global lexical scope whether the scripts are separate or concatenated, and
# the 3 nonce-reading scripts (colorblind/plugin-registry/plugin-sandbox) capture
# document.currentScript.nonce — so the bundle <script> carries nonce="{{CSP_NONCE}}".
# admpan.html is EXCLUDED (its ESM module graph cannot be concatenated).
BUNDLE_PAGES = (
    "index.html", "explorer.html", "viewer.html", "compare.html",
    "tracking.html", "about.html", "legal.html", "page.html", "widgets.html",
)
_SCRIPT_TAG_RE = re.compile(
    r'[ \t]*<script\b(?P<attrs>[^>]*?)\bsrc="(?P<src>[^"]+)"(?P<rest>[^>]*)>\s*</script>[ \t]*\n?',
    re.IGNORECASE,
)


def bundle_pages(by_name):
    """Rewrite each classic page to load one concatenated bundle instead of many
    <script> tags. Mutates and returns the {arcname: bytes} map. Vendor libs and
    module scripts are left untouched; a page is skipped if anything looks unsafe."""
    for page in BUNDLE_PAGES:
        html_bytes = by_name.get(page)
        if html_bytes is None:
            continue
        text = html_bytes.decode("utf-8")
        local = []   # (match, arcname) for bundle-able local scripts, in order
        for m in _SCRIPT_TAG_RE.finditer(text):
            tag = m.group(0)
            if "type=module" in tag.replace(" ", "").replace('"', "").lower():
                continue  # never concatenate ESM
            src = m.group("src")
            arc = src.split("?", 1)[0]
            if arc.startswith("js/") and not arc.startswith("js/vendor/"):
                local.append((m, arc))
        if len(local) < 3:
            continue  # not worth a bundle
        parts, ok = [], True
        for _, arc in local:
            data = by_name.get(arc)
            if data is None:
                ok = False
                break
            parts.append(("\n/* " + arc + " */\n").encode("utf-8") + data)
        if not ok:
            continue
        bundle = b"\n;\n".join(parts)
        digest8 = sha256_hex(bundle)[:10]
        bundle_arc = "js/bundle/" + page[:-5] + ".js"
        by_name[bundle_arc] = bundle
        # Rebuild the HTML: drop every bundled tag, insert one bundle tag where the
        # first bundled script was (after the vendor libs, preserving load order).
        bundle_tag = ('<script src="' + bundle_arc + "?v=" + digest8
                      + '" nonce="{{CSP_NONCE}}"></script>\n')
        pieces, idx, inserted = [], 0, False
        for m, _ in local:
            pieces.append(text[idx:m.start()])
            if not inserted:
                pieces.append(bundle_tag)
                inserted = True
            idx = m.end()
        pieces.append(text[idx:])
        by_name[page] = "".join(pieces).encode("utf-8")
        print(f"    bundled {page}: {len(local)} scripts -> 1 ({len(bundle)} bytes)")
    return by_name


def main():
    parser = argparse.ArgumentParser(description="Build the Lumen3D web release zip.")
    parser.add_argument("--version", required=True, help="platform version X.Y.Z")
    parser.add_argument("--out", required=True, help="output directory")
    parser.add_argument("--commit", default=None, help="git commit sha to record")
    parser.add_argument("--sign-seed-hex", default=None,
                        help="Ed25519 private seed (64 hex chars) to sign SHA256SUMS; "
                             "falls back to the LUMEN_SIGNING_KEY env var")
    args = parser.parse_args()

    if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
        print(f"ERROR: malformed version {args.version!r} (expected X.Y.Z)")
        return 1

    changelog = REPO_ROOT / "changelog" / f"changelog_{args.version}.md"
    if not changelog.is_file() or not changelog.read_text(encoding="utf-8").strip():
        print(f"ERROR: missing or empty changelog for {args.version}: {changelog}")
        return 1

    files = collect_files(REPO_ROOT)

    # Load every file into memory, then bundle each classic page's scripts (this
    # rewrites the page HTML and adds js/bundle/<page>.js) BEFORE hashing, so
    # version.json covers the shipped (bundled) bytes.
    by_name = {arcname: path.read_bytes() for arcname, path in files}
    bundle_pages(by_name)

    file_hashes = {arc: sha256_hex(data) for arc, data in by_name.items()}
    entries = list(by_name.items())
    entries.append(
        (
            "version.json",
            build_version_manifest(args.version, args.commit, file_hashes).encode(
                "utf-8"
            ),
        )
    )
    entries.sort(key=lambda entry: entry[0])

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    zip_name = f"lumen3d-web-{args.version}.zip"
    zip_path = out_dir / zip_name
    write_zip(zip_path, entries)

    zip_digest = sha256_hex(zip_path.read_bytes())
    sums_bytes = f"{zip_digest}  {zip_name}\n".encode("utf-8")
    sums_path = out_dir / "SHA256SUMS"
    sums_path.write_bytes(sums_bytes)

    print(f"OK: {zip_path} ({len(entries)} files, {zip_path.stat().st_size} bytes)")
    print(f"    sha256 {zip_digest}")

    # Release authenticity (L7): sign the SHA256SUMS bytes with the Ed25519 seed
    # (hex) from --sign-seed-hex or the LUMEN_SIGNING_KEY env var. The detached
    # signature (hex) is written next to the zip and uploaded as SHA256SUMS.sig; the
    # updater/install.php verify it against their pinned public key before applying.
    seed_hex = (args.sign_seed_hex or os.environ.get("LUMEN_SIGNING_KEY") or "").strip()
    if seed_hex:
        try:
            import ed25519_pure as ed
        except Exception as e:
            print(f"ERROR: cannot import ed25519_pure to sign: {e}")
            return 1
        if not re.fullmatch(r"[0-9a-fA-F]{64}", seed_hex):
            print("ERROR: signing seed must be 64 hex chars (32-byte Ed25519 seed)")
            return 1
        seed = bytes.fromhex(seed_hex)
        sig = ed.sign(seed, sums_bytes)
        (out_dir / "SHA256SUMS.sig").write_text(sig.hex() + "\n", encoding="utf-8", newline="\n")
        pub = ed.publickey(seed).hex()
        print(f"    signed SHA256SUMS (Ed25519); public key {pub}")
    else:
        print("    NOTE: no signing seed (LUMEN_SIGNING_KEY unset) — release is unsigned.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
