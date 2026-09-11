"""Unit tests for the per-dataset image gallery (web v1.45.0).

Covers the storage engine in dev_server.py: what is accepted onto disk, what the
`file` field is allowed to look like (it becomes a URL in the viewer), and the
reconciliation that keeps metadata.json honest against the gallery/ folder.

Run: py tests/test_dataset_gallery.py
"""
import base64
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import dev_server  # noqa: E402

PNG = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 40
JPEG = b"\xff\xd8\xff" + b"\x00" * 40
GIF = b"GIF89a" + b"\x00" * 40
WEBP = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 40


def durl(raw: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64," + base64.b64encode(raw).decode()


class GalleryCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._orig_root = dev_server.DATA_WEB
        dev_server.DATA_WEB = self.tmp
        self.ds_dir = self.tmp / "3d" / "demo"
        self.ds_dir.mkdir(parents=True)
        self._write_meta({"name": "Demo", "type": "3d"})

    def tearDown(self):
        dev_server.DATA_WEB = self._orig_root
        shutil.rmtree(self.tmp, ignore_errors=True)

    # helpers
    def _write_meta(self, doc):
        (self.ds_dir / "metadata.json").write_text(json.dumps(doc), encoding="utf-8")

    def _meta(self):
        return json.loads((self.ds_dir / "metadata.json").read_text(encoding="utf-8"))

    def _add(self, raw=PNG, name="shot.png", **kw):
        body = {"image": durl(raw), "filename": name}
        body.update(kw)
        return dev_server._gallery_add("3d/demo", body)

    def _files(self):
        gdir = self.ds_dir / "gallery"
        return sorted(p.name for p in gdir.iterdir()) if gdir.is_dir() else []


class TestUpload(GalleryCase):
    def test_writes_file_and_records_entry(self):
        status, payload = self._add(caption="Vue sagittale")
        self.assertEqual(status, 200)
        self.assertEqual(self._files(), ["shot.png"])
        entry = self._meta()["gallery"][0]
        self.assertEqual(entry["file"], "shot.png")
        self.assertEqual(entry["caption"], "Vue sagittale")
        self.assertEqual(payload["url"], "DATA_WEB/3d/demo/gallery/shot.png")

    def test_every_supported_format_is_accepted(self):
        for raw, ext in ((PNG, "png"), (JPEG, "jpg"), (GIF, "gif"), (WEBP, "webp")):
            status, _ = self._add(raw, name=f"f-{ext}.bin")
            self.assertEqual(status, 200, ext)
        self.assertEqual(len(self._files()), 4)

    def test_extension_comes_from_magic_bytes_not_the_filename(self):
        # A JPEG announced as .png must land as .jpg: the name never decides the type.
        status, payload = self._add(JPEG, name="liar.png")
        self.assertEqual(status, 200)
        self.assertEqual(payload["item"]["file"], "liar.jpg")

    def test_non_image_is_refused_before_any_write(self):
        status, _ = self._add(b"<?php system($_GET['c']); ?>", name="evil.png")
        self.assertEqual(status, 400)
        self.assertEqual(self._files(), [])
        self.assertNotIn("gallery", self._meta())

    def test_oversized_payload_is_refused(self):
        status, _ = self._add(PNG + b"\x00" * dev_server.MAX_GALLERY_BYTES)
        self.assertEqual(status, 400)
        self.assertEqual(self._files(), [])

    def test_non_data_url_is_refused(self):
        status, _ = dev_server._gallery_add("3d/demo", {"image": "https://evil.example/x.png"})
        self.assertEqual(status, 400)

    def test_filename_is_slugged_and_deduplicated(self):
        self._add(name="Coupe Annotée !.png")
        self._add(name="Coupe Annotée !.png")
        self.assertEqual(self._files(), ["coupe-annot-e-1.png", "coupe-annot-e.png"])

    def test_traversal_in_filename_cannot_escape_the_gallery_folder(self):
        status, payload = self._add(name="../../../../evil.png")
        self.assertEqual(status, 200)
        self.assertEqual(payload["item"]["file"], "evil.png")   # slugged to a bare name
        self.assertEqual(self._files(), ["evil.png"])
        self.assertFalse((self.tmp / "evil.png").exists())

    def test_bad_dataset_id_is_refused(self):
        for bad in ("../../api", "3d", "2d", "secrets/keys", "3d/../../api", "fixed/demo"):
            status, _ = dev_server._gallery_add(bad, {"image": durl(PNG)})
            self.assertEqual(status, 400, bad)

    def test_count_is_capped(self):
        for i in range(dev_server.MAX_GALLERY_ITEMS):
            self.assertEqual(self._add(name=f"i{i}.png")[0], 200)
        status, _ = self._add(name="overflow.png")
        self.assertEqual(status, 409)
        self.assertEqual(len(self._files()), dev_server.MAX_GALLERY_ITEMS)

    def test_caption_is_flattened_and_clamped(self):
        _, payload = self._add(caption="ligne 1\nligne 2\r\n" + "x" * 900)
        caption = payload["item"]["caption"]
        self.assertNotIn("\n", caption)
        self.assertEqual(len(caption), 400)


class TestDelete(GalleryCase):
    def test_removes_file_and_entry(self):
        self._add(name="a.png")
        self._add(name="b.png")
        status, payload = dev_server._gallery_delete("3d/demo", "a.png")
        self.assertEqual(status, 200)
        self.assertEqual(self._files(), ["b.png"])
        self.assertEqual([e["file"] for e in payload["gallery"]], ["b.png"])

    def test_traversal_target_is_refused(self):
        self._add(name="a.png")
        for bad in ("../metadata.json", "../../3d/demo/metadata.json", "sub/a.png", "a.php"):
            status, _ = dev_server._gallery_delete("3d/demo", bad)
            self.assertEqual(status, 400, bad)
        self.assertTrue((self.ds_dir / "metadata.json").exists())

    def test_gallery_prefix_form_is_accepted(self):
        # The viewer stores bare names, but a hand-written "gallery/x.png" still resolves.
        self._add(name="a.png")
        status, _ = dev_server._gallery_delete("3d/demo", "gallery/a.png")
        self.assertEqual(status, 200)
        self.assertEqual(self._files(), [])


class TestReconcileOnSave(GalleryCase):
    """metadata.json's gallery decides ORDER and CAPTIONS; the folder decides WHICH."""

    def test_stale_draft_cannot_drop_a_concurrent_upload(self):
        self._add(name="a.png", caption="Vue A")
        self._add(name="b.png", caption="Vue B")
        # A form opened before b.png existed saves back only a.png.
        dev_server._save_dataset("3d/demo", {"name": "Demo", "gallery": [{"file": "a.png", "caption": "Vue A"}]})
        gallery = self._meta()["gallery"]
        self.assertEqual([e["file"] for e in gallery], ["a.png", "b.png"])
        # …and b.png keeps the caption it was uploaded with.
        self.assertEqual(gallery[1]["caption"], "Vue B")

    def test_entries_without_a_file_on_disk_are_dropped(self):
        self._add(name="a.png")
        dev_server._save_dataset("3d/demo", {"gallery": [
            {"file": "a.png"},
            {"file": "ghost.png"},
            {"file": "../../../etc/passwd"},
            {"file": "x.php"},
            "not-an-object",
        ]})
        self.assertEqual([e["file"] for e in self._meta()["gallery"]], ["a.png"])

    def test_order_and_captions_from_the_draft_are_kept(self):
        self._add(name="a.png")
        self._add(name="b.png")
        dev_server._save_dataset("3d/demo", {"gallery": [
            {"file": "b.png", "caption": "second devient premier"},
            {"file": "a.png"},
        ]})
        gallery = self._meta()["gallery"]
        self.assertEqual([e["file"] for e in gallery], ["b.png", "a.png"])
        self.assertEqual(gallery[0]["caption"], "second devient premier")

    def test_duplicate_entries_collapse(self):
        self._add(name="a.png")
        dev_server._save_dataset("3d/demo", {"gallery": [{"file": "a.png"}, {"file": "a.png"}]})
        self.assertEqual(len(self._meta()["gallery"]), 1)

    def test_key_is_removed_when_no_image_remains(self):
        self._add(name="a.png")
        dev_server._gallery_delete("3d/demo", "a.png")
        dev_server._save_dataset("3d/demo", {"name": "Demo"})
        self.assertNotIn("gallery", self._meta())

    def test_a_dataset_without_a_gallery_folder_is_unaffected(self):
        dev_server._save_dataset("3d/demo", {"name": "Demo"})
        self.assertNotIn("gallery", self._meta())


class TestCatalogExposure(GalleryCase):
    def test_gallery_reaches_the_public_catalog(self):
        self._write_meta({"name": "Demo", "type": "3d", "configured": True,
                          "dimensions": {"x": 4, "y": 4, "z": 4, "c": 1},
                          "channels": [{"name": "c0"}]})
        self._add(name="a.png", caption="Vue A")
        dev_server._CATALOG_CACHE["sig"] = None
        entry = next(d for d in dev_server._build_catalog() if d["id"] == "3d/demo")
        self.assertEqual([e["file"] for e in entry["gallery"]], ["a.png"])
        self.assertEqual(entry["gallery"][0]["caption"], "Vue A")


if __name__ == "__main__":
    unittest.main(verbosity=2)
