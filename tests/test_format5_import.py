"""Browser import of a format-5 dataset (web 1.65.0), both backends.

A dataset converted to format 5 on the operator's own machine (dataset_migrations m002 →
m005, or the pipeline's `--format 5`) is dragged into the admin Import tab like any other.
The allowlist of upload_staging.classify_path / api/_upload_lib.php lumen_up_classify
accepts every file of a v5 tree (column indexes at the core tier, packs tiered by level,
the xy / xz / yz plane stores and the cut bricks last) and nothing else under bricks/;
validate_dataset / lumen_up_validate_dataset prove the tree whole: every column and cut
index is the one the manifest hashed and describes its grids, every brick they list lies
inside a pack that arrived, every plane store is present. Both twins are fed the same
staged trees and must agree.

Run: python tests/test_format5_import.py   (numpy, Pillow; php for the twin)
"""
import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

try:
    import numpy  # noqa: F401
    import dataset_migrations as dm
    import upload_staging as us
    from test_v3_py_migrations import make_3d
    from v3_minor_support import PhpTwin
except Exception as exc:  # pragma: no cover
    print(f"SKIP: numpy/Pillow/dataset_migrations unavailable ({exc})")
    sys.exit(0)


def sha(b):
    return hashlib.sha256(b).hexdigest()


class ImportV5(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.src = Path(tempfile.mkdtemp(prefix="lumen-impv5-src-"))
        for t in ("3d", "2d", "live"):
            (cls.src / "DATA_WEB" / t).mkdir(parents=True)
        dm.configure(cls.src)
        make_3d(cls.src / "DATA_WEB", X=300, Y=140, Z=20, C=1, voxel=(0.5, 0.5, 1.6))
        ds = "3d/SYN3"
        for mid in ("m002-planes", "m003-layer-mips", "m004-bricks-v3", "m005-matrix"):
            dm.plan_job(ds, mid)
            while dm.unit_run(ds, mid, 20)["done"] < dm.plan_job(ds, mid)["total"]:
                pass
            while not dm.finalize(ds, mid).get("complete"):
                pass
        dm.configure(ROOT)
        root = cls.src / "DATA_WEB" / "3d" / "SYN3"
        cls.files = {p.relative_to(root).as_posix(): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}
        assert json.loads(cls.files["bricks/manifest.json"])["schema"] == "iribhm-bricks-v5"
        # The synthetic volume's metadata is minimal; an import wants the fields a dataset carries.
        meta = json.loads(cls.files["metadata.json"])
        meta.update({"id": "3d/DS", "name": "DS", "dimensions": {"x": 300, "y": 140, "z": 20, "c": 1},
                     "channels": [{"name": "c0"}]})
        cls.files["metadata.json"] = json.dumps(meta).encode()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.src, ignore_errors=True)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-impv5-"))
        us.configure(self.tmp)
        us.ensure_dirs()
        self.twin = PhpTwin(self.tmp, ["_admin_lib.php", "_upload_lib.php"])

    def tearDown(self):
        us.configure(ROOT)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def stage(self, files):
        res = us.plan([{"type": "3d", "folder": "DS", "files": [{"path": k, "size": len(v)} for k, v in files.items()]}])
        self.assertEqual(res["datasets"][0]["rejected"], [])
        planned = {f["path"]: f for f in res["datasets"][0]["files"]}
        for rel, blob in files.items():
            st, pl = us.write_chunk("3d", "DS", rel, 0, blob, sha(blob), planned[rel]["fileId"])
            self.assertEqual(st, 200, (rel, pl))
            st, pl = us.finalize_file("3d", "DS", rel, None)
            self.assertEqual(st, 200, (rel, pl))
        return planned

    def both(self):
        py = us.validate_dataset("3d", "DS")
        if self.twin.available():
            (php,) = self.twin.call({"fn": "lumen_up_validate_dataset", "args": ["3d", "DS"]})
            self.assertEqual(sorted(php["errors"]), sorted(py["errors"]), "twins disagree")
        return py

    def test_every_file_is_allowed_with_its_tier(self):
        paths = list(self.files)
        py = {p: us.classify_path("3d", p) for p in paths}
        self.assertTrue(all(v is not None for v in py.values()), [p for p, v in py.items() if v is None])
        self.assertEqual(py["bricks/index/q50.bin"], (us.TIER_CORE, "index"))
        self.assertEqual(py["bricks/xy/l1/z00000.bin"], (us.TIER_EXTRA, "planes_pack"))
        self.assertEqual(py["bricks/xz/l0/c0/b00000.bin"], (us.TIER_EXTRA, "orth_pack"))
        self.assertEqual(py["bricks/cuts/l0/index.bin"], (us.TIER_EXTRA, "index"))
        foreign = ["bricks/index/q70.bin", "bricks/l0/x/c0/p00000.bin", "bricks/xy/l1/z0.bin", "bricks/zx/l0/c0/b00000.bin",
                   "bricks/cuts/l0/c0/p00000.php", "bricks/cuts/index.bin", "bricks/t001/index/ll.bin"]
        for p in foreign:
            self.assertIsNone(us.classify_path("3d", p), p)
        if self.twin.available():
            got = self.twin.call(*({"fn": "lumen_up_classify", "args": ["3d", p]} for p in paths + foreign))
            self.assertEqual(got, [list(py[p]) if p in py else None for p in paths] + [None] * len(foreign))

    def test_a_v5_dataset_imports_and_validates(self):
        planned = self.stage(self.files)
        lods = {v["tier"] for k, v in planned.items() if k.startswith("bricks/l1/")}
        self.assertEqual(lods, {us.TIER_PREVIEW}, "the coarsest level opens the dataset")
        self.assertEqual({v["tier"] for k, v in planned.items() if k.startswith("bricks/l0/")}, {us.TIER_FULL})
        py = self.both()
        self.assertTrue(py["ok"], py)

    def test_missing_truncated_and_foreign_pieces_are_caught(self):
        self.stage(self.files)
        ds = us.STAGING_DIR / "3d/DS/bricks"
        pack = next(p for p in sorted(ds.glob("l1/q80/c0/*.bin")))
        data = pack.read_bytes()
        pack.write_bytes(data[:-3])
        self.assertIn(f"truncated_pack:bricks/l1/q80/c0/{pack.name}", self.both()["errors"])
        pack.write_bytes(data)
        orth = ds / "yz/l0/c0/b00001.bin"
        keep = orth.read_bytes()
        orth.unlink()
        self.assertIn("missing_store:bricks/yz/l0/c0/b00001.bin", self.both()["errors"])
        orth.write_bytes(keep)
        idx = ds / "cuts/l1/index.bin"
        raw = bytearray(idx.read_bytes())
        raw[-1] ^= 1
        idx.write_bytes(bytes(raw))
        self.assertIn("index_hash_mismatch:bricks/cuts/l1/index.bin", self.both()["errors"])

    def test_a_manifest_without_its_column_indexes_is_refused(self):
        man = json.loads(self.files["bricks/manifest.json"])
        del man["index"]["columns"]["b4"]
        ok, reason = us._validate_manifest(man)
        self.assertEqual((ok, reason), (False, "manifest_v5_bad_index"))
        man = json.loads(self.files["bricks/manifest.json"])
        man["columns"] = man["columns"][:4]
        self.assertEqual(us._validate_manifest(man), (False, "manifest_v5_bad_columns"))
        if self.twin.available():
            (got,) = self.twin.call({"fn": "lumen_up_validate_manifest", "args": [man]})
            self.assertEqual(got, [False, "manifest_v5_bad_columns"])

    def test_orth_pack_check_agrees(self):
        probe = self.tmp / "probe"
        probe.mkdir()
        good = self.files["bricks/xz/l0/c0/b00000.bin"]
        cases = {"good.bin": good, "short.bin": good[:20], "magic.bin": b"LPZZ" + good[4:]}
        want = {}
        for n, blob in cases.items():
            (probe / n).write_bytes(blob)
            want[n] = list(us._validate_file_content("3d", n, probe / n, "orth_pack"))
        self.assertEqual(want, {"good.bin": [True, None], "short.bin": [False, "orth_pack_bad_header"],
                                "magic.bin": [False, "orth_pack_bad_magic"]})
        if self.twin.available():
            got = self.twin.call(*({"fn": "lumen_up_validate_file", "args": ["3d", n, str(probe / n), "orth_pack"]} for n in cases))
            self.assertEqual(dict(zip(cases, got)), want)


if __name__ == "__main__":
    unittest.main(verbosity=2)
