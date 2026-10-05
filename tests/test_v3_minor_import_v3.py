"""Browser import of format-3/4 datasets (web 1.59.0), both backends.

The pipeline (>= 0.21.0) writes format 4 directly (DOCS/dataset-migrations/SPEC.md
Part II), so the Import allowlist of upload_staging.classify_path and
api/_upload_lib.php lumen_up_classify accepts:
  * bricks/index.bin, bricks/tNNN/index.bin   (v3 binary index, magic LBIX, core tier)
  * bricks/[tNNN/]l{k}/c{c}/pNNNNN.bin        (v3 packs, tiered like v2 levels)
  * mips/[tNNN/]manifest.json, mips/[tNNN/]lNNNNN.bin  (lumen-mips-v1 / LMIP, last tier)
and validate_dataset / lumen_up_validate_dataset prove a v3 tree whole: each
index.bin is the one the manifest hashed (bytes + sha256), describes the
manifest's levels/channels/grids, and every brick it lists lies inside a pack
that arrived. The two twins are fed the same staged trees.

Run: python tests/test_v3_minor_import_v3.py
"""
import hashlib
import json
import shutil
import struct
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import upload_staging as us  # noqa: E402
from v3_minor_support import PhpTwin  # noqa: E402


def sha(b):
    return hashlib.sha256(b).hexdigest()


def index_bin(levels, channels, entries):
    """levels: [(gx, gy, gz, packs)]; entries[k][c]: [(pack, offset, length)] per brick."""
    out = struct.pack("<4sHHHH", b"LBIX", 1, len(levels), channels, 0)
    for lv in levels:
        out += struct.pack("<IIII", *lv)
    for per_level in entries:
        for per_channel in per_level:
            for e in per_channel:
                out += struct.pack("<HII", *e)
    return out


def mip_pack():
    return b"LMIP" + struct.pack("<HHHHI", 1, 1, 1, 1, 0) + struct.pack("<QI", 0, 0)


def v3_tree(prefix=""):
    """One tree: level 0 grid 2x1x1 (one brick stored, one absent), level 1 grid 1x1x1."""
    idx = index_bin([(2, 1, 1, 1), (1, 1, 1, 1)], 1,
                    [[[(0, 0, 12), (0, 0, 0)]], [[(0, 0, 8)]]])
    files = {f"bricks/{prefix}index.bin": idx,
             f"bricks/{prefix}l0/c0/p00000.bin": b"A" * 12,
             f"bricks/{prefix}l1/c0/p00000.bin": b"B" * 8}
    return files, {"bytes": len(idx), "sha256": sha(idx)}


LEVELS = [{"level": 0, "dimensions": {"x": 100, "y": 64, "z": 64}, "gridSize": {"x": 2, "y": 1, "z": 1},
           "voxelSize": {"x": 1, "y": 1, "z": 1}, "brickCount": 2},
          {"level": 1, "dimensions": {"x": 50, "y": 32, "z": 32}, "gridSize": {"x": 1, "y": 1, "z": 1},
           "voxelSize": {"x": 2, "y": 2, "z": 2}, "brickCount": 1}]


def manifest(trees):
    doc = {"schema": "iribhm-bricks-v3", "version": 3, "formatVersion": 4, "channels": 1, "brickSize": 64,
           "apron": 1, "brickPacking": {"mode": "grid", "cols": 9, "rows": 8, "slice": 66},
           "encoding": "webp-lossless", "levels": LEVELS}
    if list(trees) == [""]:
        doc["timepoints"] = None
        doc["index"] = {"url": "index.bin", **trees[""]}
    else:
        doc["timepoints"] = [{"path": k, "index": {"url": f"{k}/index.bin", **v}} for k, v in sorted(trees.items())]
    return doc


def dataset(type_dir):
    files, infos = {}, {}
    for key in ([""] if type_dir == "3d" else ["t000", "t001"]):
        f, info = v3_tree(f"{key}/" if key else "")
        files.update(f)
        infos[key] = info
    files["bricks/manifest.json"] = json.dumps(manifest(infos)).encode()
    files["metadata.json"] = json.dumps({"id": f"{type_dir}/DS", "name": "DS", "type": type_dir, "formatVersion": 4,
                                         "dimensions": {"x": 100, "y": 64, "z": 64, "c": 1},
                                         "channels": [{"name": "c0"}]}).encode()
    mprefix = "" if type_dir == "3d" else "t000/"
    files[f"mips/{mprefix}manifest.json"] = json.dumps({"schema": "lumen-mips-v1", "formatVersion": 3}).encode()
    files[f"mips/{mprefix}l00000.bin"] = mip_pack()
    return files


class ImportV3(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-impv3-"))
        us.configure(self.tmp)
        us.ensure_dirs()
        self.twin = PhpTwin(self.tmp, ["_admin_lib.php", "_upload_lib.php"])

    def tearDown(self):
        us.configure(ROOT)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def stage(self, type_dir, files):
        res = us.plan([{"type": type_dir, "folder": "DS",
                        "files": [{"path": k, "size": len(v)} for k, v in files.items()]}])
        planned = {f["path"]: f for f in res["datasets"][0]["files"]}
        self.assertEqual(res["datasets"][0]["rejected"], [])
        for rel, blob in files.items():
            st, pl = us.write_chunk(type_dir, "DS", rel, 0, blob, sha(blob), planned[rel]["fileId"])
            self.assertEqual(st, 200, (rel, pl))
            st, pl = us.finalize_file(type_dir, "DS", rel, None)
            self.assertEqual(st, 200, (rel, pl))
        return planned

    def both(self, type_dir):
        py = us.validate_dataset(type_dir, "DS")
        if not self.twin.available():
            return py, None
        (php,) = self.twin.call({"fn": "lumen_up_validate_dataset", "args": [type_dir, "DS"]})
        self.assertEqual(sorted(php["errors"]), sorted(py["errors"]), "twins disagree")
        return py, php

    def test_a_3d_v3_dataset_imports_and_validates(self):
        planned = self.stage("3d", dataset("3d"))
        tiers = {k: (v["tier"], v["kind"]) for k, v in planned.items()}
        self.assertEqual(tiers["bricks/index.bin"], (us.TIER_CORE, "index"))
        self.assertEqual(tiers["bricks/l1/c0/p00000.bin"], (us.TIER_PREVIEW, "pack"), "coarsest level first")
        self.assertEqual(tiers["bricks/l0/c0/p00000.bin"], (us.TIER_FULL, "pack"), "level 0 late")
        self.assertEqual(tiers["mips/l00000.bin"], (us.TIER_EXTRA, "mips_pack"))
        py, _ = self.both("3d")
        self.assertTrue(py["ok"], py)
        self.assertEqual(us.dataset_state("3d", "DS"), us.STATE_STAGED)

    def test_a_live_v3_dataset_validates_every_tree(self):
        self.stage("live", dataset("live"))
        py, _ = self.both("live")
        self.assertTrue(py["ok"], py)
        (us.STAGING_DIR / "live/DS/bricks/t001/l0/c0/p00000.bin").write_bytes(b"A" * 5)
        py, _ = self.both("live")
        self.assertIn("truncated_pack:t001/l0/c0/p00000.bin", py["errors"])

    def test_missing_or_truncated_packs_and_a_foreign_index_are_caught(self):
        self.stage("3d", dataset("3d"))
        ds = us.STAGING_DIR / "3d/DS"
        (ds / "bricks/l1/c0/p00000.bin").unlink()
        py, _ = self.both("3d")
        self.assertIn("missing_pack:l1/c0/p00000.bin", py["errors"])
        (ds / "bricks/l1/c0/p00000.bin").write_bytes(b"B" * 8)
        idx = bytearray((ds / "bricks/index.bin").read_bytes())
        idx[-1] ^= 1
        (ds / "bricks/index.bin").write_bytes(bytes(idx))
        py, _ = self.both("3d")
        self.assertIn("index_hash_mismatch:bricks", py["errors"])

    def test_an_index_that_disagrees_with_the_manifest_is_refused(self):
        files = dataset("3d")
        bad = index_bin([(1, 1, 1, 1), (1, 1, 1, 1)], 1, [[[(0, 0, 12)]], [[(0, 0, 8)]]])
        files["bricks/index.bin"] = bad
        man = json.loads(files["bricks/manifest.json"])
        man["index"].update(bytes=len(bad), sha256=sha(bad))
        files["bricks/manifest.json"] = json.dumps(man).encode()
        self.stage("3d", files)
        py, _ = self.both("3d")
        self.assertIn("index_grid_mismatch:bricks:l0", py["errors"])

    def test_file_level_checks_agree(self):
        ds = self.tmp / "probe"
        ds.mkdir()
        good = v3_tree()[0]["bricks/index.bin"]
        cases = {"index.bin": (good, "index"), "short.bin": (good[:-1], "index"),
                 "magic.bin": (b"XXXX" + good[4:], "index"), "mip.bin": (mip_pack(), "mips_pack"),
                 "notmip.bin": (b"LPLN" + mip_pack()[4:], "mips_pack"),
                 "mm.json": (b'{"schema": "lumen-planes-v1"}', "mips_manifest")}
        expected = {}
        for name, (blob, kind) in cases.items():
            (ds / name).write_bytes(blob)
            expected[name] = list(us._validate_file_content("3d", name, ds / name, kind))
        self.assertEqual(expected["index.bin"], [True, None])
        self.assertEqual(expected["short.bin"], [False, "index_bad_length"])
        self.assertEqual(expected["magic.bin"], [False, "index_bad_magic"])
        self.assertEqual(expected["mip.bin"], [True, None])
        self.assertEqual(expected["notmip.bin"], [False, "mips_pack_bad_magic"])
        self.assertEqual(expected["mm.json"], [False, "mips_manifest_invalid"])
        if self.twin.available():
            got = self.twin.call(*({"fn": "lumen_up_validate_file", "args": ["3d", n, str(ds / n), k]}
                                   for n, (_, k) in cases.items()))
            self.assertEqual(dict(zip(cases, got)), expected)

    def test_allowlist_parity(self):
        paths = [("3d", "bricks/index.bin"), ("live", "bricks/t000/index.bin"), ("3d", "bricks/t000/index.bin"),
                 ("3d", "bricks/l0/c0/p00000.bin"), ("3d", "bricks/l12/c3/p01234.bin"),
                 ("live", "bricks/t004/l1/c0/p00000.bin"), ("3d", "bricks/l0/c0/p0000.bin"),
                 ("3d", "bricks/l0/c0/p000000.bin"), ("3d", "bricks/l0/p00000.bin"),
                 ("3d", "mips/manifest.json"), ("3d", "mips/l00000.bin"), ("live", "mips/t001/manifest.json"),
                 ("live", "mips/t001/l00012.bin"), ("3d", "mips/t001/l00000.bin"), ("2d", "mips/manifest.json"),
                 ("3d", "mips/l0.bin"), ("3d", "mips/z00000.bin"), ("2d", "bricks/index.bin"),
                 ("3d", "bricks/lod0/c0/pack_00.bin"), ("3d", "bricks/lod0/c0/pack_00.bin\n")]
        py = [list(us.classify_path(t, r)) if us.classify_path(t, r) else None for t, r in paths]
        self.assertIsNone(py[-1], "a trailing newline is not a pack name")
        if self.twin.available():
            php = self.twin.call(*({"fn": "lumen_up_classify", "args": [t, r]} for t, r in paths))
            self.assertEqual(php, py)


if __name__ == "__main__":
    unittest.main(verbosity=2)
