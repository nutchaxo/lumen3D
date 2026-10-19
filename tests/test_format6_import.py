"""Browser import of a format-6 dataset (SPEC §15.2), both backends.

A dataset converted to format 6 (m002 → m006 here, or the pipeline's `--format 6`) is dragged
into the admin Import tab like any other. The allowlist of upload_staging.classify_path /
api/_upload_lib.php lumen_up_classify takes every file of a matrix tree (any matrix column,
q30 included: one path does not say which format its tree has), and validate_dataset /
lumen_up_validate_dataset prove the tree whole against its manifest's format:

* a v6 tree uploads (the coarsest level's packs at the preview tier) and validates;
* a v6 tree holding a b2 pack or a b2 index, and a v5 tree holding a q30 pack or index, are
  refused (`foreign_column:…`);
* a v6 manifest whose `columns` list is not exactly [ll, q30], whose index names a format-5
  column, or whose version is not 6, is refused (`manifest_v6_bad_columns`, `…_bad_index`,
  `…_bad_version`), already when the manifest file is uploaded; a v5 manifest keeps the five columns (`manifest_v5_bad_columns`).

Both twins are fed the same staged trees and must agree.

Run: python tests/test_format6_import.py   (numpy, Pillow; php for the twin)
"""
import copy
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

CHAIN = ("m002-planes", "m003-layer-mips", "m004-bricks-v3", "m005-matrix")


def sha(b):
    return hashlib.sha256(b).hexdigest()


def run(ds, mid):
    dm.plan_job(ds, mid)
    while dm.unit_run(ds, mid, 20)["done"] < dm.plan_job(ds, mid)["total"]:
        pass
    while not dm.finalize(ds, mid).get("complete"):
        pass


def snapshot(root: Path) -> dict:
    files = {p.relative_to(root).as_posix(): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}
    meta = json.loads(files["metadata.json"])
    meta.update({"id": "3d/DS", "name": "DS", "dimensions": {"x": 300, "y": 140, "z": 20, "c": 1},
                 "channels": [{"name": "c0"}]})
    files["metadata.json"] = json.dumps(meta).encode()
    return files


class ImportV6(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.src = Path(tempfile.mkdtemp(prefix="lumen-impv6-src-"))
        for t in ("3d", "2d", "live"):
            (cls.src / "DATA_WEB" / t).mkdir(parents=True)
        dm.configure(cls.src)
        make_3d(cls.src / "DATA_WEB", X=300, Y=140, Z=20, C=1, voxel=(0.5, 0.5, 1.6))
        ds = "3d/SYN3"
        for mid in CHAIN:
            run(ds, mid)
        root = cls.src / "DATA_WEB" / "3d" / "SYN3"
        cls.v5 = snapshot(root)
        run(ds, "m006-q30")
        dm.configure(ROOT)
        cls.v6 = snapshot(root)
        assert json.loads(cls.v5["bricks/manifest.json"])["schema"] == "iribhm-bricks-v5"
        assert json.loads(cls.v6["bricks/manifest.json"])["schema"] == "iribhm-bricks-v6"

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.src, ignore_errors=True)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-impv6-"))
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
            self.assertEqual(php["ok"], py["ok"])
        return py

    def manifest_both(self, man):
        py = list(us._validate_manifest(man))
        if self.twin.available():
            (got,) = self.twin.call({"fn": "lumen_up_validate_manifest", "args": [man]})
            self.assertEqual(got, py, "twins disagree")
        return py

    def test_every_v6_file_is_allowed_with_its_tier(self):
        paths = list(self.v6)
        py = {p: us.classify_path("3d", p) for p in paths}
        self.assertTrue(all(v is not None for v in py.values()), [p for p, v in py.items() if v is None])
        self.assertEqual(py["bricks/index/q30.bin"], (us.TIER_CORE, "index"))
        self.assertTrue(any(p.startswith("bricks/l0/q30/") for p in paths))
        self.assertFalse([p for p in paths if "/b2/" in p or "/q80/" in p or p.endswith("/b4.bin")])
        foreign = ["bricks/index/q31.bin", "bricks/l0/q3/c0/p00000.bin", "bricks/l0/q30/c0/p0.bin",
                   "bricks/l0/q30/p00000.bin", "bricks/t001/index/q30.bin", "bricks/l0/q30/c0/p00000.php"]
        for p in foreign:
            self.assertIsNone(us.classify_path("3d", p), p)
        if self.twin.available():
            got = self.twin.call(*({"fn": "lumen_up_classify", "args": ["3d", p]} for p in paths + foreign))
            self.assertEqual(got, [list(py[p]) for p in paths] + [None] * len(foreign))

    def test_a_v6_dataset_imports_and_validates(self):
        planned = self.stage(self.v6)
        self.assertEqual({v["tier"] for k, v in planned.items() if k.startswith("bricks/l1/")}, {us.TIER_PREVIEW},
                         "the coarsest level opens the dataset")
        self.assertEqual({v["tier"] for k, v in planned.items() if k.startswith("bricks/l0/")}, {us.TIER_FULL})
        py = self.both()
        self.assertTrue(py["ok"], py)

    def test_a_format5_column_in_a_v6_tree_is_refused(self):
        b2 = {k: v for k, v in self.v5.items() if k.startswith("bricks/l0/b2/")}
        self.assertTrue(b2)
        files = dict(self.v6, **b2, **{"bricks/index/b2.bin": self.v5["bricks/index/b2.bin"]})
        self.stage(files)
        py = self.both()
        self.assertFalse(py["ok"])
        self.assertIn("foreign_column:bricks/l0/b2", py["errors"])
        self.assertIn("foreign_column:bricks/index/b2.bin", py["errors"])

    def test_a_q30_column_in_a_v5_tree_is_refused(self):
        q30 = {k: v for k, v in self.v6.items() if k.startswith("bricks/l1/q30/")}
        self.assertTrue(q30)
        self.stage(dict(self.v5, **q30))
        py = self.both()
        self.assertEqual(py["errors"], ["foreign_column:bricks/l1/q30"])
        # The same v5 tree without it is valid.
        shutil.rmtree(us.STAGING_DIR / "3d/DS/bricks/l1/q30")
        self.assertEqual(self.both()["errors"], [])

    def test_manifests_with_the_wrong_columns_are_refused(self):
        man6 = json.loads(self.v6["bricks/manifest.json"])
        man5 = json.loads(self.v5["bricks/manifest.json"])
        self.assertEqual(self.manifest_both(man6), [True, None])
        self.assertEqual(self.manifest_both(man5), [True, None])
        bad = copy.deepcopy(man6)
        bad["columns"] = man5["columns"]
        self.assertEqual(self.manifest_both(bad), [False, "manifest_v6_bad_columns"])
        bad = copy.deepcopy(man6)
        bad["columns"] = bad["columns"][::-1]
        self.assertEqual(self.manifest_both(bad), [False, "manifest_v6_bad_columns"])
        bad = copy.deepcopy(man6)
        bad["columns"].append(man5["columns"][1])
        self.assertEqual(self.manifest_both(bad), [False, "manifest_v6_bad_columns"])
        bad = copy.deepcopy(man6)
        bad["index"]["columns"]["b2"] = man5["index"]["columns"]["b2"]
        self.assertEqual(self.manifest_both(bad), [False, "manifest_v6_bad_index"])
        bad = copy.deepcopy(man6)
        bad["version"] = 5
        self.assertEqual(self.manifest_both(bad), [False, "manifest_v6_bad_version"])
        bad = copy.deepcopy(man5)
        bad["columns"] = man6["columns"]
        self.assertEqual(self.manifest_both(bad), [False, "manifest_v5_bad_columns"])
        bad = copy.deepcopy(man6)
        bad["columns"] = man5["columns"]
        # The same refusal when the manifest file itself arrives (its upload is refused).
        probe = self.tmp / "probe.json"
        probe.write_bytes(json.dumps(bad).encode())
        want = list(us._validate_file_content("3d", "bricks/manifest.json", probe, "manifest"))
        self.assertEqual(want, [False, "manifest_v6_bad_columns"])
        if self.twin.available():
            (got,) = self.twin.call({"fn": "lumen_up_validate_file", "args": ["3d", "bricks/manifest.json", str(probe), "manifest"]})
            self.assertEqual(got, want)

if __name__ == "__main__":
    unittest.main(verbosity=2)
