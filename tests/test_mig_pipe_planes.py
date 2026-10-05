"""Pipeline — format 2 (`planes/`, DOCS/dataset-migrations/SPEC.md §3) written by step 3.

Needs numpy, scipy, h5py, Pillow and tqdm (Python 3.12: `py -3.12 -m unittest ...`).

Covers:
  * the png-gray8 codec: standard PNG decoded by Pillow to the very bytes encoded, IHDR
    of the expected size and colour type 0, no ancillary chunk, filter None on every row,
    zlib level 6;
  * the plane pack layout byte for byte (magic, counts, entries c-major/ty/tx, length 0
    with offset 0 for an empty tile, payloads concatenated);
  * pack_timepoint + build_packs on multi-tile, multi-channel LOD0 files: every pixel of
    every plane equals the voxel the WebP brick decodes to, 0 where the channel's brick
    is absent; exactly the all-zero tiles have length 0; manifest fields, headerBytes and the sha256 of
    the bricks manifest; one tree per timepoint for a timelapse;
  * step 4: formatVersion 2 when the planes are complete (1 otherwise), never curated;
    a histogram injection re-points the planes at the new manifest bytes;
  * the orchestrator end to end (real process pools): the published dataset carries
    planes/ and formatVersion 2, and a re-run swaps planes/ with bricks/.
"""
import hashlib
import importlib.util
import io
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRE = ROOT / "preprocess"
sys.path.insert(0, str(PRE))
sys.path.insert(0, str(ROOT / "tests"))

try:
    import h5py  # noqa: F401
    import numpy as np
    import scipy  # noqa: F401
    import tqdm  # noqa: F401
    from PIL import Image
    HAVE_DEPS = True
except ImportError as exc:  # pragma: no cover
    HAVE_DEPS = False
    MISSING = str(exc)


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(PRE / filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if HAVE_DEPS:
    import planes_writer as pw
    from preprocess_fixtures import synthetic_volume, write_ims
    step2 = _load("lumen_mig_pipe_step2", "2-image_processor.py")
    step3 = _load("lumen_mig_pipe_step3", "3-chunk_packer.py")
    step4 = _load("lumen_mig_pipe_step4", "4-catalog_generator.py")
    import run_preprocess


class _Serial:
    _max_workers = 1

    def submit(self, fn, task):
        from concurrent.futures import Future
        fut = Future()
        fut.set_result(fn(task))
        return fut

    def map(self, fn, tasks):
        return map(fn, tasks)

    def shutdown(self):
        pass


def png_chunks(data):
    pos, out = 8, []
    while pos < len(data):
        n = struct.unpack(">I", data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + n]
        crc = struct.unpack(">I", data[pos + 8 + n:pos + 12 + n])[0]
        assert crc == zlib.crc32(kind + body) & 0xFFFFFFFF
        out.append((kind, body))
        pos += 12 + n
    return out


def decode_png(data):
    img = Image.open(io.BytesIO(data))
    img.load()
    assert img.mode == "L", img.mode
    return np.asarray(img)


def decode_webp_brick(data):
    """What the viewer's decoder does: WebP lossless -> 512x512 mosaic -> 64^3 brick."""
    img = Image.open(io.BytesIO(data))
    img.load()
    mosaic = np.asarray(img)
    if mosaic.ndim == 3:
        mosaic = mosaic[:, :, 0]
    brick = np.zeros((64, 64, 64), np.uint8)
    for z in range(64):
        r, c = divmod(z, 8)
        brick[z] = mosaic[r * 64:(r + 1) * 64, c * 64:(c + 1) * 64]
    return brick


def read_tree(tree_dir, dims, channels):
    """Every plane of a tree as (Z, C, Y, X) uint8, plus each pack's parsed header."""
    X, Y, Z = dims
    out = np.zeros((Z, channels, Y, X), np.uint8)
    headers = []
    for z in range(Z):
        data = (tree_dir / pw.pack_name(z)).read_bytes()
        head = pw.parse_plane_pack_header(data)
        headers.append(head)
        tx_n, ty_n = head["tilesX"], head["tilesY"]
        for i, (off, ln) in enumerate(head["entries"]):
            if not ln:
                continue
            c, rest = divmod(i, ty_n * tx_n)
            ty, tx = divmod(rest, tx_n)
            tile = decode_png(data[off:off + ln])
            out[z, c, ty * 512:ty * 512 + tile.shape[0], tx * 512:tx * 512 + tile.shape[1]] = tile
    return out, headers


@unittest.skipUnless(HAVE_DEPS, "preprocessing dependencies missing")
class Codec(unittest.TestCase):
    def test_png_roundtrip_and_shape(self):
        rng = np.random.default_rng(7)
        for h, w in ((512, 512), (1, 1), (37, 1), (1, 300), (277, 189)):
            tile = rng.integers(0, 256, size=(h, w), dtype=np.uint8)
            tile[: h // 2] = np.uint8(3)      # long runs next to noise
            data = pw.png_gray8(tile)
            self.assertTrue(np.array_equal(decode_png(data), tile))
            chunks = png_chunks(data)
            self.assertEqual([k for k, _ in chunks], [b"IHDR", b"IDAT", b"IEND"])
            self.assertEqual(chunks[0][1], struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
            self.assertEqual(pw.png_header(data), (w, h, 8, 0, 0))
            raw = zlib.decompress(chunks[1][1])
            self.assertEqual(chunks[1][1], zlib.compress(raw, 6))
            rows = np.frombuffer(raw, np.uint8).reshape(h, w + 1)
            self.assertTrue((rows[:, 0] == 0).all())
            self.assertTrue(np.array_equal(rows[:, 1:], tile))

    def test_pack_layout(self):
        a, b = b"\x89PNGaaaa", b"\x89PNGbbbbbb"
        data = pw.build_plane_pack(258, 2, 3, 1, [a, b"", b, b"", b"", a])
        self.assertEqual(data[:16], b"LPLN" + struct.pack("<HHHHI", 1, 2, 3, 1, 258))
        hb = pw.header_bytes(2, 3, 1)
        self.assertEqual(hb, 16 + 12 * 6)
        entries = [struct.unpack_from("<QI", data, 16 + 12 * i) for i in range(6)]
        self.assertEqual(entries, [(hb, len(a)), (0, 0), (hb + len(a), len(b)), (0, 0), (0, 0),
                                   (hb + len(a) + len(b), len(a))])
        self.assertEqual(data[hb:], a + b + a)
        self.assertEqual(pw.parse_plane_pack_header(data)["entries"], entries)
        self.assertEqual(pw.pack_name(7), "z00007.bin")


def _write_lods(tmp, t_idx, lod_levels, channels, rng):
    """LOD files with signal, a noise-only region and a channel-1 blank stripe."""
    for c in range(channels):
        for li in lod_levels:
            D, H, W = li["depth"], li["height"], li["width"]
            vol = (rng.random((D, H, W)) < 0.01).astype(np.uint8) * rng.integers(
                6, 256, size=(D, H, W), dtype=np.uint8)
            vol[:, :min(H, 200), :min(W, 150)] = np.maximum(
                vol[:, :min(H, 200), :min(W, 150)], rng.integers(0, 200, size=(D, min(H, 200), min(W, 150)),
                                                                  dtype=np.uint8))
            vol[:, -64:, -70:] = 1                 # noise only: bricks dropped by ESS
            if c == channels - 1:
                vol[:, :, 512:] = 0                # last channel empty in the second tile column
            vol.tofile(tmp / f"t{t_idx:03d}_c{c}_lod{li['lod']}.bin")


@unittest.skipUnless(HAVE_DEPS, "preprocessing dependencies missing")
class PackerPlanes(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen_mig_pipe_"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _proc(self, W, H, D, channels, n_tp):
        lod_levels = step2.lod_ladder(W, H, D)
        proc = {"lod_levels": lod_levels, "n_channels": channels, "n_timepoints": n_tp,
                "voxel_size": {"x": 1, "y": 1, "z": 1}, "channel_names": ["a", "b"][:channels],
                "width": W, "height": H, "depth": D}
        (self.tmp / "processing_meta.json").write_text(json.dumps(proc), encoding="utf-8")
        return lod_levels

    def _check_tree(self, ds, tree_key, row, dims, channels, t_idx):
        X, Y, Z = dims
        tree = ds / "planes" / tree_key if tree_key else ds / "planes"
        bricks_root = ds / "bricks" / tree_key if tree_key else ds / "bricks"
        planes, headers = read_tree(tree, dims, channels)
        b2p = row["brickTransport"]["brickToPack"]
        expected = np.zeros((Z, channels, Y, X), np.uint8)
        for c in range(channels):
            for bz in range(math.ceil(Z / 64)):
                for by in range(math.ceil(Y / 64)):
                    for bx in range(math.ceil(X / 64)):
                        e = b2p.get(f"lod0/c{c}/x{bx:03d}_y{by:03d}_z{bz:03d}.webp")
                        if not e:
                            continue
                        with open(bricks_root / e["url"], "rb") as fh:
                            fh.seek(e["offset"])
                            brick = decode_webp_brick(fh.read(e["length"]))
                        z0, y0, x0 = bz * 64, by * 64, bx * 64
                        z1, y1, x1 = min(Z, z0 + 64), min(Y, y0 + 64), min(X, x0 + 64)
                        expected[z0:z1, c, y0:y1, x0:x1] = brick[:z1 - z0, :y1 - y0, :x1 - x0]
        self.assertTrue(np.array_equal(planes, expected), "planes != decoded bricks")
        # And the bricks are the masked LOD0 file itself (lossless end to end).
        lod0 = [np.fromfile(self.tmp / f"t{t_idx:03d}_c{c}_lod0.bin", np.uint8).reshape(Z, Y, X)
                for c in range(channels)]
        self.assertTrue(((planes == np.stack(lod0, axis=1)) | (planes == 0)).all())

        tx_n, ty_n = math.ceil(X / 512), math.ceil(Y / 512)
        empty_seen = 0
        for z, head in enumerate(headers):
            self.assertEqual((head["z"], head["channels"], head["tilesX"], head["tilesY"]),
                             (z, channels, tx_n, ty_n))
            for i, (off, ln) in enumerate(head["entries"]):
                c, rest = divmod(i, ty_n * tx_n)
                ty, tx = divmod(rest, tx_n)
                tile = expected[z, c, ty * 512:(ty + 1) * 512, tx * 512:(tx + 1) * 512]
                self.assertEqual(ln > 0, bool(tile.any()), (z, c, ty, tx))
                if not ln:
                    self.assertEqual(off, 0)
                    empty_seen += 1
        self.assertGreater(empty_seen, 0)

        doc = json.loads((tree / "manifest.json").read_text(encoding="utf-8"))
        raw_manifest = (ds / "bricks" / "manifest.json").read_bytes()
        self.assertEqual(doc["source"], {"manifestSha256": hashlib.sha256(raw_manifest).hexdigest()})
        created = doc.pop("createdAt")
        self.assertRegex(created, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(doc, {
            "schema": "lumen-planes-v1", "formatVersion": 2, "level": 0,
            "dimensions": {"x": X, "y": Y, "z": Z}, "channels": channels, "tileSize": 512,
            "tiles": {"x": tx_n, "y": ty_n}, "codec": "png-gray8", "packPattern": "z{z}.bin",
            "headerBytes": 16 + 12 * channels * tx_n * ty_n,
            "source": doc["source"], "producer": "pipeline"})
        self.assertNotIn(b"\n", (tree / "manifest.json").read_bytes())

    def test_single_volume(self):
        W, H, D, C = 600, 530, 70, 2
        lod_levels = self._proc(W, H, D, C, 1)
        _write_lods(self.tmp, 0, lod_levels, C, np.random.default_rng(11))
        ds = self.tmp / "3d" / "ds"
        ds.mkdir(parents=True)
        levels, transport = step3.pack_timepoint(self.tmp, ds / "bricks", 0, lod_levels, C,
                                                 _Serial(), "")
        (self.tmp / "pack_t000.json").write_text(json.dumps({"levels": levels,
                                                             "brickTransport": transport}))
        step3.build_packs(self.tmp, ds)
        manifest = json.loads((ds / "bricks" / "manifest.json").read_text(encoding="utf-8"))
        self._check_tree(ds, "", manifest, (W, H, D), C, 0)
        self.assertEqual(sorted(p.name for p in (ds / "planes").iterdir()),
                         ["manifest.json"] + [f"z{z:05d}.bin" for z in range(D)])
        self.assertTrue(pw.planes_complete(ds))

        # Step 4 claims format 2, and a histogram injection keeps the planes valid.
        manifest["histograms"] = []
        (ds / "bricks" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        self.assertFalse(pw.planes_complete(ds))
        step4.generate_catalog_metadata(self.tmp, ds)
        meta = json.loads((ds / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["formatVersion"], 2)
        self.assertTrue(pw.planes_complete(ds))
        self.assertTrue(json.loads((ds / "bricks" / "manifest.json").read_text())["histograms"])

        # Without its planes the same dataset is honestly format 1.
        shutil.rmtree(ds / "planes")
        step4.generate_catalog_metadata(self.tmp, ds)
        meta = json.loads((ds / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["formatVersion"], 1)

    def test_timelapse_one_tree_per_timepoint(self):
        W, H, D, C = 530, 140, 9, 1
        lod_levels = self._proc(W, H, D, C, 2)
        ds = self.tmp / "live" / "tl"
        ds.mkdir(parents=True)
        for t in range(2):
            _write_lods(self.tmp, t, lod_levels, C, np.random.default_rng(20 + t))
            levels, transport = step3.pack_timepoint(self.tmp, ds / "bricks", t, lod_levels, C,
                                                     _Serial(), f"t{t:03d}")
            (self.tmp / f"pack_t{t:03d}.json").write_text(json.dumps(
                {"levels": levels, "brickTransport": transport}))
        step3.build_packs(self.tmp, ds)
        manifest = json.loads((ds / "bricks" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(p.name for p in (ds / "planes").iterdir()), ["t000", "t001"])
        for t in range(2):
            key = f"t{t:03d}"
            self._check_tree(ds, key, manifest["timepoints"][key], (W, H, D), C, t)
        self.assertTrue(pw.planes_complete(ds))

    def test_incomplete_tree_is_refused(self):
        W, H, D, C = 100, 90, 5, 1
        lod_levels = self._proc(W, H, D, C, 1)
        _write_lods(self.tmp, 0, lod_levels, C, np.random.default_rng(3))
        ds = self.tmp / "3d" / "ds"
        ds.mkdir(parents=True)
        levels, transport = step3.pack_timepoint(self.tmp, ds / "bricks", 0, lod_levels, C,
                                                 _Serial(), "")
        (self.tmp / "pack_t000.json").write_text(json.dumps({"levels": levels,
                                                             "brickTransport": transport}))
        (ds / "planes" / "z00003.bin").unlink()
        with self.assertRaises(RuntimeError):
            step3.build_packs(self.tmp, ds)


@unittest.skipUnless(HAVE_DEPS, "preprocessing dependencies missing")
class FormatVersionNotCurated(unittest.TestCase):
    def test_merge_takes_the_fresh_value(self):
        existing = {"formatVersion": 1, "hidden": True, "name": "kept"}
        fresh = {"formatVersion": 2, "name": "new", "lastModified": "x"}
        self.assertNotIn("formatVersion", run_preprocess.CURATED_KEYS)
        merged = run_preprocess.merge_curated(existing, fresh)
        self.assertEqual((merged["formatVersion"], merged["hidden"], merged["name"]), (2, True, "kept"))
        self.assertEqual(step4.merge_volume_metadata(existing, fresh)["formatVersion"], 2)


@unittest.skipUnless(HAVE_DEPS, "preprocessing dependencies missing")
class Orchestrator(unittest.TestCase):
    def test_published_dataset_is_format_2(self):
        tmp = Path(tempfile.mkdtemp(prefix="lumen_mig_pipe_run_"))
        try:
            raw = tmp / "raw"
            raw.mkdir()
            out = tmp / "DATA_WEB"
            write_ims(raw / "Dll4-E10-5-Em3.ims", [[synthetic_volume((20, 90, 100), seed=5),
                                                     synthetic_volume((20, 90, 100), seed=6)]])
            env = dict(os.environ, LUMEN_PREPROCESS_WORKERS="2", LUMEN_PREPROCESS_TILE_MVOX="0.05")
            cmd = [sys.executable, str(PRE / "run_preprocess.py"), "--input", str(raw),
                   "--output", str(out), "--tracking", "off"]
            r = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=600)
            self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])
            ds = out / "3d" / "Dll4-E10-5-Em3"
            meta = json.loads((ds / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["formatVersion"], 2)
            self.assertTrue(pw.planes_complete(ds))
            first = {p.name: p.read_bytes() for p in (ds / "planes").glob("z*.bin")}
            self.assertEqual(len(first), 20)

            # A dataset migrated before its re-run: the run swaps planes/ like bricks/.
            meta["formatVersion"] = 1
            (ds / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
            (ds / "planes" / "stale.txt").write_text("old", encoding="utf-8")
            r = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=600)
            self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])
            meta = json.loads((ds / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["formatVersion"], 2)
            self.assertFalse((ds / "planes" / "stale.txt").exists())
            self.assertFalse(list(ds.glob("*.pre-swap")))
            self.assertEqual({p.name: p.read_bytes() for p in (ds / "planes").glob("z*.bin")}, first)
            self.assertTrue(pw.planes_complete(ds))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    if not HAVE_DEPS:
        print(f"SKIP test_mig_pipe_planes: {MISSING}")
    unittest.main()
