#!/usr/bin/env python3
"""Format 4 of a volume dataset: the brick pyramid v3.

Normative contract: DOCS/dataset-migrations/SPEC.md §13. One brick tree (`bricks/` of a
'3d' dataset, each `bricks/tNNN/` of a 'live' one) holds:

  * levels halved in X, Y and — when that brings the voxel closer to a cube — Z
    (`level_ladder`), each level the integer mean, rounded half up, of 2×2(×2) blocks of
    the previous one (`reduce_level`), level 0 the native voxels verbatim;
  * per level and channel, 64³ bricks stored as 66³ — a 1-voxel border taken from the
    neighbours, clamp-to-edge outside the volume (`brick_with_apron`) — laid out as 66
    slices of 66×66 in a 9 × 8 grid (`mosaic_9x8`, a 594×528 greyscale image), encoded as
    lossless WebP; a brick whose 64³ interior holds no voxel ≥ 1 is not stored;
  * packs `l{k}/c{c}/pNNNNN.bin` (bricks of one level and channel grouped by 4×4×4
    super-block, whole super-blocks per pack, at most 64 bricks or 16 MiB each);
  * `index.bin`, the binary index of every brick slot (`index_bin_bytes`).

The tree's `manifest.json` (`manifest_v3`) is written once every tree of the dataset is
complete. The migration m004-bricks-v3 (dataset_migrations.py and the browser executor)
produces the same tree from a format-3 dataset; this file is a standalone copy of that
arithmetic on purpose — the pipeline pack ships without the web platform — and
tests/test_v3_pipe_parity.py holds the two together.

Needs numpy and Pillow (WebP).
"""
import hashlib
import io
import math
import os
import struct
import time

import numpy as np

SCHEMA = "iribhm-bricks-v3"
MANIFEST_VERSION = 3
FORMAT_VERSION = 4
ENCODING = "webp-lossless"
BRICK = 64
APRON = 1
SLICE = BRICK + 2 * APRON                 # 66
COLS, ROWS = 9, 8                         # 72 slots for 66 slices
MOSAIC_W, MOSAIC_H = COLS * SLICE, ROWS * SLICE     # 594 × 528
PACK_MAX_BRICKS = 64
PACK_MAX_BYTES = 16 * 1024 * 1024
SUPER = 4                                 # super-block side, in bricks
MIN_COARSE_SIDE = 128
# Pillow's lossless effort (quality) and method, the same as dataset_migrations: the two
# producers then write the same bytes, not only the same voxels.
WEBP_QUALITY = 75
WEBP_METHOD = 4
Z_ISOTROPY = 1.5
INDEX_NAME = "index.bin"
INDEX_MAGIC = b"LBIX"
INDEX_VERSION = 1
INDEX_HEADER_BYTES = 12
INDEX_LEVEL_BYTES = 16
INDEX_ENTRY_BYTES = 10
INDEX_ENTRY = np.dtype([("pack", "<u2"), ("offset", "<u4"), ("length", "<u4")])
assert INDEX_ENTRY.itemsize == INDEX_ENTRY_BYTES


# ── Levels ─────────────────────────────────────────────────────────────────────
def _usable_voxel(voxel):
    """(vx, vy, vz) in µm, or (1, 1, 1) when the file declares no calibration — the
    Z-halving rule then treats the voxel as a cube."""
    try:
        v = tuple(float(voxel[a]) for a in ("x", "y", "z")) if isinstance(voxel, dict) \
            else tuple(float(a) for a in voxel)
    except (TypeError, ValueError, KeyError):
        return 1.0, 1.0, 1.0
    if len(v) != 3 or not all(math.isfinite(a) and a > 0 for a in v):
        return 1.0, 1.0, 1.0
    return v


def level_ladder(dims, voxel):
    """The levels of a tree: [{level, dimensions{x,y,z}, voxelSize{x,y,z}, halveZ}].

    Level k+1 halves X and Y (ceil(n/2), both voxel sides doubled) and halves Z iff
    vz_k ≤ 1.5 · vxy_{k+1}, vxy being the larger XY side of level k+1 — the Z step is
    halved only while it is not already coarser than the new XY voxel (OME-Zarr-style
    isotropy). `halveZ` says how level k was made from level k−1 (False for level 0).
    Levels are added while the coarsest level is wider than 128 voxels in X or Y.
    """
    X, Y, Z = (int(d) for d in dims)
    vx, vy, vz = _usable_voxel(voxel)
    out = [{"level": 0, "dimensions": {"x": X, "y": Y, "z": Z},
            "voxelSize": {"x": vx, "y": vy, "z": vz}, "halveZ": False}]
    while max(X, Y) > MIN_COARSE_SIDE:
        vx, vy = 2.0 * vx, 2.0 * vy
        halve_z = vz <= Z_ISOTROPY * max(vx, vy)
        X, Y = (X + 1) // 2, (Y + 1) // 2
        if halve_z:
            Z, vz = (Z + 1) // 2, 2.0 * vz
        out.append({"level": len(out), "dimensions": {"x": X, "y": Y, "z": Z},
                    "voxelSize": {"x": vx, "y": vy, "z": vz}, "halveZ": halve_z})
    return out


def grid_size(dims) -> tuple:
    """(gx, gy, gz) bricks of a level."""
    x, y, z = (dims["x"], dims["y"], dims["z"]) if isinstance(dims, dict) else dims
    return -(-int(x) // BRICK), -(-int(y) // BRICK), -(-int(z) // BRICK)


def _pair_sum(a: np.ndarray, axis: int):
    """Sums of consecutive pairs along `axis` (the last one alone when the length is
    odd) and the count of voxels in each."""
    n = a.shape[axis]
    m = (n + 1) // 2
    idx = [slice(None)] * a.ndim
    idx[axis] = slice(0, None, 2)
    out = a[tuple(idx)].copy()
    idx[axis] = slice(1, None, 2)
    odd = a[tuple(idx)]
    idx[axis] = slice(0, n // 2)
    out[tuple(idx)] += odd
    counts = np.full(m, 2, dtype=np.uint32)
    if n % 2:
        counts[-1] = 1
    return out, counts


def reduce_level(src, halve_z: bool) -> np.ndarray:
    """Level k+1 of a (D, H, W) uint8 block of level k: the mean of each 2×2(×2) block,
    edge blocks averaging only the n voxels that exist, in integers rounded half up:
    (sum + n // 2) // n. A block whose Z extent is a whole number of pairs (or any
    block when Z is kept) reduces to exactly the planes the whole level would give."""
    a = np.asarray(src, dtype=np.uint8).astype(np.uint32)
    if a.ndim != 3 or 0 in a.shape:
        raise ValueError(f"reduce_level: expected a non-empty (D, H, W) block, got {a.shape}")
    if halve_z:
        a, cz = _pair_sum(a, 0)
    else:
        cz = np.ones(a.shape[0], dtype=np.uint32)
    a, cy = _pair_sum(a, 1)
    a, cx = _pair_sum(a, 2)
    n = cz[:, None, None] * cy[None, :, None] * cx[None, None, :]
    return ((a + n // 2) // n).astype(np.uint8)


def reduce_task(args):
    """Worker task: planes [z0, z1) of level k+1 from the level-k file, read two planes
    (or one) per output plane — never a whole level in memory."""
    src_path, src_shape, dst_path, dst_shape, halve_z, z0, z1 = args
    D = src_shape[0]
    src = np.memmap(src_path, dtype=np.uint8, mode="r", shape=tuple(src_shape))
    dst = np.memmap(dst_path, dtype=np.uint8, mode="r+", shape=tuple(dst_shape))
    try:
        for z in range(z0, z1):
            block = src[2 * z:min(D, 2 * z + 2)] if halve_z else src[z:z + 1]
            dst[z] = reduce_level(block, halve_z)[0]
        dst.flush()
    finally:
        del src, dst
    return z1 - z0


# ── Bricks ─────────────────────────────────────────────────────────────────────
def _apron_index(b: int, n: int) -> np.ndarray:
    """Level voxel indices of the 66 samples of brick b along an axis of length n:
    64·b − 1 … 64·b + 64, clamped to the volume (clamp-to-edge)."""
    return np.clip(np.arange(BRICK * b - APRON, BRICK * b + BRICK + APRON), 0, n - 1)


def brick_with_apron(vol, bx: int, by: int, bz: int) -> np.ndarray:
    """The 66³ uint8 brick (z, y, x) of a (D, H, W) level array (or memmap)."""
    D, H, W = vol.shape
    zi, yi, xi = _apron_index(bz, D), _apron_index(by, H), _apron_index(bx, W)
    block = np.asarray(vol[zi[0]:zi[-1] + 1, yi[0]:yi[-1] + 1, xi[0]:xi[-1] + 1])
    return block[np.ix_(zi - zi[0], yi - yi[0], xi - xi[0])]


def brick_row(vol, by: int, bz: int) -> list:
    """Every 66³ brick of the row (by, bz), bx ascending, from one slab read."""
    D, H, W = vol.shape
    zi, yi = _apron_index(bz, D), _apron_index(by, H)
    slab = np.asarray(vol[zi[0]:zi[-1] + 1, yi[0]:yi[-1] + 1, :])
    slab = slab[np.ix_(zi - zi[0], yi - yi[0], np.arange(W))]
    return [slab[:, :, _apron_index(bx, W)] for bx in range(-(-W // BRICK))]


def brick_kept(brick66: np.ndarray) -> bool:
    """Exact empty-space skipping: kept iff the 64³ interior holds a voxel ≥ 1. The
    interior samples past the volume's end replicate voxels of that same interior, so
    this is the test on the brick's real voxels."""
    return bool(brick66[APRON:APRON + BRICK, APRON:APRON + BRICK, APRON:APRON + BRICK].any())


def mosaic_9x8(brick66: np.ndarray) -> np.ndarray:
    """(528, 594) uint8: slice s at column s % 9, row s // 9; the 6 last slots zero."""
    b = np.asarray(brick66, dtype=np.uint8)
    if b.shape != (SLICE, SLICE, SLICE):
        raise ValueError(f"mosaic_9x8: expected a {SLICE}³ brick, got {b.shape}")
    slots = np.zeros((ROWS * COLS, SLICE, SLICE), dtype=np.uint8)
    slots[:SLICE] = b
    return np.ascontiguousarray(
        slots.reshape(ROWS, COLS, SLICE, SLICE).transpose(0, 2, 1, 3).reshape(MOSAIC_H, MOSAIC_W))


def unmosaic_9x8(img: np.ndarray) -> np.ndarray:
    """Inverse of mosaic_9x8: the 66³ brick of a (528, 594) mosaic."""
    m = np.asarray(img, dtype=np.uint8)
    if m.shape != (MOSAIC_H, MOSAIC_W):
        raise ValueError(f"unmosaic_9x8: expected ({MOSAIC_H}, {MOSAIC_W}), got {m.shape}")
    return np.ascontiguousarray(
        m.reshape(ROWS, SLICE, COLS, SLICE).transpose(0, 2, 1, 3).reshape(ROWS * COLS, SLICE, SLICE)[:SLICE])


def encode_brick(brick66: np.ndarray) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray(mosaic_9x8(brick66), mode="L").save(buf, format="WEBP", lossless=True,
                                                        quality=WEBP_QUALITY, method=WEBP_METHOD)
    return buf.getvalue()


def decode_brick(data: bytes) -> np.ndarray:
    """The 66³ brick of one stored image. A greyscale WebP decodes as R = G = B; the
    first component is the voxel."""
    from PIL import Image
    img = Image.open(io.BytesIO(data))
    img.load()
    arr = np.asarray(img)
    if arr.ndim == 3:
        arr = arr[:, :, 0]
    return unmosaic_9x8(arr)


def encode_row_task(args):
    """Worker task: the stored image of each brick of one row (by, bz) of a level file,
    b"" for a brick skipped by ESS. Returns (bz, by, [bytes per bx])."""
    path, shape, by, bz = args
    vol = np.memmap(path, dtype=np.uint8, mode="r", shape=tuple(shape))
    try:
        out = [encode_brick(b) if brick_kept(b) else b"" for b in brick_row(vol, by, bz)]
    finally:
        del vol
    return bz, by, out


# ── Packs and index ────────────────────────────────────────────────────────────
def pack_rel(level: int, channel: int, pack: int) -> str:
    return f"l{level}/c{channel}/p{pack:05d}.bin"


def superblock_order(grid):
    """Flat brick indices (bz·gy·gx + by·gx + bx) of a level grid (gx, gy, gz), one list
    per 4×4×4 super-block, super-blocks in (SBZ, SBY, SBX) order and the bricks inside in
    (bz, by, bx) order (SPEC §13.4)."""
    gx, gy, gz = (int(v) for v in grid)
    s = SUPER
    out = []
    for sz in range(0, gz, s):
        for sy in range(0, gy, s):
            for sx in range(0, gx, s):
                out.append([(bz * gy + by) * gx + bx
                            for bz in range(sz, min(gz, sz + s))
                            for by in range(sy, min(gy, sy + s))
                            for bx in range(sx, min(gx, sx + s))])
    return out


class PackWriter:
    """Writes the bricks of one (level, channel) super-block by super-block (SPEC §13.4):
    a pack holds whole super-blocks — a new pack starts before a super-block that would
    take a non-empty pack past 64 bricks or 16 MiB — and a super-block over a limit on
    its own is split in brick order, a new pack starting before a brick that would take
    a non-empty pack past a limit."""

    def __init__(self, tree_dir, level: int, channel: int):
        self.tree = os.fspath(tree_dir)
        self.level, self.channel = level, channel
        self.index = -1
        self.fh = None
        self.count = self.offset = 0
        self.bytes = 0

    def _open_next(self):
        if self.fh is not None:
            self.fh.close()
        self.index += 1
        path = os.path.join(self.tree, *pack_rel(self.level, self.channel, self.index).split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.fh = open(path, "wb")
        self.count = self.offset = 0

    def add_superblock(self, datas) -> list:
        """The stored images of one super-block's present bricks, in (bz, by, bx) order.
        Returns their (pack, offset, length)."""
        datas = [d for d in datas if d]
        if not datas:
            return []
        n, b = len(datas), sum(len(d) for d in datas)
        if self.fh is None or (self.count and (self.count + n > PACK_MAX_BRICKS
                                               or self.offset + b > PACK_MAX_BYTES)):
            self._open_next()
        split = n > PACK_MAX_BRICKS or b > PACK_MAX_BYTES
        out = []
        for data in datas:
            if split and self.count and (self.count >= PACK_MAX_BRICKS
                                         or self.offset + len(data) > PACK_MAX_BYTES):
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


def pack_layout(lengths, grid=None) -> tuple:
    """(layout, npacks) of one (level, channel) under the PackWriter rule, for producers
    that assemble packs from bricks encoded elsewhere. lengths: stored sizes in
    (bz, by, bx) order (0 = absent); grid: (gx, gy, gz), None = one row along X.
    layout[i] = (pack, offset, length) of brick i, (0, 0, 0) when absent."""
    lengths = [int(v) for v in lengths]
    if grid is None:
        grid = (len(lengths), 1, 1)
    if int(grid[0]) * int(grid[1]) * int(grid[2]) != len(lengths):
        raise ValueError(f"pack_layout: {len(lengths)} lengths for grid {tuple(grid)}")
    layout = [(0, 0, 0)] * len(lengths)
    pack, count, size, placed = 0, 0, 0, False
    for block in superblock_order(grid):
        members = [i for i in block if lengths[i] > 0]
        if not members:
            continue
        n, b = len(members), sum(lengths[i] for i in members)
        if count and (count + n > PACK_MAX_BRICKS or size + b > PACK_MAX_BYTES):
            pack, count, size = pack + 1, 0, 0
        split = n > PACK_MAX_BRICKS or b > PACK_MAX_BYTES
        for i in members:
            ln = lengths[i]
            if split and count and (count >= PACK_MAX_BRICKS or size + ln > PACK_MAX_BYTES):
                pack, count, size = pack + 1, 0, 0
            layout[i] = (pack, size, ln)
            count += 1
            size += ln
            placed = True
    return layout, (pack + 1 if placed else 0)


def level_pack_count(per_channel_counts) -> int:
    """index.bin's per-level packCount: the packs of the level, all channels together."""
    return int(sum(per_channel_counts))


def index_bin_bytes(levels, channels: int, entries) -> bytes:
    """index.bin of a tree. levels: [(gx, gy, gz, packCount)]; entries: per level a
    (channels, gz·gy·gx) array of INDEX_ENTRY (or (pack, offset, length) triples) in
    brick order (bz, by, bx). An absent brick is (0, 0, 0)."""
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
        absent = arr["length"] == 0
        if (arr["pack"][absent].any() or arr["offset"][absent].any()):
            raise ValueError("index_bin_bytes: an absent brick must be (0, 0, 0)")
        parts.append(np.ascontiguousarray(arr).tobytes())
    return b"".join(parts)


def parse_index_bin(data: bytes) -> dict:
    """{levels: [(gx, gy, gz, packCount)], channels, entries: [(C, n) INDEX_ENTRY]}."""
    if len(data) < INDEX_HEADER_BYTES or data[:4] != INDEX_MAGIC:
        raise ValueError("index.bin: bad magic")
    _m, version, n_levels, channels, _r = struct.unpack_from("<4sHHHH", data, 0)
    if version != INDEX_VERSION:
        raise ValueError(f"index.bin: unsupported version {version}")
    pos = INDEX_HEADER_BYTES
    levels = []
    for _ in range(n_levels):
        levels.append(struct.unpack_from("<IIII", data, pos))
        pos += INDEX_LEVEL_BYTES
    entries = []
    for gx, gy, gz, _p in levels:
        n = channels * gx * gy * gz
        end = pos + n * INDEX_ENTRY_BYTES
        if end > len(data):
            raise ValueError("index.bin: truncated")
        entries.append(np.frombuffer(data, dtype=INDEX_ENTRY, count=n, offset=pos)
                       .reshape(channels, gx * gy * gz))
        pos = end
    if pos != len(data):
        raise ValueError("index.bin: trailing bytes")
    return {"levels": levels, "channels": channels, "entries": entries}


# ── One tree ───────────────────────────────────────────────────────────────────
def _atomic_write(path, data: bytes) -> None:
    path = os.fspath(path)
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


def write_tree(level_files, levels, tree_dir, run, progress=None) -> dict:
    """Encode, pack and index every level of one tree.

    level_files[k][c]: the (D_k, H_k, W_k) uint8 file of level k, channel c (None for a
    channel without data: every brick absent). levels: level_ladder's output.
    run(fn, tasks): an ordered iterator of fn over tasks (a process pool's, or map).
    progress(level, channel, rows_done, rows_total) is called as rows come back.
    Returns {"levels": [{level, dimensions, voxelSize, gridSize, brickCount, stored,
    storedBricks (per channel), bytes}], "index": {"bytes", "sha256"}}.
    """
    os.makedirs(tree_dir, exist_ok=True)
    channels = len(level_files[0])
    level_rows, index_levels, index_entries = [], [], []
    for li in levels:
        k = li["level"]
        d = li["dimensions"]
        gx, gy, gz = grid_size(d)
        shape = (d["z"], d["y"], d["x"])
        entries = np.zeros((channels, gx * gy * gz), dtype=INDEX_ENTRY)
        packs, per_channel, nbytes = [], [0] * channels, 0
        for c in range(channels):
            path = level_files[k][c]
            if path is None or not os.path.exists(path):
                packs.append(0)
                continue
            writer = PackWriter(tree_dir, k, c)
            # Rows come back in super-block-row order, so only one row of super-blocks
            # (≤ 16 brick rows) is held before it is written.
            tasks = [(os.fspath(path), shape, by, bz)
                     for sz in range(0, gz, SUPER) for sy in range(0, gy, SUPER)
                     for bz in range(sz, min(gz, sz + SUPER))
                     for by in range(sy, min(gy, sy + SUPER))]
            group = {}
            try:
                for done, (bz, by, row) in enumerate(run(encode_row_task, tasks), 1):
                    group[(bz, by)] = row
                    sz, sy = bz - bz % SUPER, by - by % SUPER
                    if len(group) == (min(gz, sz + SUPER) - sz) * (min(gy, sy + SUPER) - sy):
                        for sx in range(0, gx, SUPER):
                            keys = [(z, y, x) for z in range(sz, min(gz, sz + SUPER))
                                    for y in range(sy, min(gy, sy + SUPER))
                                    for x in range(sx, min(gx, sx + SUPER))
                                    if group[(z, y)][x]]
                            placed = writer.add_superblock([group[(z, y)][x] for z, y, x in keys])
                            for (z, y, x), entry in zip(keys, placed):
                                entries[c, (z * gy + y) * gx + x] = entry
                            per_channel[c] += len(keys)
                        group = {}
                    if progress:
                        progress(k, c, done, len(tasks))
            finally:
                writer.close()
            packs.append(writer.pack_count)
            nbytes += writer.bytes
        index_levels.append((gx, gy, gz, level_pack_count(packs)))
        index_entries.append(entries)
        level_rows.append({"level": k, "dimensions": dict(d), "voxelSize": dict(li["voxelSize"]),
                           "gridSize": {"x": gx, "y": gy, "z": gz}, "brickCount": gx * gy * gz,
                           "stored": sum(per_channel), "storedBricks": per_channel,
                           "bytes": nbytes})
    blob = index_bin_bytes(index_levels, channels, index_entries)
    _atomic_write(os.path.join(tree_dir, INDEX_NAME), blob)
    return {"levels": level_rows,
            "index": {"bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest()}}


# ── Manifest ───────────────────────────────────────────────────────────────────
def manifest_levels(trees: dict) -> list:
    """The manifest's `levels` rows, keys in SPEC §13.3 order. `brickCount` = the bricks
    present (length > 0) in the level over all channels and every tree of the dataset.
    trees: {key: write_tree's result}."""
    first = trees[sorted(trees)[0]]["levels"]
    out = []
    for k, r in enumerate(first):
        out.append({"level": r["level"], "dimensions": r["dimensions"],
                    "voxelSize": r["voxelSize"], "gridSize": r["gridSize"],
                    "brickCount": int(sum(trees[t]["levels"][k]["stored"] for t in trees))})
    return out


def manifest_v3(channels: int, trees: dict, histograms, created_at: str,
                histograms_by_tree: dict = None, dataset: str = None,
                producer: str = "pipeline") -> dict:
    """bricks/manifest.json, keys in the order dataset_migrations.bricks_v3_manifest
    writes them. trees: {"": write_tree's result} for a '3d' dataset, {"t000": …,
    "t001": …} for a 'live' one.

    '3d': a root `index` {url, bytes, sha256} and `timepoints` null. 'live': no root
    `index`; `timepoints` = [{"path": "t000", "index": {"url": "t000/index.bin", "bytes",
    "sha256"}}, …] (urls relative to bricks/), and `timepointHistograms` keeps the
    per-frame histograms the channel panel reads."""
    keys = sorted(trees)
    live = keys != [""]
    doc = {"schema": SCHEMA, "version": MANIFEST_VERSION, "formatVersion": FORMAT_VERSION}
    if dataset:
        doc["dataset"] = dataset
    doc.update({
        "channels": channels,
        "brickSize": BRICK,
        "apron": APRON,
        "brickPacking": {"mode": "grid", "cols": COLS, "rows": ROWS, "slice": SLICE},
        "encoding": ENCODING,
        "levels": manifest_levels(trees),
        "timepoints": [{"path": k, "index": {"url": f"{k}/{INDEX_NAME}",
                                             "bytes": trees[k]["index"]["bytes"],
                                             "sha256": trees[k]["index"]["sha256"]}}
                       for k in keys] if live else None,
    })
    if not live:
        doc["index"] = {"url": INDEX_NAME, "bytes": trees[""]["index"]["bytes"],
                        "sha256": trees[""]["index"]["sha256"]}
    doc["histograms"] = histograms
    if live and histograms_by_tree:
        doc["timepointHistograms"] = {k: histograms_by_tree[k] for k in keys
                                      if k in histograms_by_tree}
    doc["producer"] = producer
    doc["createdAt"] = created_at
    return doc


def tree_keys(manifest: dict) -> list:
    """'' for a '3d' tree, the timepoint paths of a 'live' one."""
    tps = manifest.get("timepoints")
    if isinstance(tps, list) and tps:
        return [row.get("path") if isinstance(row, dict) else row for row in tps]
    return [""]


def tree_index_info(manifest: dict, key: str) -> dict:
    """{url (relative to bricks/), bytes, sha256} of a tree's index.bin."""
    if not key:
        return manifest.get("index") or {}
    for row in manifest.get("timepoints") or []:
        if isinstance(row, dict) and row.get("path") == key:
            return row.get("index") or {}
    return {}


def tree_complete(bricks_dir, manifest: dict, key: str) -> bool:
    """The tree's index.bin matches the manifest and every brick it lists lies inside
    a pack of the tree."""
    tree = os.path.join(os.fspath(bricks_dir), key) if key else os.fspath(bricks_dir)
    info = tree_index_info(manifest, key)
    if not isinstance(key, str) or info.get("url") != (f"{key}/{INDEX_NAME}" if key else INDEX_NAME):
        return False
    try:
        with open(os.path.join(tree, INDEX_NAME), "rb") as fh:
            blob = fh.read()
    except OSError:
        return False
    if len(blob) != info.get("bytes") or hashlib.sha256(blob).hexdigest() != info.get("sha256"):
        return False
    try:
        idx = parse_index_bin(blob)
    except ValueError:
        return False
    levels = manifest.get("levels") or []
    if len(idx["levels"]) != len(levels) or idx["channels"] != manifest.get("channels"):
        return False
    for k, ((gx, gy, gz, _p), row, e) in enumerate(zip(idx["levels"], levels, idx["entries"])):
        g = row.get("gridSize") or {}
        if (gx, gy, gz) != (g.get("x"), g.get("y"), g.get("z")):
            return False
        for c in range(idx["channels"]):
            present = e[c][e[c]["length"] > 0]
            if not present.size:
                continue
            for pack in np.unique(present["pack"]):
                try:
                    size = os.path.getsize(os.path.join(tree, *pack_rel(k, c, int(pack)).split("/")))
                except OSError:
                    return False
                sel = present[present["pack"] == pack]
                if int((sel["offset"].astype(np.int64) + sel["length"]).max()) > size:
                    return False
    return True


def bricks_complete(dataset_dir) -> bool:
    """bricks/manifest.json is a v3 manifest and every tree it names is complete."""
    import json
    bricks = os.path.join(os.fspath(dataset_dir), "bricks")
    try:
        with open(os.path.join(bricks, "manifest.json"), "rb") as fh:
            manifest = json.loads(fh.read().decode("utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
        return False
    return all(tree_complete(bricks, manifest, key) for key in tree_keys(manifest))
