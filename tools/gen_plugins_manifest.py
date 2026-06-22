#!/usr/bin/env python3
"""
Generate js/modules/manifest.json — the static plugin-discovery fallback.
=========================================================================
The viewer auto-discovers plugins via a hybrid resolver:
    1. GET /api/plugins        (live, served by dev_server.py)
    2. GET js/modules/manifest.json   (this file)   ← static / PHP hosts
    3. embedded default list   (crash-proof floor in viewer.js)

dev_server.py rewrites manifest.json automatically on every /api/plugins hit,
so you only need this standalone script when deploying to a static host
(fast_server.py, `python -m http.server`, PHP) WITHOUT having run dev_server
first, or as a build/CI step.

Usage:
    python tools/gen_plugins_manifest.py

It scans js/modules/<placement>/<id>/plugin.json and writes the list. No
dependencies beyond the standard library; safe to re-run.
"""

import json
import re
import sys
from pathlib import Path

# tools/ sits at the repo root; ROOT is its parent.
ROOT = Path(__file__).resolve().parent.parent
MODULES_DIR = ROOT / "js" / "modules"
PLUGIN_PLACEMENTS = ("tools", "channels", "shaders")
# Same guard as dev_server.py: a single safe path component, no traversal.
_SAFE_FOLDER_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$")


def discover() -> list[dict]:
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
            except Exception as exc:
                print(f"  ! skipping {placement}/{mod_dir.name}: bad plugin.json ({exc})")
                continue
            if not isinstance(meta, dict):
                continue
            if meta.get("placement") and meta["placement"] != placement:
                print(f"  ! skipping {placement}/{mod_dir.name}: placement mismatch")
                continue
            plugins.append({
                "path": f"{placement}/{mod_dir.name}",
                "placement": placement,
                "id": meta.get("id"),
            })
    return plugins


def main() -> int:
    if not MODULES_DIR.is_dir():
        print(f"ERROR: {MODULES_DIR} not found", file=sys.stderr)
        return 1
    plugins = discover()
    out = MODULES_DIR / "manifest.json"
    out.write_text(
        json.dumps({"plugins": plugins}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"Wrote {out.relative_to(ROOT)} — {len(plugins)} plugins discovered.")
    for p in plugins:
        print(f"  · {p['path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
