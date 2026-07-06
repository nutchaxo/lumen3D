#!/usr/bin/env python3
"""One-command marketplace publisher.

Takes a plugin folder, packages + signs it, adds/updates it in the signed
marketplace catalog, and (with --push) commits + pushes so it goes LIVE on GitHub
immediately — no other step needed.

    python tools/publish_plugin.py js/modules/tools/my-plugin            # prepare only
    python tools/publish_plugin.py path/to/my-plugin --push              # + go live
    python tools/publish_plugin.py path/to/my-plugin --recommended false --push
    python tools/publish_plugin.py --remove my-plugin --push             # unpublish

The signing seed is read from secrets/marketplace-signing-seed.hex (or the
LUMEN_SIGNING_KEY env var). The catalog's public URL base is derived from the
platform's pinned _MARKETPLACE_CATALOG_URL, so the asset URLs always match what
the running platform fetches. Ed25519 signatures are deterministic, so re-running
on an unchanged plugin produces no git change (nothing to commit — handled).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

# Windows consoles default to cp1252 and choke on the ✓/⚠ status glyphs; force UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import ed25519_pure as ed                      # noqa: E402
import tools.build_plugin_release as bpr       # noqa: E402
import dev_server                              # noqa: E402  (for the pinned catalog URL)

MARKETPLACE = REPO / "marketplace"
CATALOG = MARKETPLACE / "marketplace-catalog.json"
CATALOG_SIG = MARKETPLACE / "marketplace-catalog.json.sig"
SEED_FILE = REPO / "secrets" / "marketplace-signing-seed.hex"

# Public URL base for the plugin assets, derived from the platform's pinned catalog
# URL (…/<branch>/marketplace/marketplace-catalog.json → …/<branch>/marketplace).
_CATALOG_URL = dev_server._MARKETPLACE_CATALOG_URL
if not _CATALOG_URL:
    sys.exit("ERROR: _MARKETPLACE_CATALOG_URL is empty in dev_server.py — configure the marketplace first.")
BASE = _CATALOG_URL.rsplit("/", 1)[0]
# Branch the raw URL points at (…/<owner>/<repo>/<branch>/marketplace/…) — the push
# must target this branch so the raw URLs resolve.
try:
    _URL_BRANCH = _CATALOG_URL.split("/", 6)[5]
except Exception:
    _URL_BRANCH = None


def _seed() -> bytes:
    env = os.environ.get("LUMEN_SIGNING_KEY", "").strip()
    if env:
        return bytes.fromhex(env)
    if SEED_FILE.exists():
        return bytes.fromhex(SEED_FILE.read_text(encoding="utf-8").strip())
    sys.exit(f"ERROR: no signing seed. Set LUMEN_SIGNING_KEY or create {SEED_FILE.relative_to(REPO)}.")


def _load_catalog() -> dict:
    if CATALOG.exists():
        try:
            d = json.loads(CATALOG.read_text(encoding="utf-8"))
            if isinstance(d, dict) and isinstance(d.get("plugins"), list):
                return d
        except Exception:
            pass
    return {"version": 1, "plugins": []}


def _write_signed_catalog(cat: dict, seed: bytes) -> None:
    cat["plugins"].sort(key=lambda e: (e.get("placement", ""), e.get("id", "")))
    raw = (json.dumps(cat, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    CATALOG.write_bytes(raw)                                       # LF bytes: signed == published
    sig = ed.sign(seed, raw)
    CATALOG_SIG.write_text(sig.hex() + "\n", encoding="utf-8", newline="\n")
    if not ed.verify(ed.publickey(seed), raw, sig):
        sys.exit("ERROR: catalog self-verification failed after signing.")


def _entry(meta: dict, info: dict, recommended: bool) -> dict:
    pid = meta["id"]
    return {
        "id": pid, "name": meta.get("name", pid), "placement": meta.get("placement"),
        "subtype": meta.get("subtype"), "description": meta.get("description", ""),
        "creator": meta.get("creator"), "icon": meta.get("icon"),
        "platformCompat": meta.get("platformCompat"),
        "sandboxCapabilities": meta.get("sandboxCapabilities"),
        "latestVersion": info["version"],
        "assetUrl": f"{BASE}/plugins/{pid}/{info['zip']}",
        "sumsUrl": f"{BASE}/plugins/{pid}/SHA256SUMS",
        "sigUrl": f"{BASE}/plugins/{pid}/SHA256SUMS.sig",
        "sha256": info["sha256"],
        "recommended": recommended,
    }


def _git(*args) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(REPO), capture_output=True, text=True)


def _push(message: str) -> None:
    cur = _git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    if _URL_BRANCH and cur != _URL_BRANCH:
        print(f"⚠  current branch '{cur}' ≠ catalog URL branch '{_URL_BRANCH}'. The raw URLs "
              f"resolve on '{_URL_BRANCH}', so publishing on '{cur}' won't be live until merged.")
    _git("add", "marketplace")
    st = _git("diff", "--cached", "--quiet")
    if st.returncode == 0:
        print("• nothing changed (deterministic re-sign) — already up to date, no commit.")
        return
    c = _git("commit", "-m", message)
    if c.returncode != 0:
        sys.exit(f"ERROR: git commit failed:\n{c.stderr or c.stdout}")
    p = _git("push", "origin", cur)
    if p.returncode != 0:
        sys.exit(f"ERROR: git push failed:\n{p.stderr or p.stdout}")
    print(f"✓ pushed to origin/{cur} — LIVE at {_CATALOG_URL}")


def publish(plugin_dir: Path, recommended_arg, push: bool) -> None:
    src = plugin_dir.resolve()
    meta_path = src / "plugin.json"
    if not meta_path.is_file():
        sys.exit(f"ERROR: no plugin.json in {src}")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    pid = meta.get("id")
    if not pid:
        sys.exit("ERROR: plugin.json has no 'id'.")
    seed = _seed()

    out = MARKETPLACE / "plugins" / pid
    shutil.rmtree(out, ignore_errors=True)
    info = bpr.build(src, out, seed.hex())
    (out / "catalog-entry.json").unlink(missing_ok=True)

    cat = _load_catalog()
    existing = next((e for e in cat["plugins"] if e.get("id") == pid), None)
    if recommended_arg is not None:
        rec = recommended_arg == "true"
    elif existing is not None:
        rec = bool(existing.get("recommended", True))
    else:
        rec = True
    cat["plugins"] = [e for e in cat["plugins"] if e.get("id") != pid] + [_entry(meta, info, rec)]
    _write_signed_catalog(cat, seed)

    verb = "updated" if existing else "added"
    print(f"✓ {pid} v{info['version']} packaged + {verb} in catalog "
          f"({len(cat['plugins'])} plugins, recommended={rec})")
    if push:
        _push(f"marketplace: publish {pid} v{info['version']}")
    else:
        print("Prepared (not pushed). Re-run with --push to go live, or:\n"
              "  git add marketplace && git commit -m \"marketplace: publish " + pid + "\" && git push")


def remove(pid: str, push: bool) -> None:
    seed = _seed()
    cat = _load_catalog()
    if not any(e.get("id") == pid for e in cat["plugins"]):
        sys.exit(f"ERROR: '{pid}' is not in the catalog.")
    cat["plugins"] = [e for e in cat["plugins"] if e.get("id") != pid]
    shutil.rmtree(MARKETPLACE / "plugins" / pid, ignore_errors=True)
    _write_signed_catalog(cat, seed)
    print(f"✓ {pid} removed from catalog ({len(cat['plugins'])} plugins left)")
    if push:
        _push(f"marketplace: unpublish {pid}")
    else:
        print("Prepared (not pushed). Re-run with --push to go live.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Publish (or unpublish) a plugin to the signed marketplace.")
    ap.add_argument("plugin_dir", nargs="?", help="path to the plugin folder (contains plugin.json)")
    ap.add_argument("--remove", metavar="ID", help="unpublish a plugin by id instead of publishing")
    ap.add_argument("--recommended", choices=["true", "false"], default=None,
                    help="preselect in the first-run picker (default: keep existing / true for new)")
    ap.add_argument("--push", action="store_true", help="commit + push marketplace/ so it goes live")
    args = ap.parse_args()

    if args.remove:
        remove(args.remove, args.push)
    elif args.plugin_dir:
        publish(Path(args.plugin_dir), args.recommended, args.push)
    else:
        ap.error("provide a plugin folder to publish, or --remove <id>.")


if __name__ == "__main__":
    main()
