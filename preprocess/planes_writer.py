#!/usr/bin/env python3
"""Format 2 of a volume dataset: the native level (LOD0) re-cut into XY planes.

Normative contract: DOCS/dataset-migrations/SPEC.md §3. For every brick tree of a
dataset (`bricks/` of a '3d' one, each `bricks/tNNN/` of a 'live' one) a sibling tree
`planes/` (`planes/tNNN/`) holds one pack per z:

    zNNNNN.bin   little-endian
      0  "LPLN"            magic
      4  u16  version = 1
      6  u16  C            channels
      8  u16  TX           tiles along x  = ceil(X / 512)
     10  u16  TY           tiles along y  = ceil(Y / 512)
     12  u32  z
     16  C·TY·TX × { u64 offset from the start of the file, u32 length }, c-major, then
         ty, then tx; length 0 = an all-zero tile without payload (offset 0)
     then the tile payloads in entry order, no padding

and one `manifest.json` describing the tree. A tile is a greyscale PNG (colour type 0,
bit depth 8, no ancillary chunk) whose pixel (x, y) is the stored uint8 voxel of channel
c at (tx·512 + x, ty·512 + y, z): exactly what the brick decoder yields for that voxel.
A voxel of a brick the manifest does not list for that channel (dropped by empty-space
skipping) is 0, so the planes and the bricks never disagree.

The migration of an already published dataset (dataset_migrations.py, server side, and
the browser executor) produces the same tree. This file is a standalone copy of the
codec on purpose: the pipeline pack ships without the web platform, and the parity test
(tests/test_mig_pipe_parity.py) holds the two copies together.

Only numpy and zlib are needed.
"""
import hashlib
import json
import math
import os
import re
import struct
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

SCHEMA = "lumen-planes-v1"
FORMAT_VERSION = 2
CODEC = "png-gray8"
TILE = 512
BRICK = 64
BRICKS_PER_TILE = TILE // BRICK
PACK_MAGIC = b"LPLN"
PACK_VERSION = 1
PACK_FIXED_BYTES = 16
PACK_ENTRY_BYTES = 12
PACK_PATTERN = "z{z}.bin"
ZLIB_LEVEL = 6
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

_BRICK_KEY = re.compile(r"^lod0/c(\d+)/x(\d+)_y(\d+)_z(\d+)\.webp$")


# ── Codec ──────────────────────────────────────────────────────────────────────
def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))


def png_gray8(tile: np.ndarray) -> bytes:
    """A (h, w) uint8 array as a PNG: IHDR, one IDAT, IEND, nothing else.

    Filter 0 (None) on every row, then zlib (RFC 1950) at level 6, byte-identical to
    dataset_migrations.png_gray8. None, not Sub: shot noise dominates real LOD0 planes and
    a horizontal difference doubles its entropy; over 2264 lab tiles Sub was 4 % larger in
    total, 70 % on a sparse timelapse.
    """
    tile = np.ascontiguousarray(tile, dtype=np.uint8)
    if tile.ndim != 2 or tile.shape[0] < 1 or tile.shape[1] < 1:
        raise ValueError(f"png_gray8: expected a non-empty 2-D tile, got {tile.shape}")
    h, w = tile.shape
    filtered = np.zeros((h, w + 1), dtype=np.uint8)
    filtered[:, 1:] = tile
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)
    return (PNG_SIGNATURE + _png_chunk(b"IHDR", ihdr)
            + _png_chunk(b"IDAT", zlib.compress(filtered.tobytes(), ZLIB_LEVEL))
            + _png_chunk(b"IEND", b""))


def png_header(data: bytes):
    """(width, height, bit depth, colour type, interlace) of a PNG's IHDR, or None."""
    if len(data) < 33 or data[:8] != PNG_SIGNATURE or data[12:16] != b"IHDR" \
            or struct.unpack(">I", data[8:12])[0] != 13:
        return None
    w, h, depth, ctype, _comp, _filt, interlace = struct.unpack(">IIBBBBB", data[16:29])
    return w, h, depth, ctype, interlace


def header_bytes(channels: int, tiles_x: int, tiles_y: int) -> int:
    return PACK_FIXED_BYTES + PACK_ENTRY_BYTES * channels * tiles_y * tiles_x


def build_plane_pack(z: int, channels: int, tiles_x: int, tiles_y: int, payloads) -> bytes:
    """One zNNNNN.bin. payloads: C·TY·TX byte strings in entry order (c, ty, tx), an
    empty one for an all-zero tile."""
    n = channels * tiles_y * tiles_x
    if len(payloads) != n:
        raise ValueError(f"build_plane_pack: {len(payloads)} payloads for {n} tiles")
    for v in (channels, tiles_x, tiles_y):
        if not 1 <= v <= 0xFFFF:
            raise ValueError("build_plane_pack: count out of u16 range")
    head = bytearray(header_bytes(channels, tiles_x, tiles_y))
    struct.pack_into("<4sHHHHI", head, 0, PACK_MAGIC, PACK_VERSION, channels, tiles_x,
                     tiles_y, z)
    offset = len(head)
    for i, data in enumerate(payloads):
        length = len(data)
        struct.pack_into("<QI", head, PACK_FIXED_BYTES + i * PACK_ENTRY_BYTES,
                         offset if length else 0, length)
        offset += length
    return bytes(head) + b"".join(payloads)


def parse_plane_pack_header(data: bytes) -> dict:
    if len(data) < PACK_FIXED_BYTES or data[:4] != PACK_MAGIC:
        raise ValueError("plane pack: bad magic")
    _m, version, channels, tiles_x, tiles_y, z = struct.unpack_from("<4sHHHHI", data, 0)
    if version != PACK_VERSION:
        raise ValueError(f"plane pack: unsupported version {version}")
    n = channels * tiles_y * tiles_x
    if len(data) < header_bytes(channels, tiles_x, tiles_y):
        raise ValueError("plane pack: short header")
    entries = [struct.unpack_from("<QI", data, PACK_FIXED_BYTES + i * PACK_ENTRY_BYTES)
               for i in range(n)]
    return {"version": version, "channels": channels, "tilesX": tiles_x, "tilesY": tiles_y,
            "z": z, "entries": entries}


def pack_name(z: int) -> str:
    return PACK_PATTERN.replace("{z}", f"{z:05d}")


# ── Which bricks a channel kept ────────────────────────────────────────────────
def kept_grid(brick_to_pack: dict, channels: int, dims) -> np.ndarray:
    """(C, nz, ny, nx) bool: brick (bx, by, bz) of channel c is in the LOD0 index.

    Read from the transport's brickToPack — the index the viewer itself decodes — so a
    brick the packer dropped in one channel and kept in another reads 0 only where the
    viewer reads 0.
    """
    x, y, z = dims
    grid = np.zeros((channels, math.ceil(z / BRICK), math.ceil(y / BRICK),
                     math.ceil(x / BRICK)), dtype=bool)
    for key in brick_to_pack:
        m = _BRICK_KEY.match(key)
        if not m:
            continue
        c, bx, by, bz = (int(g) for g in m.groups())
        if c < channels and bz < grid.shape[1] and by < grid.shape[2] and bx < grid.shape[3]:
            grid[c, bz, by, bx] = True
    return grid


# ── Writing one tree ───────────────────────────────────────────────────────────
def _atomic_write(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
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
            tmp.unlink()
        except OSError:
            pass
        raise


def plane_pack_for_z(z: int, planes, keep_layer: np.ndarray, width: int, height: int) -> bytes:
    """The pack of one z from its C planes.

    planes: C arrays (height, width) uint8, or None for a channel without data.
    keep_layer: (C, ny, nx) bool, the kept bricks of this z's brick layer; the voxels of
    every other brick are zeroed. A tile that is entirely zero gets length 0 and no
    payload — what both migration executors produce, so a pipeline tree and a migrated
    one are byte-identical.
    """
    channels = len(planes)
    tiles_x, tiles_y = math.ceil(width / TILE), math.ceil(height / TILE)
    payloads = []
    for c in range(channels):
        plane = planes[c]
        keep = keep_layer[c]
        if plane is not None and not keep.all():
            mask = np.repeat(np.repeat(keep, BRICK, axis=0), BRICK, axis=1)[:height, :width]
            plane = np.where(mask, plane, np.uint8(0))
        for ty in range(tiles_y):
            for tx in range(tiles_x):
                tile = None if plane is None else                     plane[ty * TILE:min(height, (ty + 1) * TILE), tx * TILE:min(width, (tx + 1) * TILE)]
                payloads.append(png_gray8(tile) if tile is not None and tile.any() else b"")
    return build_plane_pack(z, channels, tiles_x, tiles_y, payloads)


def write_plane_task(args):
    """Worker task: write planes/zNNNNN.bin for one z of one tree.

    args = (lod0 file per channel (str, or None when a channel has no data),
            (D, H, W), z, keep_layer (C, ny, nx) bool, output directory).
    Each worker reads only its own plane of each channel out of the LOD0 files, so
    no voxel crosses a pipe and the resident set is C planes. Returns (z, bytes).
    """
    paths, shape, z, keep_layer, out_dir = args
    D, H, W = shape
    planes = []
    for p in paths:
        if p is None:
            planes.append(None)
            continue
        vol = np.memmap(p, dtype=np.uint8, mode="r", shape=(D, H, W))
        try:
            planes.append(np.array(vol[z]))
        finally:
            del vol
    data = plane_pack_for_z(z, planes, keep_layer, W, H)
    _atomic_write(Path(out_dir) / pack_name(z), data)
    return z, len(data)


def plane_tasks(lod0_files, dims, brick_to_pack: dict, out_dir: Path):
    """Tasks for write_plane_task covering every z of one tree, in z order.

    lod0_files: per channel, the (D, H, W) uint8 LOD0 file or None; dims = (X, Y, Z).
    """
    X, Y, Z = dims
    channels = len(lod0_files)
    keep = kept_grid(brick_to_pack, channels, dims)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = [str(p) if p is not None and Path(p).exists() else None for p in lod0_files]
    return [(paths, (Z, Y, X), z, keep[:, z // BRICK].copy(), str(out_dir))
            for z in range(Z)]


# ── The tree manifest ──────────────────────────────────────────────────────────
def brick_trees(bricks_manifest: dict):
    """[(tree key or '', LOD0 dims (X, Y, Z), channels)] of a bricks manifest — one
    entry for a '3d' dataset, one per timepoint for a 'live' one."""
    channels = int(bricks_manifest.get("channels") or 0)

    def lod0(levels):
        for lv in levels or []:
            if int(lv.get("level", -1)) == 0:
                d = lv["dimensions"]
                return int(d["x"]), int(d["y"]), int(d["z"])
        raise ValueError("bricks manifest: no LOD0 level")

    timepoints = bricks_manifest.get("timepoints")
    if isinstance(timepoints, dict) and timepoints:
        return [(key, lod0(row.get("levels") or bricks_manifest.get("levels")),
                 int(row.get("channels") or channels))
                for key, row in sorted(timepoints.items())]
    return [("", lod0(bricks_manifest.get("levels")), channels)]


def tree_manifest(dims, channels: int, manifest_sha256: str, producer: str = "pipeline",
                  created_at: str = None) -> dict:
    X, Y, Z = dims
    tiles_x, tiles_y = math.ceil(X / TILE), math.ceil(Y / TILE)
    return {
        "schema": SCHEMA,
        "formatVersion": FORMAT_VERSION,
        "level": 0,
        "dimensions": {"x": X, "y": Y, "z": Z},
        "channels": channels,
        "tileSize": TILE,
        "tiles": {"x": tiles_x, "y": tiles_y},
        "codec": CODEC,
        "packPattern": PACK_PATTERN,
        "headerBytes": header_bytes(channels, tiles_x, tiles_y),
        "source": {"manifestSha256": manifest_sha256},
        "producer": producer,
        "createdAt": created_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def _check_tree_packs(tree_dir: Path, dims, channels: int) -> None:
    """Every zNNNNN.bin of the tree is there with the header this tree implies."""
    X, Y, Z = dims
    tiles_x, tiles_y = math.ceil(X / TILE), math.ceil(Y / TILE)
    need = header_bytes(channels, tiles_x, tiles_y)
    for z in range(Z):
        path = tree_dir / pack_name(z)
        try:
            size = path.stat().st_size
            with open(path, "rb") as fh:
                head = parse_plane_pack_header(fh.read(need))
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"{path}: plan illisible ({exc})") from exc
        if (head["channels"], head["tilesX"], head["tilesY"], head["z"]) != \
                (channels, tiles_x, tiles_y, z):
            raise RuntimeError(f"{path}: en-tete incoherent avec l'arbre")
        end = max((off + ln for off, ln in head["entries"] if ln), default=need)
        if end != size:
            raise RuntimeError(f"{path}: taille {size} != {end} attendue")


def write_manifests(dataset_dir, producer: str = "pipeline") -> list:
    """Write planes[/tNNN]/manifest.json for every tree of a dataset whose packs exist.

    Called once bricks/manifest.json holds its final bytes (and again whenever a later
    step rewrites it), since each tree records that file's sha256. Raises when a tree
    is incomplete: a dataset is never published claiming planes it does not have.
    """
    dataset_dir = Path(dataset_dir)
    raw = (dataset_dir / "bricks" / "manifest.json").read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    written = []
    for key, dims, channels in brick_trees(json.loads(raw.decode("utf-8"))):
        tree_dir = dataset_dir / "planes" / key if key else dataset_dir / "planes"
        _check_tree_packs(tree_dir, dims, channels)
        doc = tree_manifest(dims, channels, sha, producer)
        _atomic_write(tree_dir / "manifest.json",
                      json.dumps(doc, separators=(",", ":")).encode("utf-8"))
        written.append(tree_dir / "manifest.json")
    return written


def planes_complete(dataset_dir) -> bool:
    """True when every brick tree has a planes manifest naming the current bricks
    manifest — the condition for a dataset to claim formatVersion 2."""
    dataset_dir = Path(dataset_dir)
    try:
        raw = (dataset_dir / "bricks" / "manifest.json").read_bytes()
        sha = hashlib.sha256(raw).hexdigest()
        trees = brick_trees(json.loads(raw.decode("utf-8")))
    except (OSError, ValueError, KeyError, TypeError):
        return False
    for key, dims, channels in trees:
        tree_dir = dataset_dir / "planes" / key if key else dataset_dir / "planes"
        try:
            doc = json.loads((tree_dir / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        X, Y, Z = dims
        if (doc.get("schema") != SCHEMA or doc.get("codec") != CODEC
                or doc.get("dimensions") != {"x": X, "y": Y, "z": Z}
                or doc.get("channels") != channels
                or (doc.get("source") or {}).get("manifestSha256") != sha):
            return False
    return True
