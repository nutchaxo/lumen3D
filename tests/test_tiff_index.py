"""api/tiff-index, Python twin (dev_server._tiff_index + GET /api/tiff-index).

Synthetic TIFFs from tests/tiff_index_fixtures.py: classic + BigTIFF, II + MM, interleaved IFDs, deflate +
predictor tags, ImageJ description + tags 50838 / 50839, a 3-page ImageJ composite (the 2d original's shape),
tiles, non-uniform pages, a cycle, too many strips, and the HTTP guards (traversal, sub-folder file, non-tif,
hidden dataset, unknown type, ETag / 304).

Run: python tests/test_tiff_index.py
"""
import base64
import http.client
import json
import os
import shutil
import struct
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
os.chdir(ROOT)
import dev_server  # noqa: E402
import tiff_index_fixtures as fx  # noqa: E402


def dec(b64, fmt):
    raw = base64.b64decode(b64)
    return list(struct.unpack("<%d%s" % (len(raw) // struct.calcsize(fmt), fmt), raw))


class IndexTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.expect = fx.write_all(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def index(self, name):
        return dev_server._tiff_index(str(self.tmp / name), "3d/demo", name)

    def test_every_fixture(self):
        for name, exp in self.expect.items():
            if "error" in exp:
                with self.assertRaises(dev_server._TiffError, msg=name) as cm:
                    self.index(name)
                self.assertEqual(cm.exception.code, exp["error"], name)
                continue
            doc = self.index(name)
            self.assertEqual(doc["pages"], exp["pages"], name)
            for key, field in (("bigtiff", "bigtiff"), ("littleEndian", "littleEndian"), ("compression", "compression"),
                               ("predictor", "predictor"), ("bits", "bitsPerSample"), ("tiled", "tiled"), ("uniform", "uniform")):
                if key in exp:
                    self.assertEqual(doc[field], exp[key], f"{name}.{field}")
            if exp.get("strips"):
                self.assertEqual(doc["strips"]["perPage"], exp["strips"], name)

    def test_strips_point_at_the_payload_for_both_layouts(self):
        for name in ("ij-ii.tif", "ij-mm-big.tif", "not-interleaved.tif", "deflate-predictor.tif"):
            doc = self.index(name)
            offs = dec(doc["strips"]["offsets"], "d")
            counts = dec(doc["strips"]["byteCounts"], "I")
            self.assertEqual(len(offs), doc["pages"] * doc["strips"]["perPage"], name)
            data = (self.tmp / name).read_bytes()
            for o, c in zip(offs, counts):
                chunk = data[int(o):int(o) + c]
                self.assertEqual(len(chunk), c)
                self.assertEqual(len(set(chunk)), 1, f"{name}: strip bytes are one value")

    def test_imagej_block_both_byte_orders(self):
        for name in ("ij-ii.tif", "ij-mm.tif", "ij-ii-big.tif", "ij-mm-big.tif"):
            ij = self.index(name)["imagej"]
            self.assertEqual(ij["version"], "1.54f")
            self.assertEqual((ij["images"], ij["channels"], ij["slices"], ij["frames"]), (6, 3, 2, 1))
            self.assertTrue(ij["hyperstack"])
            self.assertEqual((ij["mode"], ij["unit"], ij["spacing"], ij["min"], ij["max"]), ("composite", "micron", 2.5, 0, 255))
            self.assertEqual(ij["labels"], ["DAPI", "GFP", "RFP"], "labels capped at the channel count")
            self.assertEqual(ij["colors"], ["#ff0000", "#00ff00", "#0000ff"])
            self.assertEqual(ij["ranges"], [0, 255, 5, 100, 0, 77.5])
            self.assertEqual(ij["info"], "Dataset: demo\nSource: Imaris .ims ResolutionLevel 1, native uint8\nµm")

    def test_resolution_and_composite_shape(self):
        doc = self.index("three-page-ijcomposite.tif")
        self.assertEqual(doc["resolution"], {"x": 2.5, "y": 2.5, "unit": 1})
        self.assertEqual(doc["imagej"]["labels"], ["A", "B", "C"])
        self.assertEqual(doc["imagej"]["colors"], ["#00ffff", "#ffff00", "#ff00ff"])
        self.assertEqual(self.index("deflate-predictor.tif")["imagej"], None)

    def test_non_uniform_lists_every_strip(self):
        doc = self.index("non-uniform.tif")
        self.assertFalse(doc["uniform"])
        self.assertEqual([p["bitsPerSample"] for p in doc["pageInfo"]], [8, 16, 8])
        self.assertIsNone(doc["strips"]["perPage"])
        starts = dec(doc["strips"]["index"], "I")
        self.assertEqual(starts, [0, 2, 6])
        self.assertEqual(len(dec(doc["strips"]["offsets"], "d")), 7)

    def test_caps(self):
        with mock.patch.object(dev_server, "_TIFF_MAX_PAGES", 2):
            with self.assertRaises(dev_server._TiffError) as cm:
                dev_server._tiff_index_core(str(self.tmp / "ij-ii.tif"))
            self.assertEqual(cm.exception.code, "too_many_pages")

    def test_json_is_compact_and_ordered(self):
        text = dev_server._tiff_json(self.index("ij-ii.tif"))
        keys = list(json.loads(text).keys())
        self.assertEqual(keys[:6], ["v", "dataset", "file", "url", "size", "mtime"])
        self.assertEqual(keys[-3:], ["resolution", "imagej", "strips"])
        self.assertNotIn('"v": ', text)
        self.assertNotIn(", \"", text)
        self.assertIn("µ", text, "no ASCII escaping of unicode")

    def test_cache_is_keyed_on_size_and_mtime(self):
        path = self.tmp / "cache.tif"
        path.write_bytes(self.tmp.joinpath("ij-ii.tif").read_bytes())
        first = dev_server._tiff_index(str(path), "3d/demo", "cache.tif")
        os.utime(path, (1, 1))
        with mock.patch.object(dev_server, "_tiff_index_core", side_effect=AssertionError("reparsed")):
            with self.assertRaises(AssertionError):
                dev_server._tiff_index(str(path), "3d/demo", "cache.tif")
        self.assertEqual(first["pages"], 6)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls._web = dev_server.DATA_WEB
        dev_server.DATA_WEB = cls.tmp
        for ds, hidden in (("3d/demo", False), ("3d/secret", True), ("2d/photo", False)):
            d = cls.tmp / ds
            (d / "download" / "sub").mkdir(parents=True)
            (d / "metadata.json").write_text(json.dumps({"hidden": hidden}))
            fx.write_all(d / "download")
            shutil.copy(d / "download" / "ij-ii.tif", d / "download" / "sub" / "deep.tif")
            (d / "download" / "notes.txt").write_text("x")
            (d / "download" / "My Stack 1.tif").write_bytes((d / "download" / "ij-ii.tif").read_bytes())
            (d / "download" / "spaced name.tif").write_bytes((d / "download" / "ij-ii.tif").read_bytes())
        (cls.tmp / "outside.tif").write_bytes((cls.tmp / "3d/demo/download/ij-ii.tif").read_bytes())
        cls.httpd = dev_server._QuietServer(("127.0.0.1", 0), dev_server.AdminHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        dev_server.DATA_WEB = cls._web
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def get(self, query, headers=None, path="/api/tiff-index"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        conn.request("GET", f"{path}?{query}", headers=headers or {})
        r = conn.getresponse()
        data = r.read()
        conn.close()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, data

    def test_answer_etag_and_304(self):
        for path in ("/api/tiff-index", "/api/tiff-index.php"):
            status, h, body = self.get("dataset=3d/demo&file=ij-ii.tif", path=path)
            self.assertEqual(status, 200)
            self.assertEqual(h["cache-control"], "no-cache")
            self.assertNotIn("access-control-allow-origin", h)
            doc = json.loads(body)
            self.assertEqual((doc["v"], doc["dataset"], doc["file"], doc["url"]),
                             (1, "3d/demo", "ij-ii.tif", "DATA_WEB/3d/demo/download/ij-ii.tif"))
            self.assertRegex(h["etag"], r'^"\d+-\d+-v1"$')
            s2, h2, b2 = self.get("dataset=3d/demo&file=ij-ii.tif", {"If-None-Match": h["etag"]}, path=path)
            self.assertEqual((s2, b2), (304, b""))

    def test_names_with_spaces_and_parens(self):
        for name in ("My%20Stack%201.tif", "spaced+name.tif", "spaced%20name.tif"):
            self.assertEqual(self.get(f"dataset=3d/demo&file={name}")[0], 200, name)

    def test_refusals(self):
        cases = {
            "dataset=3d/demo&file=../../outside.tif": (400, "invalid_file"),
            "dataset=3d/demo&file=sub/deep.tif": (400, "invalid_file"),
            "dataset=3d/demo&file=..%2Foutside.tif": (400, "invalid_file"),
            "dataset=3d/demo&file=notes.txt": (400, "invalid_file"),
            "dataset=3d/demo&file=.hidden.tif": (400, "invalid_file"),
            "dataset=3d/demo&file=ij-ii.tif%00.png": (400, "invalid_file"),
            "dataset=3d/demo&file=ij-ii.tif%0A": (400, "invalid_file"),
            "dataset=3d/demo&file=": (400, "invalid_file"),
            "dataset=3d/demo": (400, "invalid_file"),
            "dataset=../etc&file=a.tif": (400, "invalid_dataset"),
            "dataset=3d/../2d&file=a.tif": (400, "invalid_dataset"),
            "dataset=fixed/demo&file=ij-ii.tif": (400, "invalid_dataset"),
            "dataset=3d&file=a.tif": (400, "invalid_dataset"),
            "dataset=3d/secret&file=ij-ii.tif": (404, "not_found"),
            "dataset=3d/ghost&file=ij-ii.tif": (404, "not_found"),
            "dataset=3d/demo&file=missing.tif": (404, "not_found"),
            "dataset=3d/demo&file=not-a-tiff.tif": (422, "not_tiff"),
            "dataset=3d/demo&file=cycle.tif": (422, "malformed"),
            "dataset=3d/demo&file=truncated.tif": (422, "malformed"),
            "dataset=3d/demo&file=too-many-strips.tif": (422, "too_many_pages"),
        }
        for query, (status, code) in cases.items():
            got, _h, body = self.get(query)
            self.assertEqual((got, json.loads(body).get("error")), (status, code), query)

    def test_a_hidden_dataset_answers_like_an_unknown_one(self):
        a = self.get("dataset=3d/secret&file=ij-ii.tif")
        b = self.get("dataset=3d/ghost&file=ij-ii.tif")
        self.assertEqual((a[0], a[2]), (b[0], b[2]))


if __name__ == "__main__":
    unittest.main(verbosity=1)
