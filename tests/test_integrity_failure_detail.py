"""A check-up that itself fails answers the browser with the class of the failure only.

The exception text (which names files of the host) goes to the server log; the finding the
admin shows is `check_failed` with the exception class as its detail, on both backends.

    python tests/test_integrity_failure_detail.py
"""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import dataset_integrity as di  # noqa: E402

PHP = shutil.which("php") or (r"C:\php-portable\php.exe" if os.path.exists(r"C:\php-portable\php.exe") else None)
SECRET = "/srv/private/host-path/secret.json"

PHP_DRIVER = r"""<?php
declare(strict_types=1);
define('LUMEN_INTEGRITY_TEST', true);
require_once $argv[1] . "/api/_integrity_lib.php";
// Any warning of the check becomes an exception, which is what the catch under test handles.
set_error_handler(function ($no, $str, $file, $line) { throw new ErrorException($str . ' in ' . $file, 0, $no, $file, $line); });
echo json_encode(lumen_int_handle('check', ['dataset' => '3d/X'])[1]);
"""


class IntegrityFailureDetail(unittest.TestCase):
    def test_python_keeps_the_text_in_the_log(self):
        orig = di.check_published

        def boom(t, f):
            raise OSError(f"cannot open {SECRET}")
        di.check_published = boom
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                status, payload = di.handle("check", {"dataset": "3d/X"})
        finally:
            di.check_published = orig
        self.assertEqual(status, 200)
        findings = payload["result"]["findings"]
        self.assertEqual(findings, [{"level": "error", "code": "check_failed", "detail": "OSError"}])
        self.assertNotIn(SECRET, json.dumps(payload))
        self.assertIn(SECRET, out.getvalue(), "the server log keeps the full text")

    @unittest.skipUnless(PHP, "SKIP php not found")
    def test_php_keeps_the_text_in_the_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "api").mkdir()
            for f in (ROOT / "api").glob("*.php"):
                shutil.copy(f, root / "api" / f.name)
            ds = root / "DATA_WEB" / "3d" / "X"
            ds.mkdir(parents=True)
            (ds / "metadata.json").write_text(json.dumps({"name": "X", "type": "3d", "id": "3d/X"}), encoding="utf-8")
            (root / "uploads" / "state").mkdir(parents=True)
            drv = root / "driver.php"
            drv.write_text(PHP_DRIVER)
            res = subprocess.run([PHP, str(drv), str(root)], capture_output=True, text=True, timeout=120)
            self.assertEqual(res.returncode, 0, res.stderr)
            payload = json.loads(res.stdout)
            findings = payload["result"]["findings"]
            self.assertEqual(findings, [{"level": "error", "code": "check_failed", "detail": "ErrorException"}])
            self.assertNotIn(str(root), res.stdout)
            self.assertIn(str(root), res.stderr, "the server log keeps the full text")


if __name__ == "__main__":
    unittest.main(verbosity=2)
