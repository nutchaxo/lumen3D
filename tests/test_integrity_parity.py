"""Data integrity check-up: the Python engine (dataset_integrity.py) and its PHP twin
(api/_integrity_lib.php) must give the same verdict — status and finding codes — on the
same tree, and each finding the fixtures are built to trigger must be reported.

    python tests/test_integrity_parity.py
"""
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
import dataset_migrations as dm  # noqa: E402

PHP = shutil.which("php") or (r"C:\php-portable\php.exe" if os.path.exists(r"C:\php-portable\php.exe") else None)

PHOTO = {"name": "Photo", "type": "2d", "id": "2d/Photo", "dimensions": {"x": 4, "y": 3, "z": 1, "c": 1},
         "image": {"native": "image.webp", "preview": "preview.webp", "width": 4, "height": 3}}


def _put(path: Path, data=b"x"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else json.dumps(data).encode())


def build(web: Path):
    good = web / "2d" / "Good"
    _put(good / "metadata.json", dict(PHOTO, id="2d/Good", name="Good", gallery=[{"file": "a.png", "caption": ""}]))
    for n in ("image.webp", "preview.webp", "thumbnail.webp"):
        _put(good / n)
    _put(good / "gallery" / "a.png")

    bad = web / "2d" / "Bad"
    _put(bad / "metadata.json", dict(PHOTO, id="2d/Other", gallery=[{"file": "missing.png", "caption": ""}]))
    _put(bad / "preview.webp")
    _put(bad / "gallery" / "extra.png")
    _put(bad / "thumbnail.webp.pre-swap")

    (web / "3d" / "NoMeta").mkdir(parents=True)
    _put(web / "3d" / "Torn" / "metadata.json", "{not json")


def py_report(web: Path):
    dm.configure(ROOT, data_web=web, uploads_dir=web.parent / "uploads")
    out = {}
    for x in di.list_datasets()["datasets"]:
        r = di.handle("check", {"dataset": x["id"]})[1]["result"]
        out[r["id"]] = (r["status"], sorted(f["code"] for f in r["findings"]))
    return out


PHP_DRIVER = r"""<?php
declare(strict_types=1);
$root = $argv[1];
define('LUMEN_INTEGRITY_TEST', true);
require_once "$root/api/_integrity_lib.php";
$out = [];
foreach (lumen_int_list()['datasets'] as $d) {
    $r = lumen_int_handle('check', ['dataset' => $d['id']])[1]['result'];
    $codes = array_column($r['findings'], 'code'); sort($codes);
    $out[$r['id']] = [$r['status'], $codes];
}
echo json_encode($out);
"""


@unittest.skipUnless(PHP, "php not available")
class IntegrityParity(unittest.TestCase):
    def test_same_verdicts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            web = root / "DATA_WEB"
            (root / "uploads" / "state").mkdir(parents=True)
            build(web)
            (root / "api").mkdir()
            for f in (ROOT / "api").glob("*.php"):
                shutil.copy(f, root / "api" / f.name)
            drv = root / "driver.php"
            drv.write_text(PHP_DRIVER)
            res = subprocess.run([PHP, str(drv), str(root)], capture_output=True, text=True, timeout=120)
            self.assertEqual(res.returncode, 0, res.stderr + res.stdout[-500:])
            php = {k: (v[0], v[1]) for k, v in json.loads(res.stdout).items()}
            py = py_report(web)
            self.assertEqual(py, php)

            self.assertEqual(py["2d/Good"], ("ok", []))
            status, codes = py["2d/Bad"]
            self.assertEqual(status, "error")
            for expected in ("metadata_identity", "gallery_missing", "gallery_unlisted", "missing_thumbnail",
                             "interrupted_swap", "missing_image"):
                self.assertIn(expected, codes)
            self.assertIn("missing_metadata", py["3d/NoMeta"][1])
            self.assertIn("metadata_not_json", py["3d/Torn"][1])


if __name__ == "__main__":
    unittest.main()
