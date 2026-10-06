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

LATEST = 4

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
    {
        "id": "m003-layer-mips",
        "from": 2,
        "to": 3,
        "types": ["3d", "live"],
        "title": {
            "en": "Maximum projections of each brick layer (fast whole-stack z-stack figures)",
            "fr": "Projections maximales de chaque couche de briques (figures z-stack de toute la pile rapides)",
            "es": "Proyecciones máximas de cada capa de ladrillos (figuras z-stack de toda la pila rápidas)",
            "nl": "Maximumprojecties van elke brick-laag (snelle z-stackfiguren over de hele stapel)",
        },
        "description": {
            "en": "Stores, for every 64-plane layer of the native level and every channel, the "
                  "per-pixel maximum of its planes, so a maximum projection of a thick slab reads "
                  "one picture per layer instead of 64 planes. Derived from the planes; lossless.",
            "fr": "Range, pour chaque couche de 64 plans du niveau natif et chaque canal, le "
                  "maximum pixel par pixel de ses plans : une projection maximale d'une tranche "
                  "épaisse lit une image par couche au lieu de 64 plans. Dérivé des plans ; sans perte.",
            "es": "Guarda, para cada capa de 64 planos del nivel nativo y cada canal, el máximo "
                  "píxel a píxel de sus planos: una proyección máxima de un bloque grueso lee una "
                  "imagen por capa en lugar de 64 planos. Derivado de los planos; sin pérdidas.",
            "nl": "Bewaart voor elke laag van 64 vlakken van het native niveau en elk kanaal het "
                  "maximum per pixel van zijn vlakken, zodat een maximumprojectie van een dikke "
                  "plak één beeld per laag leest in plaats van 64 vlakken. Afgeleid van de vlakken; "
                  "verliesvrij.",
        },
    },
    {
        "id": "m004-bricks-v3",
        "from": 3,
        "to": 4,
        "types": ["3d", "live"],
        "title": {
            "en": "Brick pyramid v3: halved in Z too, 1-voxel border, binary index",
            "fr": "Pyramide de briques v3 : réduite aussi en Z, bordure d'un voxel, index binaire",
            "es": "Pirámide de ladrillos v3: reducida también en Z, borde de un vóxel, índice binario",
            "nl": "Brick-piramide v3: ook in Z gehalveerd, rand van één voxel, binaire index",
        },
        "description": {
            "en": "Rebuilds the brick tree: the native level is kept voxel for voxel, every coarser "
                  "level halves Z as well once the voxels are close to isotropic, every brick "
                  "carries a 1-voxel border (seamless filtering across bricks) and a compact binary "
                  "index replaces the large JSON manifest. Lossless.",
            "fr": "Reconstruit l'arbre de briques : le niveau natif est conservé voxel pour voxel, "
                  "chaque niveau plus grossier réduit aussi Z dès que les voxels sont presque "
                  "isotropes, chaque brique porte une bordure d'un voxel (filtrage sans couture entre "
                  "briques) et un index binaire compact remplace le gros manifeste JSON. Sans perte.",
            "es": "Reconstruye el árbol de ladrillos: el nivel nativo se conserva vóxel a vóxel, cada "
                  "nivel más grueso reduce también Z cuando los vóxeles son casi isótropos, cada "
                  "ladrillo lleva un borde de un vóxel (filtrado sin costuras entre ladrillos) y un "
                  "índice binario compacto sustituye al gran manifiesto JSON. Sin pérdidas.",
            "nl": "Bouwt de brick-boom opnieuw op: het native niveau blijft voxel voor voxel behouden, "
                  "elk grover niveau halveert ook Z zodra de voxels bijna isotroop zijn, elke brick "
                  "heeft een rand van één voxel (naadloze filtering tussen bricks) en een compacte "
                  "binaire index vervangt het grote JSON-manifest. Verliesvrij.",
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
    if encoding == V3_ENCODING:
        if bs != BRICK_SIZE:
            raise ValueError("v3 bricks are 64³")
        return _np.ascontiguousarray(decode_brick_v3(raw)[1:-1, 1:-1, 1:-1]).tobytes()
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


def build_plane_pack(z: int, channels: int, tiles_x: int, tiles_y: int, tiles,
                     magic: bytes = PACK_MAGIC) -> bytes:
    """One `zNNNNN.bin` (SPEC §3.2), or with magic LMIP one `lNNNNN.bin` (§12, z = the
    layer). `tiles` lists C·TY·TX payloads in entry order (c-major, then ty, then tx);
    None or b"" is an all-zero tile (length 0, offset 0)."""
    channels, tiles_x, tiles_y = int(channels), int(tiles_x), int(tiles_y)
    n = channels * tiles_y * tiles_x
    tiles = list(tiles)
    if len(tiles) != n:
        raise ValueError("build_plane_pack: %d tiles, expected %d" % (len(tiles), n))
    head = bytearray(struct.pack("<4sHHHHI", magic, PACK_VERSION, channels, tiles_x, tiles_y, int(z)))
    offset = pack_header_bytes(channels, tiles_x, tiles_y)
    for payload in tiles:
        length = len(payload) if payload else 0
        head += struct.pack("<QI", offset if length else 0, length)
        offset += length
    return bytes(head) + b"".join(p for p in tiles if p)


def parse_plane_pack(data: bytes, magic: bytes = PACK_MAGIC, header_only: bool = False):
    """(z, channels, tilesX, tilesY, [(offset, length)…]) of a plane pack (or, with magic
    LMIP, of a layer-MIP pack); ValueError. `header_only`: `data` is the header alone, so
    entries are only checked not to point into it."""
    if len(data) < PACK_HEADER_FIXED or data[:4] != magic:
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
        if length and (off < hb or (not header_only and off + length > len(data))):
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


# ── Format 3 — layer MIPs (SPEC §12) ──────────────────────────────────────────

MIPS_SCHEMA = "lumen-mips-v1"
MIPS_PACK_PATTERN = "l{l}.bin"
MIPS_PACK_MAGIC = b"LMIP"
LAYER_DEPTH = 64
# A layer MIP is a few percent of the 64 planes it summarises (it holds one picture per
# layer, a little denser than an average plane): the disk budget of a job.
MIPS_SIZE_RATIO = 0.05


def mip_pack_name(layer: int) -> str:
    return "l%05d.bin" % int(layer)


def mip_tile(planes):
    """Per-voxel maximum of equal-length uint8 buffers (bytes or numpy arrays); None
    entries are all-zero tiles and are skipped. None when every input is None. The
    maximum of the stored LOD0 values, exactly (SPEC §12)."""
    acc = None
    for p in planes:
        if p is None:
            continue
        if _np is not None:
            a = p if isinstance(p, _np.ndarray) else _np.frombuffer(bytes(p), dtype=_np.uint8)
            a = a.reshape(-1)
            if acc is None:
                acc = a.copy()
            else:
                if a.size != acc.size:
                    raise ValueError("mip_tile: tiles of different sizes")
                _np.maximum(acc, a, out=acc)
        else:
            b = bytes(p)
            if acc is None:
                acc = b
            else:
                if len(b) != len(acc):
                    raise ValueError("mip_tile: tiles of different sizes")
                acc = bytes(map(max, acc, b))
    if acc is None:
        return None
    return acc.tobytes() if _np is not None else bytes(acc)


def mips_manifest(dimensions: dict, channels: int, source_sha256: str, producer: str,
                  created_at: str | None = None) -> dict:
    """The per-tree `mips/manifest.json` of SPEC §12: the planes manifest's shape, with
    `layers`/`layerDepth` inserted after `codec` (key order is part of the contract:
    the Python and PHP twins write the same bytes from the same tile store)."""
    x, y, z = int(dimensions["x"]), int(dimensions["y"]), int(dimensions["z"])
    tx, ty = -(-x // TILE_SIZE), -(-y // TILE_SIZE)
    return {
        "schema": MIPS_SCHEMA,
        "formatVersion": 3,
        "level": 0,
        "dimensions": {"x": x, "y": y, "z": z},
        "channels": int(channels),
        "tileSize": TILE_SIZE,
        "tiles": {"x": tx, "y": ty},
        "codec": PLANES_CODEC,
        "layers": -(-z // LAYER_DEPTH),
        "layerDepth": LAYER_DEPTH,
        "packPattern": MIPS_PACK_PATTERN,
        "headerBytes": pack_header_bytes(channels, tx, ty),
        "source": {"manifestSha256": str(source_sha256)},
        "producer": producer,
        "createdAt": created_at or _utc_iso(),
    }


# ── Format 4 — brick pyramid v3 (SPEC §13) ────────────────────────────────────

V3_SCHEMA = "iribhm-bricks-v3"
V3_ENCODING = "webp-lossless-v3"      # internal Tree.encoding tag, never written to disk
V3_APRON = 1
V3_SLICE = BRICK_SIZE + 2 * V3_APRON  # 66
V3_COLS, V3_ROWS = 9, 8
V3_MOSAIC_W, V3_MOSAIC_H = V3_COLS * V3_SLICE, V3_ROWS * V3_SLICE   # 594 × 528
V3_LEVEL_STOP = 128
V3_PACK_MAX_BRICKS = 64
V3_PACK_MAX_BYTES = 16 * 1024 * 1024
V3_SUPER = 4                          # a work unit = 4×4×4 bricks of one level
INDEX_MAGIC = b"LBIX"
INDEX_VERSION = 1
INDEX_HEAD_BYTES = 12
INDEX_LEVEL_BYTES = 16
INDEX_ENTRY_BYTES = 10
INDEX_NAME = "index.bin"
# Pillow's lossless effort. Measured on real LOD0 mosaics (see the m004 timing test):
# method 4 is within 1 % of method 6 for ~40x less CPU; quality is the lossless effort.
V3_WEBP_QUALITY = 75
V3_WEBP_METHOD = 4
# v3 bricks weigh ~1.1-1.3x the v2 bricks (the 66³ apron is +14 % of voxels, the exact
# ESS keeps faint bricks v2 dropped): the disk budget of a job.
BRICKS_V3_SIZE_RATIO = 1.3


def level_geometry(dimensions, voxel_size) -> list:
    """The levels of a v3 pyramid (SPEC §13.1) for LOD0 `dimensions` (X, Y, Z) and voxel
    size (vx, vy, vz) in µm. Level k+1 halves X and Y (ceil(n/2)) and halves Z iff
    vz_k ≤ 1.5 · vxy_{k+1}, where vxy is the coarser of the two XY voxel sizes after the
    step (they differ by rounding only on real acquisitions). A halved axis doubles its
    voxel size exactly (the 2-voxel box of the reduction; the last voxel of an odd axis
    averages one source voxel). Levels are added while max(X, Y) > 128.

    Each entry: {level, dimensions:(X,Y,Z), voxelSize:(vx,vy,vz), gridSize:(gx,gy,gz),
    halveZ: bool (how this level was made from the previous one; False for level 0)}."""
    X, Y, Z = (int(v) for v in dimensions)
    vx, vy, vz = (float(v) for v in voxel_size)
    if X < 1 or Y < 1 or Z < 1:
        raise ValueError("level_geometry: empty volume")
    if not all(v > 0 and v == v and v != float("inf") for v in (vx, vy, vz)):
        raise ValueError("level_geometry: voxel size must be positive")

    def entry(k, X, Y, Z, vx, vy, vz, hz):
        return {"level": k, "dimensions": (X, Y, Z), "voxelSize": (vx, vy, vz),
                "gridSize": (-(-X // BRICK_SIZE), -(-Y // BRICK_SIZE), -(-Z // BRICK_SIZE)),
                "halveZ": hz}

    out = [entry(0, X, Y, Z, vx, vy, vz, False)]
    while max(X, Y) > V3_LEVEL_STOP:
        nvx, nvy = vx * 2.0, vy * 2.0
        hz = vz <= 1.5 * max(nvx, nvy)
        X, Y = -(-X // 2), -(-Y // 2)
        if hz:
            Z, vz = -(-Z // 2), vz * 2.0
        vx, vy = nvx, nvy
        out.append(entry(len(out), X, Y, Z, vx, vy, vz, hz))
    return out


def reduce_level(vol, halve_z: bool, chunk: int = 32):
    """Level k+1 from level k (SPEC §13.1): the mean of each 2×2(×2) block, edge blocks
    averaging only the voxels that exist, in integers rounded half up:
    (sum + n//2) // n with n ∈ {1, 2, 4, 8} (n/2 is then exact). `vol` is uint8
    (z, y, x); the result has shape (ceil(Z/2) or Z, ceil(Y/2), ceil(X/2)). A region of
    a larger volume reduces exactly when its origin is even and its far edges are either
    even-sized or the volume's own edges. Worked in z-chunks to bound memory."""
    if _np is None:
        raise RuntimeError("reduce_level needs numpy")
    a = _np.asarray(vol, dtype=_np.uint8)
    if a.ndim != 3 or 0 in a.shape:
        raise ValueError("reduce_level: a non-empty 3-D array is required")
    Z, Y, X = a.shape
    oy, ox = -(-Y // 2), -(-X // 2)
    oz = -(-Z // 2) if halve_z else Z
    out = _np.empty((oz, oy, ox), dtype=_np.uint8)
    # Voxels per output cell along each axis: 2, except 1 for the last of an odd axis.
    cy = _np.full(oy, 2, dtype=_np.uint32)
    cx = _np.full(ox, 2, dtype=_np.uint32)
    if Y % 2:
        cy[-1] = 1
    if X % 2:
        cx[-1] = 1
    cyx = cy[:, None] * cx[None, :]
    step = max(1, int(chunk))
    for z0 in range(0, oz, step):
        z1 = min(oz, z0 + step)
        if halve_z:
            s0, s1 = 2 * z0, min(Z, 2 * z1)
        else:
            s0, s1 = z0, z1
        blk = a[s0:s1].astype(_np.uint32)
        if halve_z:
            if blk.shape[0] % 2:
                blk = _np.concatenate([blk, _np.zeros((1, Y, X), dtype=_np.uint32)], axis=0)
            cz = _np.full(blk.shape[0] // 2, 2, dtype=_np.uint32)
            if s1 == Z and Z % 2:
                cz[-1] = 1
            blk = blk[0::2] + blk[1::2]
        else:
            cz = _np.ones(blk.shape[0], dtype=_np.uint32)
        if Y % 2:
            blk = _np.concatenate([blk, _np.zeros((blk.shape[0], 1, X), dtype=_np.uint32)], axis=1)
        blk = blk[:, 0::2, :] + blk[:, 1::2, :]
        if X % 2:
            blk = _np.concatenate([blk, _np.zeros((blk.shape[0], oy, 1), dtype=_np.uint32)], axis=2)
        blk = blk[:, :, 0::2] + blk[:, :, 1::2]
        n = cz[:, None, None] * cyx[None, :, :]
        out[z0:z1] = ((blk + n // 2) // n).astype(_np.uint8)
    return out


def brick_with_apron(vol, bz: int, by: int, bx: int, dimensions, origin=(0, 0, 0)):
    """The stored 66³ voxels (z, y, x) of brick (bx, by, bz) of a level (SPEC §13.2):
    level voxels [64·b − 1, 64·b + 65) per axis, each coordinate clamped to [0, n − 1]
    (clamp-to-edge, also for the interior padding of the last brick of an axis).
    `vol` (uint8, z, y, x) holds the level's voxels [origin, origin + shape) and must
    contain every clamped coordinate; `dimensions` = the level's (X, Y, Z)."""
    if _np is None:
        raise RuntimeError("brick_with_apron needs numpy")
    X, Y, Z = (int(v) for v in dimensions)
    ox, oy, oz = (int(v) for v in origin)
    a = _np.asarray(vol, dtype=_np.uint8)

    def axis(b, n, o, size):
        idx = _np.clip(_np.arange(b * BRICK_SIZE - V3_APRON, b * BRICK_SIZE + BRICK_SIZE + V3_APRON),
                       0, n - 1) - o
        if idx.min() < 0 or idx.max() >= size:
            raise ValueError("brick_with_apron: the region does not hold brick %d" % b)
        return idx

    iz = axis(int(bz), Z, oz, a.shape[0])
    iy = axis(int(by), Y, oy, a.shape[1])
    ix = axis(int(bx), X, ox, a.shape[2])
    return a[_np.ix_(iz, iy, ix)]


def brick_interior_nonzero(brick66) -> bool:
    """ESS of SPEC §13.1: a brick is stored iff its 64³ interior holds a voxel ≥ 1."""
    b = _np.asarray(brick66, dtype=_np.uint8).reshape(V3_SLICE, V3_SLICE, V3_SLICE)
    return bool(b[1:-1, 1:-1, 1:-1].any())


def mosaic_9x8(brick66) -> bytes:
    """The 594×528 greyscale mosaic of a 66³ brick (SPEC §13.2): slice s (z) at column
    s % 9, row s // 9; the 6 slots after the last slice are 0. Row-major bytes."""
    b = _np.asarray(brick66, dtype=_np.uint8).reshape(V3_SLICE, V3_SLICE, V3_SLICE)
    slots = _np.zeros((V3_COLS * V3_ROWS, V3_SLICE, V3_SLICE), dtype=_np.uint8)
    slots[:V3_SLICE] = b
    m = slots.reshape(V3_ROWS, V3_COLS, V3_SLICE, V3_SLICE).transpose(0, 2, 1, 3)
    return _np.ascontiguousarray(m).reshape(V3_MOSAIC_H, V3_MOSAIC_W).tobytes()


def unmosaic_9x8(mosaic, strict: bool = False):
    """The 66³ voxels (z, y, x; numpy uint8) of a 594×528 mosaic (row-major bytes or a
    (528, 594) array). `strict`: the 6 unused slots must be zero (ValueError)."""
    m = _np.asarray(mosaic if isinstance(mosaic, _np.ndarray) else _np.frombuffer(bytes(mosaic), dtype=_np.uint8))
    if m.size != V3_MOSAIC_W * V3_MOSAIC_H:
        raise ValueError("mosaic holds %d bytes, expected %dx%d" % (m.size, V3_MOSAIC_W, V3_MOSAIC_H))
    slots = (m.reshape(V3_ROWS, V3_SLICE, V3_COLS, V3_SLICE).transpose(0, 2, 1, 3)
             .reshape(V3_COLS * V3_ROWS, V3_SLICE, V3_SLICE))
    if strict and slots[V3_SLICE:].any():
        raise ValueError("unused mosaic slots are not zero")
    return _np.ascontiguousarray(slots[:V3_SLICE])


def webp_lossless_size(data: bytes):
    """(width, height) of a LOSSLESS WebP (a simple VP8L file, or an extended VP8X file
    whose image is VP8L, no animation); ValueError for anything else, lossy VP8 included.
    Reads the RIFF structure only, never decodes."""
    n = len(data)
    if n < 20 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ValueError("not a WebP (RIFF header)")
    riff = struct.unpack_from("<I", data, 4)[0]
    if riff + 8 != n or riff % 2:
        raise ValueError("RIFF size %d does not match the file (%d bytes)" % (riff, n))
    pos, canvas, image = 12, None, None
    while pos < n:
        if pos + 8 > n:
            raise ValueError("truncated WebP chunk")
        kind = data[pos:pos + 4]
        size = struct.unpack_from("<I", data, pos + 4)[0]
        body = pos + 8
        if body + size > n:
            raise ValueError("WebP chunk overruns the file")
        if kind == b"VP8X":
            if pos != 12 or size < 10:
                raise ValueError("misplaced VP8X")
            if data[body] & 0x02:
                raise ValueError("animated WebP")
            cw = 1 + int.from_bytes(data[body + 4:body + 7], "little")
            ch = 1 + int.from_bytes(data[body + 7:body + 10], "little")
            canvas = (cw, ch)
        elif kind == b"VP8 ":
            raise ValueError("lossy WebP (VP8)")
        elif kind in (b"ANIM", b"ANMF"):
            raise ValueError("animated WebP")
        elif kind == b"VP8L":
            if image is not None:
                raise ValueError("two image chunks")
            if size < 5 or data[body] != 0x2F:
                raise ValueError("bad VP8L signature")
            bits = struct.unpack_from("<I", data, body + 1)[0]
            if bits >> 29:
                raise ValueError("unknown VP8L version")
            image = ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
        pos = body + size + (size & 1)
    if image is None:
        raise ValueError("no VP8L image")
    if canvas is not None and canvas != image:
        raise ValueError("VP8X canvas differs from the image")
    return image


def encode_brick_v3(brick66) -> bytes:
    """The stored image of one v3 brick channel: its 9×8 mosaic as lossless WebP."""
    if _PILImage is None:
        raise RuntimeError("Pillow is not installed")
    m = _np.frombuffer(mosaic_9x8(brick66), dtype=_np.uint8).reshape(V3_MOSAIC_H, V3_MOSAIC_W)
    buf = io.BytesIO()
    _PILImage.fromarray(m, mode="L").save(buf, format="WEBP", lossless=True,
                                          quality=V3_WEBP_QUALITY, method=V3_WEBP_METHOD)
    return buf.getvalue()


def decode_brick_v3(data: bytes, strict: bool = False):
    """66³ voxels (numpy uint8, z, y, x) of a stored v3 brick image: lossless WebP of
    594×528, R channel (what the browser decoder reads), opaque. `strict` also requires
    the unused mosaic slots to be zero. ValueError on anything else."""
    w, h = webp_lossless_size(data)
    if (w, h) != (V3_MOSAIC_W, V3_MOSAIC_H):
        raise ValueError("brick image is %dx%d, expected %dx%d" % (w, h, V3_MOSAIC_W, V3_MOSAIC_H))
    if _PILImage is None:
        raise ValueError("Pillow is not installed")
    with _PILImage.open(io.BytesIO(data)) as im:
        im.load()
        if im.size != (V3_MOSAIC_W, V3_MOSAIC_H):
            raise ValueError("decoded size %r" % (im.size,))
        if im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info:
            alpha = im.getchannel("A") if im.mode in ("RGBA", "LA", "PA") else im.convert("RGBA").getchannel("A")
            if alpha.getextrema()[0] != 255:
                raise ValueError("brick mosaic carries transparency")
        band = im if im.mode == "L" else (im.getchannel(0) if im.mode in ("RGB", "RGBA") else im.convert("RGB").getchannel(0))
        mosaic = band.tobytes()
    return unmosaic_9x8(mosaic, strict=strict)


def superblock_order(grid):
    """Flat brick indices (bz·gy·gx + by·gx + bx) of a level grid (gx, gy, gz), one list
    per 4×4×4 super-block, super-blocks in (SBZ, SBY, SBX) order and the bricks inside in
    (bz, by, bx) order (SPEC §13.4)."""
    gx, gy, gz = (int(v) for v in grid)
    s = V3_SUPER
    out = []
    for sz in range(0, gz, s):
        for sy in range(0, gy, s):
            for sx in range(0, gx, s):
                out.append([(bz * gy + by) * gx + bx
                            for bz in range(sz, min(gz, sz + s))
                            for by in range(sy, min(gy, sy + s))
                            for bx in range(sx, min(gx, sx + s))])
    return out


def pack_layout(lengths, grid=None, max_bricks: int | None = None, max_bytes: int | None = None):
    """Pack layout of one (level, channel) (SPEC §13.4). `lengths` are the stored sizes
    of the bricks in (bz, by, bx) order (0 = absent), `grid` the level's (gx, gy, gz)
    (None: one row along X). Bricks are written super-block by super-block (see
    superblock_order), absent ones skipped; a pack holds whole super-blocks: a new pack
    starts before a super-block that would take a non-empty pack past `max_bricks`
    bricks or `max_bytes` bytes; a super-block that exceeds a limit on its own is split
    in brick order, a new pack starting before a brick that would take a non-empty pack
    past a limit. Returns (layout, npacks, order): layout[i] = (pack, offset, length)
    of brick i in brick order ((0, 0, 0) when absent), order = the present bricks'
    indices in the order the packs concatenate them."""
    max_bricks = V3_PACK_MAX_BRICKS if max_bricks is None else int(max_bricks)
    max_bytes = V3_PACK_MAX_BYTES if max_bytes is None else int(max_bytes)
    lengths = [int(v) for v in lengths]
    if grid is None:
        grid = (len(lengths), 1, 1)
    if int(grid[0]) * int(grid[1]) * int(grid[2]) != len(lengths):
        raise ValueError("pack_layout: %d lengths for grid %r" % (len(lengths), tuple(grid)))
    layout = [(0, 0, 0)] * len(lengths)
    order = []
    pack, count, size = 0, 0, 0
    for block in superblock_order(grid):
        members = [i for i in block if lengths[i] > 0]
        if not members:
            continue
        n, b = len(members), sum(lengths[i] for i in members)
        if count and (count + n > max_bricks or size + b > max_bytes):
            pack, count, size = pack + 1, 0, 0
        split = n > max_bricks or b > max_bytes
        for i in members:
            ln = lengths[i]
            if split and count and (count >= max_bricks or size + ln > max_bytes):
                pack, count, size = pack + 1, 0, 0
            layout[i] = (pack, size, ln)
            order.append(i)
            count += 1
            size += ln
    return layout, (pack + 1 if order else 0), order


def v3_pack_rel(level: int, channel: int, pack: int) -> str:
    """Path of a v3 pack relative to its tree (SPEC §13.3/§13.4)."""
    return "l%d/c%d/p%05d.bin" % (int(level), int(channel), int(pack))


def index_bin_bytes(grids, channels: int, entries, pack_counts=None) -> bytes:
    """`index.bin` of one tree (SPEC §13.3), little-endian: magic LBIX, u16 version 1,
    u16 levels, u16 channels, u16 reserved 0; per level u32 gridX, gridY, gridZ,
    packCount; then per level, per channel, per brick in (bz, by, bx) order
    {u16 pack, u32 offset, u32 length} (length 0 = absent ⇒ pack 0, offset 0).

    `grids` = [(gx, gy, gz)] per level; `entries[k][c]` = gx·gy·gz (pack, offset, length)
    tuples in brick order. packCount of a level = the number of packs of that level
    summed over its channels (pack numbers restart at 0 for every channel; a client
    names a pack l{k}/c{c}/p{pack:05d}.bin). `pack_counts` overrides the computed sums."""
    grids = [tuple(int(v) for v in g) for g in grids]
    channels = int(channels)
    if len(entries) != len(grids):
        raise ValueError("index_bin_bytes: %d entry levels for %d grids" % (len(entries), len(grids)))
    if pack_counts is None:
        pack_counts = []
        for k, g in enumerate(grids):
            total = 0
            for c in range(channels):
                used = [p for p, _o, ln in entries[k][c] if ln]
                total += (max(used) + 1) if used else 0
            pack_counts.append(total)
    head = bytearray(struct.pack("<4sHHHH", INDEX_MAGIC, INDEX_VERSION, len(grids), channels, 0))
    for (gx, gy, gz), pc in zip(grids, pack_counts):
        head += struct.pack("<IIII", gx, gy, gz, int(pc))
    body = []
    for k, (gx, gy, gz) in enumerate(grids):
        if len(entries[k]) != channels:
            raise ValueError("index_bin_bytes: level %d has %d channels" % (k, len(entries[k])))
        n = gx * gy * gz
        for c in range(channels):
            rows = entries[k][c]
            if len(rows) != n:
                raise ValueError("index_bin_bytes: level %d channel %d has %d entries, expected %d"
                                 % (k, c, len(rows), n))
            if _np is not None:
                arr = _np.zeros(n, dtype=[("p", "<u2"), ("o", "<u4"), ("l", "<u4")])
                if n:
                    t = _np.asarray(rows, dtype=_np.int64).reshape(n, 3)
                    if t.min() < 0 or t[:, 0].max() > 0xFFFF or t[:, 1:].max() > 0xFFFFFFFF:
                        raise ValueError("index entry out of range")
                    absent = t[:, 2] == 0
                    arr["p"] = _np.where(absent, 0, t[:, 0])
                    arr["o"] = _np.where(absent, 0, t[:, 1])
                    arr["l"] = t[:, 2]
                body.append(arr.tobytes())
            else:
                body.append(b"".join(struct.pack("<HII", p if ln else 0, o if ln else 0, ln)
                                     for p, o, ln in rows))
    return bytes(head) + b"".join(body)


def parse_index_bin(data: bytes) -> dict:
    """{levels: [{grid:(gx,gy,gz), packCount, entries: [per channel: list or numpy
    structured array of (pack, offset, length)]}], channels} of an index.bin;
    ValueError when malformed (sizes must match exactly)."""
    if len(data) < INDEX_HEAD_BYTES or data[:4] != INDEX_MAGIC:
        raise ValueError("not a brick index (magic)")
    _m, ver, nlev, chans, _r = struct.unpack_from("<4sHHHH", data, 0)
    if ver != INDEX_VERSION:
        raise ValueError("brick index version %d" % ver)
    if nlev < 1 or chans < 1:
        raise ValueError("brick index without levels or channels")
    pos = INDEX_HEAD_BYTES
    if len(data) < pos + INDEX_LEVEL_BYTES * nlev:
        raise ValueError("truncated brick index header")
    levels = []
    for _ in range(nlev):
        gx, gy, gz, pc = struct.unpack_from("<IIII", data, pos)
        levels.append({"grid": (gx, gy, gz), "packCount": pc, "entries": []})
        pos += INDEX_LEVEL_BYTES
    need = pos + INDEX_ENTRY_BYTES * chans * sum(L["grid"][0] * L["grid"][1] * L["grid"][2] for L in levels)
    if len(data) != need:
        raise ValueError("brick index holds %d bytes, expected %d" % (len(data), need))
    dt = [("p", "<u2"), ("o", "<u4"), ("l", "<u4")]
    for L in levels:
        n = L["grid"][0] * L["grid"][1] * L["grid"][2]
        for _c in range(chans):
            if _np is not None:
                L["entries"].append(_np.frombuffer(data, dtype=dt, count=n, offset=pos))
            else:
                L["entries"].append([struct.unpack_from("<HII", data, pos + INDEX_ENTRY_BYTES * i)
                                     for i in range(n)])
            pos += INDEX_ENTRY_BYTES * n
    return {"levels": levels, "channels": chans}


def bricks_v3_manifest(levels, channels: int, timepoints, index: dict, histograms=None,
                       timepoint_histograms=None, producer: str = "pipeline",
                       created_at: str | None = None, dataset: str | None = None,
                       stored=None) -> dict:
    """`bricks/manifest.json` of format 4 (SPEC §13.3), keys in contract order.
    `levels` = level_geometry() entries; `stored[k]` = bricks present (length > 0) in
    level k over all channels (and all trees of a timelapse) = levels[k].brickCount.
    3d: `index` = {"url": "index.bin", "bytes", "sha256"} and `timepoints` None.
    live: `index` None (the root key is then absent) and `timepoints` = [{"path": "t000",
    "index": {"url": "t000/index.bin", "bytes", "sha256"}}, …] (urls relative to bricks/)."""
    rows = []
    for L in levels:
        X, Y, Z = L["dimensions"]
        vx, vy, vz = L["voxelSize"]
        gx, gy, gz = L["gridSize"]
        rows.append({"level": int(L["level"]), "dimensions": {"x": X, "y": Y, "z": Z},
                     "voxelSize": {"x": vx, "y": vy, "z": vz},
                     "gridSize": {"x": gx, "y": gy, "z": gz},
                     "brickCount": int(stored[int(L["level"])]) if stored is not None else 0})
    doc = {"schema": V3_SCHEMA, "version": 3, "formatVersion": 4}
    if dataset:
        doc["dataset"] = dataset
    doc.update({
        "channels": int(channels), "brickSize": BRICK_SIZE, "apron": V3_APRON,
        "brickPacking": {"mode": "grid", "cols": V3_COLS, "rows": V3_ROWS, "slice": V3_SLICE},
        "encoding": "webp-lossless",
        "levels": rows,
        "timepoints": list(timepoints) if timepoints else None,
    })
    if index is not None:
        doc["index"] = index
    doc["histograms"] = histograms if isinstance(histograms, list) else []
    if timepoint_histograms:
        doc["timepointHistograms"] = timepoint_histograms
    doc["producer"] = producer
    doc["createdAt"] = created_at or _utc_iso()
    return doc


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
_UNIT_RE_M003 = re.compile(r"^t(\d{1,6})\.l(\d{1,5})\.c(\d{1,3})\.y(\d{1,4})\.x(\d{1,4})\Z", re.ASCII)
_UNIT_RE_M004 = re.compile(r"^t(\d{1,6})\.k(\d{1,2})\.c(\d{1,3})\.z(\d{1,5})\.y(\d{1,5})\.x(\d{1,5})\Z", re.ASCII)
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
                 "index", "nbx", "nby", "nbz", "tiles_x", "tiles_y", "v3_index_ref")


class Plan:
    __slots__ = ("dataset", "type", "folder", "ds_dir", "manifest_path", "sha", "trees",
                 "units", "unit_bytes", "total", "empty",
                 "v3", "v3_problem", "voxel", "manifest", "extra")


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


def _voxel_triplet(v):
    if not isinstance(v, dict):
        return None
    try:
        out = tuple(float(v[a]) for a in ("x", "y", "z"))
    except (KeyError, TypeError, ValueError):
        return None
    return out if all(x > 0 and x == x and x != float("inf") for x in out) else None


def _manifest_voxel(manifest: dict, ds_dir: Path):
    """LOD0 voxel size (µm) that drives the v3 Z-halving rule: the bricks manifest's
    `voxelSize` (v3: levels[0].voxelSize), else metadata.json `voxel_size`, else 1 µm
    isotropic (the rule then halves Z with X and Y from the first level on)."""
    if manifest.get("schema") == V3_SCHEMA:
        lv = manifest.get("levels")
        if isinstance(lv, list) and lv and isinstance(lv[0], dict):
            v = _voxel_triplet(lv[0].get("voxelSize"))
            if v:
                return v
    v = _voxel_triplet(manifest.get("voxelSize"))
    if v:
        return v
    v = _voxel_triplet(_read_metadata(ds_dir).get("voxel_size"))
    return v or (1.0, 1.0, 1.0)


def _build_v3_trees(type_dir: str, bricks_root: Path, manifest: dict):
    """Trees of a format-4 bricks manifest (SPEC §13.3). The LOD0 entries of each tree's
    index.bin become Tree.index, so the format-2 machinery (m002 repair on a v4
    dataset) reads the v3 bricks' interiors. Returns (trees, problem): `problem` names
    the first structural fault (index missing or not matching the manifest, a pack
    missing or shorter than its bricks) — the bricks are then not valid."""
    levels = manifest.get("levels")
    if not isinstance(levels, list) or not levels or not all(isinstance(L, dict) for L in levels):
        raise ValueError("levels")
    if manifest.get("brickSize", BRICK_SIZE) != BRICK_SIZE or manifest.get("apron") != V3_APRON:
        raise ValueError("brickSize/apron")
    packing = manifest.get("brickPacking") or {}
    if (packing.get("mode"), packing.get("cols"), packing.get("rows"), packing.get("slice")) != (
            "grid", V3_COLS, V3_ROWS, V3_SLICE):
        raise ValueError("brickPacking")
    channels = manifest.get("channels")
    if isinstance(channels, bool) or not isinstance(channels, int) or not 1 <= channels <= 64:
        raise ValueError("channels")
    grids = []
    for k, L in enumerate(levels):
        if L.get("level") != k:
            raise ValueError("level %d out of order" % k)
        g = L.get("gridSize") or {}
        d = L.get("dimensions") or {}
        dims = (_int_dim(d.get("x")), _int_dim(d.get("y")), _int_dim(d.get("z")))
        grid = (_int_dim(g.get("x")), _int_dim(g.get("y")), _int_dim(g.get("z")))
        if grid != tuple(-(-n // BRICK_SIZE) for n in dims):
            raise ValueError("level %d gridSize" % k)
        grids.append(grid)
    d0 = levels[0]["dimensions"]
    dims0 = (_int_dim(d0.get("x")), _int_dim(d0.get("y")), _int_dim(d0.get("z")))
    tps = manifest.get("timepoints")
    refs = {}
    if type_dir == "live" and isinstance(tps, list) and tps:
        rels = []
        for row in tps:
            if not isinstance(row, dict):
                raise ValueError("timepoint row")
            rel = str(row.get("path") or "")
            if not _SAFE_TREE_RE.match(rel):
                raise ValueError("timepoint path %r" % rel)
            rels.append(rel)
            ref = row.get("index")
            if isinstance(ref, dict) and ref.get("url") == rel + "/" + INDEX_NAME:
                refs[rel] = ref
    else:
        rels = [""]
        idx = manifest.get("index")
        if isinstance(idx, dict) and idx.get("url") == INDEX_NAME:
            refs[""] = idx
    trees, problem, seen = [], None, set()
    for i, rel in enumerate(rels):
        if rel and not _SAFE_TREE_RE.match(rel):
            raise ValueError("timepoint path %r" % rel)
        t = _frame_number(rel, i) if rel else 0
        if t in seen:
            raise ValueError("timepoint %r twice" % rel)
        seen.add(t)
        tree = Tree()
        tree.t, tree.rel = t, rel
        tree.bricks_dir = bricks_root / rel if rel else bricks_root
        tree.dims = dims0
        tree.channels = channels
        tree.nbx, tree.nby, tree.nbz = grids[0]
        tree.tiles_x, tree.tiles_y = -(-dims0[0] // TILE_SIZE), -(-dims0[1] // TILE_SIZE)
        tree.encoding = V3_ENCODING
        tree.packing = dict(packing)
        tree.v3_index_ref = refs.get(rel)
        tree.index = {}
        try:
            tree.index = _v3_tree_lod0_index(tree, grids, channels)
        except ValueError as exc:
            problem = problem or ("%s: %s" % (rel or "bricks", exc))
        trees.append(tree)
    return trees, problem


def _v3_tree_lod0_index(tree: Tree, grids, channels: int) -> dict:
    """Validate one v3 tree (index bytes + sha256 against the manifest, grids, every
    referenced pack present and long enough) and return its LOD0 brick index."""
    ref = tree.v3_index_ref
    if not ref:
        raise ValueError("no (valid) index entry in the manifest")
    path = tree.bricks_dir / INDEX_NAME
    try:
        st = path.stat()
    except OSError:
        raise ValueError("index.bin missing")
    if st.st_size != ref.get("bytes"):
        raise ValueError("index.bin size %d, manifest says %r" % (st.st_size, ref.get("bytes")))
    if _manifest_sha(path) != ref.get("sha256"):
        raise ValueError("index.bin sha256 differs from the manifest")
    parsed = parse_index_bin(path.read_bytes())
    if parsed["channels"] != channels or [L["grid"] for L in parsed["levels"]] != list(grids):
        raise ValueError("index.bin grids/channels differ from the manifest")
    index = {}
    gx, gy, _gz = grids[0]
    for k, L in enumerate(parsed["levels"]):
        for c, arr in enumerate(L["entries"]):
            ends: dict = {}
            if _np is not None:
                present = _np.nonzero(arr["l"])[0]
                packs = arr["p"][present].astype(_np.int64)
                end = arr["o"][present].astype(_np.int64) + arr["l"][present].astype(_np.int64)
                for pk in _np.unique(packs):
                    ends[int(pk)] = int(end[packs == pk].max())
                rows = ((int(i), int(arr["p"][i]), int(arr["o"][i]), int(arr["l"][i]))
                        for i in present.tolist()) if k == 0 else ()
            else:
                rows = []
                for i, (pk, off, ln) in enumerate(arr):
                    if ln:
                        ends[pk] = max(ends.get(pk, 0), off + ln)
                        rows.append((i, pk, off, ln))
                if k:
                    rows = []
            for i, pk, off, ln in rows:
                bx, rest = i % gx, i // gx
                by, bz = rest % gy, rest // gy
                index[(c, bx, by, bz)] = (tree.bricks_dir / v3_pack_rel(0, c, pk), off, ln)
            for pk, end in ends.items():
                p = tree.bricks_dir / v3_pack_rel(k, c, pk)
                try:
                    size = p.stat().st_size
                except OSError:
                    raise ValueError("%s missing" % v3_pack_rel(k, c, pk))
                if size < end:
                    raise ValueError("%s holds %d bytes, its bricks end at %d" % (v3_pack_rel(k, c, pk), size, end))
    return index


def _v3_index_stamp_trees(trees) -> tuple:
    """(mtime, size) of every tree's index.bin: a v3 plan (and its validity verdict) is
    reused only while neither the manifest nor an index changed."""
    out = []
    for tree in sorted(trees, key=lambda tr: tr.t):
        try:
            st = (tree.bricks_dir / INDEX_NAME).stat()
            out.append((st.st_mtime_ns, st.st_size))
        except OSError:
            out.append(None)
    return tuple(out)


def _v3_index_stamp(plan) -> tuple:
    return _v3_index_stamp_trees([plan.trees[t] for t in sorted(plan.trees)])


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
    if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size and (
            not hit[2].v3 or hit[2].extra.get("_index_stamp") == _v3_index_stamp(hit[2])):
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
        is_v3 = manifest.get("schema") == V3_SCHEMA
        v3_problem = None
        if is_v3:
            trees, v3_problem = _build_v3_trees(type_dir, bricks_root, manifest)
        elif type_dir == "live" and isinstance(tps, dict) and tps:
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
    plan.v3, plan.v3_problem, plan.manifest, plan.extra = is_v3, v3_problem, manifest, {}
    if is_v3:
        plan.extra["_index_stamp"] = _v3_index_stamp_trees(trees)
    plan.voxel = _manifest_voxel(manifest, ds_dir)
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


def tree_mips_valid(plan: Plan, tree: Tree, root_name: str = "mips") -> bool:
    d = _tree_planes_dir(plan.ds_dir, tree, root_name)
    try:
        doc = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    except Exception:
        return False
    if not isinstance(doc, dict):
        return False
    X, Y, Z = tree.dims
    expect = mips_manifest({"x": X, "y": Y, "z": Z}, tree.channels, plan.sha, "")
    for key in ("schema", "formatVersion", "level", "dimensions", "channels", "tileSize", "tiles",
                "codec", "layers", "layerDepth", "packPattern", "headerBytes"):
        if doc.get(key) != expect[key]:
            return False
    if (doc.get("source") or {}).get("manifestSha256") != plan.sha:
        return False
    try:
        names = set(os.listdir(d))
    except OSError:
        return False
    return all(mip_pack_name(lay) in names for lay in range(expect["layers"]))



def dataset_mips_valid(plan: Plan, root_name: str = "mips") -> bool:
    return all(tree_mips_valid(plan, tree, root_name) for tree in plan.trees.values())



def dataset_bricks_v3_valid(plan: Plan) -> bool:
    return bool(plan.v3) and plan.v3_problem is None


M002, M003, M004 = "m002-planes", "m003-layer-mips", "m004-bricks-v3"
# (incoming, live, old) directory names of the structure each migration swaps in.
_SWAP_DIRS = {M002: (".planes-incoming", "planes", ".planes-old"),
              M003: (".mips-incoming", "mips", ".mips-old"),
              M004: (".bricks-incoming", "bricks", "bricks.v2-old")}



class UnitSet:
    """The work of one migration on one dataset: the non-empty units (tuples, in the
    order executors should take them), their input bytes, the totals the journal
    counts (`empty` units are done at plan time), `exact` = False for an estimate made
    before the inputs exist. m003: `refs[unit]` = [(z, offset, length)] of its plane
    tiles, `inputs` = sha256 of each tree's planes manifest. m004: `levels` = the
    level_geometry() of the trees, `group_size[(t, c, k)]` = non-empty units."""

    __slots__ = ("mid", "units", "unit_bytes", "total", "empty", "exact", "levels", "refs",
                 "group_size", "inputs")

    def __init__(self, mid):
        self.mid = mid
        self.units, self.unit_bytes, self.total, self.empty = [], {}, 0, 0
        self.exact, self.levels, self.refs, self.group_size, self.inputs = True, None, None, None, {}



def unit_key_for(mid: str, unit) -> str:
    """Key string of a unit: m002 t.z.c.y.x (§4), m003 t.l.c.y.x (§12), m004
    t.k.c.z.y.x (§13.5)."""
    if mid == M003:
        return "t%d.l%d.c%d.y%d.x%d" % tuple(unit)
    if mid == M004:
        return "t%d.k%d.c%d.z%d.y%d.x%d" % tuple(unit)
    return unit_key(*unit)



def parse_unit_key_for(mid: str, key) -> tuple:
    rx = {M003: _UNIT_RE_M003, M004: _UNIT_RE_M004}.get(mid, _UNIT_RE)
    m = rx.match(str(key or ""))
    if not m:
        raise MigrationError("bad_unit")
    return tuple(int(g) for g in m.groups())



def _unitset(plan: Plan, mid: str) -> UnitSet:
    if mid == M002:
        us = plan.extra.get(M002)
        if us is None:
            us = UnitSet(M002)
            us.units, us.unit_bytes, us.total, us.empty = plan.units, plan.unit_bytes, plan.total, plan.empty
            plan.extra[M002] = us
        return us
    if mid == M003:
        return _m003_unitset(plan)
    if mid == M004:
        return _m004_unitset(plan)
    raise MigrationError("unknown_migration")



def _m003_unitset(plan: Plan) -> UnitSet:
    """Units of m003 read from the plane pack headers (headerBytes per z): a unit is
    empty when all its ≤ 64 plane tiles have length 0. Cached while the planes
    manifests are unchanged. MigrationError planes_missing when planes/ is not valid."""
    stamp = []
    for t in sorted(plan.trees):
        p = _tree_planes_dir(plan.ds_dir, plan.trees[t]) / "manifest.json"
        try:
            st = p.stat()
            stamp.append((st.st_mtime_ns, st.st_size))
        except OSError:
            stamp.append(None)
    hit = plan.extra.get(M003)
    if hit is not None and hit[0] == stamp:
        return hit[1]
    if not dataset_planes_valid(plan):
        raise MigrationError("planes_missing", 409)
    us = UnitSet(M003)
    refs, total = {}, 0
    for t in sorted(plan.trees):
        tree = plan.trees[t]
        _X, _Y, Z = tree.dims
        d = _tree_planes_dir(plan.ds_dir, tree)
        us.inputs[str(t)] = _manifest_sha(d / "manifest.json")
        hb = pack_header_bytes(tree.channels, tree.tiles_x, tree.tiles_y)
        per_c = tree.tiles_y * tree.tiles_x
        total += -(-Z // LAYER_DEPTH) * tree.channels * per_c
        for z in range(Z):
            name = pack_name(z)
            try:
                with open(d / name, "rb") as fh:
                    head = fh.read(hb)
                if len(head) != hb:
                    raise ValueError("truncated header")
                zz, cc, ttx, tty, entries = parse_plane_pack(head, header_only=True)
            except (OSError, ValueError) as exc:
                raise MigrationError("planes_invalid", 409, "%s: %s" % (name, exc))
            if (zz, cc, ttx, tty) != (z, tree.channels, tree.tiles_x, tree.tiles_y):
                raise MigrationError("planes_invalid", 409, "%s: header" % name)
            layer = z // LAYER_DEPTH
            for i, (off, ln) in enumerate(entries):
                if ln:
                    c, rem = divmod(i, per_c)
                    ty, tx = divmod(rem, tree.tiles_x)
                    refs.setdefault((t, layer, c, ty, tx), []).append((z, off, ln))
    us.refs = refs
    us.units = sorted(refs)
    us.unit_bytes = {u: sum(r[2] for r in v) for u, v in refs.items()}
    us.total, us.empty = total, total - len(us.units)
    plan.extra[M003] = (stamp, us)
    return us



def _m003_estimate(plan: Plan) -> dict:
    """m003 before planes/ exists: every unit counted (an upper bound), the bytes it
    will read estimated from the bricks."""
    total = sum(-(-tree.dims[2] // LAYER_DEPTH) * tree.channels * tree.tiles_y * tree.tiles_x
                for tree in plan.trees.values())
    est = int(sum(plan.unit_bytes.values()) * PLANES_SIZE_RATIO)
    return {"units": total, "bytes": est, "unitsTotal": total, "bytesTotal": est, "exact": False}



def _m004_geometry(plan: Plan):
    """The level geometry shared by every tree (a timelapse's frames must agree)."""
    trees = [plan.trees[t] for t in sorted(plan.trees)]
    first = trees[0]
    for tree in trees[1:]:
        if tree.dims != first.dims or tree.channels != first.channels:
            raise MigrationError("trees_differ", 409, "timepoint %s: %r x %d channels, %s: %r x %d"
                                 % (first.rel, first.dims, first.channels, tree.rel, tree.dims, tree.channels))
    try:
        return level_geometry(first.dims, plan.voxel)
    except ValueError as exc:
        raise MigrationError("manifest_invalid", 409, str(exc))



def _m004_unitset(plan: Plan) -> UnitSet:
    """Units of m004 (SPEC §13.5): super-blocks of 4×4×4 bricks of every level, channel
    and tree, ordered by level. A level-k unit is empty iff no v2 LOD0 brick of its
    channel lies in its LOD0 footprint (level-k brick b covers LOD0 bricks b·2^k in XY
    and b·2^hz in Z, hz = the Z halvings up to k): known from the v2 manifest alone.
    The bytes of a level-k unit are its footprint's v2 bytes / (4^k·2^hz) (estimate)."""
    hit = plan.extra.get(M004)
    if hit is not None:
        return hit
    if plan.v3:
        raise MigrationError("already_v3", 409)
    levels = _m004_geometry(plan)
    zshift = [0]
    for L in levels[1:]:
        zshift.append(zshift[-1] + (1 if L["halveZ"] else 0))
    us = UnitSet(M004)
    us.levels = levels
    unit_bytes, groups, total = {}, {}, 0
    for t in sorted(plan.trees):
        tree = plan.trees[t]
        for c in range(tree.channels):
            for k, L in enumerate(levels):
                gx, gy, gz = L["gridSize"]
                total += (-(-gx // V3_SUPER)) * (-(-gy // V3_SUPER)) * (-(-gz // V3_SUPER))
        for (c, bx, by, bz), (_p, _o, length) in tree.index.items():
            for k in range(len(levels)):
                u = (t, k, c, (bz >> zshift[k]) // V3_SUPER, (by >> k) // V3_SUPER, (bx >> k) // V3_SUPER)
                unit_bytes[u] = unit_bytes.get(u, 0) + length
    for u in list(unit_bytes):
        k = u[1]
        unit_bytes[u] = max(1, unit_bytes[u] >> (2 * k + zshift[k]))
        g = (u[0], u[2], k)
        groups[g] = groups.get(g, 0) + 1
    us.units = sorted(unit_bytes, key=lambda u: (u[1], u[0], u[2], u[3], u[4], u[5]))
    us.unit_bytes = unit_bytes
    us.total, us.empty = total, total - len(us.units)
    us.group_size = groups
    plan.extra[M004] = us
    return us



def _pending_units(us: UnitSet, done) -> tuple:
    """(runnable, pending) units not yet done. m004 (SPEC §13.5): a level-k unit of tree
    t / channel c is runnable only once every unit of the lower levels of (t, c) is
    done — its inputs are those levels' bricks; every other migration's pending units
    are all runnable."""
    pending = [u for u in us.units if unit_key_for(us.mid, u) not in done]
    if us.mid != M004:
        return pending, pending
    frontier = {}
    for u in pending:
        g = (u[0], u[2])
        if u[1] < frontier.get(g, 1 << 30):
            frontier[g] = u[1]
    return [u for u in pending if u[1] == frontier[(u[0], u[2])]], pending



V3_PARTS = 8     # octants (2×2×2 bricks) of a super-block: a slow PHP host's server steps


def _m004_part_bricks(unit, part=None):
    """Brick range [b0, b1) per axis (x, y, z) of a unit's super-block or, for part in
    [0, 8), of its octant (axis bit x = part & 1, y = part >> 1 & 1, z = part >> 2 & 1);
    not clipped to the grid. Twin of lumen_v3_part_bricks."""
    _t, _k, _c, BZ, BY, BX = unit
    out = []
    for a, B in enumerate((BX, BY, BZ)):
        if part is None or part < 0:
            out.append((V3_SUPER * B, V3_SUPER * B + V3_SUPER))
        else:
            b0 = V3_SUPER * B + 2 * ((part >> a) & 1)
            out.append((b0, b0 + 2))
    return out



def _m004_unit_ranges(us: UnitSet, unit, part=None):
    """Level-k voxel range [lo, hi) per axis (x, y, z) that a unit's 66³ bricks read: its
    4×4×4 bricks' interiors (or those of its octant `part`) plus the 1-voxel apron,
    clipped to the level (clamped coordinates then fall inside it)."""
    L = us.levels[unit[1]]
    out = []
    for (b0, b1), n in zip(_m004_part_bricks(unit, part), L["dimensions"]):
        out.append((max(0, BRICK_SIZE * b0 - V3_APRON), min(n, BRICK_SIZE * b1 + V3_APRON)))
    return out



def _m004_unit_bricks(us: UnitSet, unit, part=None):
    """(bz, by, bx) of the bricks of a unit (its super-block, or its octant `part`, ∩ the
    level's grid)."""
    gx, gy, gz = us.levels[unit[1]]["gridSize"]
    (x0, x1), (y0, y1), (z0, z1) = _m004_part_bricks(unit, part)
    return [(bz, by, bx)
            for bz in range(z0, min(gz, z1))
            for by in range(y0, min(gy, y1))
            for bx in range(x0, min(gx, x1))]



def _m004_source_ranges(us: UnitSet, unit, part=None):
    """The previous level's voxel range [lo, hi) per axis (x, y, z) that the reduction of a
    level-k ≥ 1 unit's range needs: [2·lo, min(2·hi, n)) on a halved axis (2·lo is even,
    so the 2-voxel blocks line up; a cut at n is the level's own edge), the range
    itself on a Z axis this level did not halve."""
    _t, k, _c, _BZ, _BY, _BX = unit
    L, P = us.levels[k], us.levels[k - 1]
    rng = _m004_unit_ranges(us, unit, part)
    out = []
    for axis, ((lo, hi), n) in enumerate(zip(rng, P["dimensions"])):
        if axis == 2 and not L["halveZ"]:
            out.append((lo, hi))
        else:
            out.append((2 * lo, min(n, 2 * hi)))
    return out



def _bricks_overlapping(rng, grid):
    """(bz, by, bx) of the bricks of a grid whose interior meets the voxel range."""
    (x0, x1), (y0, y1), (z0, z1) = rng
    gx, gy, gz = grid
    return [(bz, by, bx)
            for bz in range(z0 // BRICK_SIZE, min(gz, -(-z1 // BRICK_SIZE)))
            for by in range(y0 // BRICK_SIZE, min(gy, -(-y1 // BRICK_SIZE)))
            for bx in range(x0 // BRICK_SIZE, min(gx, -(-x1 // BRICK_SIZE)))]



def _paste_brick(region, origin, b, vox) -> None:
    """Copy the part of a brick interior (64³, z, y, x, brick coords b = (bz, by, bx))
    that lies in `region` (voxels [origin, origin + shape), origin = (x, y, z))."""
    ox, oy, oz = origin
    Rz, Ry, Rx = region.shape
    sl_r, sl_v = [], []
    for bb, o, R in zip(b, (oz, oy, ox), (Rz, Ry, Rx)):
        v0 = bb * BRICK_SIZE
        a0, a1 = max(v0, o), min(v0 + BRICK_SIZE, o + R)
        if a0 >= a1:
            return
        sl_r.append(slice(a0 - o, a1 - o))
        sl_v.append(slice(a0 - v0, a1 - v0))
    region[tuple(sl_r)] = vox[tuple(sl_v)]



def _v3_store_brick(store: Path, t: int, k: int, c: int, bz: int, by: int, bx: int) -> Path:
    return store / ("t%d" % t) / ("k%d" % k) / ("c%d" % c) / ("z%d.y%d.x%d.webp" % (bz, by, bx))



class _BrickCache:
    """A small LRU of decoded brick interiors: consecutive units of one level share
    their neighbour bricks (the apron ring at level 0, the 10-brick source span above)."""

    def __init__(self, cap: int = 160):
        self.cap, self.data = cap, {}

    def get(self, key):
        v = self.data.pop(key, None)
        if v is not None:
            self.data[key] = v
        return v

    def put(self, key, value):
        self.data[key] = value
        while len(self.data) > self.cap:
            self.data.pop(next(iter(self.data)))



def process_unit_m004(plan: Plan, us: UnitSet, unit, store: Path, cache: "_BrickCache | None" = None,
                      part=None):
    """Server executor of one m004 unit (SPEC §13.5): build the level-k voxels of the
    unit's range — level 0 from the v2 LOD0 bricks (absent = zeros), level k ≥ 1 by
    reduce_level() of the level k−1 bricks in the tile store — then cut, ESS and encode
    its 66³ bricks. `part` in [0, 8): only that octant's bricks (every brick depends on
    the level's voxels alone, so the 8 octants are exactly the unit). Returns
    ({(bz, by, bx): webp}, bytes_read)."""
    if _np is None:
        raise MigrationError("server_unavailable", 409, "numpy is not installed")
    t, k, c, _BZ, _BY, _BX = unit
    tree = plan.trees.get(t)
    if tree is None or k >= len(us.levels) or c >= tree.channels:
        raise MigrationError("bad_unit")
    L = us.levels[k]
    rng = _m004_unit_ranges(us, unit, part)
    if any(lo >= hi for lo, hi in rng):
        return {}, 0
    bytes_read = 0
    cache = cache if cache is not None else _BrickCache()
    if k == 0:
        src_rng, grid = rng, L["gridSize"]
    else:
        src_rng, grid = _m004_source_ranges(us, unit, part), us.levels[k - 1]["gridSize"]
    (sx0, sx1), (sy0, sy1), (sz0, sz1) = src_rng
    src = _np.zeros((sz1 - sz0, sy1 - sy0, sx1 - sx0), dtype=_np.uint8)
    wanted = _bricks_overlapping(src_rng, grid)
    if k == 0:
        by_file: dict = {}
        for b in wanted:
            bz, by, bx = b
            hit = cache.get(("v2", t, c, b))
            if hit is not None:
                _paste_brick(src, (sx0, sy0, sz0), b, hit)
                continue
            ref = tree.index.get((c, bx, by, bz))
            if ref is not None:
                by_file.setdefault(ref[0], []).append((ref[1], ref[2], b))
        for path, items in by_file.items():
            items.sort()
            try:
                fh = open(path, "rb")
            except OSError:
                raise MigrationError("brick_unreadable", 500, f"{path.name}: missing")
            with fh:
                for off, length, b in items:
                    fh.seek(off)
                    raw = fh.read(length)
                    if len(raw) != length:
                        raise MigrationError("brick_unreadable", 500, f"{path.name}@{off}: short read")
                    bytes_read += length
                    try:
                        vox = _np.frombuffer(decode_brick(raw, tree.encoding, tree.packing),
                                             dtype=_np.uint8).reshape(BRICK_SIZE, BRICK_SIZE, BRICK_SIZE)
                    except Exception as exc:
                        raise MigrationError("brick_undecodable", 500, f"c{c} x{b[2]} y{b[1]} z{b[0]}: {exc}")
                    cache.put(("v2", t, c, b), vox)
                    _paste_brick(src, (sx0, sy0, sz0), b, vox)
        region = src
    else:
        for b in wanted:
            key = ("v3", t, k - 1, c, b)
            vox = cache.get(key)
            if vox is None:
                p = _v3_store_brick(store, t, k - 1, c, *b)
                try:
                    raw = p.read_bytes()
                except FileNotFoundError:
                    continue
                bytes_read += len(raw)
                try:
                    vox = decode_brick_v3(raw)[1:-1, 1:-1, 1:-1]
                except Exception as exc:
                    raise MigrationError("brick_undecodable", 500, f"level {k - 1} c{c} {b}: {exc}")
                cache.put(key, vox)
            _paste_brick(src, (sx0, sy0, sz0), b, vox)
        region = reduce_level(src, L["halveZ"])
        expect = tuple(hi - lo for lo, hi in reversed(rng))
        if region.shape != expect:
            raise MigrationError("internal", 500, "reduced region %r, expected %r" % (region.shape, expect))
    origin = (rng[0][0], rng[1][0], rng[2][0])
    out = {}
    for bz, by, bx in _m004_unit_bricks(us, unit, part):
        b66 = brick_with_apron(region, bz, by, bx, L["dimensions"], origin)
        if brick_interior_nonzero(b66):
            out[(bz, by, bx)] = encode_brick_v3(b66)
    return out, bytes_read



def process_unit_m003(plan: Plan, us: UnitSet, unit):
    """Server executor of one m003 unit: the ≤ 64 plane tiles of (c, ty, tx) in layer l,
    read from planes/ by their pack offsets, decoded, max'ed. (png or None, bytes)."""
    t, layer, c, ty, tx = unit
    tree = plan.trees.get(t)
    if tree is None:
        raise MigrationError("bad_unit")
    X, Y, _Z = tree.dims
    w, h = min(TILE_SIZE, X - tx * TILE_SIZE), min(TILE_SIZE, Y - ty * TILE_SIZE)
    d = _tree_planes_dir(plan.ds_dir, tree)
    tiles, nread = [], 0
    for z, off, length in us.refs.get(unit) or []:
        try:
            with open(d / pack_name(z), "rb") as fh:
                fh.seek(off)
                png = fh.read(length)
        except OSError:
            raise MigrationError("plane_unreadable", 500, pack_name(z))
        if len(png) != length:
            raise MigrationError("plane_unreadable", 500, f"{pack_name(z)}@{off}: short read")
        nread += length
        try:
            pw, ph, px = decode_png_gray8(png)
        except ValueError as exc:
            raise MigrationError("plane_undecodable", 500, f"{pack_name(z)} c{c} y{ty} x{tx}: {exc}")
        if (pw, ph) != (w, h):
            raise MigrationError("plane_undecodable", 500, f"{pack_name(z)}: tile {pw}x{ph}")
        tiles.append(px)
    mip = mip_tile(tiles)
    if mip is None or mip.count(0) == len(mip):
        return None, nread
    return png_gray8(w, h, mip), nread



def mip_tile_path(store: Path, unit) -> Path:
    t, layer, c, ty, tx = unit
    return store / ("t%d" % t) / ("l%d" % layer) / ("c%d.y%d.x%d.png" % (c, ty, tx))



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
    for k in ("partial", "attempts", "timing"):     # the PHP executor's step bookkeeping
        if k in j and not j[k]:
            del j[k]
    j["updatedAt"] = _utc_iso()
    _atomic_write(path, json.dumps(j, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def _summary(j: dict, us: "UnitSet | None" = None) -> dict:
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
    if us is not None:
        done_set = set(j.get("done") or [])
        out["bytesRemaining"] = sum(b for u, b in us.unit_bytes.items()
                                    if unit_key_for(us.mid, u) not in done_set)
    return out


def _migration(mid) -> dict:
    m = _MIGRATIONS_BY_ID.get(str(mid or ""))
    if m is None:
        raise MigrationError("unknown_migration")
    return m


def _repair_needed(plan: Plan, fv: int, m: dict) -> bool:
    """The version claims the migration's structure but it is missing or invalid. A v4
    dataset whose v3 bricks are damaged is NOT repairable by m004 (its v2 source is gone):
    that is reported as a problem by dataset_status, never as a pending repair."""
    if fv < m["to"]:
        return False
    if m["id"] == M004:
        return not plan.v3
    return not _structure_valid(plan, m["id"])


def _applicable(plan: Plan, fv: int, m: dict) -> bool:
    return plan.type in m["types"] and (fv == m["from"] or _repair_needed(plan, fv, m))


def _check_source(plan: Plan, j: dict, path: Path, persist: bool = True) -> None:
    """Fail the job when a bricks manifest (or, for m003, a planes manifest) changed since
    it was planned. `persist` (only under the job lock) records the failure."""
    current = _manifest_sha(plan.manifest_path)
    changed = any(sha != current for sha in (j.get("sourceManifests") or {}).values())
    if not changed:
        for t, sha in (j.get("inputManifests") or {}).items():
            tree = plan.trees.get(_as_int(t, -1))
            p = _tree_planes_dir(plan.ds_dir, tree) / "manifest.json" if tree is not None else None
            try:
                cur = _manifest_sha(p) if p is not None else None
            except OSError:
                cur = None
            if cur != sha:
                changed = True
                break
    if changed:
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


def _check_disk(plan: Plan, mid: str = M002, us: "UnitSet | None" = None) -> None:
    """Refuse a new job the disk cannot hold (507 insufficient_disk, as the import
    does): the tile store under uploads/ and the structure assembled beside the dataset
    each need about `est` bytes, both at once during finalize."""
    if mid == M003 and us is not None:
        est = int(sum(us.unit_bytes.values()) * MIPS_SIZE_RATIO)
    elif mid == M004:
        # The v2 pyramid weighs ~8/7 of its LOD0; v3 ~BRICKS_V3_SIZE_RATIO of v2.
        est = int(sum(plan.unit_bytes.values()) * 8 / 7 * BRICKS_V3_SIZE_RATIO)
    else:
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
    page of the pending unit keys an executor may take NOW (`units`; for m004 the
    pending units of the lowest unfinished level of each tree/channel, `runnable` of
    `pending`)."""
    m = _migration(mid)
    try:
        m, plan, path = _open_job(dataset_id, mid)
    except MigrationError as exc:
        # m004 interrupted between its two renames: bricks/ is momentarily absent.
        if m["id"] == M004 and exc.code in ("no_manifest", "manifest_invalid"):
            type_dir, folder, _ds = _resolve_dataset(dataset_id)
            j = _load_journal(journal_path(type_dir, folder, m["id"]))
            if j is not None and (j.get("state") == "swapped" or (_ds / ".bricks-incoming").is_dir()):
                return _swapped_only_summary(j)
        raise
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
        if j is not None and j.get("state") != "swapped":
            try:
                _check_source(plan, j, path, persist=False)
            except MigrationError:
                _rmtree(tile_store_dir(plan.type, plan.folder, m["id"]))
                j = None
        if j is not None and j.get("attempts"):
            # A (re)started job gives the PHP server executor's units a fresh count
            # (lumen_mig_plan): max_execution_time may have been raised since.
            j.pop("attempts", None)
            _save_journal(path, j)
        if j is None:
            fv = format_version(_read_metadata(plan.ds_dir))
            if not _applicable(plan, fv, m):
                raise MigrationError("not_applicable", 409)
            incoming = _SWAP_DIRS[m["id"]][0]
            if m["id"] == M004 and plan.v3:
                # A v3 tree already in place at version 3 (a swap whose journal was
                # lost): only the re-stamp and the bump remain.
                if not dataset_bricks_v3_valid(plan):
                    raise MigrationError("bricks_v3_invalid", 409, plan.v3_problem)
                j = {"migration": m["id"], "dataset": plan.dataset, "createdAt": _utc_iso(),
                     "sourceManifests": {}, "units": {"total": 0, "empty": 0}, "done": [],
                     "executors": {"browser": 0, "server": 0}, "state": "swapped",
                     "newManifestSha": plan.sha}
                _save_journal(path, j)
                return _swapped_only_summary(j)
            us = _unitset(plan, m["id"])
            _rmtree(plan.ds_dir / incoming)
            _check_disk(plan, m["id"], us)
            j = {
                "migration": m["id"], "dataset": plan.dataset, "createdAt": _utc_iso(),
                "sourceManifests": {str(t): plan.sha for t in sorted(plan.trees)},
                "units": {"total": us.total, "empty": us.empty},
                "done": [], "executors": {"browser": 0, "server": 0}, "state": "running",
            }
            if us.inputs:
                j["inputManifests"] = dict(us.inputs)
            _save_journal(path, j)
    if j.get("state") == "swapped":
        return _swapped_only_summary(j)
    us = _unitset(plan, m["id"])
    done = set(j.get("done") or [])
    runnable, pending = _pending_units(us, done)
    offset = max(0, _as_int(offset, 0))
    limit = max(1, min(100000, _as_int(limit, 10000) or 10000))
    out = _summary(j, us)
    keys = [unit_key_for(m["id"], u) for u in runnable]
    out.update({"pending": len(pending), "runnable": len(runnable), "offset": offset,
                "units": keys[offset:offset + limit]})
    if m["id"] == M004:
        out["levels"] = _levels_progress(us, done)
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
            # A done unit drops the PHP server executor's step bookkeeping (octants
            # stored so far, steps started: lumen_mig_mark_done).
            for book in ("partial", "attempts"):
                if isinstance(j.get(book), dict):
                    j[book].pop(k, None)
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
    """Browser executor: store the encoded result of one unit (idempotent). Blob layouts:
    m002 §5.1 (planes), m003 the same with the layer index in place of z (≤ 1 entry),
    m004 parse_v3_unit_blob()."""
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
    mid = m["id"]
    unit = parse_unit_key_for(mid, key)
    store = tile_store_dir(plan.type, plan.folder, mid)
    if mid == M002:
        tree, w, h, z0, depth = _unit_geometry(plan, unit)
    elif mid == M003:
        tree, w, h = _m003_unit_geometry(plan, unit)
    us = _unitset(plan, mid)
    if mid == M004:
        _m004_check_unit(us, plan, unit)
    if unit not in us.unit_bytes:
        raise MigrationError("empty_unit", 409)
    j = _load_journal(path)
    if j is None:
        raise MigrationError("no_job", 404)
    _check_source(plan, j, path, persist=False)
    if j.get("state") != "running":
        raise MigrationError("job_not_running", 409)
    if mid == M002:
        tiles = {}
        for z, png in parse_unit_blob(body):
            if not (z0 <= z < z0 + depth) or z in tiles:
                raise MigrationError("bad_blob", 400, f"plane {z} outside the unit's layer")
            try:
                is_zero = validate_png_gray8(png, w, h)
            except ValueError as exc:
                raise MigrationError("bad_png", 400, f"z{z}: {exc}")
            tiles[z] = None if is_zero else png
        _write_unit_tiles(plan, mid, unit, {z: p for z, p in tiles.items() if p is not None})
    elif mid == M003:
        entries = parse_unit_blob(body)
        if len(entries) > 1:
            raise MigrationError("bad_blob", 400, "an m003 unit holds one tile")
        png = None
        for layer, data in entries:
            if layer != unit[1]:
                raise MigrationError("bad_blob", 400, f"layer {layer}, unit is layer {unit[1]}")
            try:
                png = None if validate_png_gray8(data, w, h) else data
            except ValueError as exc:
                raise MigrationError("bad_png", 400, f"l{layer}: {exc}")
        _write_mip_tile(store, unit, png)
    else:
        if not _m004_level_ready(us, set(j.get("done") or []), unit):
            raise MigrationError("unit_blocked", 409, "a lower level of this tree/channel is not complete")
        allowed = set(_m004_unit_bricks(us, unit))
        bricks = {}
        for bz, by, bx, data in parse_v3_unit_blob(body):
            b = (bz, by, bx)
            if b not in allowed or b in bricks:
                raise MigrationError("bad_blob", 400, f"brick z{bz} y{by} x{bx} outside the unit")
            try:
                keep = validate_v3_brick(data)
            except ValueError as exc:
                raise MigrationError("bad_webp", 400, f"z{bz} y{by} x{bx}: {exc}")
            bricks[b] = data if keep else None
        _write_unit_m004(us, store, unit, {b: d for b, d in bricks.items() if d})
    j = _mark_done(plan, m, path, [unit_key_for(mid, unit)], "browser")
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
    """Server executor: process runnable units for at most ~max_seconds (at least one)."""
    m, plan, path = _open_job(dataset_id, mid)
    try:
        budget = float(max_seconds)
    except (TypeError, ValueError):
        budget = MAX_RUN_SECONDS
    budget = max(1.0, min(float(MAX_RUN_SECONDS), budget))
    base = _job_base(plan, mid=m["id"])
    store = tile_store_dir(plan.type, plan.folder, m["id"])
    t0 = time.monotonic()
    processed, bytes_read, bytes_written, slowest = [], 0, 0, 0.0
    with _JobLock(base):
        j = _load_journal(path)
        if j is None:
            raise MigrationError("no_job", 404)
        _check_source(plan, j, path)
    if j.get("state") != "running":
        raise MigrationError("job_not_running", 409)
    us = _unitset(plan, m["id"])
    cache = _BrickCache()
    taken = set()
    while True:
        done = set(j.get("done") or [])
        runnable, _pending = _pending_units(us, done)
        candidates = (k for k in (unit_key_for(us.mid, u) for u in runnable) if k not in taken)
        key = _claim(base, candidates)
        if key is None:
            break
        u0 = time.monotonic()
        try:
            unit = parse_unit_key_for(us.mid, key)
            result, nread, nwritten = _process_any(plan, us, unit, store, cache)
            bytes_read += nread
            bytes_written += nwritten
            if not dry:
                _store_any(plan, us, unit, store, result)
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


def bench(dataset_id, n=4, mid=None, require_server: bool = False) -> dict:
    """Server executor on N sample units, spread over the units runnable at the start
    of a job (for m004: level 0), results discarded. `mid` defaults to the first
    migration the dataset still needs (m002 otherwise)."""
    plan = _plan_for(dataset_id)
    n = max(1, min(MAX_BENCH_UNITS, _as_int(n, 4)))
    if mid is None:
        fv = format_version(_read_metadata(plan.ds_dir))
        mid = next((m["id"] for m in MIGRATIONS if plan.type in m["types"] and _applicable(plan, fv, m)), M002)
    m = _migration(mid)
    if require_server:
        _require_server(m["id"])
    us = _unitset(plan, m["id"])
    units, _pending = _pending_units(us, set())
    if not units:
        return {"ok": True, "migration": m["id"], "seconds": 0.0, "units": 0, "bytesRead": 0, "bytesWritten": 0}
    picks = sorted({units[(k * len(units)) // n] for k in range(min(n, len(units)))},
                   key=lambda u: units.index(u))
    store = tile_store_dir(plan.type, plan.folder, m["id"])
    t0 = time.monotonic()
    nread = nwritten = 0
    for unit in picks:
        _res, r, w = _process_any(plan, us, unit, store, None)
        nread += r
        nwritten += w
    secs = time.monotonic() - t0
    return {"ok": True, "migration": m["id"], "seconds": round(secs, 3), "units": len(picks),
            "bytesRead": nread, "bytesWritten": nwritten, "secondsPerUnit": round(secs / len(picks), 4),
            "sample": [unit_key_for(m["id"], u) for u in picks]}


# The executors' speed test of the Data updates tab. A *block* is what a unit does for each
# brick it reads: decode the 512² lossless-WebP mosaic of one 64³ brick and encode its voxels
# as one 512² png-gray8 tile. The input is a fixed synthetic brick shipped with the platform
# (blobs over shot noise, like a confocal stack); the browser downloads the same file, so a
# score depends neither on the published datasets nor on their state.
SPEEDTEST_SAMPLE = ("js", "migrations", "speedtest-brick.webp")
SPEEDTEST_MAX_SECONDS = 3.0
SPEEDTEST_PUT_MAX = 4 * 1024 * 1024


def speedtest(max_seconds=1.0) -> dict:
    """Blocks run back to back until the next one would end past `max_seconds` (≤ 3 s, at
    least one block). Nothing is written. Needs what m002 needs (WebP decode + zlib)."""
    _require_server(M002)
    try:
        budget = float(max_seconds)
    except (TypeError, ValueError):
        budget = 1.0
    budget = max(0.05, min(SPEEDTEST_MAX_SECONDS, budget))
    try:
        raw = ROOT.joinpath(*SPEEDTEST_SAMPLE).read_bytes()
    except OSError as exc:
        raise MigrationError("speedtest_sample_missing", 500, str(exc))
    packing = {"mode": "grid", "cols": BRICKS_PER_TILE}
    blocks = written = 0
    slowest = 0.0
    t0 = time.monotonic()
    while True:
        b0 = time.monotonic()
        voxels = decode_brick(raw, "webp-lossless", packing)
        written += len(png_gray8(TILE_SIZE, TILE_SIZE, voxels))
        blocks += 1
        now = time.monotonic()
        slowest = max(slowest, now - b0)
        if now - t0 + slowest > budget:
            break
    return {"ok": True, "blocks": blocks, "seconds": round(time.monotonic() - t0, 4),
            "bytesRead": blocks * len(raw), "bytesWritten": written}


def speedtest_put(raw: bytes | None) -> dict:
    """The browser's side of the speed test uploads each converted block here, like a
    unit_put: the bytes cross the link and are dropped."""
    n = len(raw or b"")
    if n > SPEEDTEST_PUT_MAX:
        raise MigrationError("body_too_large", 413)
    return {"ok": True, "bytes": n}


def _structure_valid(plan: Plan, mid: str) -> bool:
    if mid == M002:
        return dataset_planes_valid(plan)
    if mid == M003:
        return dataset_mips_valid(plan)
    if mid == M004:
        return dataset_bricks_v3_valid(plan)
    return False



def _swapped_only_summary(j: dict) -> dict:
    out = _summary(j)
    out.update({"pending": 0, "runnable": 0, "offset": 0, "units": []})
    return out



def _levels_progress(us: UnitSet, done) -> list:
    rows = []
    for L in us.levels or []:
        k = L["level"]
        units = [u for u in us.units if u[1] == k]
        X, Y, Z = L["dimensions"]
        vx, vy, vz = L["voxelSize"]
        gx, gy, gz = L["gridSize"]
        rows.append({"level": k, "dimensions": {"x": X, "y": Y, "z": Z},
                     "voxelSize": {"x": vx, "y": vy, "z": vz}, "gridSize": {"x": gx, "y": gy, "z": gz},
                     "halveZ": L["halveZ"], "units": len(units),
                     "done": sum(1 for u in units if unit_key_for(M004, u) in done)})
    return rows



def _m003_unit_geometry(plan: Plan, unit):
    t, layer, c, ty, tx = unit
    tree = plan.trees.get(t)
    if (tree is None or layer >= -(-tree.dims[2] // LAYER_DEPTH) or c >= tree.channels
            or ty >= tree.tiles_y or tx >= tree.tiles_x):
        raise MigrationError("bad_unit")
    X, Y, _Z = tree.dims
    return tree, min(TILE_SIZE, X - tx * TILE_SIZE), min(TILE_SIZE, Y - ty * TILE_SIZE)



def _m004_check_unit(us: UnitSet, plan: Plan, unit) -> None:
    t, k, c, BZ, BY, BX = unit
    tree = plan.trees.get(t)
    if tree is None or k >= len(us.levels) or c >= tree.channels:
        raise MigrationError("bad_unit")
    gx, gy, gz = us.levels[k]["gridSize"]
    if BZ >= -(-gz // V3_SUPER) or BY >= -(-gy // V3_SUPER) or BX >= -(-gx // V3_SUPER):
        raise MigrationError("bad_unit")



def _write_mip_tile(store: Path, unit, png) -> None:
    p = mip_tile_path(store, unit)
    with _thread_lock("unit:%s:%s" % (store, unit_key_for(M003, unit))):
        if png:
            _atomic_write(p, png)
        else:
            try:
                p.unlink()
            except FileNotFoundError:
                pass



def _write_unit_m004(us: UnitSet, store: Path, unit, bricks: dict, part=None) -> None:
    """Replace a unit's bricks in the store: the given ones are written, every other
    brick of its super-block (or octant `part`) is removed (an absent brick has no file)."""
    t, k, c = unit[0], unit[1], unit[2]
    with _thread_lock("unit:%s:%s" % (store, unit_key_for(M004, unit))):
        for b in _m004_unit_bricks(us, unit, part):
            p = _v3_store_brick(store, t, k, c, *b)
            data = bricks.get(b)
            if data:
                _atomic_write(p, data)
            else:
                try:
                    p.unlink()
                except FileNotFoundError:
                    pass



def parse_v3_unit_blob(body: bytes):
    """[(bz, by, bx, webp)] of an m004 unit blob: u32 count, then count ×
    {u32 bz, u32 by, u32 bx, u32 length, length bytes of lossless WebP} (little-endian;
    level-k brick coordinates). MigrationError bad_blob when malformed."""
    if len(body) < 4:
        raise MigrationError("bad_blob")
    count = struct.unpack_from("<I", body, 0)[0]
    if count > V3_SUPER ** 3:
        raise MigrationError("bad_blob", 400, "too many bricks")
    pos, out = 4, []
    for _ in range(count):
        if pos + 16 > len(body):
            raise MigrationError("bad_blob", 400, "truncated entry")
        bz, by, bx, length = struct.unpack_from("<IIII", body, pos)
        pos += 16
        if pos + length > len(body):
            raise MigrationError("bad_blob", 400, "truncated brick")
        out.append((bz, by, bx, body[pos:pos + length]))
        pos += length
    if pos != len(body):
        raise MigrationError("bad_blob", 400, "trailing bytes")
    return out



def build_v3_unit_blob(bricks: dict) -> bytes:
    """The m004 unit blob of {(bz, by, bx): webp} (the browser's layout; tests, tools)."""
    parts = [struct.pack("<I", len(bricks))]
    for (bz, by, bx) in sorted(bricks):
        data = bricks[(bz, by, bx)]
        parts.append(struct.pack("<IIII", bz, by, bx, len(data)))
        parts.append(data)
    return b"".join(parts)



def validate_v3_brick(data: bytes) -> bool:
    """Check one uploaded v3 brick image: lossless WebP 594×528 (RIFF/VP8L header); with
    Pillow also decoded: opaque, unused mosaic slots zero. True when its 64³ interior
    holds a non-zero voxel (it is stored), False when the interior is zero (ESS: not
    stored). ValueError when invalid. Losslessness of the encoding is the producer's
    responsibility (the browser probes its encoder by a decode round trip)."""
    w, h = webp_lossless_size(data)
    if (w, h) != (V3_MOSAIC_W, V3_MOSAIC_H):
        raise ValueError("brick image is %dx%d, expected %dx%d" % (w, h, V3_MOSAIC_W, V3_MOSAIC_H))
    if _PILImage is None or _np is None:
        return True
    return brick_interior_nonzero(decode_brick_v3(data, strict=True))



def _m004_level_ready(us: UnitSet, done, unit) -> bool:
    t, k, c = unit[0], unit[1], unit[2]
    for u in us.units:
        if u[0] == t and u[2] == c and u[1] < k and unit_key_for(M004, u) not in done:
            return False
    return True



def _process_any(plan: Plan, us: UnitSet, unit, store: Path, cache):
    """One unit by the server executor: (result, bytes_read, bytes_written)."""
    if us.mid == M002:
        tiles, nread = process_unit(plan, unit)
        return tiles, nread, sum(len(p) for p in tiles.values())
    if us.mid == M003:
        png, nread = process_unit_m003(plan, us, unit)
        return png, nread, len(png) if png else 0
    bricks, nread = process_unit_m004(plan, us, unit, store, cache)
    return bricks, nread, sum(len(p) for p in bricks.values())



def _store_any(plan: Plan, us: UnitSet, unit, store: Path, result) -> None:
    if us.mid == M002:
        _write_unit_tiles(plan, M002, unit, result)
    elif us.mid == M003:
        _write_mip_tile(store, unit, result)
    else:
        _write_unit_m004(us, store, unit, result)



def unit_inputs(dataset_id, mid, key) -> dict:
    """What a browser executor reads for one unit. m003: the plane tiles (pack name
    relative to the tree's planes directory, offset, length). m004 level 0: the v2 LOD0
    bricks of the unit's range (pack url relative to the tree's bricks directory); level
    k ≥ 1: the level k−1 bricks of the tile store (fetched with `store_get`), with the
    voxel ranges the reduction works on. m002: the unit's v2 bricks."""
    m, plan, _path = _open_job(dataset_id, mid)
    mid = m["id"]
    unit = parse_unit_key_for(mid, key)
    us = _unitset(plan, mid)
    out = {"ok": True, "migration": mid, "unit": unit_key_for(mid, unit), "empty": unit not in us.unit_bytes}
    if mid == M003:
        tree, w, h = _m003_unit_geometry(plan, unit)
        out.update({"tree": tree.rel, "width": w, "height": h,
                    "tiles": [{"z": z, "pack": pack_name(z), "offset": off, "length": ln}
                              for z, off, ln in us.refs.get(unit) or []]})
        return out
    if mid == M002:
        tree, w, h, z0, depth = _unit_geometry(plan, unit)
        t, bz, c, ty, tx = unit
        rows = []
        for (cc, bx, by, bzz), (p, off, ln) in sorted(tree.index.items()):
            if cc == c and bzz == bz and bx // BRICKS_PER_TILE == tx and by // BRICKS_PER_TILE == ty:
                rows.append({"x": bx, "y": by, "z": bz, "url": p.relative_to(tree.bricks_dir).as_posix(),
                             "offset": off, "length": ln})
        out.update({"tree": tree.rel, "bricks": rows})
        return out
    _m004_check_unit(us, plan, unit)
    t, k, c = unit[0], unit[1], unit[2]
    tree = plan.trees[t]
    L = us.levels[k]
    rng = _m004_unit_ranges(us, unit)
    out.update({"tree": tree.rel, "level": k, "halveZ": L["halveZ"],
                "dimensions": dict(zip("xyz", L["dimensions"])),
                "range": {a: list(r) for a, r in zip("xyz", rng)},
                "outputBricks": [{"z": b[0], "y": b[1], "x": b[2]} for b in _m004_unit_bricks(us, unit)]})
    if k == 0:
        rows = []
        for bz, by, bx in _bricks_overlapping(rng, L["gridSize"]):
            ref = tree.index.get((c, bx, by, bz))
            if ref is not None:
                rows.append({"z": bz, "y": by, "x": bx, "url": ref[0].relative_to(tree.bricks_dir).as_posix(),
                             "offset": ref[1], "length": ref[2]})
        out.update({"source": "v2", "bricks": rows})
    else:
        store = tile_store_dir(plan.type, plan.folder, mid)
        src = _m004_source_ranges(us, unit)
        rows = []
        for bz, by, bx in _bricks_overlapping(src, us.levels[k - 1]["gridSize"]):
            p = _v3_store_brick(store, t, k - 1, c, bz, by, bx)
            try:
                size = p.stat().st_size
            except OSError:
                continue
            rows.append({"z": bz, "y": by, "x": bx,
                         "key": unit_key_for(M004, (t, k - 1, c, bz, by, bx)), "length": size})
        out.update({"source": "store", "sourceLevel": k - 1,
                    "sourceRange": {a: list(r) for a, r in zip("xyz", src)}, "bricks": rows,
                    "ready": _m004_level_ready(us, set((_load_journal(_path) or {}).get("done") or []), unit)})
    return out



def store_get(dataset_id, mid, key) -> bytes:
    """One brick of the m004 tile store (a level the browser reduces from): key
    t{t}.k{k}.c{c}.z{bz}.y{by}.x{bx} names the BRICK (not a super-block). MigrationError
    absent (404) when the brick is not stored (its interior is zero)."""
    m = _migration(mid)
    if m["id"] != M004:
        raise MigrationError("not_applicable", 409)
    type_dir, folder, _ds = _resolve_dataset(dataset_id)
    t, k, c, bz, by, bx = parse_unit_key_for(M004, key)
    p = _v3_store_brick(tile_store_dir(type_dir, folder, M004), t, k, c, bz, by, bx)
    try:
        return p.read_bytes()
    except OSError:
        raise MigrationError("absent", 404)



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


def _finalize_m002(dataset_id, mid, max_seconds=None) -> dict:
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
    inc_name, live_name, old_name = _SWAP_DIRS[m["id"]]
    with _JobLock(base):
        path = journal_path(type_dir, folder, m["id"])
        j = None
        try:
            j = _load_journal(path)
        except MigrationError:
            pass
        if j is not None and j.get("state") == "swapped":
            # The new structure is live already: finishing is the only consistent exit.
            raise MigrationError("finalize_in_progress", 409)
        if m["id"] == M004 and not (ds_dir / live_name).exists():
            if (ds_dir / inc_name).is_dir():
                raise MigrationError("finalize_in_progress", 409)
            if (ds_dir / old_name).is_dir():
                _replace_retry(ds_dir / old_name, ds_dir / live_name)
        _rmtree(tile_store_dir(type_dir, folder, m["id"]))
        _rmtree(ds_dir / inc_name)
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    try:
        (MIGRATIONS_DIR / (base + ".lock")).unlink()
    except OSError:
        pass
    return {"ok": True}


def _swap_dirs(ds_dir: Path, mid: str) -> None:
    """Rename the live structure aside, the incoming one in, delete the old one
    (planes/ and mips/). Re-entrant: completes a swap a crash interrupted."""
    inc_name, live_name, old_name = _SWAP_DIRS[mid]
    incoming, live, old = ds_dir / inc_name, ds_dir / live_name, ds_dir / old_name
    if incoming.is_dir():
        if live.exists():
            _rmtree(old)
            _replace_retry(live, old)
        _replace_retry(incoming, live)
    _rmtree(old)



def _assemble_mips_tree(plan: Plan, us: UnitSet, tree: Tree, store: Path, incoming: Path, producer: str,
                        created_at: str, deadline) -> bool:
    """Write the layer packs of one tree into `incoming` (SPEC §12); False when the
    deadline stopped it (packs already written are atomic and kept for the next call)."""
    out_dir = incoming / tree.rel if tree.rel else incoming
    if not plan.ds_dir.is_dir():
        raise MigrationError("no_dataset", 404)
    out_dir.mkdir(parents=True, exist_ok=True)
    X, Y, Z = tree.dims
    present = set(os.listdir(out_dir))
    wrote = False
    for layer in range(-(-Z // LAYER_DEPTH)):
        name = mip_pack_name(layer)
        if name in present:
            continue
        if wrote and deadline is not None and time.monotonic() > deadline:
            return False
        if not out_dir.is_dir():
            raise MigrationError("no_dataset", 404)
        tiles = []
        for c in range(tree.channels):
            for ty in range(tree.tiles_y):
                h = min(TILE_SIZE, Y - ty * TILE_SIZE)
                for tx in range(tree.tiles_x):
                    w = min(TILE_SIZE, X - tx * TILE_SIZE)
                    unit = (tree.t, layer, c, ty, tx)
                    payload = None
                    if unit in us.unit_bytes:
                        p = mip_tile_path(store, unit)
                        try:
                            payload = p.read_bytes()
                        except FileNotFoundError:
                            payload = None
                    if payload:
                        try:
                            ihdr = png_ihdr(payload)
                        except ValueError as exc:
                            raise MigrationError("bad_tile", 500, f"{p.name} l{layer}: {exc}")
                        if ihdr != (w, h, 8, 0, 0, 0, 0):
                            raise MigrationError("bad_tile", 500, f"{p.name} l{layer}: IHDR {ihdr[:2]}")
                    tiles.append(payload)
        _atomic_write(out_dir / name, build_plane_pack(layer, tree.channels, tree.tiles_x, tree.tiles_y, tiles,
                                                       magic=MIPS_PACK_MAGIC), public=True)
        wrote = True
    doc = mips_manifest({"x": X, "y": Y, "z": Z}, tree.channels, plan.sha, producer, created_at)
    _atomic_write(out_dir / "manifest.json", planes_manifest_bytes(doc), public=True)
    return True



def _finalize_m003(dataset_id, mid, max_seconds=None) -> dict:
    """Assemble mips/, validate, swap, bump to 3 — m002's state machine (SPEC §5.2)."""
    m, plan, path = _open_job(dataset_id, mid)
    base = _job_base(plan, mid=m["id"])
    secs = _as_seconds(max_seconds)
    deadline = time.monotonic() + secs if secs is not None else None
    with _JobLock(base):
        j = _load_journal(path)
        if j is None:
            if plan.type in m["types"] and dataset_mips_valid(plan):
                fv = _bump_metadata(plan.ds_dir, m["to"])
                return {"ok": True, "complete": True, "formatVersion": fv}
            raise MigrationError("no_job", 404)
        state = j.get("state")
        if state in ("running", "assembling"):
            _check_source(plan, j, path)
        us = None
        if state == "running":
            us = _unitset(plan, m["id"])
            done = set(j.get("done") or [])
            missing = sum(1 for u in us.units if unit_key_for(M003, u) not in done)
            if missing:
                raise MigrationError("units_pending", 409, f"{missing} unit(s) not done")
            _rmtree(plan.ds_dir / ".mips-incoming")
            j["state"], j["producer"], j["assembledAt"] = "assembling", _producer(j), _utc_iso()
            _save_journal(path, j)
            state = "assembling"
        if state == "assembling":
            us = us or _unitset(plan, m["id"])
            store = tile_store_dir(plan.type, plan.folder, m["id"])
            incoming = plan.ds_dir / ".mips-incoming"
            layers_total = sum(-(-tree.dims[2] // LAYER_DEPTH) for tree in plan.trees.values())
            for t in sorted(plan.trees):
                if not _assemble_mips_tree(plan, us, plan.trees[t], store, incoming,
                                           j.get("producer") or _producer(j),
                                           j.get("assembledAt") or _utc_iso(), deadline):
                    written = sum(len([n for n in os.listdir(incoming / tr.rel if tr.rel else incoming)
                                       if n.endswith(".bin")])
                                  for tr in plan.trees.values()
                                  if (incoming / tr.rel if tr.rel else incoming).is_dir())
                    j["assembly"] = {"layers": layers_total, "written": written}
                    _save_journal(path, j)
                    return {"ok": True, "complete": False, "assembly": j["assembly"]}
            if not dataset_mips_valid(plan, ".mips-incoming"):
                raise MigrationError("assembly_invalid", 500)
            _check_source(plan, j, path)
            _swap_dirs(plan.ds_dir, M003)
            j["state"] = "swapped"
            j.pop("assembly", None)
            _save_journal(path, j)
            state = "swapped"
        if state == "swapped":
            _swap_dirs(plan.ds_dir, M003)
            if not dataset_mips_valid(plan):
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



def _bricks_dir_schema(d: Path):
    try:
        doc = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    except Exception:
        return None
    return doc.get("schema") if isinstance(doc, dict) else None



def _swap_bricks(ds_dir: Path) -> None:
    """bricks/ → bricks.v2-old/, .bricks-incoming/ → bricks/ (SPEC §13.6). Re-entrant:
    after a crash between the two renames bricks/ is absent and only the second one
    remains; bricks.v2-old/ is deleted by the caller after the version bump."""
    incoming, live, old = ds_dir / ".bricks-incoming", ds_dir / "bricks", ds_dir / "bricks.v2-old"
    if not incoming.is_dir():
        return
    if live.exists():
        if _bricks_dir_schema(live) == V3_SCHEMA:
            _rmtree(incoming)
            return
        _rmtree(old)   # a stale leftover: the live v2 tree is the one to keep aside
        _replace_retry(live, old)
    _replace_retry(incoming, live)



def _restamp_derived(plan: Plan, old_sha) -> int:
    """Re-stamp planes/ and mips/ manifests made from the v2 bricks (`old_sha`) with the
    v3 manifest's sha256 (SPEC §13.6): their voxels are LOD0, which v3 keeps verbatim.
    A manifest stamped with anything else was already stale and is left so (it is then
    offered for repair). Returns the number of manifests rewritten."""
    n = 0
    for tree in plan.trees.values():
        for root in ("planes", "mips"):
            p = _tree_planes_dir(plan.ds_dir, tree, root) / "manifest.json"
            try:
                doc = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            src = doc.get("source") if isinstance(doc, dict) else None
            if not isinstance(src, dict) or src.get("manifestSha256") == plan.sha:
                continue
            if old_sha is None or src.get("manifestSha256") != old_sha:
                continue
            src["manifestSha256"] = plan.sha
            _atomic_write(p, planes_manifest_bytes(doc), public=True)
            n += 1
    return n



def _v3_layout(us: UnitSet, plan: Plan, store: Path):
    """Pack layout of every (tree, level, channel) from the tile store's file sizes:
    {(t, k, c): (bricks in brick order [(b, path, length)], layout, npacks, write order)}."""
    out = {}
    for t in sorted(plan.trees):
        tree = plan.trees[t]
        for k, L in enumerate(us.levels):
            gx, gy, gz = L["gridSize"]
            for c in range(tree.channels):
                d = store / ("t%d" % t) / ("k%d" % k) / ("c%d" % c)
                sizes = {}
                try:
                    with os.scandir(d) as it:
                        for e in it:
                            if e.name.endswith(".webp") and e.is_file():
                                sizes[e.name] = e.stat().st_size
                except FileNotFoundError:
                    pass
                rows = []
                for bz in range(gz):
                    for by in range(gy):
                        for bx in range(gx):
                            name = "z%d.y%d.x%d.webp" % (bz, by, bx)
                            rows.append(((bz, by, bx), d / name, sizes.get(name, 0)))
                layout, npacks, order = pack_layout([r[2] for r in rows], (gx, gy, gz))
                out[(t, k, c)] = (rows, layout, npacks, order)
    return out



def _assemble_v3(plan: Plan, us: UnitSet, store: Path, incoming: Path, j: dict, deadline):
    """Write the packs, index.bin and manifest.json of the v3 tree(s) into `incoming`
    (SPEC §13.3/§13.4). Packs already written with their expected size are kept, so a
    deadline only pauses it. Returns (complete, packsWritten, packsTotal)."""
    if not plan.ds_dir.is_dir():
        raise MigrationError("no_dataset", 404)
    layouts = _v3_layout(us, plan, store)
    total = sum(v[2] for v in layouts.values())
    written, wrote_now = 0, False
    index_refs, channels = {}, plan.trees[min(plan.trees)].channels
    stored = [0 for _ in us.levels]
    for t in sorted(plan.trees):
        tree = plan.trees[t]
        out_dir = incoming / tree.rel if tree.rel else incoming
        entries = []
        for k in range(len(us.levels)):
            per_c = []
            for c in range(channels):
                rows, layout, npacks, order = layouts[(t, k, c)]
                stored[k] += len(order)
                members = [[] for _ in range(npacks)]
                for i in order:
                    members[layout[i][0]].append((rows[i][1], rows[i][2]))
                for pk in range(npacks):
                    dest = out_dir / v3_pack_rel(k, c, pk)
                    expected = sum(ln for _p, ln in members[pk])
                    try:
                        if dest.stat().st_size == expected:
                            written += 1
                            continue
                    except OSError:
                        pass
                    # At least one pack per call, so any deadline makes progress.
                    if wrote_now and deadline is not None and time.monotonic() > deadline:
                        return False, written, total
                    parts = []
                    for p, ln in members[pk]:
                        data = p.read_bytes()
                        if len(data) != ln:
                            raise MigrationError("bad_tile", 500, f"{p.name}: changed during assembly")
                        try:
                            if webp_lossless_size(data) != (V3_MOSAIC_W, V3_MOSAIC_H):
                                raise ValueError("size")
                        except ValueError as exc:
                            raise MigrationError("bad_tile", 500, f"k{k} c{c} {p.name}: {exc}")
                        parts.append(data)
                    if not plan.ds_dir.is_dir():
                        raise MigrationError("no_dataset", 404)
                    _atomic_write(dest, b"".join(parts), public=True)
                    written += 1
                    wrote_now = True
                per_c.append(layout)
            entries.append(per_c)
        data = index_bin_bytes([L["gridSize"] for L in us.levels], channels, entries)
        out_dir.mkdir(parents=True, exist_ok=True)
        _atomic_write(out_dir / INDEX_NAME, data, public=True)
        index_refs[tree.rel] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    v2 = plan.manifest or {}
    if plan.type == "live" and any(tree.rel for tree in plan.trees.values()):
        rels = [plan.trees[t].rel for t in sorted(plan.trees)]
        index = None
        timepoints = [{"path": rel, "index": {"url": rel + "/" + INDEX_NAME, **index_refs[rel]}}
                      for rel in rels]
        tph = {}
        rows = v2.get("timepoints") if isinstance(v2.get("timepoints"), dict) else {}
        for key, row in rows.items():
            if isinstance(row, dict) and isinstance(row.get("histograms"), list):
                tph[str(row.get("path") or key)] = row["histograms"]
        tph = {rel: tph[rel] for rel in rels if rel in tph}
    else:
        index = {"url": INDEX_NAME, **index_refs[""]}
        timepoints, tph = None, None
    doc = bricks_v3_manifest(us.levels, channels, timepoints, index, v2.get("histograms"), tph,
                             j.get("producer") or _producer(j), j.get("assembledAt") or _utc_iso(),
                             dataset=v2.get("dataset") if isinstance(v2.get("dataset"), str) else None,
                             stored=stored)
    _atomic_write(incoming / "manifest.json", planes_manifest_bytes(doc), public=True)
    return True, written, total



def _finalize_m004(dataset_id, m, max_seconds=None) -> dict:
    """Assemble the v3 tree, validate, swap bricks/, re-stamp planes/ and mips/, bump to
    4, delete bricks.v2-old/ (SPEC §13.6). Re-entrant at every step; `max_seconds`
    pauses the assembly (call again until complete)."""
    type_dir, folder, ds_dir = _resolve_dataset(dataset_id)
    path = journal_path(type_dir, folder, M004)
    base = _job_base(type_dir, folder, M004)
    secs = _as_seconds(max_seconds)
    deadline = time.monotonic() + secs if secs is not None else None
    incoming, live, old = ds_dir / ".bricks-incoming", ds_dir / "bricks", ds_dir / "bricks.v2-old"
    with _JobLock(base):
        j = _load_journal(path)
        if j is None:
            plan = _plan_for(dataset_id)
            if plan.type in m["types"] and dataset_bricks_v3_valid(plan):
                old_sha = _manifest_sha(old / "manifest.json") if (old / "manifest.json").is_file() else None
                _restamp_derived(plan, old_sha)
                fv = _bump_metadata(ds_dir, m["to"])
                _rmtree(old)
                return {"ok": True, "complete": True, "formatVersion": fv}
            raise MigrationError("no_job", 404)
        state = j.get("state")
        if state == "assembling" and incoming.is_dir() and (
                not live.exists() or _bricks_dir_schema(live) == V3_SCHEMA):
            # The swap ran (or half ran) but its journal entry was not written.
            state = "swapped"
        elif state == "assembling" and not incoming.is_dir() and _bricks_dir_schema(live) == V3_SCHEMA:
            state = "swapped"
        plan = None
        if state in ("running", "assembling"):
            plan = _plan_for(dataset_id)
            _check_source(plan, j, path)
        if state == "running":
            us = _unitset(plan, M004)
            done = set(j.get("done") or [])
            missing = sum(1 for u in us.units if unit_key_for(M004, u) not in done)
            if missing:
                raise MigrationError("units_pending", 409, f"{missing} unit(s) not done")
            _rmtree(incoming)
            j["state"], j["producer"], j["assembledAt"] = "assembling", _producer(j), _utc_iso()
            _save_journal(path, j)
            state = "assembling"
        if state == "assembling":
            us = _unitset(plan, M004)
            store = tile_store_dir(type_dir, folder, M004)
            complete, written, total = _assemble_v3(plan, us, store, incoming, j, deadline)
            if not complete:
                j["assembly"] = {"packs": total, "written": written}
                _save_journal(path, j)
                return {"ok": True, "complete": False, "assembly": j["assembly"]}
            try:
                doc = json.loads((incoming / "manifest.json").read_text(encoding="utf-8"))
                _trees, problem = _build_v3_trees(type_dir, incoming, doc)
            except Exception as exc:
                problem = str(exc)
            if problem:
                raise MigrationError("assembly_invalid", 500, problem)
            _check_source(plan, j, path)
            j["oldManifestSha"] = plan.sha
            _swap_bricks(ds_dir)
            j["state"] = "swapped"
            j.pop("assembly", None)
            _save_journal(path, j)
            state = "swapped"
        if state == "swapped":
            _swap_bricks(ds_dir)
            if j.get("state") != "swapped":
                j["state"] = "swapped"
                _save_journal(path, j)
            plan = _plan_for(dataset_id)
            if not dataset_bricks_v3_valid(plan):
                j["state"], j["error"] = "failed", "assembly_invalid"
                _save_journal(path, j)
                raise MigrationError("assembly_invalid", 500, plan.v3_problem)
            old_sha = j.get("oldManifestSha") or (next(iter((j.get("sourceManifests") or {}).values()), None))
            if old_sha is None and (old / "manifest.json").is_file():
                old_sha = _manifest_sha(old / "manifest.json")
            _restamp_derived(plan, old_sha)
            fv = _bump_metadata(ds_dir, m["to"])
            _rmtree(old)
            _rmtree(tile_store_dir(type_dir, folder, M004))
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            return {"ok": True, "complete": True, "formatVersion": fv}
        raise MigrationError("job_failed", 409, str(j.get("error") or state))



def finalize(dataset_id, mid, max_seconds=None) -> dict:
    """Assemble, validate, swap, bump (SPEC §5.2, §12, §13.6). Re-entrant at every step:
    a crash or a deadline (`max_seconds`, optional) leaves a state the next call
    completes; call again until `complete` is true."""
    m = _migration(mid)
    if m["id"] == M003:
        return _finalize_m003(dataset_id, mid, max_seconds)
    if m["id"] == M004:
        return _finalize_m004(dataset_id, m, max_seconds)
    return _finalize_m002(dataset_id, mid, max_seconds)



# ── Capability probe and status ────────────────────────────────────────────────

# 4×3 lossless WebP, R=G=B = the values below (encoded by Pillow/libwebp).
_PROBE_WEBP = base64.b64decode(
    "UklGRlQAAABXRUJQVlA4TEcAAAAvA4AAAF9gKpLN6NscfNFBBqYi2Yy+zcEXHWRgKpLN6NscfNFBBvMfSQLAzKgqu6u7"
    "wf+7OwCCABKFaCKZZJpZJo3of9A9AgA=")
_PROBE_PIXELS = bytes([0, 1, 2, 127, 128, 200, 254, 255, 37, 64, 99, 3])
_CAPS = None


def server_capabilities(force: bool = False) -> dict:
    """The server executor's capability. Top-level `available`/`reasons` are m002's
    (the 1.58.0 contract); `migrations[id] = {available, reasons}` is per migration:
    m002 WebP decode + zlib, m003 zlib only (PNG in and out), m004 numpy + WebP decode +
    lossless WebP encode (probed by an exact round trip)."""
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
    lossless = _probe_v3_encode()
    m004 = []
    if _np is None:
        m004.append("no_numpy")
    if not webp:
        m004.append("no_webp_decode")
    if not lossless:
        m004.append("no_webp_lossless_encode")
    if not png:
        m004.append("no_zlib")
    _CAPS = {
        "available": not reasons, "reasons": reasons, "webpDecode": webp, "pngEncode": png,
        "webpLosslessEncode": lossless,
        "limits": {"maxExecutionTime": 0, "memoryLimitBytes": None, "resettable": True},
        "backend": "python", "vectorized": _np is not None,
        "maxRunSeconds": MAX_RUN_SECONDS, "maxUnitBody": MAX_UNIT_BODY,
        "migrations": {
            M002: {"available": not reasons, "reasons": list(reasons)},
            M003: {"available": png, "reasons": [] if png else ["no_zlib"]},
            M004: {"available": not m004, "reasons": m004},
        },
    }
    if _PILImage is None:
        _CAPS["detail"] = "Pillow is not installed"
    return _CAPS


def registry() -> list:
    return [dict(m) for m in MIGRATIONS]


def dataset_status(type_dir: str, folder: str, ds_dir: Path) -> dict:
    """One dataset row of `status`: version, pending migrations (in order; a missing or
    invalid structure that the version claims is a pending `repair`), the jobs, and an
    estimate summed over the pending migrations (`estimate.migrations[id]` each; m003
    before planes/ exists is an upper bound, `exact: false`)."""
    meta = _read_metadata(ds_dir)
    fv = format_version(meta)
    row = {"id": f"{type_dir}/{folder}", "type": type_dir, "folder": folder,
           "name": meta.get("name") or folder, "formatVersion": fv, "pending": [],
           "repair": False, "trees": 0, "job": None, "jobs": [], "estimate": {"units": 0, "bytes": 0}}
    if type_dir not in VOLUME_TYPES:
        return row
    try:
        plan = _plan_for(row["id"])
    except MigrationError as exc:
        row["problem"] = exc.code
        if exc.detail:
            row["problemDetail"] = exc.detail[:300]
        for m in MIGRATIONS:
            try:
                j = _load_journal(journal_path(type_dir, folder, m["id"]))
            except MigrationError:
                j = None
            if j is not None:
                row["jobs"].append(_summary(j))
        row["job"] = row["jobs"][0] if row["jobs"] else None
        return row
    row["trees"] = len(plan.trees)
    row["bricksSchema"] = V3_SCHEMA if plan.v3 else "iribhm-bricks-v2"
    if plan.v3 and plan.v3_problem:
        row["problem"] = "bricks_v3_invalid"
        row["problemDetail"] = plan.v3_problem[:300]
    est = {"units": 0, "bytes": 0, "unitsTotal": 0, "bytesTotal": 0, "migrations": {}}
    for m in MIGRATIONS:
        if plan.type not in m["types"]:
            continue
        try:
            j = _load_journal(journal_path(type_dir, folder, m["id"]))
        except MigrationError:
            j = {"migration": m["id"], "state": "failed", "error": "journal_corrupt"}
        repair = _repair_needed(plan, fv, m)
        pending = m["from"] >= fv or repair
        if m["id"] == M004 and plan.v3 and fv >= m["to"]:
            pending = False
        if pending:
            row["pending"].append(m["id"])
            row["repair"] = row["repair"] or repair
        if j is not None:
            us = None
            if j.get("state") in ("running", "assembling"):
                try:
                    us = _unitset(plan, m["id"])
                except MigrationError:
                    us = None
            row["jobs"].append(_summary(j, us))
        if pending:
            e = _estimate_for(plan, m, j)
            est["migrations"][m["id"]] = e
            for key in ("units", "bytes", "unitsTotal", "bytesTotal"):
                est[key] += int(e.get(key) or 0)
    if row["jobs"]:
        row["job"] = row["jobs"][0]
    if row["pending"]:
        row["estimate"] = est
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


def _probe_v3_encode() -> bool:
    """m004's server probe: encode a 66³ brick holding every byte value through the real
    encoder, check the file is lossless VP8L of 594×528, decode it back and compare
    every voxel."""
    if _PILImage is None or _np is None:
        return False
    try:
        i = _np.arange(V3_SLICE ** 3, dtype=_np.uint32)
        brick = ((i * 2654435761) >> 13).astype(_np.uint8).reshape(V3_SLICE, V3_SLICE, V3_SLICE)
        brick[:8] = 0
        data = encode_brick_v3(brick)
        if webp_lossless_size(data) != (V3_MOSAIC_W, V3_MOSAIC_H):
            return False
        return bool(_np.array_equal(decode_brick_v3(data, strict=True), brick))
    except Exception:
        return False



def _require_server(mid) -> None:
    caps = server_capabilities()
    mc = caps["migrations"].get(str(mid or M002))
    if mc is None:
        raise MigrationError("unknown_migration")
    if not mc["available"]:
        raise MigrationError("server_unavailable", 409, ",".join(mc["reasons"]))



def _estimate_for(plan: Plan, m: dict, j) -> dict:
    try:
        us = _unitset(plan, m["id"])
    except MigrationError as exc:
        if m["id"] == M003 and exc.code == "planes_missing":
            return _m003_estimate(plan)
        return {"units": 0, "bytes": 0, "unitsTotal": 0, "bytesTotal": 0, "exact": False, "error": exc.code}
    done = set((j or {}).get("done") or [])
    rest = [u for u in us.units if unit_key_for(m["id"], u) not in done]
    return {"units": len(rest), "bytes": sum(us.unit_bytes[u] for u in rest),
            "unitsTotal": len(us.units), "bytesTotal": sum(us.unit_bytes.values()), "exact": True}



# ── HTTP dispatch (the dev server only routes here) ────────────────────────────

WRITE_ACTIONS = ("plan", "unit_put", "unit_run", "finalize", "cancel", "bench", "unit_inputs",
                 "speedtest", "speedtest_put")
# Binary answers (application/octet-stream) — routed to handle_binary(), not handle().
BINARY_ACTIONS = ("store_get",)


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
            _migration(body.get("migration"))
            _require_server(body.get("migration"))
            return 200, unit_run(body.get("dataset"), body.get("migration"),
                                 body.get("maxSeconds", MAX_RUN_SECONDS), dry=bool(body.get("dry")))
        if action == "finalize":
            return 200, finalize(body.get("dataset"), body.get("migration"), body.get("maxSeconds"))
        if action == "cancel":
            return 200, cancel(body.get("dataset"), body.get("migration"))
        if action == "bench":
            return 200, bench(body.get("dataset"), body.get("units", 4), body.get("migration"),
                              require_server=True)
        if action == "unit_inputs":
            return 200, unit_inputs(body.get("dataset"), body.get("migration"), body.get("unit"))
        if action == "speedtest":
            return 200, speedtest(body.get("maxSeconds", 1.0))
        if action == "speedtest_put":
            return 200, speedtest_put(raw)
        return 400, {"error": "unknown_action"}
    except MigrationError as exc:
        payload = {"error": exc.code, **exc.extra}
        if exc.detail and exc.detail != exc.code:
            payload["detail"] = exc.detail[:500]
        return exc.status, payload


def handle_binary(action: str, params: dict) -> tuple[int, str, bytes]:
    """A binary API call → (HTTP status, Content-Type, body). `store_get` (query dataset,
    migration=m004-bricks-v3, brick=t.k.c.z.y.x): one stored v3 brick of the tile store,
    which a browser executor reduces into the next level. Same authentication as
    handle() (admin session; the caller's job); errors are JSON."""
    try:
        if action == "store_get":
            data = store_get(params.get("dataset"), params.get("migration"), params.get("brick"))
            return 200, "application/octet-stream", data
        return 400, "application/json", b'{"error":"unknown_action"}'
    except MigrationError as exc:
        payload = {"error": exc.code, **exc.extra}
        if exc.detail and exc.detail != exc.code:
            payload["detail"] = exc.detail[:500]
        return exc.status, "application/json", json.dumps(payload).encode("utf-8")
