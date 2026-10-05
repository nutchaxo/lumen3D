"""Shared helpers of the tests/test_v3_minor_*.py parity tests (not a test itself).

PhpTwin drives api/*.php functions through tests/v3_minor_php_driver.php against a
throwaway web root, so the Python and PHP backends can be fed the same inputs and
compared answer for answer.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DRIVER = ROOT / "tests" / "v3_minor_php_driver.php"


def _candidates():
    for cand in ("php", r"C:\php-portable\php.exe"):
        found = shutil.which(cand) or (cand if os.path.isfile(cand) else None)
        if found:
            yield found


def find_php(need_gd: bool = False):
    """(php, extra-args) or None. With need_gd, the GD extension must load (with
    WebP support), from the interpreter's own ext/ directory when php.ini does not
    enable it."""
    for exe in _candidates():
        for extra in ([], ["-d", "extension_dir=" + str(Path(exe).parent / "ext"), "-d", "extension=gd",
                           "-d", "extension=exif"]):
            probe = "echo function_exists('imagewebp') && !empty(gd_info()['WebP Support']) ? 'gd' : 'nogd';"
            try:
                r = subprocess.run([exe, *extra, "-r", probe], capture_output=True, text=True, timeout=30)
            except OSError:
                continue
            if r.returncode != 0:
                continue
            has_gd = r.stdout.strip().endswith("gd") and not r.stdout.strip().endswith("nogd")
            if not need_gd or has_gd:
                return exe, extra
        if not need_gd:
            return exe, []
    return None


class PhpTwin:
    """A throwaway web root holding copies of the PHP libraries under test."""

    def __init__(self, root: Path, libs, need_gd: bool = False):
        self.root = Path(root)
        self.libs = list(libs)
        (self.root / "api").mkdir(parents=True, exist_ok=True)
        (self.root / "changelog").mkdir(exist_ok=True)
        (self.root / "changelog" / "changelog_1.59.0.md").write_text("x")
        for lib in self.libs:
            if not lib.startswith("--"):
                shutil.copy(ROOT / "api" / lib, self.root / "api" / lib)
        self.php = find_php(need_gd)

    def available(self) -> bool:
        return self.php is not None

    def call(self, *ops, lib_order=None):
        exe, extra = self.php
        r = subprocess.run([exe, *extra, str(DRIVER), str(self.root), *(lib_order or self.libs)],
                           input=json.dumps(list(ops)), capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            raise AssertionError(f"php driver failed: {r.stdout[-2000:]} {r.stderr[-2000:]}")
        out = json.loads(r.stdout)
        for o in out:
            if "error" in o:
                raise AssertionError(f"php error: {o['error']}")
        return [o["ok"] for o in out]
