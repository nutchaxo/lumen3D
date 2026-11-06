"""A confirmed Ctrl+C cleans up the interrupted dataset's working tree, and only it.

Two pipeline runs may write into the same DATA_WEB (different --only filters). Stopping one
must not delete the other's `.temp_preprocess_<name>` tree under it.

Run: python tests/test_preprocess_interrupt_cleanup.py
"""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
PRE = ROOT / "preprocess"


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(PRE / filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RUN = _load("lumen_test_interrupt_run", "run_preprocess.py")


class InterruptCleanup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.raw = base / "raw"
        self.raw.mkdir()
        self.out = base / "DATA_WEB"
        self.out.mkdir()
        (self.raw / "Embryo A.ims").write_bytes(b"")

    def tearDown(self):
        self.tmp.cleanup()

    def test_only_the_interrupted_dataset_tree_is_removed(self):
        foreign = self.out / ".temp_preprocess_other-run"
        (foreign / "stage").mkdir(parents=True)
        (foreign / "stage" / "t000_c0_lod0.bin").write_bytes(b"\0" * 16)
        own = RUN.temp_dir_for(self.out, self.raw / "Embryo A.ims")

        def interrupted_run(ims_path, output_root, *args, **kwargs):
            # What a killed worker leaves behind when process_ims_file's own cleanup
            # could not take a file it still held open.
            tree = RUN.temp_dir_for(output_root, ims_path)
            tree.mkdir(parents=True)
            (tree / "left.bin").write_bytes(b"x")
            raise KeyboardInterrupt

        argv = ["run_preprocess.py", "--input", str(self.raw), "--output", str(self.out),
                "--tracking", "off"]
        with mock.patch.object(RUN, "process_ims_file", interrupted_run), \
                mock.patch.object(RUN, "_install_sigint_handler", lambda: None), \
                mock.patch.object(sys, "argv", argv):
            with self.assertRaises(SystemExit) as stop:
                RUN.main()
        self.assertEqual(stop.exception.code, 130)
        self.assertFalse(own.exists())
        self.assertTrue((foreign / "stage" / "t000_c0_lod0.bin").is_file())

    def test_temp_dir_name_follows_the_source_file(self):
        self.assertEqual(RUN.temp_dir_for(self.out, Path("x/Embryo A.ims")).parent, self.out)
        self.assertTrue(RUN.temp_dir_for(self.out, Path("x/Embryo A.ims")).name
                        .startswith(".temp_preprocess_"))
        self.assertNotEqual(RUN.temp_dir_for(self.out, Path("a.ims")),
                            RUN.temp_dir_for(self.out, Path("b.ims")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
