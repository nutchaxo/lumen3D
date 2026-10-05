"""Overwrite publish keeps what the operator curated (web 1.59.0), both backends.

Re-importing a dataset over a published one replaced metadata.json and dropped the
gallery/ folder with the old copy. Now (upload_staging.publish_dataset and
api/_upload_lib.php lumen_up_publish):
  * every key of CURATED_KEYS (the copy of preprocess/run_preprocess.py's list) the
    old metadata had and the new upload does not state is carried over;
  * a key the new upload states wins; `formatVersion` (pipeline-owned) is never
    carried over;
  * the old gallery/ folder (images + thumbs/) moves into the new dataset, and the
    gallery list keeps only entries whose file arrived;
  * the answer says what was carried (carriedKeys, carriedGallery).

Run: python tests/test_v3_minor_publish_carry.py
"""
import ast
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
import upload_staging as us  # noqa: E402
from v3_minor_support import PhpTwin  # noqa: E402

FRESH = {"id": "3d/DS", "name": "Fresh name", "type": "3d", "formatVersion": 4,
         "dimensions": {"x": 64, "y": 64, "z": 64, "c": 1}, "channels": [{"name": "c0"}]}
OLD = {"id": "3d/DS", "name": "Curated name", "type": "3d", "formatVersion": 1,
       "dimensions": {"x": 64, "y": 64, "z": 64, "c": 1}, "channels": [{"name": "c0"}],
       "orientation": [0, 0, 0.7071, 0.7071], "upsideDown": True, "notes": "lab notes",
       "relatedIds": ["3d/OTHER"], "hidden": False,
       "gallery": [{"file": "fig.png", "caption": "kept"}, {"file": "gone.png", "caption": "lost"}],
       "customBlock": {"x": 1}}
MANIFEST = {"version": 2, "brickSize": 64,
            "levels": [{"level": 0, "dimensions": {"x": 64, "y": 64, "z": 64}}],
            "brickTransport": {"brickToPack": {"b": {"url": "lod0/c0/pack_00.bin", "offset": 0, "length": 10}}}}


def sha(b):
    return hashlib.sha256(b).hexdigest()


class CarryCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-carry-"))
        us.configure(self.tmp)
        us.ensure_dirs()
        self.twin = PhpTwin(self.tmp, ["_admin_lib.php", "_upload_lib.php"])

    def tearDown(self):
        us.configure(ROOT)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def stage(self, meta):
        files = {"metadata.json": json.dumps(meta).encode(), "bricks/manifest.json": json.dumps(MANIFEST).encode(),
                 "bricks/lod0/c0/pack_00.bin": b"X" * 10, "thumbnail.webp": b"RIFF" + b"0" * 20}
        us.plan([{"type": "3d", "folder": "DS",
                  "files": [{"path": k, "size": len(v)} for k, v in files.items()]}])
        for rel, blob in files.items():
            self.assertEqual(us.write_chunk("3d", "DS", rel, 0, blob, sha(blob))[0], 200)
            self.assertEqual(us.finalize_file("3d", "DS", rel, None)[0], 200)

    def publish_old(self):
        live = self.tmp / "DATA_WEB/3d/DS"
        (live / "gallery/thumbs").mkdir(parents=True)
        (live / "metadata.json").write_text(json.dumps(OLD))
        (live / "gallery/fig.png").write_bytes(b"\x89PNG\r\n\x1a\nfig")
        (live / "gallery/thumbs/fig.png.webp").write_bytes(b"RIFF....WEBP")
        return live

    def check(self, status, payload, live):
        self.assertEqual(status, 200, payload)
        meta = json.loads((live / "metadata.json").read_text())
        self.assertEqual(meta["name"], "Fresh name", "a key the upload states wins")
        self.assertEqual(meta["formatVersion"], 4, "formatVersion is pipeline-owned, never carried")
        self.assertEqual(meta["orientation"], OLD["orientation"])
        self.assertIs(meta["upsideDown"], True)
        self.assertEqual(meta["notes"], "lab notes")
        self.assertEqual(meta["relatedIds"], ["3d/OTHER"])
        self.assertIs(meta["hidden"], True, "the publish flag still decides visibility")
        self.assertEqual(meta["gallery"], [{"file": "fig.png", "caption": "kept"}],
                         "an entry whose file is not there is dropped")
        self.assertNotIn("customBlock", meta, "only curated keys travel")
        self.assertEqual((live / "gallery/fig.png").read_bytes(), b"\x89PNG\r\n\x1a\nfig")
        self.assertTrue((live / "gallery/thumbs/fig.png.webp").is_file())
        self.assertEqual((live / "bricks/lod0/c0/pack_00.bin").read_bytes(), b"X" * 10)
        self.assertTrue(payload["carriedGallery"])
        self.assertEqual(set(payload["carriedKeys"]),
                         {"orientation", "upsideDown", "notes", "relatedIds", "hidden", "gallery"})
        leftovers = [p.name for p in (self.tmp / "DATA_WEB/3d").iterdir() if p.name.startswith(".")]
        self.assertEqual(leftovers, [])

    def test_python_publish_carries_curated_data(self):
        self.stage(FRESH)
        live = self.publish_old()
        st, pl = us.publish_dataset("3d", "DS", overwrite=True, hidden=True)
        self.check(st, pl, live)

    def test_php_publish_carries_curated_data(self):
        if not self.twin.available():
            self.skipTest("no php interpreter")
        self.stage(FRESH)
        live = self.publish_old()
        ((st, pl),) = self.twin.call({"fn": "lumen_up_publish", "args": ["3d", "DS", True, True]})
        self.check(st, pl, live)

    def test_a_first_publish_carries_nothing(self):
        self.stage(FRESH)
        st, pl = us.publish_dataset("3d", "DS", overwrite=False, hidden=True)
        self.assertEqual(st, 200, pl)
        self.assertEqual(pl["carriedKeys"], [])
        self.assertFalse(pl["carriedGallery"])

    def test_the_curated_key_list_matches_the_pipeline(self):
        tree = ast.parse((ROOT / "preprocess" / "run_preprocess.py").read_text(encoding="utf-8"))
        pipeline = next(ast.literal_eval(n.value) for n in tree.body
                        if isinstance(n, ast.Assign) and any(getattr(t, "id", "") == "CURATED_KEYS" for t in n.targets))
        self.assertEqual(tuple(us.CURATED_KEYS), tuple(pipeline))
        self.assertNotIn("formatVersion", us.CURATED_KEYS)
        if self.twin.available():
            (php,) = self.twin.call({"fn": "constant", "args": ["LUMEN_UP_CURATED_KEYS"]})
            self.assertEqual(tuple(php), tuple(pipeline))


if __name__ == "__main__":
    unittest.main(verbosity=2)
