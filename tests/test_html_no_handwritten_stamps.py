"""No hand-written ?v= cache stamp on a local css/js URL of a source page.

Both servers send `immutable, max-age=604800` for a .js/.css request that
carries a `v` query. A stamp typed into a checkout's HTML therefore froze the
edited stylesheet or script in the browser for a week, and it propagated: the
brick loader copies its own query onto the decode worker URL and admpan.js
gives its query to every lazily imported admin tab. Releases stamp every URL
themselves (tools/build_release.py stamp_asset_versions), so the source pages
keep bare URLs.

Pinned here:
  * no root *.html references css/… or js/… with a `?v=` query;
  * stamp_asset_versions still stamps those bare URLs (and leaves js/vendor/
    alone), so a release keeps busting the cache.

Run: python tests/test_html_no_handwritten_stamps.py
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

STAMPED = re.compile(r'(?:src|href)="(?:\./)?(?:css|js)/[^"?]+\?v=[^"]*"', re.IGNORECASE)


class NoHandwrittenStamps(unittest.TestCase):
    def test_source_pages_have_bare_asset_urls(self):
        pages = sorted(ROOT.glob("*.html"))
        self.assertTrue(pages, "no root HTML page found")
        offenders = []
        for page in pages:
            text = page.read_text(encoding="utf-8")
            for line_no, line in enumerate(text.splitlines(), 1):
                for m in STAMPED.finditer(line):
                    offenders.append(f"{page.name}:{line_no}: {m.group(0)}")
        self.assertEqual(offenders, [], "hand-written ?v= stamps:\n" + "\n".join(offenders))

    def test_release_build_stamps_bare_urls(self):
        import build_release  # noqa: E402
        html = (
            '<link rel="stylesheet" href="css/viewer.css">\n'
            '<script src="js/core/brick-loader.js"></script>\n'
            '<script src="js/vendor/three.min.js" integrity="sha384-x"></script>\n'
        )
        out = build_release.stamp_asset_versions({"viewer.html": html.encode("utf-8")}, "9.9.9")
        text = out["viewer.html"].decode("utf-8")
        self.assertIn('href="css/viewer.css?v=9.9.9"', text)
        self.assertIn('src="js/core/brick-loader.js?v=9.9.9"', text)
        self.assertIn('src="js/vendor/three.min.js"', text)
        self.assertNotIn("three.min.js?v=", text)


if __name__ == "__main__":
    unittest.main()
