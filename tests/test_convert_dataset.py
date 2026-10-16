"""tools/convert_dataset.py — a format-1 dataset taken to the latest format on this machine.

A synthetic two-channel volume published as format 1 (v2 bricks only) goes through
m002 → m005 with the Python server executor in one command; it ends at format 5 with a
complete v5 tree, and a second run has nothing to do. `--to 4` stops before m005.

Run: python tests/test_convert_dataset.py
"""
import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "tools"))

try:
    import numpy  # noqa: F401
    import dataset_migrations as dm
    import format5 as f5
    import convert_dataset as cd
    from test_v3_py_migrations import make_3d
except Exception as exc:  # pragma: no cover
    print(f"SKIP: numpy/Pillow unavailable ({exc})")
    sys.exit(0)


class ConvertDataset(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-convert-"))
        for t in ("3d", "2d", "live"):
            (self.tmp / "DATA_WEB" / t).mkdir(parents=True)
        self.ds, _ = make_3d(self.tmp / "DATA_WEB", X=280, Y=120, Z=20, C=2)

    def tearDown(self):
        dm.configure(ROOT)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_cli(self, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            code = cd.main([str(self.ds), "--workers", "2", *args])
        return code, out.getvalue()

    def fv(self):
        return json.loads((self.ds / "metadata.json").read_text(encoding="utf-8")).get("formatVersion")

    def test_to_latest_then_nothing_to_do(self):
        code, out = self.run_cli()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.fv(), 5)
        self.assertIsNone(f5.bricks_problem(self.ds))
        for mid in ("m002-planes", "m003-layer-mips", "m004-bricks-v3", "m005-matrix"):
            self.assertIn(f"{mid}: done", out)
        self.assertFalse((self.tmp / "uploads" / "migrations" / "3d__SYN3__m005-matrix.json").exists())
        code, out = self.run_cli()
        self.assertEqual(code, 0)
        self.assertIn("pending: nothing", out)

    def test_stop_at_format_4(self):
        code, out = self.run_cli("--to", "4")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.fv(), 4)
        self.assertNotIn("m005-matrix: done", out)
        code, out = self.run_cli("--list")
        self.assertIn("pending: m005-matrix", out)

    def test_refuses_a_folder_outside_a_deployment(self):
        stray = self.tmp / "loose" / "X"
        stray.mkdir(parents=True)
        (stray / "metadata.json").write_text("{}", encoding="utf-8")
        err = io.StringIO()
        from contextlib import redirect_stderr
        with redirect_stderr(err):
            self.assertEqual(cd.main([str(stray)]), 2)
        self.assertIn("3d/", err.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
