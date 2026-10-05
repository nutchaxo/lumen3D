#!/usr/bin/env python3
"""Format 3 of a volume dataset: the maximum projection of each brick layer.

Normative contract: DOCS/dataset-migrations/SPEC.md §12. Beside each `planes/` tree a
`mips/` tree (`mips/tNNN/` for a timelapse) holds, for every brick layer l (LOD0 planes
z ∈ [64·l, min(64·l + 64, Z))) and channel c, the per-voxel maximum over the layer's
planes, at native XY resolution, tiled and packed exactly like the planes:

    lNNNNN.bin   the planes pack layout (planes_writer) with magic "LMIP" and the header
                 field z = the layer index l; tiles png-gray8, filter None, length 0 iff
                 the tile is all zero

and one `manifest.json` (schema lumen-mips-v1). The migration m003-layer-mips derives the
same tree from planes/; a layer MIP is exactly the maximum of the LOD0 voxels, so the
pipeline computes it from the LOD0 file it already has.
"""
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import planes_writer as pw

SCHEMA = "lumen-mips-v1"
FORMAT_VERSION = 3
LAYER_DEPTH = 64
PACK_MAGIC = b"LMIP"
PACK_PATTERN = "l{l}.bin"


def pack_name(layer: int) -> str:
    return PACK_PATTERN.replace("{l}", f"{layer:05d}")


def layer_count(depth: int) -> int:
    return -(-int(depth) // LAYER_DEPTH)


def mip_tile(planes) -> np.ndarray:
    """Per-voxel maximum of a stack of equally shaped uint8 planes (a layer's planes of
    one tile, or of a whole plane)."""
    stack = [np.asarray(p, dtype=np.uint8) for p in planes]
    if not stack:
        raise ValueError("mip_tile: no plane")
    out = stack[0].copy()
    for p in stack[1:]:
        np.maximum(out, p, out=out)
    return out


def layer_mip(path, shape, layer: int) -> np.ndarray:
    """(H, W) maximum of the layer's planes of a (D, H, W) uint8 LOD0 file, read plane by
    plane."""
    D, H, W = shape
    vol = np.memmap(path, dtype=np.uint8, mode="r", shape=(D, H, W))
    try:
        z0, z1 = layer * LAYER_DEPTH, min(D, (layer + 1) * LAYER_DEPTH)
        out = np.array(vol[z0])
        for z in range(z0 + 1, z1):
            np.maximum(out, vol[z], out=out)
    finally:
        del vol
    return out


def mip_channel_task(args):
    """Worker task: the TY·TX tile payloads of one (layer, channel).
    args = (LOD0 file or None, (D, H, W), layer, channel). Returns (layer, channel,
    payloads)."""
    path, shape, layer, channel = args
    D, H, W = shape
    plane = layer_mip(path, shape, layer) if path is not None else None
    return layer, channel, pw.tile_payloads(plane, W, H)


def mip_tasks(lod0_files, dims):
    """Tasks for mip_channel_task, layer-major then channel, for one tree."""
    X, Y, Z = dims
    paths = [str(p) if p is not None and Path(p).exists() else None for p in lod0_files]
    return [(paths[c], (Z, Y, X), layer, c)
            for layer in range(layer_count(Z)) for c in range(len(paths))]


def write_tree(lod0_files, dims, out_dir, run) -> int:
    """Write every lNNNNN.bin of one tree. run(fn, tasks) iterates fn over tasks in
    order. Returns the bytes written."""
    X, Y, Z = dims
    channels = len(lod0_files)
    tiles_x, tiles_y = math.ceil(X / pw.TILE), math.ceil(Y / pw.TILE)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written, current, layer_payloads = 0, None, []
    for layer, _c, payloads in run(mip_channel_task, mip_tasks(lod0_files, dims)):
        if current is not None and layer != current:
            raise RuntimeError("mips: tasks out of order")
        current = layer
        layer_payloads += payloads
        if len(layer_payloads) == channels * tiles_x * tiles_y:
            data = pw.build_plane_pack(layer, channels, tiles_x, tiles_y, layer_payloads,
                                       magic=PACK_MAGIC)
            pw._atomic_write(out_dir / pack_name(layer), data)
            written += len(data)
            current, layer_payloads = None, []
    return written


def tree_manifest(dims, channels: int, manifest_sha256: str, producer: str = "pipeline",
                  created_at: str = None) -> dict:
    X, Y, Z = dims
    tiles_x, tiles_y = math.ceil(X / pw.TILE), math.ceil(Y / pw.TILE)
    return {
        "schema": SCHEMA,
        "formatVersion": FORMAT_VERSION,
        "level": 0,
        "dimensions": {"x": X, "y": Y, "z": Z},
        "channels": channels,
        "tileSize": pw.TILE,
        "tiles": {"x": tiles_x, "y": tiles_y},
        "codec": pw.CODEC,
        "layers": layer_count(Z),
        "layerDepth": LAYER_DEPTH,
        "packPattern": PACK_PATTERN,
        "headerBytes": pw.header_bytes(channels, tiles_x, tiles_y),
        "source": {"manifestSha256": manifest_sha256},
        "producer": producer,
        "createdAt": created_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def write_manifests(dataset_dir, producer: str = "pipeline") -> list:
    """Write mips[/tNNN]/manifest.json for every tree, naming the bricks manifest's
    current sha256. Raises when a tree is incomplete."""
    dataset_dir = Path(dataset_dir)
    raw = (dataset_dir / "bricks" / "manifest.json").read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    written = []
    for key, dims, channels in pw.brick_trees(json.loads(raw.decode("utf-8"))):
        tree_dir = dataset_dir / "mips" / key if key else dataset_dir / "mips"
        pw._check_tree_packs(tree_dir, dims, channels, count=layer_count(dims[2]),
                             name=pack_name, magic=PACK_MAGIC)
        doc = tree_manifest(dims, channels, sha, producer)
        pw._atomic_write(tree_dir / "manifest.json",
                         json.dumps(doc, separators=(",", ":")).encode("utf-8"))
        written.append(tree_dir / "manifest.json")
    return written


def mips_complete(dataset_dir) -> bool:
    """True when every brick tree has a mips manifest naming the current bricks manifest."""
    dataset_dir = Path(dataset_dir)
    try:
        raw = (dataset_dir / "bricks" / "manifest.json").read_bytes()
        sha = hashlib.sha256(raw).hexdigest()
        trees = pw.brick_trees(json.loads(raw.decode("utf-8")))
    except (OSError, ValueError, KeyError, TypeError):
        return False
    for key, dims, channels in trees:
        tree_dir = dataset_dir / "mips" / key if key else dataset_dir / "mips"
        try:
            doc = json.loads((tree_dir / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        X, Y, Z = dims
        if (doc.get("schema") != SCHEMA or doc.get("codec") != pw.CODEC
                or doc.get("dimensions") != {"x": X, "y": Y, "z": Z}
                or doc.get("channels") != channels or doc.get("layers") != layer_count(Z)
                or (doc.get("source") or {}).get("manifestSha256") != sha):
            return False
    return True
