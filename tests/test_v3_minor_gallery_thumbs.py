"""Gallery thumbnails (web 1.59.0), both backends.

The viewer's gallery grid used to load every original (up to 8 MB each, forty of
them) through the sockets the brick packs need. The server now keeps a grid-sized
copy, gallery/thumbs/<file>.webp (<file>.jpg where WebP cannot be encoded), at most
320 px on the long side:
  * made on gallery_add, lazily for older images (`gallery_thumbs`, and on save);
  * removed with its image on gallery_delete, orphans swept on sync;
  * every gallery entry carries `thumb` (derived from the disk, never trusted from
    a posted entry) — dataset-gallery.js / tab-datasets.js load it in the grid and
    the original in the lightbox.
Python (Pillow) and PHP (GD) are checked on the same images: same file names,
same sizes, the same entries.

Run: python tests/test_v3_minor_gallery_thumbs.py
"""
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import dev_server  # noqa: E402
from v3_minor_support import PhpTwin  # noqa: E402

try:
    from PIL import Image
except Exception:   # pragma: no cover
    Image = None


def png(w, h, color=(200, 30, 30, 128)):
    buf = io.BytesIO()
    Image.new("RGBA", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


def jpeg(w, h):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (10, 200, 10)).save(buf, "JPEG")
    return buf.getvalue()


@unittest.skipIf(Image is None, "Pillow is not installed")
class PythonThumbs(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-gthumb-"))
        self._dw = dev_server.DATA_WEB
        dev_server.DATA_WEB = self.tmp
        self.ds = self.tmp / "3d" / "demo"
        self.ds.mkdir(parents=True)
        (self.ds / "metadata.json").write_text(json.dumps({"name": "Demo", "type": "3d"}))

    def tearDown(self):
        dev_server.DATA_WEB = self._dw
        shutil.rmtree(self.tmp, ignore_errors=True)

    def meta(self):
        return json.loads((self.ds / "metadata.json").read_text())

    def test_add_makes_a_thumbnail(self):
        st, pl = dev_server._gallery_add("3d/demo", {"raw": png(1000, 500), "filename": "fig.png"})
        self.assertEqual(st, 200, pl)
        self.assertEqual(pl["item"]["thumb"], "thumbs/fig.png.webp")
        with Image.open(self.ds / "gallery/thumbs/fig.png.webp") as im:
            self.assertEqual((im.format, im.size), ("WEBP", (320, 160)))
            self.assertIn("A", im.getbands(), "transparency survives")
        self.assertEqual(self.meta()["gallery"][0]["thumb"], "thumbs/fig.png.webp")

    def test_small_images_are_not_upscaled_and_jpeg_without_webp(self):
        with mock.patch("PIL.features.check", lambda name: False if name == "webp" else True):
            st, pl = dev_server._gallery_add("3d/demo", {"raw": png(100, 80), "filename": "small.png"})
        self.assertEqual(st, 200, pl)
        self.assertEqual(pl["item"]["thumb"], "thumbs/small.png.jpg")
        with Image.open(self.ds / "gallery/thumbs/small.png.jpg") as im:
            self.assertEqual((im.format, im.size), ("JPEG", (100, 80)))

    def test_delete_removes_the_thumbnail(self):
        dev_server._gallery_add("3d/demo", {"raw": png(400, 400), "filename": "a.png"})
        st, pl = dev_server._gallery_delete("3d/demo", "a.png")
        self.assertEqual(st, 200, pl)
        self.assertFalse((self.ds / "gallery/thumbs/a.png.webp").exists())

    def test_existing_images_get_thumbnails_lazily(self):
        (self.ds / "gallery").mkdir()
        (self.ds / "gallery/old.jpg").write_bytes(jpeg(640, 1280))
        (self.ds / "metadata.json").write_text(json.dumps({"name": "Demo", "gallery": [{"file": "old.jpg"}]}))
        (self.ds / "gallery/thumbs").mkdir()
        (self.ds / "gallery/thumbs/ghost.png.webp").write_bytes(b"orphan")
        st, pl = dev_server._gallery_thumbs("3d/demo")
        self.assertEqual(st, 200, pl)
        self.assertEqual(pl["gallery"], [{"file": "old.jpg", "thumb": "thumbs/old.jpg.webp"}])
        with Image.open(self.ds / "gallery/thumbs/old.jpg.webp") as im:
            self.assertEqual(im.size, (160, 320))
        self.assertFalse((self.ds / "gallery/thumbs/ghost.png.webp").exists(), "orphans are swept")
        self.assertEqual(self.meta()["gallery"][0]["thumb"], "thumbs/old.jpg.webp")

    def test_a_posted_thumb_is_never_trusted(self):
        dev_server._gallery_add("3d/demo", {"raw": png(50, 50), "filename": "x.png"})
        self.assertTrue(dev_server._save_dataset("3d/demo", {"gallery": [
            {"file": "x.png", "thumb": "../../../../api/admin_credential.json"}]}))
        self.assertEqual(self.meta()["gallery"], [{"file": "x.png", "thumb": "thumbs/x.png.webp"}])

    def test_a_decompression_bomb_gets_no_thumbnail(self):
        with mock.patch.object(dev_server, "GALLERY_THUMB_MAX_SOURCE_PIXELS", 1000):
            st, pl = dev_server._gallery_add("3d/demo", {"raw": png(100, 100), "filename": "big.png"})
        self.assertEqual(st, 200, pl)
        self.assertNotIn("thumb", pl["item"], "the grid falls back to the original")


@unittest.skipIf(Image is None, "Pillow is not installed")
class PhpThumbs(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-gthumb-php-"))
        self.twin = PhpTwin(self.tmp, ["_admin_lib.php", "_upload_lib.php", "datasets.php"], need_gd=True)
        if not self.twin.available():
            self.skipTest("no php interpreter with GD + WebP")
        self.ds = self.tmp / "DATA_WEB" / "3d" / "demo"
        self.ds.mkdir(parents=True)
        (self.ds / "metadata.json").write_text(json.dumps({"name": "Demo", "type": "3d"}))
        self.order = ["--define=LUMEN_DATASETS_LIB", "datasets.php"]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def call(self, *ops):
        return self.twin.call(*ops, lib_order=self.order)

    def test_php_matches_python(self):
        ((st, pl),) = self.call({"fn": "gallery_add", "args": [
            "3d/demo", str(self.ds), {"raw": {"__hex": png(1000, 500).hex()}, "filename": "fig.png"}]})
        self.assertEqual(st, 200, pl)
        self.assertEqual(pl["item"]["thumb"], "thumbs/fig.png.webp")
        with Image.open(self.ds / "gallery/thumbs/fig.png.webp") as im:
            self.assertEqual((im.format, im.size), ("WEBP", (320, 160)))
        # Lazy path + orphan sweep + delete, as in Python.
        (self.ds / "gallery/old.jpg").write_bytes(jpeg(640, 1280))
        (self.ds / "gallery/thumbs/ghost.png.webp").write_bytes(b"orphan")
        ((st, pl),) = self.call({"fn": "gallery_thumbs", "args": [str(self.ds)]})
        self.assertEqual(st, 200, pl)
        self.assertEqual({g["file"]: g.get("thumb") for g in pl["gallery"]},
                         {"fig.png": "thumbs/fig.png.webp", "old.jpg": "thumbs/old.jpg.webp"})
        with Image.open(self.ds / "gallery/thumbs/old.jpg.webp") as im:
            self.assertEqual(im.size, (160, 320))
        self.assertFalse((self.ds / "gallery/thumbs/ghost.png.webp").exists())
        ((st, pl),) = self.call({"fn": "gallery_delete", "args": [str(self.ds), "fig.png"]})
        self.assertEqual(st, 200, pl)
        self.assertFalse((self.ds / "gallery/thumbs/fig.png.webp").exists())
        self.assertIn("lastModified", json.loads((self.ds / "metadata.json").read_text()))

    def test_a_canvas_too_large_for_memory_limit_gets_no_thumbnail(self):
        # 6000×6000 (36 MP, under the 50 MP cap) is ~144 MB decoded by GD: under a
        # 128 MiB memory_limit it must be refused before decoding, not die mid-request.
        (self.ds / "gallery").mkdir(parents=True)
        Image.new("L", (6000, 6000)).save(self.ds / "gallery/big.png", optimize=True)
        exe, extra = self.twin.php
        self.twin.php = (exe, [*extra, "-d", "memory_limit=128M"])
        try:
            (got,) = self.call({"fn": "gallery_make_thumb", "args": [str(self.ds / "gallery"), "big.png"]})
            self.assertIsNone(got)
            ((st, pl),) = self.call({"fn": "gallery_thumbs", "args": [str(self.ds)]})
        finally:
            self.twin.php = (exe, extra)
        self.assertEqual(st, 200, pl)

    def test_a_python_made_thumbnail_is_current_for_php(self):
        (self.ds / "gallery/thumbs").mkdir(parents=True)
        (self.ds / "gallery/a.png").write_bytes(png(64, 64))
        _dw = dev_server.DATA_WEB
        try:
            dev_server.DATA_WEB = self.tmp / "DATA_WEB"
            dev_server._gallery_sync_thumbs(self.ds)
        finally:
            dev_server.DATA_WEB = _dw
        made = (self.ds / "gallery/thumbs/a.png.webp").read_bytes()
        (got,) = self.call({"fn": "gallery_thumb_existing", "args": [str(self.ds / "gallery"), "a.png"]})
        self.assertEqual(got, "thumbs/a.png.webp")
        self.call({"fn": "gallery_sync_thumbs", "args": [str(self.ds)]})
        self.assertEqual((self.ds / "gallery/thumbs/a.png.webp").read_bytes(), made, "not regenerated")


class ClientUsesThumbnails(unittest.TestCase):
    def test_grid_loads_thumbs_and_lightbox_originals(self):
        src = (ROOT / "js/components/dataset-gallery.js").read_text(encoding="utf-8")
        self.assertIn("img.src = thumb || _urlFor(item);", src)
        paint = src[src.index("function _paint()"):]
        self.assertIn("img.src = _urlFor(item);", paint[:400])
        admin = (ROOT / "js/pages/admin/tab-datasets.js").read_text(encoding="utf-8")
        self.assertIn("galleryThumbUrl(it)", admin)
        self.assertIn("action=gallery_thumbs", admin)


if __name__ == "__main__":
    unittest.main(verbosity=2)
