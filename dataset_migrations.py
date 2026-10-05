"""Dataset migrations — in-place format upgrades of published volume datasets.

Contract: DOCS/dataset-migrations/SPEC.md (normative). Twin: api/_migrations_lib.php.

A dataset carries `formatVersion` in its metadata.json (absent = 1). MIGRATIONS is the
ordered registry; each entry knows how to cut its work into independent UNITS so that
either executor can do them: the browser (it posts the encoded result of a unit, see
`unit_put`) or this server (`unit_run`, time-bounded calls). Units land in a tile store
under uploads/migrations/ (never served); `finalize` assembles the final structure next
to the dataset, swaps it in and bumps the version under the metadata lock.

Migration m002-planes (format 1 -> 2) re-cuts the native level of every brick tree into
XY planes: `planes/zNNNNN.bin` packs of greyscale PNG tiles (SPEC §3). The PURE format
functions of this module (png_gray8, decode_png_gray8, validate_png_gray8,
unmosaic_brick, decode_brick, cut_unit_planes, build_plane_pack, planes_manifest_bytes)
depend on the standard library only (numpy is used when present, for speed, with
identical output) so the standalone preprocessing pack can reuse them verbatim.

The server executor needs Pillow with WebP support to read the bricks; without it the
module still imports, and `server_capabilities()` reports the executor unavailable.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import struct
import tempfile
import threading
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

try:  # optional: vectorised paths, byte-identical results
    import numpy as _np
except Exception:  # pragma: no cover - exercised on hosts without numpy
    _np = None

try:  # optional: required by the server executor only
    from PIL import Image as _PILImage
except Exception:  # pragma: no cover
    _PILImage = None

try:
    import msvcrt as _msvcrt
except Exception:
    _msvcrt = None
try:
    import fcntl as _fcntl
except Exception:
    _fcntl = None


# ── Registry ───────────────────────────────────────────────────────────────────

LATEST = 2

MIGRATIONS = [
    {
        "id": "m002-planes",
        "from": 1,
        "to": 2,
        "types": ["3d", "live"],
        "title": {
            "en": "Plane-major copy of the native level (fast XY cuts in the Studio)",
            "fr": "Copie par plans du niveau natif (coupes XY rapides dans le Studio)",
            "es": "Copia por planos del nivel nativo (cortes XY rápidos en el Studio)",
            "nl": "Kopie per vlak van het native niveau (snelle XY-sneden in de Studio)",
        },
        "description": {
            "en": "Re-cuts the full-resolution bricks into XY planes stored beside them, so a "
                  "native XY cut reads one plane instead of a whole 64-slice brick layer. "
                  "The bricks are untouched; the result is lossless.",
            "fr": "Redécoupe les briques en pleine résolution en plans XY rangés à côté d'elles : "
                  "une coupe XY native lit un seul plan au lieu d'une couche entière de 64 "
                  "tranches. Les briques ne sont pas modifiées ; le résultat est sans perte.",
            "es": "Vuelve a cortar los ladrillos a resolución completa en planos XY guardados a "
                  "su lado: un corte XY nativo lee un solo plano en lugar de una capa entera de "
                  "64 cortes. Los ladrillos no se modifican; el resultado no tiene pérdidas.",
            "nl": "Snijdt de bricks op volledige resolutie opnieuw in XY-vlakken die ernaast "
                  "worden bewaard, zodat een native XY-snede één vlak leest in plaats van een "
                  "hele laag van 64 coupes. De bricks blijven onaangeroerd; het resultaat is "
                  "verliesvrij.",
        },
    },
]
_MIGRATIONS_BY_ID = {m["id"]: m for m in MIGRATIONS}

VOLUME_TYPES = ("3d", "live")
ALL_TYPES = ("3d", "2d", "live")


# ── Format constants (SPEC §3) ─────────────────────────────────────────────────

BRICK_SIZE = 64
TILE_SIZE = 512
BRICKS_PER_TILE = TILE_SIZE // BRICK_SIZE          # 8
PLANES_SCHEMA = "lumen-planes-v1"
PLANES_CODEC = "png-gray8"
PACK_PATTERN = "z{z}.bin"
PACK_MAGIC = b"LPLN"
PACK_VERSION = 1
PACK_HEADER_FIXED = 16
PACK_ENTRY_BYTES = 12
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_ZLIB_LEVEL = 6
MAX_UNIT_BODY = 32 * 1024 * 1024
MAX_RUN_SECONDS = 20
MAX_BENCH_UNITS = 8
# Disk budget of a new job. The PNG planes weigh about 1.3x the native WebP bricks
# they are cut from (measured on the lab's datasets); during finalize the tile store
# and the assembled packs coexist, so a job needs ~2.6x its LOD0 bytes at its peak
# on one volume. The reserve is the import's (upload_staging.DISK_RESERVE_BYTES).
PLANES_SIZE_RATIO = 1.3
DISK_RESERVE_BYTES = 512 * 1024 * 1024


class MigrationError(Exception):
    """A refusal with a stable reason code (the API's `error`) and an HTTP status."""

    def __init__(self, code: str, status: int = 400, detail: str | None = None,
                 extra: dict | None = None):
        super().__init__(detail or code)
        self.code = code
        self.status = status
        self.detail = detail
        self.extra = extra or {}


# ── Pure format functions (shared with the preprocessing pipeline) ─────────────

def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))


def png_gray8(width: int, height: int, data) -> bytes:
    """Encode `height` rows of `width` uint8 pixels (row-major, bytes-like or a numpy
    uint8 array) as the reference `png-gray8` tile of SPEC §3.3: signature, IHDR (depth 8,
    colour type 0), ONE IDAT (filter 0 = None on every row, zlib level 6), IEND.

    None rather than Sub: measured on 2264 real LOD0 tiles of five lab datasets, Sub made
    the tiles 4 % larger in total (up to 70 % on a sparse timelapse): shot noise dominates
    these planes and a horizontal difference doubles its entropy. preprocess/planes_writer.py
    is kept byte-identical to this function; the PHP twin makes the same choice."""
    width, height = int(width), int(height)
    if width < 1 or height < 1:
        raise ValueError("png_gray8: empty image")
    if _np is not None:
        if isinstance(data, _np.ndarray):
            a = _np.ascontiguousarray(data, dtype=_np.uint8).reshape(-1)
        else:
            a = _np.frombuffer(bytes(data), dtype=_np.uint8)
        if a.size != width * height:
            raise ValueError("png_gray8: %d bytes for %dx%d" % (a.size, width, height))
        filt = _np.zeros((height, width + 1), dtype=_np.uint8)
        filt[:, 1:] = a.reshape(height, width)
        raw = filt.tobytes()
    else:
        mv = bytes(data)
        if len(mv) != width * height:
            raise ValueError("png_gray8: %d bytes for %dx%d" % (len(mv), width, height))
        raw = b"".join(b"\x00" + mv[y * width:(y + 1) * width] for y in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return (PNG_SIGNATURE + _png_chunk(b"IHDR", ihdr)
            + _png_chunk(b"IDAT", zlib.compress(raw, PNG_ZLIB_LEVEL)) + _png_chunk(b"IEND", b""))


def _png_chunks(png: bytes):
    """(type, data) of every chunk, CRC-checked; ValueError on any structural fault."""
    if len(png) < 8 or png[:8] != PNG_SIGNATURE:
        raise ValueError("not a PNG (signature)")
    pos, n, out = 8, len(png), []
    while pos < n:
        if pos + 12 > n:
            raise ValueError("truncated chunk")
        length = struct.unpack_from(">I", png, pos)[0]
        kind = png[pos + 4:pos + 8]
        end = pos + 12 + length
        if length > 0x7FFFFFFF or end > n:
            raise ValueError("chunk overruns the file")
        data = png[pos + 8:pos + 8 + length]
        crc = struct.unpack_from(">I", png, pos + 8 + length)[0]
        if zlib.crc32(kind + data) & 0xFFFFFFFF != crc:
            raise ValueError("bad CRC in %r" % kind)
        out.append((bytes(kind), data))
        pos = end
        if kind == b"IEND":
            break
    if not out or out[-1][0] != b"IEND":
        raise ValueError("missing IEND")
    if pos != n:
        raise ValueError("bytes after IEND")
    return out


def png_ihdr(png: bytes):
    """(width, height, bitDepth, colourType, compression, filter, interlace) from the
    IHDR that must be the first chunk; ValueError otherwise. Reads 33 bytes only."""
    if len(png) < 33 or png[:8] != PNG_SIGNATURE or png[12:16] != b"IHDR":
        raise ValueError("no IHDR")
    if struct.unpack_from(">I", png, 8)[0] != 13:
        raise ValueError("bad IHDR length")
    return struct.unpack_from(">IIBBBBB", png, 16)


def validate_png_gray8(png: bytes, width: int, height: int) -> bool:
    """Full structural check of a `png-gray8` tile of the expected size: signature,
    IHDR first (8-bit greyscale, no interlace), only IHDR/IDAT/IEND chunks (no colour
    management chunk may reach a browser), every CRC, an inflatable IDAT stream of
    exactly height·(width+1) bytes with filter types 0..4. Returns True when every
    pixel is zero (the tile is then stored as length 0). ValueError when invalid."""
    chunks = _png_chunks(png)
    if chunks[0][0] != b"IHDR":
        raise ValueError("IHDR is not first")
    w, h, depth, ctype, comp, filt, inter = png_ihdr(png)
    if (w, h) != (int(width), int(height)):
        raise ValueError("IHDR %dx%d, expected %dx%d" % (w, h, width, height))
    if depth != 8 or ctype != 0 or comp != 0 or filt != 0 or inter != 0:
        raise ValueError("not an 8-bit non-interlaced greyscale PNG")
    idat = []
    for kind, data in chunks[1:]:
        if kind == b"IDAT":
            idat.append(data)
        elif kind != b"IEND":
            raise ValueError("chunk %r not allowed" % kind)
    if not idat:
        raise ValueError("no IDAT")
    expected = h * (w + 1)
    dec = zlib.decompressobj()
    try:
        raw = dec.decompress(b"".join(idat), expected + 1)
    except zlib.error as exc:
        raise ValueError("IDAT does not inflate: %s" % exc)
    if len(raw) != expected or dec.unconsumed_tail or not dec.eof:
        raise ValueError("IDAT holds %d bytes, expected %d" % (len(raw), expected))
    # With every filter type, all-zero pixels filter to all-zero bytes and vice versa
    # (each reconstruction adds the filtered byte to a predictor of zeros).
    if _np is not None:
        arr = _np.frombuffer(raw, dtype=_np.uint8).reshape(h, w + 1)
        if int(arr[:, 0].max()) > 4:
            raise ValueError("bad filter type")
        return not bool(arr[:, 1:].any())
    zero = True
    stride = w + 1
    for y in range(h):
        if raw[y * stride] > 4:
            raise ValueError("bad filter type")
        if zero and raw.count(0, y * stride + 1, (y + 1) * stride) != w:
            zero = False
    return zero


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def decode_png_gray8(png: bytes):
    """(width, height, pixels bytes) of an 8-bit greyscale non-interlaced PNG, any filter."""
    chunks = _png_chunks(png)
    w, h, depth, ctype, comp, filt, inter = png_ihdr(png)
    if depth != 8 or ctype != 0 or inter != 0:
        raise ValueError("not an 8-bit non-interlaced greyscale PNG")
    raw = zlib.decompress(b"".join(d for k, d in chunks if k == b"IDAT"))
    stride = w + 1
    if len(raw) != h * stride:
        raise ValueError("IDAT size mismatch")
    out = bytearray(w * h)
    prev = bytearray(w)
    for y in range(h):
        ft = raw[y * stride]
        line = raw[y * stride + 1:(y + 1) * stride]
        if ft == 0:
            cur = bytearray(line)
        elif ft == 1 and _np is not None:
            cur = bytearray(_np.cumsum(_np.frombuffer(line, dtype=_np.uint8), dtype=_np.uint8).tobytes())
        elif ft == 2 and _np is not None:
            cur = bytearray((_np.frombuffer(line, dtype=_np.uint8) + _np.frombuffer(bytes(prev), dtype=_np.uint8)).tobytes())
        else:
            cur = bytearray(w)
            for x in range(w):
                a = cur[x - 1] if x else 0
                b = prev[x]
                c = prev[x - 1] if x else 0
                v = line[x]
                if ft == 1:
                    v += a
                elif ft == 2:
                    v += b
                elif ft == 3:
                    v += (a + b) >> 1
                elif ft == 4:
                    v += _paeth(a, b, c)
                elif ft != 0:
                    raise ValueError("bad filter type %d" % ft)
                cur[x] = v & 0xFF
        out[y * w:(y + 1) * w] = cur
        prev = cur
    return w, h, bytes(out)


def unmosaic_brick(mosaic: bytes, mosaic_width: int, mosaic_height: int,
                   brick_size: int = BRICK_SIZE, cols: int = 8) -> bytes:
    """The brick_size³ voxels (z-major, then y, then x) of a grid mosaic, exactly as
    js/core/brick-decode-worker.js reads it: tile (tx, ty) holds z = ty·cols + tx and
    voxel (x, y, z) is mosaic pixel (tx·bs + x, ty·bs + y). `mosaic` is ONE byte per
    pixel (the R channel the decoder reads); pixels outside a truncated mosaic are 0."""
    bs, cols = int(brick_size), int(cols)
    rows = -(-bs // cols)
    need_w, need_h = cols * bs, rows * bs
    mw, mh = int(mosaic_width), int(mosaic_height)
    if len(mosaic) != mw * mh:
        raise ValueError("mosaic holds %d bytes, expected %dx%d" % (len(mosaic), mw, mh))
    if _np is not None:
        m = _np.frombuffer(mosaic, dtype=_np.uint8).reshape(mh, mw)
        if mw < need_w or mh < need_h:
            padded = _np.zeros((max(mh, need_h), max(mw, need_w)), dtype=_np.uint8)
            padded[:mh, :mw] = m
            m = padded
        cube = (m[:need_h, :need_w].reshape(rows, bs, cols, bs)
                .transpose(0, 2, 1, 3).reshape(rows * cols, bs, bs)[:bs])
        return _np.ascontiguousarray(cube).tobytes()
    if mw < need_w or mh < need_h:
        pw, ph = max(mw, need_w), max(mh, need_h)
        padded = bytearray(pw * ph)
        for y in range(mh):
            padded[y * pw:y * pw + mw] = mosaic[y * mw:(y + 1) * mw]
        mosaic, mw = bytes(padded), pw
    out = bytearray(bs * bs * bs)
    pos = 0
    for z in range(bs):
        top, left = (z // cols) * bs, (z % cols) * bs
        for y in range(bs):
            start = (top + y) * mw + left
            out[pos:pos + bs] = mosaic[start:start + bs]
            pos += bs
    return bytes(out)


def decode_brick(raw: bytes, encoding: str | None = "webp-lossless", packing: dict | None = None,
                 brick_size: int = BRICK_SIZE) -> bytes:
    """Voxels (z, y, x; brick_size³ bytes) of one stored brick channel.

    webp-lossless (and a legacy manifest without transport): decoded with Pillow,
    R channel, un-mosaicked like the browser decoder. raw-u8 / raw-u8-gzip: the
    voxels themselves. Raises ValueError on anything the viewer would not mount."""
    bs = int(brick_size)
    whole = bs * bs * bs
    if encoding in ("raw-u8", "raw-u8-gzip"):
        data = raw if encoding == "raw-u8" else gzip.decompress(raw)
        if len(data) != whole:
            raise ValueError("raw brick holds %d bytes, expected %d" % (len(data), whole))
        return bytes(data)
    if encoding not in (None, "webp-lossless"):
        raise ValueError("unsupported brick encoding %r" % encoding)
    packing = packing or {}
    if packing.get("mode") != "grid":
        raise ValueError("unsupported brick packing %r" % packing.get("mode"))
    cols = packing.get("cols")
    if isinstance(cols, bool) or not isinstance(cols, int) or cols < 1:
        cols = -(-bs // _ceil_sqrt(bs))   # the decoder's default: 8 for 64
    if _PILImage is None:
        raise ValueError("Pillow is not installed")
    with _PILImage.open(io.BytesIO(raw)) as im:
        im.load()
        if im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info:
            alpha = im.getchannel("A") if im.mode in ("RGBA", "LA", "PA") else im.convert("RGBA").getchannel("A")
            lo, _hi = alpha.getextrema()
            if lo != 255:
                # A canvas round-trips a translucent pixel through premultiplied alpha:
                # the browser's value is not the stored one, so no exact copy exists.
                raise ValueError("brick mosaic carries transparency")
        if im.mode == "L":
            band = im
        elif im.mode in ("RGB", "RGBA"):
            band = im.getchannel(0)
        else:
            band = im.convert("RGB").getchannel(0)
        w, h = band.size
        mosaic = band.tobytes()
    return unmosaic_brick(mosaic, w, h, bs, cols)


def _ceil_sqrt(n: int) -> int:
    r = int(n ** 0.5)
    while r * r < n:
        r += 1
    while r > 0 and (r - 1) * (r - 1) >= n:
        r -= 1
    return r


def cut_unit_planes(bricks: dict, tile_width: int, tile_height: int, depth: int,
                    brick_size: int = BRICK_SIZE):
    """The `depth` XY planes (each tile_height·tile_width bytes, row-major) of one unit:
    `bricks` maps (bx_local, by_local) -> brick voxels (z, y, x) for the bricks that
    exist; every other voxel is 0. Brick (i, j) covers tile columns [i·bs, i·bs+bs) and
    rows [j·bs, j·bs+bs), cropped to the tile; plane k is brick slice z = k."""
    bs = int(brick_size)
    w, h, depth = int(tile_width), int(tile_height), int(depth)
    if _np is not None:
        stack = _np.zeros((depth, h, w), dtype=_np.uint8)
        for (i, j), vox in bricks.items():
            x0, y0 = i * bs, j * bs
            if x0 >= w or y0 >= h:
                continue
            cw, ch = min(bs, w - x0), min(bs, h - y0)
            cube = _np.frombuffer(vox, dtype=_np.uint8).reshape(bs, bs, bs)
            stack[:, y0:y0 + ch, x0:x0 + cw] = cube[:depth, :ch, :cw]
        return [stack[k] for k in range(depth)]
    planes = [bytearray(w * h) for _ in range(depth)]
    for (i, j), vox in bricks.items():
        x0, y0 = i * bs, j * bs
        if x0 >= w or y0 >= h:
            continue
        cw, ch = min(bs, w - x0), min(bs, h - y0)
        for k in range(depth):
            plane = planes[k]
            for y in range(ch):
                src = (k * bs + y) * bs
                dst = (y0 + y) * w + x0
                plane[dst:dst + cw] = vox[src:src + cw]
    return planes


def plane_is_zero(plane) -> bool:
    if _np is not None and isinstance(plane, _np.ndarray):
        return not bool(plane.any())
    return bytes(plane).count(0) == len(plane)


def plane_bytes(plane) -> bytes:
    if _np is not None and isinstance(plane, _np.ndarray):
        return plane.tobytes()
    return bytes(plane)


def pack_header_bytes(channels: int, tiles_x: int, tiles_y: int) -> int:
    return PACK_HEADER_FIXED + PACK_ENTRY_BYTES * int(channels) * int(tiles_y) * int(tiles_x)


def build_plane_pack(z: int, channels: int, tiles_x: int, tiles_y: int, tiles) -> bytes:
    """One `zNNNNN.bin` (SPEC §3.2). `tiles` lists C·TY·TX payloads in entry order
    (c-major, then ty, then tx); None or b"" is an all-zero tile (length 0, offset 0)."""
    channels, tiles_x, tiles_y = int(channels), int(tiles_x), int(tiles_y)
    n = channels * tiles_y * tiles_x
    tiles = list(tiles)
    if len(tiles) != n:
        raise ValueError("build_plane_pack: %d tiles, expected %d" % (len(tiles), n))
    head = bytearray(struct.pack("<4sHHHHI", PACK_MAGIC, PACK_VERSION, channels, tiles_x, tiles_y, int(z)))
    offset = pack_header_bytes(channels, tiles_x, tiles_y)
    for payload in tiles:
        length = len(payload) if payload else 0
        head += struct.pack("<QI", offset if length else 0, length)
        offset += length
    return bytes(head) + b"".join(p for p in tiles if p)


def parse_plane_pack(data: bytes):
    """(z, channels, tilesX, tilesY, [(offset, length)…]) of a plane pack; ValueError."""
    if len(data) < PACK_HEADER_FIXED or data[:4] != PACK_MAGIC:
        raise ValueError("not a plane pack")
    _m, ver, c, tx, ty, z = struct.unpack_from("<4sHHHHI", data, 0)
    if ver != PACK_VERSION:
        raise ValueError("plane pack version %d" % ver)
    n = c * ty * tx
    hb = pack_header_bytes(c, tx, ty)
    if len(data) < hb:
        raise ValueError("truncated plane pack header")
    entries = [struct.unpack_from("<QI", data, PACK_HEADER_FIXED + PACK_ENTRY_BYTES * i) for i in range(n)]
    for off, length in entries:
        if length and (off < hb or off + length > len(data)):
            raise ValueError("tile outside the pack")
    return z, c, tx, ty, entries


def planes_manifest(dimensions: dict, channels: int, source_sha256: str, producer: str,
                    created_at: str | None = None) -> dict:
    """The per-tree `planes/manifest.json` document of SPEC §3.1, keys in spec order."""
    x, y, z = int(dimensions["x"]), int(dimensions["y"]), int(dimensions["z"])
    tx, ty = -(-x // TILE_SIZE), -(-y // TILE_SIZE)
    return {
        "schema": PLANES_SCHEMA,
        "formatVersion": 2,
        "level": 0,
        "dimensions": {"x": x, "y": y, "z": z},
        "channels": int(channels),
        "tileSize": TILE_SIZE,
        "tiles": {"x": tx, "y": ty},
        "codec": PLANES_CODEC,
        "packPattern": PACK_PATTERN,
        "headerBytes": pack_header_bytes(channels, tx, ty),
        "source": {"manifestSha256": str(source_sha256)},
        "producer": producer,
        "createdAt": created_at or _utc_iso(),
    }


def planes_manifest_bytes(doc: dict) -> bytes:
    return json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def pack_name(z: int) -> str:
    return "z%05d.bin" % int(z)


def _as_int(v, default: int) -> int:
    """A request number (int, float or decimal string) as an int, else `default`."""
    if isinstance(v, bool):
        return default
    try:
        return int(v)
    except (TypeError, ValueError, OverflowError):
        try:
            f = float(v)
        except (TypeError, ValueError):
            return default
        return int(f) if f == f and abs(f) < 1e15 else default


def _as_seconds(v):
    """A positive finite number of seconds, or None."""
    if isinstance(v, bool) or v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and 0 < f < 1e9 else None


def _utc_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── Paths, locks, atomic writes ────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parent
DATA_WEB = ROOT / "DATA_WEB"
UPLOADS_DIR = ROOT / "uploads"
MIGRATIONS_DIR = UPLOADS_DIR / "migrations"
_META_LOCK = threading.RLock()
_ON_METADATA_CHANGE = None
# \Z, not $ ("$" also matches before a trailing newline), and ASCII digits only: the
# PHP twin's /D-anchored [0-9]-equivalent patterns accept exactly the same strings.
_SAFE_FOLDER_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*\Z", re.ASCII)
_SAFE_TREE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}\Z", re.ASCII)
_UNIT_RE = re.compile(r"^t(\d{1,6})\.z(\d{1,5})\.c(\d{1,3})\.y(\d{1,4})\.x(\d{1,4})\Z", re.ASCII)
_BRICK_KEY_RE = re.compile(r"^lod0/c(\d{1,3})/x(\d{3,})_y(\d{3,})_z(\d{3,})\.webp\Z", re.ASCII)
_TMP_PREFIX = ".lumen-tmp-"
# Mode of the files written INTO DATA_WEB (plane packs, their manifest, the bumped
# metadata.json). mkstemp creates 0600 files: a separate static server (Apache, nginx)
# reading the published tree could not serve them, and a dataset whose metadata.json
# it cannot read vanishes. The dev server passes its own _file_mode(); the journal and
# the tile store under uploads/ keep 0600.
_PUBLIC_FILE_MODE = 0o644


def configure(root, *, meta_lock=None, on_metadata_change=None, data_web=None, uploads_dir=None,
              file_mode=None) -> None:
    """Point the module at a deployment root (dev server, tests). `meta_lock` is the
    server's metadata.json lock, so a version bump never interleaves with an edit;
    `file_mode` the POSIX mode of the files it publishes under DATA_WEB."""
    global ROOT, DATA_WEB, UPLOADS_DIR, MIGRATIONS_DIR, _META_LOCK, _ON_METADATA_CHANGE, _PUBLIC_FILE_MODE
    ROOT = Path(root).resolve()
    DATA_WEB = Path(data_web).resolve() if data_web else ROOT / "DATA_WEB"
    UPLOADS_DIR = Path(uploads_dir).resolve() if uploads_dir else ROOT / "uploads"
    MIGRATIONS_DIR = UPLOADS_DIR / "migrations"
    if meta_lock is not None:
        _META_LOCK = meta_lock
    _ON_METADATA_CHANGE = on_metadata_change
    if file_mode is not None:
        _PUBLIC_FILE_MODE = int(file_mode)
    with _CACHE_LOCK:
        _PLAN_CACHE.clear()
        _SHA_CACHE.clear()


def _replace_retry(src, dst, attempts: int = 10, delay: float = 0.04) -> None:
    for i in range(attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(delay * (i + 1))


def _atomic_write(path: Path, data: bytes, public: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=_TMP_PREFIX)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        if public and os.name == "posix":
            os.chmod(tmp, _PUBLIC_FILE_MODE)
        _replace_retry(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _rmtree(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
        if path.exists():  # a reader held a file open on Windows: one more try
            time.sleep(0.2)
            shutil.rmtree(path, ignore_errors=True)


_LOCKS: dict = {}
_LOCKS_GUARD = threading.Lock()


def _thread_lock(key: str) -> threading.Lock:
    with _LOCKS_GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = _LOCKS[key] = threading.Lock()
        return lock


class _JobLock:
    """In-process lock + an exclusive OS lock on `<job>.lock`, so two server processes
    (or a PHP request beside a Python one on the same tree) never interleave the
    read-modify-write of one journal."""

    def __init__(self, base: str):
        self._thread = _thread_lock("job:" + base)
        self._path = MIGRATIONS_DIR / (base + ".lock")
        self._fh = None

    def __enter__(self):
        self._thread.acquire()
        try:
            MIGRATIONS_DIR.mkdir(parents=True, exist_ok=True)
            self._fh = open(self._path, "a+b")
            if _fcntl is not None:
                _fcntl.flock(self._fh.fileno(), _fcntl.LOCK_EX)
            elif _msvcrt is not None:
                self._fh.seek(0)
                while True:
                    try:
                        _msvcrt.locking(self._fh.fileno(), _msvcrt.LK_LOCK, 1)
                        break
                    except OSError:
                        time.sleep(0.05)
        except Exception:
            if self._fh is not None:
                self._fh.close()
                self._fh = None
        return self

    def __exit__(self, *exc):
        try:
            if self._fh is not None:
                try:
                    if _fcntl is not None:
                        _fcntl.flock(self._fh.fileno(), _fcntl.LOCK_UN)
                    elif _msvcrt is not None:
                        self._fh.seek(0)
                        _msvcrt.locking(self._fh.fileno(), _msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
                self._fh.close()
                self._fh = None
        finally:
            self._thread.release()
        return False


# ── Dataset resolution and the plan of a migration ─────────────────────────────

def _resolve_dataset(dataset_id, must_exist: bool = True) -> tuple[str, str, Path]:
    if not isinstance(dataset_id, str) or "/" not in dataset_id:
        raise MigrationError("bad_dataset")
    type_dir, folder = dataset_id.split("/", 1)
    if type_dir not in ALL_TYPES or folder in (".", "..") or not _SAFE_FOLDER_RE.match(folder):
        raise MigrationError("bad_dataset")
    base = (DATA_WEB / type_dir).resolve()
    ds_dir = (base / folder).resolve()
    try:
        ds_dir.relative_to(base)
    except ValueError:
        raise MigrationError("bad_dataset")
    if must_exist and not ds_dir.is_dir():
        raise MigrationError("no_dataset", 404)
    return type_dir, folder, ds_dir


def _read_metadata(ds_dir: Path) -> dict:
    try:
        meta = json.loads((ds_dir / "metadata.json").read_text(encoding="utf-8"))
    except Exception:
        return {}
    return meta if isinstance(meta, dict) else {}


def format_version(meta: dict) -> int:
    v = meta.get("formatVersion") if isinstance(meta, dict) else None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
        return 1
    v = int(v)
    return v if v >= 1 else 1


_CACHE_LOCK = threading.Lock()
_SHA_CACHE: dict = {}    # path -> (mtime_ns, size, sha)
_PLAN_CACHE: dict = {}   # ds_dir -> (mtime_ns, size, Plan)


def _manifest_sha(path: Path) -> str:
    st = path.stat()
    key = str(path)
    with _CACHE_LOCK:
        hit = _SHA_CACHE.get(key)
        if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
            return hit[2]
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    sha = h.hexdigest()
    with _CACHE_LOCK:
        _SHA_CACHE[key] = (st.st_mtime_ns, st.st_size, sha)
    return sha


class Tree:
    """One brick tree: `bricks/` of a 3d dataset or `bricks/tNNN/` of a timelapse."""

    __slots__ = ("t", "rel", "bricks_dir", "dims", "channels", "encoding", "packing",
                 "index", "nbx", "nby", "nbz", "tiles_x", "tiles_y")


class Plan:
    __slots__ = ("dataset", "type", "folder", "ds_dir", "manifest_path", "sha", "trees",
                 "units", "unit_bytes", "total", "empty")


def _int_dim(v) -> int:
    if isinstance(v, bool):
        raise ValueError("dimension")
    iv = int(v)
    if iv != v or iv < 1 or iv > 1 << 20:
        raise ValueError("dimension")
    return iv


def _safe_rel_file(base: Path, rel) -> Path:
    s = str(rel or "").replace("\\", "/").lstrip("/")
    parts = s.split("/")
    if not s or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", s) or any(p in ("", ".", "..") for p in parts):
        raise ValueError("unsafe pack url %r" % rel)
    return base.joinpath(*parts)


def _build_tree(t: int, rel: str, bricks_dir: Path, levels, channels, transport, packing) -> Tree:
    if not isinstance(levels, list) or not levels or not isinstance(levels[0], dict):
        raise ValueError("levels")
    lod0 = levels[0]
    if lod0.get("level", 0) != 0:
        raise ValueError("levels[0] is not level 0")
    if lod0.get("brickSize", BRICK_SIZE) != BRICK_SIZE:
        raise ValueError("brickSize")
    d = lod0.get("dimensions") or {}
    tree = Tree()
    tree.t, tree.rel, tree.bricks_dir = t, rel, bricks_dir
    tree.dims = (_int_dim(d.get("x")), _int_dim(d.get("y")), _int_dim(d.get("z")))
    tree.channels = int(channels)
    if tree.channels < 1 or tree.channels > 64:
        raise ValueError("channels")
    tree.nbx, tree.nby, tree.nbz = (-(-n // BRICK_SIZE) for n in tree.dims)
    tree.tiles_x, tree.tiles_y = -(-tree.dims[0] // TILE_SIZE), -(-tree.dims[1] // TILE_SIZE)
    transport = transport if isinstance(transport, dict) else {}
    tree.encoding = transport.get("encoding")
    tree.packing = packing if isinstance(packing, dict) else {}
    if tree.encoding not in (None, "webp-lossless", "raw-u8", "raw-u8-gzip"):
        raise ValueError("unsupported encoding %r" % tree.encoding)
    if tree.encoding in (None, "webp-lossless") and tree.packing.get("mode") != "grid":
        raise ValueError("webp bricks need brickPacking.mode grid")
    index = {}
    b2p = transport.get("brickToPack")
    ext = {"raw-u8": ".bin", "raw-u8-gzip": ".bin.gz"}.get(tree.encoding, ".webp")
    if isinstance(b2p, dict) and b2p:
        for key, entry in b2p.items():
            m = _BRICK_KEY_RE.match(str(key).lstrip("/"))
            if not m or not isinstance(entry, dict):
                continue
            c, bx, by, bz = (int(g) for g in m.groups())
            if c >= tree.channels or bx >= tree.nbx or by >= tree.nby or bz >= tree.nbz:
                continue
            off, length = entry.get("offset"), entry.get("length")
            if isinstance(off, bool) or isinstance(length, bool):
                continue
            off, length = int(off), int(length)
            if off < 0 or length <= 0:
                continue
            index[(c, bx, by, bz)] = (_safe_rel_file(bricks_dir, entry.get("url")), off, length)
    else:
        # A manifest without a pack index: one file per brick, present when it exists.
        for c in range(tree.channels):
            cdir = bricks_dir / "lod0" / ("c%d" % c)
            if not cdir.is_dir():
                continue
            for name in os.listdir(cdir):
                if not name.endswith(ext):
                    continue
                m = re.match(r"^x(\d{3,})_y(\d{3,})_z(\d{3,})" + re.escape(ext) + "$", name)
                if not m:
                    continue
                bx, by, bz = (int(g) for g in m.groups())
                if bx < tree.nbx and by < tree.nby and bz < tree.nbz:
                    p = cdir / name
                    index[(c, bx, by, bz)] = (p, 0, p.stat().st_size)
    tree.index = index
    return tree


def _frame_number(key: str, fallback: int) -> int:
    m = re.match(r"^t(\d{1,6})$", str(key))
    return int(m.group(1)) if m else fallback


def _plan_for(dataset_id: str) -> Plan:
    """The unit plan of a volume dataset, cached while its bricks manifest is unchanged."""
    type_dir, folder, ds_dir = _resolve_dataset(dataset_id)
    if type_dir not in VOLUME_TYPES:
        raise MigrationError("not_applicable", 409)
    manifest_path = ds_dir / "bricks" / "manifest.json"
    try:
        st = manifest_path.stat()
    except OSError:
        raise MigrationError("no_manifest", 409)
    cache_key = str(ds_dir)
    with _CACHE_LOCK:
        hit = _PLAN_CACHE.get(cache_key)
        if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
            return hit[2]
    try:
        raw = manifest_path.read_bytes()
        manifest = json.loads(raw.decode("utf-8"))
        if not isinstance(manifest, dict):
            raise ValueError("manifest is not an object")
        if manifest.get("brickSize", BRICK_SIZE) != BRICK_SIZE:
            raise ValueError("brickSize")
        packing = manifest.get("brickPacking")
        trees = []
        bricks_root = ds_dir / "bricks"
        tps = manifest.get("timepoints")
        if type_dir == "live" and isinstance(tps, dict) and tps:
            rows = sorted(((_frame_number(k, i), k, v) for i, (k, v) in enumerate(tps.items())),
                          key=lambda r: r[0])
            seen = set()
            for t, key, row in rows:
                if not isinstance(row, dict):
                    raise ValueError("timepoint %s" % key)
                rel = str(row.get("path") or key)
                if not _SAFE_TREE_RE.match(rel) or t in seen:
                    raise ValueError("timepoint path %r" % rel)
                seen.add(t)
                trees.append(_build_tree(
                    t, rel, bricks_root / rel,
                    row.get("levels") or manifest.get("levels"),
                    row.get("channels") or manifest.get("channels") or 1,
                    row.get("brickTransport") if isinstance(row.get("brickTransport"), dict)
                    else manifest.get("brickTransport"),
                    packing))
        else:
            trees.append(_build_tree(0, "", bricks_root, manifest.get("levels"),
                                     manifest.get("channels") or 1,
                                     manifest.get("brickTransport"), packing))
    except MigrationError:
        raise
    except Exception as exc:
        raise MigrationError("manifest_invalid", 409, str(exc))
    plan = Plan()
    plan.dataset, plan.type, plan.folder, plan.ds_dir = f"{type_dir}/{folder}", type_dir, folder, ds_dir
    plan.manifest_path = manifest_path
    plan.sha = hashlib.sha256(raw).hexdigest()
    with _CACHE_LOCK:
        _SHA_CACHE[str(manifest_path)] = (st.st_mtime_ns, st.st_size, plan.sha)
    plan.trees = {tree.t: tree for tree in trees}
    unit_bytes = {}
    total = 0
    for tree in trees:
        total += tree.nbz * tree.channels * tree.tiles_y * tree.tiles_x
        for (c, bx, by, bz), (_p, _o, length) in tree.index.items():
            k = (tree.t, bz, c, by // BRICKS_PER_TILE, bx // BRICKS_PER_TILE)
            unit_bytes[k] = unit_bytes.get(k, 0) + length
    plan.units = sorted(unit_bytes)
    plan.unit_bytes = unit_bytes
    plan.total = total
    plan.empty = total - len(plan.units)
    with _CACHE_LOCK:
        _PLAN_CACHE[cache_key] = (st.st_mtime_ns, st.st_size, plan)
    return plan


def unit_key(t: int, bz: int, c: int, ty: int, tx: int) -> str:
    return f"t{t}.z{bz}.c{c}.y{ty}.x{tx}"


def parse_unit_key(key) -> tuple:
    m = _UNIT_RE.match(str(key or ""))
    if not m:
        raise MigrationError("bad_unit")
    return tuple(int(g) for g in m.groups())


def _unit_geometry(plan: Plan, unit: tuple):
    t, bz, c, ty, tx = unit
    tree = plan.trees.get(t)
    if tree is None or bz >= tree.nbz or c >= tree.channels or ty >= tree.tiles_y or tx >= tree.tiles_x:
        raise MigrationError("bad_unit")
    X, Y, Z = tree.dims
    w = min(TILE_SIZE, X - tx * TILE_SIZE)
    h = min(TILE_SIZE, Y - ty * TILE_SIZE)
    z0 = bz * BRICK_SIZE
    depth = min(BRICK_SIZE, Z - z0)
    return tree, w, h, z0, depth


def process_unit(plan: Plan, unit: tuple):
    """Server executor for one unit: read its bricks from the packs, decode, cut the
    planes, encode the non-zero tiles. Returns ({z: png}, bytes_read)."""
    t, bz, c, ty, tx = unit
    tree, w, h, z0, depth = _unit_geometry(plan, unit)
    refs = []
    for j in range(BRICKS_PER_TILE):
        by = ty * BRICKS_PER_TILE + j
        if by >= tree.nby:
            break
        for i in range(BRICKS_PER_TILE):
            bx = tx * BRICKS_PER_TILE + i
            if bx >= tree.nbx:
                break
            ref = tree.index.get((c, bx, by, bz))
            if ref is not None:
                refs.append((i, j, ref))
    bricks, bytes_read = {}, 0
    by_file: dict = {}
    for i, j, (path, off, length) in refs:
        by_file.setdefault(path, []).append((off, length, i, j))
    for path, items in by_file.items():
        items.sort()
        try:
            fh = open(path, "rb")
        except OSError:
            raise MigrationError("brick_unreadable", 500, f"{path.name}: missing")
        with fh:
            for off, length, i, j in items:
                fh.seek(off)
                raw = fh.read(length)
                if len(raw) != length:
                    raise MigrationError("brick_unreadable", 500, f"{path.name}@{off}: short read")
                bytes_read += length
                try:
                    bricks[(i, j)] = decode_brick(raw, tree.encoding, tree.packing)
                except Exception as exc:
                    raise MigrationError("brick_undecodable", 500,
                                         f"c{c} x{tx * 8 + i} y{ty * 8 + j} z{bz}: {exc}")
    tiles = {}
    if bricks:
        for k, plane in enumerate(cut_unit_planes(bricks, w, h, depth)):
            if not plane_is_zero(plane):
                tiles[z0 + k] = png_gray8(w, h, plane_bytes(plane))
    return tiles, bytes_read


# ── Planes validity (repair detection) ─────────────────────────────────────────

def _tree_planes_dir(ds_dir: Path, tree: Tree, root_name: str = "planes") -> Path:
    base = ds_dir / root_name
    return base / tree.rel if tree.rel else base


def tree_planes_valid(plan: Plan, tree: Tree, root_name: str = "planes") -> bool:
    d = _tree_planes_dir(plan.ds_dir, tree, root_name)
    try:
        doc = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    except Exception:
        return False
    if not isinstance(doc, dict):
        return False
    X, Y, Z = tree.dims
    expect = planes_manifest({"x": X, "y": Y, "z": Z}, tree.channels, plan.sha, "")
    for key in ("schema", "formatVersion", "level", "dimensions", "channels", "tileSize",
                "tiles", "codec", "packPattern", "headerBytes"):
        if doc.get(key) != expect[key]:
            return False
    if (doc.get("source") or {}).get("manifestSha256") != plan.sha:
        return False
    try:
        names = set(os.listdir(d))
    except OSError:
        return False
    return all(pack_name(z) in names for z in range(Z))


def dataset_planes_valid(plan: Plan, root_name: str = "planes") -> bool:
    return all(tree_planes_valid(plan, tree, root_name) for tree in plan.trees.values())


# ── Journal and tile store ─────────────────────────────────────────────────────

def _job_base(plan_or_type, folder=None, mid=None) -> str:
    if isinstance(plan_or_type, Plan):
        return f"{plan_or_type.type}__{plan_or_type.folder}__{mid}"
    return f"{plan_or_type}__{folder}__{mid}"


def journal_path(type_dir: str, folder: str, mid: str) -> Path:
    return MIGRATIONS_DIR / f"{type_dir}__{folder}__{mid}.json"


def tile_store_dir(type_dir: str, folder: str, mid: str) -> Path:
    return MIGRATIONS_DIR / f"{type_dir}__{folder}__{mid}"


def tile_path(store: Path, unit: tuple, z: int) -> Path:
    t, _bz, c, ty, tx = unit
    return store / f"t{t}" / f"z{z}" / f"c{c}.y{ty}.x{tx}.png"


def _load_journal(path: Path):
    try:
        j = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except Exception:
        raise MigrationError("journal_corrupt", 500)
    return j if isinstance(j, dict) else None


def _save_journal(path: Path, j: dict) -> None:
    j["updatedAt"] = _utc_iso()
    _atomic_write(path, json.dumps(j, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def _summary(j: dict, plan: Plan | None = None) -> dict:
    units = j.get("units") or {}
    done = len(j.get("done") or []) + int(units.get("empty") or 0)
    out = {
        "migration": j.get("migration"), "dataset": j.get("dataset"), "state": j.get("state"),
        "total": int(units.get("total") or 0), "empty": int(units.get("empty") or 0),
        "done": done, "executors": j.get("executors") or {"browser": 0, "server": 0},
        "createdAt": j.get("createdAt"), "updatedAt": j.get("updatedAt"),
    }
    if j.get("error"):
        out["error"] = j["error"]
    if j.get("assembly"):
        out["assembly"] = j["assembly"]
    if plan is not None:
        done_set = set(j.get("done") or [])
        out["bytesRemaining"] = sum(b for u, b in plan.unit_bytes.items() if unit_key(*u) not in done_set)
    return out


def _migration(mid) -> dict:
    m = _MIGRATIONS_BY_ID.get(str(mid or ""))
    if m is None:
        raise MigrationError("unknown_migration")
    return m


def _repair_needed(plan: Plan, fv: int, m: dict) -> bool:
    return fv >= m["to"] and not dataset_planes_valid(plan)


def _applicable(plan: Plan, fv: int, m: dict) -> bool:
    return plan.type in m["types"] and (fv == m["from"] or _repair_needed(plan, fv, m))


def _check_source(plan: Plan, j: dict, path: Path, persist: bool = True) -> None:
    """Fail the job when a bricks manifest changed since it was planned. `persist`
    (only under the job lock) records the failure in the journal."""
    current = _manifest_sha(plan.manifest_path)
    for sha in (j.get("sourceManifests") or {}).values():
        if sha != current:
            if persist and j.get("state") != "failed":
                j["state"], j["error"] = "failed", "source_changed"
                _save_journal(path, j)
            raise MigrationError("source_changed", 409)


def _open_job(dataset_id, mid):
    m = _migration(mid)
    plan = _plan_for(dataset_id)
    path = journal_path(plan.type, plan.folder, m["id"])
    return m, plan, path


def _volume_key(path: Path):
    """(free bytes, device id) of the volume holding `path` (its nearest existing
    ancestor); (None, None) when the OS will not say."""
    probe = Path(path)
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    try:
        return shutil.disk_usage(str(probe)).free, os.stat(str(probe)).st_dev
    except OSError:
        return None, None


def _check_disk(plan: Plan) -> None:
    """Refuse a new job the disk cannot hold (507 insufficient_disk, as the import
    does): the tile store under uploads/ and the assembled packs beside the dataset
    each need ~PLANES_SIZE_RATIO x the LOD0 bytes, both at once during finalize."""
    est = int(sum(plan.unit_bytes.values()) * PLANES_SIZE_RATIO)
    store_free, store_dev = _volume_key(MIGRATIONS_DIR)
    data_free, data_dev = _volume_key(plan.ds_dir)
    checks = ([(store_free, 2 * est)] if store_dev is not None and store_dev == data_dev
              else [(store_free, est), (data_free, est)])
    for free, needed in checks:
        if free is not None and needed > max(0, free - DISK_RESERVE_BYTES):
            raise MigrationError("insufficient_disk", 507, None,
                                 {"neededBytes": needed, "freeBytes": max(0, free - DISK_RESERVE_BYTES)})


def plan_job(dataset_id, mid, offset: int = 0, limit: int = 10000) -> dict:
    """Create (or resume) the job of migration `mid` on a dataset; its summary and a
    page of the pending unit keys."""
    m, plan, path = _open_job(dataset_id, mid)
    base = _job_base(plan, mid=m["id"])
    with _JobLock(base):
        j = _load_journal(path)
        if j is not None and j.get("state") == "failed":
            if j.get("error") == "source_changed":
                _rmtree(tile_store_dir(plan.type, plan.folder, m["id"]))
                j = None
            else:
                j["state"] = "running"
                j.pop("error", None)
                _save_journal(path, j)
        if j is not None and any(sha != plan.sha for sha in (j.get("sourceManifests") or {}).values()):
            _rmtree(tile_store_dir(plan.type, plan.folder, m["id"]))
            j = None
        if j is None:
            fv = format_version(_read_metadata(plan.ds_dir))
            if not _applicable(plan, fv, m):
                raise MigrationError("not_applicable", 409)
            _rmtree(plan.ds_dir / ".planes-incoming")
            _check_disk(plan)
            j = {
                "migration": m["id"], "dataset": plan.dataset, "createdAt": _utc_iso(),
                "sourceManifests": {str(t): plan.sha for t in sorted(plan.trees)},
                "units": {"total": plan.total, "empty": plan.empty},
                "done": [], "executors": {"browser": 0, "server": 0}, "state": "running",
            }
            _save_journal(path, j)
    done = set(j.get("done") or [])
    pending = [unit_key(*u) for u in plan.units if unit_key(*u) not in done]
    offset = max(0, _as_int(offset, 0))
    limit = max(1, min(100000, _as_int(limit, 10000) or 10000))
    out = _summary(j, plan)
    out.update({"pending": len(pending), "offset": offset, "units": pending[offset:offset + limit]})
    return out


def _write_unit_tiles(plan: Plan, mid: str, unit: tuple, tiles: dict) -> None:
    """Replace a unit's tiles in the store: the given z planes are written, every other
    plane of its layer is removed (a zero tile has no file)."""
    store = tile_store_dir(plan.type, plan.folder, mid)
    _tree, _w, _h, z0, depth = _unit_geometry(plan, unit)
    with _thread_lock("unit:%s:%s" % (store, unit_key(*unit))):
        for z in range(z0, z0 + depth):
            p = tile_path(store, unit, z)
            if z in tiles:
                _atomic_write(p, tiles[z])
            else:
                try:
                    p.unlink()
                except FileNotFoundError:
                    pass


def _mark_done(plan: Plan, m: dict, path: Path, keys, executor: str) -> dict:
    base = _job_base(plan, mid=m["id"])
    with _JobLock(base):
        j = _load_journal(path)
        if j is None:
            raise MigrationError("no_job", 404)
        _check_source(plan, j, path)
        if j.get("state") != "running":
            raise MigrationError("job_not_running", 409)
        done = j.get("done") or []
        have = set(done)
        added = 0
        for k in keys:
            if k not in have:
                have.add(k)
                done.append(k)
                added += 1
        j["done"] = done
        ex = j.setdefault("executors", {"browser": 0, "server": 0})
        ex[executor] = int(ex.get(executor) or 0) + added
        _save_journal(path, j)
        return j


def parse_unit_blob(body: bytes):
    """[(z, png)] of a unit blob (SPEC §5.1); MigrationError on a malformed body."""
    if len(body) < 4:
        raise MigrationError("bad_blob")
    count = struct.unpack_from("<I", body, 0)[0]
    pos, out = 4, []
    if count > BRICK_SIZE:
        raise MigrationError("bad_blob", 400, "too many planes")
    for _ in range(count):
        if pos + 8 > len(body):
            raise MigrationError("bad_blob", 400, "truncated entry")
        z, length = struct.unpack_from("<II", body, pos)
        pos += 8
        if pos + length > len(body):
            raise MigrationError("bad_blob", 400, "truncated PNG")
        out.append((z, body[pos:pos + length]))
        pos += length
    if pos != len(body):
        raise MigrationError("bad_blob", 400, "trailing bytes")
    return out


def unit_put(dataset_id, mid, key, body: bytes, dry: bool = False) -> dict:
    """Browser executor: store the encoded tiles of one unit (idempotent)."""
    if len(body) > MAX_UNIT_BODY:
        raise MigrationError("body_too_large", 413)
    if dry:
        out = {"ok": True, "dry": True, "bytes": len(body)}
        try:
            m, plan, path = _open_job(dataset_id, mid)
            j = _load_journal(path)
            if j is not None:
                s = _summary(j)
                out.update({"done": s["done"], "total": s["total"]})
        except MigrationError:
            pass
        return out
    m, plan, path = _open_job(dataset_id, mid)
    unit = parse_unit_key(key)
    tree, w, h, z0, depth = _unit_geometry(plan, unit)
    if unit not in plan.unit_bytes:
        raise MigrationError("empty_unit", 409)
    j = _load_journal(path)
    if j is None:
        raise MigrationError("no_job", 404)
    _check_source(plan, j, path, persist=False)
    if j.get("state") != "running":
        raise MigrationError("job_not_running", 409)
    tiles = {}
    for z, png in parse_unit_blob(body):
        if not (z0 <= z < z0 + depth) or z in tiles:
            raise MigrationError("bad_blob", 400, f"plane {z} outside the unit's layer")
        try:
            is_zero = validate_png_gray8(png, w, h)
        except ValueError as exc:
            raise MigrationError("bad_png", 400, f"z{z}: {exc}")
        tiles[z] = None if is_zero else png
    _write_unit_tiles(plan, m["id"], unit, {z: p for z, p in tiles.items() if p is not None})
    j = _mark_done(plan, m, path, [unit_key(*unit)], "browser")
    s = _summary(j)
    return {"ok": True, "done": s["done"], "total": s["total"]}


_CLAIMS: dict = {}       # job base -> {unit key: claim time}
_CLAIMS_GUARD = threading.Lock()
_CLAIM_TTL = 120.0


def _claim(base: str, pending, n: int = 1):
    now = time.monotonic()
    with _CLAIMS_GUARD:
        held = _CLAIMS.setdefault(base, {})
        for k in [k for k, ts in held.items() if now - ts > _CLAIM_TTL]:
            del held[k]
        for key in pending:
            if key not in held:
                held[key] = now
                return key
    return None


def _release(base: str, key: str) -> None:
    with _CLAIMS_GUARD:
        (_CLAIMS.get(base) or {}).pop(key, None)


def unit_run(dataset_id, mid, max_seconds=MAX_RUN_SECONDS, dry: bool = False) -> dict:
    """Server executor: process pending units for at most ~max_seconds (at least one)."""
    m, plan, path = _open_job(dataset_id, mid)
    try:
        budget = float(max_seconds)
    except (TypeError, ValueError):
        budget = MAX_RUN_SECONDS
    budget = max(1.0, min(float(MAX_RUN_SECONDS), budget))
    base = _job_base(plan, mid=m["id"])
    t0 = time.monotonic()
    processed, bytes_read, bytes_written, slowest = [], 0, 0, 0.0
    with _JobLock(base):
        j = _load_journal(path)
        if j is None:
            raise MigrationError("no_job", 404)
        _check_source(plan, j, path)
    if j.get("state") != "running":
        raise MigrationError("job_not_running", 409)
    taken = set()
    while True:
        done = set(j.get("done") or [])
        pending = (k for k in (unit_key(*u) for u in plan.units) if k not in done and k not in taken)
        key = _claim(base, pending)
        if key is None:
            break
        u0 = time.monotonic()
        try:
            unit = parse_unit_key(key)
            tiles, nread = process_unit(plan, unit)
            bytes_read += nread
            bytes_written += sum(len(p) for p in tiles.values())
            if not dry:
                _write_unit_tiles(plan, m["id"], unit, tiles)
                j = _mark_done(plan, m, path, [key], "server")
            processed.append(key)
            taken.add(key)
        finally:
            _release(base, key)
        slowest = max(slowest, time.monotonic() - u0)
        if time.monotonic() - t0 + slowest > budget:
            break
    s = _summary(j)
    return {"ok": True, "processed": processed, "done": s["done"], "total": s["total"],
            "seconds": round(time.monotonic() - t0, 3), "bytesRead": bytes_read,
            "bytesWritten": bytes_written, "dry": bool(dry)}


def bench(dataset_id, n=4) -> dict:
    """Server executor on N sample units, spread over the dataset, tiles discarded."""
    plan = _plan_for(dataset_id)
    n = max(1, min(MAX_BENCH_UNITS, _as_int(n, 4)))
    units = plan.units
    if not units:
        return {"ok": True, "seconds": 0.0, "units": 0, "bytesRead": 0, "bytesWritten": 0}
    picks = sorted({units[(k * len(units)) // n] for k in range(min(n, len(units)))})
    t0 = time.monotonic()
    nread = nwritten = 0
    for unit in picks:
        tiles, r = process_unit(plan, unit)
        nread += r
        nwritten += sum(len(p) for p in tiles.values())
    secs = time.monotonic() - t0
    return {"ok": True, "seconds": round(secs, 3), "units": len(picks), "bytesRead": nread,
            "bytesWritten": nwritten, "secondsPerUnit": round(secs / len(picks), 4),
            "sample": [unit_key(*u) for u in picks]}


# ── Finalize ───────────────────────────────────────────────────────────────────

def _producer(j: dict) -> str:
    ex = j.get("executors") or {}
    b, s = int(ex.get("browser") or 0), int(ex.get("server") or 0)
    if b and s:
        return "mixed"
    return "migration-browser" if b else "migration-server"


def _assemble_tree(plan: Plan, tree: Tree, store: Path, incoming: Path, producer: str,
                   created_at: str, deadline) -> bool:
    """Write the packs of one tree into `incoming`; False when the deadline stopped it
    (packs already written are atomic and are kept for the next call)."""
    out_dir = incoming / tree.rel if tree.rel else incoming
    if not plan.ds_dir.is_dir():
        # Deleted (or replaced by a publish) under us: never re-create its folder.
        raise MigrationError("no_dataset", 404)
    out_dir.mkdir(parents=True, exist_ok=True)
    X, Y, Z = tree.dims
    present = set(os.listdir(out_dir))
    for z in range(Z):
        name = pack_name(z)
        if name in present:
            continue
        if deadline is not None and time.monotonic() > deadline:
            return False
        if not out_dir.is_dir():
            raise MigrationError("no_dataset", 404)
        bz = z // BRICK_SIZE
        tiles = []
        for c in range(tree.channels):
            for ty in range(tree.tiles_y):
                h = min(TILE_SIZE, Y - ty * TILE_SIZE)
                for tx in range(tree.tiles_x):
                    w = min(TILE_SIZE, X - tx * TILE_SIZE)
                    unit = (tree.t, bz, c, ty, tx)
                    payload = None
                    if unit in plan.unit_bytes:
                        p = tile_path(store, unit, z)
                        try:
                            payload = p.read_bytes()
                        except FileNotFoundError:
                            payload = None
                    if payload:
                        try:
                            ihdr = png_ihdr(payload)
                        except ValueError as exc:
                            raise MigrationError("bad_tile", 500, f"{p.name} z{z}: {exc}")
                        if ihdr != (w, h, 8, 0, 0, 0, 0):
                            raise MigrationError("bad_tile", 500, f"{p.name} z{z}: IHDR {ihdr[:2]}")
                    tiles.append(payload)
        _atomic_write(out_dir / name, build_plane_pack(z, tree.channels, tree.tiles_x, tree.tiles_y, tiles),
                      public=True)
    doc = planes_manifest({"x": X, "y": Y, "z": Z}, tree.channels, plan.sha, producer, created_at)
    _atomic_write(out_dir / "manifest.json", planes_manifest_bytes(doc), public=True)
    return True


def _bump_metadata(ds_dir: Path, to_version: int) -> int:
    """formatVersion = max(current, to), merged into the CURRENT file under the
    metadata lock (an editor save cannot be lost, no other key is touched)."""
    with _META_LOCK:
        path = ds_dir / "metadata.json"
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise MigrationError("no_metadata", 409)
        except Exception:
            raise MigrationError("metadata_invalid", 409)
        if not isinstance(meta, dict):
            raise MigrationError("metadata_invalid", 409)
        new = max(format_version(meta), int(to_version))
        if meta.get("formatVersion") != new:
            meta["formatVersion"] = new
            _atomic_write(path, json.dumps(meta, indent=2, ensure_ascii=False).encode("utf-8"), public=True)
            if _ON_METADATA_CHANGE is not None:
                try:
                    _ON_METADATA_CHANGE()
                except Exception:
                    pass
        return new


def _swap_planes(ds_dir: Path) -> None:
    incoming, live, old = ds_dir / ".planes-incoming", ds_dir / "planes", ds_dir / ".planes-old"
    if incoming.is_dir():
        if live.exists():
            _rmtree(old)
            _replace_retry(live, old)
        _replace_retry(incoming, live)
    _rmtree(old)


def finalize(dataset_id, mid, max_seconds=None) -> dict:
    """Assemble, validate, swap, bump (SPEC §5.2). Re-entrant at every step: a crash or
    a deadline (`max_seconds`, optional) leaves a state the next call completes."""
    m, plan, path = _open_job(dataset_id, mid)
    base = _job_base(plan, mid=m["id"])
    secs = _as_seconds(max_seconds)
    deadline = time.monotonic() + secs if secs is not None else None
    with _JobLock(base):
        j = _load_journal(path)
        if j is None:
            # Nothing journaled: the structure may already be in place (a crash after
            # the swap that also lost the journal, a pipeline-made tree) — bump only then.
            if plan.type in m["types"] and dataset_planes_valid(plan):
                fv = _bump_metadata(plan.ds_dir, m["to"])
                return {"ok": True, "formatVersion": fv}
            raise MigrationError("no_job", 404)
        state = j.get("state")
        if state in ("running", "assembling"):
            _check_source(plan, j, path)
        if state == "running":
            done = set(j.get("done") or [])
            missing = sum(1 for u in plan.units if unit_key(*u) not in done)
            if missing:
                raise MigrationError("units_pending", 409, f"{missing} unit(s) not done")
            _rmtree(plan.ds_dir / ".planes-incoming")
            j["state"], j["producer"], j["assembledAt"] = "assembling", _producer(j), _utc_iso()
            _save_journal(path, j)
            state = "assembling"
        if state == "assembling":
            store = tile_store_dir(plan.type, plan.folder, m["id"])
            incoming = plan.ds_dir / ".planes-incoming"
            planes_total = sum(tree.dims[2] for tree in plan.trees.values())
            for t in sorted(plan.trees):
                if not _assemble_tree(plan, plan.trees[t], store, incoming, j.get("producer") or _producer(j),
                                      j.get("assembledAt") or _utc_iso(), deadline):
                    written = sum(len([n for n in os.listdir(incoming / tr.rel if tr.rel else incoming)
                                       if n.endswith(".bin")])
                                  for tr in plan.trees.values()
                                  if (incoming / tr.rel if tr.rel else incoming).is_dir())
                    j["assembly"] = {"planes": planes_total, "written": written}
                    _save_journal(path, j)
                    return {"ok": True, "complete": False, "assembly": j["assembly"]}
            if not dataset_planes_valid(plan, ".planes-incoming"):
                raise MigrationError("assembly_invalid", 500)
            # The assembly may have taken many seconds: a re-publish of the dataset in
            # the meantime must not get these planes nor a version bump.
            _check_source(plan, j, path)
            _swap_planes(plan.ds_dir)
            j["state"] = "swapped"
            j.pop("assembly", None)
            _save_journal(path, j)
            state = "swapped"
        if state == "swapped":
            _swap_planes(plan.ds_dir)  # completes a swap a crash interrupted
            if not dataset_planes_valid(plan):
                j["state"], j["error"] = "failed", "assembly_invalid"
                _save_journal(path, j)
                raise MigrationError("assembly_invalid", 500)
            fv = _bump_metadata(plan.ds_dir, m["to"])
            _rmtree(tile_store_dir(plan.type, plan.folder, m["id"]))
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            return {"ok": True, "complete": True, "formatVersion": fv}
        raise MigrationError("job_failed", 409, str(j.get("error") or state))


def cancel(dataset_id, mid) -> dict:
    m = _migration(mid)
    # A dataset deleted mid-job must still let the operator drop its journal and tiles.
    type_dir, folder, ds_dir = _resolve_dataset(dataset_id, must_exist=False)
    base = _job_base(type_dir, folder, m["id"])
    with _JobLock(base):
        path = journal_path(type_dir, folder, m["id"])
        j = None
        try:
            j = _load_journal(path)
        except MigrationError:
            pass
        if j is not None and j.get("state") == "swapped":
            # The new planes are live already: finishing is the only consistent exit.
            raise MigrationError("finalize_in_progress", 409)
        _rmtree(tile_store_dir(type_dir, folder, m["id"]))
        _rmtree(ds_dir / ".planes-incoming")
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    try:
        (MIGRATIONS_DIR / (base + ".lock")).unlink()
    except OSError:
        pass
    return {"ok": True}


# ── Capability probe and status ────────────────────────────────────────────────

# 4×3 lossless WebP, R=G=B = the values below (encoded by Pillow/libwebp).
_PROBE_WEBP = base64.b64decode(
    "UklGRlQAAABXRUJQVlA4TEcAAAAvA4AAAF9gKpLN6NscfNFBBqYi2Yy+zcEXHWRgKpLN6NscfNFBBvMfSQLAzKgqu6u7"
    "wf+7OwCCABKFaCKZZJpZJo3of9A9AgA=")
_PROBE_PIXELS = bytes([0, 1, 2, 127, 128, 200, 254, 255, 37, 64, 99, 3])
_CAPS = None


def server_capabilities(force: bool = False) -> dict:
    global _CAPS
    if _CAPS is not None and not force:
        return _CAPS
    reasons = []
    webp = False
    if _PILImage is not None:
        try:
            with _PILImage.open(io.BytesIO(_PROBE_WEBP)) as im:
                im.load()
                band = im if im.mode == "L" else im.convert("RGB").getchannel(0)
                webp = band.size == (4, 3) and band.tobytes() == _PROBE_PIXELS
        except Exception:
            webp = False
    if not webp:
        reasons.append("no_webp_decode")
    png = False
    try:
        sample = bytes(range(256)) * 3
        w, h, px = decode_png_gray8(png_gray8(16, 48, sample))
        png = (w, h, px) == (16, 48, sample)
    except Exception:
        png = False
    if not png:
        reasons.append("no_zlib")
    _CAPS = {
        "available": not reasons, "reasons": reasons, "webpDecode": webp, "pngEncode": png,
        "limits": {"maxExecutionTime": 0, "memoryLimitBytes": None},
        "backend": "python", "vectorized": _np is not None,
        "maxRunSeconds": MAX_RUN_SECONDS, "maxUnitBody": MAX_UNIT_BODY,
    }
    if _PILImage is None:
        _CAPS["detail"] = "Pillow is not installed"
    return _CAPS


def registry() -> list:
    return [dict(m) for m in MIGRATIONS]


def dataset_status(type_dir: str, folder: str, ds_dir: Path) -> dict:
    meta = _read_metadata(ds_dir)
    fv = format_version(meta)
    row = {"id": f"{type_dir}/{folder}", "type": type_dir, "folder": folder,
           "name": meta.get("name") or folder, "formatVersion": fv, "pending": [],
           "repair": False, "trees": 0, "job": None, "estimate": {"units": 0, "bytes": 0}}
    if type_dir not in VOLUME_TYPES:
        return row
    try:
        plan = _plan_for(row["id"])
    except MigrationError as exc:
        row["problem"] = exc.code
        if exc.detail:
            row["problemDetail"] = exc.detail[:300]
        return row
    row["trees"] = len(plan.trees)
    jobs = []
    for m in MIGRATIONS:
        if plan.type not in m["types"]:
            continue
        try:
            j = _load_journal(journal_path(type_dir, folder, m["id"]))
        except MigrationError:
            j = {"migration": m["id"], "state": "failed", "error": "journal_corrupt"}
        repair = _repair_needed(plan, fv, m)
        if m["from"] >= fv or repair:
            row["pending"].append(m["id"])
            row["repair"] = row["repair"] or repair
        if j is not None:
            jobs.append(_summary(j, plan))
    if jobs:
        row["job"] = jobs[0]
    if row["pending"]:
        done = set()
        if row["job"] is not None:
            try:
                done = set(_load_journal(journal_path(type_dir, folder, row["job"]["migration"])).get("done") or [])
            except Exception:
                done = set()
        rest = [u for u in plan.units if unit_key(*u) not in done]
        row["estimate"] = {"units": len(rest), "bytes": sum(plan.unit_bytes[u] for u in rest),
                           "unitsTotal": len(plan.units), "bytesTotal": sum(plan.unit_bytes.values())}
    return row


def status() -> dict:
    datasets = []
    for type_dir in ALL_TYPES:
        base = DATA_WEB / type_dir
        if not base.is_dir():
            continue
        for ds_dir in sorted(base.iterdir(), key=lambda p: p.name.lower()):
            if ds_dir.name.startswith(".") or not ds_dir.is_dir() or not _SAFE_FOLDER_RE.match(ds_dir.name):
                continue
            datasets.append(dataset_status(type_dir, ds_dir.name, ds_dir))
    return {"ok": True, "latest": LATEST, "migrations": registry(), "datasets": datasets,
            "server": server_capabilities()}


# ── HTTP dispatch (the dev server only routes here) ────────────────────────────

WRITE_ACTIONS = ("plan", "unit_put", "unit_run", "finalize", "cancel", "bench")


def handle(action: str, params: dict, body, raw: bytes | None = None) -> tuple[int, dict]:
    """One API call → (HTTP status, JSON payload). Authentication, CSRF and the body
    size cap are the caller's job; errors come back as {error: <code>, detail?}."""
    body = body if isinstance(body, dict) else {}
    try:
        if action == "status":
            return 200, status()
        if action == "plan":
            return 200, {"ok": True, **plan_job(body.get("dataset"), body.get("migration"),
                                                 body.get("offset", 0), body.get("limit", 10000))}
        if action == "unit_put":
            return 200, unit_put(params.get("dataset"), params.get("migration"), params.get("unit"),
                                 raw or b"", dry=str(params.get("dry", "0")) in ("1", "true"))
        if action == "unit_run":
            caps = server_capabilities()
            if not caps["available"]:
                raise MigrationError("server_unavailable", 409, ",".join(caps["reasons"]))
            return 200, unit_run(body.get("dataset"), body.get("migration"),
                                 body.get("maxSeconds", MAX_RUN_SECONDS), dry=bool(body.get("dry")))
        if action == "finalize":
            return 200, finalize(body.get("dataset"), body.get("migration"), body.get("maxSeconds"))
        if action == "cancel":
            return 200, cancel(body.get("dataset"), body.get("migration"))
        if action == "bench":
            caps = server_capabilities()
            if not caps["available"]:
                raise MigrationError("server_unavailable", 409, ",".join(caps["reasons"]))
            return 200, bench(body.get("dataset"), body.get("units", 4))
        return 400, {"error": "unknown_action"}
    except MigrationError as exc:
        payload = {"error": exc.code, **exc.extra}
        if exc.detail and exc.detail != exc.code:
            payload["detail"] = exc.detail[:500]
        return exc.status, payload
