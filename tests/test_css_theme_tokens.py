"""Every theme token a page uses is defined for that page (web 1.61.2).

A custom property that no stylesheet declares makes the declaration that reads it
invalid at computed-value time: `background: var(--bg-base)` painted nothing and
`color: var(--bg-base)` fell back to the inherited colour. `--bg-base` was used
that way from v1.0.0 on (viewer root, channel cards, timeline track, Studio,
About / Explorer navbar, which let the page scroll visibly under it) while no
theme ever defined it.

Pinned here, per root page (its own <link rel="stylesheet"> files, its nonce'd
<style> blocks and the operator's config/theme.css): every `var(--x)` written
WITHOUT a fallback, in those stylesheets or in an inline style="" attribute of
the page, names a property one of them declares.

PENDING lists what is still undefined today: tokens no stylesheet defines at all
("*") and tokens the admin page reads from the public stylesheets it does not load
("admpan.html"). Each entry must still be undefined where it is listed, so fixing
one fails this test until it is removed.

Run: python tests/test_css_theme_tokens.py
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PENDING = {
    "*": {"--border-light", "--border-color", "--bg-card"},
    "admpan.html": {"--text-muted", "--z-viewer-base", "--z-admin-overlay"},
}

_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_DECLARED = re.compile(r"(--[\w-]+)\s*:")
_BARE_VAR = re.compile(r"var\(\s*(--[\w-]+)\s*\)")
_LINK = re.compile(r"<link\b[^>]*\brel=[\"']stylesheet[\"'][^>]*>", re.I)
_HREF = re.compile(r"\bhref=[\"']([^\"'?#]+)", re.I)
_STYLE_BLOCK = re.compile(r"<style\b[^>]*>(.*?)</style>", re.S | re.I)
_STYLE_ATTR = re.compile(r"\sstyle=\"([^\"]*)\"", re.I)


def _strip(css):
    return _COMMENT.sub(lambda m: "\n" * m.group(0).count("\n"), css)


def _pages():
    return sorted(p for p in ROOT.glob("*.html") if not p.name.startswith("_"))


def _sources(page):
    """(label, css text) of every stylesheet the page applies, local files only."""
    html = page.read_text(encoding="utf-8")
    out = []
    for tag in _LINK.findall(html):
        m = _HREF.search(tag)
        if not m or "://" in m.group(1):
            continue
        path = ROOT / m.group(1)
        if path.is_file():
            out.append((m.group(1), _strip(path.read_text(encoding="utf-8"))))
    for i, block in enumerate(_STYLE_BLOCK.findall(html)):
        out.append((f"{page.name}<style #{i}>", _strip(block)))
    return html, out


def undefined_tokens():
    """{token: {page: [where, …]}} over every root page."""
    found = {}
    for page in _pages():
        html, sources = _sources(page)
        declared = set()
        for _, css in sources:
            declared.update(_DECLARED.findall(css))
        uses = []
        for label, css in sources:
            for n, line in enumerate(css.split("\n"), 1):
                uses += [(t, f"{label}:{n}") for t in _BARE_VAR.findall(line)]
        for n, line in enumerate(html.split("\n"), 1):
            for attr in _STYLE_ATTR.findall(line):
                uses += [(t, f"{page.name}:{n} style=\"\"") for t in _BARE_VAR.findall(attr)]
        for token, where in uses:
            if token not in declared:
                found.setdefault(token, {}).setdefault(page.name, set()).add(where)
    return {t: {pg: sorted(w) for pg, w in pages.items()} for t, pages in found.items()}


def _pending(token, page):
    return token in PENDING["*"] or token in PENDING.get(page, ())


class ThemeTokens(unittest.TestCase):
    def test_pages_have_stylesheets(self):
        for page in _pages():
            self.assertTrue(_sources(page)[1], f"{page.name}: no stylesheet found")

    def test_every_bare_token_is_defined(self):
        missing = {f"{page}: {t}": w for t, pages in undefined_tokens().items()
                   for page, w in pages.items() if not _pending(t, page)}
        self.assertEqual(missing, {}, "var() of a custom property no stylesheet of the page declares "
                         "(define it in css/themes.css for both themes, or use an existing token)")

    def test_bg_base_is_gone(self):
        self.assertNotIn("--bg-base", undefined_tokens())

    def test_pending_list_is_current(self):
        found = undefined_tokens()
        stale = sorted(f"{scope}: {t}" for scope, tokens in PENDING.items() for t in tokens
                       if t not in found or (scope != "*" and scope not in found[t]))
        self.assertEqual(stale, [], "now defined or unused: drop from PENDING")


if __name__ == "__main__":
    if "--list" in sys.argv:
        for token, pages in sorted(undefined_tokens().items()):
            for page, where in sorted(pages.items()):
                print(token, page, len(where), *where[:6])
        sys.exit(0)
    unittest.main(verbosity=1)
