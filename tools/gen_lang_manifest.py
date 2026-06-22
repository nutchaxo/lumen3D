#!/usr/bin/env python3
"""
Generate lang/manifest.json — the static language-discovery fallback.
=====================================================================
The platform auto-discovers its available locales via a hybrid resolver
(mirrors plugin discovery):
    1. GET /api/languages       (live, served by dev_server.py)
    2. GET lang/manifest.json   (this file)   ← static / PHP hosts
    3. embedded default ['en','fr','es']       (crash-proof floor in i18n.js)

dev_server.py rewrites manifest.json automatically on every /api/languages
hit, so you only need this standalone script when deploying to a static host
WITHOUT having run dev_server first, or as a build/CI step.

Usage:
    python tools/gen_lang_manifest.py

It scans lang/<code>.json and writes the list. 'en' is always first (the
fallback locale). No dependencies beyond the standard library.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LANG_DIR = ROOT / "lang"
_LANG_CODE_RE = re.compile(r"^[a-z]{2,3}(-[A-Za-z]{2,4})?$")


def discover() -> list[str]:
    codes = set()
    if LANG_DIR.is_dir():
        for f in LANG_DIR.glob("*.json"):
            if f.stem == "manifest":
                continue
            if _LANG_CODE_RE.match(f.stem):
                codes.add(f.stem)
    codes.add("en")
    return ["en", *sorted(c for c in codes if c != "en")]


def main() -> int:
    codes = discover()
    out = LANG_DIR / "manifest.json"
    out.write_text(json.dumps({"languages": codes}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {out.relative_to(ROOT)} with {len(codes)} locale(s): {', '.join(codes)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
