"""The vendor libraries (lucide, three.js) load at the end of <body>, not in <head>.

A classic script in <head> holds the first paint until it has been downloaded and
run (three.min.js + lucide.min.js are ~920 KB on the viewer). Nothing reads `lucide`
or `THREE` before the page's own scripts, so each page loads them right before its
first local script, without defer/async (a deferred script runs after the classic
body scripts that need it). The release bundler puts the bundle where the first
local script was, so this order also holds in a release.

Run: python tests/test_vendor_scripts_in_body.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = ("index.html", "explorer.html", "viewer.html", "compare.html", "2d.html",
         "about.html", "legal.html", "page.html")
SCRIPT_RE = re.compile(r'<script\b([^>]*)\bsrc="([^"]+)"([^>]*)>', re.IGNORECASE)


def check(page):
    with open(os.path.join(ROOT, page), encoding="utf-8") as fh:
        text = fh.read()
    head_end = text.index("</head>")
    head, body = text[:head_end], text[head_end:]
    head_scripts = [m.group(2) for m in SCRIPT_RE.finditer(head)]
    assert head_scripts == ["js/core/theme-boot.js"], f"{page}: <head> scripts {head_scripts}"
    scripts = [(m.group(2), m.group(0)) for m in SCRIPT_RE.finditer(body)]
    srcs = [s for s, _ in scripts]
    vendor = [i for i, s in enumerate(srcs) if s.startswith("js/vendor/")]
    assert vendor, f"{page}: no vendor script in <body>"
    assert "js/vendor/lucide.min.js" in srcs, f"{page}: lucide missing"
    first_local = next(i for i, s in enumerate(srcs) if s.startswith("js/") and not s.startswith("js/vendor/"))
    assert max(vendor) < first_local, f"{page}: a vendor script comes after a local one"
    assert vendor == list(range(len(vendor))), f"{page}: vendor scripts are not grouped first"
    for i in vendor:
        tag = scripts[i][1]
        assert 'integrity="sha384-' in tag and 'crossorigin="anonymous"' in tag, f"{page}: SRI lost on {srcs[i]}"
        assert not re.search(r"\b(defer|async)\b", tag), f"{page}: {srcs[i]} must not be deferred"
    if page == "viewer.html":
        assert srcs[:2] == ["js/vendor/lucide.min.js", "js/vendor/three.min.js"], srcs[:2]


def main():
    for page in PAGES:
        check(page)
    print(f"vendor scripts at the end of <body> on {len(PAGES)} pages: OK")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        print("FAIL:", exc)
        sys.exit(1)
