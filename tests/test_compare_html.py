"""Unit tests for compare.html structural integrity (CRIT-01).

compare.html had been corrupted with a duplicated <head>/<body>/layout block and
a split (partially duplicated) <script> list. These tests assert the document is a
single, well-formed HTML document with no duplicated structure.

Run: py tests/test_compare_html.py
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, "compare.html")


class TestCompareHtmlStructure(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(HTML, encoding="utf-8") as f:
            cls.src = f.read()
        cls.low = cls.src.lower()

    def _count(self, pattern):
        return len(re.findall(pattern, self.src, re.IGNORECASE))

    def test_single_doctype(self):
        self.assertEqual(self._count(r"<!DOCTYPE"), 1)

    def test_single_head(self):
        self.assertEqual(self._count(r"<head\b"), 1, "expected exactly one <head>")
        self.assertEqual(self._count(r"</head>"), 1, "expected exactly one </head>")

    def test_single_body(self):
        self.assertEqual(self._count(r"<body\b"), 1, "expected exactly one <body>")
        self.assertEqual(self._count(r"</body>"), 1, "expected exactly one </body>")

    def test_single_html_close(self):
        self.assertEqual(self._count(r"</html>"), 1)

    def test_single_style_block(self):
        self.assertEqual(self._count(r"<style\b"), 1, "expected exactly one <style>")
        self.assertEqual(self._count(r"</style>"), 1, "expected exactly one </style>")

    def test_no_duplicate_script_srcs(self):
        srcs = re.findall(r'<script[^>]+src="([^"]+)"', self.src)
        bare = [s.split("?")[0] for s in srcs]  # ignore ?v= cache-busting query
        dupes = sorted({s for s in bare if bare.count(s) > 1})
        self.assertEqual(dupes, [], f"duplicate <script> srcs: {dupes}")

    def test_essential_scripts_present(self):
        for must in (
            "js/core/utils.js",
            "js/core/i18n.js",
            "js/core/theme.js",
            "js/core/colorblind.js",
            "js/components/studio-editor.js",
            "js/pages/compare.js",
        ):
            self.assertIn(must, self.src, f"missing required script {must}")

    def test_head_closes_before_body_opens(self):
        self.assertLess(self.low.index("</head>"), self.low.index("<body"))

    def test_no_stray_css_fragment_outside_style(self):
        # The corruption left a bare ".dataset-mini-card {" CSS rule duplicated
        # outside the single <style> block; it must appear at most once.
        self.assertLessEqual(self._count(r"\.dataset-mini-card \{"), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
