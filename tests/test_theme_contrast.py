"""Filled-button contrast of an operator theme (web 1.59.4), three twins.

A filled button carries white text on --color-primary-strong. The stylesheet
derives that colour with a fixed color-mix (77 % of the primary over black),
which left white text under WCAG AA (4.5:1) for a bright primary: the wizard's
orange (#FF7A2F) gave about 4.2:1, its turquoise (#0FC5A8) about 3.6:1. The
theme compiler now writes the pair explicitly, darkened until it passes.

Pinned here:
  * dev_server.py _theme_strong_pair, api/site.php site_theme_strong_pair and
    js/pages/admin/theme-contrast.js strongPair return the same bytes for the
    wizard presets and for a few hundred random colours;
  * white on strong is >= 4.5:1, white on hover is >= strong's contrast;
  * a colour that already passes at 77 % is not darkened further;
  * the compiled theme.css carries the pair (Python and PHP, byte-identical) and
    an unparseable primary leaves the CSS fallback alone.

Run: python tests/test_theme_contrast.py
"""
import json
import random
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import dev_server as ds  # noqa: E402

PRESETS = ["#00A654", "#2F6BFF", "#7C5CFF", "#0FC5A8", "#FF7A2F", "#E5484D"]
rng = random.Random(1594)
COLOURS = PRESETS + ["#fff", "#000000", "rgb(255, 122, 47)", "rgba(15,197,168,0.5)", "red", "", "#12345"] + [
    "#%02X%02X%02X" % (rng.randrange(256), rng.randrange(256), rng.randrange(256)) for _ in range(300)]

PHP = shutil.which("php")
NODE = shutil.which("node")


def php_eval(code: str) -> str:
    prog = ("define('LUMEN_SITE_LIB', true); require " + json.dumps(str(ROOT / "api" / "site.php")) + ";\n" + code)
    return subprocess.run([PHP, "-r", prog], capture_output=True, text=True, check=True).stdout


class StrongPair(unittest.TestCase):
    def test_aa_on_every_colour(self):
        for c in COLOURS:
            pair = ds._theme_strong_pair(c)
            rgb = ds._theme_parse_rgb(c)
            if rgb is None:
                self.assertIsNone(pair, c)
                continue
            strong, hover = (ds._theme_parse_rgb(x) for x in pair)
            self.assertGreaterEqual(ds._contrast_on_white(strong), 4.5, c)
            self.assertGreaterEqual(ds._contrast_on_white(hover), ds._contrast_on_white(strong), c)

    def test_presets_that_failed_now_pass(self):
        for c in ("#FF7A2F", "#0FC5A8"):
            fixed77 = ds._theme_scale(ds._theme_parse_rgb(c), 77)
            self.assertLess(ds._contrast_on_white(fixed77), 4.5, f"{c} was under AA at 77 %")
            self.assertGreaterEqual(ds._contrast_on_white(ds._theme_parse_rgb(ds._theme_strong_pair(c)[0])), 4.5)

    def test_not_darker_than_needed(self):
        # Blue already passes at 77 %: kept exactly there.
        self.assertEqual(ds._theme_strong_pair("#2F6BFF")[0], "#%02X%02X%02X" % ds._theme_scale((0x2F, 0x6B, 0xFF), 77))

    def test_compiled_css(self):
        css = ds._generate_theme_css({"tokens": {"--color-primary": "#FF7A2F"}})
        strong, hover = ds._theme_strong_pair("#FF7A2F")
        self.assertIn(f"--color-primary-strong:{strong}", css)
        self.assertIn(f"--color-primary-strong-hover:{hover}", css)
        self.assertNotIn("primary-strong", ds._generate_theme_css({"tokens": {"--color-primary": "var(--x)"}}))
        self.assertNotIn("primary-strong", ds._generate_theme_css({"tokens": {}}))


@unittest.skipUnless(PHP, "php not found")
class PhpTwin(unittest.TestCase):
    def test_same_pairs(self):
        got = json.loads(php_eval(
            "$out = []; foreach (json_decode(" + json.dumps(json.dumps(COLOURS)) + ", true) as $c) "
            "$out[] = site_theme_strong_pair($c); echo json_encode($out);"))
        self.assertEqual(got, [list(p) if p else None for p in (ds._theme_strong_pair(c) for c in COLOURS)])

    def test_same_css(self):
        for theme in ({"tokens": {"--color-primary": "#0FC5A8", "--color-accent": "#2FE0FF"}},
                      {"tokens": {"--color-primary-strong": "#123456", "--color-primary": "#FF7A2F"},
                       "dark": {"--bg-base": "#000"}},
                      {"tokens": {"--color-primary": "nope"}}, {}):
            php = php_eval("echo site_generate_theme_css(json_decode(" + json.dumps(json.dumps(theme)) + ", true));")
            self.assertEqual(php, ds._generate_theme_css(theme), theme)


@unittest.skipUnless(NODE, "node not found")
class JsTwin(unittest.TestCase):
    def test_same_pairs(self):
        mod = (ROOT / "js" / "pages" / "admin" / "theme-contrast.js").as_uri()
        prog = (f"const m = await import({json.dumps(mod)});"
                f"console.log(JSON.stringify({json.dumps(COLOURS)}.map((c) => m.strongPair(c))));")
        out = subprocess.run([NODE, "--input-type=module", "-e", prog], capture_output=True, text=True, check=True).stdout
        self.assertEqual(json.loads(out), [list(p) if p else None for p in (ds._theme_strong_pair(c) for c in COLOURS)])


if __name__ == "__main__":
    unittest.main(verbosity=1)
