"""Format 5 of a volume dataset — the resolution × compression matrix (SPEC Part III, §14).

Normative contract: DOCS/dataset-migrations/SPEC.md §14. One module, used by both producers:
the preprocessing pipeline (preprocess/3-chunk_packer.py, `--format 5`, through
`write_tree`) and the migration m005-matrix (dataset_migrations.py, unit by unit). Both
call the same functions, so they write the same bytes. It needs numpy and Pillow (WebP)
and nothing of the web platform: the pipeline pack ships a copy of this file.

A brick tree (`bricks/` of a '3d' dataset, `bricks/tNNN/` of a 'live' one) holds:

  levels   level 0 = the native voxels; then one level per power of two 256·2^j below the
           native XY size, long XY axis = the target, Z never reduced (`level_ladder`),
           each level the exact integer area average of level 0 (`resample_plane`).
  bricks   per level, column and channel: 64³ bricks stored as 66³ (1-voxel clamp-to-edge
           border), stored iff the 64³ interior holds a voxel >= 1, encoded per column
           (`COLUMNS`, `encode_brick`), packed by 4×4×4 super-block
           (`l{k}/{col}/c{c}/pNNNNN.bin`), indexed per column (`index/{col}.bin`, LBIX).
  xy       per level k >= 1, one LPLN pack of 512² png-gray8 tiles per plane
           (`xy/l{k}/zNNNNN.bin`); level 0 is `planes/` beside bricks/ (format 2).
  xz, yz   per level and channel, one pack per 64 consecutive rows y (xz) or columns x
           (yz): `xz/l{k}/c{c}/bNNNNN.bin` (`orth_pack`), tiles of ≤ 512 along the row ×
           ≤ 512 along z.
  cuts     per level and channel, small bricks of 32 × 32 × bz voxels (bz from the voxel
           anisotropy, `cut_depth`), grouped by super-blocks of 8 × 8 × 8 into records
           (`cut_record`) packed in `cuts/l{k}/c{c}/pNNNNN.bin`, indexed by super-block in
           `cuts/l{k}/index.bin` (LBIX, one level, the super-block grid).
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import struct
import time
import zlib

import numpy as np

SCHEMA = "iribhm-bricks-v5"
MANIFEST_VERSION = 5
FORMAT_VERSION = 5
BRICK = 64
APRON = 1
SLICE = BRICK + 2 * APRON                     # 66
COLS, ROWS = 9, 8                             # 72 slots for 66 slices
MOSAIC66_W, MOSAIC66_H = COLS * SLICE, ROWS * SLICE     # 594 × 528
PITCH = 80                                    # grid80: slot pitch of the lossy mosaics
PAD = (PITCH - SLICE) // 2                    # 7 px of edge replication on each side
MOSAIC80_W, MOSAIC80_H = COLS * PITCH, ROWS * PITCH     # 720 × 640
MIN_TARGET = 256
TILE = 512
SUPER = 4                                     # brick super-block side
PACK_MAX_BRICKS = 64
PACK_MAX_BYTES = 16 * 1024 * 1024
WEBP_LL_QUALITY = 75                          # Pillow's lossless effort, as format 4
WEBP_LL_METHOD = 4
WEBP_LOSSY_METHOD = 6
DEAD_ZONE_MAX = 12
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_ZLIB_LEVEL = 6
PLANE_MAGIC = b"LPLN"
PLANE_HEADER = 16
PLANE_ENTRY = 12
ORTH_ROWS = 64                                # rows (xz) / columns (yz) per orthogonal pack
ORTH_MAGIC = {"xz": b"LPXZ", "yz": b"LPYZ"}
ORTH_HEADER = 20
ORTH_ENTRY = 12
CUT_XY = 32
CUT_SUPER = 8
CUT_RECORD_HEAD = CUT_SUPER ** 3 * 8          # 512 × (u32 offset, u32 length)
CUT_PACK_MAX_BYTES = 16 * 1024 * 1024
INDEX_MAGIC = b"LBIX"
INDEX_VERSION = 1
INDEX_HEADER = 12
INDEX_LEVEL = 16
INDEX_ENTRY = np.dtype([("pack", "<u2"), ("offset", "<u4"), ("length", "<u4")])
assert INDEX_ENTRY.itemsize == 10


# ── Columns (SPEC §14.3) ──────────────────────────────────────────────────────

def quantizer(e: int):
    """(index_of, value_of) of the bounded quantizer of half-width e: 0 alone in bin 0;
    bins of 2e+1 consecutive values from 1 ([1, 2e+1], [2e+2, 4e+2], …), the last one cut
    at 255; a bin reconstructed at its centre s + e, or its last value when cut. Every v
    satisfies |value_of[index_of[v]] − v| <= e."""
    e = int(e)
    index_of = np.zeros(256, dtype=np.uint8)
    value_of = np.zeros(256, dtype=np.uint8)
    s, k = 1, 1
    while s <= 255:
        hi = min(255, s + 2 * e)
        index_of[s:hi + 1] = k
        value_of[k] = min(hi, s + e)
        s, k = hi + 1, k + 1
    return index_of, value_of


_QUANT = {2: quantizer(2), 4: quantizer(4)}

COLUMNS = (
    {"id": "ll", "codec": "webp-lossless", "mosaic": "grid66", "maxError": 0},
    {"id": "b2", "codec": "webp-lossless-lut", "mosaic": "grid66", "maxError": 2},
    {"id": "b4", "codec": "webp-lossless-lut", "mosaic": "grid66", "maxError": 4},
    {"id": "q80", "codec": "webp-lossy-dz", "mosaic": "grid80", "quality": 80, "maxError": None},
    {"id": "q50", "codec": "webp-lossy-dz", "mosaic": "grid80", "quality": 50, "maxError": None},
)
COLUMN_IDS = tuple(c["id"] for c in COLUMNS)
_COLUMN = {c["id"]: c for c in COLUMNS}


def column(cid: str) -> dict:
    try:
        return _COLUMN[cid]
    except KeyError:
        raise ValueError(f"unknown column {cid!r}")


def manifest_columns() -> list:
    """The manifest's `columns` rows (a `lut` for the quantized ones)."""
    out = []
    for c in COLUMNS:
        row = dict(c)
        if c["codec"] == "webp-lossless-lut":
            row["lut"] = _QUANT[c["maxError"]][1].tolist()
        out.append(row)
    return out


# ── Levels (SPEC §14.1) ───────────────────────────────────────────────────────

def _usable_voxel(voxel):
    try:
        v = tuple(float(voxel[a]) for a in ("x", "y", "z")) if isinstance(voxel, dict) \
            else tuple(float(a) for a in voxel)
    except (TypeError, ValueError, KeyError):
        return 1.0, 1.0, 1.0
    if len(v) != 3 or not all(math.isfinite(a) and a > 0 for a in v):
        return 1.0, 1.0, 1.0
    return v


def grid_size(dims, edge: int = BRICK) -> tuple:
    x, y, z = (dims["x"], dims["y"], dims["z"]) if isinstance(dims, dict) else dims
    return -(-int(x) // edge), -(-int(y) // edge), -(-int(z) // edge)


def level_ladder(dims, voxel) -> list:
    """[{level, target, dimensions{x,y,z}, voxelSize{x,y,z}, gridSize{x,y,z}}]: level 0 =
    native (target "native"), then the targets T = 256·2^j < N = max(X, Y), largest
    first. The long XY axis of a level is T, the other (2·n·T + N) // (2·N) (n·T/N rounded
    half up, at least 1), Z is never reduced; an XY voxel side is v·n₀/n."""
    X, Y, Z = (int(d) for d in ((dims["x"], dims["y"], dims["z"]) if isinstance(dims, dict) else dims))
    if X < 1 or Y < 1 or Z < 1:
        raise ValueError("level_ladder: empty volume")
    vx, vy, vz = _usable_voxel(voxel)
    N = max(X, Y)
    targets = []
    T = MIN_TARGET
    while T < N:
        targets.append(T)
        T *= 2

    def row(k, target, x, y):
        return {"level": k, "target": target,
                "dimensions": {"x": x, "y": y, "z": Z},
                "voxelSize": {"x": vx * X / x, "y": vy * Y / y, "z": vz},
                "gridSize": dict(zip("xyz", grid_size((x, y, Z))))}

    out = [row(0, "native", X, Y)]
    for T in reversed(targets):
        x = T if X == N else max(1, (2 * X * T + N) // (2 * N))
        y = T if Y == N else max(1, (2 * Y * T + N) // (2 * N))
        out.append(row(len(out), T, x, y))
    return out


def axis_weights(n0: int, n1: int):
    """(idx, w), both (n1, K) int64: the source voxels of each output voxel along an axis
    resampled from n0 to n1 and their overlap lengths on the integer line of length n0·n1
    (source j covers [j·n1, (j+1)·n1), output i covers [i·n0, (i+1)·n0)). Σ w = n0 per
    output voxel; unused slots carry weight 0 (and a valid index)."""
    n0, n1 = int(n0), int(n1)
    i = np.arange(n1, dtype=np.int64)
    lo, hi = i * n0, (i + 1) * n0
    j0 = lo // n1
    j1 = (hi - 1) // n1
    K = int((j1 - j0).max()) + 1
    j = j0[:, None] + np.arange(K, dtype=np.int64)[None, :]
    w = np.minimum((j + 1) * n1, hi[:, None]) - np.maximum(j * n1, lo[:, None])
    w = np.where(j <= j1[:, None], w, 0)
    j = np.minimum(j, n0 - 1)
    return j, w


def resample_plane(plane, out_w: int, out_h: int, band: int = 128) -> np.ndarray:
    """The exact area average of a (H0, W0) uint8 plane on (out_h, out_w): integer sums
    of overlap-weighted voxels, separable (X then Y, no intermediate rounding), divided
    once by D = W0·H0 rounded half up. Output rows are made `band` at a time so the
    64-bit sums stay small."""
    src = np.asarray(plane, dtype=np.uint8)
    H0, W0 = src.shape
    out_w, out_h = int(out_w), int(out_h)
    if (out_w, out_h) == (W0, H0):
        return src.copy()
    ix, wx = axis_weights(W0, out_w)
    iy, wy = axis_weights(H0, out_h)
    D = W0 * H0
    out = np.empty((out_h, out_w), dtype=np.uint8)
    for a in range(0, out_h, band):
        b = min(out_h, a + band)
        r0 = int(iy[a:b].min())
        r1 = int(iy[a:b].max()) + 1
        rows = src[r0:r1].astype(np.int64)
        acc_x = np.zeros((r1 - r0, out_w), dtype=np.int64)
        for k in range(ix.shape[1]):
            acc_x += rows[:, ix[:, k]] * wx[:, k][None, :]
        acc = np.zeros((b - a, out_w), dtype=np.int64)
        for k in range(iy.shape[1]):
            acc += acc_x[iy[a:b, k] - r0] * wy[a:b, k][:, None]
        out[a:b] = ((acc + D // 2) // D).astype(np.uint8)
    return out


# ── Bricks (SPEC §14.2) ───────────────────────────────────────────────────────

def apron_index(b: int, n: int) -> np.ndarray:
    """Level voxel indices of the 66 samples of brick b along an axis of n voxels:
    64·b − 1 … 64·b + 64, clamped to the volume (clamp-to-edge)."""
    return np.clip(np.arange(BRICK * b - APRON, BRICK * b + BRICK + APRON), 0, n - 1)


def brick_with_apron(vol, bx: int, by: int, bz: int, dims=None, origin=(0, 0, 0)) -> np.ndarray:
    """The 66³ uint8 brick (z, y, x) of a level, read from `vol`: the whole level (D, H,
    W), or a region of it starting at `origin` = (x, y, z) when `dims` = the level's
    (X, Y, Z) is given — the region must hold every clamped sample of the brick."""
    if dims is None:
        D, H, W = vol.shape
        X, Y, Z = W, H, D
    else:
        X, Y, Z = dims
    ox, oy, oz = origin
    zi, yi, xi = apron_index(bz, Z) - oz, apron_index(by, Y) - oy, apron_index(bx, X) - ox
    block = np.asarray(vol[zi[0]:zi[-1] + 1, yi[0]:yi[-1] + 1, xi[0]:xi[-1] + 1])
    return block[np.ix_(zi - zi[0], yi - yi[0], xi - xi[0])]


def brick_kept(brick66) -> bool:
    return bool(np.asarray(brick66)[APRON:APRON + BRICK, APRON:APRON + BRICK, APRON:APRON + BRICK].any())


def mosaic66(brick66) -> np.ndarray:
    """(528, 594) uint8: slice s at column s % 9, row s // 9; the 6 last slots zero."""
    b = np.asarray(brick66, dtype=np.uint8)
    if b.shape != (SLICE, SLICE, SLICE):
        raise ValueError(f"mosaic66: expected a {SLICE}³ brick, got {b.shape}")
    slots = np.zeros((ROWS * COLS, SLICE, SLICE), dtype=np.uint8)
    slots[:SLICE] = b
    return np.ascontiguousarray(
        slots.reshape(ROWS, COLS, SLICE, SLICE).transpose(0, 2, 1, 3).reshape(MOSAIC66_H, MOSAIC66_W))


def unmosaic66(img) -> np.ndarray:
    m = np.asarray(img, dtype=np.uint8)
    if m.shape != (MOSAIC66_H, MOSAIC66_W):
        raise ValueError(f"unmosaic66: expected ({MOSAIC66_H}, {MOSAIC66_W}), got {m.shape}")
    return np.ascontiguousarray(
        m.reshape(ROWS, SLICE, COLS, SLICE).transpose(0, 2, 1, 3).reshape(ROWS * COLS, SLICE, SLICE)[:SLICE])


def mosaic80(brick66) -> np.ndarray:
    """(640, 720) uint8: the 9 × 8 slots on an 80-px pitch, each 66² slice centred with
    7 px of edge replication around it (no 16-px macroblock holds two slices and the
    deblocking filter, <= 3 px from a block edge, never reaches a stored voxel)."""
    b = np.asarray(brick66, dtype=np.uint8)
    if b.shape != (SLICE, SLICE, SLICE):
        raise ValueError(f"mosaic80: expected a {SLICE}³ brick, got {b.shape}")
    slots = np.zeros((ROWS * COLS, PITCH, PITCH), dtype=np.uint8)
    slots[:SLICE] = np.pad(b, ((0, 0), (PAD, PAD), (PAD, PAD)), mode="edge")
    return np.ascontiguousarray(
        slots.reshape(ROWS, COLS, PITCH, PITCH).transpose(0, 2, 1, 3).reshape(MOSAIC80_H, MOSAIC80_W))


def unmosaic80(img) -> np.ndarray:
    m = np.asarray(img, dtype=np.uint8)
    if m.shape != (MOSAIC80_H, MOSAIC80_W):
        raise ValueError(f"unmosaic80: expected ({MOSAIC80_H}, {MOSAIC80_W}), got {m.shape}")
    slots = m.reshape(ROWS, PITCH, COLS, PITCH).transpose(0, 2, 1, 3).reshape(ROWS * COLS, PITCH, PITCH)
    return np.ascontiguousarray(slots[:SLICE, PAD:PAD + SLICE, PAD:PAD + SLICE])


def _webp(img, **kw) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(img, dtype=np.uint8), mode="L").save(buf, format="WEBP", **kw)
    return buf.getvalue()


def _unwebp(data: bytes) -> np.ndarray:
    """The first component of a decoded WebP (a greyscale image decodes as R = G = B)."""
    from PIL import Image
    with Image.open(io.BytesIO(data)) as im:
        im.load()
        if im.format != "WEBP":
            raise ValueError("not a WebP image")
        band = im if im.mode == "L" else im.convert("RGB").getchannel(0)
        return np.asarray(band, dtype=np.uint8)


def dead_zone(src66, dec66) -> int:
    """tau in 0..12 minimising the squared error of the 64³ interior once every decoded
    value <= tau is set to 0 (the smallest such tau on a tie)."""
    s = np.asarray(src66)[1:-1, 1:-1, 1:-1].astype(np.int32)
    d = np.asarray(dec66)[1:-1, 1:-1, 1:-1].astype(np.int32)
    hist_d = np.bincount(d.ravel(), minlength=256)
    best, best_sse = 0, None
    base = int(((d - s) ** 2).sum())
    sse = base
    for tau in range(DEAD_ZONE_MAX + 1):
        if tau:
            if hist_d[tau]:
                sel = d == tau
                ss = s[sel]
                # A decoded value tau set to 0: (0 − s)² replaces (tau − s)².
                sse += int((ss * ss).sum() - ((tau - ss) ** 2).sum())
        if best_sse is None or sse < best_sse:
            best, best_sse = tau, sse
    return best


def apply_dead_zone(dec66, tau: int) -> np.ndarray:
    out = np.array(dec66, dtype=np.uint8, copy=True)
    if tau:
        out[out <= tau] = 0
    return out


# Trailer of a lossy-column brick stored in a better, smaller form (SPEC §14.3).
TAG_B4, TAG_LL = 0xFE, 0xFF
_FALLBACK = ((TAG_LL, "ll"), (TAG_B4, "b4"))


def encode_brick(brick66, cid: str, known: dict | None = None) -> bytes:
    """The stored image of one brick channel in column `cid` (SPEC §14.3). The caller
    decides ESS (brick_kept on the source). A lossy column stores the smallest of its WebP
    lossy image + dead-zone byte, the brick's `b4` image + 0xFE and its `ll` image + 0xFF
    (on a tie the more faithful form): on sparse bricks the lossy image of the 720×640
    mosaic can outweigh the lossless one, and a light column must never be heavier than
    a faithful one. `known` = images of this brick already encoded ({column id: bytes})."""
    col = column(cid)
    codec = col["codec"]
    if codec == "webp-lossless":
        return _webp(mosaic66(brick66), lossless=True, quality=WEBP_LL_QUALITY, method=WEBP_LL_METHOD)
    if codec == "webp-lossless-lut":
        idx = _QUANT[col["maxError"]][0][np.asarray(brick66, dtype=np.uint8)]
        return _webp(mosaic66(idx), lossless=True, quality=WEBP_LL_QUALITY, method=WEBP_LL_METHOD)
    data = _webp(mosaic80(brick66), quality=col["quality"], method=WEBP_LOSSY_METHOD)
    tau = dead_zone(brick66, unmosaic80(_unwebp(data)))
    best = data + bytes([tau])
    known = known if known is not None else {}
    for tag, other in _FALLBACK:
        alt = known.get(other)
        if alt is None:
            alt = known[other] = encode_brick(brick66, other)
        if len(alt) + 1 <= len(best):
            best = alt + bytes([tag])
    return best


def decode_brick(data: bytes, cid: str) -> np.ndarray:
    """The 66³ voxels a reader shows for one stored brick of column `cid`."""
    col = column(cid)
    codec = col["codec"]
    if codec == "webp-lossless":
        return unmosaic66(_unwebp(data))
    if codec == "webp-lossless-lut":
        return _QUANT[col["maxError"]][1][unmosaic66(_unwebp(data))]
    if len(data) < 2:
        raise ValueError("lossy brick without its trailer byte")
    tag = data[-1]
    if tag == TAG_LL:
        return decode_brick(data[:-1], "ll")
    if tag == TAG_B4:
        return decode_brick(data[:-1], "b4")
    if tag > DEAD_ZONE_MAX:
        raise ValueError(f"trailer byte {tag}: neither a dead zone nor a fallback tag")
    return apply_dead_zone(unmosaic80(_unwebp(data[:-1])), tag)


def encode_brick_columns(brick66, columns=COLUMN_IDS, known: dict | None = None) -> dict:
    """{column id: stored bytes} of one kept brick. `known`: images already encoded (the
    format-4 `ll` image of a level-0 brick in m005); the faithful columns are made first
    so a lossy column compares itself with them at no extra cost."""
    known = dict(known or {})
    out = {}
    for cid in sorted(columns, key=lambda c: column(c)["codec"] == "webp-lossy-dz"):
        out[cid] = known.get(cid) if cid in known else encode_brick(brick66, cid, known)
        known[cid] = out[cid]
    return {cid: out[cid] for cid in columns}


# ── Packs and indexes (SPEC §13.3/§13.4, reused by §14.4) ─────────────────────

def superblock_order(grid, side: int = SUPER):
    """Flat indices (bz·gy·gx + by·gx + bx) of a grid (gx, gy, gz), one list per
    super-block of side³ cells, super-blocks in (SBZ, SBY, SBX) order and the cells inside
    in (bz, by, bx) order."""
    gx, gy, gz = (int(v) for v in grid)
    out = []
    for sz in range(0, gz, side):
        for sy in range(0, gy, side):
            for sx in range(0, gx, side):
                out.append([(bz * gy + by) * gx + bx
                            for bz in range(sz, min(gz, sz + side))
                            for by in range(sy, min(gy, sy + side))
                            for bx in range(sx, min(gx, sx + side))])
    return out


def pack_layout(lengths, grid, max_bricks: int = PACK_MAX_BRICKS, max_bytes: int = PACK_MAX_BYTES,
                side: int = SUPER) -> tuple:
    """(layout, npacks) of one (level, channel): whole super-blocks per pack — a new pack
    starts before a super-block that would take a non-empty pack past a limit — and a
    super-block over a limit on its own split in cell order. layout[i] = (pack, offset,
    length), (0, 0, 0) when absent."""
    lengths = [int(v) for v in lengths]
    gx, gy, gz = (int(v) for v in grid)
    if gx * gy * gz != len(lengths):
        raise ValueError(f"pack_layout: {len(lengths)} lengths for grid {tuple(grid)}")
    layout = [(0, 0, 0)] * len(lengths)
    pack, count, size, placed = 0, 0, 0, False
    for block in superblock_order(grid, side):
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
            count += 1
            size += ln
            placed = True
    return layout, (pack + 1 if placed else 0)


class PackWriter:
    """Writes packs group by group under the pack_layout rule: a group (one super-block's
    present items, in order) starts a new pack when it would take a non-empty pack past
    `max_items` or `max_bytes`; a group over a limit on its own is split in item order.
    `path_of(pack)` names pack files; nothing is written for an empty (level, channel)."""

    def __init__(self, path_of, max_items: int = PACK_MAX_BRICKS, max_bytes: int = PACK_MAX_BYTES):
        self.path_of, self.max_items, self.max_bytes = path_of, max_items, max_bytes
        self.index, self.fh = -1, None
        self.count = self.offset = self.bytes = 0

    def _open_next(self):
        if self.fh is not None:
            self.fh.close()
        self.index += 1
        path = self.path_of(self.index)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.fh = open(path, "wb")
        self.count = self.offset = 0

    def add_group(self, datas) -> list:
        """(pack, offset, length) of each payload of one group (empty payloads excluded by
        the caller)."""
        if not datas:
            return []
        n, b = len(datas), sum(len(d) for d in datas)
        if self.fh is None or (self.count and (self.count + n > self.max_items
                                               or self.offset + b > self.max_bytes)):
            self._open_next()
        split = n > self.max_items or b > self.max_bytes
        out = []
        for data in datas:
            if split and self.count and (self.count >= self.max_items or self.offset + len(data) > self.max_bytes):
                self._open_next()
            out.append((self.index, self.offset, len(data)))
            self.fh.write(data)
            self.offset += len(data)
            self.count += 1
            self.bytes += len(data)
        return out

    @property
    def pack_count(self) -> int:
        return self.index + 1

    def close(self):
        if self.fh is not None:
            self.fh.close()
            self.fh = None


def index_bin_bytes(levels, channels: int, entries) -> bytes:
    """An LBIX file. levels: [(gx, gy, gz, packCount)]; entries: per level a (channels,
    gx·gy·gz) array of INDEX_ENTRY (or (pack, offset, length) triples) in cell order."""
    if not 1 <= len(levels) <= 0xFFFF or not 1 <= channels <= 0xFFFF:
        raise ValueError("index_bin_bytes: level or channel count out of range")
    parts = [struct.pack("<4sHHHH", INDEX_MAGIC, INDEX_VERSION, len(levels), channels, 0)]
    for gx, gy, gz, packs in levels:
        parts.append(struct.pack("<IIII", gx, gy, gz, packs))
    for (gx, gy, gz, _), rows in zip(levels, entries):
        arr = np.asarray(rows)
        if arr.dtype != INDEX_ENTRY:
            flat = np.asarray(rows, dtype=np.int64).reshape(channels, -1, 3)
            arr = np.zeros(flat.shape[:2], dtype=INDEX_ENTRY)
            arr["pack"], arr["offset"], arr["length"] = flat[..., 0], flat[..., 1], flat[..., 2]
        if arr.shape != (channels, gx * gy * gz):
            raise ValueError(f"index_bin_bytes: entries {arr.shape} for grid {gx}x{gy}x{gz}")
        parts.append(np.ascontiguousarray(arr).tobytes())
    return b"".join(parts)


def parse_index_bin(data: bytes) -> dict:
    """{levels: [(gx, gy, gz, packCount)], channels, entries: [(C, n) INDEX_ENTRY]}."""
    if len(data) < INDEX_HEADER or data[:4] != INDEX_MAGIC:
        raise ValueError("index: bad magic")
    _m, version, n_levels, channels, _r = struct.unpack_from("<4sHHHH", data, 0)
    if version != INDEX_VERSION:
        raise ValueError(f"index: unsupported version {version}")
    pos = INDEX_HEADER
    levels = []
    for _ in range(n_levels):
        if pos + INDEX_LEVEL > len(data):
            raise ValueError("index: truncated")
        levels.append(struct.unpack_from("<IIII", data, pos))
        pos += INDEX_LEVEL
    entries = []
    for gx, gy, gz, _p in levels:
        n = channels * gx * gy * gz
        end = pos + n * INDEX_ENTRY.itemsize
        if end > len(data):
            raise ValueError("index: truncated")
        entries.append(np.frombuffer(data, dtype=INDEX_ENTRY, count=n, offset=pos).reshape(channels, gx * gy * gz))
        pos = end
    if pos != len(data):
        raise ValueError("index: trailing bytes")
    return {"levels": levels, "channels": channels, "entries": entries}


def brick_pack_rel(level: int, cid: str, channel: int, pack: int) -> str:
    return f"l{level}/{cid}/c{channel}/p{pack:05d}.bin"


def index_rel(cid: str) -> str:
    return f"index/{cid}.bin"


# ── XY planes of a level (format 2 layout, SPEC §3) ───────────────────────────

def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def png_gray8(img) -> bytes:
    """The reference png-gray8 tile (SPEC §3.3): filter None on every row, zlib 6, one
    IDAT; byte-identical to dataset_migrations.png_gray8."""
    a = np.ascontiguousarray(img, dtype=np.uint8)
    h, w = a.shape
    filt = np.zeros((h, w + 1), dtype=np.uint8)
    filt[:, 1:] = a
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)
    return (PNG_SIGNATURE + _png_chunk(b"IHDR", ihdr)
            + _png_chunk(b"IDAT", zlib.compress(filt.tobytes(), PNG_ZLIB_LEVEL)) + _png_chunk(b"IEND", b""))


def unpng_gray8(png: bytes) -> np.ndarray:
    """Pixels of a png-gray8 tile written with filter None on every row (what every
    producer of format 2 and 5 writes); ValueError for anything else."""
    if png[:8] != PNG_SIGNATURE or png[12:16] != b"IHDR":
        raise ValueError("not a PNG")
    w, h, depth, ctype, _comp, _filt, inter = struct.unpack_from(">IIBBBBB", png, 16)
    if depth != 8 or ctype != 0 or inter != 0:
        raise ValueError("not an 8-bit greyscale PNG")
    pos, idat = 8, []
    while pos + 12 <= len(png):
        ln = struct.unpack_from(">I", png, pos)[0]
        kind = png[pos + 4:pos + 8]
        if kind == b"IDAT":
            idat.append(png[pos + 8:pos + 8 + ln])
        pos += 12 + ln
        if kind == b"IEND":
            break
    raw = np.frombuffer(zlib.decompress(b"".join(idat)), dtype=np.uint8)
    if raw.size != h * (w + 1):
        raise ValueError("IDAT size")
    raw = raw.reshape(h, w + 1)
    if raw[:, 0].any():
        raise ValueError("a row is filtered (not None)")
    return np.ascontiguousarray(raw[:, 1:])


def plane_tiles(plane) -> list:
    """png-gray8 tiles of a (H, W) plane, row-major (ty, tx); None for an all-zero tile."""
    p = np.asarray(plane, dtype=np.uint8)
    H, W = p.shape
    out = []
    for ty in range(-(-H // TILE)):
        for tx in range(-(-W // TILE)):
            t = p[ty * TILE:(ty + 1) * TILE, tx * TILE:(tx + 1) * TILE]
            out.append(png_gray8(t) if t.any() else None)
    return out


def plane_pack(z: int, channels: int, tiles_x: int, tiles_y: int, tiles, magic: bytes = PLANE_MAGIC) -> bytes:
    """One LPLN pack (SPEC §3.2): tiles in entry order (c, ty, tx); None = all zero."""
    n = channels * tiles_y * tiles_x
    tiles = list(tiles)
    if len(tiles) != n:
        raise ValueError(f"plane_pack: {len(tiles)} tiles, expected {n}")
    head = bytearray(struct.pack("<4sHHHHI", magic, 1, channels, tiles_x, tiles_y, int(z)))
    offset = PLANE_HEADER + PLANE_ENTRY * n
    for t in tiles:
        ln = len(t) if t else 0
        head += struct.pack("<QI", offset if ln else 0, ln)
        offset += ln
    return bytes(head) + b"".join(t for t in tiles if t)


def parse_plane_pack(data: bytes, magic: bytes = PLANE_MAGIC):
    """(z, channels, tiles_x, tiles_y, [(offset, length)])."""
    if len(data) < PLANE_HEADER or data[:4] != magic:
        raise ValueError("not a plane pack")
    _m, ver, c, tx, ty, z = struct.unpack_from("<4sHHHHI", data, 0)
    if ver != 1:
        raise ValueError(f"plane pack version {ver}")
    n = c * tx * ty
    if len(data) < PLANE_HEADER + PLANE_ENTRY * n:
        raise ValueError("truncated plane pack")
    entries = [struct.unpack_from("<QI", data, PLANE_HEADER + PLANE_ENTRY * i) for i in range(n)]
    return z, c, tx, ty, entries


def xy_pack_rel(level: int, z: int) -> str:
    return f"xy/l{level}/z{z:05d}.bin"


# ── XZ / YZ packs (SPEC §14.5) ────────────────────────────────────────────────

def orth_pack_rel(kind: str, level: int, channel: int, block: int) -> str:
    return f"{kind}/l{level}/c{channel}/b{block:05d}.bin"


def orth_header_bytes(count: int, tiles_a: int, tiles_z: int) -> int:
    return ORTH_HEADER + ORTH_ENTRY * count * tiles_a * tiles_z


def orth_pack(kind: str, first: int, images) -> bytes:
    """One pack of `images` — the (Z, A) cuts of consecutive rows `first`, `first + 1`, …
    (xz: image[z, x] = voxel (x, row, z); yz: image[z, y] = voxel (row, y, z)) — tiled in
    ≤ 512 (along A) × ≤ 512 (along z) png-gray8 tiles. Header: magic, u16 version 1,
    u16 tilesA, u16 tilesZ, u16 0, u32 first, u32 count; entries in order (row, tz, ta)
    {u64 offset, u32 length}, length 0 iff the tile is all zero."""
    images = [np.asarray(im, dtype=np.uint8) for im in images]
    if not images:
        raise ValueError("orth_pack: no rows")
    Z, A = images[0].shape
    ta, tz = -(-A // TILE), -(-Z // TILE)
    head = bytearray(struct.pack("<4sHHHHII", ORTH_MAGIC[kind], 1, ta, tz, 0, int(first), len(images)))
    payloads = []
    offset = orth_header_bytes(len(images), ta, tz)
    for im in images:
        if im.shape != (Z, A):
            raise ValueError("orth_pack: rows of different shapes")
        for iz in range(tz):
            for ia in range(ta):
                t = im[iz * TILE:(iz + 1) * TILE, ia * TILE:(ia + 1) * TILE]
                data = png_gray8(t) if t.any() else b""
                head += struct.pack("<QI", offset if data else 0, len(data))
                offset += len(data)
                payloads.append(data)
    return bytes(head) + b"".join(payloads)


def parse_orth_pack(data: bytes, kind: str):
    """(first, count, tiles_a, tiles_z, [(offset, length)]) of an xz / yz pack."""
    if len(data) < ORTH_HEADER or data[:4] != ORTH_MAGIC[kind]:
        raise ValueError(f"not an {kind} pack")
    _m, ver, ta, tz, _r, first, count = struct.unpack_from("<4sHHHHII", data, 0)
    if ver != 1:
        raise ValueError(f"{kind} pack version {ver}")
    hb = orth_header_bytes(count, ta, tz)
    if len(data) < hb:
        raise ValueError(f"truncated {kind} pack")
    n = count * ta * tz
    entries = [struct.unpack_from("<QI", data, ORTH_HEADER + ORTH_ENTRY * i) for i in range(n)]
    for off, ln in entries:
        if ln and (off < hb or off + ln > len(data)):
            raise ValueError(f"{kind} tile outside the pack")
    return first, count, ta, tz, entries


def orth_blocks(n: int) -> int:
    return -(-int(n) // ORTH_ROWS)


# ── Cut bricks (SPEC §14.5) ───────────────────────────────────────────────────

def cut_depth(voxel_size) -> int:
    """bz = 2^round(log2(32·vxy / vz)) clamped to [1, 32], vxy the larger XY side of the
    LEVEL's voxel: a cut brick of 32 × 32 × bz voxels is about a cube in µm."""
    vx, vy, vz = _usable_voxel(voxel_size)
    r = 32.0 * max(vx, vy) / vz
    return int(min(32, max(1, 2 ** round(math.log2(r)))))


def cut_grid(dims, bz: int) -> tuple:
    x, y, z = (dims["x"], dims["y"], dims["z"]) if isinstance(dims, dict) else dims
    return -(-int(x) // CUT_XY), -(-int(y) // CUT_XY), -(-int(z) // int(bz))


def cut_super_grid(dims, bz: int) -> tuple:
    gx, gy, gz = cut_grid(dims, bz)
    return -(-gx // CUT_SUPER), -(-gy // CUT_SUPER), -(-gz // CUT_SUPER)


def cut_mosaic_shape(bz: int) -> tuple:
    """(height, width) of a cut brick's mosaic: its bz slices of 32², min(bz, 8) per row."""
    cols = min(int(bz), 8)
    return CUT_XY * (-(-int(bz) // cols)), CUT_XY * cols


def encode_cut_brick(block) -> bytes:
    """Lossless WebP of a (bz, 32, 32) cut brick (voxels outside the level are 0)."""
    b = np.asarray(block, dtype=np.uint8)
    bz = b.shape[0]
    h, w = cut_mosaic_shape(bz)
    cols = w // CUT_XY
    slots = np.zeros(((h // CUT_XY) * cols, CUT_XY, CUT_XY), dtype=np.uint8)
    slots[:bz] = b
    img = slots.reshape(h // CUT_XY, cols, CUT_XY, CUT_XY).transpose(0, 2, 1, 3).reshape(h, w)
    return _webp(img, lossless=True, quality=WEBP_LL_QUALITY, method=WEBP_LL_METHOD)


def decode_cut_brick(data: bytes, bz: int) -> np.ndarray:
    img = _unwebp(data)
    h, w = cut_mosaic_shape(bz)
    if img.shape != (h, w):
        raise ValueError(f"cut brick {img.shape}, expected {(h, w)}")
    cols = w // CUT_XY
    slots = img.reshape(h // CUT_XY, CUT_XY, cols, CUT_XY).transpose(0, 2, 1, 3).reshape(-1, CUT_XY, CUT_XY)
    return np.ascontiguousarray(slots[:bz])


def cut_record(region, origin, dims, bz: int, sz: int, sy: int, sx: int):
    """The record of cut super-block (sz, sy, sx) of a level, or None when every brick of it
    is zero. `region` holds the level's voxels (z, y, x) from `origin` = (x, y, z) over at
    least the super-block (clipped to the level). Record = 512 × {u32 offset (from the
    record's start), u32 length} in (bz, by, bx) order inside the super-block, then the
    payloads; a brick outside the level or all zero has length 0."""
    X, Y, Z = dims
    ox, oy, oz = origin
    table = []
    payloads = []
    offset = CUT_RECORD_HEAD
    any_kept = False
    for lz in range(CUT_SUPER):
        for ly in range(CUT_SUPER):
            for lx in range(CUT_SUPER):
                bzz, byy, bxx = sz * CUT_SUPER + lz, sy * CUT_SUPER + ly, sx * CUT_SUPER + lx
                z0, y0, x0 = bzz * bz, byy * CUT_XY, bxx * CUT_XY
                data = b""
                if z0 < Z and y0 < Y and x0 < X:
                    z1, y1, x1 = min(Z, z0 + bz), min(Y, y0 + CUT_XY), min(X, x0 + CUT_XY)
                    sub = region[z0 - oz:z1 - oz, y0 - oy:y1 - oy, x0 - ox:x1 - ox]
                    if sub.any():
                        block = np.zeros((bz, CUT_XY, CUT_XY), dtype=np.uint8)
                        block[:z1 - z0, :y1 - y0, :x1 - x0] = sub
                        data = encode_cut_brick(block)
                        any_kept = True
                table.append((offset if data else 0, len(data)))
                offset += len(data)
                payloads.append(data)
    if not any_kept:
        return None
    head = b"".join(struct.pack("<II", o, ln) for o, ln in table)
    return head + b"".join(payloads)


def parse_cut_record(data: bytes):
    """[(offset, length)] × 512 of a cut super-block record."""
    if len(data) < CUT_RECORD_HEAD:
        raise ValueError("truncated cut record")
    out = [struct.unpack_from("<II", data, 8 * i) for i in range(CUT_SUPER ** 3)]
    for off, ln in out:
        if ln and (off < CUT_RECORD_HEAD or off + ln > len(data)):
            raise ValueError("cut brick outside its record")
    return out


def cut_pack_rel(level: int, channel: int, pack: int) -> str:
    return f"cuts/l{level}/c{channel}/p{pack:05d}.bin"


def cut_index_rel(level: int) -> str:
    return f"cuts/l{level}/index.bin"


# ── Manifest (SPEC §14.4) ─────────────────────────────────────────────────────

def stores_doc(levels: list) -> dict:
    return {
        "xy": {"tileSize": TILE, "codec": "png-gray8", "level0": "planes", "packPattern": "xy/l{k}/z{z}.bin"},
        "xz": {"rowsPerPack": ORTH_ROWS, "tileSize": TILE, "codec": "png-gray8",
               "packPattern": "xz/l{k}/c{c}/b{b}.bin"},
        "yz": {"rowsPerPack": ORTH_ROWS, "tileSize": TILE, "codec": "png-gray8",
               "packPattern": "yz/l{k}/c{c}/b{b}.bin"},
        "cuts": {"brickXY": CUT_XY, "superBlock": CUT_SUPER, "codec": "webp-lossless",
                 "packPattern": "cuts/l{k}/c{c}/p{p}.bin",
                 "levels": [{"level": L["level"], "brickZ": cut_depth(L["voxelSize"]),
                             "gridSize": dict(zip("xyz", cut_grid(L["dimensions"], cut_depth(L["voxelSize"])))),
                             "superGrid": dict(zip("xyz", cut_super_grid(L["dimensions"], cut_depth(L["voxelSize"]))))}
                            for L in levels]},
    }


def tree_index_doc(rel: str, column_refs: dict, cut_refs: list) -> dict:
    """{columns: {cid: {url, bytes, sha256}}, cuts: [{url, bytes, sha256} per level]};
    urls relative to bricks/ (a live tree's carry its 'tNNN/' prefix)."""
    pre = f"{rel}/" if rel else ""
    return {"columns": {cid: {"url": pre + index_rel(cid), **column_refs[cid]} for cid in COLUMN_IDS},
            "cuts": [{"url": pre + cut_index_rel(k), **ref} for k, ref in enumerate(cut_refs)]}


def manifest_v5(levels: list, channels: int, trees: dict, histograms, created_at: str,
                histograms_by_tree: dict | None = None, dataset: str | None = None,
                producer: str = "pipeline") -> dict:
    """bricks/manifest.json. trees: {"": tree} ('3d') or {"t000": tree, …} ('live'); a tree =
    {"index": tree_index_doc(...)-like {columns, cuts} WITHOUT url prefix, "bytes": {k:
    {cid: [per channel]}}, "stored": [per level, bricks present over channels in `ll`]}."""
    keys = sorted(trees)
    live = keys != [""]
    doc = {"schema": SCHEMA, "version": MANIFEST_VERSION, "formatVersion": FORMAT_VERSION}
    if dataset:
        doc["dataset"] = dataset
    rows = []
    for k, L in enumerate(levels):
        rows.append({"level": k, "target": L["target"], "dimensions": dict(L["dimensions"]),
                     "voxelSize": dict(L["voxelSize"]), "gridSize": dict(L["gridSize"]),
                     "brickCount": int(sum(trees[t]["stored"][k] for t in keys))})
    doc.update({"channels": int(channels), "brickSize": BRICK, "apron": APRON,
                "levels": rows, "columns": manifest_columns(), "stores": stores_doc(levels)})

    def index_with_urls(rel, tree):
        idx = tree["index"]
        return tree_index_doc(rel, idx["columns"], idx["cuts"])

    if live:
        doc["index"] = None
        doc["timepoints"] = [{"path": k, "index": index_with_urls(k, trees[k]), "bytes": trees[k]["bytes"]}
                             for k in keys]
        worst = {}
        for k in keys:
            for lv, per_col in trees[k]["bytes"].items():
                for cid, per_c in per_col.items():
                    cur = worst.setdefault(lv, {}).setdefault(cid, [0] * len(per_c))
                    worst[lv][cid] = [max(a, b) for a, b in zip(cur, per_c)]
        doc["bytes"] = worst
    else:
        doc["index"] = index_with_urls("", trees[""])
        doc["timepoints"] = None
        doc["bytes"] = trees[""]["bytes"]
    doc["histograms"] = histograms
    if live and histograms_by_tree:
        doc["timepointHistograms"] = {k: histograms_by_tree[k] for k in keys if k in histograms_by_tree}
    doc["producer"] = producer
    doc["createdAt"] = created_at
    return doc


def manifest_bytes(doc: dict) -> bytes:
    return json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def tree_rels(manifest: dict) -> list:
    tps = manifest.get("timepoints")
    if isinstance(tps, list) and tps:
        return [row.get("path") for row in tps if isinstance(row, dict)]
    return [""]


def tree_index_info(manifest: dict, rel: str) -> dict:
    if not rel:
        return manifest.get("index") or {}
    for row in manifest.get("timepoints") or []:
        if isinstance(row, dict) and row.get("path") == rel:
            return row.get("index") or {}
    return {}


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def tree_problem(bricks_dir, manifest: dict, rel: str, plane_count=None) -> str | None:
    """The first structural fault of one tree of a v5 manifest, or None: every column
    index and cut index present with the size and sha256 the manifest records, every pack
    they reference present and long enough, every xy plane pack (levels >= 1) and every
    xz / yz block pack present. `plane_count`: skip the per-plane stat (callers that only
    need the indexes)."""
    base = os.path.join(os.fspath(bricks_dir), rel) if rel else os.fspath(bricks_dir)
    info = tree_index_info(manifest, rel)
    levels = manifest.get("levels") or []
    channels = manifest.get("channels")
    if not isinstance(info, dict) or not levels or not isinstance(channels, int):
        return "manifest: no index"
    prefix = f"{rel}/" if rel else ""
    grids = [tuple(int(L["gridSize"][a]) for a in "xyz") for L in levels]

    def read_ref(ref, rel_expected):
        if not isinstance(ref, dict) or ref.get("url") != prefix + rel_expected:
            raise ValueError(f"{rel_expected}: not in the manifest")
        path = os.path.join(base, *rel_expected.split("/"))
        try:
            with open(path, "rb") as fh:
                blob = fh.read()
        except OSError:
            raise ValueError(f"{rel_expected} missing")
        if len(blob) != ref.get("bytes") or _sha(blob) != ref.get("sha256"):
            raise ValueError(f"{rel_expected} differs from the manifest")
        return parse_index_bin(blob)

    def check_packs(entries, rel_of):
        for c in range(channels):
            e = entries[c]
            present = e[e["length"] > 0]
            if not present.size:
                continue
            ends = {}
            for pk, off, ln in zip(present["pack"].tolist(), present["offset"].tolist(), present["length"].tolist()):
                ends[pk] = max(ends.get(pk, 0), off + ln)
            for pk, end in ends.items():
                p = os.path.join(base, *rel_of(c, pk).split("/"))
                try:
                    if os.path.getsize(p) < end:
                        raise ValueError(f"{rel_of(c, pk)} shorter than its bricks")
                except OSError:
                    raise ValueError(f"{rel_of(c, pk)} missing")

    try:
        cols = info.get("columns") or {}
        for cid in COLUMN_IDS:
            idx = read_ref(cols.get(cid), index_rel(cid))
            if idx["channels"] != channels or [L[:3] for L in idx["levels"]] != grids:
                raise ValueError(f"index/{cid}.bin grids differ from the manifest")
            for k, entries in enumerate(idx["entries"]):
                check_packs(entries, lambda c, pk, k=k, cid=cid: brick_pack_rel(k, cid, c, pk))
        cuts = info.get("cuts") or []
        if len(cuts) != len(levels):
            raise ValueError("cut indexes: one per level expected")
        for k, L in enumerate(levels):
            idx = read_ref(cuts[k], cut_index_rel(k))
            bz = cut_depth(L["voxelSize"])
            if idx["channels"] != channels or [l[:3] for l in idx["levels"]] != [cut_super_grid(L["dimensions"], bz)]:
                raise ValueError(f"{cut_index_rel(k)} grid differs")
            check_packs(idx["entries"][0], lambda c, pk, k=k: cut_pack_rel(k, c, pk))
        if plane_count is None:
            for k, L in enumerate(levels):
                d = L["dimensions"]
                if k:
                    for z in range(d["z"]):
                        if not os.path.isfile(os.path.join(base, *xy_pack_rel(k, z).split("/"))):
                            raise ValueError(f"{xy_pack_rel(k, z)} missing")
                for kind, n in (("xz", d["y"]), ("yz", d["x"])):
                    for c in range(channels):
                        for b in range(orth_blocks(n)):
                            if not os.path.isfile(os.path.join(base, *orth_pack_rel(kind, k, c, b).split("/"))):
                                raise ValueError(f"{orth_pack_rel(kind, k, c, b)} missing")
    except (ValueError, KeyError, TypeError) as exc:
        return f"{rel or 'bricks'}: {exc}"
    return None


def bricks_problem(dataset_dir) -> str | None:
    """None when bricks/manifest.json is a v5 manifest whose every tree is complete."""
    bricks = os.path.join(os.fspath(dataset_dir), "bricks")
    try:
        with open(os.path.join(bricks, "manifest.json"), "rb") as fh:
            manifest = json.loads(fh.read().decode("utf-8"))
    except (OSError, ValueError):
        return "manifest unreadable"
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
        return "not a v5 manifest"
    for rel in tree_rels(manifest):
        p = tree_problem(bricks, manifest, rel)
        if p:
            return p
    return None


def bricks_complete(dataset_dir) -> bool:
    return bricks_problem(dataset_dir) is None


# ── The pipeline's writer: one tree from level-0 volumes ──────────────────────

def atomic_write(path, data: bytes) -> None:
    path = os.fspath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = os.path.join(os.path.dirname(path), f".{os.path.basename(path)}.{os.getpid()}.tmp")
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        for attempt in range(40):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if attempt == 39:
                    raise
                time.sleep(0.1)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def resample_task(args):
    """Worker: planes [z0, z1) of a level file from the level-0 file of one channel."""
    src_path, src_shape, dst_path, dst_shape, z0, z1 = args
    src = np.memmap(src_path, dtype=np.uint8, mode="r", shape=tuple(src_shape))
    dst = np.memmap(dst_path, dtype=np.uint8, mode="r+", shape=tuple(dst_shape))
    try:
        for z in range(z0, z1):
            dst[z] = resample_plane(src[z], dst_shape[2], dst_shape[1])
        dst.flush()
    finally:
        del src, dst
    return z1 - z0


def brick_row_task(args):
    """Worker: the stored bytes of every brick of row (by, bz) of a level file, in every
    column of `columns`: (bz, by, [{cid: bytes} or None per bx])."""
    path, shape, by, bz, columns = args
    vol = np.memmap(path, dtype=np.uint8, mode="r", shape=tuple(shape))
    try:
        D, H, W = shape
        out = []
        for bx in range(-(-W // BRICK)):
            b = brick_with_apron(vol, bx, by, bz)
            out.append(encode_brick_columns(b, columns) if brick_kept(b) else None)
    finally:
        del vol
    return bz, by, out


def xy_plane_task(args):
    """Worker: the xy pack of plane z of a level (every channel)."""
    paths, shape, z, dest = args
    D, H, W = shape
    tiles = []
    for p in paths:
        if p is None:
            tiles.extend([None] * (-(-H // TILE)) * (-(-W // TILE)))
            continue
        vol = np.memmap(p, dtype=np.uint8, mode="r", shape=tuple(shape))
        try:
            tiles.extend(plane_tiles(vol[z]))
        finally:
            del vol
    data = plane_pack(z, len(paths), -(-W // TILE), -(-H // TILE), tiles)
    atomic_write(dest, data)
    return len(data)


def orth_task(args):
    """Worker: one xz / yz pack of a level channel."""
    path, shape, kind, block, dest = args
    D, H, W = shape
    vol = np.memmap(path, dtype=np.uint8, mode="r", shape=tuple(shape))
    try:
        n = H if kind == "xz" else W
        first = block * ORTH_ROWS
        last = min(n, first + ORTH_ROWS)
        if kind == "xz":
            band = np.asarray(vol[:, first:last, :])
            images = [band[:, r, :] for r in range(last - first)]
        else:
            band = np.asarray(vol[:, :, first:last])
            images = [band[:, :, r] for r in range(last - first)]
        data = orth_pack(kind, first, images)
    finally:
        del vol
    atomic_write(dest, data)
    return len(data)


def cut_task(args):
    """Worker: the records of one row (sz, sy) of cut super-blocks of a level channel:
    (sz, sy, [record or None per sx])."""
    path, shape, bz, sz, sy = args
    D, H, W = shape
    vol = np.memmap(path, dtype=np.uint8, mode="r", shape=tuple(shape))
    try:
        z0, y0 = sz * CUT_SUPER * bz, sy * CUT_SUPER * CUT_XY
        z1, y1 = min(D, z0 + CUT_SUPER * bz), min(H, y0 + CUT_SUPER * CUT_XY)
        band = np.asarray(vol[z0:z1, y0:y1, :])
        out = []
        for sx in range(-(-(-(-W // CUT_XY)) // CUT_SUPER)):
            out.append(cut_record(band, (0, y0, z0), (W, H, D), bz, sz, sy, sx))
    finally:
        del vol
    return sz, sy, out


def write_tree(level0_files, dims, voxel, tree_dir, work_dir, run, progress=None) -> dict:
    """Every structure of one format-5 tree from its level-0 volumes.

    level0_files[c]: the (Z, Y, X) uint8 raw file of channel c (None: an empty channel).
    work_dir: where the level files are made (deleted when done). run(fn, tasks): an
    ordered iterator of fn over tasks (a process pool's, or map). progress(step, done,
    total). Returns {"levels", "index": {columns, cuts}, "bytes", "stored"} — the tree's
    part of manifest_v5."""
    levels = level_ladder(dims, voxel)
    channels = len(level0_files)
    os.makedirs(tree_dir, exist_ok=True)
    os.makedirs(work_dir, exist_ok=True)
    X0, Y0, Z0 = levels[0]["dimensions"]["x"], levels[0]["dimensions"]["y"], levels[0]["dimensions"]["z"]
    shape0 = (Z0, Y0, X0)
    files = [list(level0_files)]
    made = []
    try:
        for L in levels[1:]:
            k = L["level"]
            d = L["dimensions"]
            shape = (d["z"], d["y"], d["x"])
            row = []
            for c, src in enumerate(level0_files):
                if src is None:
                    row.append(None)
                    continue
                dst = os.path.join(os.fspath(work_dir), f"l{k}_c{c}.u8")
                np.memmap(dst, dtype=np.uint8, mode="w+", shape=shape).flush()
                made.append(dst)
                step = max(1, -(-shape[0] // 64))
                tasks = [(os.fspath(src), shape0, dst, shape, z, min(shape[0], z + step))
                         for z in range(0, shape[0], step)]
                for _ in run(resample_task, tasks):
                    pass
                row.append(dst)
            files.append(row)
            if progress:
                progress(f"level {k}", k, len(levels) - 1)
        col_entries = {cid: [] for cid in COLUMN_IDS}
        col_packs = {cid: [] for cid in COLUMN_IDS}
        nbytes, stored = {}, []
        for L in levels:
            k = L["level"]
            d = L["dimensions"]
            shape = (d["z"], d["y"], d["x"])
            gx, gy, gz = grid_size(d)
            stored_k = 0
            nbytes[str(k)] = {cid: [0] * channels for cid in COLUMN_IDS}
            per_cid = {cid: np.zeros((channels, gx * gy * gz), dtype=INDEX_ENTRY) for cid in COLUMN_IDS}
            packs_cid = {cid: 0 for cid in COLUMN_IDS}
            for c in range(channels):
                path = files[k][c]
                if path is None:
                    continue
                writers = {cid: PackWriter(lambda pk, cid=cid, c=c: os.path.join(
                    tree_dir, *brick_pack_rel(k, cid, c, pk).split("/"))) for cid in COLUMN_IDS}
                # Rows come back in super-block-row order: only one row of super-blocks
                # (<= 16 brick rows) is held before it is written.
                tasks = [(os.fspath(path), shape, by, bz, COLUMN_IDS)
                         for sz in range(0, gz, SUPER) for sy in range(0, gy, SUPER)
                         for bz in range(sz, min(gz, sz + SUPER))
                         for by in range(sy, min(gy, sy + SUPER))]
                group = {}
                try:
                    for bz, by, row in run(brick_row_task, tasks):
                        group[(bz, by)] = row
                        sz, sy = bz - bz % SUPER, by - by % SUPER
                        if len(group) < (min(gz, sz + SUPER) - sz) * (min(gy, sy + SUPER) - sy):
                            continue
                        for sx in range(0, gx, SUPER):
                            keys = [(z, y, x) for z in range(sz, min(gz, sz + SUPER))
                                    for y in range(sy, min(gy, sy + SUPER))
                                    for x in range(sx, min(gx, sx + SUPER))
                                    if group[(z, y)][x] is not None]
                            stored_k += len(keys)
                            for cid in COLUMN_IDS:
                                datas = [group[(z, y)][x][cid] for z, y, x in keys]
                                for (z, y, x), entry in zip(keys, writers[cid].add_group(datas)):
                                    per_cid[cid][c, (z * gy + y) * gx + x] = entry
                                nbytes[str(k)][cid][c] += sum(len(d) for d in datas)
                        group = {}
                finally:
                    for w in writers.values():
                        w.close()
                for cid in COLUMN_IDS:
                    packs_cid[cid] += writers[cid].pack_count
                if progress:
                    progress(f"bricks level {k} c{c}", c + 1, channels)
            for cid in COLUMN_IDS:
                col_entries[cid].append(per_cid[cid])
                col_packs[cid].append((gx, gy, gz, packs_cid[cid]))
            stored.append(stored_k)
            if k:
                tasks = [([os.fspath(p) if p else None for p in files[k]], shape, z,
                          os.path.join(tree_dir, *xy_pack_rel(k, z).split("/"))) for z in range(shape[0])]
                for _ in run(xy_plane_task, tasks):
                    pass
            for c in range(channels):
                path = files[k][c]
                for kind, n in (("xz", shape[1]), ("yz", shape[2])):
                    if path is None:
                        empty = [np.zeros((shape[0], shape[2] if kind == "xz" else shape[1]), dtype=np.uint8)]
                        for b in range(orth_blocks(n)):
                            first = b * ORTH_ROWS
                            atomic_write(os.path.join(tree_dir, *orth_pack_rel(kind, k, c, b).split("/")),
                                         orth_pack(kind, first, empty * (min(n, first + ORTH_ROWS) - first)))
                        continue
                    tasks = [(os.fspath(path), shape, kind, b,
                              os.path.join(tree_dir, *orth_pack_rel(kind, k, c, b).split("/")))
                             for b in range(orth_blocks(n))]
                    for _ in run(orth_task, tasks):
                        pass
            if progress:
                progress(f"planes level {k}", k + 1, len(levels))
        column_refs = {}
        for cid in COLUMN_IDS:
            blob = index_bin_bytes(col_packs[cid], channels, col_entries[cid])
            atomic_write(os.path.join(tree_dir, *index_rel(cid).split("/")), blob)
            column_refs[cid] = {"bytes": len(blob), "sha256": _sha(blob)}
        cut_refs = []
        for L in levels:
            k = L["level"]
            d = L["dimensions"]
            shape = (d["z"], d["y"], d["x"])
            bz = cut_depth(L["voxelSize"])
            sgx, sgy, sgz = cut_super_grid(d, bz)
            entries = np.zeros((channels, sgx * sgy * sgz), dtype=INDEX_ENTRY)
            npacks_total = 0
            for c in range(channels):
                path = files[k][c]
                if path is None:
                    continue
                writer = PackWriter(lambda pk, c=c: os.path.join(tree_dir, *cut_pack_rel(k, c, pk).split("/")),
                                    max_items=1 << 30, max_bytes=CUT_PACK_MAX_BYTES)
                tasks = [(os.fspath(path), shape, bz, sz, sy) for sz in range(sgz) for sy in range(sgy)]
                try:
                    for sz, sy, row in run(cut_task, tasks):
                        for sx, rec in enumerate(row):
                            if rec:
                                entries[c, (sz * sgy + sy) * sgx + sx] = writer.add_group([rec])[0]
                finally:
                    writer.close()
                npacks_total += writer.pack_count
            blob = index_bin_bytes([(sgx, sgy, sgz, npacks_total)], channels, [entries])
            atomic_write(os.path.join(tree_dir, *cut_index_rel(k).split("/")), blob)
            cut_refs.append({"bytes": len(blob), "sha256": _sha(blob)})
            if progress:
                progress(f"cuts level {k}", k + 1, len(levels))
    finally:
        for p in made:
            try:
                os.unlink(p)
            except OSError:
                pass
    return {"levels": levels, "index": {"columns": column_refs, "cuts": cut_refs},
            "bytes": nbytes, "stored": stored}
