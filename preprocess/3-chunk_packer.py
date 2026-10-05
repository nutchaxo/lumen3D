#!/usr/bin/env python3
import hashlib
import io
import itertools
import math
import os
import sys
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from run_preprocess import worker_count, atomic_write_json, read_json_file  # noqa: E402

# Empty-space skipping counts the voxels the RENDERER can draw, not the voxels that
# are merely non-zero.
#
# Window leveling in 2-image_processor.py maps [bg_floor, sig_max] onto [0, 255], so a
# voxel sitting one step above the noise floor lands on 1. Background noise straddling
# bg_floor therefore always leaves a speckle of 1s — that is arithmetic, not a defect.
# Counting those as content made a brick that is 97-99 % zero pass the test: measured on
# the published Decidua bricks, the eight corner bricks are 96.9 %, 98.5 % and 98.9 %
# zero (99th percentile = 1) and were all kept, which is why that dataset reports 7200
# non-empty bricks out of 7200 and downloads ~4x what a comparable one does.
#
# The viewer never shows those voxels. volume-viewer.js:_floorsFromManifest derives a
# per-channel background floor and clamps it to [6, 48] (it reaches the low end of that
# clamp whenever the manifest carries no explicit backgroundFloor, which is every
# dataset published so far). Anything under 6 is crushed to zero by the LUT before the
# ray marcher ever sees it. A voxel above DISPLAY_FLOOR = 5 is therefore "drawable".
#
# A brick is kept when BOTH hold:
#   (a) it has at least one drawable voxel — a brick without one cannot contribute a
#       single pixel, however many quantization-noise 1s it carries;
#   (b) its non-zero voxels (drawable ones AND noise 1s) exceed ESS_MIN_OCCUPANCY of its
#       valid voxels — the historic bandwidth tolerance, 0.0005 x 64^3 = 131 voxels for
#       a full brick.
# (b) is a deliberate trade-off, not a noise filter: a brick holding a few bright voxels
# of a thin vessel tip or an isolated cell (and little noise around them) fails it and is
# dropped, so at most 131 drawable voxels per brick are given up to save a download.
# Replaying the rule over every published brick of a LOD, (a) alone took Decidua lod2
# from 1836 kept bricks to 1434 and the healthy Em10 lod2 from 932 to 930; dropping (b)
# would keep 291 MORE Decidua lod2 bricks, each holding at most 131 drawable voxels.
# The packer reports, per LOD, how many bricks with drawable voxels (b) dropped and how
# many such voxels they held. LUMEN_ESS_MIN_OCCUPANCY overrides the tolerance (0 keeps
# every brick with a drawable voxel); unset, the output is the historic one.
DISPLAY_FLOOR = 5           # the viewer's LUT crushes everything below 6 to zero


def _ess_min_occupancy() -> float:
    raw = os.environ.get("LUMEN_ESS_MIN_OCCUPANCY", "").strip()
    if raw:
        try:
            value = float(raw)
            if 0.0 <= value < 1.0:
                return value
        except ValueError:
            pass
        print(f"[PACKER] LUMEN_ESS_MIN_OCCUPANCY={raw!r} ignore (0 <= x < 1 attendu)", flush=True)
    return 0.0005


ESS_MIN_OCCUPANCY = _ess_min_occupancy()

BRICK_SIZE = 64
CHUNKS_PER_PACK = 128
BRICKS_PER_TASK = 16        # bricks a worker reads and encodes per task


def process_chunk(args):
    chunk_data, ch_meta, BRICK_SIZE = args
    non_zero = np.count_nonzero(chunk_data)
    valid_voxels = max(1, ch_meta["validVoxelCount"])
    occ = float(non_zero) / float(valid_voxels)

    # A brick holding nothing at or above the display floor cannot contribute a single
    # pixel: it is empty however many quantization-noise 1s it carries.
    has_drawable = bool(np.any(chunk_data > DISPLAY_FLOOR))

    is_non_empty = occ > ESS_MIN_OCCUPANCY and has_drawable
    if not is_non_empty:
        return (ch_meta["idx"], 0.0 if not has_drawable else occ, False, None)

    padded = np.zeros((BRICK_SIZE, BRICK_SIZE, BRICK_SIZE), dtype=np.uint8)
    d, h, w = chunk_data.shape
    padded[:d, :h, :w] = chunk_data

    mosaic = np.zeros((512, 512), dtype=np.uint8)
    for z in range(64):
        row = z // 8
        col = z % 8
        mosaic[row*64:(row+1)*64, col*64:(col+1)*64] = padded[z]

    img = Image.fromarray(mosaic)
    buf = io.BytesIO()
    img.save(buf, format="WEBP", lossless=True)
    return (ch_meta["idx"], occ, True, buf.getvalue())


# ── Worker tasks: they read the LOD file themselves, so no voxel crosses a pipe ─
def encode_brick_batch(args):
    """Encode a run of bricks of one (LOD, channel) file.

    items: [(idx, (z0, z1, y0, y1, x0, x1), validVoxelCount)]. Returns, per brick,
    process_chunk's (idx, occ, kept, bytes) plus the number of drawable voxels a dropped
    brick held (0 for a kept one).
    """
    bin_path, shape, items = args
    vol = np.memmap(bin_path, dtype=np.uint8, mode="r", shape=tuple(shape))
    out = []
    try:
        for idx, (z0, z1, y0, y1, x0, x1), valid in items:
            chunk = np.array(vol[z0:z1, y0:y1, x0:x1])
            idx, occ, kept, data = process_chunk((chunk, {"idx": idx, "validVoxelCount": valid},
                                                  BRICK_SIZE))
            dropped = 0 if kept or occ <= 0.0 else int(np.count_nonzero(chunk > DISPLAY_FLOOR))
            out.append((idx, occ, kept, data, dropped))
    finally:
        del vol
    return out


def layer_max_grid(args):
    """Per-brick maximum of one 64-plane brick layer of a LOD file, read plane by plane:
    a (ny, nx) uint8 grid."""
    bin_path, shape, bz = args
    D, H, W = shape
    vol = np.memmap(bin_path, dtype=np.uint8, mode="r", shape=(D, H, W))
    ys = np.arange(0, H, BRICK_SIZE)
    xs = np.arange(0, W, BRICK_SIZE)
    grid = np.zeros((len(ys), len(xs)), dtype=np.uint8)
    try:
        for z in range(bz * BRICK_SIZE, min(D, (bz + 1) * BRICK_SIZE)):
            plane = np.asarray(vol[z])
            np.maximum(grid, np.maximum.reduceat(np.maximum.reduceat(plane, ys, axis=0),
                                                 xs, axis=1), out=grid)
    finally:
        del vol
    return grid


_DONE = object()


def ordered_results(executor, fn, tasks, window: int):
    """Results of fn over tasks, in order, with at most `window` tasks submitted ahead —
    the encoded bricks of a whole LOD never queue up in memory at once."""
    if executor is None:
        yield from map(fn, tasks)
        return
    it = iter(tasks)
    pending = deque(executor.submit(fn, t) for t in itertools.islice(it, window))
    while pending:
        result = pending.popleft().result()
        nxt = next(it, _DONE)
        if nxt is not _DONE:
            pending.append(executor.submit(fn, nxt))
        yield result


class _PackWriter:
    """Appends bricks to pack_NN.bin files of one (LOD, channel), rolling over every
    CHUNKS_PER_PACK bricks and hashing each pack as it is written."""

    def __init__(self, channel_dir: Path, tp_root: Path, pack_hashes: dict):
        self.dir = channel_dir
        self.root = tp_root
        self.hashes = pack_hashes
        self.idx = -1
        self._open_next()

    def _open_next(self):
        self.idx += 1
        self.path = self.dir / f"pack_{self.idx:02d}.bin"
        self.fh = open(self.path, "wb")
        self.sha = hashlib.sha256()
        self.offset = 0
        self.count = 0

    def _finish(self):
        self.fh.close()
        self.hashes[self.path.relative_to(self.root).as_posix()] = self.sha.hexdigest()

    def add(self, data: bytes) -> dict:
        if self.count >= CHUNKS_PER_PACK:
            self._finish()
            self._open_next()
        self.fh.write(data)
        self.sha.update(data)
        entry = {"url": self.path.relative_to(self.root).as_posix(),
                 "offset": int(self.offset), "length": int(len(data))}
        self.offset += len(data)
        self.count += 1
        return entry

    def close(self):
        self._finish()


def pack_timepoint(temp_dir: Path, bricks_dir: Path, t_idx: int, lod_levels, n_ch: int,
                   executor, tp_subdir: str, encode_fn=None, layer_fn=None):
    """Brick, compress and pack every LOD of a single timepoint.

    tp_subdir is '' for a single-timepoint ('3d') dataset — the packs then land
    directly under bricks/ and the output is byte-identical to the pre-4D pipeline.
    For a timelapse it is 't000', 't001', … and each timepoint owns a self-contained
    pack tree whose brickToPack urls stay relative to that sub-directory, which is
    exactly what the viewer appends to the bricks base path.

    encode_fn / layer_fn are this module's encode_brick_batch / layer_max_grid, or
    wrappers a caller's pool can import by name.
    """
    encode_fn = encode_fn or encode_brick_batch
    layer_fn = layer_fn or layer_max_grid
    window = 2 * (getattr(executor, "_max_workers", 1) or 1)

    tp_root = bricks_dir / tp_subdir if tp_subdir else bricks_dir
    tp_root.mkdir(parents=True, exist_ok=True)

    brick_to_pack = {}
    pack_hashes = {}
    levels_manifest = []

    from tqdm import tqdm
    for li in lod_levels:
        lod_num = li["lod"]
        W, H, D = li["width"], li["height"], li["depth"]
        shape = (D, H, W)

        nx = math.ceil(W / BRICK_SIZE)
        ny = math.ceil(H / BRICK_SIZE)
        nz = math.ceil(D / BRICK_SIZE)

        # Build logical grid of chunks for this level
        chunks_grid = []
        for bz in range(nz):
            for by in range(ny):
                for bx in range(nx):
                    ox, oy, oz = bx * BRICK_SIZE, by * BRICK_SIZE, bz * BRICK_SIZE
                    ew = min(BRICK_SIZE, W - ox)
                    eh = min(BRICK_SIZE, H - oy)
                    ed = min(BRICK_SIZE, D - oz)
                    chunks_grid.append({
                        "bx": bx,
                        "by": by,
                        "bz": bz,
                        "min": [int(ox), int(oy), int(oz)],
                        "max": [int(ox + ew), int(oy + eh), int(oz + ed)],
                        "validVoxelCount": int(ew * eh * ed)
                    })

        bin_files = {c: temp_dir / f"t{t_idx:03d}_c{c}_lod{lod_num}.bin" for c in range(n_ch)}

        # Only a brick with a drawable voxel in SOME channel can be kept in any channel
        # (rule (a) above), so only those are read, encoded and listed. Empty-space
        # skipping is decided per timepoint: cells move, so the occupied brick set
        # legitimately differs from one frame to the next.
        drawable = np.zeros((nz, ny, nx), dtype=bool)
        layer_tasks = [(str(p), shape, bz) for c, p in bin_files.items() if p.exists()
                       for bz in range(nz)]
        for (_, _, bz), grid in zip(layer_tasks, ordered_results(executor, layer_fn,
                                                                 layer_tasks, window)):
            drawable[bz] |= grid > DISPLAY_FLOOR

        active_chunks_grid = [ch for ch in chunks_grid if drawable[ch["bz"], ch["by"], ch["bx"]]]
        print(f"[PACKER] {tp_subdir or 't000'} LOD {lod_num}: Grid {nx}x{ny}x{nz} "
              f"({len(chunks_grid)} chunks, {len(active_chunks_grid)} with drawable voxels)")

        # We will track occupancy union across all channels for the active chunk grid
        occupancy_union = [0.0] * len(active_chunks_grid)
        dropped_bricks = dropped_voxels = 0

        items = [(i, (ch["min"][2], ch["max"][2], ch["min"][1], ch["max"][1],
                      ch["min"][0], ch["max"][0]), ch["validVoxelCount"])
                 for i, ch in enumerate(active_chunks_grid)]

        for c_idx in range(n_ch):
            bin_file = bin_files[c_idx]
            if not bin_file.exists():
                print(f"[WARNING] Processed file not found: {bin_file}")
                continue

            channel_lod_dir = tp_root / f"lod{lod_num}" / f"c{c_idx}"
            channel_lod_dir.mkdir(parents=True, exist_ok=True)
            writer = _PackWriter(channel_lod_dir, tp_root, pack_hashes)

            tasks = [(str(bin_file), shape, items[k:k + BRICKS_PER_TASK])
                     for k in range(0, len(items), BRICKS_PER_TASK)]
            try:
                for batch in tqdm(ordered_results(executor, encode_fn, tasks, window),
                                  total=len(tasks), desc="Compressing WebP", leave=False,
                                  ascii=True, mininterval=2.0):
                    for idx, occ, is_non_empty, compressed_bytes, dropped in batch:
                        occupancy_union[idx] = max(occupancy_union[idx], occ)
                        if is_non_empty:
                            ch = active_chunks_grid[idx]
                            bx, by, bz = ch["bx"], ch["by"], ch["bz"]
                            brick_rel_key = f"lod{lod_num}/c{c_idx}/x{bx:03d}_y{by:03d}_z{bz:03d}.webp"
                            brick_to_pack[brick_rel_key] = writer.add(compressed_bytes)
                        elif dropped:
                            dropped_bricks += 1
                            dropped_voxels += dropped
            finally:
                writer.close()

        if dropped_bricks:
            print(f"[PACKER]   tolerance ESS ({ESS_MIN_OCCUPANCY:g}) : {dropped_bricks} brick(s) "
                  f"ecartee(s) malgre {dropped_voxels} voxel(s) affichable(s) (toutes voies)")

        # Build level chunks list for manifest
        manifest_chunks = []
        non_empty_count = 0
        for i, ch in enumerate(active_chunks_grid):
            is_non_empty = occupancy_union[i] > ESS_MIN_OCCUPANCY
            if is_non_empty:
                non_empty_count += 1
            manifest_chunks.append({
                "id": f"{ch['bz']}_{ch['by']}_{ch['bx']}",
                "min": ch["min"],
                "max": ch["max"],
                "occupiedRatio": round(occupancy_union[i], 6),
                "nonEmpty": is_non_empty
            })

        levels_manifest.append({
            "level": lod_num,
            "scale": 1.0 / (2 ** lod_num),
            "dimensions": {"x": W, "y": H, "z": D},
            "brickSize": BRICK_SIZE,
            "gridSize": {"x": nx, "y": ny, "z": nz},
            "brickCount": len(chunks_grid),
            "chunks": manifest_chunks,
            "nonEmptyCount": non_empty_count
        })

    transport = {
        "mode": "packs",
        "encoding": "webp-lossless",
        "packSize": CHUNKS_PER_PACK,
        "brickToPack": brick_to_pack,
        "packHashes": pack_hashes
    }
    return levels_manifest, transport


def histograms_for_timepoint(temp_dir: Path, t_idx: int, n_ch: int, lod_num: int):
    """Per-channel 64-bin histogram of one timepoint, on its coarsest LOD."""
    out = []
    for c_idx in range(n_ch):
        bin_file = temp_dir / f"t{t_idx:03d}_c{c_idx}_lod{lod_num}.bin"
        if bin_file.exists():
            vol_data = np.fromfile(str(bin_file), dtype=np.uint8)
            counts, edges = np.histogram(vol_data, bins=64, range=(0, 255))

            mean_val = float(vol_data.mean()) if vol_data.size else 0.0
            std_val = float(vol_data.std()) if vol_data.size else 0.0
            max_val = int(vol_data.max()) if vol_data.size else 0

            out.append({
                "counts": counts.astype(np.int64).tolist(),
                "edges": edges.astype(np.float64).tolist(),
                "total": int(vol_data.size),
                "max": max_val,
                "mean": mean_val,
                "std": std_val,
                "backgroundFloor": 0
            })
            del vol_data
        else:
            print(f"[WARNING] Bin file for histogram not found: {bin_file}")
            out.append({
                "counts": [0] * 64,
                "edges": list(range(65)),
                "total": 0,
                "max": 0,
                "mean": 0.0,
                "std": 0.0,
                "backgroundFloor": 0
            })
    return out


def build_packs(temp_dir: Path, output_dir: Path):
    proc_meta = read_json_file(temp_dir / "processing_meta.json")
    if not proc_meta:
        raise FileNotFoundError(f"{temp_dir / 'processing_meta.json'} absent ou illisible")

    lod_levels = proc_meta["lod_levels"]
    n_ch = proc_meta["n_channels"]
    n_tp = proc_meta["n_timepoints"]
    voxel_size = proc_meta["voxel_size"]

    bricks_dir = output_dir / "bricks"
    bricks_dir.mkdir(parents=True, exist_ok=True)

    is_timelapse = n_tp > 1
    coarsest = lod_levels[-1]["lod"]

    # A timepoint step 2 already packed (--pack-into) is only indexed here; anything
    # else is packed now, through one process pool for the whole run.
    executor = None
    per_tp = []
    try:
        for t_idx in range(n_tp):
            key = f"t{t_idx:03d}"
            packed = read_json_file(temp_dir / f"pack_{key}.json")
            if packed:
                levels, transport = packed["levels"], packed["brickTransport"]
            else:
                if executor is None:
                    executor = ProcessPoolExecutor(max_workers=worker_count())
                if is_timelapse:
                    print(f"[PACKER] === timepoint {t_idx + 1}/{n_tp} ({key}) ===")
                levels, transport = pack_timepoint(temp_dir, bricks_dir, t_idx, lod_levels,
                                                   n_ch, executor, key if is_timelapse else "")
            per_tp.append((key, levels, transport,
                           histograms_for_timepoint(temp_dir, t_idx, n_ch, coarsest)))
    finally:
        if executor is not None:
            executor.shutdown()

    if not is_timelapse:
        _, levels_manifest, transport, histograms = per_tp[0]
        timepoints_manifest = None
    else:
        timepoints_manifest = {}
        for key, levels, tp_transport, hist in per_tp:
            # A timelapse carries one histogram set per frame: the channel panel reads
            # the row of the timepoint on screen, and a shared set would mis-scale the
            # sliders as the specimen bleaches.
            timepoints_manifest[key] = {
                "path": key,
                "channels": n_ch,
                "levels": levels,
                "brickTransport": tp_transport,
                "histograms": hist
            }
        # Mirrored at the top level so a consumer that ignores `timepoints` still
        # mounts a coherent (first-frame) dataset instead of failing.
        _, levels_manifest, transport, histograms = per_tp[0]

    manifest = {
        "version": 2,
        "schema": "iribhm-bricks-v2",
        "dataset": output_dir.name,
        "datasetType": "live" if is_timelapse else "3d",
        "channels": n_ch,
        "brickSize": BRICK_SIZE,
        "brickPacking": {"mode": "grid", "cols": 8, "rows": 8},
        "voxelSize": voxel_size,
        "createdAt": __import__("datetime").datetime.now().isoformat(),
        "levels": levels_manifest,
        "histograms": histograms,
        "hashes": {},     # Left empty as we use pack transport
        "timepoints": timepoints_manifest,
        "brickTransport": transport
    }

    # Compact: the browser downloads and parses the manifest before the first frame,
    # and indentation alone doubled it (23 MB -> 11 MB on the largest dataset).
    manifest_path = bricks_dir / "manifest.json"
    atomic_write_json(manifest_path, manifest, separators=(",", ":"))

    size_mb = manifest_path.stat().st_size / 1e6
    print(f"[PACKER] Wrote manifest.json to {manifest_path} ({size_mb:.2f} MB)")
    if is_timelapse:
        print(f"[PACKER] {n_tp} timepoints indexed")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python 3-chunk_packer.py <temp_dir> <output_dir>")
        sys.exit(1)

    temp_dir = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])

    try:
        build_packs(temp_dir, output_dir)
        print(f"[PACKER] Chunk packaging complete.")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[ERROR] Chunk packaging failed: {e}", file=sys.stderr)
        sys.exit(1)
